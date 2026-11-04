import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm,lstat,readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { MacPointer,type PointerCommand } from "../src/pointer-mac.ts";
import { InputCoordinator,InputTerminationUnverifiedError } from "../src/coordinator.ts";
import { ComponentInputClaims,type ClaimProcessBirth } from "../src/input-claim-mac.ts";
import type { JsonHelper } from "../src/helper.ts";

const mac={skip:process.platform!=="darwin",timeout:15_000};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function startup(pointer:MacPointer){const helpers=Reflect.get(pointer,"startupHelpers") as Set<JsonHelper>;assert.equal(helpers.size,1);const helper=[...helpers][0]!;return {helper,child:Reflect.get(helper,"child") as ChildProcessWithoutNullStreams};}
async function fixture(){const root=await mkdtemp(join(tmpdir(),"mountains-pointer-startup-")),store=join(root,"store");await mkdir(store,{mode:0o700});const client=new ComponentInputClaims(store);await client.initialize();const pointer=new MacPointer(),coordinator=new InputCoordinator(join(root,"legacy"),client);return {root,client,pointer,coordinator,async close(){await pointer.close().catch(()=>{});await client.close();await rm(root,{recursive:true,force:true});}};}

test("real MacPointer startup registers the exact Foundation JXA birth before ping and waits for its EOF exit",mac,async()=>{
 const f=await fixture(),call=f.client.call.bind(f.client);let actual:ChildProcessWithoutNullStreams|undefined,birth:ClaimProcessBirth|undefined,registered=0;
 f.client.call=async(request,timeout,signal)=>{const state=await call(request,timeout,signal);if(request.op==="register"&&request.senderPid!==process.pid){registered++;actual=startup(f.pointer).child;assert.equal(actual.pid,request.senderPid);birth=await f.client.processIdentity(actual.pid!);assert.deepEqual(state.lease!.senders.find(s=>s.id===request.senderId)!.birth,birth);assert.equal(state.lease!.commands.length,0);const args=Reflect.get(startup(f.pointer).helper,"args") as string[],source=args[args.indexOf("-e")+1]!;assert.match(source,/ObjC.import\("Foundation"\)/);assert.doesNotMatch(source,/Cocoa|AppKit|ApplicationServices|CoreGraphics|QuartzCore|NSApplication|NSWorkspace|NSPasteboard|perform\(/);}return state;};
 try{await f.coordinator.run(new AbortController().signal,async()=>{const reply=await f.pointer.send({op:"ping"});assert.equal(reply.startupOnly,true);assert.equal(reply.componentOnly,true);assert.equal(reply.inputSent,false);assert.equal(reply.pid,birth!.pid);assert.equal(actual!.exitCode,0);assert.equal(actual!.signalCode,null);assert.equal(startupCount(f.pointer),0);const state=await call({op:"inspect"});assert.equal(state.lease!.commands.length,0);assert.equal(state.lease!.senders.length,2);});assert.equal(registered,1);assert.equal((await call({op:"inspect"})).lease,undefined);await assert.rejects(lstat(join(f.root,"legacy","input.lock")),{code:"ENOENT"});}finally{await f.close();}
});
function startupCount(pointer:MacPointer){return (Reflect.get(pointer,"startupHelpers") as Set<JsonHelper>).size;}

for(const op of ["guard_start","guard_end","wake","reveal_app","cursor","hide","click","hover","drag","scroll","key","text","type_focus","prepare_key","release_pointer","release_key","clip_read","clip_set","clip_restore"]){
 test(`candidate ${op} is refused before event-data, legacy startup or first command bytes`,mac,async()=>{
  const f=await fixture();try{await f.coordinator.run(new AbortController().signal,async()=>{await assert.rejects(f.pointer.send({op} as PointerCommand),/candidate JXA input is not connected/);assert.equal(f.pointer.pid,null);assert.equal(Reflect.get(f.pointer,"eventData"),undefined);assert.equal(startupCount(f.pointer),0);assert.equal((await f.client.call({op:"inspect"})).lease!.senders.length,1);});assert.equal((await f.client.call({op:"inspect"})).lease,undefined);}finally{await f.close();}
 });
}

for(const action of ["abort","seal"] as const)test(`real startup pending registration then ${action} never sends or reopens after late completion`,mac,async()=>{
 const f=await fixture(),call=f.client.call.bind(f.client),entered=deferred(),gate=deferred(),returned=deferred(),stop=new AbortController();let actual:ChildProcessWithoutNullStreams|undefined,writes=0,ping:Promise<unknown>|undefined;
 f.client.call=async(request,timeout,signal)=>{const state=await call(request,timeout,signal);if(request.op==="register"&&request.senderPid!==process.pid){actual=startup(f.pointer).child;const write=actual.stdin.write;Reflect.set(actual.stdin,"write",(...args:unknown[])=>{writes++;return Reflect.apply(write,actual!.stdin,args);});entered.resolve();await gate.promise;returned.resolve();}return state;};
 const task=f.coordinator.run(stop.signal,async()=>{ping=f.pointer.send({op:"ping"});void ping.catch(()=>{});if(action==="abort")return await ping;await entered.promise;}).catch(error=>error);
 try{await entered.promise;if(action==="abort")stop.abort(new Error("cancel own JXA startup"));const error=await task;assert.ok(error instanceof InputTerminationUnverifiedError);assert.equal(writes,0);assert.equal(actual!.exitCode,0);gate.resolve();await returned.promise;await ping!.catch(()=>{});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(writes,0);assert.equal(startupCount(f.pointer),0);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());assert.equal((await call({op:"inspect"})).lease!.senders.length,2);}finally{gate.resolve();await task;await f.close();}
});

