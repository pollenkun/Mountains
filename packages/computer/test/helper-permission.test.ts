import assert from "node:assert/strict";
import { test } from "node:test";
import { POSIX_ONLY } from "./fixtures/platform.ts";
import { mkdtemp, readFile, writeFile, open, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { JsonHelper } from "../src/helper.ts";
import { InputCoordinator } from "../src/coordinator.ts";

// Actual Node pipes and filesystem only. The child never sends desktop input.
// Its independent ACK record reads the durable files, rather than trusting the
// callback's own claim that it finished writing them.
const program=String.raw`
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const root=process.argv[1],mode=process.argv[2];let command;
const event=value=>fs.appendFileSync(root+'/events',JSON.stringify(value)+'\n');
const reply=value=>process.stdout.write(JSON.stringify(value)+'\n');
rl.on('line',line=>{const c=JSON.parse(line);
 if(c.op==='route_ack'){
  event({kind:'ack',id:c.id,token:c.routeToken,route:c.route,recordStored:fs.existsSync(root+'/record'),permitStored:fs.existsSync(root+'/permit')});
  reply({id:c.id,ok:true,inputSent:true});return;
 }
 if(c.op==='ping'){reply({id:c.id,ok:true});return;}
 command=c;event({kind:'command',token:c.routeToken,op:c.op});
 const record={id:c.id,kind:'input-route',routeToken:c.routeToken,route:{pid:10,window:{id:100,path:[1,2]}}};
 if(mode==='refusal'){reply({id:c.id,ok:false,inputSent:false,error:'refused before permission'});return;}
 if(mode==='early-success'){reply({id:c.id,ok:true,inputSent:true});return;}
 reply(record);
 if(mode==='duplicate')reply(record);
 if(mode==='pending-success')setTimeout(()=>reply({id:c.id,ok:true,inputSent:true}),20);
 if(mode==='close')setTimeout(()=>process.exit(0),20);
});rl.on('close',()=>{event({kind:'eof'});process.exit(0);});setInterval(()=>{},1000);
`;

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function stored(path:string){const handle=await open(path,"wx",0o600);try{await handle.writeFile("durable");await handle.sync();}finally{await handle.close();}}
async function setup(mode="ordinary"){
	const root=await mkdtemp(join(tmpdir(),"mountains-async-permission-"));await writeFile(join(root,"events"),"");
	const helper=new JsonHelper(process.execPath,["-e",program,root,mode],process.env,"eof");
	const coordinator=new InputCoordinator(join(root,"coord")),stop=new AbortController();
	const events=async()=>String(await readFile(join(root,"events"),"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
	const clean=async()=>{stop.abort();await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});};
	return {root,helper,coordinator,stop,events,clean};
}

test("input ACK waits for both asynchronous callbacks and their independently read durable files",POSIX_ONLY,async()=>{
	const f=await setup(),recordEntered=deferred(),recordGate=deferred(),permitEntered=deferred(),permitGate=deferred();
	const command={op:"gesture",routeToken:"original-token"};
	const task=f.coordinator.run(f.stop.signal,()=>f.helper.send(command,3000,true,async record=>{
		assert.ok(Object.isFrozen(record));assert.ok(Object.isFrozen(record.route));
		assert.ok(Object.isFrozen(((record.route as Record<string,unknown>).window as Record<string,unknown>).path));
		recordEntered.resolve();await recordGate.promise;await stored(join(f.root,"record"));
	},undefined,async()=>{permitEntered.resolve();await permitGate.promise;await stored(join(f.root,"permit"));}));
	try{
		await recordEntered.promise;assert.equal((await f.events()).some(value=>value.kind==="ack"),false);
		command.routeToken="changed-after-send";command.op="must-not-change";
		recordGate.resolve();await permitEntered.promise;assert.equal((await f.events()).some(value=>value.kind==="ack"),false);
		permitGate.resolve();assert.equal((await task).ok,true);
		const ack=(await f.events()).filter(value=>value.kind==="ack");assert.equal(ack.length,1);
		assert.equal(ack[0]!.recordStored,true);assert.equal(ack[0]!.permitStored,true);assert.equal(ack[0]!.token,"original-token");
		assert.deepEqual(ack[0]!.route,{pid:10,window:{id:100,path:[1,2]}});
		await assert.rejects(lstat(join(f.root,"coord/input.lock")),{code:"ENOENT"});
	}finally{recordGate.resolve();permitGate.resolve();await task.catch(()=>{});await f.clean();}
});

for(const stage of ["record","permit"])for(const action of ["reject","abort","dispose","timeout"])test(`no late ACK when an asynchronous ${stage} callback is interrupted by ${action}`,{...POSIX_ONLY,timeout:6000},async()=>{
	const f=await setup(),entered=deferred(),gate=deferred(),returned=deferred();
	await f.helper.send({op:"ping"}); // Keep the deadline check independent of process cold start.
	let callbackSignal:AbortSignal|undefined;
	const callback=async(context:{signal:AbortSignal})=>{callbackSignal=context.signal;entered.resolve();await gate.promise;returned.resolve();if(action==="reject")throw new Error("durable callback rejected");};
	const task=f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"interrupted-original"},action==="timeout"?500:3000,true,stage==="record"?(_record,context)=>callback(context):()=>{},undefined,stage==="permit"?callback:undefined)).catch(error=>error);
	try{
		await entered.promise;
		if(action==="reject")gate.resolve();
		if(action==="abort")f.stop.abort(new Error("cancel while persisting"));
		if(action==="dispose")await f.helper.dispose().catch(()=>{});
		const error=await task;assert.ok(error instanceof Error,String(error));
		assert.match(error.message,action==="reject"?/durable callback rejected/:/persistence is unfinished/);
		assert.equal(callbackSignal?.aborted,true);
		gate.resolve();await returned.promise;await new Promise<void>(resolve=>setImmediate(resolve));
		assert.equal((await f.events()).some(value=>value.kind==="ack"),false);
		assert.equal(f.helper.pid,null);
		if(action==="reject"){
			await assert.rejects(lstat(join(f.root,"coord/input.lock")),{code:"ENOENT"});
			let next=false;await f.coordinator.run(new AbortController().signal,async()=>{next=true;});assert.equal(next,true);
		}else{
			assert.ok((await lstat(join(f.root,"coord/input.lock"))).isDirectory());let next=false;
			await assert.rejects(f.coordinator.run(new AbortController().signal,async()=>{next=true;}),/earlier input helper termination is unverified/);assert.equal(next,false);
		}
	}finally{gate.resolve();await task;await f.clean();}
});

