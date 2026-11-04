import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ComponentInputClaims, type ClaimFocusFinalization, type ClaimInputAddress, type ClaimProcessBirth, type ClaimRestoreObligation, type ClaimState } from "../src/input-claim-mac.ts";

// File/process protocol checks. No AX, GUI applications or system clipboard.
// References and process-shaped addresses here never prove a real UI outcome.
const mac={skip:process.platform!=="darwin",timeout:30_000};
const clean={schema:"input-claim-cleanup-v2",pendingKeys:0,pendingButtons:0,failed:false,complete:true};
const restored={schema:"input-claim-restoration-v1",complete:true,failed:false};
const fields=(state:ClaimState)=>state.lease?{leaseId:state.lease.id,epoch:state.lease.epoch}:{};
const processAddress=(birth:ClaimProcessBirth,operation="focus_restore"):ClaimInputAddress=>({schema:"mac-input-address-v1",kind:"process",operation,owner:{process:birth},target:{process:birth}});
function worker(){
 const child=spawn(process.execPath,[fileURLToPath(new URL("./fixtures/claim-worker.ts",import.meta.url))],{stdio:["ignore","ignore","pipe","ipc"]});child.stderr!.resume();
 const closed=once(child,"close");let id=0;
 const pending=new Map<number,{resolve:(state:ClaimState)=>void;reject:(error:Error)=>void}>();
 child.on("message",(message:{id:number;result:ClaimState;error?:string})=>{const p=pending.get(message.id);if(!p)return;pending.delete(message.id);if(message.error)p.reject(new Error(message.error));else p.resolve(message.result);});
 child.on("close",()=>{for(const p of pending.values())p.reject(new Error("own worker closed"));pending.clear();});
 const send=(message:Record<string,unknown>)=>new Promise<ClaimState>((resolve,reject)=>{pending.set(++id,{resolve,reject});child.send({...message,id});});
 return {child,connect:(directory:string,binding:ClaimState["binding"])=>send({op:"connect",directory,binding}),call:(command:Record<string,unknown>)=>send({op:"call",command}),async stop(){if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed;}};
}
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),"mountains-focus-resolution-"));await chmod(directory,0o700);
 const client=new ComponentInputClaims(directory),initial=await client.initialize();
 let state=await client.call({op:"acquire",revision:initial.revision,leaseId:randomUUID()});
 const senderId=randomUUID();state=await client.call({op:"register",revision:state.revision,...fields(state),senderId,senderPid:process.pid,senderKind:"ui_input"});
 const workers:ReturnType<typeof worker>[]=[];
 const sync=async()=>state=await client.call({op:"inspect"});
 const call=async(command:Record<string,unknown>)=>state=await client.call({...fields(state),...command});
 const addWorker=async()=>{const w=worker();workers.push(w);await w.connect(directory,state.binding);return {worker:w,birth:await client.processIdentity(w.child.pid!)};};
 const group=(front:ClaimProcessBirth,keyboard?:ClaimProcessBirth):ClaimRestoreObligation[]=>{
  const scopeId=randomUUID();
  return ([{resource:"frontmost_application" as const,birth:front},...(keyboard?[{resource:"keyboard_focus" as const,birth:keyboard}]:[])]).map(value=>({id:randomUUID(),kind:"focus" as const,address:processAddress(value.birth),focusBaseline:{schema:"input-claim-focus-baseline-v1",scopeId,resource:value.resource,reference:randomUUID(),keyboardAtCapture:keyboard?"present":"absent",uiSender:state.lease!.owner}}));
 };
 const stage=async(address:ClaimInputAddress=processAddress(state.lease!.owner,"file_probe"))=>{await call({op:"stage",revision:state.revision,senderId,commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address});const command=state.lease!.commands.at(-1)!;const ticket={...fields(state),commandId:command.id,token:command.token,route:command.route,address:command.address};await call({op:"permit",revision:state.revision,...ticket});return ticket;};
 const start=async(opened:ClaimRestoreObligation[],address?:ClaimInputAddress)=>{const ticket=await stage(address);await call({op:"begin",...ticket,openObligations:opened});return ticket;};
 const seal=()=>call({op:"seal",revision:state.revision});
 const proof=(opened:ClaimRestoreObligation[]):ClaimFocusFinalization=>{
  const focus=opened.filter(o=>o.kind==="focus");const front=focus.find(o=>o.focusBaseline!.resource==="frontmost_application")!,keyboard=focus.find(o=>o.focusBaseline!.resource==="keyboard_focus");
  assert.equal(front.address.kind,"process");
  if(keyboard)assert.equal(keyboard.address.kind,"process");
  return {observation:{schema:"input-claim-focus-observation-v1",id:randomUUID(),scopeId:front.focusBaseline!.scopeId,front:{process:front.address.target.process,reference:front.focusBaseline!.reference},keyboard:keyboard&&keyboard.address.kind==="process"?{status:"present",destination:{process:keyboard.address.target.process,reference:keyboard.focusBaseline!.reference}}:{status:"absent",destination:null}},resolutions:focus.map(o=>({restorationId:o.id,address:o.address,action:"no_write",reason:"already_at_original"}))};
 };
 const resolve=(value:unknown)=>call({op:"resolveFocus",senderId,focusFinalization:value});
 const finish=async()=>{await call({op:"retire",senderId});await call({op:"release",revision:state.revision});assert.equal(state.lease,undefined);};
 return {directory,client,senderId,get state(){return state;},sync,call,addWorker,group,stage,start,seal,proof,resolve,finish,async close(){await Promise.allSettled(workers.map(w=>w.stop()));await client.close();await rm(directory,{recursive:true,force:true});}};
}

