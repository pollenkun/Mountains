import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {sha256} from './integrity.ts';
import {readExecutableProcess,readWriterProcess,writerProcessIdentity,writerState,type ExecutableProcessObservation,type WriterProcessIdentity} from './process-identity.ts';

type Probe={path:string;sha256:string};
export interface OwnPowerAssertion{id:string;type:'PreventUserIdleSystemSleep'|'PreventSystemSleep'}
/** Only active records owned by the exact caffeinate PID are retained. Never
 * persist other applications' assertion names, paths or private details. */
export function ownPowerAssertions(text:string,pid:number):OwnPowerAssertion[]{
	assert.ok(typeof text==='string'&&Buffer.byteLength(text)<=1048576);assert.ok(Number.isSafeInteger(pid)&&pid>0);
	const records:OwnPowerAssertion[]=[];
	for(const line of text.split('\n')){
		const owner=line.match(/^\s*pid (\d+)\(([^)]*)\):/);if(!owner||Number(owner[1])!==pid)continue;
		assert.equal(owner[2],'caffeinate','power assertion PID belongs to another executable');
		const row=line.match(/^\s*pid \d+\(caffeinate\):\s+\[(0x[0-9a-f]+)\]\s+\d+:\d+:\d+\s+(\S+)\s+named:/i);assert.ok(row,'malformed own power assertion');
		const type=row[2]==='NoIdleSleepAssertion'?'PreventUserIdleSystemSleep':row[2];
		assert.ok(type==='PreventUserIdleSystemSleep'||type==='PreventSystemSleep','unexpected display/user-active or other assertion');
		assert.ok(!records.some(record=>record.id===row[1]||record.type===type),'duplicate own power assertion');records.push({id:row[1]!,type});
	}
	return records.sort((a,b)=>a.type.localeCompare(b.type));
}
export function isACPower(text:string):boolean{
	const line=text.split('\n')[0];assert.ok(line==="Now drawing from 'AC Power'"||line==="Now drawing from 'Battery Power'",'unknown actual power source');return line==="Now drawing from 'AC Power'";
}

/** Case-local AC preparation, never a model tool or a persistent preference.
 * It requests no display wake or user activity. It cannot prevent every forced
 * sleep or prove uninterrupted focus; the independent monitor stays strict. */