test("a lost register reply retains the original claim and sends no startup command",mac,async()=>{
 const f=await fixture(),call=f.client.call.bind(f.client);let actual:ChildProcessWithoutNullStreams|undefined,writes=0;
 f.client.call=async(request,timeout,signal)=>{const state=await call(request,timeout,signal);if(request.op==="register"&&request.senderPid!==process.pid){actual=startup(f.pointer).child;const write=actual.stdin.write;Reflect.set(actual.stdin,"write",(...args:unknown[])=>{writes++;return Reflect.apply(write,actual!.stdin,args);});throw new Error("own injected lost committed register reply");}return state;};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,()=>f.pointer.send({op:"ping"})),InputTerminationUnverifiedError);assert.equal(writes,0);assert.equal(actual!.exitCode,0);const state=await call({op:"inspect"});assert.equal(state.lease!.senders.length,2);assert.equal(state.lease!.commands.length,0);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());}finally{await f.close();}
});

test("registered sender birth must match the independently queried actual child in every field",mac,async()=>{
 const f=await fixture(),call=f.client.call.bind(f.client);let writes=0;
 f.client.call=async(request,timeout,signal)=>{const state=await call(request,timeout,signal);if(request.op==="register"&&request.senderPid!==process.pid){const actual=startup(f.pointer).child,write=actual.stdin.write;Reflect.set(actual.stdin,"write",(...args:unknown[])=>{writes++;return Reflect.apply(write,actual!.stdin,args);});const changed=structuredClone(state),birth=changed.lease!.senders.find(s=>s.id===request.senderId)!.birth;birth.startMicroseconds=(birth.startMicroseconds+1)%1_000_000;return changed;}return state;};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,()=>f.pointer.send({op:"ping"})),InputTerminationUnverifiedError);assert.equal(writes,0);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());}finally{await f.close();}
});

test("a child ending after registration but before first write cannot receive the ping",mac,async()=>{
 const f=await fixture();let writes=0,actual:ChildProcessWithoutNullStreams|undefined;
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,async lease=>{const register=lease.registerReadOnlyHelper.bind(lease);lease.registerReadOnlyHelper=async(child,signal)=>{await register(child,signal);actual=child;const write=child.stdin.write;Reflect.set(child.stdin,"write",(...args:unknown[])=>{writes++;return Reflect.apply(write,child.stdin,args);});child.stdin.end();};return f.pointer.send({op:"ping"});}),/before its first command write/);assert.equal(writes,0);assert.equal(actual!.exitCode,0);assert.equal((await f.client.call({op:"inspect"})).lease,undefined);}finally{await f.close();}
});

test("successful ping cannot hide an unverified EOF exit",{...mac,timeout:20_000},async()=>{
 const f=await fixture(),call=f.client.call.bind(f.client);let actual:ChildProcessWithoutNullStreams|undefined;
 f.client.call=async(request,timeout,signal)=>{const state=await call(request,timeout,signal);if(request.op==="register"&&request.senderPid!==process.pid){actual=startup(f.pointer).child;Reflect.set(actual.stdin,"end",()=>actual!.stdin);}return state;};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,()=>f.pointer.send({op:"ping"})),InputTerminationUnverifiedError);assert.equal(actual!.exitCode,null);assert.ok(actual!.signalCode);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());}finally{await f.close();}
});

test("warm legacy pointer is refused without closing its existing helper",mac,async()=>{
 const f=await fixture(),helper=Reflect.get(f.pointer,"helper") as JsonHelper;
 // Own Node file fixture stands in for legacy UI. Its real process/EOF lifetime
 // is tested; no existing GUI or restoration is exercised by this check.
 Reflect.set(helper,"command",process.execPath);Reflect.set(helper,"args",["-e",String.raw`const fs=require('node:fs'),root=process.argv[1],rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const c=JSON.parse(line);process.stdout.write(JSON.stringify({id:c.id,ok:true})+'\n');});rl.on('close',()=>{fs.writeFileSync(root+'/old-eof','closed');process.exit(0);});`,f.root]);
 try{await f.pointer.send({op:"ping"});const old=helper.pid;assert.ok(old);await assert.rejects(f.coordinator.run(new AbortController().signal,()=>f.pointer.send({op:"ping"})),/requires a fresh pointer/);assert.equal(helper.pid,old);await assert.rejects(readFile(join(f.root,"old-eof")),{code:"ENOENT"});await f.pointer.close();assert.equal(await readFile(join(f.root,"old-eof"),"utf8"),"closed");}finally{await f.close();}
});

test("a candidate pointer never switches into legacy UI when called outside its original lease",mac,async()=>{
 const f=await fixture();try{await f.coordinator.run(new AbortController().signal,()=>f.pointer.send({op:"ping"}));await assert.rejects(f.pointer.send({op:"ping"}),/cannot switch to legacy input/);assert.equal(f.pointer.pid,null);assert.equal(startupCount(f.pointer),0);}finally{await f.close();}
});