test("atomic final focus is required even after both restoration writes report success",mac,async()=>{
 const f=await fixture();try{
  const opened=f.group(f.state.lease!.owner,f.state.lease!.owner),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();
  // Independent resources may start in either order, but never overlap.
  await f.call({op:"beginRestore",restorationId:opened[0]!.id,address:opened[0]!.address});
  await assert.rejects(f.call({op:"beginRestore",restorationId:opened[1]!.id,address:opened[1]!.address}),/another input sender or restoration/);
  await f.call({op:"restorationReceipt",restorationId:opened[0]!.id,address:opened[0]!.address,restorationReceipt:restored});
  await f.call({op:"beginRestore",restorationId:opened[1]!.id,address:opened[1]!.address});
  await f.call({op:"restorationReceipt",restorationId:opened[1]!.id,address:opened[1]!.address,restorationReceipt:restored});
  await assert.rejects(f.call({op:"retire",senderId:f.senderId}),/pending restorations/);
  const proof=f.proof(opened);await f.resolve(proof);assert.deepEqual(f.state.lease!.restorations.map(r=>r.phase),["resolved","resolved"]);
  // Original focus wins before exclusions, including a target already in front.
  assert.deepEqual(f.state.lease!.focusFinalization,proof);const revision=f.state.revision;await f.resolve(proof);assert.equal(f.state.revision,revision);
  await assert.rejects(f.resolve({...proof,observation:{...proof.observation,id:randomUUID()}}),/cannot be replaced/);
  await assert.rejects(f.call({op:"beginRestore",restorationId:opened[0]!.id,address:opened[0]!.address}),/finalized/);
  assert.equal((await f.call({op:"restorationReceipt",restorationId:opened[0]!.id,address:opened[0]!.address,restorationReceipt:restored})).revision,revision);
  await f.finish();
 }finally{await f.close();}
});

test("unrelated user destinations can be preserved without rewriting immutable original baselines",mac,async()=>{
 const f=await fixture();try{
  const original=await f.addWorker(),current=await f.addWorker();const opened=f.group(original.birth,original.birth),before=structuredClone(opened);
  const ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();const proof=f.proof(opened);
  proof.observation.front={process:current.birth,reference:randomUUID()};proof.observation.keyboard={status:"present",destination:{process:current.birth,reference:randomUUID()}};
  for(const resolution of proof.resolutions)resolution.reason="preserve_current_destination";
  await f.resolve(proof);assert.equal(f.state.lease!.tainted,false);assert.deepEqual(f.state.lease!.commands[0]!.openedObligations,before);await f.finish();
 }finally{await f.close();}
});