export class RunAwake{
	private child:ChildProcess|undefined;
	private closed:Promise<{code:number|null;signal:NodeJS.Signals|null;error?:string}>|undefined;
	private birth:ExecutableProcessObservation|undefined;
	private ids:OwnPowerAssertion[]|undefined;
	private binarySha256:string|undefined;
	private failure:Error|undefined;
	private closing:Promise<unknown>|undefined;
	private starting=false;
	private startWork:Promise<unknown>|undefined;
	private readonly probe:Probe;
	private readonly onFailure:(error:Error)=>unknown;
	private readonly observations=new AbortController();
	private readonly work=new Set<Promise<unknown>>();
	readonly owner:WriterProcessIdentity;
	readonly args:readonly string[];
	constructor(probe:Probe,owner:WriterProcessIdentity,onFailure:(error:Error)=>unknown=()=>{},holdSeconds=120){
		assert.ok(Number.isInteger(holdSeconds)&&holdSeconds>=1&&holdSeconds<=300,'case-local power timeout must be between 1 and 300 seconds');
		this.probe={...probe};this.onFailure=onFailure;
		this.owner=writerProcessIdentity(owner);assert.equal(this.owner.pid,process.pid,'only the current controller may hold this case-local assertion');
		this.args=Object.freeze(['-i','-s','-t',String(holdSeconds),'-w',String(this.owner.pid)]);
	}
	private track<T>(operation:Promise<T>):Promise<T>{
		this.work.add(operation);operation.then(()=>this.work.delete(operation),()=>this.work.delete(operation));return operation;
	}
	private failed(message:string):void{
		if(this.failure)return;this.failure=new Error(message);
		try{this.track(Promise.resolve(this.onFailure(this.failure)).catch(()=>{this.failure=new Error('case-local power failure notification failed');}));}
		catch{this.failure=new Error('case-local power failure notification failed');}
	}
	private signal(signal?:AbortSignal):AbortSignal{return signal?AbortSignal.any([signal,this.observations.signal]):this.observations.signal;}
	private async drain():Promise<void>{
		let timer:ReturnType<typeof setTimeout>|undefined;
		try{await Promise.race([(async()=>{while(this.work.size)await Promise.allSettled([...this.work]);})(),new Promise<never>((_yes,no)=>{timer=setTimeout(()=>no(new Error('power observations or notifications did not actually settle')),5000);})]);}
		finally{clearTimeout(timer);}
	}
	private active():void{assert.ok(!this.closing&&!this.failure,'case-local power preparation is closed or failed');assert.ok(this.child&&this.child.exitCode===null&&this.child.signalCode===null,'case-local power process ended');}
	private powerRead(which:'assertions'|'batt',signal?:AbortSignal):Promise<string>{return this.track(this.powerReadActual(which,signal));}
	private async powerReadActual(which:'assertions'|'batt',signal?:AbortSignal):Promise<string>{
		signal?.throwIfAborted();
		const child=spawn('/usr/bin/pmset',['-g',which],{stdio:['ignore','pipe','pipe']});let out='',error:Error|undefined,finished=false;
		child.on('error',()=>{error??=new Error('read-only power query could not start');});
		child.stdout.on('data',data=>{out+=String(data);if(Buffer.byteLength(out)>1048576){error??=new Error('read-only power query exceeded its bound');child.kill('SIGKILL');}});child.stderr.resume();
		const kill=()=>{if(!finished){error??=new Error('read-only power query was cancelled or timed out');child.kill('SIGKILL');}};
		const timer=setTimeout(kill,2000);signal?.addEventListener('abort',kill,{once:true});
		try{return await new Promise<string>((yes,no)=>child.once('close',(code,sig)=>{finished=true;if(error||code!==0||sig!==null)no(error??new Error('read-only power query failed'));else yes(out);}));}
		finally{clearTimeout(timer);signal?.removeEventListener('abort',kill);}
	}
	start(signal:AbortSignal):Promise<unknown>{
		assert.equal(process.platform,'darwin');assert.ok(!this.child&&!this.startWork&&!this.starting&&!this.closing&&!this.failure,'case-local power preparation cannot restart');this.starting=true;
		this.startWork=this.track(Promise.resolve().then(()=>this.startActual(this.signal(signal))));return this.startWork;
	}
	private async startActual(signal:AbortSignal):Promise<unknown>{
		try{
			signal.throwIfAborted();assert.ok(!this.closing);assert.equal(writerState(this.owner,await readWriterProcess(this.probe,this.owner.pid,signal)),'alive');
			assert.equal(isACPower(await this.powerRead('batt',signal)),true,'system-sleep preparation needs actual AC power');
			assert.equal(realpathSync('/usr/bin/caffeinate'),'/usr/bin/caffeinate');this.binarySha256=sha256(readFileSync('/usr/bin/caffeinate'));signal.throwIfAborted();assert.ok(!this.closing&&!this.failure,'power preparation closed before actual spawn');
			const child=this.child=spawn('/usr/bin/caffeinate',[...this.args],{stdio:'ignore'});let launchError:string|undefined;
			child.on('error',()=>{launchError='case-local power process could not start';this.failed(launchError);});
			this.closed=new Promise(yes=>child.once('close',(code,signal)=>{const ended={code,signal,...(launchError?{error:launchError}:{})};yes(ended);if(!this.closing)this.failed('case-local power process ended before cleanup');}));
			assert.ok(child.pid);const observed=await readExecutableProcess(this.probe,child.pid,signal);assert.ok(observed);assert.equal(observed.executable,'/usr/bin/caffeinate');this.birth=observed;
			const deadline=performance.now()+2000;
			for(;;){
				this.active();signal.throwIfAborted();const records=ownPowerAssertions(await this.powerRead('assertions',signal),child.pid);
				assert.ok(performance.now()<deadline,'both own power assertions did not become active');
				if(records.length===2){this.ids=records;return await this.check(signal);}
				await new Promise<void>(yes=>setTimeout(yes,10));
			}
		}catch(error){this.failed('case-local power preparation failed');throw error;}finally{this.starting=false;}
	}
	check(signal?:AbortSignal):Promise<unknown>{return this.track(this.checkActual(this.signal(signal)));}
	private async checkActual(signal:AbortSignal):Promise<unknown>{
		const at=Date.now();this.active();signal?.throwIfAborted();assert.ok(this.birth&&this.ids&&this.binarySha256);
		try{
			assert.equal(sha256(readFileSync('/usr/bin/caffeinate')),this.binarySha256);
			const observed=await readExecutableProcess(this.probe,this.birth.pid,signal);assert.deepEqual(observed,this.birth);
			assert.equal(isACPower(await this.powerRead('batt',signal)),true,'AC power was removed');
			const assertions=ownPowerAssertions(await this.powerRead('assertions',signal),this.birth.pid);assert.deepEqual(assertions,this.ids,'own power assertions disappeared or changed');
			const after=await readExecutableProcess(this.probe,this.birth.pid,signal);assert.deepEqual(after,this.birth);this.active();signal?.throwIfAborted();
			return{at,end:Date.now(),process:this.birth,binarySha256:this.binarySha256,args:this.args,powerSource:'AC Power',assertions};
		}catch(error){this.failed('case-local power assertions became unknown or ineffective');throw error;}
	}
	close():Promise<unknown>{
		if(this.closing)return this.closing;
		this.closing=Promise.resolve().then(()=>this.closeActual());
		// Cancel observations immediately. No asynchronous startup may spawn after
		// closing, and cleanup must free the assertion before waiting for queries.
		this.observations.abort(new Error('case-local power cleanup began'));return this.closing;
	}
	private async closeActual():Promise<unknown>{
		const child=this.child;let ended:{code:number|null;signal:NodeJS.Signals|null;error?:string}|undefined,forced=false,accepted=false,early=false;
		const errors:unknown[]=[];
		if(child){
			early=child.exitCode!==null||child.signalCode!==null;
			try{if(!early)accepted=child.kill('SIGTERM');}catch(error){errors.push(error);}
			let force:ReturnType<typeof setTimeout>|undefined,limit:ReturnType<typeof setTimeout>|undefined;
			try{
				force=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null){forced=true;try{child.kill('SIGKILL');}catch(error){errors.push(error);}}},2000);
				ended=await Promise.race([this.closed!,new Promise<never>((_yes,no)=>{limit=setTimeout(()=>no(new Error('original power process did not actually close')),4000);})]);
			}catch(error){errors.push(error);}finally{clearTimeout(force);clearTimeout(limit);}
		}
		try{await this.drain();}catch(error){errors.push(error);}
		if(!child){assert.equal(errors.length,0,'power startup observations did not actually settle');assert.ok(!this.failure,'power preparation failed before starting');return{notStarted:true};}
		let current;
		try{
			assert.ok(this.birth,'power process never acquired independent OS identity');current=await readWriterProcess(this.probe,this.birth.pid);assert.equal(writerState(this.birth.observation.identity,current),'exited');
			const remaining=ownPowerAssertions(await this.powerRead('assertions'),this.birth.pid);assert.ok(!remaining.some(row=>this.ids?.some(prior=>prior.id===row.id)),'an original assertion remained after actual process exit');
		}catch(error){errors.push(error);}
		assert.equal(errors.length,0,'power cleanup observations did not complete');
		assert.ok(!forced&&!early&&accepted&&ended?.code===null&&ended.signal==='SIGTERM'&&!this.failure,'power assertion expired or failed instead of ending by the accepted cleanup signal');
		return{process:this.birth,ended,stopRequested:true,stopAccepted:accepted,observation:current,originalAssertionsAbsent:true};
	}
}
