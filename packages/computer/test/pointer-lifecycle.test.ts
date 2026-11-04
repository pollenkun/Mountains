import assert from "node:assert/strict";
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { InputCoordinator } from "../src/coordinator.ts";
import type { JsonHelper } from "../src/helper.ts";
import { phasedFilePointer } from "./fixtures/phased-file-pointer.ts";

const mac={skip:process.platform!=="darwin",timeout:15_000};
async function fixture(){const root=await mkdtemp(join(tmpdir(),"mountains-phased-pointer-")),log=join(root,"events");await writeFile(log,"");const value=await phasedFilePointer(log);return {...value,root,log,coordinator:new InputCoordinator(join(root,"claim")),events:()=>readFile(log,"utf8"),async close(){await value.pointer.close().catch(()=>{});await rm(root,{recursive:true,force:true});}};}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test("real phased MacPointer retains its readonly process across clean scopes and closes it only on disposal",mac,async()=>{
	const f=await fixture();try{
		const first=await f.pointer.send({op:"ping"}),pid=first.pid;assert.ok(pid);
		for(let index=0;index<2;index++){
			await f.coordinator.run(new AbortController().signal,async()=>{await f.pointer.send({op:"guard_start",pid:10});await f.pointer.send({op:"guard_end"});assert.equal((await f.pointer.send({op:"ping"})).pid,pid);});
			assert.equal((await f.pointer.send({op:"ping"})).pid,pid);
		}
		assert.equal((await f.events()).split("baseline\n").length-1,2,"a step must not replace the scope's first baseline");
		assert.equal((await f.events()).split("global-focus\n").length-1,2);
		await assert.rejects(f.pointer.send({op:"guard_start",pid:10}),/active input lease/);
		await f.pointer.close();assert.equal(f.actor.helper.pid,null);assert.doesNotMatch(await f.events(),/watchdog-exit/);
	}finally{await f.close();}
});

test("seal cancels local input but waits for the actual Node AX promise before global restoration",mac,async()=>{
	const f=await fixture(),gate=deferred(),entered=deferred();let task:Promise<unknown>|undefined;
	try{
		task=f.coordinator.run(new AbortController().signal,async lease=>{
			await f.pointer.send({op:"guard_start",pid:10});
			const ax=lease.ax(null,null,"set_value",async()=>{await appendFile(f.log,"AX-start\n");entered.resolve();await gate.promise;await appendFile(f.log,"AX-end\n");});void ax.catch(()=>{});
			await entered.promise;return "deliberately unawaited AX must fail";
		}).catch(error=>error);
		await Promise.race([entered.promise,task.then(error=>{throw error;})]);await delay(2200);const before=await f.events();assert.match(before,/AX-start/);assert.doesNotMatch(before,/restore|global-focus|helper-exit|watchdog-exit/);assert.ok(f.actor.helper.pid,"local stop grace must not kill a helper merely waiting for Node AX");
		gate.resolve();assert.match(String(await task),/unawaited helper work/);
		const after=await f.events();assert.ok(after.indexOf("AX-end")<after.indexOf("restore"));assert.ok(after.indexOf("restore")<after.indexOf("global-focus"));
		await assert.rejects(lstat(join(f.root,"claim","input.lock")),{code:"ENOENT"});
	}finally{gate.resolve();await task;await f.close();}
});

test("several guard steps within one scope do not replace the original baseline",mac,async()=>{
	const f=await fixture();try{await f.coordinator.run(new AbortController().signal,async()=>{
		for(const pid of [10,11,12]){await f.pointer.send({op:"guard_start",pid});await f.pointer.send({op:"guard_end"});}
	});assert.equal((await f.events()).split("baseline\n").length-1,1);assert.equal((await f.events()).split("global-focus\n").length-1,1);}finally{await f.close();}
});

