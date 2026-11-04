import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFile,lstat,mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InputCoordinator,InputTerminationUnverifiedError } from "../src/coordinator.ts";
import { ComponentInputClaims,type ClaimState } from "../src/input-claim-mac.ts";
import { HelperResponseError } from "../src/helper.ts";
import { jxaClaimSender } from "./fixtures/jxa-claim-sender.ts";

const mac={skip:process.platform!=="darwin",timeout:20_000};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"mountains-claim-owner-")),store=join(root,"store");await mkdir(store,{mode:0o700});await writeFile(join(root,"methods"),"");
 const client=new ComponentInputClaims(store),initial=await client.initialize(),coordinator=new InputCoordinator(join(root,"legacy"),client);
 const inspect=()=>client.call({op:"inspect"});
 return {root,store,client,initial,coordinator,inspect,async close(){await client.close();await rm(root,{recursive:true,force:true});}};
}

test("owner independently refreshes after actual Foundation sender begin/receipt instead of trusting its false reply revision",mac,async t=>{
 const f=await fixture(),sender=await jxaClaimSender(f.root,f.store,f.initial.binding).catch(async error=>{await f.close();throw error;});let methodCount=0;
 try{
  await f.coordinator.run(new AbortController().signal,async lease=>{
   let state=await f.inspect();const fields={leaseId:state.lease!.id,epoch:state.lease!.epoch},senderId=randomUUID();
   state=await f.client.call({op:"register",senderKind:"file_only",revision:state.revision,...fields,senderId,senderPid:sender.pid});
   const address={schema:"mac-input-address-v1",kind:"process",operation:"file_sender",owner:{process:state.lease!.owner},target:{process:state.lease!.owner}};
   const ticket={...fields,commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address};
   state=await f.client.call({op:"stage",revision:state.revision,...ticket,senderId});
   state=await f.client.call({op:"permit",revision:state.revision,...ticket});
   await assert.rejects(f.client.call({op:"begin",...ticket,openObligations:[]}),/actual caller is not registered sender/);
   const reply=await sender.execute(ticket);assert.equal(reply.executed,true);assert.equal(reply.revision,"0");
   const after=await f.inspect();assert.equal(after.lease!.commands[0]!.phase,"clean");assert.ok(BigInt(after.revision)>BigInt(state.revision));assert.equal(after.lease!.senders.find(s=>s.id===senderId)!.birth.pid,sender.pid);
   await lease.ax(process.pid,process.pid,"press",async()=>{methodCount++;await appendFile(join(f.root,"methods"),"node-method\n");});
   // EOF/ended is the original sender's proof; no owner-forged retire receipt.
   await sender.close();
  });
  assert.equal(methodCount,1);assert.equal(await readFile(join(f.root,"methods"),"utf8"),"jxa-method\nnode-method\n");assert.equal((await f.inspect()).lease,undefined);
 }catch(error){
  const causes=(value:unknown):string[]=>value instanceof Error?[value.message,...(value instanceof AggregateError?value.errors.flatMap(causes):value.cause?causes(value.cause):[])]:[];
  t.diagnostic(JSON.stringify({methods:await readFile(join(f.root,"methods"),"utf8"),causes:causes(error),phases:(await f.inspect()).lease?.commands.map(c=>c.phase)}));throw error;
 }finally{await sender.kill();await f.close();}
});

async function advance(client:ComponentInputClaims,call:ComponentInputClaims["call"]){
 const state=await call({op:"inspect"}),lease=state.lease!;
 return call({op:"stage",revision:state.revision,leaseId:lease.id,epoch:lease.epoch,senderId:lease.senders.find(s=>s.birth.pid===process.pid)!.id,commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address:{schema:"mac-input-address-v1",kind:"process",operation:"other_file_record",owner:{process:lease.owner},target:{process:lease.owner}}});
}
const ownStage=(request:Record<string,unknown>,op="stage")=>request.op===op&&(request.address as {operation?:string}|undefined)?.operation==="press";
const reasonContains=(error:unknown,text:string):boolean=>error instanceof Error&&(error.message.includes(text)||(error instanceof AggregateError&&error.errors.some(item=>reasonContains(item,text)))||reasonContains(error.cause,text));

