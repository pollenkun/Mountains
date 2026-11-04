import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ObservedBrowser} from './fixtures/observed-browser.ts';
import {witnessBrowserObserver} from './acceptance/witness-browser-observer.ts';
import {documentRequestWitness} from './acceptance/document-request-witness.ts';
import {signedFormService} from './acceptance/signed-form-service.ts';
import {REQUEST_PROOF_HEADER} from './acceptance/request-witness.ts';
const origin='http://127.0.0.1:12345',form=origin+'/form',detail=origin+'/detail';
async function setup(site=origin,timeoutMs=1000){
	const browser=new ObservedBrowser(),observer=await witnessBrowserObserver(browser,{targetId:'main',allowedURLs:['about:blank',site+'/form',site+'/detail'],verifyOwner:async()=>{},timeoutMs});
	browser.navigate(site+'/form','form-loader');const manager=await documentRequestWitness(browser,{observer,verifyOwner:async()=>{},timeoutMs});
	return{browser,observer,manager,async close(){await manager.close().catch(()=>{});await observer.close().catch(()=>{});}};
}
test('navigation closes the old actual private session before input and binds a distinct new document afterward',async()=>{
	const f=await setup();try{
		await f.manager.beginExecution('form-read');await f.manager.endExecution('form-read');const old=f.manager.snapshot().epochs[0]!;
		await f.manager.beginNavigation('link-to-detail');assert.equal(f.manager.snapshot().epochs[0]!.closed,true);
		assert.ok(!f.browser.sessions.has(old.scope.sessionId));assert.equal(f.manager.snapshot().transition?.id,'link-to-detail');assert.throws(()=>f.manager.verifyComplete());
		f.browser.navigate(detail,'detail-loader');await f.manager.endNavigation('link-to-detail');const fresh=f.manager.snapshot().epochs[1]!;
		assert.equal(fresh.document.url,detail);assert.notEqual(fresh.scope.sessionId,old.scope.sessionId);assert.notEqual(fresh.scope.loaderId,old.scope.loaderId);
		await f.manager.beginExecution('detail-read');await f.manager.endExecution('detail-read');f.manager.verifyComplete();
		const first=f.manager.close(),second=f.manager.close();assert.equal(first,second);assert.equal((await first).closedEpochs,2);assert.equal(f.browser.sessions.size,2,'only the permanent observer and clock sessions remain');
	}finally{await f.close();}
});
test('navigation gaps reject a POST and a later valid document cannot reset that failure',async()=>{
	const f=await setup();try{
		await f.manager.beginNavigation('gap');await assert.rejects(f.manager.authorization.accept({nonce:'0'.repeat(64),method:'POST',url:origin+'/api/detail',body:Buffer.from('{"value":"unpermitted"}')},new AbortController().signal),/outside an active document/);
		f.browser.navigate(detail,'new-loader');await assert.rejects(f.manager.endNavigation('gap'),/outside an active document/);assert.throws(()=>f.manager.verifyComplete());assert.equal(f.manager.snapshot().epochs.length,1);assert.ok(f.manager.snapshot().failure);
	}finally{await f.close();}
});
test('unexpected document changes fail the old witness rather than reclassifying them as authorized navigation',async()=>{
	const f=await setup();try{
		await f.manager.beginExecution('old-input');f.browser.navigate(detail,'unexpected-loader');
		await assert.rejects(f.manager.endExecution('old-input'));await assert.rejects(f.manager.beginNavigation('cannot-clear'));assert.throws(()=>f.manager.verifyComplete());assert.equal(f.manager.snapshot().epochs.length,1);
	}finally{await f.close();}
});
test('navigation without a real document event cannot bind a fresh empty witness',async()=>{
	const f=await setup();try{await f.manager.beginNavigation('no-change');await assert.rejects(f.manager.endNavigation('no-change'),/no actual document event/);assert.throws(()=>f.manager.verifyComplete());assert.equal(f.manager.snapshot().epochs.length,1);}finally{await f.close();}
});
test('execution identity remains unique across documents even when history reuses old loader IDs',async()=>{
	const f=await setup();try{
		await f.manager.beginExecution('same-id');await f.manager.endExecution('same-id');
		await f.manager.beginNavigation('to-detail');f.browser.navigate(detail,'detail-loader');await f.manager.endNavigation('to-detail');
		await f.manager.beginNavigation('back');f.browser.navigate(form,'form-loader');await f.manager.endNavigation('back');f.manager.verifyComplete();
		assert.equal(f.manager.snapshot().epochs.length,3);await assert.rejects(f.manager.beginExecution('same-id'),/reused/);assert.throws(()=>f.manager.verifyComplete());
	}finally{await f.close();}
});
test('real signed POST and committed callback stay attached to the old document after later empty connections',async()=>{
	// Actual own HTTP, synthetic CDP only; no model/UI/focus claim.
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-document-request-'))),service=await signedFormService(root,'detail'),f=await setup(service.origin);
	service.bind(f.manager.authorization);let actualHTTP:Promise<Response>|undefined;
	try{
		await f.manager.beginNavigation('enter-detail');f.browser.navigate(service.origin+'/detail','detail-loader');await f.manager.endNavigation('enter-detail');
		await f.manager.beginExecution('save-detail');const session=f.manager.snapshot().epochs.at(-1)!.scope.sessionId,body=JSON.stringify({value:'Own saved detail'}),url=service.origin+'/api/detail';
		f.browser.continuation=async(params,actualSession)=>{
			assert.equal(actualSession,session);const nonce=(params.headers as {name:string;value:string}[]).find(row=>row.name===REQUEST_PROOF_HEADER)!.value;
			f.browser.emit('Network.requestWillBeSentExtraInfo',{requestId:'network-write',headers:{[REQUEST_PROOF_HEADER]:nonce}},session);
			actualHTTP=fetch(url,{method:'POST',body,headers:{[REQUEST_PROOF_HEADER]:nonce}});return{};
		};
		f.browser.emit('Network.requestWillBeSent',{requestId:'network-write',frameId:'main-frame',loaderId:'detail-loader',documentURL:service.origin+'/detail',timestamp:f.browser.clock+1,request:{method:'POST',url,postData:body}},session);
		f.browser.emit('Fetch.requestPaused',{requestId:'fetch-write',networkId:'network-write',frameId:'main-frame',request:{method:'POST',url,postData:body,headers:{}}},session);
		// Settlement begins before the HTTP ACK. The manager must allow the
		// real committed callback while it is waiting for this exact write.
		await f.manager.endExecution('save-detail');assert.equal((await actualHTTP!).status,200);assert.equal(f.manager.publicRecords().length,1);
		await f.manager.beginNavigation('round-trip');f.browser.navigate(service.origin+'/form','form-loader');f.browser.navigate(service.origin+'/detail','detail-loader');f.browser.navigate(service.origin+'/detail','refreshed-loader');await f.manager.endNavigation('round-trip');
		f.manager.verifyComplete();assert.equal(f.manager.publicRecords().length,1);assert.equal(f.manager.publicRecords()[0]!.stage,'committed');assert.equal(f.manager.publicRecords()[0]!.proof.sessionId,session);
		const saved=f.manager.snapshot();assert.equal(saved.epochs.length,3);assert.deepEqual(saved.epochs.map(row=>row.closed),[true,true,false]);assert.equal(saved.epochs[1]!.requestProofs.length,1);assert.equal(saved.epochs[2]!.requestProofs.length,0);
		assert.deepEqual(await(await fetch(service.origin+'/api/state')).json(),{detail:'Own saved detail'});assert.equal(service.verify().filter(row=>row.kind==='detail-saved').length,1);
		await f.manager.close();await service.close();
	}finally{await actualHTTP?.catch(()=>{});await f.close();await service.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});
test('old connection close failure is preserved and prevents every later document attachment',async()=>{
	const f=await setup(),send=f.browser.send.bind(f.browser);let failOld=true;const old=f.manager.snapshot().epochs[0]!.scope.sessionId;
	f.browser.send=async(method,params,session)=>{if(failOld&&method==='Fetch.disable'&&session===old)throw new Error('injected old detach failure');return send(method,params,session);};
	try{await assert.rejects(f.manager.beginNavigation('failed-retirement'));f.browser.navigate(detail,'another-loader');await assert.rejects(f.manager.endNavigation('failed-retirement'));assert.equal(f.manager.snapshot().epochs.length,1);assert.throws(()=>f.manager.verifyComplete());}
	finally{failOld=false;await f.close();}
});

test('stopping in the navigation gap permanently revokes the whole module before a new document exists',async()=>{
	const f=await setup();try{
		await f.manager.beginNavigation('stopped-gap');f.manager.authorization.stop();f.browser.navigate(detail,'post-stop-loader');
		await assert.rejects(f.manager.endNavigation('stopped-gap'),/observation stopped/);await assert.rejects(f.manager.beginExecution('post-stop-input'),/observation stopped/);
		await assert.rejects(f.manager.authorization.accept({nonce:'0'.repeat(64),method:'POST',url:origin+'/api/detail',body:Buffer.from('{"value":"stopped"}')},new AbortController().signal),/observation stopped/);
		assert.throws(()=>f.manager.verifyComplete(),/observation stopped/);assert.equal(f.manager.snapshot().epochs.length,1);assert.deepEqual(f.manager.publicRecords(),[]);
	}finally{await f.close();}
});
test('a document connection finishing after stop is actually closed and never becomes current',async()=>{
	const browser=new ObservedBrowser(),observer=await witnessBrowserObserver(browser,{targetId:'main',allowedURLs:['about:blank',form,detail],verifyOwner:async()=>{}});browser.navigate(form,'form-loader');
	let hold=false,release!:()=>void,entered!:()=>void;const gate=new Promise<void>(yes=>{release=yes;}),waiting=new Promise<void>(yes=>{entered=yes;});
	const manager=await documentRequestWitness(browser,{observer,verifyOwner:async()=>{if(hold){entered();await gate;}}});
	try{
		await manager.beginNavigation('late-stopped');browser.navigate(detail,'new-loader');hold=true;const binding=manager.endNavigation('late-stopped');const rejected=assert.rejects(binding,/observation stopped/);await waiting;
		manager.authorization.stop();release();await rejected;assert.equal(manager.snapshot().epochs.length,2);assert.ok(manager.snapshot().epochs.every(epoch=>epoch.closed));assert.equal(browser.sessions.size,2);assert.throws(()=>manager.verifyComplete());await manager.close();
	}finally{release();await manager.close().catch(()=>{});await observer.close().catch(()=>{});}
});
