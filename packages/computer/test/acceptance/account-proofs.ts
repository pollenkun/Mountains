import assert from 'node:assert/strict';

export type AccountKind='notes'|'events'|'reminders';
export interface AccountRecord{
 id:string;sourceId:string;parentId:string|null;kind:'container'|'object';fingerprint:string;
}
export interface AccountInventory{
 kind:AccountKind;authorization:'full'|'write-only'|'denied'|'unknown';
 coverage:'all-objects'|'bounded-interval'|'unknown';complete:boolean;
 /** Complete object enumeration is not an atomic database snapshot and does
  * not cover private fields which EventKit never exposes. */
 fieldScope:'EventKit-public-reminder-v1'|'unproven';
 sources:{id:string;storage:'local'|'remote'|'unknown';proof:'EventKit.sourceType'|'unproven-name'}[];
 records:AccountRecord[];
}
export interface AccountReader{
 inventory():Promise<AccountInventory>;
 read(id:string):Promise<AccountRecord|null>;
 children(id:string):Promise<{complete:boolean;records:AccountRecord[]}>;
 /** Must address and revalidate the persistent object ID inside the native
  * adapter. A selected-row Delete key is not an implementation of this API. */
 removeExact(expected:AccountRecord):Promise<void>;
}
/** A trusted native writer, not a model/UI receipt. Implementations must return
 * a fresh persistent ID from that write, never adopt a matching name. It needs
 * its own crash-safe creation journal before this can unlock a real test. */
export interface AccountCreator extends AccountReader{
 /** Cancel before committing when possible. If already committed, still return
  * its journaled receipt so cleanup can wait for and remove that exact ID. */
 create(request:{kind:'container'|'object';sourceId:string;parentId:string|null},signal:AbortSignal):Promise<AccountRecord>;
}
function records(inventory:AccountInventory):Map<string,AccountRecord>{
 const entries=new Map<string,AccountRecord>();
 for(const item of inventory.records){
  assert.ok(item.id&&item.sourceId&&item.fingerprint,'incomplete persistent account identity');
  assert.ok(!entries.has(item.id),'duplicate account object ID');entries.set(item.id,{...item});
 }
 return entries;
}
function complete(inventory:AccountInventory):void{
 assert.equal(inventory.authorization,'full','write-only or missing authorization cannot verify original data');
 assert.equal(inventory.coverage,'all-objects','a bounded event query cannot prove a complete original inventory');
 assert.equal(inventory.complete,true,'partial or nil account inventory cannot be treated as empty');
 if(inventory.kind==='reminders')assert.equal(inventory.fieldScope,'EventKit-public-reminder-v1','reminder field coverage is unproven');
 records(inventory);
 const sources=new Set<string>();
 for(const source of inventory.sources){assert.ok(source.id&&!sources.has(source.id),'missing or duplicate source ID');sources.add(source.id);}
 for(const item of inventory.records)assert.ok(sources.has(item.sourceId),'account record has no source');
}

/** Ownership must come from a trusted native creation receipt. Prefixes,
 * independently observed new children and selected-row names
 * cannot confer ownership. This is preparation/cleanup policy; it does not
 * claim an AX row is bound to an object until a native UI-ID bridge exists. */