test("native revision-conflict code proves a pre-mutation refusal and is not inferred from messages",mac,async()=>{
 const f=await fixture();try{
  const state=await f.inspect();await assert.rejects(f.client.call({op:"acquire",revision:"999",leaseId:randomUUID()}),error=>{assert.ok(error instanceof HelperResponseError);assert.equal(error.reply.code,"revision_conflict");assert.equal(f.client.isRevisionConflict(error),true);return true;});assert.deepEqual(await f.inspect(),state);
  assert.equal(f.client.isRevisionConflict(new Error("claim revision changed")),false);
  assert.equal(f.client.isRevisionConflict(new HelperResponseError({error:"claim revision changed",componentOnly:true})),false);
  assert.equal(f.client.isRevisionConflict(new HelperResponseError({code:"revision_conflict",componentOnly:false})),false);
 }finally{await f.close();}
});

for(const op of ["stage","permit"] as const)test(`one native ${op} revision conflict refreshes and invokes the actual method only once`,mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client);let writes=0,attempts=0;
 f.client.call=async(request,timeout)=>{if(ownStage(request,op)&&++attempts===1)await advance(f.client,original);return original(request,timeout);};
 try{await f.coordinator.run(new AbortController().signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;await appendFile(join(f.root,"methods"),"one method\n");}));assert.equal(attempts,2);assert.equal(writes,1);assert.equal(await readFile(join(f.root,"methods"),"utf8"),"one method\n");assert.equal((await f.inspect()).lease,undefined);}finally{await f.close();}
});

for(const op of ["stage","permit"] as const)test(`four certified ${op} conflicts stop this unstarted command and allow verified cleanup`,mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client);let writes=0,attempts=0;
 f.client.call=async(request,timeout)=>{if(ownStage(request,op)){attempts++;await advance(f.client,original);}return original(request,timeout);};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;})),error=>!(error instanceof InputTerminationUnverifiedError)&&error instanceof Error&&/record remained busy; this command was not started/.test(error.message));assert.equal(attempts,4);assert.equal(writes,0);assert.equal((await f.inspect()).lease,undefined);await assert.rejects(lstat(join(f.root,"legacy","input.lock")),{code:"ENOENT"});await f.coordinator.run(new AbortController().signal,async()=>{});}finally{await f.close();}
});

for(const op of ["begin","receipt","retire"] as const)test(`sender ${op} is never replayed even if a refusal carries the compare code`,mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client);let calls=0,writes=0;
 f.client.call=async(request,timeout)=>{if(request.op===op){calls++;throw new HelperResponseError({componentOnly:true,code:"revision_conflict",error:"injected response must not replay sender command"});}return original(request,timeout);};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;})),InputTerminationUnverifiedError);assert.equal(calls,1);assert.equal(writes,op==="begin"?0:1);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());}finally{await f.close();}
});

test("a committed owner transaction with a missing reply is not replayed or treated as a conflict",mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client);let calls=0,writes=0;
 f.client.call=async(request,timeout)=>{const state=await original(request,timeout);if(ownStage(request)){calls++;throw new Error("reply lost after actual commit");}return state;};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;})),InputTerminationUnverifiedError);assert.equal(calls,1);assert.equal(writes,0);assert.equal((await f.inspect()).lease!.commands[0]!.phase,"registered");assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());}finally{await f.close();}
});