test("a real Foundation cancel releases the file gesture locally, restores afterwards and leaves only readonly idle",mac,async()=>{
	const f=await fixture(),stop=new AbortController();let task:Promise<unknown>|undefined;
	// Mouse data creation is irrelevant to this file-only receiver. No real CG
	// event is generated or posted by this lifecycle test.
	Reflect.set(f.pointer,"eventData",Promise.resolve({mouse:async()=>({}),close:async()=>{}}));
	try{
		task=f.coordinator.run(stop.signal,async()=>{await f.pointer.send({op:"guard_start",pid:10});return f.pointer.send({op:"drag",pid:10,instance:"own-file",window:1,bounds:{x:0,y:0,width:100,height:100},x:10,y:10,x2:80,y2:80,cursor:false});}).catch(error=>error);
		const end=performance.now()+3000;while(!(await f.events()).includes("down\n")){if(performance.now()>end)throw new Error("own file gesture never began");await delay(5);}
		stop.abort(new Error("cancel only the file gesture"));const error=await task;assert.match(String(error),/closed|cancel/);
		const events=await f.events();assert.equal(events.split("down\n").length-1,1);assert.equal(events.split("up\n").length-1,1);assert.ok(events.indexOf("up\n")<events.indexOf("global-focus"));assert.doesNotMatch(events,/helper-exit|watchdog-exit/);
		await f.coordinator.run(new AbortController().signal,async()=>{await f.pointer.send({op:"guard_start",pid:11});await f.pointer.send({op:"guard_end"});});
		await assert.rejects(lstat(join(f.root,"claim","input.lock")),{code:"ENOENT"});
	}finally{stop.abort();await task;await f.close();}
});

test("synchronous cancellation after route recording never posts and keeps the warm actor usable",mac,async()=>{
	const f=await fixture(),stop=new AbortController(),send=f.actor.helper.send.bind(f.actor.helper);
	Reflect.set(f.pointer,"eventData",Promise.resolve({mouse:async()=>({}),close:async()=>{}}));
	Reflect.set(f.actor.helper,"send",(...args:Parameters<JsonHelper["send"]>)=>{
		const record=args[3];if(record)args[3]=(row,context)=>{assert.equal(record(row,context),undefined);stop.abort(new Error("cancel after synchronous own route record"));};return send(...args);
	});
	try{
		await assert.rejects(f.coordinator.run(stop.signal,async()=>{await f.pointer.send({op:"guard_start",pid:10});return f.pointer.send({op:"drag",pid:10,instance:"own-file",window:1,bounds:{x:0,y:0,width:100,height:100},x:10,y:10,x2:80,y2:80,cursor:false});}),/cancelled before target acknowledgement/);
		assert.ok(f.actor.helper.pid,"known unstarted input must not kill its actor");assert.doesNotMatch(await f.events(),/down|drag|up|helper-exit|watchdog-exit/);
		await assert.rejects(lstat(join(f.root,"claim","input.lock")),{code:"ENOENT"});
		await f.coordinator.run(new AbortController().signal,async()=>{await f.pointer.send({op:"guard_start",pid:10});await f.pointer.send({op:"guard_end"});});
	}finally{await f.close();}
});

test("an interrupted asynchronous route hook remains unknown after its late completion",mac,async()=>{
	const f=await fixture(),stop=new AbortController(),gate=deferred(),entered=deferred(),send=f.actor.helper.send.bind(f.actor.helper);let task:Promise<unknown>|undefined;
	Reflect.set(f.pointer,"eventData",Promise.resolve({mouse:async()=>({}),close:async()=>{}}));
	Reflect.set(f.actor.helper,"send",(...args:Parameters<JsonHelper["send"]>)=>{
		const record=args[3];if(record)args[3]=async(row,context)=>{await record(row,context);entered.resolve();await gate.promise;};return send(...args);
	});
	try{
		task=f.coordinator.run(stop.signal,async()=>{await f.pointer.send({op:"guard_start",pid:10});return f.pointer.send({op:"drag",pid:10,instance:"own-file",window:1,bounds:{x:0,y:0,width:100,height:100},x:10,y:10,x2:80,y2:80,cursor:false});}).catch(error=>error);
		await Promise.race([entered.promise,task.then(error=>{throw error;})]);stop.abort(new Error("interrupt unfinished own record"));gate.resolve();
		assert.match(String(await task),/unverified|could not be verified/);assert.ok(await lstat(join(f.root,"claim","input.lock")));
		assert.doesNotMatch(await f.events(),/down|drag|up|global-front|global-focus/);
		await assert.rejects(f.coordinator.run(new AbortController().signal,async()=>f.pointer.send({op:"ping"})),/earlier input helper termination is unverified/);
	}finally{gate.resolve();await task;await f.close();}
});

