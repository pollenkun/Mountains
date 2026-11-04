import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import type {RunAwake} from './acceptance/run-awake.ts';
import type {ExecutableProcessObservation,ProcessObservation,WriterProcessIdentity} from './acceptance/process-identity.ts';

// Execute the complete production class. Only its imported OS boundaries are
// replaced. There is no real spawn, power assertion, pmset query, AX or UI.
const production=readFileSync(new URL('./acceptance/run-awake.ts',import.meta.url),'utf8');
const executableBytes=Buffer.from('owned fake caffeinate executable');
const sha256=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

function deferred<T>(){
	let resolve!:(value:T)=>void;
	const promise=new Promise<T>(yes=>{resolve=yes;});
	return{promise,resolve};
}
type Outcome={kind:'resolved';value:unknown}|{kind:'rejected';error:unknown}|{kind:'pending'};
async function settled(promise:Promise<unknown>,milliseconds=100):Promise<Outcome>{
	let timer:ReturnType<typeof setTimeout>|undefined;
	try{return await Promise.race([
		promise.then(value=>({kind:'resolved' as const,value}),error=>({kind:'rejected' as const,error})),
		new Promise<Outcome>(resolve=>{timer=setTimeout(()=>resolve({kind:'pending'}),milliseconds);}),
	]);}finally{clearTimeout(timer);}
}

class FileOnlyChild extends EventEmitter{
	readonly stdout=new PassThrough();
	readonly stderr=new PassThrough();
	exitCode:number|null=null;
	signalCode:NodeJS.Signals|null=null;
	killed=false;
	closed=false;
	readonly kills:NodeJS.Signals[]=[];
	holdClose=false;
	acceptKill=true;
	exitInsteadOfKill=false;
	private requestedSignal:NodeJS.Signals|undefined;
	readonly pid:number;
	readonly birth:WriterProcessIdentity;
	readonly command:string;
	constructor(pid:number,command:string,owner:WriterProcessIdentity){
		super();this.pid=pid;this.command=command;this.birth={...owner,pid,startMicroseconds:pid%1_000_000};
	}
	kill(signal:NodeJS.Signals='SIGTERM'):boolean{
		this.kills.push(signal);
		if(this.closed)return false;
		if(this.exitInsteadOfKill){queueMicrotask(()=>this.end(0,null));return false;}
		if(!this.acceptKill)return false;
		this.killed=true;this.requestedSignal=signal;
		if(!this.holdClose)queueMicrotask(()=>this.end(null,signal));
		return true;
	}
	completeQuery(output:string):void{
		if(this.closed)return;
		if(this.requestedSignal)this.end(null,this.requestedSignal);
		else{this.stdout.write(output);this.end(0,null);}
	}
	end(code:number|null,signal:NodeJS.Signals|null):void{
		if(this.closed)return;
		this.closed=true;this.exitCode=code;this.signalCode=signal;
		this.stdout.end();this.stderr.end();
		try{this.emit('exit',code,signal);}finally{this.emit('close',code,signal);}
	}
}

