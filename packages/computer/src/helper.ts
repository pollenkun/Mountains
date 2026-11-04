import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { currentInput, InputTerminationUnverifiedError } from "./coordinator.ts";

/** A received refusal can distinguish no input from a helper that disappeared mid-action. */
export class HelperResponseError extends Error {
 readonly reply: Record<string, unknown>;
 constructor(reply: Record<string, unknown>) { super(String(reply.error ?? "desktop helper failed")); this.reply = reply; }
}

/** A bounded file/control transaction can revoke its first write while queued.
 * Once bytes may have been written, completion still waits for the real request. */
export interface HelperAdmission { readonly expiresAt:number; readonly beforeDispatch?:AbortSignal }
export class HelperAdmissionError extends Error {
	readonly reason:"expired"|"aborted";
	constructor(reason:"expired"|"aborted",cause?:unknown){super(reason==="expired"?"helper command expired before its first write; no command bytes were sent":"helper command cancelled before its first write; no command bytes were sent",{cause});this.reason=reason;}
}

export interface HelperPermissionContext {
	readonly commandId:number;
	/** Cancellation requests cooperation; it does not undo a filesystem write. */
	readonly signal:AbortSignal;
}

/** Internal startup registration, never an input permission. The exact spawned
 * child is observed before any command bytes can reach it. */
export interface HelperBeforeCommandContext extends HelperPermissionContext {
	readonly child:ChildProcessWithoutNullStreams;
}

