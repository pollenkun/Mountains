import assert from "node:assert/strict";
import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { HelperAdmissionError,JsonHelper } from "../src/helper.ts";

const program=String.raw`
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin}),root=process.argv[1];
const reply=c=>process.stdout.write(JSON.stringify({id:c.id,ok:true})+'\n');
rl.on('line',line=>{const c=JSON.parse(line);fs.appendFileSync(root+'/received',c.op+'\n');if(c.op!=='hold'){reply(c);return;}fs.writeFileSync(root+'/holding','true');const timer=setInterval(()=>{if(fs.existsSync(root+'/go')){clearInterval(timer);reply(c);}},5);});
`;
async function fixture(){const root=await mkdtemp(join(tmpdir(),"mountains-helper-admission-"));await writeFile(join(root,"received"),"");const helper=new JsonHelper(process.execPath,["-e",program,root]);return {root,helper,async close(){await helper.dispose();await rm(root,{recursive:true,force:true});}};}
async function held(root:string){const until=Date.now()+5000;for(;;){try{await readFile(join(root,"holding"));return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"||Date.now()>=until)throw error;}await delay(5);}}

for(const mode of ["expired","aborted"] as const)test(`queued ${mode} returns before the blocker and permanently forbids its late first write`,{timeout:15_000},async()=>{
 const f=await fixture(),stop=new AbortController(),reason=new Error("cancel only queued command");let unblocked=false,firstDone=false;
 const first=f.helper.send({op:"hold"},8000).then(value=>{firstDone=true;return value;});
 let watchdog:ReturnType<typeof setTimeout>|undefined;
 try{
  await held(f.root);const pid=f.helper.pid,admission={expiresAt:performance.now()+(mode==="expired"?30:5000),beforeDispatch:stop.signal};
  const queued=f.helper.send({op:"never"},5000,true,undefined,undefined,undefined,admission);
  admission.expiresAt=performance.now()+60_000; // Cannot alter the captured request.
  if(mode==="aborted")stop.abort(reason);
  watchdog=setTimeout(()=>{unblocked=true;void writeFile(join(f.root,"go"),"release");},1000);
  await assert.rejects(queued,error=>{assert.ok(error instanceof HelperAdmissionError);assert.equal(error.reason,mode);if(mode==="aborted")assert.equal(error.cause,reason);return true;});
  assert.equal(unblocked,false);assert.equal(firstDone,false);assert.equal(f.helper.pid,pid);assert.equal(await readFile(join(f.root,"received"),"utf8"),"hold\n");
  clearTimeout(watchdog);await writeFile(join(f.root,"go"),"release");await first;
  await f.helper.send({op:"after"},5000,true,undefined,undefined,undefined,{expiresAt:performance.now()+5000});
  assert.equal(await readFile(join(f.root,"received"),"utf8"),"hold\nafter\n");
 }finally{clearTimeout(watchdog);await writeFile(join(f.root,"go"),"release");await first.catch(()=>{});await f.close();}
});

test("aborting after the first byte still waits for the actual transaction rather than reporting unsent cancellation",{timeout:15_000},async()=>{
 const f=await fixture(),stop=new AbortController();let done=false;
 const request=f.helper.send({op:"hold"},8000,true,undefined,undefined,undefined,{expiresAt:performance.now()+8000,beforeDispatch:stop.signal}).finally(()=>{done=true;});
 try{await held(f.root);stop.abort();await delay(30);assert.equal(done,false);assert.ok(f.helper.pid);await writeFile(join(f.root,"go"),"release");await request;assert.equal(await readFile(join(f.root,"received"),"utf8"),"hold\n");}finally{await writeFile(join(f.root,"go"),"release");await request.catch(()=>{});await f.close();}
});

test("serialization cannot extend an expired first-write admission or start a delayed helper",async t=>{
 const f=await fixture(),clock=performance.now.bind(performance);let offset=0;t.mock.method(performance,"now",()=>clock()+offset);
 try{await assert.rejects(f.helper.send({op:"never",toJSON(){offset=1000;return {op:"never"};}},5000,true,undefined,undefined,undefined,{expiresAt:performance.now()+50}),HelperAdmissionError);assert.equal(f.helper.pid,null);assert.equal(await readFile(join(f.root,"received"),"utf8"),"");}finally{t.mock.restoreAll();await f.close();}
});

test("a write that applies then throws an admission-shaped error is still possibly sent",{timeout:15_000},async()=>{
 const f=await fixture();let attempted=false;
 try{
  await f.helper.send({op:"warm"},5000);
  const child=Reflect.get(f.helper,"child") as import("node:child_process").ChildProcessWithoutNullStreams,write=child.stdin.write;
  Object.defineProperty(child.stdin,"write",{configurable:true,writable:true,value:(...args:unknown[])=>{Reflect.apply(write,child.stdin,args);attempted=true;throw new HelperAdmissionError("aborted",new Error("after actual write"));}});
  try{await assert.rejects(f.helper.send({op:"applied"},5000,true,undefined,undefined,undefined,{expiresAt:performance.now()+5000}),error=>{assert.ok(error instanceof Error);assert.ok(!(error instanceof HelperAdmissionError));assert.match(error.message,/write was attempted/);return true;});}
  finally{Object.defineProperty(child.stdin,"write",{configurable:true,writable:true,value:write});}
  assert.equal(attempted,true);
  for(const until=Date.now()+5000;;){const text=await readFile(join(f.root,"received"),"utf8");if(text.includes("applied\n"))break;if(Date.now()>=until)assert.fail("actual child never received attempted bytes");await delay(5);}
  assert.equal(await readFile(join(f.root,"received"),"utf8"),"warm\napplied\n");
 }finally{await f.helper.dispose().catch(()=>{});assert.equal(f.helper.pid,null);await rm(f.root,{recursive:true,force:true});}
});