for(const invalid of ["business-host","remote-target","ui-sender","application-address"] as const)test(`preserve cannot excuse focus in ${invalid}`,mac,async()=>{
 const f=await fixture();try{
  const original=await f.addWorker(),host=await f.addWorker(),remote=await f.addWorker();const opened=f.group(original.birth);
  const address:ClaimInputAddress=invalid==="application-address"?{schema:"mac-input-address-v1",kind:"application",operation:"file_probe",application:"own-file-fixture"}:{schema:"mac-input-address-v1",kind:"process",operation:"file_probe",owner:{process:host.birth},target:{process:remote.birth}};
  const ticket=await f.start(opened,address);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();const proof=f.proof(opened);
  proof.observation.front={process:invalid==="business-host"?host.birth:invalid==="ui-sender"?f.state.lease!.owner:remote.birth,reference:randomUUID()};proof.resolutions[0]!.reason="preserve_current_destination";
  await f.resolve(proof);assert.equal(f.state.lease!.tainted,true);assert.equal(f.state.lease!.restorations[0]!.phase,"unknown");
  await assert.rejects(f.resolve(f.proof(opened)),/unknown cleanup/);await assert.rejects(f.call({op:"release",revision:f.state.revision}),/cleanup remains unknown/);
 }finally{await f.close();}
});

for(const invalid of ["missing-front","missing-keyboard","duplicate-resource","changed-scope","missing-baseline","extra-field","wrong-ui-sender","two-original-destinations","window-on-original"] as const)test(`first UI begin refuses ${invalid} without consuming its permit`,mac,async()=>{
 const f=await fixture();try{
  const opened=f.group(f.state.lease!.owner,f.state.lease!.owner),value=structuredClone(opened) as any[];
  if(invalid==="missing-front")value.shift();if(invalid==="missing-keyboard")value.pop();
  if(invalid==="duplicate-resource")value[1].focusBaseline.resource="frontmost_application";
  if(invalid==="changed-scope")value[1].focusBaseline.scopeId=randomUUID();
  if(invalid==="missing-baseline")delete value[0].focusBaseline;
  if(invalid==="extra-field")value[0].focusBaseline.label="should never record UI text";
  if(invalid==="wrong-ui-sender")value[0].focusBaseline.uiSender=(await f.addWorker()).birth;
  if(invalid==="two-original-destinations")value[0].address.owner={process:(await f.addWorker()).birth};
  if(invalid==="window-on-original")for(const key of ["owner","target"])value[0].address[key]={...value[0].address[key],window:1,bounds:{x:0,y:0,width:1,height:1}};
  const ticket=await f.stage(),before=f.state;await assert.rejects(f.call({op:"begin",...ticket,openObligations:value}),/focus|restoration/);assert.deepEqual(await f.sync(),before);
  await f.call({op:"begin",...ticket,openObligations:opened});await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();await f.resolve(f.proof(opened));await f.finish();
 }finally{await f.close();}
});

test("UI sender cannot begin with empty obligations, create a second UI sender or open a later baseline",mac,async()=>{
 const f=await fixture();try{
  const second=await f.addWorker();await assert.rejects(f.call({op:"register",revision:f.state.revision,senderId:randomUUID(),senderPid:second.birth.pid,senderKind:"ui_input"}),/UI sender must be unique/);
  const opened=f.group(f.state.lease!.owner),ticket=await f.stage();await assert.rejects(f.call({op:"begin",...ticket,openObligations:[]}),/original focus group/);assert.equal(f.state.lease!.commands[0]!.phase,"permitted");
  await f.call({op:"begin",...ticket,openObligations:opened});await f.call({op:"receipt",...ticket,receipt:clean});const next=await f.stage();
  await assert.rejects(f.call({op:"begin",...next,openObligations:f.group(f.state.lease!.owner)}),/cannot be replaced/);
  await f.call({op:"begin",...next,openObligations:[]});await f.call({op:"receipt",...next,receipt:clean});await f.seal();await f.resolve(f.proof(opened));await f.finish();
 }finally{await f.close();}
});