test("a duplicated route while persistence is pending cannot grant either copy",POSIX_ONLY,async()=>{
	const f=await setup("duplicate"),entered=deferred(),gate=deferred();let calls=0;
	const task=f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"duplicate-original"},3000,true,async()=>{calls++;entered.resolve();await gate.promise;})).catch(error=>error);
	try{
		await entered.promise;assert.match(String(await task),/duplicate desktop helper input record/);gate.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
		assert.equal(calls,1);assert.equal((await f.events()).some(value=>value.kind==="ack"),false);
	}finally{gate.resolve();await task;await f.clean();}
});

for(const mode of ["early-success","pending-success"])test(`a helper cannot complete a gated command before permission (${mode})`,POSIX_ONLY,async()=>{
	const f=await setup(mode),gate=deferred();
	const task=f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"early-original"},3000,true,()=>gate.promise)).catch(error=>error);
	try{
		assert.match(String(await task),/termination could not be verified/);gate.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
		assert.equal((await f.events()).some(value=>value.kind==="ack"),false);
		assert.ok((await lstat(join(f.root,"coord/input.lock"))).isDirectory());let next=false;
		await assert.rejects(f.coordinator.run(new AbortController().signal,async()=>{next=true;}),/earlier input helper termination is unverified/);assert.equal(next,false);
	}finally{gate.resolve();await task;await f.clean();}
});