for(const field of ["epoch","owner"] as const)test(`inspection cannot adopt a different ${field} under the same lease nonce`,mac,async()=>{
 const f=await fixture();let writes=0;
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,async lease=>{
  const state=await f.inspect();state.revision=String(BigInt(state.revision)+1n);
  if(field==="epoch")state.lease!.epoch=state.revision;else state.lease!.owner.startSeconds=String(BigInt(state.lease!.owner.startSeconds)+1n);
  await writeFile(join(f.store,"input-claim.state"),JSON.stringify(state),{mode:0o600});
  await lease.ax(process.pid,process.pid,"press",async()=>{writes++;});
 }),error=>error instanceof InputTerminationUnverifiedError&&reasonContains(error,"original persistent input lease identity changed"));assert.equal(writes,0);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());}finally{await f.close();}
});

test("the original owner identity is copied once rather than aliased to a returned acquire object",mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client);let acquired:ClaimState|undefined,writes=0;
 f.client.call=async(request,timeout)=>{const state=await original(request,timeout);if(request.op==="acquire")acquired=state;return state;};
 try{await f.coordinator.run(new AbortController().signal,async lease=>{acquired!.lease!.epoch="999";acquired!.lease!.owner.startSeconds="1";await lease.ax(process.pid,process.pid,"press",async()=>{writes++;});});assert.equal(writes,1);assert.equal((await f.inspect()).lease,undefined);}finally{await f.close();}
});

test("cancellation during the independent pre-write inspection sends no new business transaction",mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client),stop=new AbortController(),reason=new Error("cancel during inspection");let armed=false,writes=0,stages=0;
 f.client.call=async(request,timeout)=>{if(request.op==="stage")stages++;const state=await original(request,timeout);if(armed&&request.op==="inspect"){armed=false;stop.abort(reason);}return state;};
 try{await assert.rejects(f.coordinator.run(stop.signal,async lease=>{armed=true;await lease.ax(process.pid,process.pid,"press",async()=>{writes++;});}),error=>error===reason);assert.equal(stages,0);assert.equal(writes,0);assert.equal((await f.inspect()).lease,undefined);}finally{await f.close();}
});

test("owner retries share one monotonic deadline instead of restarting five seconds for each attempt",mac,async t=>{
 const f=await fixture(),original=f.client.call.bind(f.client),clock=performance.now.bind(performance);let offset=0,attempts=0,writes=0;const limits:number[]=[];
 t.mock.method(performance,"now",()=>clock()+offset);
 f.client.call=async(request,timeout)=>{if(ownStage(request)){attempts++;limits.push(timeout!);await advance(f.client,original);try{return await original(request,timeout);}catch(error){offset+=3000;throw error;}}return original(request,timeout);};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;})),error=>error instanceof InputTerminationUnverifiedError&&reasonContains(error,"transaction deadline exceeded"));assert.equal(attempts,2);assert.ok(limits[1]!<limits[0]!-2500);assert.equal(writes,0);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());}finally{t.mock.restoreAll();await f.close();}
});

test("late successful file-transaction reply cannot satisfy the total deadline",mac,async t=>{
 const f=await fixture(),original=f.client.call.bind(f.client),clock=performance.now.bind(performance);let offset=0,calls=0,writes=0;t.mock.method(performance,"now",()=>clock()+offset);
 f.client.call=async(request,timeout)=>{const state=await original(request,timeout);if(ownStage(request)){calls++;offset+=6000;}return state;};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;})),error=>error instanceof InputTerminationUnverifiedError&&reasonContains(error,"transaction deadline exceeded"));assert.equal(calls,1);assert.equal(writes,0);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());}finally{t.mock.restoreAll();await f.close();}
});

for(const op of ["stage","permit"] as const)for(const phase of ["permitted","executing"] as const)test(`${op} conflicts cannot call an already ${phase} ticket unstarted`,mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client);let attempts=0,writes=0;
 f.client.call=async(request,timeout,beforeDispatch)=>{
  if(!ownStage(request,op))return original(request,timeout,beforeDispatch);
  attempts++;await advance(f.client,original);
  try{return await original(request,timeout,beforeDispatch);}catch(error){
   if(attempts===4){let state=await original({op:"inspect"});if(op==="stage")state=await original({...request,revision:state.revision});state=await original({...request,op:"permit",revision:state.revision});if(phase==="executing")await original({...request,op:"begin",openObligations:[]});}
   throw error;
  }
 };
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;})),InputTerminationUnverifiedError);assert.equal(attempts,4);assert.equal(writes,0);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());assert.equal((await f.inspect()).lease!.commands.find(c=>c.address.operation==="press")!.phase,phase);}finally{await f.close();}
});