for(const invalid of ["keyboard-absent","keyboard-unreadable","keyboard-null","partial-group","extra-resolution","changed-original","changed-private-reference","changed-scope","changed-front-process-birth","unknown-reason","missing-observation","extra-observation-field"] as const)test(`authenticated invalid ${invalid} cannot later be erased by a good observation`,mac,async()=>{
 const f=await fixture();try{
  const opened=f.group(f.state.lease!.owner,f.state.lease!.owner),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();const value:any=f.proof(opened);
  if(invalid==="keyboard-absent")value.observation.keyboard={status:"absent",destination:null};
  if(invalid==="keyboard-unreadable")value.observation.keyboard={status:"unreadable",destination:null};
  if(invalid==="keyboard-null")value.observation.keyboard=null;
  if(invalid==="partial-group")value.resolutions.pop();if(invalid==="extra-resolution")value.resolutions.push(structuredClone(value.resolutions[0]));
  if(invalid==="changed-original")value.resolutions[0].address.operation="different_restore";
  if(invalid==="changed-private-reference")value.observation.front.reference=randomUUID();
  if(invalid==="changed-scope")value.observation.scopeId=randomUUID();
  if(invalid==="changed-front-process-birth")value.observation.front.process.startMicroseconds=(value.observation.front.process.startMicroseconds+1)%1_000_000;
  if(invalid==="unknown-reason")value.resolutions[0].reason="user_input_recently";
  if(invalid==="missing-observation")delete value.observation;
  if(invalid==="extra-observation-field")value.observation.uiText="must not persist";
  await f.resolve(value);assert.equal(f.state.lease!.tainted,true);assert.ok(f.state.lease!.restorations.every(r=>r.phase==="unknown"));assert.equal(f.state.lease!.focusFinalization,undefined);
  await assert.rejects(f.resolve(f.proof(opened)),/unknown cleanup/);await assert.rejects(f.call({op:"release",revision:f.state.revision}),/cleanup remains unknown/);
 }finally{await f.close();}
});

test("a dead original keyboard process does not excuse the separate live original frontmost process",mac,async()=>{
 const f=await fixture();try{
  const original=await f.addWorker();const opened=f.group(f.state.lease!.owner,original.birth),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();await original.worker.stop();
  const proof=f.proof(opened);proof.observation.keyboard={status:"absent",destination:null};proof.resolutions[1]!.reason="destination_ended";
  await f.resolve(proof);assert.equal(f.state.lease!.tainted,false);assert.equal(f.state.lease!.restorations[0]!.phase,"resolved");await f.finish();
 }finally{await f.close();}
});

test("destination-ended on a still-live original destination is terminal uncertainty",mac,async()=>{
 const f=await fixture();try{
  const opened=f.group(f.state.lease!.owner),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();const proof=f.proof(opened);proof.resolutions[0]!.reason="destination_ended";
  await f.resolve(proof);assert.equal(f.state.lease!.tainted,true);
 }finally{await f.close();}
});

test("atomic focus resolution waits for commands, clipboard and every restoration write to end",mac,async()=>{
 const f=await fixture();try{
  const opened=f.group(f.state.lease!.owner,f.state.lease!.owner),clipboard:ClaimRestoreObligation={id:randomUUID(),kind:"clipboard",address:{schema:"mac-input-address-v1",kind:"clipboard",operation:"clip_restore",clipboard:"general"}},ticket=await f.start([...opened,clipboard]);
  await assert.rejects(f.resolve(f.proof(opened)),/all writes end/);await f.call({op:"receipt",...ticket,receipt:clean});
  await assert.rejects(f.call({op:"beginRestore",restorationId:opened[1]!.id,address:opened[1]!.address}),/all input commands end/);await f.seal();await assert.rejects(f.resolve(f.proof(opened)),/all writes end/);
  await f.call({op:"beginRestore",restorationId:clipboard.id,address:clipboard.address});await assert.rejects(f.resolve(f.proof(opened)),/all writes end/);await f.call({op:"restorationReceipt",restorationId:clipboard.id,address:clipboard.address,restorationReceipt:restored});
  await f.call({op:"beginRestore",restorationId:opened[1]!.id,address:opened[1]!.address});await assert.rejects(f.resolve(f.proof(opened)),/all writes end/);await f.call({op:"restorationReceipt",restorationId:opened[1]!.id,address:opened[1]!.address,restorationReceipt:restored});
  await f.resolve(f.proof(opened));assert.equal(f.state.lease!.tainted,false);await f.finish();
 }finally{await f.close();}
});

