import assert from 'node:assert/strict';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,readFileSync,readSync,fsyncSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {AccountCreationJournal} from './account-journal.ts';
import {OwnedAccountObjects,type AccountInventory,type AccountRecord} from './account-proofs.ts';
import {containerRecord,parseContainerOutcome,type ContainerAttempt,type ContainerOutcome} from './container-outcome.ts';
import {requireRealMachineAcceptanceSafety} from './safety-gate.ts';
import {readWriterProcess,writerProcessIdentity,type ProcessObservation} from './process-identity.ts';

export interface ContainerControllerOptions{
 binary:{path:string;sha256:string};journal:AccountCreationJournal;
 before:AccountInventory;workspace:string;runId:string;sourceId:string;title:string;key:Uint8Array;
 reader:{inventory(signal?:AbortSignal):Promise<AccountInventory>;read(id:string,signal?:AbortSignal):Promise<AccountRecord|null>};
 /** Internal tests can supply OS observations. The gated production wrapper
  * always uses the frozen OS-only helper, never a caller's status callback. */
 processes:{read(pid:number,signal?:AbortSignal):Promise<ProcessObservation>};
 signal?:AbortSignal;timeoutMs?:number;settleTimeoutMs?:number;
}
export type NativeContainerControllerOptions=Omit<ContainerControllerOptions,'processes'>&{processProbe:{path:string;sha256:string}};
export interface ContainerCreationResult{
 outcome:'refused'|'not-committed'|'unknown'|'confirmed'|'failed';
 /** A confirmed write is a cleanup receipt, not a test verdict. Cancellation,
  * a missing reply or any failure must still fail the corresponding task. */
 record?:AccountRecord;cleanupRecord?:AccountRecord;prepared?:AccountRecord;attempt?:ContainerAttempt;requestId?:string;
 cancelled:boolean;usedRecovery:boolean;failure?:string;
}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function readOutcome(fd:number,path:string,attempt:ContainerAttempt,expected:{runId:string;nonce:string;sourceId:string}):ContainerOutcome{
 const before=fstatSync(fd,{bigint:true}),current=lstatSync(path,{bigint:true});
 assert.ok(current.isFile()&&!current.isSymbolicLink()&&before.dev===current.dev&&before.ino===current.ino);
 assert.equal(String(before.dev),attempt.outcomeDevice);assert.equal(String(before.ino),attempt.outcomeInode);
 assert.ok(before.nlink===1n&&(before.mode&0o077n)===0n&&(!process.getuid||before.uid===BigInt(process.getuid()))&&before.size<=65_536n);
 const buffer=Buffer.alloc(65_537);let offset=0;
 for(;;){const length=readSync(fd,buffer,offset,buffer.length-offset,offset);if(!length)break;offset+=length;assert.ok(offset<=65_536);}
 assert.equal(fstatSync(fd,{bigint:true}).size,before.size,'native outcome changed while being read');
 return parseContainerOutcome(buffer.subarray(0,offset).toString('utf8'),expected);
}
function reply(bytes:string,expected:{runId:string;nonce:string;sourceId:string}):ContainerOutcome{
 assert.ok(bytes.endsWith('\n'));const rows=bytes.slice(0,-1).split('\n');assert.ok(rows.length===1||rows.length===2);
 const first=JSON.parse(rows[0]!) as Record<string,unknown>;assert.equal(first.kind,'prepared');
 const prepared=parseContainerOutcome(rows[0]+'\n',expected);
 if(rows.length===1)return prepared;
 // stdout only replies PREPARED/COMMITTED. The actual started record must
 // independently exist in fd 3; this synthetic row only validates wire shape.
 const started={...first,kind:'commit-started'};
 return parseContainerOutcome(rows[0]+'\n'+JSON.stringify(started)+'\n'+rows[1]+'\n',expected);
}

/** Production preparation entry stays disabled until all account protections
 * have been independently reviewed. There is no environment/diagnostic bypass. */
