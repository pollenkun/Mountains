import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AccountCreationJournal,createAccountFingerprintKey,recoverAccountCreations} from './acceptance/account-journal.ts';
import {runContainerCreationProtocol,createReminderContainer,type ContainerControllerOptions} from './acceptance/container-controller.ts';
import {parseContainerOutcome} from './acceptance/container-outcome.ts';
import type {AccountInventory,AccountRecord} from './acceptance/account-proofs.ts';
import type {WriterProcessIdentity} from './acceptance/process-identity.ts';

const created:AccountRecord={id:'new-container-id',sourceId:'local-source',parentId:null,kind:'container',fingerprint:'a'.repeat(64)};
const fakeBirth=(pid:number):WriterProcessIdentity=>({schema:'macos-kinfo-starttime-v1',pid,bootId:'01234567-89ab-cdef-0123-456789abcdef',startSeconds:'1000000000',startMicroseconds:123456});
function fixture(mode='normal'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-container-protocol-'))),workspace=join(root,'workspace'),directory=join(root,'controller-private'),binary=join(root,'fake-writer'),store=join(directory,'fake-store.json');
 mkdirSync(workspace,{mode:0o700});mkdirSync(directory,{mode:0o700});const key=createAccountFingerprintKey(directory,workspace),runId=randomUUID(),faultReplyLog=join(directory,'fault-replies.jsonl');
 const before:AccountInventory={kind:'reminders',authorization:'full',coverage:'all-objects',complete:true,fieldScope:'EventKit-public-reminder-v1',sources:[{id:'local-source',storage:'local',proof:'EventKit.sourceType'},{id:'cloud-source',storage:'remote',proof:'EventKit.sourceType'}],records:[{id:'original-list',sourceId:'cloud-source',parentId:null,kind:'container',fingerprint:'e'.repeat(64)},{id:'original-item',sourceId:'cloud-source',parentId:'original-list',kind:'object',fingerprint:'f'.repeat(64)}]};
 const identity={runId,sourceId:'local-source',workspace,originalIds:before.records.map(item=>item.id),fingerprintKeySha256:key.sha256},journal=AccountCreationJournal.create(directory,identity);
 const currentOriginals=structuredClone(before.records);
 const code=`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const mode=${JSON.stringify(mode)},store=${JSON.stringify(store)},created=${JSON.stringify(created)};
if(mode==='exit-before-input')process.exit(0);
const rl=readline.createInterface({input:process.stdin}),iterator=rl[Symbol.asyncIterator]();
const input=await iterator.next();if(input.done)process.exit(1);const request=JSON.parse(input.value);
if(process.argv.length!==2||Buffer.from(request.key,'base64').length!==32)process.exit(1);
const birthLog=fs.readFileSync(${JSON.stringify(journal.file)},'utf8').trim().split('\\n').map(JSON.parse),birth=birthLog.at(-1);
const birthHeads=fs.readFileSync(${JSON.stringify(join(directory,'account-creations.head.jsonl'))},'utf8').trim().split('\\n').map(JSON.parse);
if(birth.payload.kind!=='writer-bound'||birth.payload.nonce!==request.nonce||birth.payload.writer.pid!==process.pid||birthHeads.at(-1).sha256!==birth.sha256)process.exit(4);
const base={version:1,runId:request.runId,nonce:request.nonce},append=value=>{fs.writeSync(3,JSON.stringify(value)+'\\n');fs.fsyncSync(3);},emit=value=>new Promise(resolve=>process.stdout.write(JSON.stringify(value)+'\\n',resolve));
const emitFault=async value=>{
 await emit(value);
 const fd=fs.openSync(${JSON.stringify(faultReplyLog)},'a',0o600);
 try{fs.writeSync(fd,JSON.stringify({mode,kind:value.kind,nonceMatches:value.nonce===request.nonce,idMatches:value.record.id===created.id})+'\\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
};
if(mode==='stuck-before'){setInterval(()=>{},1000);await new Promise(()=>{});}
const staged={...base,kind:'prepared',record:created};if(mode!=='pipe-only')append(staged);
if(mode==='unsolicited-unknown'){append({...base,kind:'commit-started',record:created});fs.writeFileSync(store,JSON.stringify(created),{mode:0o600});append({version:1,kind:'unknown',phase:'commit-started'});await emit(staged);process.exit(0);}
await emit(mode==='bad-nonce'?{...staged,nonce:'00000000-0000-0000-0000-000000000000'}:staged);
const command=await iterator.next();if(command.done){append({version:1,kind:'not-committed',phase:'prepared'});process.exit(0);}
const parsed=JSON.parse(command.value);if(parsed.action!=='commit'||parsed.nonce!==request.nonce)process.exit(2);
const heads=fs.readFileSync(${JSON.stringify(join(directory,'account-creations.head.jsonl'))},'utf8').trim().split('\\n').map(JSON.parse);
const log=fs.readFileSync(${JSON.stringify(journal.file)},'utf8').trim().split('\\n').map(JSON.parse);
if(log.at(-1).payload.kind!=='commit-granted'||heads.at(-1).sha256!==log.at(-1).sha256)process.exit(3);
append({...base,kind:'commit-started',record:created});
if(mode==='stuck-after'){setInterval(()=>{},1000);await new Promise(()=>{});}
const actual=mode==='changed-id'?{...created,id:'unexpected-new-id'}:created;fs.writeFileSync(store,JSON.stringify(actual),{mode:0o600});
if(mode==='slow-commit')await new Promise(resolve=>setTimeout(resolve,150));
const committed={...base,kind:'committed',preparedId:created.id,record:actual};append(committed);
if(mode==='extra-terminal')append({version:1,kind:'unknown',phase:'committed'});
if(mode==='changed-id'||mode==='extra-terminal')await emitFault(committed);
else if(mode==='bad-full-nonce')await emitFault({...committed,nonce:'00000000-0000-0000-0000-000000000000'});
else if(mode==='bad-full-id')await emitFault({...committed,record:{...actual,id:'different-pipe-id'}});
else if(mode==='extra-reply'){await emitFault(committed);await emitFault(committed);}
else if(mode!=='lost-reply')await emit(committed);
rl.close();process.stdin.destroy();process.exit(0);
`;
 writeFileSync(binary,code,{mode:0o700});
 const inventory=():AccountInventory=>({...structuredClone(before),records:[...structuredClone(currentOriginals),...(existsSync(store)?[JSON.parse(readFileSync(store,'utf8')) as AccountRecord]:[])]});
 const options:ContainerControllerOptions={binary:{path:binary,sha256:createHash('sha256').update(code).digest('hex')},journal,before,workspace,runId,sourceId:'local-source',title:'M20-'+runId.slice(0,8)+' test list',key:key.key,reader:{inventory:async()=>inventory(),read:async id=>existsSync(store)&&JSON.parse(readFileSync(store,'utf8')).id===id?JSON.parse(readFileSync(store,'utf8')) as AccountRecord:null},processes:{read:async pid=>({status:'alive',identity:fakeBirth(pid)})},timeoutMs:2000};
 return{root,directory,store,faultReplyLog,before,currentOriginals,identity,journal,options,cleanup:()=>{journal.close();rmSync(root,{recursive:true,force:true});}};
}
const noWindows={skip:process.platform==='win32'};
test('actual fake-writer pipes require durable grants and exact independent readback',noWindows,async()=>{
 const f=fixture();try{const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'confirmed',JSON.stringify(result));assert.equal(result.failure,undefined);assert.equal(result.usedRecovery,false);assert.deepEqual(result.record,created);
 const recovered=recoverAccountCreations(f.journal.file,f.identity).candidates[0]!;assert.equal(recovered.outcome,'committed');assert.equal(recovered.attempt!.nonce,result.attempt!.nonce);assert.equal(recovered.attempt!.writerSha256,f.options.binary.sha256);assert.match(recovered.attempt!.requestSha256,/^[0-9a-f]{64}$/);
 }finally{f.cleanup();}
});
test('a lost pipe reply only provides a cleanup receipt and fails the task',noWindows,async()=>{
 const f=fixture('lost-reply');try{const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'failed');assert.equal(result.usedRecovery,true);assert.equal(result.failure,'missing-commit-reply');assert.equal(result.record,undefined);assert.deepEqual(result.cleanupRecord,created);}finally{f.cleanup();}
});
test('unrecorded preparation and an old nonce never send COMMIT',noWindows,async()=>{
 for(const mode of ['pipe-only','bad-nonce']){const f=fixture(mode);try{const result=await runContainerCreationProtocol(f.options);assert.notEqual(result.outcome,'confirmed');assert.equal(existsSync(f.store),false);assert.deepEqual(recoverAccountCreations(f.journal.file,f.identity).candidates,[]);}finally{f.cleanup();}}
});
test('closed or mismatched journals refuse before allowing a database write',noWindows,async()=>{
 const f=fixture();try{f.journal.close();const result=await runContainerCreationProtocol(f.options);assert.notEqual(result.outcome,'confirmed');assert.equal(existsSync(f.store),false);}finally{f.cleanup();}
 const g=fixture();try{g.options.runId=randomUUID();const result=await runContainerCreationProtocol(g.options);assert.equal(result.outcome,'refused');assert.equal(existsSync(g.store),false);}finally{g.cleanup();}
});
test('cancellation after a durable grant but before write prevents COMMIT',noWindows,async()=>{
 const f=fixture(),controller=new AbortController(),allow=f.journal.allowCommit.bind(f.journal);f.options.signal=controller.signal;
 f.journal.allowCommit=id=>{allow(id);controller.abort();};
 try{const result=await runContainerCreationProtocol(f.options);assert.equal(result.cancelled,true);assert.notEqual(result.outcome,'confirmed');assert.equal(existsSync(f.store),false);}finally{f.cleanup();}
});
test('cancellation after COMMIT waits for the writer and returns a receipt with an uncancelled read signal',noWindows,async()=>{
 const f=fixture('slow-commit'),controller=new AbortController();f.options.signal=controller.signal;let afterSignal:AbortSignal|undefined;
 const read=f.options.reader.read;f.options.reader.read=async(id,signal)=>{afterSignal=signal;return read(id,signal);};
 const interval=setInterval(()=>{if(existsSync(f.store))controller.abort();},5);
 try{const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'failed');assert.deepEqual(result.cleanupRecord,created);assert.equal(result.record,undefined);assert.equal(result.cancelled,true);assert.equal(result.failure,'cancelled');assert.equal(result.usedRecovery,false);assert.equal(afterSignal!.aborted,false);}finally{clearInterval(interval);f.cleanup();}
});
test('a deadline before preparation cannot write and one after COMMIT remains unknown',noWindows,async()=>{
 for(const mode of ['stuck-before','stuck-after']){const f=fixture(mode);f.options.timeoutMs=mode==='stuck-before'?250:5000;try{const result=await runContainerCreationProtocol(f.options);assert.notEqual(result.outcome,'confirmed');assert.equal(result.failure,'writer-timeout');assert.equal(existsSync(f.store),false);if(mode==='stuck-after'){
  // This must actually reach the post-COMMIT phase, rather than timing out
  // during process startup and accidentally testing the pre-input case twice.
  const records=readFileSync(join(f.directory,`container-${result.attempt!.nonce}.outcome.jsonl`),'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(records.at(-1).kind,'commit-started');
  assert.equal(result.outcome,'unknown');assert.equal(recoverAccountCreations(f.journal.file,f.identity).candidates[0]!.outcome,'unknown');
 }}finally{f.cleanup();}}
});
test('changed committed IDs and additional terminal rows cannot authorize cleanup receipts',noWindows,async()=>{
 for(const mode of ['changed-id','extra-terminal']){const f=fixture(mode);try{
  // This checks a delivered invalid outcome, not process startup speed. Use
  // the unchanged product default and prove the intended fault reached disk.
  delete f.options.timeoutMs;
  const result=await runContainerCreationProtocol(f.options);
  assert.equal(existsSync(f.faultReplyLog),true,'intended invalid outcome never arrived: '+JSON.stringify({mode,result}));
  assert.deepEqual(readFileSync(f.faultReplyLog,'utf8').trim().split('\n').map(line=>JSON.parse(line)),[{mode,kind:'committed',nonceMatches:true,idMatches:mode!=='changed-id'}]);
  assert.deepEqual(JSON.parse(readFileSync(f.store,'utf8')),mode==='changed-id'?{...created,id:'unexpected-new-id'}:created);
  assert.equal(result.outcome,'unknown');assert.equal(result.record,undefined);assert.equal(result.cleanupRecord,undefined);assert.equal(recoverAccountCreations(f.journal.file,f.identity).candidates[0]!.outcome,'unknown');
 }finally{f.cleanup();}}
});
test('a provider cannot rewrite the original snapshot through a reused object during receipt readback',noWindows,async()=>{
 const f=fixture(),read=f.options.reader.read;
 f.options.reader.read=async(id,signal)=>{f.before.records[1]!.fingerprint='b'.repeat(64);f.currentOriginals[1]!.fingerprint='b'.repeat(64);return read(id,signal);};
 try{const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'failed');assert.deepEqual(result.cleanupRecord,created);assert.equal(result.record,undefined);}finally{f.cleanup();}
});
test('complete wrong replies fail instead of being treated as a lost reply fallback',noWindows,async()=>{
 for(const mode of ['bad-full-nonce','bad-full-id','extra-reply']){const f=fixture(mode);try{
  // This is a bad-reply protocol case, not a startup-speed case. Use the
  // product's existing default deadline; dedicated deadline tests keep their
  // 250/5000ms limits. Require independent proof the fault actually happened.
  delete f.options.timeoutMs;
  const result=await runContainerCreationProtocol(f.options);
  assert.equal(existsSync(f.faultReplyLog),true,'fixture did not send the intended bad reply: '+JSON.stringify({mode,result}));
  const receipts=readFileSync(f.faultReplyLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(receipts,Array.from({length:mode==='extra-reply'?2:1},()=>({mode,kind:'committed',nonceMatches:mode!=='bad-full-nonce',idMatches:mode!=='bad-full-id'})));
  assert.deepEqual(JSON.parse(readFileSync(f.store,'utf8')),created);
  assert.equal(result.outcome,'failed');assert.equal(result.record,undefined);assert.deepEqual(result.cleanupRecord,created);assert.equal(result.usedRecovery,false);assert.equal(result.failure,'invalid-commit-reply');
 }finally{f.cleanup();}}
});
test('native unknown before any parent COMMIT stays unknown and its attempt remains registered',noWindows,async()=>{
 const f=fixture('unsolicited-unknown');try{
  // Preserve the pre-COMMIT unknown fault; don't accidentally test only a
  // slow startup that was killed before receiving the initial request.
  delete f.options.timeoutMs;
  const result=await runContainerCreationProtocol(f.options);
  // The fault is the unsolicited durable write, not a later stdout log.
  // Correct early termination may prevent any work after emitting PREPARED.
  const outcomes=readFileSync(join(f.directory,`container-${result.attempt!.nonce}.outcome.jsonl`),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(outcomes.map(row=>row.kind),['prepared','commit-started','unknown']);
  for(const row of outcomes.slice(0,2)){assert.equal(row.nonce,result.attempt!.nonce);assert.equal(row.runId,f.options.runId);assert.deepEqual(row.record,created);}
  assert.deepEqual(outcomes[2],{version:1,kind:'unknown',phase:'commit-started'});
  assert.deepEqual(JSON.parse(readFileSync(f.store,'utf8')),created);
  assert.equal(readFileSync(f.journal.file,'utf8').trim().split('\n').map(line=>JSON.parse(line)).some(row=>row.payload.kind==='commit-granted'),false);assert.equal(result.outcome,'unknown');assert.equal(result.record,undefined);assert.equal(result.cleanupRecord,undefined);assert.equal(existsSync(f.store),true);
  const recovery=recoverAccountCreations(f.journal.file,f.identity);assert.equal(recovery.needsIndependentReconciliation,true);assert.equal(recovery.attempts.length,1);assert.equal(recovery.attempts[0]!.nonce,result.attempt!.nonce);
 }finally{f.cleanup();}
});
test('a read provider returning after its deadline never confirms an input, even if it ignores cancellation',noWindows,async()=>{
 for(const slow of ['exact','inventory']){const f=fixture();f.options.settleTimeoutMs=25;
  const read=f.options.reader.read,inventory=f.options.reader.inventory;let expired=false;
  if(slow==='exact')f.options.reader.read=async(id,signal)=>{await new Promise(resolve=>setTimeout(resolve,80));expired=signal!.aborted;return read(id,signal);};
  else f.options.reader.inventory=async signal=>{if(signal){await new Promise(resolve=>setTimeout(resolve,80));expired=signal.aborted;}return inventory(signal);};
  try{const result=await runContainerCreationProtocol(f.options);assert.equal(expired,true);assert.equal(result.outcome,slow==='exact'?'unknown':'failed');assert.equal(result.record,undefined);if(slow==='inventory')assert.deepEqual(result.cleanupRecord,created);assert.equal(recoverAccountCreations(f.journal.file,f.identity).candidates[0]!.outcome,'unknown');}finally{f.cleanup();}
 }
});
test('production account creation still stops at the safety gate before launching anything',noWindows,async()=>{
 const f=fixture();try{await assert.rejects(createReminderContainer({...f.options,processProbe:f.options.binary}),/entry points are disabled/);assert.equal(existsSync(f.store),false);assert.equal(recoverAccountCreations(f.journal.file,f.identity).candidates.length,0);}finally{f.cleanup();}
});
test('native outcome parsing rejects incomplete, replayed, reordered and privacy-bearing evidence',()=>{
 const expected={runId:randomUUID(),nonce:randomUUID(),sourceId:'local-source'},prepared={version:1,...expected,kind:'prepared',record:created};delete (prepared as Record<string,unknown>).sourceId;
 const start={...prepared,kind:'commit-started'},committed={...prepared,kind:'committed',preparedId:created.id};
 const bytes=[prepared,start,committed].map(value=>JSON.stringify(value)+'\n');assert.equal(parseContainerOutcome(bytes.join(''),expected).state,'committed');
 for(const input of [bytes[0]!.slice(0,-1),bytes[2]!,bytes[0]!+bytes[2]!,bytes.join('')+bytes[2]!,JSON.stringify({...prepared,nonce:randomUUID()})+'\n',JSON.stringify({...prepared,private:'PRIVATE-PROBE-CONTENT'})+'\n']){
  try{parseContainerOutcome(input,expected);assert.fail('invalid evidence was accepted');}catch(error){assert.equal(String(error),'Error: Native container outcome is invalid or incomplete; commit status remains unknown');}
 }
});
test('a synchronous reader cannot hide an expired deadline by blocking timer delivery',noWindows,async()=>{
 const f=fixture();f.options.settleTimeoutMs=20;const read=f.options.reader.read;
 f.options.reader.read=async(id,signal)=>{const end=performance.now()+60;while(performance.now()<end){}return read(id,signal);};
 try{const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'unknown');assert.equal(result.record,undefined);}finally{f.cleanup();}
});
test('missing, malformed and wrong-PID OS observations never send even the initial account request',noWindows,async()=>{
 for(const mode of ['absent','unknown','wrong-pid','malformed']){
  const f=fixture();f.options.processes.read=async pid=>mode==='absent'?{status:'absent'}:mode==='unknown'?{status:'unknown',reason:'process-query-failed'}:{status:'alive',identity:mode==='wrong-pid'?fakeBirth(pid+1):{...fakeBirth(pid),startMicroseconds:-1}};
  try{
   const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'not-committed');assert.equal(result.record,undefined);assert.equal(existsSync(f.store),false);
   const evidence=readFileSync(join(f.directory,`container-${result.attempt!.nonce}.outcome.jsonl`),'utf8');assert.equal(evidence,'');
   const recovered=recoverAccountCreations(f.journal.file,f.identity);assert.equal(recovered.attempts.length,1);assert.equal(recovered.attempts[0]!.writer,undefined);assert.deepEqual(recovered.candidates,[]);
  }finally{f.cleanup();}
 }
});
test('cancellation or writer exit during its OS identity query cannot send an initial request',noWindows,async()=>{
 for(const mode of ['cancel','exit']){
  const f=fixture(mode==='exit'?'exit-before-input':'normal'),controller=new AbortController();f.options.signal=controller.signal;
  f.options.processes.read=async(pid,signal)=>{
   if(mode==='cancel')controller.abort();
   if(!signal!.aborted)await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));
   assert.equal(signal!.aborted,true);return{status:'alive',identity:fakeBirth(pid)};
  };
  try{const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'not-committed');assert.equal(result.cancelled,mode==='cancel');assert.equal(existsSync(f.store),false);assert.equal(recoverAccountCreations(f.journal.file,f.identity).attempts[0]!.writer,undefined);}finally{f.cleanup();}
 }
});
test('a provider cannot replace the durably bound writer identity after returning it',noWindows,async()=>{
 const f=fixture();let identity:WriterProcessIdentity|undefined;const read=f.options.reader.read;
 f.options.processes.read=async pid=>{identity=fakeBirth(pid);return{status:'alive',identity};};
 f.options.reader.read=async(id,signal)=>{identity!.startMicroseconds=654321;return read(id,signal);};
 try{
  const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'confirmed');assert.equal(result.attempt!.writer!.startMicroseconds,123456);
  result.attempt!.writer!.startMicroseconds=999999;assert.equal(recoverAccountCreations(f.journal.file,f.identity).attempts[0]!.writer!.startMicroseconds,123456);
 }finally{f.cleanup();}
});
test('late OS identity queries and failed durable binding never send a request containing the key',noWindows,async()=>{
 for(const mode of ['late','blocked-timer','journal-closed']){
  const f=fixture();if(mode!=='journal-closed')f.options.timeoutMs=25;
  f.options.processes.read=async pid=>{
   if(mode==='late')await new Promise(resolve=>setTimeout(resolve,80));
   else if(mode==='blocked-timer'){const end=performance.now()+80;while(performance.now()<end){}}
   else f.journal.close();
   return{status:'alive',identity:fakeBirth(pid)};
  };
  try{
   const result=await runContainerCreationProtocol(f.options);assert.equal(result.outcome,'not-committed');assert.equal(existsSync(f.store),false);
   assert.equal(readFileSync(join(f.directory,`container-${result.attempt!.nonce}.outcome.jsonl`),'utf8'),'');
   assert.equal(recoverAccountCreations(f.journal.file,f.identity).attempts[0]!.writer,undefined);
  }finally{f.cleanup();}
 }
});
