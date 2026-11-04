import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,writeSync,fsyncSync,readFileSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import type {AccountRecord} from './account-proofs.ts';
import type {ContainerAttempt} from './container-outcome.ts';
import {writerProcessIdentity,type WriterProcessIdentity} from './process-identity.ts';

type Identity={runId:string;sourceId:string;workspace:string;originalIds:readonly string[];fingerprintKeySha256:string};
type Entry={sequence:number;previous:string;payload:Record<string,unknown>;sha256:string};
type Creation={requestId:string;record:AccountRecord;grant:boolean;committed:boolean;notCommitted:boolean;attempt?:ContainerAttempt};
export interface CreationRecovery{
 /** The controller log is not a cleanup verdict. Reconcile the exact native
  * outcome file and independent account reads before deciding what happened. */
 needsIndependentReconciliation:true;
 /** Includes writers which ended before the parent received a stage ID. A
  * missing grant is not proof that a faulty writer left no native evidence. */
 attempts:ContainerAttempt[];
 /** A granted write with no reply remains uncertain even when an API read
  * currently says absent: a previously sent database commit may finish late. */
 candidates:{requestId:string;record:AccountRecord;outcome:'committed'|'unknown';attempt?:ContainerAttempt}[];
}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const canonicalIds=(ids:readonly string[])=>[...ids].sort();
function record(value:unknown):AccountRecord{
 assert.ok(value&&typeof value==='object');const item=value as AccountRecord;
 assert.deepEqual(Object.keys(item).sort(),['id','sourceId','parentId','kind','fingerprint'].sort());
 assert.ok(typeof item.id==='string'&&item.id.length>0&&typeof item.sourceId==='string'&&item.sourceId.length>0);
 assert.equal(item.kind,'container','only staged local container creation is implemented');assert.equal(item.parentId,null);
 assert.ok(typeof item.fingerprint==='string'&&/^[0-9a-f]{64}$/.test(item.fingerprint));return{...item};
}
function checkFile(fd:number):void{
 const info=fstatSync(fd);assert.ok(info.isFile()&&info.nlink===1&&(info.mode&0o077)===0&&(!process.getuid||info.uid===process.getuid()),'account journal must be a private regular file with one link');
}
function privateDirectory(directory:string,workspace:string):void{
 assert.ok(isAbsolute(directory)&&realpathSync(directory)===directory,'use the exact private run directory');
 assert.ok(isAbsolute(workspace)&&realpathSync(workspace)===workspace,'use the exact frozen model workspace');
 assert.equal(directory,join(dirname(workspace),'controller-private'),'private account records must be outside the model workspace');
 assert.notEqual(directory,workspace,'private account records cannot be in the model workspace');
 const parent=lstatSync(directory);assert.ok(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o077)===0&&(!process.getuid||parent.uid===process.getuid()),'account journal directory must be private');
}
function syncDirectory(directory:string):void{
 const fd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}
}
/** The run's control directory must be outside the model's workspace. Keep the
 * same random key until every account object is resolved; a new key cannot
 * verify an old fingerprint after both the parent and helper have exited. */