function fixture(onFailure:(error:Error)=>void|Promise<void>=()=>{}){
	const owner:WriterProcessIdentity={schema:'macos-kinfo-starttime-v1',pid:process.pid,bootId:'11111111-1111-4111-8111-111111111111',startSeconds:'1790000000',startMicroseconds:123};
	const children:FileOnlyChild[]=[],timers=new Set<ReturnType<typeof setTimeout>>();
	const pendingGates:Array<()=>void>=[];
	let powerChild:FileOnlyChild|undefined;
	let nextQuery:{which:'batt'|'assertions';entered:ReturnType<typeof deferred<FileOnlyChild>>}|undefined;
	let ownerRead:{entered:ReturnType<typeof deferred<void>>;gate:ReturnType<typeof deferred<void>>}|undefined;
	let executableRead:{entered:ReturnType<typeof deferred<void>>;gate:ReturnType<typeof deferred<void>>}|undefined;
	const observation=(pid:number):ProcessObservation=>{
		if(pid===owner.pid)return{status:'alive',identity:{...owner}};
		const child=children.find(row=>row.pid===pid);
		return child&&!child.closed?{status:'alive',identity:{...child.birth}}:{status:'absent'};
	};
	const assertions=()=>powerChild&&!powerChild.closed?
		`pid ${powerChild.pid}(caffeinate): [0x123] 00:00:01 PreventUserIdleSystemSleep named: "own"\npid ${powerChild.pid}(caffeinate): [0x124] 00:00:01 PreventSystemSleep named: "own"\n`:'';
	const queryOutput=(which:string)=>which==='batt'?"Now drawing from 'AC Power'\n":assertions();
	const spawn=(path:string,args:string[])=>{
		assert.ok(path==='/usr/bin/caffeinate'||path==='/usr/bin/pmset','a test must never fall through to a real executable');
		const child=new FileOnlyChild(900_000+children.length+1,path,owner);children.push(child);
		if(path==='/usr/bin/caffeinate'){
			assert.deepEqual([...args],['-i','-s','-t','120','-w',String(owner.pid)]);powerChild=child;
		}else{
			assert.equal(args[0],'-g');assert.ok(args[1]==='batt'||args[1]==='assertions');
			if(nextQuery&&nextQuery.which===args[1]){
				const plan=nextQuery;nextQuery=undefined;child.holdClose=true;plan.entered.resolve(child);
			}else queueMicrotask(()=>child.completeQuery(queryOutput(args[1]!)));
		}
		return child;
	};
	const source=stripTypeScriptTypes(production).replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
	const Constructor=runInNewContext(source+'\nRunAwake;',{
		assert,Buffer,performance,AbortController,AbortSignal,queueMicrotask,setImmediate,clearImmediate,
		process:{platform:'darwin',pid:owner.pid},spawn,sha256,
		readFileSync:(path:string)=>{assert.equal(path,'/usr/bin/caffeinate');return executableBytes;},
		realpathSync:(path:string)=>{assert.equal(path,'/usr/bin/caffeinate');return path;},
		writerProcessIdentity:(value:WriterProcessIdentity)=>({...value}),
		writerState:(before:WriterProcessIdentity,after:ProcessObservation)=>after.status==='absent'?'exited':after.status==='alive'&&JSON.stringify(before)===JSON.stringify(after.identity)?'alive':'unknown',
		readWriterProcess:async(_probe:unknown,pid:number)=>{
			if(pid===owner.pid&&ownerRead){const plan=ownerRead;ownerRead=undefined;plan.entered.resolve();await plan.gate.promise;}
			return observation(pid);
		},
		readExecutableProcess:async(_probe:unknown,pid:number):Promise<ExecutableProcessObservation|null>=>{
			if(executableRead){const plan=executableRead;executableRead=undefined;plan.entered.resolve();await plan.gate.promise;}
			const value=observation(pid);return value.status==='alive'?{pid,executable:'/usr/bin/caffeinate',observation:value}:null;
		},
		setTimeout:(callback:()=>void,ms:number)=>{const timer=setTimeout(callback,ms);timer.unref();timers.add(timer);return timer;},
		clearTimeout:(timer:ReturnType<typeof setTimeout>)=>{clearTimeout(timer);timers.delete(timer);},
	}) as new(probe:{path:string;sha256:string},identity:WriterProcessIdentity,callback:(error:Error)=>void|Promise<void>)=>RunAwake;
	const awake=new Constructor({path:'/never-executed-os-reader',sha256:'0'.repeat(64)},owner,onFailure);
	return{
		awake,children,
		power:()=>{assert.ok(powerChild,'the actual production start must have spawned the fake power child');return powerChild;},
		holdQuery(which:'batt'|'assertions'){
			assert.equal(nextQuery,undefined);const entered=deferred<FileOnlyChild>();nextQuery={which,entered};
			return{entered:entered.promise,complete:(child:FileOnlyChild)=>child.completeQuery(queryOutput(which))};
		},
		holdOwnerRead(){const entered=deferred<void>(),gate=deferred<void>();ownerRead={entered,gate};pendingGates.push(()=>gate.resolve());return{entered:entered.promise,release:()=>gate.resolve()};},
		holdExecutableRead(){const entered=deferred<void>(),gate=deferred<void>();executableRead={entered,gate};pendingGates.push(()=>gate.resolve());return{entered:entered.promise,release:()=>gate.resolve()};},
		async dispose(){
			for(const release of pendingGates)release();
			for(const child of children)if(!child.closed){try{child.end(0,null);}catch{/* A failing observer must not strand test-owned substitutes. */}}
			await turn();for(const timer of timers)clearTimeout(timer);
		},
	};
}

for(const asynchronous of [false,true])test(`an ${asynchronous?'asynchronous rejection':'synchronous throw'} in failure notification cannot strand actual close`,{timeout:3000},async()=>{
	let notified=0;
	const f=fixture(asynchronous?async()=>{notified++;await Promise.resolve();throw new Error('injected asynchronous observer failure');}:()=>{notified++;throw new Error('injected synchronous observer failure');});
	try{
		await f.awake.start(new AbortController().signal);
		assert.doesNotThrow(()=>f.power().end(1,null),'the OS close event must not throw through its listener');
		await turn();
		const result=await settled(f.awake.close());
		assert.equal(result.kind,'rejected','early process exit must reject promptly, even when notifying the parent fails');
		assert.equal(notified,1);assert.equal(f.power().closed,true);
	}finally{await f.dispose();}
});

