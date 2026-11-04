import assert from 'node:assert/strict';
import type {CdpLike} from '../../src/web.ts';
import {attachRequestWitness} from './request-witness-adapter.ts';
import type {witnessBrowserObserver} from './witness-browser-observer.ts';
import type {FormServiceAuthorization} from './signed-form-service.ts';

type Observer=Awaited<ReturnType<typeof witnessBrowserObserver>>;
type Adapter=Awaited<ReturnType<typeof attachRequestWitness>>;
type Row=Record<string,unknown>;
interface Epoch{index:number;document:Row;adapter:Adapter;closed:boolean}
/** Private acceptance-controller lifecycle only, never a model tool. Every
 * document keeps its own real request witness. Navigation revokes the old
 * route before input; a gap cannot authorize any POST. Earlier errors and
 * committed requests survive every successful later document attachment. */
export async function documentRequestWitness(cdp:CdpLike,options:{observer:Observer;verifyOwner:()=>Promise<void>;timeoutMs?:number}){
	const observer=options.observer,limit=options.timeoutMs??3000;assert.equal(observer.cdp,cdp);assert.ok(Number.isInteger(limit)&&limit>0&&limit<=3000);
	const epochs:Epoch[]=[],navigations:Row[]=[],work=new Set<Promise<unknown>>(),used=new Set<string>();
	let current:Epoch|undefined,transition:{id:string;document:Row}|undefined,active:string|undefined,failure:Error|undefined,closing:Promise<Row>|undefined,busy=false;
	const fail=(error:unknown)=>{failure??=error instanceof Error?error:new Error(String(error));};
	const check=()=>{assert.ok(!closing,'document request witness is closed');if(failure)throw failure;};
	const claim=(id:string)=>{assert.ok(typeof id==='string'&&id.length>0&&id.length<=256&&!used.has(id)&&used.size<512,'document execution identity is invalid or reused');used.add(id);};
	const tracked=<T>(actual:Promise<T>)=>{work.add(actual);void actual.then(()=>work.delete(actual),()=>work.delete(actual));return actual;};
	const bounded=async<T>(actual:Promise<T>,label:string,timeout=limit)=>{let timer:ReturnType<typeof setTimeout>|undefined;const until=performance.now()+timeout;try{const value=await Promise.race([actual,new Promise<never>((_yes,no)=>{timer=setTimeout(()=>no(new Error(label+' exceeded independent deadline')),timeout);})]);assert.ok(performance.now()<until,label+' exceeded independent deadline');return value;}finally{clearTimeout(timer);}};
	const document=()=>{check();observer.verifyComplete();const snapshot=observer.snapshot();assert.equal(snapshot.failure,null);assert.ok(snapshot.frame);return structuredClone(snapshot.frame);};
	const same=(before:Row)=>assert.deepEqual(document(),before,'document changed while its private request connection was being attached');
	const attach=async()=>{
		const before=document();assert.equal(typeof before.url,'string');assert.ok(Number.isInteger(before.generation));
		const adapter=await attachRequestWitness(cdp,{targetId:observer.targetId,pageURL:before.url as string,verifyOwner:options.verifyOwner,preparation:observer,preparationTimeoutMs:limit});
		const epoch:Epoch={index:epochs.length+1,document:before,adapter,closed:false};epochs.push(epoch);
		try{check();same(before);assert.equal(adapter.scope.frameId,before.id);assert.equal(adapter.scope.loaderId,before.loaderId);current=epoch;}
		catch(error){try{await adapter.close();epoch.closed=true;}catch(cleanup){fail(cleanup);}throw error;}
	};
	const operation=async<T>(label:string,run:()=>Promise<T>):Promise<T>=>{
		check();assert.equal(busy,false,'document lifecycle operation already pending');busy=true;
		try{const value=await bounded(tracked(Promise.resolve().then(run)),label);check();return value;}
		catch(error){fail(error);throw error;}finally{busy=false;}
	};
	const complete=()=>{check();assert.equal(busy,false);assert.equal(active,undefined);assert.equal(transition,undefined);assert.ok(current);observer.verifyComplete();for(const epoch of epochs)if(epoch!==current)assert.equal(epoch.closed,true,'an earlier document connection did not close');current.adapter.verifyComplete();same(current.document);};
	const records=()=>epochs.flatMap(epoch=>epoch.adapter.publicRecords());
	const snapshot=()=>({targetId:observer.targetId,failure:failure?.message??null,active:active??null,transition:transition?structuredClone(transition):null,navigations:structuredClone(navigations),epochs:epochs.map(epoch=>({index:epoch.index,document:structuredClone(epoch.document),scope:epoch.adapter.scope,closed:epoch.closed,requestProofs:epoch.adapter.publicRecords(),preparations:epoch.adapter.preparations()}))});
	const close=():Promise<Row>=>{
		if(closing)return closing;
		closing=Promise.resolve().then(async()=>{
			const errors:string[]=[],until=performance.now()+limit;
			const step=async(run:()=>Promise<unknown>)=>{try{await bounded(tracked(Promise.resolve().then(run)),'document connection cleanup',Math.max(1,until-performance.now()));}catch(error){errors.push(String(error));}};
			const pending=[...work];await step(()=>Promise.allSettled(pending));
			for(const epoch of epochs)if(!epoch.closed)await step(async()=>{await epoch.adapter.close();epoch.closed=true;});
			const tail=[...work];await step(()=>Promise.allSettled(tail));
			assert.equal(work.size,0,'actual document lifecycle work remains pending');assert.ok(epochs.every(epoch=>epoch.closed));assert.deepEqual(errors,[]);
			return{closedEpochs:epochs.length,priorFailure:failure?.message??null};
		});return closing;
	};
	const authorization:FormServiceAuthorization={
		accept(request,signal){try{check();assert.ok(current&&!transition&&active,'POST arrived outside an active document execution');return current.adapter.authorization.accept(request,signal).catch(error=>{fail(error);throw error;});}catch(error){fail(error);return Promise.reject(error);}},
		committed(proof,signal){try{check();assert.ok(current&&!transition&&active,'POST committed outside an active document execution');return Promise.resolve(current.adapter.authorization.committed(proof,signal)).catch(error=>{fail(error);throw error;});}catch(error){fail(error);return Promise.reject(error);}},
		stop(){fail(new Error('document request observation stopped'));for(const epoch of epochs){try{epoch.adapter.authorization.stop();}catch(error){fail(error);}}},
	};
	try{await operation('initial document connection',attach);}catch(error){await close().catch(()=>{});throw error;}
	return Object.freeze({authorization,
		async beginExecution(id:string){return operation('document input preparation',async()=>{assert.ok(current&&!transition);assert.equal(active,undefined);claim(id);active=id;return current.adapter.beginExecution(id);});},
		async endExecution(id:string){return operation('document input settlement',async()=>{assert.ok(current&&!transition);assert.equal(active,id);await current.adapter.endExecution(id);active=undefined;});},
		async beginNavigation(id:string){return operation('old document revocation',async()=>{assert.ok(current);assert.equal(active,undefined);assert.equal(transition,undefined);claim(id);const old=current;old.adapter.verifyComplete();same(old.document);transition={id,document:structuredClone(old.document)};current=undefined;await old.adapter.close();old.closed=true;navigations.push({id,stage:'revoked',at:Date.now(),document:structuredClone(old.document)});});},
		async endNavigation(id:string){return operation('new document connection',async()=>{assert.ok(transition);assert.equal(transition.id,id);assert.equal(current,undefined);const before=transition.document,after=document();assert.ok(Number(after.generation)>Number(before.generation),'navigation produced no actual document event');await attach();navigations.push({id,stage:'attached',at:Date.now(),before:structuredClone(before),document:structuredClone(after)});transition=undefined;});},
		verifyComplete:complete,publicRecords:records,snapshot,close,
	});
}
