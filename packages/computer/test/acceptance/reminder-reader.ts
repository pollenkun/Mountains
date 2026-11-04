import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {isAbsolute} from 'node:path';
import type {AccountInventory,AccountRecord} from './account-proofs.ts';

export interface ReminderInventory extends AccountInventory{
 version:1;kind:'reminders';fieldScope:'EventKit-public-reminder-v1';
}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'invalid reminder evidence object');
 const record=value as Record<string,unknown>;
 assert.deepEqual(Object.keys(record).sort(),[...keys].sort(),'unexpected reminder evidence fields');return record;
}
function id(value:unknown):asserts value is string{assert.ok(typeof value==='string'&&value.length>0&&value.length<=4096,'invalid persistent reminder identity');}

/** Reject partial, foreign-domain and extra plaintext fields. A caller cannot
 * turn this scoped public-field observation into an all-fields database proof. */
export function parseReminderInventory(bytes:string):ReminderInventory{
 try{return validateReminderInventory(bytes);}catch{
  // JSON syntax errors and assertions may quote an unexpected actual value.
  // Neither that value nor the original Error/cause belongs in test logs.
  throw new Error('Invalid read-only reminder evidence; account tests remain disabled');
 }
}
function validateReminderInventory(bytes:string):ReminderInventory{
 const raw=object(JSON.parse(bytes),['version','kind','authorization','coverage','complete','fieldScope','sources','records']);
 assert.equal(raw.version,1);assert.equal(raw.kind,'reminders');assert.equal(raw.authorization,'full');
 assert.equal(raw.coverage,'all-objects');assert.equal(raw.complete,true);assert.equal(raw.fieldScope,'EventKit-public-reminder-v1');
 assert.ok(Array.isArray(raw.sources)&&Array.isArray(raw.records));
 const sourceIds=new Set<string>();
 const sources:AccountInventory['sources']=raw.sources.map(value=>{
  const source=object(value,['id','storage','proof']);id(source.id);
  assert.ok(!sourceIds.has(source.id),'duplicate reminder source');sourceIds.add(source.id);
  assert.ok(source.storage==='local'||source.storage==='remote'||source.storage==='unknown');assert.equal(source.proof,'EventKit.sourceType');
  return{id:source.id,storage:source.storage,proof:'EventKit.sourceType' as const};
 });
 const ids=new Set<string>();
 const records:AccountRecord[]=raw.records.map(value=>{
  const item=object(value,['id','sourceId','parentId','kind','fingerprint']);id(item.id);id(item.sourceId);
  assert.ok(!ids.has(item.id),'duplicate reminder object');ids.add(item.id);assert.ok(sourceIds.has(item.sourceId),'missing reminder source');
  assert.ok(item.kind==='container'||item.kind==='object');
  if(item.kind==='container')assert.equal(item.parentId,null);else id(item.parentId);
  assert.ok(typeof item.fingerprint==='string'&&/^[0-9a-f]{64}$/.test(item.fingerprint),'invalid private reminder fingerprint');
  return{id:item.id,sourceId:item.sourceId,parentId:item.parentId as string|null,kind:item.kind,fingerprint:item.fingerprint};
 });
 const parents=new Map(records.filter(item=>item.kind==='container').map(item=>[item.id,item.sourceId]));
 for(const item of records)if(item.kind==='object')assert.equal(parents.get(item.parentId!),item.sourceId,'reminder is outside its independently enumerated list');
 return{version:1,kind:'reminders',authorization:'full',coverage:'all-objects',complete:true,fieldScope:'EventKit-public-reminder-v1',sources,records};
}

/** Preparation is still hard-disabled. This only wraps a separately built,
 * frozen, read-only helper; it never compiles or launches a GUI application.
 * No write adapter exists yet. Do not call this to bypass safety-gate.ts. */
export async function readReminderInventory(binary:string,key:Uint8Array,signal?:AbortSignal):Promise<ReminderInventory>{
 assert.equal(process.platform,'darwin','EventKit inspection requires macOS');assert.ok(isAbsolute(binary),'use the exact frozen reader path');
 assert.equal(key.byteLength,32,'inventory requires a private 32-byte fingerprint key');signal?.throwIfAborted();
 const output=await new Promise<string>((resolve,reject)=>{
  let result:{failed:boolean;stdout:string}|undefined;
  const child=execFile(binary,[],{encoding:'utf8',timeout:10_000,killSignal:'SIGKILL',maxBuffer:32*1024*1024,...(signal?{signal}:{})},(error,stdout)=>{
   // Raw stderr and output may contain private data if the binary is corrupt.
   // Preserve only a fixed error, never the child_process Error.cmd/stdout.
   result={failed:!!error,stdout};
  });
  // Abort errors can precede actual child exit. Do not let the caller proceed
  // to cleanup while the inventory helper is still accessing the store.
  child.once('close',()=>{
   if(!result||result.failed)reject(new Error('Read-only reminder inventory failed or timed out; account tests remain disabled'));
   else resolve(result.stdout);
  });
  child.stdin?.on('error',()=>{});
  child.stdin?.end(JSON.stringify({version:1,key:Buffer.from(key).toString('base64')}));
 });
 signal?.throwIfAborted();return parseReminderInventory(output);
}