test("a helper exiting during unfinished persistence cannot receive a late ACK or release that claim",POSIX_ONLY,async()=>{
	const f=await setup("close"),gate=deferred();
	const task=f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"closed-original"},3000,true,()=>gate.promise)).catch(error=>error);
	try{
		assert.match(String(await task),/stopped/);gate.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
		assert.equal((await f.events()).some(value=>value.kind==="ack"),false);assert.ok((await lstat(join(f.root,"coord/input.lock"))).isDirectory());
	}finally{gate.resolve();await task;await f.clean();}
});

for(const stage of ["record","permit"])test(`a synchronous ${stage} callback cannot overrun the deadline before the timer gets a turn`,POSIX_ONLY,async()=>{
	const f=await setup();await f.helper.send({op:"ping"});
	const block=()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);};
	try{
		await assert.rejects(f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"expired-original"},70,true,stage==="record"?block:()=>{},undefined,stage==="permit"?block:undefined)),/timed out/);
		assert.equal((await f.events()).some(value=>value.kind==="ack"),false);
	}finally{await f.clean();}
});

test("authorized cleanup remains possible after outer cancellation and receives its own live command signal",POSIX_ONLY,async()=>{
	const f=await setup();let dispatched=0;
	try{
		const result=await f.coordinator.run(f.stop.signal,async()=>{
			f.stop.abort(new Error("cancel outer work, allow original-target cleanup"));
			return f.helper.send({op:"gesture",routeToken:"cleanup-original"},3000,false,async(_record,context)=>{
				assert.equal(context.signal.aborted,false);await stored(join(f.root,"record"));assert.equal(context.signal.aborted,false);
			},()=>{dispatched++;},async context=>{assert.equal(context.signal.aborted,false);await stored(join(f.root,"permit"));});
		});
		assert.equal(result.ok,true);assert.equal(dispatched,1);const ack=(await f.events()).find(value=>value.kind==="ack");assert.equal(ack?.recordStored,true);assert.equal(ack?.permitStored,true);
	}finally{await f.clean();}
});

for(const mode of ["throws","returns-promise"])test(`a dispatch notification failure after the write is treated as possibly sent (${mode})`,POSIX_ONLY,async()=>{
	const f=await setup();let notified=0;
	const callback=()=>{notified++;if(mode==="throws")throw new Error("notification failed after possible write");return Promise.reject(new Error("must be handled without an unhandled rejection"));};
	try{
		const result=await f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"dispatch-original"},3000,true,()=>{},callback as unknown as ()=>undefined)).catch(error=>error);
		assert.match(String(result),/release and cleanup remain unverified/);assert.equal(notified,1);assert.ok((await lstat(join(f.root,"coord/input.lock"))).isDirectory());
	}finally{await f.clean();}
});

test("a definite refusal before a route remains a normal failure without either callback",POSIX_ONLY,async()=>{
	const f=await setup("refusal");let callbacks=0;
	try{
		await assert.rejects(f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"refused-original"},3000,true,()=>{callbacks++;},()=>{callbacks++;})),/refused before permission/);
		assert.equal(callbacks,0);await assert.rejects(lstat(join(f.root,"coord/input.lock")),{code:"ENOENT"});
	}finally{await f.clean();}
});

test("queued commands retain their original token and payload",POSIX_ONLY,async()=>{
	const f=await setup(),gate=deferred(),entered=deferred();
	const first=f.helper.send({op:"gesture",routeToken:"queue-first"},3000,true,async()=>{entered.resolve();await gate.promise;});
	try{
		await entered.promise;const command={op:"gesture",routeToken:"queue-second"};
		const second=f.helper.send(command,3000,true,()=>{});command.op="changed";command.routeToken="changed";
		gate.resolve();await first;await second;
		assert.deepEqual((await f.events()).filter(value=>value.kind==="command").map(value=>[value.op,value.token]),[["gesture","queue-first"],["gesture","queue-second"]]);
	}finally{gate.resolve();await first.catch(()=>{});await f.clean();}
});

