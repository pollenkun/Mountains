import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

/** The claim's owner is gone (or its PID now belongs to a later process) and no orphaned input helper is running. */
export async function staleClaim(path: string, probe: { alive(pid: number): boolean; startedAt(pid: number): Promise<number | null>; orphanedHelpers(): Promise<number> } = processProbe): Promise<boolean> {
	let owner: { pid?: unknown; started?: unknown };
	try { owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as typeof owner; } catch { return false; }
	const pid = owner.pid, claimed = owner.started;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
	if (probe.alive(pid)) {
		const started = await probe.startedAt(pid);
		// The same PID started after the claim was written is another process.
		if (started === null || typeof claimed !== "number" || started <= claimed + 1_000) return false;
	}
	if (await probe.orphanedHelpers() > 0) return false;
	await delay(150);
	return !(await probe.orphanedHelpers() > 0);
}
const processProbe = {
	alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } },
	async startedAt(pid: number): Promise<number | null> {
		try { const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 3_000, env: { ...process.env, LC_ALL: "C" } }); const t = Date.parse(stdout.trim()); return Number.isFinite(t) ? t : null; } catch { return null; }
	},
	/** Input helpers left without their Mountains process (re-parented to launchd), by executable name: the
	 * pointer helper is osascript, the others are Mountains' own binaries. Any orphaned osascript counts, since
	 * the script text cannot be read reliably; when unsure the claim is kept. */
	async orphanedHelpers(): Promise<number> {
		try {
			const { stdout } = await promisify(execFile)("ps", ["-ax", "-o", "ppid=,comm="], { timeout: 3_000, maxBuffer: 16 * 1024 * 1024 });
			return stdout.split("\n").filter(line => { const m = /^\s*(\d+)\s+(.*)$/.exec(line); return !!m && m[1] === "1" && /(^|\/)(osascript|window-server|event-data|input-claim)$/.test(m[2]!.trim()); }).length;
		} catch { return 1; }
	},
};
import type { ComponentInputClaims, ClaimState, ClaimInputAddress, ClaimProcessBirth } from "./input-claim-mac.ts";

/** Cleanup uncertainty must survive a caller catching an ordinary work error. */
export class InputTerminationUnverifiedError extends Error { completedResult?:unknown;dispatched?:boolean }
/** Cleanup completed, but its last observation invalidates business success. */
export class InputPostconditionError extends Error {
	readonly completedResult:unknown;readonly dispatched:boolean;
	constructor(message:string,completedResult:unknown,dispatched:boolean){super(message);this.completedResult=completedResult;this.dispatched=dispatched;}
}
/** Actual owned UI helper only. Local cancellation must never restore global
 * state; finish is called solely after all real business promises drain. */
export interface InputHelperLifetime {
	cancelLocal():Promise<void>;
	finishAfterDrain():Promise<{violation?:string}>;
	closeUnverified(reason:unknown):Promise<void>;
}

const invokingAX = new AsyncLocalStorage<readonly InputLease[]>();
const AX_OPERATIONS = new Set(["set_value","type_text","select_text","perform","scroll_to_visible","toggle","select","press","focus","expand","collapse","increment","decrement","activate","show_menu"]);