/** One in-flight command per helper. Cancellation waits for the child to exit. */
export class JsonHelper {
	private child: ChildProcessWithoutNullStreams | null = null;
	private disposed=false;
	private tail: Promise<unknown> = Promise.resolve();
	private sequence = 0;
	private readonly command: string;
	private readonly args: string[];
	private readonly env: NodeJS.ProcessEnv;
	private stopping: { child: ChildProcessWithoutNullStreams; promise: Promise<void> } | undefined;
	private readonly stopMode: "terminate" | "eof";
	private stopFailure: InputTerminationUnverifiedError | undefined;
	private readonly stopObservers=new Set<()=>void>();
	private readonly managedInput:boolean;
	private readonly controlPipe:boolean;
	private readonly childCloses=new WeakMap<ChildProcessWithoutNullStreams,Promise<void>>();
	private readonly strictReplies:boolean;
	private readonly strictActive=new WeakSet<ChildProcessWithoutNullStreams>();
	private strictFailure:Error|undefined;
	constructor(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, stopMode: "terminate" | "eof" = "terminate",ownership?:{managedUI:true;controlPipe:true},protocol?:{strictReplies:true}) { this.command = command; this.args = args; this.env = env; this.stopMode = stopMode;this.managedInput=ownership?.managedUI===true;this.controlPipe=ownership?.controlPipe===true;this.strictReplies=protocol?.strictReplies===true; }
	get pid(): number | null { return this.child?.pid ?? null; }
	/** Captures only already queued commands. Used by the actual UI owner to
	 * avoid global cleanup re-entering an unrelated in-flight readonly call. */
	commandsDrained():Promise<void>{return this.tail.then(()=>{});}
	private unverified(message:string,cause?:unknown):InputTerminationUnverifiedError{
		return this.stopFailure??=new InputTerminationUnverifiedError(message,{cause});
	}
	private start(): ChildProcessWithoutNullStreams {
		if(this.stopFailure)throw this.stopFailure;
		if(this.strictFailure)throw this.strictFailure;
		if(this.disposed)throw new Error("desktop helper was closed");
		if (this.child) return this.child;
		const child = spawn(this.command, this.args, { stdio: this.controlPipe?["pipe", "pipe", "pipe", "pipe"]:["pipe", "pipe", "pipe"], env: this.env }) as ChildProcessWithoutNullStreams;
		this.childCloses.set(child,new Promise<void>(yes=>{child.once('close',()=>yes());}));
		this.child = child;
		child.on("error", () => {});
		child.on("close", () => { if (this.child === child) this.child = null; });
		child.stdout.setEncoding("utf8");
		if(this.strictReplies)child.stdout.on('data',(chunk:string)=>{
			if(chunk.length&&!this.strictActive.has(child)){
				this.strictFailure??=new Error('readonly helper sent unsolicited data; process observation is unverified');
				void this.stopChild().catch(()=>{});
			}
		});
		child.stderr.resume();
		child.stdin.on("error", () => {});
		child.unref();
		for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
		return child;
	}
	async stop(): Promise<void> {
		const scope=currentInput();
		scope?.assertOpen();
		const pending=this.stopChild();scope?.track(pending);
		try{await pending;}
		catch(error){if(error instanceof InputTerminationUnverifiedError)scope?.retainUnverified(error);throw error;}
	}
	private stopChild():Promise<void>{
		const child=this.child;
		if(!child)return this.stopFailure?Promise.reject(this.stopFailure):Promise.resolve();
		if(this.stopping?.child===child)return this.stopping.promise;
		let yes!:()=>void,no!:(error:unknown)=>void;
		const promise=new Promise<void>((resolve,reject)=>{yes=resolve;no=reject;});
		// Publish before cancellation observers can synchronously reenter stop.
		this.stopping={child,promise};
		void this.stopOriginalChild(child).then(yes,no);return promise;
	}
	private async stopOriginalChild(child:ChildProcessWithoutNullStreams):Promise<void>{
		const deadline=performance.now()+3000,closed=this.childCloses.get(child);
		let grace:ReturnType<typeof setTimeout>|undefined,force:ReturnType<typeof setTimeout>|undefined,expiry:ReturnType<typeof setTimeout>|undefined;
		try{
			for(const observer of this.stopObservers)try{observer();}catch(error){this.unverified('helper cancellation observer failed',error);}
			if(!closed)throw this.unverified('original helper close record is missing');
			const signal=(value:'SIGTERM'|'SIGKILL')=>{try{child.kill(value);}catch(error){this.unverified('original helper termination request failed',error);}};
			if(child.exitCode===null&&child.signalCode===null){
				const terminate=()=>{signal('SIGTERM');force=setTimeout(()=>signal('SIGKILL'),200);};
				if(this.stopMode==='eof'){
					grace=setTimeout(terminate,2000);try{child.stdin.end();}catch(error){this.unverified('original helper input pipe could not close',error);terminate();}
				}else terminate();
			}
			// exit alone is insufficient: stdio may still belong to a descendant.
			// Both initially-live and already-exited children have the same bound.
			await Promise.race([closed,new Promise<never>((_,reject)=>{expiry=setTimeout(()=>reject(this.unverified('original helper did not actually close before its deadline; cleanup is unverified')),Math.max(0,deadline-performance.now()));})]);
			if(performance.now()>=deadline)this.unverified('original helper closed after its deadline; cleanup is unverified');
			if(this.stopMode==='eof'&&(child.exitCode!==0||child.signalCode!==null))this.unverified('desktop helper was forcibly stopped or failed; input release and cleanup remain unverified');
			if(this.stopFailure)throw this.stopFailure;
		}finally{clearTimeout(grace);clearTimeout(force);clearTimeout(expiry);}
	}
	async dispose():Promise<void>{
		currentInput()?.assertOpen();this.disposed=true;const errors:unknown[]=[];
		try{await this.stop();await this.tail;}catch(error){errors.push(error);}
		if(this.strictFailure&&!errors.includes(this.strictFailure))errors.push(this.strictFailure);
		if(errors.length===1)throw errors[0];
		if(errors.length)throw new AggregateError(errors,'helper cleanup and readonly protocol both failed');
	}
	/** Record/beforePermit hooks must await all their writes and never dispatch input.
	 * An interrupted unfinished hook poisons this owner even if it later completes.
	 * onDispatch is a synchronous notification AFTER the ACK write attempt; no awaits.
	 */
	send(command: Record<string, unknown>, timeoutMs = 15_000, cancellable = true, onRecord?: (record: Record<string, unknown>,context:HelperPermissionContext) => void | Promise<void>, onDispatch?: () => undefined, beforePermit?:(context:HelperPermissionContext)=>void|Promise<void>, admission?:HelperAdmission, beforeCommand?:(context:HelperBeforeCommandContext)=>void|Promise<void>): Promise<Record<string, unknown>> {
		const scope=currentInput(),lease = cancellable ? scope : undefined;
		const checkScope=()=>{scope?.assertOpen();if(this.managedInput)scope?.check();};
		const scopedCancellation=()=>{
			if(!this.managedInput||!scope||typeof command.lifecycleScope!=="string")return false;
			if(scope.signal.aborted)return true;
			try{scope.assertOpen();return false;}catch{return true;}
		};
		const gate=admission?{expiresAt:admission.expiresAt,signal:admission.beforeDispatch}:undefined;
		let admissionError:HelperAdmissionError|undefined,writeAttempted=false;
		const checkAdmission=()=>{
			if(admissionError)throw admissionError;
			if(gate?.signal?.aborted)throw admissionError=new HelperAdmissionError("aborted",gate.signal.reason);
			if(gate&&performance.now()>=gate.expiresAt)throw admissionError=new HelperAdmissionError("expired");
		};
		try{
			if(gate&&!Number.isFinite(gate.expiresAt))throw new Error("invalid absolute helper admission deadline");
			checkAdmission();
			checkScope();
			// Capture before queueing or waiting for persistence. A caller changing its
			// original object must not change the eventual command or route token.
			command=JSON.parse(JSON.stringify(command)) as Record<string,unknown>;
		}catch(error){return Promise.reject(error);}
		const run = async () => {
			checkAdmission();
			if(this.disposed)throw new Error("desktop helper was closed");
			if(this.strictFailure)throw this.strictFailure;
			checkScope();
			lease?.check();
			if(this.stopping?.child===this.child)await this.stopping.promise;
			checkAdmission();
			if(this.disposed)throw new Error("desktop helper was closed");
			checkScope();
			lease?.check();
			const child = this.start(), id = ++this.sequence;
			if(this.strictReplies)this.strictActive.add(child);
			// This previously registered close remains authorized after scope seal.
			// The actual UI participant owns both cancellation and final close.
			// In particular seal must not issue EOF before other AX work ends.
			const unwatch = this.managedInput?undefined:scope?.watch(() => this.stopChild(),cancellable);
			try {
				return await new Promise<Record<string, unknown>>((resolve, reject) => {
					const expires=Math.min(performance.now()+timeoutMs,gate?.expiresAt??Infinity);
					let buffer = "", finished = false, stderr = "", terminalError: Error | undefined, terminalReplyError: HelperResponseError | undefined, acceptStoppedFinal=false;
					const gated=typeof command.routeToken==="string"&&typeof onRecord==="function";
					let permissionMayHaveBeenSent=false;
					let routePhase:"unseen"|"preparing"|"permitted"="unseen";
					const permissionAbort=new AbortController(),permissionContext=Object.freeze({commandId:id,signal:permissionAbort.signal});
					let callbackPending=false,routeRecordCompleted=false;
					let unwatchManaged:(()=>void)|undefined;
					const abandonPermission=(reason:Error)=>{
						permissionAbort.abort(reason);
						if(callbackPending)this.unverified(reason.message+"; input permission persistence is unfinished; input release and cleanup remain unverified",reason);
					};
					const stopping=()=>abandonPermission(lease?.signal.aborted&&lease.signal.reason instanceof Error?lease.signal.reason:new Error("desktop helper stopped while persisting input permission"));
					this.stopObservers.add(stopping);
					const diagnostic = (chunk: Buffer | string) => { stderr = (stderr + String(chunk)).slice(-4000); };
					child.stderr.on("data", diagnostic);
					const done = (error?: Error, reply?: Record<string, unknown>) => {
						if (finished) return;
						abandonPermission(error??new Error("desktop helper command finished"));this.stopObservers.delete(stopping);
						if(this.stopFailure){error=this.stopFailure;reply=undefined;}
						finished = true; clearTimeout(timer);scope?.signal.removeEventListener("abort",managedAbort);unwatchManaged?.();
						this.strictActive.delete(child);
						child.stdout.off("data", data); child.stderr.off("data", diagnostic); child.off("close", closed); child.off("error", errored);
						if (error) reject(error); else resolve(reply!);
					};
					const closed = () => {
						const primary=terminalReplyError ?? terminalError ?? new Error(`desktop helper stopped (${child.exitCode ?? child.signalCode}); any already dispatched input must be observed before retrying${stderr ? `: ${stderr}` : ""}`);
						abandonPermission(primary);
						if(this.stopFailure)done(this.stopFailure);
						else if(this.stopMode==="eof"&&permissionMayHaveBeenSent&&(!terminalReplyError||child.exitCode!==0||child.signalCode!==null))done(this.unverified(primary.message+"; input release and cleanup remain unverified",primary));
						else done(primary);
					};
					const errored = (error: Error) => done(error);
					const protocolError = (error: unknown) => {
						if(finished||terminalError)return;
						acceptStoppedFinal=false;
						terminalError = error instanceof Error ? error : new Error("invalid desktop helper record");
						if(this.strictReplies)this.strictFailure??=terminalError;
						abandonPermission(terminalError);
						void this.stopChild().then(() => done(terminalError),error=>done(error));
					};
					const managedAbort=()=>{
						if(!this.managedInput)return;
						const reason=scope?.signal.reason instanceof Error?scope.signal.reason:new Error("managed input cancelled before permission");
						abandonPermission(reason);
						// An interrupted asynchronous record may still write later.
						// Its uncertainty cannot be erased by a no-input receipt.
					};
					if(this.managedInput&&scope){
						scope.signal.addEventListener("abort",managedAbort,{once:true});
						// Seal also revokes this command, even without signal.abort.
						// It marks an unfinished hook immediately and never sends EOF.
						unwatchManaged=scope.watch(()=>{managedAbort();return Promise.resolve();},false);
					}
					const persist=async(callback:()=>void|Promise<void>)=>{
						const result=callback();
						// Await is the only thenable lookup. A late completion cannot
						// authorize IO after a timeout, exit, cancellation or seal.
						if(result!==undefined){
							callbackPending=true;
							if(permissionAbort.signal.aborted)abandonPermission(permissionAbort.signal.reason);
							try{await result;}finally{callbackPending=false;}
						}
					};
					const permit = async (record:Record<string,unknown>) => {
						try {
							// Preserve exactly the received address, including nested data. These
							// objects came from JSON, so an iterative freeze cannot invoke getters.
							const pending:object[]=[record];
							while(pending.length){const value=pending.pop()!;Object.freeze(value);for(const child of Object.values(value))if(child!==null&&typeof child==="object")pending.push(child);}
							const ack=JSON.stringify({op:"route_ack",id,routeToken:command.routeToken,route:record.route,...(typeof command.lifecycleScope==="string"?{lifecycleScope:command.lifecycleScope}:{})})+"\n";
							const check=()=>{
								checkAdmission();
								checkScope();lease?.check();
								if(finished||terminalError||this.stopFailure||this.disposed||this.child!==child||this.stopping?.child===child||child.exitCode!==null||child.signalCode!==null||child.stdin.destroyed||child.stdin.writableEnded)throw new Error("desktop input command ended before route permission; no acknowledgement was sent");
								// Timer delivery can be delayed by synchronous work or microtasks.
								if(performance.now()>=expires)throw new Error(`desktop helper timed out after ${timeoutMs}ms before route permission; no acknowledgement was sent`);
							};
							check();await persist(()=>onRecord!(record,permissionContext));routeRecordCompleted=true;check();
							if(beforePermit){await persist(()=>beforePermit(permissionContext));check();}
							// A write can queue bytes before reporting failure. From this point
							// onwards a missing final receipt must retain the input claim.
							permissionMayHaveBeenSent=true;routePhase="permitted";
							try{child.stdin.write(ack);}finally{
								const notified=onDispatch?.();
								if(notified!==undefined){void Promise.resolve(notified).catch(()=>{});throw this.unverified("input dispatch notification must return synchronously; input release and cleanup remain unverified");}
							}
						}catch(error){
							if(scopedCancellation()&&routeRecordCompleted&&!permissionMayHaveBeenSent&&!callbackPending&&!this.stopFailure&&!terminalError&&!finished&&!(error instanceof InputTerminationUnverifiedError)){permissionAbort.abort(error);return;}
							protocolError(error);
						}
					};
					const data = (chunk: string) => {
						if (this.stopFailure || terminalReplyError || terminalError&&!acceptStoppedFinal) return;
						buffer += chunk;
						if (buffer.length > 16 * 1024 * 1024) { protocolError(new Error("desktop helper response exceeded its limit")); return; }
						let newline: number;
						while ((newline = buffer.indexOf("\n")) >= 0) {
							const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
							let reply: Record<string, unknown>;
							try { reply = JSON.parse(line); } catch {if(this.strictReplies){protocolError(new Error('readonly helper sent invalid JSON'));return;}continue;}
							if (!reply || typeof reply !== "object" || Array.isArray(reply)) { protocolError(new Error("invalid desktop helper response")); return; }
							if (reply.id !== id) {if(this.strictReplies){protocolError(new Error('readonly helper replied to a different request'));return;}continue;}
							if (reply.kind === "input-route") {
								if(terminalError)continue; // Expired commands can never acquire permission.
								try {
									if (!gated || reply.routeToken !== command.routeToken) throw new Error("unexpected desktop helper input record");
									if(routePhase!=="unseen")throw new Error("duplicate desktop helper input record");
									routePhase="preparing";void permit(reply);
								}
								catch (error) { protocolError(error); return; }
								continue;
							}
							if (typeof reply.ok !== "boolean") { protocolError(new Error("desktop helper reply omitted its result")); return; }
							if (this.strictReplies?buffer.length>0:buffer.trim()) { protocolError(new Error("desktop helper sent extra data after its final reply")); return; }
							const pointer=reply.inputPointer;
							const pointerHeld=pointer!==null&&typeof pointer==="object"&&!Array.isArray(pointer)&&(pointer as Record<string,unknown>).released!==true;
							const opcode=typeof command.op==="string"?command.op:"";
							const failedRelease=["release_pointer","release_key"].includes(opcode)&&reply.ok===false;
							const cleanup=reply.inputCleanup as Record<string,unknown>|null|undefined;
							const keyboardClean=cleanup!==null&&typeof cleanup==="object"&&!Array.isArray(cleanup)&&cleanup.schema==="mac-keyboard-cleanup-v1"&&cleanup.commandId===id&&cleanup.pendingKeys===0&&cleanup.failed===false&&cleanup.complete===true;
							const mouseCleanup=reply.inputMouseCleanup as Record<string,unknown>|null|undefined;
							const mouseClean=mouseCleanup!==null&&typeof mouseCleanup==="object"&&!Array.isArray(mouseCleanup)&&mouseCleanup.schema==="mac-mouse-cleanup-v1"&&mouseCleanup.commandId===id&&Number.isSafeInteger(mouseCleanup.registeredDowns)&&(mouseCleanup.registeredDowns as number)>=0&&mouseCleanup.pendingButtons===0&&mouseCleanup.failed===false&&mouseCleanup.complete===true;
							const cancelled=reply.cancelledBeforePermit as Record<string,unknown>|undefined;
							const cancelledBeforePermit=gated&&routePhase==="preparing"&&scopedCancellation()&&routeRecordCompleted&&!permissionMayHaveBeenSent&&!callbackPending&&!this.stopFailure&&reply.ok===false&&reply.inputSent===false&&keyboardClean&&mouseClean&&cancelled?.schema==="mac-pointer-cancel-before-permit-v1"&&cancelled.scope===command.lifecycleScope&&cancelled.commandId===id&&cancelled.routeToken===command.routeToken;
							if(cancelled!==undefined&&!cancelledBeforePermit&&routePhase!=="permitted"){protocolError(new Error("unverified cancellation before input permission"));return;}
							if(gated&&routePhase!=="permitted"&&!cancelledBeforePermit&&(routePhase==="preparing"||reply.ok||reply.inputSent!==false)){
								if(this.stopMode==="eof"&&(reply.ok||reply.inputSent!==false))this.unverified("desktop helper completed before route permission; input release and cleanup remain unverified");
								protocolError(new Error("desktop helper completed before route permission"));return;
							}
							const position=pointer!==null&&typeof pointer==="object"&&!Array.isArray(pointer)?pointer as Record<string,unknown>:undefined;
							const mousePositionClean=position?.released===true&&typeof position.x==="number"&&Number.isFinite(position.x)&&typeof position.y==="number"&&Number.isFinite(position.y)&&(position.button==="left"||position.button==="right")&&(!("positionVerified" in position)||position.positionVerified===true);
							const badMouseRecord=mouseCleanup!==undefined&&!mouseClean;
							const uncertainKey=["key","text","type_focus"].includes(opcode)&&reply.ok===false&&reply.inputSent===true&&!keyboardClean;
							const pointerMayHaveStarted=reply.inputSent===true||gated&&permissionMayHaveBeenSent&&reply.inputSent!==false;
							const uncertainPointer=["click","drag","release_pointer"].includes(opcode)&&(reply.ok===true||pointerMayHaveStarted)&&(!mouseClean||!mousePositionClean||reply.ok===true&&reply.inputSent!==true||(opcode!=="release_pointer"&&(mouseCleanup!.registeredDowns as number)<1));
							if(this.stopMode==="eof"&&(pointerHeld||failedRelease||uncertainKey||uncertainPointer||badMouseRecord)){
								const primary=new HelperResponseError(reply),failure=this.unverified(primary.message+"; input release and cleanup remain unverified",primary);
									void this.stopChild().then(()=>done(failure),error=>done(error));return;
							}
							if(cancelledBeforePermit){done(new HelperResponseError(reply));return;}
							if(terminalError||lease?.signal.aborted){
								terminalReplyError=new HelperResponseError({...reply,ok:false,error:terminalError?.message??"desktop input cancelled; verify any dispatched input"});
								void this.stopChild().then(()=>done(terminalReplyError),error=>done(error));
							}
							else if (reply.ok === true) done(undefined, reply); else done(new HelperResponseError(reply));
							return;
						}
					};
					const timer = setTimeout(() => { terminalError ??= new Error(writeAttempted?`desktop helper timed out after ${timeoutMs}ms and was stopped; verify any dispatched input${stderr ? `: ${stderr}` : ""}`:`desktop helper timed out after ${timeoutMs}ms before its first command write; no command bytes were sent`); acceptStoppedFinal=this.stopMode==="eof";void this.stopChild().then(() => done(terminalReplyError??terminalError),error=>done(error)); }, Math.max(0,expires-performance.now()));
					child.stdout.on("data", data); child.once("close", closed); child.once("error", errored);
					const checkBeforeCommand=()=>{
						checkScope();lease?.check();checkAdmission();
						if(finished||terminalError||this.stopFailure||this.disposed||this.child!==child||this.stopping?.child===child||child.exitCode!==null||child.signalCode!==null||child.stdin.destroyed||child.stdin.writableEnded)throw new Error("desktop helper ended before its first command write; no command bytes were sent");
						if(performance.now()>=expires)throw new Error(`desktop helper timed out after ${timeoutMs}ms before its first command write; no command bytes were sent`);
					};
					const writeCommand=()=>{
						try { const bytes=`${JSON.stringify({ ...command, id, deadline: Date.now() + Math.max(0,expires-performance.now()) })}\n`;checkBeforeCommand();writeAttempted=true;if(!gated)permissionMayHaveBeenSent=true;child.stdin.write(bytes); }
						catch (error) { done(writeAttempted&&error instanceof HelperAdmissionError?this.unverified("helper write was attempted; its outcome remains unverified",error):error instanceof Error ? error : new Error(String(error))); }
					};
					if(beforeCommand){
						void(async()=>{checkBeforeCommand();await persist(()=>beforeCommand(Object.freeze({...permissionContext,child})));checkBeforeCommand();writeCommand();})().catch(protocolError);
					}else writeCommand();
				});
			} finally { unwatch?.(); }
		};
		const queued = this.tail.then(run, run);
		this.tail = queued.catch(() => {});
		const result = gate ? new Promise<Record<string,unknown>>((resolve,reject)=>{
			let timer:ReturnType<typeof setTimeout>|undefined;
			const cleanup=()=>{clearTimeout(timer);gate.signal?.removeEventListener("abort",aborted);};
			const refuse=(reason:"expired"|"aborted")=>{
				if(writeAttempted)return;
				// Permanently revoke this queue entry before reporting refusal. Its
				// eventual run must throw before start/watch/write, never a late IO.
				admissionError??=new HelperAdmissionError(reason,reason==="aborted"?gate.signal?.reason:undefined);
				cleanup();reject(admissionError);
			};
			const aborted=()=>refuse("aborted");
			gate.signal?.addEventListener("abort",aborted,{once:true});
			timer=setTimeout(()=>refuse("expired"),Math.max(0,gate.expiresAt-performance.now()));
			if(gate.signal?.aborted)aborted();
			queued.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
		}) : queued;
		scope?.track(result);
		return result;
	}
}
