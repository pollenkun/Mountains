import assert from 'node:assert/strict';
import type {AccountRecord} from './account-proofs.ts';
import type {WriterProcessIdentity} from './process-identity.ts';

export interface ContainerAttempt{
 nonce:string;writerPath:string;writerSha256:string;requestSha256:string;
 outcomeDevice:string;outcomeInode:string;
 /** Independently read by the parent and durably bound before the first
  * request. Missing birth metadata can never be filled from a reused PID. */
 writer?:WriterProcessIdentity;
}
export interface ContainerOutcome{
 state:'starting'|'prepared'|'commit-started'|'committed'|'not-committed'|'unknown';
 prepared?:AccountRecord;actual?:AccountRecord;
}
function object(input:unknown,keys:readonly string[]):Record<string,unknown>{
 assert.ok(input&&typeof input==='object'&&!Array.isArray(input));
 assert.deepEqual(Object.keys(input).sort(),[...keys].sort());return input as Record<string,unknown>;
}
export function containerRecord(input:unknown):AccountRecord{
 try{
  const item=object(input,['id','sourceId','parentId','kind','fingerprint']);
  assert.ok(typeof item.id==='string'&&item.id.length>0&&item.id.length<=4096);
  assert.ok(typeof item.sourceId==='string'&&item.sourceId.length>0&&item.sourceId.length<=4096);
  assert.equal(item.kind,'container');assert.equal(item.parentId,null);
  assert.ok(typeof item.fingerprint==='string'&&/^[0-9a-f]{64}$/.test(item.fingerprint));
  return{id:item.id,sourceId:item.sourceId,parentId:null,kind:'container',fingerprint:item.fingerprint};
 }catch{throw new Error('Invalid native container identity; no object was adopted');}
}

/** This checks the actual native file's state machine. It does not turn an
 * absent reply, a live writer or an incomplete file into a failed commit. */
export function parseContainerOutcome(bytes:string,expected:{runId:string;nonce:string;sourceId:string}):ContainerOutcome{
 try{
  assert.ok(Buffer.byteLength(bytes)<=65_536);if(!bytes)return{state:'starting'};
  assert.ok(bytes.endsWith('\n'),'partial native outcome record');
  const lines=bytes.slice(0,-1).split('\n');assert.ok(lines.length<=4);
  let state:ContainerOutcome['state']='starting',prepared:AccountRecord|undefined,actual:AccountRecord|undefined;
  for(const line of lines){
   assert.ok(state!=='committed'&&state!=='not-committed'&&state!=='unknown','native outcome continued after its terminal record');
   const raw=JSON.parse(line) as Record<string,unknown>;
   if(raw.kind==='not-committed'||raw.kind==='unknown'){
    object(raw,['version','kind','phase']);assert.equal(raw.version,1);assert.equal(raw.phase,state);
    if(raw.kind==='not-committed')assert.ok(state==='starting'||state==='prepared','commit started; absence cannot prove rollback');
    state=raw.kind;continue;
   }
   object(raw,raw.kind==='committed'?['version','kind','runId','nonce','record','preparedId']:['version','kind','runId','nonce','record']);
   assert.equal(raw.version,1);assert.equal(raw.runId,expected.runId);assert.equal(raw.nonce,expected.nonce);
   const item=containerRecord(raw.record);assert.equal(item.sourceId,expected.sourceId);
   if(raw.kind==='prepared'){assert.equal(state,'starting');prepared=item;state='prepared';}
   else if(raw.kind==='commit-started'){assert.equal(state,'prepared');assert.deepEqual(item,prepared);state='commit-started';}
   else if(raw.kind==='committed'){assert.equal(state,'commit-started');assert.equal(raw.preparedId,prepared!.id);actual=item;state='committed';}
   else assert.fail('unknown native container outcome');
  }
  return{state,...(prepared?{prepared}:{}),...(actual?{actual}:{})};
 }catch{throw new Error('Native container outcome is invalid or incomplete; commit status remains unknown');}
}