/** A lease covers validation, one mutation, and its observation; never model or approval waits. */
export class InputLease {
	readonly signal: AbortSignal;
	dispatched = false;
	private sealed = false;
	private readonly stopping = new Set<Promise<unknown>>();
	private readonly work = new Set<Promise<unknown>>();
	private terminationFailure: InputTerminationUnverifiedError | undefined;
	private readonly watchers = new Set<() => void>();
	private readonly owner: object | undefined;
	private readonly parent: InputLease | undefined;
	private readonly domain: (() => string | undefined) | undefined;
	private persistent: ComponentInputClaims | undefined;
	private persistentState: ClaimState | undefined;
	private persistentId: string | undefined;
	private persistentEpoch: string | undefined;
	private persistentOwner: ClaimProcessBirth | undefined;
	private readonly senderId = randomUUID();
	private axTail: Promise<unknown> = Promise.resolve();
	private inputHelper:InputHelperLifetime|undefined;
	private helperFinishStarted=false;
	private postcondition:string|undefined;
	constructor(signal: AbortSignal,owner?:object,parent?:InputLease,domain?:()=>string|undefined) {
		this.signal = signal; this.owner = owner; this.parent = parent; this.domain = domain;
	}
	assertOpen():void{if(this.sealed)throw new Error("desktop input lease has ended; delayed input was not sent");}
	assertDifferent(owner:object,domain?:string):void{
		for(let lease:InputLease|undefined=this;lease;lease=lease.parent){
			if(lease.owner===owner||domain!==undefined&&(lease.domain?.()===domain||lease.persistent?.domain===domain))throw new Error("recursive desktop input claim is not allowed; use the existing input lease");
		}
	}
	check(): void { this.assertOpen();if(this.terminationFailure)throw this.terminationFailure;this.signal.throwIfAborted(); }
	private unknown(cause: unknown): InputTerminationUnverifiedError {
		return this.terminationFailure ??= new InputTerminationUnverifiedError("persistent input bookkeeping could not be verified; input claim retained", {cause});
	}
	/** A directly awaited cleanup can fail outside track/watch. Its explicit
	 * uncertainty is still sticky and must survive this operation's finally. */
	retainUnverified(error:InputTerminationUnverifiedError):void{this.terminationFailure??=error;}
	/** Explicit candidate only. Never initializes, takes over, or repairs storage. */
	async attachPersistent(claims: ComponentInputClaims): Promise<void> {
		this.check(); this.persistent = claims;
		const state = await claims.call({op:"inspect"});
		this.check();
		if(state.lease)throw new Error("candidate input store is already owned; no input was sent");
		this.persistentId = randomUUID();
		try {
			this.persistentState = await claims.call({op:"acquire",revision:state.revision,leaseId:this.persistentId});
			const acquired=this.persistentState.lease;
			if(!acquired||acquired.id!==this.persistentId||acquired.owner.pid!==process.pid)throw new Error("original acquired input lease does not match");
			this.persistentEpoch=acquired.epoch;this.persistentOwner=Object.freeze({...acquired.owner});
			await this.persist({op:"register",senderKind:"node_ax",senderId:this.senderId,senderPid:process.pid});
		} catch(error) { throw this.unknown(error); }
	}
	private originalPersistent(state:ClaimState):void {
		const lease=state.lease,owner=this.persistentOwner,birth=lease?.owner;
		if(!lease||lease.id!==this.persistentId||lease.epoch!==this.persistentEpoch||!owner||!birth||birth.schema!==owner.schema||birth.pid!==owner.pid||birth.bootId!==owner.bootId||birth.startSeconds!==owner.startSeconds||birth.startMicroseconds!==owner.startMicroseconds)throw new Error("original persistent input lease identity changed");
	}
	get hasPersistentClaims():boolean{return this.persistent!==undefined;}
	/** Explicit legacy experiment, not a durable UI sender registration. */
	attachInputHelper(helper:InputHelperLifetime):void{
		this.check();
		if(this.persistent)throw new Error("legacy phased helper cannot bypass persistent UI sender admission");
		if(this.inputHelper){if(this.inputHelper===helper)return;throw new Error("one input lease cannot own two UI helpers");}
		this.inputHelper=helper;this.watch(()=>helper.cancelLocal());
	}
	get finalPostcondition():string|undefined{return this.postcondition;}
	async closeInputHelperUnverified(reason:unknown):Promise<void>{await this.inputHelper?.closeUnverified(reason);}
	/** Startup-only sender registration. This grants no stage, permit or begin.
	 * Until JXA consumes its own tickets, the caller may send only a Foundation
	 * ping and must await this exact child's EOF exit before ending the lease. */
	async registerReadOnlyHelper(child:ChildProcessWithoutNullStreams,signal:AbortSignal):Promise<void>{
		this.check();signal.throwIfAborted();
		const claims=this.persistent,pid=child.pid;
		if(!claims||!Number.isSafeInteger(pid)||!pid)throw new Error("candidate helper registration requires its actual spawned process");
		const live=()=>{this.check();signal.throwIfAborted();if(child.pid!==pid||child.exitCode!==null||child.signalCode!==null||child.stdin.destroyed||child.stdin.writableEnded)throw new Error("original helper ended before startup registration completed; no command was sent");};
		live();const birth=await claims.processIdentity(pid);live();
		const senderId=randomUUID();
		await this.persist({op:"register",senderKind:"file_only",senderId,senderPid:pid});
		const registered=this.persistentState?.lease?.senders.find(sender=>sender.id===senderId)?.birth;
		if(!registered||registered.schema!==birth.schema||registered.pid!==birth.pid||registered.bootId!==birth.bootId||registered.startSeconds!==birth.startSeconds||registered.startMicroseconds!==birth.startMicroseconds)throw this.unknown(new Error("registered helper process birth changed"));
		live();
	}
	private async persist(command: Record<string, unknown>): Promise<void> {
		const claims=this.persistent;
		if(!claims||!this.persistentState?.lease)throw this.unknown(new Error("original persistent input lease is missing"));
		const end=performance.now()+5000,op=String(command.op),business=["stage","permit","begin"].includes(op),cas=["register","stage","permit","seal","release"].includes(op);
		const remaining=()=>{const left=end-performance.now();if(left<=0)throw new Error("persistent input transaction deadline exceeded");return Math.min(5000,left);};
		const inspect=async()=>{
			try{const state=await claims.call({op:"inspect"},remaining());remaining();this.originalPersistent(state);this.persistentState=state;return state;}
			catch(error){throw this.unknown(error);}
		};
		for(let attempt=0;attempt<4;attempt++){
			if(business)this.check();
			const current=await inspect();
			if(business)this.check();
			try {
				const state=await claims.call({...command,leaseId:this.persistentId,epoch:this.persistentEpoch,revision:current.revision},remaining(),business?this.signal:undefined);
				remaining();if(op!=="release")this.originalPersistent(state);else if(state.lease)throw new Error("released persistent lease is still present");
				this.persistentState=state;return;
			} catch(error) {
				if(business&&claims.isUnsentCancellation(error,this.signal))throw this.signal.reason;
				// Only this native compare reply proves THIS file transaction made
				// no change. Never retry sender consumption or a missing reply.
				if(cas&&claims.isRevisionConflict(error)){
					try{remaining();}catch(deadline){throw this.unknown(deadline);}
					if(attempt<3)continue;
					if(op==="stage"||op==="permit"){
						const final=await inspect(),record=final.lease!.commands.find(item=>item.id===command.commandId);
						if(!record||record.phase==="registered"){
							// No ACK or begin has been issued by this path. A compound
							// tool may still have earlier completed input; keep its result.
							throw new Error("input record remained busy; this command was not started");
						}
					}
				}
				throw this.unknown(error);
			}
		}
	}