export async function createReminderContainer(options:NativeContainerControllerOptions):Promise<ContainerCreationResult>{
 requireRealMachineAcceptanceSafety();
 const probe={...options.processProbe};return runContainerCreationProtocol({...options,processes:{read:(pid,signal)=>readWriterProcess(probe,pid,signal)}});
}

/** Internal protocol harness. Unit tests supply a newly written Node fake
 * executable and an in-memory store. Do not call with the EventKit writer while
 * the real-machine safety gate remains closed. This function is not a model tool. */
export async function runContainerCreationProtocol(options:ContainerControllerOptions):Promise<ContainerCreationResult>{
 // The provider may reuse/mutate its objects between reads. Preserve the
 // original evidence and key before any callback or await can change them.
 options={...options,binary:{...options.binary},before:structuredClone(options.before),key:Uint8Array.from(options.key),processes:{...options.processes}};
 let child:ChildProcessWithoutNullStreams|undefined,closed:Promise<void>|undefined,didClose=false,outcomeFd:number|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined,commitMayHaveBeenSent=false,grantRecorded=false,stdout='',failure:string|undefined,exitCode:number|null=null;
 let requestId:string|undefined,attempt:ContainerAttempt|undefined,prepared:AccountRecord|undefined;
 let verifiedForCleanup:AccountRecord|undefined,recoveredReply=false;
 let closeInput=()=>{},removeAbort=()=>{};
 const nonce=randomUUID(),directory=dirname(options.journal.file),outcomePath=join(directory,`container-${nonce}.outcome.jsonl`);
 const expected={runId:options.runId,nonce,sourceId:options.sourceId};
 const result=(outcome:ContainerCreationResult['outcome'],extra:Partial<ContainerCreationResult>={}):ContainerCreationResult=>({
  outcome,cancelled:options.signal?.aborted===true,usedRecovery:false,...(failure?{failure}:{}),...(prepared?{prepared:{...prepared}}:{}),...(attempt?{attempt:structuredClone(attempt)}:{}),...(requestId?{requestId}:{}),...extra
 });
 try{
  const before=structuredClone(options.before),guard=new OwnedAccountObjects(before,options.sourceId);
  assert.ok(Number.isFinite(options.timeoutMs??35_000)&&(options.timeoutMs??35_000)>0&&(options.timeoutMs??35_000)<=35_000);
  assert.ok(Number.isFinite(options.settleTimeoutMs??10_000)&&(options.settleTimeoutMs??10_000)>0&&(options.settleTimeoutMs??10_000)<=10_000);
  assert.equal(before.kind,'reminders');assert.match(options.runId,/^[0-9a-f-]{36}$/i);
  assert.ok(options.title.startsWith('M20-'+options.runId.slice(0,8))&&Buffer.byteLength(options.title)<=256);assert.equal(options.key.byteLength,32);
  options.journal.assertContext({runId:options.runId,sourceId:options.sourceId,workspace:options.workspace,originalIds:before.records.map(item=>item.id),fingerprintKeySha256:sha(options.key)});
  options.signal?.throwIfAborted();guard.assertUnchangedOriginals(await options.reader.inventory(options.signal));options.signal?.throwIfAborted();
  const path=options.binary.path;assert.ok(isAbsolute(path)&&realpathSync(path)===path&&lstatSync(path).isFile());assert.equal(sha(readFileSync(path)),options.binary.sha256);
  const request={version:1,runId:options.runId,nonce,sourceId:options.sourceId,title:options.title,key:Buffer.from(options.key).toString('base64')};
  const wire=JSON.stringify(request)+'\n';assert.ok(Buffer.byteLength(wire)<=8193);
  outcomeFd=openSync(outcomePath,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
  const identity=fstatSync(outcomeFd,{bigint:true});assert.ok(identity.isFile()&&identity.nlink===1n&&identity.size===0n);
  fsyncSync(outcomeFd);const parent=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}
  attempt={nonce,writerPath:path,writerSha256:options.binary.sha256,requestSha256:sha(wire),outcomeDevice:String(identity.dev),outcomeInode:String(identity.ino)};
  options.journal.registerAttempt(attempt);
  let resolveReady!:(line:string)=>void,rejectReady!:(error:Error)=>void,readyDone=false;
  const ready=new Promise<string>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});void ready.catch(()=>{});
  child=spawn(path,[],{stdio:['pipe','pipe','pipe',outcomeFd]}) as ChildProcessWithoutNullStreams;
  const ownChild=child,writerLifetime=new AbortController();
  closeInput=()=>{try{ownChild.stdin.end();}catch{}};
  const stop=()=>{closeInput();if(!commitMayHaveBeenSent&&!didClose)ownChild.kill('SIGKILL');};
  const abort=()=>{failure??='cancelled';stop();};options.signal?.addEventListener('abort',abort,{once:true});removeAbort=()=>options.signal?.removeEventListener('abort',abort);
  closed=new Promise<void>(resolve=>{
   ownChild.once('error',()=>{failure??='writer-start-failed';rejectReady(new Error('native writer failed to start'));});
   ownChild.once('close',code=>{didClose=true;exitCode=code;writerLifetime.abort();if(!readyDone)rejectReady(new Error('native writer ended before preparation'));resolve();});
  });
  ownChild.stderr.resume();ownChild.stdout.setEncoding('utf8');
  ownChild.stdout.on('data',(part:string)=>{
   if(Buffer.byteLength(stdout)+Buffer.byteLength(part)>65_536){failure??='writer-output-limit';stop();rejectReady(new Error('native writer output exceeded its bound'));return;}
   stdout+=part;
   if(!readyDone&&stdout.includes('\n')){readyDone=true;resolveReady(stdout.slice(0,stdout.indexOf('\n')));}
  });
  ownChild.stdin.on('error',()=>{failure??='writer-pipe-error';rejectReady(new Error('native writer pipe failed'));});
  timer=setTimeout(()=>{failure??='writer-timeout';writerLifetime.abort();ownChild.kill('SIGKILL');rejectReady(new Error('native writer deadline'));},options.timeoutMs??35_000);
  // The child is still waiting for its initial request and has no key or
  // account instructions. Bind its independently observed OS birth to disk
  // before allowing even preparation, not merely before COMMIT.
  options.signal?.throwIfAborted();assert.ok(ownChild.pid);
  const identifyStart=performance.now(),identifyLimit=Math.min(3000,options.timeoutMs??35_000);
  const identifySignal=AbortSignal.any([writerLifetime.signal,AbortSignal.timeout(identifyLimit),...(options.signal?[options.signal]:[])]);
  const observation=await options.processes.read(ownChild.pid,identifySignal);
  identifySignal.throwIfAborted();assert.ok(performance.now()-identifyStart<=identifyLimit,'writer identity query exceeded its deadline');
  assert.equal(observation.status,'alive','writer OS identity is unavailable');
  assert.ok(observation.status==='alive');const writer=writerProcessIdentity(observation.identity);assert.equal(writer.pid,ownChild.pid);
  assert.ok(!didClose&&ownChild.exitCode===null&&ownChild.signalCode===null,'writer exited during its identity query');
  attempt=options.journal.bindWriter(nonce,writer);
  options.signal?.throwIfAborted();assert.ok(!didClose&&!ownChild.stdin.destroyed&&!ownChild.stdin.writableEnded);ownChild.stdin.write(wire);
  const first=await ready;
  const observed=reply(first+'\n',expected);assert.equal(observed.state,'prepared');prepared=containerRecord(observed.prepared);
  const durable=readOutcome(outcomeFd,outcomePath,attempt,expected);assert.equal(durable.state,'prepared');assert.deepEqual(durable.prepared,prepared);
  assert.equal(stdout,first+'\n','writer sent unsolicited replies');assert.equal(didClose,false);
  requestId=options.journal.stage(prepared,attempt);options.signal?.throwIfAborted();
  options.journal.allowCommit(requestId);grantRecorded=true;options.signal?.throwIfAborted();assert.equal(didClose,false);assert.ok(!ownChild.stdin.destroyed&&!ownChild.stdin.writableEnded);
  // Set before write: a failed callback does not prove the command did not
  // arrive. Every later cancellation waits for the exact writer's close.
  commitMayHaveBeenSent=true;ownChild.stdin.write(JSON.stringify({action:'commit',nonce})+'\n');
 }catch{failure??='container-protocol-refused';}
 finally{
  if(child&&!didClose){closeInput();if(!commitMayHaveBeenSent)child.kill('SIGKILL');}
  if(closed)await closed;clearTimeout(timer);removeAbort();
 }
 try{
  if(outcomeFd===undefined||!attempt)return result('refused');
  const native=readOutcome(outcomeFd,outcomePath,attempt,expected);
  if(!commitMayHaveBeenSent){
   if(native.state==='unknown'||native.state==='committed'||native.state==='commit-started')return result('unknown',{failure:failure??'unexpected-native-write-state'});
   if(requestId&&!grantRecorded)options.journal.notCommitted(requestId);
   return result('not-committed');
  }
  if(native.state!=='committed'||!native.actual||!prepared)return result('unknown',{failure:failure??'missing-native-terminal-receipt'});
  assert.deepEqual(native.prepared,prepared);assert.deepEqual(native.actual,prepared,'native ID or fields changed across commit');
  let usedRecovery=false;
  try{const received=reply(stdout,expected);assert.equal(received.state,'committed');assert.deepEqual(received.actual,native.actual);}
  catch{
   const complete=stdout.split('\n');
   // Only an absent/truncated second reply is recoverable. A complete wrong
   // nonce/ID or an extra complete reply is contradictory protocol evidence.
   usedRecovery=complete.length===2;
   failure??=usedRecovery?'missing-commit-reply':'invalid-commit-reply';
  }
  recoveredReply=usedRecovery;
  if(exitCode!==0)failure??='writer-exit-error';
  // Cancellation after COMMIT must not cancel receipt acquisition. The
  // independent reader has its own bounded lifetime, without more writes.
  const settleLimit=options.settleTimeoutMs??10_000,settleStart=performance.now(),settling=AbortSignal.timeout(settleLimit);
  const checkSettling=()=>{settling.throwIfAborted();assert.ok(performance.now()-settleStart<=settleLimit,'independent receipt acquisition exceeded its deadline');};
  const exact=await options.reader.read(native.actual.id,settling);checkSettling();
  assert.deepEqual(exact,native.actual,'independent exact-ID read did not match');
  // Later inventory/log failures must not discard this already independently
  // verified creation ID. Cleanup still rereads its fingerprint and children.
  verifiedForCleanup={...native.actual};
  const after=await options.reader.inventory(settling);checkSettling();const created=after.records.filter(item=>item.id===native.actual!.id);
  assert.deepEqual(created,[native.actual]);
  new OwnedAccountObjects(structuredClone(options.before),options.sourceId).assertUnchangedOriginals({...after,records:after.records.filter(item=>item.id!==native.actual!.id)});
  checkSettling();
  assert.ok(requestId);options.journal.committed(requestId,native.actual);
  return failure||options.signal?.aborted
   ?result('failed',{cleanupRecord:{...native.actual},usedRecovery,...(failure?{failure}:{failure:'cancelled'})})
   :result('confirmed',{record:{...native.actual},usedRecovery:false});
 }catch{return verifiedForCleanup
  ?result('failed',{cleanupRecord:verifiedForCleanup,usedRecovery:recoveredReply,failure:failure??'independent-inventory-or-journal-failed'})
  :result(commitMayHaveBeenSent?'unknown':'refused',{failure:failure??'native-receipt-or-independent-read-failed'});}
 finally{if(outcomeFd!==undefined)closeSync(outcomeFd);}
}