export class OwnedAccountObjects{
 private readonly baseline:Map<string,AccountRecord>;
 private readonly sources:AccountInventory['sources'];
 private readonly owned=new Map<string,AccountRecord>();
 private containerId:string|undefined;
 private sealed=false;
 private readonly cancellation=new AbortController();
 private active:Promise<AccountRecord>|undefined;
 private cleanupResult:Promise<{id:string;error:string}[]>|undefined;
 readonly sourceId:string;
 readonly kind:AccountKind;
 constructor(before:AccountInventory,sourceId:string){
  complete(before);this.kind=before.kind;
  assert.notEqual(before.kind,'notes','no proven local Notes source adapter exists');
  const source=before.sources.filter(item=>item.id===sourceId);
  assert.equal(source.length,1,'source ID is missing or ambiguous');
  assert.equal(source[0]!.storage,'local','default or synchronized account is forbidden');
  assert.equal(source[0]!.proof,'EventKit.sourceType','an account name does not prove local storage');
  this.sourceId=sourceId;this.baseline=records(before);this.sources=before.sources.map(source=>({...source})).sort((a,b)=>a.id.localeCompare(b.id));
 }
 async createContainer(adapter:AccountCreator):Promise<AccountRecord>{
  assert.equal(this.containerId,undefined,'this fixture already owns a container');
  return this.create(adapter,'container',null);
 }
 async createChild(adapter:AccountCreator):Promise<AccountRecord>{
  assert.ok(this.containerId,'no independently created test container');
  return this.create(adapter,'object',this.containerId);
 }
 private create(adapter:AccountCreator,kind:AccountRecord['kind'],parentId:string|null):Promise<AccountRecord>{
  assert.equal(this.sealed,false,'account fixture is closing; no new creation is allowed');
  assert.equal(this.active,undefined,'another account creation is still running');
  const operation=this.createNative(adapter,kind,parentId);this.active=operation;
  const clear=()=>{if(this.active===operation)this.active=undefined;};void operation.then(clear,clear);return operation;
 }
 private async createNative(adapter:AccountCreator,kind:AccountRecord['kind'],parentId:string|null):Promise<AccountRecord>{
  this.assertUnchangedOriginals(await adapter.inventory());
  this.cancellation.signal.throwIfAborted();
  const receipt={...await adapter.create({kind,sourceId:this.sourceId,parentId},this.cancellation.signal)};
  assert.equal(receipt.kind,kind);assert.equal(receipt.parentId,parentId,'child is outside the owned test container');
  assert.ok(receipt.id&&receipt.fingerprint,'creation receipt has no persistent ID or fingerprint');
  assert.equal(receipt.sourceId,this.sourceId,'created object belongs to a different account');
  assert.ok(!this.baseline.has(receipt.id),'a pre-existing object cannot become test-owned');
  assert.ok(!this.owned.has(receipt.id),'duplicate ownership receipt');this.owned.set(receipt.id,{...receipt});
  if(kind==='container')this.containerId=receipt.id;
  assert.deepEqual(await adapter.read(receipt.id),receipt,'native creation could not be independently confirmed');
  this.cancellation.signal.throwIfAborted();
  return{...receipt};
 }
 private sameIdentity(expected:AccountRecord,actual:AccountRecord):void{
  assert.equal(actual.id,expected.id);assert.equal(actual.sourceId,expected.sourceId,'object moved to another account');
  assert.equal(actual.parentId,expected.parentId,'object moved to another container');assert.equal(actual.kind,expected.kind);
 }
 requireUiTarget(actual:AccountRecord|null,bridge:{persistentId:string;exactReceiver:boolean}|null):AccountRecord{
  assert.equal(this.sealed,false,'account fixture is closing; UI input is disabled');
  assert.ok(actual&&bridge?.exactReceiver,'no independent UI receiver-to-persistent-ID bridge; account UI input is disabled');
  assert.equal(bridge.persistentId,actual.id,'the observed object and actual UI receiver differ');
  const expected=this.owned.get(actual.id);assert.ok(expected,'UI receiver is not a test-owned object');
  this.sameIdentity(expected,actual);assert.equal(actual.fingerprint,expected.fingerprint,'owned object changed; reread it before input');return{...actual};
 }
 assertUnchangedOriginals(after:AccountInventory):void{
  complete(after);assert.equal(after.kind,this.kind);const current=records(after);
  assert.deepEqual(after.sources.map(source=>({...source})).sort((a,b)=>a.id.localeCompare(b.id)),this.sources,'account sources changed');
  for(const [id,before]of this.baseline){const value=current.get(id);assert.ok(value,'pre-existing object was removed');assert.deepEqual(value,before,'pre-existing account data changed');}
  for(const id of current.keys())assert.ok(this.baseline.has(id)||this.owned.has(id),'an unknown object was created; do not clean it up by name');
 }
 cleanup(reader:AccountReader):Promise<{id:string;error:string}[]>{
  if(this.cleanupResult)return this.cleanupResult;
  this.sealed=true;this.cancellation.abort(new Error('account fixture is closing'));
  this.cleanupResult=this.finishCleanup(reader);return this.cleanupResult;
 }
 private async finishCleanup(reader:AccountReader):Promise<{id:string;error:string}[]>{
  const errors:{id:string;error:string}[]=[];
  // Never drop a timed-out promise: its late receipt could otherwise create
  // an object after cleanup has reported success. The native adapter must
  // bound its own work and journal a committed ID before replying.
  if(this.active)try{await this.active;}catch(error){errors.push({id:'pending-creation',error:String(error)});}
  // Children first. A failed deletion cannot be hidden by cascading its parent.
  const owned=[...this.owned.values()].sort((a,b)=>(a.kind==='container'?1:0)-(b.kind==='container'?1:0));
  for(const expected of owned){
   try{
    const current=await reader.read(expected.id);if(!current)continue;
    this.sameIdentity(expected,current);assert.equal(current.fingerprint,expected.fingerprint,'object changed independently; kept instead of deleting it');
    if(expected.kind==='container'){
     const children=await reader.children(expected.id);assert.equal(children.complete,true,'container contents are unknown');
     assert.equal(children.records.length,0,'container still contains objects; no cascading deletion is permitted');
    }
    await reader.removeExact({...expected});assert.equal(await reader.read(expected.id),null,'exact object still exists after removal');
   }catch(error){errors.push({id:expected.id,error:String(error)});}
  }
  try{
   const after=await reader.inventory();this.assertUnchangedOriginals(after);
   for(const item of after.records)if(this.owned.has(item.id))errors.push({id:item.id,error:'owned object remains in final independent inventory'});
  }catch(error){errors.push({id:'original-inventory',error:String(error)});}
  return errors;
 }
}