test("another process, wrong sender ID and old epoch cannot submit final focus",mac,async()=>{
 const f=await fixture();try{
  const outsider=await f.addWorker(),opened=f.group(f.state.lease!.owner),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();const proof=f.proof(opened),before=f.state;
  await assert.rejects(outsider.worker.call({op:"resolveFocus",...fields(f.state),senderId:f.senderId,focusFinalization:proof}),/not original focus sender/);
  await assert.rejects(f.call({op:"resolveFocus",senderId:randomUUID(),focusFinalization:proof}),/not original focus sender/);
  await assert.rejects(f.call({op:"resolveFocus",epoch:"0",senderId:f.senderId,focusFinalization:proof}),/stale/);assert.deepEqual(await f.sync(),before);
  await f.resolve(proof);await f.finish();
 }finally{await f.close();}
});

for(const corruption of ["missing-final-observation","missing-group-member","nonfocus-resolved","early-finalization"] as const)test(`stored ${corruption} is rejected without repair`,mac,async()=>{
 const f=await fixture();try{
  const opened=f.group(f.state.lease!.owner,f.state.lease!.owner),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();await f.resolve(f.proof(opened));const value:any=structuredClone(f.state);
  if(corruption==="missing-final-observation")delete value.lease.focusFinalization;
  if(corruption==="missing-group-member")value.lease.focusFinalization.resolutions.pop();
  if(corruption==="nonfocus-resolved"){value.lease.restorations[0].obligation={id:opened[0]!.id,kind:"clipboard",address:{schema:"mac-input-address-v1",kind:"clipboard",operation:"clip_restore",clipboard:"general"}};value.lease.commands[0].openedObligations[0]=value.lease.restorations[0].obligation;}
  if(corruption==="early-finalization")value.lease.phase="open";
  const path=join(f.directory,"input-claim.state"),bytes=JSON.stringify(value);await writeFile(path,bytes,{mode:0o600});await assert.rejects(f.sync(),/focus|restoration/);assert.equal(await readFile(path,"utf8"),bytes);
 }finally{await f.close();}
});

test("new focus within the original app and a registered file-only process are not blanket-excluded",mac,async t=>{
 for(const destination of ["same-app-new-element","file-sender"] as const)await t.test(destination,async()=>{
  const f=await fixture();try{
   const original=await f.addWorker(),other=await f.addWorker(),opened=f.group(original.birth,original.birth);
   await f.call({op:"register",revision:f.state.revision,senderId:randomUUID(),senderPid:other.birth.pid,senderKind:"file_only"});
   const ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();const proof=f.proof(opened),current=destination==="same-app-new-element"?original.birth:other.birth;
   proof.observation.front={process:current,reference:randomUUID()};proof.observation.keyboard={status:"present",destination:{process:current,reference:randomUUID()}};for(const r of proof.resolutions)r.reason="preserve_current_destination";
   await f.resolve(proof);assert.equal(f.state.lease!.tainted,false);await other.worker.stop();await f.finish();
  }finally{await f.close();}
 });
});

test("unknown command cleanup cannot become clean merely because focus is observed at the original destination",mac,async()=>{
 const f=await fixture();try{
  const opened=f.group(f.state.lease!.owner),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:{...clean,pendingKeys:1}});
  assert.equal(f.state.lease!.tainted,true);const before=f.state;await assert.rejects(f.resolve(f.proof(opened)),/unknown cleanup/);assert.deepEqual(await f.sync(),before);
 }finally{await f.close();}
});

test("adding a UI sender after an earlier file command began is refused",mac,async()=>{
 const f=await fixture();try{
  // Retire the unused first lease, then start a file-only lease in the same store.
  await f.seal();await f.finish();await f.call({op:"acquire",revision:f.state.revision,leaseId:randomUUID()});
  await f.call({op:"register",revision:f.state.revision,senderId:f.senderId,senderPid:process.pid,senderKind:"file_only"});
  const ticket=await f.stage();await f.call({op:"begin",...ticket,openObligations:[]});await f.call({op:"receipt",...ticket,receipt:clean});const w=await f.addWorker();
  await assert.rejects(f.call({op:"register",revision:f.state.revision,senderId:randomUUID(),senderPid:w.birth.pid,senderKind:"ui_input"}),/before any input/);await f.seal();await f.finish();
 }finally{await f.close();}
});

