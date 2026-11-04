import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { currentInput, InputTerminationUnverifiedError, type InputHelperLifetime, type InputLease } from "./coordinator.ts";
import { JsonHelper, type HelperBeforeCommandContext } from "./helper.ts";

const READ_ONLY=new Set(["ping","app_instance","retain_receivers","selection","date_values","canonical_action"]);
interface PendingControl {scope:string;resolve:(row:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}
interface Lifetime extends InputHelperLifetime {id:string;lease:InputLease;ready?:Promise<void>;cancel?:Promise<void>;done:Promise<void>;complete:()=>void;failed:()=>void}

/** Explicit legacy experiment. The actual helper keeps read-only AX references
 * between leases. Business permission and global cleanup never survive a lease.
 * This is not the persistent sender protocol or crash recovery. */
export class PhasedPointerActor {
	readonly helper:JsonHelper;
	readonly nonce=randomUUID();
	private child:ChildProcessWithoutNullStreams|undefined;
	private control:Duplex|undefined;
	private closed:Promise<void>|undefined;
	private active:Lifetime|undefined;
	private sequence=0;
	private lastReply=0;
	private buffer="";
	private readonly pending=new Map<number,PendingControl>();
	private failure:InputTerminationUnverifiedError|undefined;
	private disposing=false;
	private finishing:Promise<void>|undefined;
	constructor(command:string,args:string[],env:NodeJS.ProcessEnv){
		this.helper=new JsonHelper(command,args,{...env,MOUNTAINS_POINTER_PHASED:this.nonce},"eof",{managedUI:true,controlPipe:true});
	}
	get pid():number|null{return this.child?.pid??null;}
	private unknown(cause:unknown):InputTerminationUnverifiedError{
		const failure=this.failure??=new InputTerminationUnverifiedError("phased pointer lifetime is unverified; input claim retained",{cause});
		this.active?.lease.retainUnverified(failure);
		for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(failure);}this.pending.clear();
		return failure;
	}
	private attach(child:ChildProcessWithoutNullStreams):void{
		if(this.failure)throw this.failure;
		if(this.child){if(this.child!==child)throw this.unknown(new Error("phased actor cannot silently replace its original process"));return;}
		const stream=child.stdio[3] as Duplex|undefined;
		if(!stream||typeof stream.write!=="function")throw this.unknown(new Error("private pointer control pipe missing"));
		this.child=child;this.control=stream;stream.setEncoding("utf8");
		const controlLost=(cause:unknown)=>{if(this.disposing&&!this.active)return;this.unknown(cause);void this.forceClose();};
		stream.on("error",controlLost);stream.on("end",()=>controlLost(new Error("original pointer control channel ended")));
		stream.on("data",(chunk:string)=>this.receive(chunk));
		this.closed=new Promise<void>(resolve=>child.once("close",()=>{
			for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(this.unknown(new Error("original pointer closed before its control receipt")));}this.pending.clear();
			if(this.active)this.unknown(new Error("active pointer closed without final quiescence"));resolve();
		}));
	}
	private receive(chunk:string):void{
		if(this.failure)return;
		this.buffer+=chunk;
		if(this.buffer.length>16*1024*1024){this.unknown(new Error("pointer control response exceeded its bound"));return;}
		for(;;){const nl=this.buffer.indexOf("\n");if(nl<0)return;const line=this.buffer.slice(0,nl);this.buffer=this.buffer.slice(nl+1);let row:Record<string,unknown>;
			try{row=JSON.parse(line);}catch{this.unknown(new Error("invalid JSON on the private pointer control channel"));return;}
			if(!row||typeof row!=="object"||Array.isArray(row)||row.kind!=="pointer-lifecycle"){this.unknown(new Error("unexpected frame on the private pointer control channel"));return;}
			const id=typeof row.id==="number"&&Number.isSafeInteger(row.id)?row.id:NaN,request=this.pending.get(id);
			if(!request||id<=this.lastReply||row.nonce!==this.nonce||row.scope!==request.scope||row.pid!==this.child?.pid){this.unknown(new Error("late or mismatching pointer control receipt"));return;}
			this.lastReply=id;this.pending.delete(id);clearTimeout(request.timer);
			if(row.ok!==true){request.reject(this.unknown(new Error(String(row.error??"pointer control refused"))));return;}else request.resolve(row);
		}
	}
	private request(lifetime:Lifetime,op:"begin_scope"|"cancel_local"|"finish_scope"):Promise<Record<string,unknown>>{
		if(this.failure)return Promise.reject(this.failure);
		const child=this.child,control=this.control;
		if(this.active!==lifetime||!child||!control||child.exitCode!==null||child.signalCode!==null||control.destroyed||control.writableEnded)return Promise.reject(this.unknown(new Error("original pointer control owner is unavailable")));
		const id=++this.sequence;
		return new Promise((resolve,reject)=>{
			const timer=setTimeout(()=>{this.pending.delete(id);reject(this.unknown(new Error("pointer local cleanup or final receipt exceeded 2000ms")));void this.forceClose();},2000);
			this.pending.set(id,{scope:lifetime.id,resolve,reject,timer});
			try{control.write(JSON.stringify({op,id,nonce:this.nonce,scope:lifetime.id})+"\n",error=>{if(error){const item=this.pending.get(id);if(item){this.pending.delete(id);clearTimeout(item.timer);item.reject(this.unknown(error));}}});}
			catch(error){this.pending.delete(id);clearTimeout(timer);reject(this.unknown(error));}
		});
	}
	private bind(lease:InputLease):Lifetime{
		lease.check();if(this.failure)throw this.failure;if(this.disposing)throw new Error("pointer actor was disposed");
		if(this.active){if(this.active.lease!==lease)throw new Error("another input lease owns this pointer actor");return this.active;}
		let complete!:()=>void,failed!:()=>void;
		const done=new Promise<void>((resolve,reject)=>{complete=resolve;failed=()=>reject(this.unknown(new Error("pointer lifetime did not finish")));});void done.catch(()=>{});
		const lifetime:Lifetime={id:randomUUID(),lease,done,complete,failed,
			cancelLocal:()=>lifetime.cancel??=(async()=>{
				// An aborted command may still be in beforeCommand. Its ready
				// promise belongs to real work, not to the actor's whole lifetime.
				const ready=lifetime.ready;if(!ready)return;await ready;
				const row=await this.request(lifetime,"cancel_local");
				if(row.pendingKeys!==0||row.pendingButtons!==0||row.failed!==false||row.complete!==true)throw this.unknown(new Error("original pointer local release remains unknown"));
			})(),
			finishAfterDrain:async()=>{
				await lifetime.cancelLocal();
				if(!lifetime.ready){this.active=undefined;complete();return {};}
				let release!:()=>void;this.finishing=new Promise<void>(resolve=>{release=resolve;});
				// Readonly calls already queued may finish; later ones capture the
				// new barrier and cannot run AX during global restoration.
				const prior=this.helper.commandsDrained();let row:Record<string,unknown>;
				try{await prior;row=await this.request(lifetime,"finish_scope");if(this.failure)throw this.failure;}finally{this.finishing=undefined;release();}
				if(row.idle!==true||row.resourcesClean!==true)throw this.unknown(new Error("pointer did not enter read-only idle"));
				const notice=row.foreground as {unchanged?:unknown;byUser?:unknown;frontChanged?:unknown;focusChanged?:unknown;restored?:unknown;attributionUnknown?:unknown;reason?:unknown}|undefined;
				if(!notice||[notice.unchanged,notice.byUser,notice.frontChanged,notice.focusChanged,notice.restored,notice.attributionUnknown].some(value=>typeof value!=="boolean")||typeof notice.reason!=="string"||notice.attributionUnknown!==false||notice.restored!==true&&notice.byUser!==true)throw this.unknown(new Error("pointer final foreground and focus cleanup receipt is incomplete"));
				this.active=undefined;complete();
				const changed=notice.unchanged!==true||notice.byUser===true||notice.frontChanged===true||notice.focusChanged===true;
				return changed?{violation:typeof notice?.reason==="string"&&notice.reason?notice.reason:notice?.byUser===true?"the user changed the target app; read its window again before continuing":"background input changed the user's foreground or keyboard focus"}:{};
			},
			closeUnverified:async(reason)=>{this.unknown(reason);await this.forceClose();failed();},
		};
		this.active=lifetime;
		try{lease.attachInputHelper(lifetime);}catch(error){this.active=undefined;complete();throw error;}
		return lifetime;
	}
	/** Capture this lease once. Never fetch a mutable current lease after an
	 * awaited route hook, or an old command could inherit the next lease. */
	command(op:string):{scope:string|null;assertValid:()=>void;beforeCommand:(context:HelperBeforeCommandContext)=>Promise<void>}{
		const lease=currentInput(),lifetime=lease?this.bind(lease):undefined,barrier=this.finishing;
		if(!lifetime&&!READ_ONLY.has(op))throw new Error("phased pointer mutation requires an active input lease");
		const assertValid=()=>{if(this.failure)throw this.failure;lease?.check();if(this.disposing)throw new Error("pointer actor was disposed");if(lifetime&&(this.active!==lifetime||lifetime.cancel))throw new Error("captured pointer input scope has ended");};
		return {scope:lifetime?.id??null,assertValid,beforeCommand:async context=>{
			await barrier;if(this.failure)throw this.failure;
			assertValid();context.signal.throwIfAborted();this.attach(context.child);
			if(lifetime){
				lifetime.ready??=(async()=>{const row=await this.request(lifetime,"begin_scope");if(row.active!==true)throw this.unknown(new Error("pointer did not open its original scope"));})();
				await lifetime.ready;assertValid();
			}
		}};
	}
	private async forceClose():Promise<void>{
		const child=this.child;if(!child)return;
		if(child.exitCode===null&&child.signalCode===null){child.kill("SIGTERM");const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");},200);try{await this.closed;}finally{clearTimeout(timer);}}
		else await this.closed;
	}
	assertDisposable():void{
		const caller=currentInput();caller?.assertOpen();
		if(this.active&&caller===this.active.lease)throw new Error("cannot await pointer disposal inside the lease that must finish it");
	}
	async dispose():Promise<void>{
		this.assertDisposable();
		this.disposing=true;
		const active=this.active;
		if(active){
			await active.cancelLocal();await active.done;
		}
		// Public stop/dispose still means the exact process has actually exited.
		await this.helper.dispose();if(this.failure)throw this.failure;
	}
}