export function createAccountFingerprintKey(directory:string,workspace:string):{key:Uint8Array;sha256:string}{
 privateDirectory(directory,workspace);const key=randomBytes(32);
 const fd=openSync(join(directory,'account-fingerprint.key'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{checkFile(fd);for(let offset=0;offset<key.length;){const written=writeSync(fd,key,offset,key.length-offset);assert.ok(written>0);offset+=written;}fsyncSync(fd);}finally{closeSync(fd);}
 syncDirectory(directory);return{key,sha256:hash(key)};
}
export function loadAccountFingerprintKey(directory:string,workspace:string,expectedSha256:string):Uint8Array{
 try{
  privateDirectory(directory,workspace);assert.match(expectedSha256,/^[0-9a-f]{64}$/);
  const fd=openSync(join(directory,'account-fingerprint.key'),constants.O_RDONLY|constants.O_NOFOLLOW);let key:Buffer;
  try{checkFile(fd);assert.equal(fstatSync(fd).size,32);key=readFileSync(fd);}finally{closeSync(fd);}
  assert.equal(hash(key),expectedSha256);return key;
 }catch{throw new Error('The original private account fingerprint key is unavailable or changed; no new key was substituted');}
}

/** Durable controller bookkeeping, not an anti-forgery acceptance receipt.
 * The native stage must prove the ID before allowCommit() is called. This log
 * never adopts objects by title and never decides that an unknown write failed.
 * No real-account entry point is enabled by constructing this class. */
export class AccountCreationJournal{
 private readonly fd:number;
 private readonly headFd:number;
 private readonly originalIds:Set<string>;
 private readonly sourceId:string;
 private readonly identity:Identity;
 private readonly creations=new Map<string,Creation>();
 private readonly attempts=new Map<string,ContainerAttempt>();
 private sequence=0;
 private previous='0'.repeat(64);
 private closed=false;
 private failed=false;
 readonly file:string;
 private constructor(directory:string,identity:Identity){
  privateDirectory(directory,identity.workspace);
  assert.ok(identity.runId&&identity.sourceId);assert.equal(new Set(identity.originalIds).size,identity.originalIds.length,'duplicate original ID');
  assert.match(identity.fingerprintKeySha256,/^[0-9a-f]{64}$/);
  this.originalIds=new Set(identity.originalIds);this.sourceId=identity.sourceId;this.identity={...identity,originalIds:[...identity.originalIds]};
  this.file=join(directory,'account-creations.jsonl');
  this.fd=openSync(this.file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
  let openedHead:number|undefined;
  try{
   checkFile(this.fd);
   this.headFd=openedHead=openSync(join(directory,'account-creations.head.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
   checkFile(this.headFd);
   this.append({kind:'session',version:1,runId:identity.runId,sourceId:identity.sourceId,workspace:identity.workspace,originalIds:canonicalIds(identity.originalIds),fingerprintKeySha256:identity.fingerprintKeySha256});
   // Persist the new directory entry as well as the file bytes before a helper
   // can ever receive permission to commit an account object.
   syncDirectory(directory);
  }catch(error){if(openedHead!==undefined)closeSync(openedHead);closeSync(this.fd);this.closed=true;throw error;}
 }
 static create(directory:string,identity:Identity):AccountCreationJournal{return new AccountCreationJournal(directory,identity);}
 assertContext(identity:Identity):void{assert.deepEqual({...identity,originalIds:canonicalIds(identity.originalIds)},{...this.identity,originalIds:canonicalIds(this.identity.originalIds)},'native writer does not match this frozen account journal');}
 registerAttempt(input:ContainerAttempt):void{
  const attempt=attemptIdentity(input);assert.ok(!attempt.writer,'writer birth must be bound after spawn');assert.ok(!this.attempts.has(attempt.nonce),'native attempt nonce was already registered');
  this.append({kind:'attempt-started',attempt});this.attempts.set(attempt.nonce,attempt);
 }
 bindWriter(nonce:string,input:WriterProcessIdentity):ContainerAttempt{
  const prior=this.attempts.get(nonce);assert.ok(prior&&!prior.writer,'unknown or already bound writer');
  assert.ok(![...this.creations.values()].some(value=>value.attempt?.nonce===nonce),'writer must be bound before staging');
  const writer=writerProcessIdentity(input),attempt={...prior,writer};
  this.append({kind:'writer-bound',nonce,writer});this.attempts.set(nonce,attempt);return attemptIdentity(attempt);
 }
 private append(payload:Record<string,unknown>):void{
  assert.ok(!this.closed&&!this.failed,'account creation journal is closed or uncertain');
  const sequence=this.sequence+1,body=JSON.stringify({sequence,previous:this.previous,payload}),sha256=hash(body);
  const bytes=Buffer.from(JSON.stringify({sequence,previous:this.previous,payload,sha256})+'\n');
  try{
   for(const [fd,path]of [[this.fd,this.file],[this.headFd,join(dirname(this.file),'account-creations.head.jsonl')]] as const){
    checkFile(fd);const opened=fstatSync(fd),current=lstatSync(path);
    assert.ok(current.isFile()&&!current.isSymbolicLink()&&current.dev===opened.dev&&current.ino===opened.ino,'account journal path was replaced or removed');
   }
   assert.ok(fstatSync(this.fd).size+bytes.length<=4*1024*1024,'account journal exceeds its recovery bound');
   for(let offset=0;offset<bytes.length;){const written=writeSync(this.fd,bytes,offset,bytes.length-offset);assert.ok(written>0);offset+=written;}
   fsyncSync(this.fd);
   // A hash chain alone accepts truncation at a complete line. Persist a
   // second, append-only high-water record before issuing a commit grant.
   const head=Buffer.from(JSON.stringify({sequence,sha256})+'\n');
   for(let offset=0;offset<head.length;){const written=writeSync(this.headFd,head,offset,head.length-offset);assert.ok(written>0);offset+=written;}
   fsyncSync(this.headFd);this.sequence=sequence;this.previous=sha256;
  }catch(error){this.failed=true;throw error;}
 }
 stage(input:AccountRecord,proof?:ContainerAttempt):string{
  const item=record(input);assert.equal(item.sourceId,this.sourceId,'staged object is in another account');
  assert.ok(!this.originalIds.has(item.id),'staged object was present before this run');
  assert.ok(![...this.creations.values()].some(value=>value.record.id===item.id),'persistent ID already belongs to another creation');
  const attempt=proof?attemptIdentity(proof):undefined;
  if(attempt){assert.ok(attempt.writer,'writer birth must be bound before staging');assert.deepEqual(this.attempts.get(attempt.nonce),attempt,'native attempt binding changed');}
  const requestId=randomUUID();this.append({kind:'staged',requestId,record:item,...(attempt?{attempt}:{})});
  this.creations.set(requestId,{requestId,record:item,grant:false,committed:false,notCommitted:false,...(attempt?{attempt}:{})});return requestId;
 }
 allowCommit(requestId:string):void{
  const item=this.creations.get(requestId);assert.ok(item&&!item.grant&&!item.notCommitted,'unknown or already granted creation');
  assert.ok(!item.attempt||item.attempt.writer,'native writer birth was not durably bound');
  this.append({kind:'commit-granted',requestId});item.grant=true;
 }
 committed(requestId:string,input:AccountRecord):void{
  const item=this.creations.get(requestId);assert.ok(item?.grant&&!item.committed&&!item.notCommitted,'creation was not granted or already finished');
  assert.deepEqual(record(input),item.record,'committed identity or initial fields differ from the staged receipt');
  this.append({kind:'committed',requestId});item.committed=true;
 }
 notCommitted(requestId:string):void{
  const item=this.creations.get(requestId);assert.ok(item&&!item.grant&&!item.notCommitted,'a granted write cannot be declared absent or rolled back by the controller');
  this.append({kind:'not-committed',requestId});item.notCommitted=true;
 }
 close():void{if(!this.closed){this.closed=true;try{closeSync(this.fd);}finally{closeSync(this.headFd);}}}
}

/** A restart needs the same independently frozen run/source/original IDs.
 * A torn or modified file is an error, never a successful empty recovery. */
export function recoverAccountCreations(file:string,identity:Identity):CreationRecovery{
 try{
  assert.ok(isAbsolute(file));privateDirectory(dirname(file),identity.workspace);assert.equal(file,join(dirname(file),'account-creations.jsonl'));
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:string;
  try{checkFile(fd);assert.ok(fstatSync(fd).size<=4*1024*1024,'account journal exceeds its bound');bytes=readFileSync(fd,'utf8');}finally{closeSync(fd);}
  assert.ok(bytes.endsWith('\n'),'incomplete account journal record');
  const headFd=openSync(join(dirname(file),'account-creations.head.jsonl'),constants.O_RDONLY|constants.O_NOFOLLOW);let headBytes:string;
  try{checkFile(headFd);assert.ok(fstatSync(headFd).size<=4*1024*1024);headBytes=readFileSync(headFd,'utf8');}finally{closeSync(headFd);}
  assert.ok(headBytes.endsWith('\n'),'incomplete account journal high-water record');
  const heads=headBytes.trimEnd().split('\n').map(line=>JSON.parse(line) as {sequence:number;sha256:string});
  const creations=new Map<string,Creation>(),attempts=new Map<string,ContainerAttempt>();let previous='0'.repeat(64),sequence=0;
  for(const line of bytes.trimEnd().split('\n')){
   const entry=JSON.parse(line) as Entry;assert.deepEqual(Object.keys(entry).sort(),['sequence','previous','payload','sha256'].sort());
   assert.equal(entry.sequence,++sequence);assert.equal(entry.previous,previous);
   assert.equal(entry.sha256,hash(JSON.stringify({sequence:entry.sequence,previous:entry.previous,payload:entry.payload})));previous=entry.sha256;
   assert.deepEqual(heads[sequence-1],{sequence,sha256:entry.sha256},'journal and independent high-water records differ');
   const payload=entry.payload;
   if(sequence===1){assert.deepEqual(payload,{kind:'session',version:1,runId:identity.runId,sourceId:identity.sourceId,workspace:identity.workspace,originalIds:canonicalIds(identity.originalIds),fingerprintKeySha256:identity.fingerprintKeySha256});continue;}
   if(payload.kind==='attempt-started'){const attempt=attemptIdentity(payload.attempt);assert.ok(!attempt.writer&&!attempts.has(attempt.nonce));attempts.set(attempt.nonce,attempt);continue;}
   if(payload.kind==='writer-bound'){
    assert.deepEqual(Object.keys(payload).sort(),['kind','nonce','writer'].sort());assert.ok(typeof payload.nonce==='string');
    const prior=attempts.get(payload.nonce);assert.ok(prior&&!prior.writer&&![...creations.values()].some(value=>value.attempt?.nonce===payload.nonce),'writer birth must precede staging');
    attempts.set(payload.nonce,{...prior,writer:writerProcessIdentity(payload.writer)});continue;
   }
   const requestId=payload.requestId;assert.ok(typeof requestId==='string'&&requestId.length>0);
   if(payload.kind==='staged'){
    const item=record(payload.record);assert.equal(item.sourceId,identity.sourceId);assert.ok(!identity.originalIds.includes(item.id)&&!creations.has(requestId));
    const attempt=payload.attempt?attemptIdentity(payload.attempt):undefined;
    if(attempt)assert.deepEqual(attempts.get(attempt.nonce),attempt,'missing or changed native attempt binding');
    assert.ok(![...creations.values()].some(value=>value.record.id===item.id));creations.set(requestId,{requestId,record:item,grant:false,committed:false,notCommitted:false,...(attempt?{attempt}:{})});
   }else{
    const item=creations.get(requestId);assert.ok(item);
    if(payload.kind==='commit-granted'){assert.ok(!item.grant&&!item.notCommitted&&(!item.attempt||item.attempt.writer));item.grant=true;}
    else if(payload.kind==='committed'){assert.ok(item.grant&&!item.committed&&!item.notCommitted);item.committed=true;}
    else if(payload.kind==='not-committed'){assert.ok(!item.grant&&!item.notCommitted);item.notCommitted=true;}
    else assert.fail('unknown creation journal operation');
   }
  }
  assert.ok(sequence>0);assert.equal(heads.length,sequence,'journal lost complete trailing records');
  return{needsIndependentReconciliation:true,attempts:[...attempts.values()].map(attemptIdentity),candidates:[...creations.values()].filter(item=>item.grant).map(item=>({requestId:item.requestId,record:{...item.record},outcome:item.committed?'committed':'unknown',...(item.attempt?{attempt:attemptIdentity(item.attempt)}:{})}))};
 }catch{throw new Error('Account creation journal is incomplete or invalid; no account objects were adopted or deleted');}
}
function attemptIdentity(value:unknown):ContainerAttempt{
 assert.ok(value&&typeof value==='object');const item=value as ContainerAttempt;
 assert.deepEqual(Object.keys(item).sort(),['nonce','writerPath','writerSha256','requestSha256','outcomeDevice','outcomeInode',...(Object.hasOwn(item,'writer')?['writer']:[])].sort());
 assert.match(item.nonce,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
 assert.ok(isAbsolute(item.writerPath));assert.match(item.writerSha256,/^[0-9a-f]{64}$/);assert.match(item.requestSha256,/^[0-9a-f]{64}$/);
 assert.match(item.outcomeDevice,/^\d+$/);assert.match(item.outcomeInode,/^[1-9]\d*$/);return{...item,...(Object.hasOwn(item,'writer')?{writer:writerProcessIdentity(item.writer)}:{})};
}