test("the actual owner cannot finalize focus on behalf of its separate live UI sender",mac,async()=>{
 const f=await fixture();try{
  await f.seal();await f.finish();await f.call({op:"acquire",revision:f.state.revision,leaseId:randomUUID()});const ui=await f.addWorker(),senderId=randomUUID();
  await f.call({op:"register",revision:f.state.revision,senderId,senderPid:ui.birth.pid,senderKind:"ui_input"});
  const opened=f.group(f.state.lease!.owner);assert.equal(opened[0]!.kind,"focus");opened[0]!.focusBaseline.uiSender=ui.birth;
  const address=processAddress(f.state.lease!.owner,"file_probe"),ticket={...fields(f.state),commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address};
  await f.call({op:"stage",revision:f.state.revision,senderId,...ticket});await f.call({op:"permit",revision:f.state.revision,...ticket});
  await ui.worker.call({op:"begin",...ticket,openObligations:opened});await ui.worker.call({op:"receipt",...ticket,receipt:clean});await f.sync();await f.seal();
  const focusFinalization=f.proof(opened),before=f.state;await assert.rejects(f.call({op:"resolveFocus",senderId,focusFinalization}),/not original focus sender/);assert.deepEqual(await f.sync(),before);
  await ui.worker.call({op:"resolveFocus",...fields(f.state),senderId,focusFinalization});await ui.worker.call({op:"retire",...fields(f.state),senderId});await f.sync();await f.call({op:"release",revision:f.state.revision});assert.equal(f.state.lease,undefined);
 }finally{await f.close();}
});

for(const baseline of ["absent","original-ended"] as const)for(const current of ["unreadable","business-target"] as const)test(`${baseline} keyboard baseline cannot hide final ${current}`,mac,async()=>{
 const f=await fixture();try{
  const original=await f.addWorker(),opened=f.group(f.state.lease!.owner,baseline==="original-ended"?original.birth:undefined),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();
  const proof=f.proof(opened);if(baseline==="original-ended"){await original.worker.stop();proof.resolutions[1]!.reason="destination_ended";}
  proof.observation.keyboard=current==="unreadable"?{status:"unreadable",destination:null}:{status:"present",destination:{process:f.state.lease!.owner,reference:randomUUID()}};
  await f.resolve(proof);assert.equal(f.state.lease!.tainted,true);assert.ok(f.state.lease!.restorations.every(r=>r.phase==="unknown"));await assert.rejects(f.call({op:"release",revision:f.state.revision}),/cleanup remains unknown/);
 }finally{await f.close();}
});

test("known initially absent keyboard may end in an independently live unrelated destination",mac,async()=>{
 const f=await fixture();try{
  const unrelated=await f.addWorker(),opened=f.group(f.state.lease!.owner),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();const proof=f.proof(opened);proof.observation.keyboard={status:"present",destination:{process:unrelated.birth,reference:randomUUID()}};
  await f.resolve(proof);assert.equal(f.state.lease!.tainted,false);await f.finish();
 }finally{await f.close();}
});

