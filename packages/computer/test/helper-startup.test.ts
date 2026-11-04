import assert from "node:assert/strict";
import { mkdtemp,writeFile,readFile,rm,lstat,open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { POSIX_ONLY } from "./fixtures/platform.ts";
import { JsonHelper,type HelperBeforeCommandContext } from "../src/helper.ts";
import { InputCoordinator } from "../src/coordinator.ts";

const program=String.raw`const fs=require('node:fs'),root=process.argv[1],rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const c=JSON.parse(line);fs.appendFileSync(root+'/received',JSON.stringify({op:c.op,stored:fs.existsSync(root+'/registered')})+'\n');process.stdout.write(JSON.stringify({id:c.id,ok:true})+'\n');});
rl.on('close',()=>{fs.appendFileSync(root+'/lifecycle','eof\n');process.exit(0);});`;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(){const root=await mkdtemp(join(tmpdir(),"mountains-helper-startup-"));await writeFile(join(root,"received"),"");await writeFile(join(root,"lifecycle"),"");const helper=new JsonHelper(process.execPath,["-e",program,root],process.env,"eof"),coordinator=new InputCoordinator(join(root,"claim"));return {root,helper,coordinator,async close(){await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}};}
async function durable(path:string){const file=await open(path,"wx",0o600);try{await file.writeFile("registered");await file.sync();}finally{await file.close();}}

test("actual child sees its first command only after asynchronous startup registration is durable",{...POSIX_ONLY,timeout:8000},async()=>{
 const f=await fixture(),entered=deferred(),gate=deferred(),command={op:"original"};let childPid:number|undefined;
 const task=f.coordinator.run(new AbortController().signal,()=>f.helper.send(command,5000,true,undefined,undefined,undefined,undefined,async context=>{assert.ok(Object.isFrozen(context));childPid=context.child.pid;assert.equal(context.child.pid,f.helper.pid);assert.equal(context.child.exitCode,null);entered.resolve();await gate.promise;await durable(join(f.root,"registered"));}));
 try{await entered.promise;assert.ok(childPid);assert.equal(await readFile(join(f.root,"received"),"utf8"),"");command.op="changed";gate.resolve();assert.equal((await task).ok,true);assert.equal(await readFile(join(f.root,"received"),"utf8"),JSON.stringify({op:"original",stored:true})+"\n");await f.helper.dispose();assert.equal(await readFile(join(f.root,"lifecycle"),"utf8"),"eof\n");}finally{gate.resolve();await task.catch(()=>{});await f.close();}
});

for(const action of ["abort","dispose","timeout","exit"] as const)test(`unfinished startup ${action} cannot write a late command or release the physical claim`,{...POSIX_ONLY,timeout:10_000},async()=>{
 const f=await fixture(),entered=deferred(),gate=deferred(),returned=deferred(),stop=new AbortController();let context:HelperBeforeCommandContext|undefined;
 const task=f.coordinator.run(stop.signal,()=>f.helper.send({op:"never"},action==="timeout"?300:5000,true,undefined,undefined,undefined,undefined,async value=>{context=value;entered.resolve();await gate.promise;returned.resolve();})).catch(error=>error);
 try{
  await entered.promise;
  if(action==="abort")stop.abort(new Error("cancel startup registration"));
  if(action==="dispose")await f.helper.dispose().catch(()=>{});
  if(action==="exit")context!.child.stdin.end();
  const error=await task;assert.ok(error instanceof Error);assert.match(error.message,/input helper termination could not be verified/);assert.equal(context!.signal.aborted,true);assert.equal(f.helper.pid,null);
  gate.resolve();await returned.promise;await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(await readFile(join(f.root,"received"),"utf8"),"");assert.ok((await lstat(join(f.root,"claim","input.lock"))).isDirectory());
 }finally{gate.resolve();await task;await f.close();}
});

test("startup synchronous refusal stops its original child without claiming any input was sent",{...POSIX_ONLY,timeout:8000},async()=>{
 const f=await fixture();let pid:number|undefined;
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,()=>f.helper.send({op:"never"},5000,true,undefined,undefined,undefined,undefined,context=>{pid=context.child.pid;throw new Error("registration refused");})),/registration refused/);assert.ok(pid);assert.equal(f.helper.pid,null);assert.equal(await readFile(join(f.root,"received"),"utf8"),"");await assert.rejects(lstat(join(f.root,"claim","input.lock")),{code:"ENOENT"});}finally{await f.close();}
});

test("synchronous startup work cannot outrun the original deadline before timers run",{...POSIX_ONLY,timeout:8000},async()=>{
 const f=await fixture();
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,()=>f.helper.send({op:"never"},30,true,undefined,undefined,undefined,undefined,()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,70);})),/timed out.*before its first command write/);assert.equal(await readFile(join(f.root,"received"),"utf8"),"");assert.equal(f.helper.pid,null);}finally{await f.close();}
});

test("unawaited startup is tracked from creation and a sealed scope cannot send after registration resolves",{...POSIX_ONLY,timeout:8000},async()=>{
 const f=await fixture(),entered=deferred(),gate=deferred(),returned=deferred();let unawaited:Promise<unknown>|undefined;
 const task=f.coordinator.run(new AbortController().signal,async()=>{unawaited=f.helper.send({op:"never"},5000,true,undefined,undefined,undefined,undefined,async()=>{entered.resolve();await gate.promise;returned.resolve();});void unawaited.catch(()=>{});await entered.promise;}).catch(error=>error);
 try{const error=await task;assert.ok(error instanceof Error);assert.match(error.message,/input helper termination could not be verified/);gate.resolve();await returned.promise;await unawaited!.catch(()=>{});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(await readFile(join(f.root,"received"),"utf8"),"");assert.equal(f.helper.pid,null);assert.ok((await lstat(join(f.root,"claim","input.lock"))).isDirectory());}finally{gate.resolve();await task;await f.close();}
});

test("a delayed disposal from an ended scope has no effect on the still-live helper or its next legal command",{...POSIX_ONLY,timeout:8000},async()=>{
 const f=await fixture(),trigger=deferred();let delayed:Promise<unknown>|undefined;
 try{
  await f.coordinator.run(new AbortController().signal,async()=>{await f.helper.send({op:"first"});delayed=trigger.promise.then(()=>f.helper.dispose());void delayed.catch(()=>{});});
  const original=f.helper.pid;assert.ok(original);trigger.resolve();await assert.rejects(delayed!,/input lease has ended/);assert.equal(f.helper.pid,original);assert.equal(Reflect.get(f.helper,"disposed"),false);assert.equal(await readFile(join(f.root,"lifecycle"),"utf8"),"");
  await f.coordinator.run(new AbortController().signal,()=>f.helper.send({op:"next"}));assert.equal(f.helper.pid,original);assert.deepEqual((await readFile(join(f.root,"received"),"utf8")).trim().split("\n").map(line=>JSON.parse(line).op),["first","next"]);
  await f.helper.dispose();assert.equal(f.helper.pid,null);assert.equal(await readFile(join(f.root,"lifecycle"),"utf8"),"eof\n");
 }finally{trigger.resolve();await delayed?.catch(()=>{});await f.close();}
});