test("scope seal cannot wash an unfinished route hook clean before the delayed cancel receipt",mac,async()=>{
	const f=await fixture(),gate=deferred(),entered=deferred(),sealed=deferred(),hookFinished=deferred(),send=f.actor.helper.send.bind(f.actor.helper);let task:Promise<unknown>|undefined;
	Reflect.set(f.pointer,"eventData",Promise.resolve({mouse:async()=>({}),close:async()=>{}}));
	const request=Reflect.get(f.actor,"request").bind(f.actor) as(lifetime:unknown,op:string)=>Promise<Record<string,unknown>>;
	Reflect.set(f.actor,"request",async(lifetime:unknown,op:string)=>{if(op==="cancel_local")await hookFinished.promise;return request(lifetime,op);});
	Reflect.set(f.actor.helper,"send",(...args:Parameters<JsonHelper["send"]>)=>{
		const record=args[3];if(record)args[3]=async(row,context)=>{await record(row,context);entered.resolve();await gate.promise;await appendFile(f.log,"late-record\n");hookFinished.resolve();};return send(...args);
	});
	try{
		task=f.coordinator.run(new AbortController().signal,async lease=>{
			await f.pointer.send({op:"guard_start",pid:10});
			const drag=f.pointer.send({op:"drag",pid:10,instance:"own-file",window:1,bounds:{x:0,y:0,width:100,height:100},x:10,y:10,x2:80,y2:80,cursor:false});void drag.catch(()=>{});
			await entered.promise;lease.watch(()=>{sealed.resolve();return Promise.resolve();},false);return "root callback deliberately returned with unfinished record";
		}).catch(error=>error);
		await Promise.race([sealed.promise,task.then(error=>{throw error;})]);gate.resolve();
		assert.match(String(await task),/could not be verified/);assert.ok(await lstat(join(f.root,"claim","input.lock")));
		assert.match(await f.events(),/late-record/);assert.doesNotMatch(await f.events(),/down|drag|up|global-front|global-focus/);
	}finally{gate.resolve();hookFinished.resolve();await task;await f.close();}
});

test("cancellation before this scope begins leaves an existing readonly actor untouched",mac,async()=>{
	const f=await fixture(),gate=deferred(),entered=deferred(),stop=new AbortController();let task:Promise<unknown>|undefined;
	Reflect.set(f.pointer,"eventData",Promise.resolve({mouse:async()=>{entered.resolve();await gate.promise;return {};},close:async()=>{}}));
	try{
		const pid=(await f.pointer.send({op:"ping"})).pid;
		task=f.coordinator.run(stop.signal,()=>f.pointer.send({op:"click",pid:10,instance:"own-file",window:1,bounds:{x:0,y:0,width:100,height:100},x:10,y:10,cursor:false})).catch(error=>error);
		await Promise.race([entered.promise,task.then(error=>{throw error;})]);stop.abort(new Error("cancel before file serialization finishes"));gate.resolve();
		assert.match(String(await task),/cancel|abort/);assert.equal(await f.events(),"");assert.equal(f.actor.helper.pid,pid);
		await assert.rejects(lstat(join(f.root,"claim","input.lock")),{code:"ENOENT"});
		await f.coordinator.run(new AbortController().signal,async()=>{await f.pointer.send({op:"guard_start",pid:10});await f.pointer.send({op:"guard_end"});});
		assert.equal((await f.pointer.send({op:"ping"})).pid,pid);
	}finally{gate.resolve();await task;await f.close();}
});