for(const late of ["command-pending-key","command-missing","command-address","focus-failed","focus-without-permit","clipboard-failed"] as const)test(`after final focus, a late ${late} receipt retains uncertainty and the first records`,mac,async()=>{
 const f=await fixture();try{
  const opened=f.group(f.state.lease!.owner),clipboard:ClaimRestoreObligation={id:randomUUID(),kind:"clipboard",address:{schema:"mac-input-address-v1",kind:"clipboard",operation:"clip_restore",clipboard:"general"}},ticket=await f.start([...opened,clipboard]);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();
  await f.call({op:"beginRestore",restorationId:clipboard.id,address:clipboard.address});await f.call({op:"restorationReceipt",restorationId:clipboard.id,address:clipboard.address,restorationReceipt:restored});
  if(late==="focus-failed"){await f.call({op:"beginRestore",restorationId:opened[0]!.id,address:opened[0]!.address});await f.call({op:"restorationReceipt",restorationId:opened[0]!.id,address:opened[0]!.address,restorationReceipt:restored});}
  const proof=f.proof(opened);await f.resolve(proof);const before=structuredClone(f.state);
  if(late.startsWith("command"))await f.call({op:"receipt",...ticket,address:late==="command-address"?undefined:ticket.address,receipt:late==="command-missing"?undefined:{...clean,pendingKeys:1,failed:true}});
  else {const obligation=late==="clipboard-failed"?clipboard:opened[0]!;await f.call({op:"restorationReceipt",restorationId:obligation.id,address:obligation.address,restorationReceipt:late==="focus-without-permit"?restored:{...restored,failed:true}});}
  assert.equal(f.state.lease!.tainted,true);assert.deepEqual(f.state.lease!.focusFinalization,proof);assert.deepEqual(f.state.lease!.commands[0]!.receipt,before.lease!.commands[0]!.receipt);
  assert.ok(f.state.lease!.restorations.filter(r=>r.obligation.kind==="focus").every(r=>r.phase==="unknown"));await assert.rejects(f.resolve(proof),/unknown cleanup/);await assert.rejects(f.call({op:"release",revision:f.state.revision}),/cleanup remains unknown/);
  await f.call({op:"receipt",...ticket,receipt:clean});assert.equal(f.state.lease!.tainted,true);await assert.rejects(f.call({op:"retire",senderId:f.senderId}),/pending restorations/);
 }finally{await f.close();}
});

test("a late live AX sender receipt cannot disappear after the UI sender already retired",mac,async()=>{
 const f=await fixture();try{
  const ax=await f.addWorker(),axId=randomUUID();await f.call({op:"register",revision:f.state.revision,senderId:axId,senderPid:ax.birth.pid,senderKind:"node_ax"});
  const opened=f.group(f.state.lease!.owner),ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});
  const address=processAddress(ax.birth,"file_ax"),other={...fields(f.state),commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address};await f.call({op:"stage",revision:f.state.revision,senderId:axId,...other});await f.call({op:"permit",revision:f.state.revision,...other});
  await ax.worker.call({op:"begin",...other,openObligations:[]});await ax.worker.call({op:"receipt",...other,receipt:clean});await f.sync();await f.seal();await f.resolve(f.proof(opened));await f.call({op:"retire",senderId:f.senderId});
  await ax.worker.call({op:"receipt",...other,receipt:{...clean,pendingKeys:1,failed:true}});await f.sync();assert.equal(f.state.lease!.tainted,true);assert.equal(f.state.lease!.senders.find(s=>s.id===f.senderId)!.retired,true);assert.equal(f.state.lease!.restorations[0]!.phase,"unknown");await assert.rejects(f.call({op:"release",revision:f.state.revision}),/cleanup remains unknown/);
 }finally{await f.close();}
});

for(const ended of ["front","keyboard"] as const)for(const order of ["front-first","keyboard-first"] as const)test(`a dead original ${ended} cannot block restoring the other focus resource (${order})`,mac,async()=>{
 const f=await fixture();try{
  const dead=await f.addWorker(),unrelated=await f.addWorker(),opened=f.group(ended==="front"?dead.birth:f.state.lease!.owner,ended==="keyboard"?dead.birth:f.state.lease!.owner);if(order==="keyboard-first")opened.reverse();
  const ticket=await f.start(opened);await f.call({op:"receipt",...ticket,receipt:clean});await f.seal();await dead.worker.stop();
  const live=opened.find(o=>o.focusBaseline?.resource===(ended==="keyboard"?"frontmost_application":"keyboard_focus"))!;
  await f.call({op:"beginRestore",restorationId:live.id,address:live.address});await f.call({op:"restorationReceipt",restorationId:live.id,address:live.address,restorationReceipt:restored});
  const proof=f.proof(opened);proof.resolutions.find(r=>r.restorationId!==live.id)!.reason="destination_ended";
  if(ended==="front")proof.observation.front={process:unrelated.birth,reference:randomUUID()};else proof.observation.keyboard={status:"absent",destination:null};
  await f.resolve(proof);assert.equal(f.state.lease!.tainted,false);assert.ok(f.state.lease!.restorations.every(r=>r.phase==="resolved"));await f.finish();
 }finally{await f.close();}
});