for(const type of ["thenable","cross-realm-promise"])test(`permission hooks wait for ${type} values without relying on instanceof Promise`,POSIX_ONLY,async()=>{
	const f=await setup(),entered=deferred(),gate=deferred();
	const persist=async()=>{entered.resolve();await gate.promise;await stored(join(f.root,"record"));};
	const hook=type==="thenable"?()=>({then:(resolve:()=>void,reject:(error:unknown)=>void)=>{void persist().then(resolve,reject);}}):runInNewContext("(work)=>new Promise((resolve,reject)=>work().then(resolve,reject))") as(work:()=>Promise<void>)=>Promise<void>;
	const record=type==="thenable"?hook as ()=>Promise<void>:()=>((hook as(work:()=>Promise<void>)=>Promise<void>)(persist));
	const task=f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"other-promise-original"},3000,true,record,undefined,()=>stored(join(f.root,"permit"))));
	try{
		await entered.promise;assert.equal((await f.events()).some(value=>value.kind==="ack"),false);gate.resolve();assert.equal((await task).ok,true);
		const ack=(await f.events()).find(value=>value.kind==="ack");assert.equal(ack?.recordStored,true);assert.equal(ack?.permitStored,true);
	}finally{gate.resolve();await task.catch(()=>{});await f.clean();}
});

test("a changing then getter is read once and cannot bypass durable persistence",POSIX_ONLY,async()=>{
	const f=await setup(),entered=deferred(),gate=deferred();let reads=0;
	const result=Object.defineProperty({},"then",{get(){
		reads++;
		if(reads===1)return (resolve:()=>void,reject:(error:unknown)=>void)=>{entered.resolve();void gate.promise.then(()=>stored(join(f.root,"record"))).then(resolve,reject);};
		return undefined;
	}}) as Promise<void>;
	const task=f.coordinator.run(f.stop.signal,()=>f.helper.send({op:"gesture",routeToken:"changing-then-original"},3000,true,()=>result,undefined,()=>stored(join(f.root,"permit"))));
	try{
		await Promise.race([entered.promise,task.then(()=>assert.fail("completed before the first thenable's durable barrier"))]);
		assert.equal((await f.events()).some(value=>value.kind==="ack"),false);assert.equal(reads,1);
		gate.resolve();assert.equal((await task).ok,true);assert.equal(reads,1);
		const ack=(await f.events()).find(value=>value.kind==="ack");assert.equal(ack?.recordStored,true);assert.equal(ack?.permitStored,true);
	}finally{gate.resolve();await task.catch(()=>{});await f.clean();}
});

for(const stage of ["record","permit"])for(const late of ["resolve","reject"])test(`a caller ending its scope while ${stage} persistence is pending retains the claim after late ${late}`,POSIX_ONLY,async()=>{
	const f=await setup(),entered=deferred(),gate=deferred();let signal:AbortSignal|undefined,send:Promise<unknown>|undefined;
	try{
		const ended=f.coordinator.run(f.stop.signal,async()=>{
			const persist=async(context:{signal:AbortSignal})=>{signal=context.signal;entered.resolve();await gate.promise;if(late==="reject")throw new Error("late failed persistence");};
			send=f.helper.send({op:"gesture",routeToken:"scope-ended-original"},3000,true,stage==="record"?(_record,context)=>persist(context):()=>{},undefined,stage==="permit"?persist:undefined).catch(error=>error);
			await entered.promise;return "caller returned without awaiting its helper";
		});
		await assert.rejects(ended,/termination could not be verified/);assert.equal(signal?.aborted,true);assert.equal(f.helper.pid,null);
		gate.resolve();await send;await new Promise<void>(resolve=>setImmediate(resolve));
		assert.equal((await f.events()).some(value=>value.kind==="ack"),false);assert.ok((await lstat(join(f.root,"coord/input.lock"))).isDirectory());
		let next=false;await assert.rejects(f.coordinator.run(new AbortController().signal,async()=>{next=true;}),/earlier input helper termination is unverified/);assert.equal(next,false);
	}finally{gate.resolve();await send;await f.clean();}
});