	/** Each exact retained AX method gets its own sender ticket, never a compound action. */
	ax<T>(ownerPid:number|null, receiverPid:number|null|undefined, operation:string, invoke:()=>Promise<T>):Promise<T> {
		try{this.check();if(invokingAX.getStore()?.includes(this))throw new Error("recursive AX input cannot await its own sender queue");}catch(error){return Promise.reject(error);}
		const send=()=>invokingAX.run([...(invokingAX.getStore()??[]),this],async()=>await invoke());
		const pending=this.axTail.then(async()=>{
			this.check();
			if(!this.persistent){this.check();return await send();}
			// Operation names come from the call sites, not model text or labels.
			if(!AX_OPERATIONS.has(operation))throw new Error("unknown AX operation; no input was sent");
			const claims=this.persistent;
			const owner=await claims.processIdentity(ownerPid as number);
			this.check();
			const target=receiverPid===ownerPid?owner:await claims.processIdentity(receiverPid as number);
			this.check();
			// A remote sheet's CG window is not the host document's window.
			// Use truthful process-only metadata; retain the original AX handle in invoke.
			const address:ClaimInputAddress={schema:"mac-input-address-v1",kind:"process",operation,owner:{process:owner},target:{process:target}};
			const ticket={commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address};
			await this.persist({op:"stage",senderId:this.senderId,...ticket});
			this.check();
			await this.persist({op:"permit",...ticket});
			this.check();
			await this.persist({op:"begin",...ticket,openObligations:[]});
			let failed=false,primary:unknown,result:T|undefined;
			try {
				// No await between this last cancellation check and actual invocation.
				this.check(); result=await send();
			} catch(error) {failed=true;primary=error;}
			try {
				// AX APIs synthesize no held CG keys/buttons. This records sender
				// completion only, not GUI success or global focus restoration.
				await this.persist({op:"receipt",...ticket,receipt:{schema:"input-claim-cleanup-v2",pendingKeys:0,pendingButtons:0,failed:false,complete:true}});
			} catch(error) {
				if(failed){
					const combined=new InputTerminationUnverifiedError("AX call failed and its persistent receipt remains unverified",{cause:new AggregateError([primary,error],"AX call and receipt failed")});
					this.terminationFailure=combined;throw combined;
				}
				throw this.unknown(error);
			}
			if(failed)throw primary;
			return result as T;
		});
		this.axTail=pending.catch(()=>{});this.track(pending);return pending;
	}
	/** Called after all real AX promises and receipts end, even after cancellation. */
	async finishPersistent():Promise<void>{
		if(this.terminationFailure)throw this.terminationFailure;
		if(this.inputHelper){
			if(!this.sealed||this.work.size)throw this.unknown(new Error("global helper cleanup requires drained sealed business input"));
			if(this.helperFinishStarted)throw this.unknown(new Error("global helper cleanup cannot be replayed"));
			this.helperFinishStarted=true;
			const result=await this.inputHelper.finishAfterDrain();if(this.terminationFailure)throw this.terminationFailure;this.postcondition=result.violation;
		}
		if(!this.persistentState)return;
		await this.persist({op:"seal"});
		await this.persist({op:"retire",senderId:this.senderId});
		await this.persist({op:"release"});
	}
	track<T>(promise:Promise<T>):void{
		this.assertOpen();this.work.add(promise);
		void promise.then(()=>this.work.delete(promise),error=>{
			this.work.delete(promise);
			if(error instanceof InputTerminationUnverifiedError)this.terminationFailure??=error;
		});
	}
	/** Register termination before sending anything to an out-of-process input helper. */
	watch(stop: () => Promise<unknown>,cancelOnAbort=true): () => void {
		this.assertOpen();let pending:Promise<unknown>|undefined;
		const abort = () => {
			if(pending)return;
			try{pending=Promise.resolve(stop());}catch(error){pending=Promise.reject(error);}
			this.stopping.add(pending);void pending.catch(()=>{});
		};
		this.watchers.add(abort);
		if(cancelOnAbort){this.signal.addEventListener("abort", abort, { once: true });if(this.signal.aborted)abort();}
		return () => {this.watchers.delete(abort);this.signal.removeEventListener("abort", abort);};
	}
	/** Close the lifetime before waiting. Timers inherit AsyncLocalStorage too. */
	seal():boolean{
		if(this.sealed)return false;this.sealed=true;
		const unfinished=this.work.size>0;for(const stop of this.watchers)stop();return unfinished;
	}
	async drained(): Promise<void> {
		const [stops]=await Promise.all([Promise.allSettled(this.stopping),Promise.allSettled(this.work)]);
		const failure=stops.find(result=>result.status==="rejected");
		if(failure?.status==="rejected")throw new InputTerminationUnverifiedError("input helper stop failed; termination remains unverified",{cause:failure.reason});
		if(this.terminationFailure)throw this.terminationFailure;
	}
}

