import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OwnedAccountObjects,type AccountInventory,type AccountRecord,type AccountCreator} from './acceptance/account-proofs.ts';

const original:AccountRecord={id:'personal-item',sourceId:'icloud',parentId:'personal-list',kind:'object',fingerprint:'private-content-hmac'};
const container:AccountRecord={id:'own-list',sourceId:'local-source',parentId:null,kind:'container',fingerprint:'own-list-hmac'};
const child:AccountRecord={id:'own-item',sourceId:'local-source',parentId:'own-list',kind:'object',fingerprint:'own-item-hmac'};
function inventory(values:AccountRecord[]=[original]):AccountInventory{return{kind:'reminders',authorization:'full',coverage:'all-objects',complete:true,fieldScope:'EventKit-public-reminder-v1',sources:[{id:'local-source',storage:'local',proof:'EventKit.sourceType'},{id:'icloud',storage:'remote',proof:'EventKit.sourceType'}],records:values.map(value=>({...value}))};}
async function fixture(){
 const values=new Map([[original.id,{...original}]]),removed:string[]=[];
 const reader:AccountCreator={
  inventory:async()=>inventory([...values.values()]),read:async id=>values.get(id)??null,
  children:async id=>({complete:true,records:[...values.values()].filter(value=>value.parentId===id)}),
  create:async request=>{const created={...(request.kind==='container'?container:child)};assert.equal(request.sourceId,created.sourceId);assert.equal(request.parentId,created.parentId);assert.ok(!values.has(created.id));values.set(created.id,created);return created;},
  removeExact:async expected=>{assert.deepEqual(values.get(expected.id),expected);removed.push(expected.id);values.delete(expected.id);}
 };
 const owned=new OwnedAccountObjects(inventory(),'local-source');await owned.createContainer(reader);await owned.createChild(reader);return{owned,values,removed,reader};
}
test('synchronized accounts, local-looking names and write-only permission cannot authorize fixture creation',()=>{
 assert.throws(()=>new OwnedAccountObjects(inventory(),'icloud'),/synchronized/);
 const named=inventory();named.sources[0]!.proof='unproven-name';assert.throws(()=>new OwnedAccountObjects(named,'local-source'),/name does not prove/);
 const writeOnly=inventory();writeOnly.authorization='write-only';assert.throws(()=>new OwnedAccountObjects(writeOnly,'local-source'),/write-only/);
 const notes=inventory();notes.kind='notes';assert.throws(()=>new OwnedAccountObjects(notes,'local-source'),/no proven local Notes/);
});
test('bounded events and incomplete reminder callbacks cannot prove original data is safe',()=>{
 const events=inventory();events.kind='events';events.coverage='bounded-interval';assert.throws(()=>new OwnedAccountObjects(events,'local-source'),/bounded event/);
 const incomplete=inventory();incomplete.complete=false;assert.throws(()=>new OwnedAccountObjects(incomplete,'local-source'),/partial or nil/);
 const fields=inventory();fields.fieldScope='unproven';assert.throws(()=>new OwnedAccountObjects(fields,'local-source'),/field coverage/);
});
test('a native creation cannot adopt a pre-existing ID or a child in another container',async()=>{
 const f=await fixture(),fresh=new OwnedAccountObjects(inventory(),'local-source');
 f.reader.inventory=async()=>inventory();f.reader.create=async()=>({...container,id:original.id});
 await assert.rejects(fresh.createContainer(f.reader),/pre-existing/);
 f.reader.create=async()=>({...child,id:'other-child',parentId:'personal-list'});
 await assert.rejects(f.owned.createChild(f.reader),/outside/);
 f.reader.create=async()=>({...child,id:'other-child',sourceId:'icloud'});
 await assert.rejects(f.owned.createChild(f.reader),/different account/);
});
test('creation requires independent exact-ID readback and retains the native receipt on read failure',async()=>{
 const f=await fixture(),fresh=new OwnedAccountObjects(inventory(),'local-source');
 f.reader.inventory=async()=>inventory();f.reader.create=async()=>({...container});f.reader.read=async()=>null;
 await assert.rejects(fresh.createContainer(f.reader),/independently confirmed/);
 const errors=await fresh.cleanup({...f.reader,inventory:async()=>inventory([original,container])});
 assert.ok(errors.some(error=>error.id===container.id&&error.error.includes('remains')));
});
test('an independent object read alone cannot authorize a selected-row Delete',async()=>{
 const {owned}=await fixture();assert.throws(()=>owned.requireUiTarget(child,null),/bridge/);
 assert.throws(()=>owned.requireUiTarget(child,{persistentId:'personal-item',exactReceiver:true}),/receiver differ/);
 assert.throws(()=>owned.requireUiTarget(original,{persistentId:'personal-item',exactReceiver:true}),/not a test-owned/);
 assert.deepEqual(owned.requireUiTarget(child,{persistentId:child.id,exactReceiver:true}),child);
});
test('cleanup independently rereads and deletes only exact owned IDs, children before parent',async()=>{
 const f=await fixture();assert.deepEqual(await f.owned.cleanup(f.reader),[]);assert.deepEqual(f.removed,[child.id,container.id]);assert.deepEqual([...f.values.values()],[original]);
});
test('unknown children cannot be adopted and stop parent cleanup instead of cascading',async()=>{
 const f=await fixture(),other={...child,id:'new-user-item'};f.values.set(other.id,other);
 // No register/refresh API can turn an observed user object or its edited
 // contents into a test creation receipt.
 await assert.rejects(f.owned.createChild(f.reader),/unknown object/);
 const errors=await f.owned.cleanup(f.reader);assert.ok(errors.some(item=>item.id===container.id));assert.deepEqual(f.removed,[child.id]);assert.ok(f.values.has(other.id));assert.ok(f.values.has(container.id));
});
test('an independently edited owned object is kept; rereading cannot confer deletion permission',async()=>{
 const f=await fixture();f.values.set(child.id,{...child,fingerprint:'user-edited'});
 assert.throws(()=>f.owned.requireUiTarget(f.values.get(child.id)!,{persistentId:child.id,exactReceiver:true}),/changed/);
 const errors=await f.owned.cleanup(f.reader);assert.ok(errors.some(error=>error.error.includes('changed independently')));assert.deepEqual(f.removed,[]);assert.ok(f.values.has(child.id));
});
test('original records and sources are copied so mutations cannot rewrite the baseline',()=>{
 const before=inventory(),owned=new OwnedAccountObjects(before,'local-source');
 before.records[0]!.fingerprint='changed';before.sources[0]!.storage='remote';
 assert.throws(()=>owned.assertUnchangedOriginals(inventory([{...original,fingerprint:'changed'}])),/pre-existing account data changed/);
 assert.throws(()=>owned.assertUnchangedOriginals(before),/sources changed/);
 const missing=inventory();missing.sources=[];assert.throws(()=>owned.assertUnchangedOriginals(missing),/no source/);
 const extra=inventory();extra.sources.push({id:'new-account',storage:'remote',proof:'EventKit.sourceType'});assert.throws(()=>owned.assertUnchangedOriginals(extra),/sources changed/);
});
test('original object deletion is detected even when the own folder and note looked correct',async()=>{
 const {owned}=await fixture();assert.throws(()=>owned.assertUnchangedOriginals(inventory([container,child])),/pre-existing object was removed/);
 assert.throws(()=>owned.assertUnchangedOriginals(inventory([{...original,fingerprint:'changed'},container,child])),/pre-existing account data changed/);
});
test('a failed child removal cannot be hidden by deleting its parent',async()=>{
 const f=await fixture();f.reader.removeExact=async()=>{throw new Error('store unavailable');};const errors=await f.owned.cleanup(f.reader);
 assert.ok(errors.some(error=>error.id===child.id));assert.ok(errors.some(error=>error.id===container.id));assert.ok(f.values.has(child.id));assert.ok(f.values.has(container.id));
});
test('an absent ID read cannot hide owned objects left in the final complete inventory',async()=>{
 const f=await fixture();f.reader.read=async()=>null;
 const errors=await f.owned.cleanup(f.reader);assert.deepEqual(errors.map(error=>error.id).sort(),[child.id,container.id].sort());assert.deepEqual(f.removed,[]);
});
test('cleanup waits for a late committed creation, shares its result, and seals future input',async()=>{
 const values=new Map<string,AccountRecord>();let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 let receivedSignal:AbortSignal|undefined;
 const reader:AccountCreator={
  inventory:async()=>inventory([...values.values()]),read:async id=>values.get(id)??null,
  children:async()=>({complete:true,records:[]}),removeExact:async item=>{values.delete(item.id);},
  create:async(_request,signal)=>{receivedSignal=signal;entered();await gate;values.set(container.id,{...container});return{...container};}
 };
 const before=inventory([]),owned=new OwnedAccountObjects(before,'local-source');
 const creation=owned.createContainer(reader);await started;
 let finished=false;const cleanup=owned.cleanup(reader);void cleanup.then(()=>{finished=true;});
 assert.equal(owned.cleanup(reader),cleanup);assert.equal(receivedSignal!.aborted,true);
 await Promise.resolve();assert.equal(finished,false,'cleanup must wait for the adapter receipt');
 release();await assert.rejects(creation,/closing/);const errors=await cleanup;
 assert.ok(errors.some(item=>item.id==='pending-creation'));assert.equal(values.size,0);
 await assert.rejects(owned.createChild(reader),/closing/);
 assert.throws(()=>owned.requireUiTarget(container,{persistentId:container.id,exactReceiver:true}),/closing/);
});
test('cleanup during a slow preflight prevents a late account write',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let writes=0;
 const reader:AccountCreator={inventory:async()=>{await gate;return inventory([]);},read:async()=>null,children:async()=>({complete:true,records:[]}),removeExact:async()=>{},create:async()=>{writes++;return{...container};}};
 const owned=new OwnedAccountObjects(inventory([]),'local-source'),creation=owned.createContainer(reader),cleanup=owned.cleanup(reader);
 release();await assert.rejects(creation,/closing/);await cleanup;assert.equal(writes,0);
});