test("an unstarted second command cannot erase the compound action's earlier actual effect",mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client);let first=0,second=0;
 f.client.call=async(request,timeout,beforeDispatch)=>{if(ownStage(request))await advance(f.client,original);return original(request,timeout,beforeDispatch);};
 try{await assert.rejects(f.coordinator.run(new AbortController().signal,async lease=>{await lease.ax(process.pid,process.pid,"select_text",async()=>{first++;await appendFile(join(f.root,"methods"),"prior effect\n");});await lease.ax(process.pid,process.pid,"press",async()=>{second++;});}),/this command was not started/);assert.equal(first,1);assert.equal(second,0);assert.equal(await readFile(join(f.root,"methods"),"utf8"),"prior effect\n");assert.equal((await f.inspect()).lease,undefined);}finally{await f.close();}
});

test("cancellation after a certified conflict forbids another business attempt while cleanup still finishes",mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client),stop=new AbortController(),reason=new Error("cancel after definite conflict");let attempts=0,writes=0;
 f.client.call=async(request,timeout,beforeDispatch)=>{if(!ownStage(request))return original(request,timeout,beforeDispatch);attempts++;await advance(f.client,original);try{return await original(request,timeout,beforeDispatch);}catch(error){stop.abort(reason);throw error;}};
 try{await assert.rejects(f.coordinator.run(stop.signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;})),error=>error===reason);assert.equal(attempts,1);assert.equal(writes,0);assert.equal((await f.inspect()).lease,undefined);}finally{await f.close();}
});

for(const mode of ["aborted","expired"] as const)test(`real fixed-store transport rejects a queued ${mode} stage before any native write`,mac,async()=>{
 const f=await fixture(),original=f.client.call.bind(f.client),stop=new AbortController(),reason=new Error("cancel queued native stage");let writes=0,attempts=0;
 f.client.call=async(request,timeout,beforeDispatch)=>{
  if(!ownStage(request))return original(request,timeout,beforeDispatch);
  attempts++;
  const lock=spawn("/usr/bin/python3",["-c","import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()",join(f.store,"input-claim.guard")],{stdio:["pipe","pipe","pipe"]});
  const closed=once(lock,"close");let blocker:Promise<ClaimState>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try{
   assert.match(String((await once(lock.stdout,"data"))[0]),/locked/);
   blocker=original({op:"inspect"});void blocker.catch(()=>{});
   const queued=original(request,mode==="expired"?30:timeout,beforeDispatch);
   if(mode==="aborted")timer=setTimeout(()=>stop.abort(reason),20);
   let failure:unknown;try{await queued;assert.fail("queued native request must not commit");}catch(error){failure=error;}
   lock.stdin.end();await closed;await blocker;
   const state=await original({op:"inspect"});assert.equal(state.lease!.commands.some(c=>c.address.operation==="press"),false,"no late stage may appear after the blocker completes");
   assert.ok(failure instanceof Error);throw failure;
  }finally{clearTimeout(timer);lock.stdin.end();if(lock.exitCode===null&&lock.signalCode===null)lock.kill("SIGKILL");await closed;await blocker?.catch(()=>{});}
 };
 try{
  await assert.rejects(f.coordinator.run(stop.signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{writes++;})),error=>mode==="aborted"?error===reason:error instanceof InputTerminationUnverifiedError);
  assert.equal(attempts,1);assert.equal(writes,0);
  if(mode==="aborted"){assert.equal((await f.inspect()).lease,undefined);await assert.rejects(lstat(join(f.root,"legacy","input.lock")),{code:"ENOENT"});}
  else assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());
 }finally{await f.close();}
});