const active = new AsyncLocalStorage<InputLease>();
export const currentInput = (): InputLease | undefined => active.getStore();
/** Internal fixed claim transport only; never wrap a business callback or AX method. */
export const outsideInputScope = <T>(transport:()=>T):T => active.exit(transport);

/** FIFO within a process; an atomic directory claim also excludes other Mountains processes.
 * A crashed owner's claim is deliberately not stolen on a timer: its input helpers may still run.
 */
export class InputCoordinator {
	private tail: Promise<void> = Promise.resolve();
	private readonly versions = new Map<string, string>();
	private stopFailure:Error|undefined;
	private domain:string|undefined;
	readonly directory: string | undefined;
	private readonly candidateClaims: ComponentInputClaims | undefined;
	constructor(directory?: string,candidateClaims?:ComponentInputClaims) {
		this.directory = directory; this.candidateClaims = candidateClaims;
		// A caller must pass already initialized, privately pinned component storage.
		if(candidateClaims)void candidateClaims.domain;
	}
	private revisionFile(key: string): string { return join(this.candidateClaims?.directory??this.directory!, `${createHash("sha256").update(key).digest("hex")}.revision`); }
	async revision(key: string): Promise<string> {
		if (!this.directory&&!this.candidateClaims) return this.versions.get(key) ?? "0";
		if(this.candidateClaims)await this.candidateClaims.call({op:"inspect"});
		try { return await readFile(this.revisionFile(key), "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "0"; throw error; }
	}
	async changed(key: string): Promise<void> {
		const version = randomUUID();
		if (!this.directory&&!this.candidateClaims) { this.versions.set(key, version); return; }
		if(this.candidateClaims)await this.candidateClaims.call({op:"inspect"});
		const file = this.revisionFile(key), temporary = `${file}.${randomUUID()}`;
		await writeFile(temporary, version, { mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	}
	private async claim(signal: AbortSignal, parent?: InputLease): Promise<() => Promise<void>> {
		if (!this.directory) return async () => {};
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const info = await lstat(this.directory);
		if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error("desktop input directory must be private to this user");
		this.domain=`filesystem:${info.dev}:${info.ino}`;
		parent?.assertOpen();
		parent?.assertDifferent(this, this.domain);
		const path = join(this.directory, "input.lock");
		let nextStaleCheck = 0;
		for (const end = Date.now() + 30_000; ; ) {
			signal.throwIfAborted();
			try { await mkdir(path, { mode: 0o700 }); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// A claim whose owner died (a run stopped with a second Ctrl-C, a crash) used to block every later
				// action. It is taken over only once the owner is gone and no orphaned input helper is left: helpers
				// exit at end of input, so one still running may still be sending events.
				if (Date.now() >= nextStaleCheck) {
					nextStaleCheck = Date.now() + 500;
					if (await staleClaim(path)) { await rm(path, { recursive: true, force: true }); continue; }
				}
			}
			if (Date.now() >= end) throw new Error(`another desktop action still owns ${path}; no input was sent. If a process crashed, inspect its helpers before removing that claim`);
			await delay(40, undefined, { signal });
		}
		try { await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, started: Date.now() }), { mode: 0o600, flag: "wx" }); }
		catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
		return () => rm(path, { recursive: true, force: true });
	}
	run<T>(signal:AbortSignal,run:(lease:InputLease)=>Promise<T>):Promise<T>{
		const parent=currentInput();
		try{parent?.assertOpen();parent?.assertDifferent(this);if(this.candidateClaims)parent?.assertDifferent(this,this.candidateClaims.domain);}catch(error){return Promise.reject(error);}
		const inherited=parent?AbortSignal.any([signal,parent.signal]):signal;
		const pending=this.runScoped(inherited,run,parent);parent?.track(pending);return pending;
	}
	private async runScoped<T>(signal: AbortSignal, run: (lease: InputLease) => Promise<T>,parent?:InputLease): Promise<T> {
		if(parent&&this.directory){
			try{const info=await lstat(this.directory);parent.assertDifferent(this,`filesystem:${info.dev}:${info.ino}`);}
			catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
			parent.assertOpen();
		}
		if(this.stopFailure)throw new InputTerminationUnverifiedError("earlier input helper termination is unverified; no further input was sent",{cause:this.stopFailure});
		let release!: () => void;
		const previous = this.tail;
		this.tail = new Promise<void>(resolve => { release = resolve; });
        try {
            await new Promise<void>((resolve, reject) => {
                const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("cancelled while waiting for desktop input")); };
                signal.addEventListener("abort", abort, { once: true });
                previous.then(() => { signal.removeEventListener("abort", abort); resolve(); });
                if (signal.aborted) abort();
            });
        } catch (error) {
            // Preserve FIFO ownership until the earlier holder finishes, even though this caller left.
            void previous.then(release);
            throw error;
        }
		let unclaim: (() => Promise<void>) | undefined;
		const lease = new InputLease(signal,this,parent,()=>this.domain);
		let failed=false,primary:unknown,completedResult:unknown;
		try {
			lease.check();
			parent?.assertOpen();
			if(this.stopFailure)throw new InputTerminationUnverifiedError("earlier input helper termination is unverified; no further input was sent",{cause:this.stopFailure});
			unclaim = await this.claim(signal, parent);
			if(this.candidateClaims)await lease.attachPersistent(this.candidateClaims);
			lease.check();
			parent?.assertOpen();
			completedResult=await active.run(lease, () => run(lease));return completedResult as T;
		}catch(error){failed=true;primary=error;if(error instanceof InputTerminationUnverifiedError)lease.retainUnverified(error);throw error;
		} finally {
			const unfinished=lease.seal();
			try{await lease.drained();await lease.finishPersistent();}
			catch(error){
				let cleanupFailure:unknown=error;
				try{await lease.closeInputHelperUnverified(error);}catch(close){cleanupFailure=new AggregateError([error,close],"input cleanup and owned helper closure failed");}
				this.stopFailure=cleanupFailure instanceof Error?cleanupFailure:new Error("input helper termination remains unverified");
				// Keep the cross-process claim, but wake local waiters so they fail
				// explicitly instead of hanging forever behind this failed cleanup.
				release();
				let primaryMessage="input operation failed";
				try{if(primary instanceof Error&&typeof primary.message==="string")primaryMessage=primary.message;}catch{/* Keep opaque errors without invoking their formatter again. */}
				const failure=new InputTerminationUnverifiedError((failed?primaryMessage+"; ":"")+"input helper termination could not be verified; input claim retained; no further input is allowed",{cause:failed?new AggregateError([primary,this.stopFailure],"input operation and cleanup failed"):this.stopFailure});
				failure.completedResult=completedResult;failure.dispatched=lease.dispatched;throw failure;
			}
			try { await unclaim?.(); } finally { release(); }
			if(lease.finalPostcondition&&!failed)throw new InputPostconditionError(lease.finalPostcondition,completedResult,lease.dispatched);
			if(unfinished&&!failed)throw new Error("desktop input lease ended with unawaited helper work; it was stopped before releasing the input claim; verify any dispatched input");
		}
	}
}

export const nativeCoordinator = new InputCoordinator(process.platform === "win32" ? undefined : `/tmp/mountains-computer-${process.getuid?.() ?? "user"}`);
const desktops = new WeakMap<object, InputCoordinator>();
export function coordinatorFor(desktop: object): InputCoordinator {
	let coordinator = desktops.get(desktop);
	if (!coordinator) { coordinator = new InputCoordinator(); desktops.set(desktop, coordinator); }
	return coordinator;
}