test('close waits for the actual held power query and its check before reporting completion',{timeout:3000},async()=>{
	const f=fixture();
	try{
		await f.awake.start(new AbortController().signal);
		const held=f.holdQuery('batt');let checkEnded=false;
		const checking=f.awake.check().then(()=>{checkEnded=true;return'resolved';},()=>{checkEnded=true;return'rejected';});
		const query=await held.entered;
		const closing=f.awake.close();assert.equal(f.awake.close(),closing,'all close callers must share the same actual cleanup');
		assert.equal((await settled(closing,25)).kind,'pending','query has not emitted its actual close event');
		assert.equal(checkEnded,false);assert.equal(query.closed,false);
		held.complete(query);
		assert.equal(await checking,'rejected','an interrupted check cannot produce a healthy receipt');
		assert.notEqual((await settled(closing)).kind,'pending','close must finish once the original work has really ended');
		assert.equal(checkEnded,true);assert.equal(query.closed,true);assert.equal(f.power().closed,true);
	}finally{await f.dispose();}
});

test('close also waits for an in-flight independent OS read rather than abandoning its check',{timeout:3000},async()=>{
	const f=fixture();
	try{
		await f.awake.start(new AbortController().signal);
		const held=f.holdExecutableRead();const checking=f.awake.check().catch(()=>undefined);await held.entered;
		const closing=f.awake.close();assert.equal((await settled(closing,25)).kind,'pending');
		held.release();await checking;
		assert.notEqual((await settled(closing)).kind,'pending');assert.equal(f.power().closed,true);
	}finally{await f.dispose();}
});

test('a rejected TERM followed by natural exit zero is not a normal healthy cleanup',{timeout:3000},async()=>{
	const f=fixture();
	try{
		await f.awake.start(new AbortController().signal);f.power().exitInsteadOfKill=true;
		assert.equal((await settled(f.awake.close())).kind,'rejected');
		assert.equal(f.power().closed,true);assert.deepEqual(f.power().kills,['SIGTERM']);
	}finally{await f.dispose();}
});

test('normal requested TERM waits for the exact child close and confirms its assertions disappeared',{timeout:3000},async()=>{
	const f=fixture();
	try{
		await f.awake.start(new AbortController().signal);f.power().holdClose=true;
		const closing=f.awake.close();await turn();assert.equal((await settled(closing,25)).kind,'pending');
		assert.deepEqual(f.power().kills,['SIGTERM']);assert.equal(f.power().closed,false);
		f.power().end(null,'SIGTERM');const result=await settled(closing);assert.equal(result.kind,'resolved');
		assert.equal((result.value as {originalAssertionsAbsent:boolean}).originalAssertionsAbsent,true);
	}finally{await f.dispose();}
});

test('close immediately after start prevents any late power child creation',{timeout:3000},async()=>{
	const f=fixture();
	try{
		const starting=f.awake.start(new AbortController().signal).catch(()=>undefined);const closing=f.awake.close();
		await starting;assert.notEqual((await settled(closing)).kind,'pending');await turn();
		assert.equal(f.children.filter(child=>child.command==='/usr/bin/caffeinate').length,0);
	}finally{await f.dispose();}
});

test('close during startup OS identity lookup cannot create a power child after that lookup returns',{timeout:3000},async()=>{
	const f=fixture(),held=f.holdOwnerRead();
	try{
		const starting=f.awake.start(new AbortController().signal).catch(()=>undefined);await held.entered;
		const closing=f.awake.close();assert.equal((await settled(closing,25)).kind,'pending');
		held.release();await starting;assert.notEqual((await settled(closing)).kind,'pending');await turn();
		assert.equal(f.children.filter(child=>child.command==='/usr/bin/caffeinate').length,0);
	}finally{held.release();await f.dispose();}
});

test('close during startup AC query waits for that query and cannot spawn after it completes',{timeout:3000},async()=>{
	const f=fixture(),held=f.holdQuery('batt');
	try{
		const starting=f.awake.start(new AbortController().signal).catch(()=>undefined),query=await held.entered;
		const closing=f.awake.close();assert.equal((await settled(closing,25)).kind,'pending');
		held.complete(query);await starting;assert.notEqual((await settled(closing)).kind,'pending');await turn();
		assert.equal(query.closed,true);assert.equal(f.children.filter(child=>child.command==='/usr/bin/caffeinate').length,0);
	}finally{await f.dispose();}
});

test('close after spawn but before independent birth lookup settles still reaps that exact child',{timeout:3000},async()=>{
	const f=fixture(),held=f.holdExecutableRead();
	try{
		const starting=f.awake.start(new AbortController().signal).catch(()=>undefined);await held.entered;const child=f.power();
		const closing=f.awake.close();assert.equal((await settled(closing,25)).kind,'pending');
		held.release();await starting;assert.notEqual((await settled(closing)).kind,'pending');
		assert.equal(child.closed,true);assert.equal(f.children.filter(row=>row.command==='/usr/bin/caffeinate').length,1);
	}finally{held.release();await f.dispose();}
});
