import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BrowserRequestWitness,REQUEST_PROOF_HEADER} from './acceptance/request-witness.ts';
import type {CdpEvent} from '../src/web.ts';

const scope={origin:'http://127.0.0.1:12345',pageURL:'http://127.0.0.1:12345/form',targetId:'owned-target',sessionId:'owned-session',frameId:'owned-frame',loaderId:'owned-loader'};
const text='{"name":"own 山川 🌍","color":"Green","agree":true}';
const url=scope.origin+'/api/form';
const request=()=>({method:'POST',url,postData:text,headers:{'content-type':'application/json','x-qa-token':'public-test-token'}});
const pause=(fetch='fetch-1',network='network-9'):CdpEvent=>({method:'Fetch.requestPaused',sessionId:scope.sessionId,params:{requestId:fetch,networkId:network,frameId:scope.frameId,request:request()}});
const network=():CdpEvent=>({method:'Network.requestWillBeSent',sessionId:scope.sessionId,params:{requestId:'network-9',frameId:scope.frameId,loaderId:scope.loaderId,documentURL:scope.pageURL,timestamp:100,request:request()}});
const extra=(nonce:string):CdpEvent=>({method:'Network.requestWillBeSentExtraInfo',sessionId:scope.sessionId,params:{requestId:'network-9',headers:{[REQUEST_PROOF_HEADER]:nonce}}});
function fixture(options:ConstructorParameters<typeof BrowserRequestWitness>[1]={}){
	const witness=new BrowserRequestWitness(scope,{waitMs:30,...options});witness.beginExecution('actual-execution-1',100);
	const continuation=witness.observe(pause())!;assert.equal(continuation.requiresProof,true);
	const nonce=continuation.headers.find(header=>header.name===REQUEST_PROOF_HEADER)!.value;
	const received={nonce,method:'POST',url,body:Buffer.from(text)};
	witness.permitContinuation(continuation.requestId);
	return{witness,nonce,received};
}

test('request witness joins the distinct Fetch/Network IDs and waits for real wire headers in either order',async()=>{
	for(const order of [['network','extra'],['extra','network']] as const){
		const {witness,nonce,received}=fixture();let done=false;
		const accepted=witness.accept(received).then(value=>{done=true;return value;});
		await Promise.resolve();assert.equal(done,false);
		for(const kind of order)witness.observe(kind==='network'?network():extra(nonce));
		const proof=await accepted;assert.equal(proof.fetchRequestId,'fetch-1');assert.equal(proof.networkRequestId,'network-9');assert.equal(proof.permissionExecutionId,'actual-execution-1');
		assert.equal(witness.publicRecords()[0]!.stage,'accepted');
		const publicText=JSON.stringify(witness.publicRecords());assert.ok(!publicText.includes(nonce)&&!publicText.includes(text));
		witness.committed('fetch-1');witness.endExecution('actual-execution-1');
		witness.verifyComplete();
	}
});

test('Network can precede Fetch but cannot be borrowed from a previous execution',async()=>{
	const witness=new BrowserRequestWitness(scope,{waitMs:30});witness.beginExecution('actual-execution-1',100);witness.observe(network());
	const continuation=witness.observe(pause())!,nonce=continuation.headers.find(header=>header.name===REQUEST_PROOF_HEADER)!.value;
	witness.permitContinuation(continuation.requestId);witness.observe(extra(nonce));
	await witness.accept({nonce,method:'POST',url,body:Buffer.from(text)});witness.committed('fetch-1');witness.endExecution('actual-execution-1');witness.verifyComplete();
	witness.beginExecution('actual-execution-2',200);assert.throws(()=>witness.observe(pause('fetch-2','network-9')),/repeated|redirected/);assert.throws(()=>witness.verifyComplete());
});

test('public page token, changed bytes or a different API URL cannot authorize server effects',async()=>{
	for(const change of [
		(row:ReturnType<typeof fixture>['received'])=>{row.nonce='public-test-token';},
		(row:ReturnType<typeof fixture>['received'])=>{row.nonce='0'.repeat(64);},
		(row:ReturnType<typeof fixture>['received'])=>{row.body=Buffer.from(text+' ');},
		(row:ReturnType<typeof fixture>['received'])=>{row.url=scope.origin+'/api/detail';},
		(row:ReturnType<typeof fixture>['received'])=>{row.method='GET';},
	]){
		const {witness,nonce,received}=fixture();witness.observe(network());witness.observe(extra(nonce));change(received);
		await assert.rejects(witness.accept(received));assert.notEqual(witness.publicRecords()[0]!.stage,'accepted');
	}
});

test('claiming a private proof is atomic before delayed evidence arrives',async()=>{
	const {witness,received}=fixture();const first=witness.accept(received);
	const second=witness.accept(received);const result=await Promise.allSettled([first,second]);
	assert.ok(result.every(row=>row.status==='rejected'));assert.equal(witness.publicRecords()[0]!.stage,'waiting');
});

test('cancellation and a late replay stay failed even after earlier commit records exist',async()=>{
	const stopped=fixture();const waiting=stopped.witness.accept(stopped.received);stopped.witness.stop(new Error('controller cancelled'));
	await assert.rejects(waiting,/cancelled/);assert.throws(()=>stopped.witness.verifyComplete(),/cancelled/);
	const {witness,nonce,received}=fixture();witness.observe(network());witness.observe(extra(nonce));await witness.accept(received);witness.committed('fetch-1');witness.endExecution('actual-execution-1');witness.verifyComplete();
	await assert.rejects(witness.accept(received),/already claimed/);assert.equal(witness.publicRecords()[0]!.stage,'committed');assert.throws(()=>witness.verifyComplete(),/already claimed/);
});

test('missing wire events, a dropped connection and a changed document never become accepted',async()=>{
	const missing=fixture();missing.witness.observe(network());await assert.rejects(missing.witness.accept(missing.received),/incomplete/);
	for(const event of [
		{method:'Mountains.connectionClosed',params:{}},
		{method:'Target.detachedFromTarget',params:{sessionId:scope.sessionId}},
		{method:'Page.frameNavigated',sessionId:scope.sessionId,params:{frame:{id:scope.frameId,loaderId:'replacement-loader'}}},
		{method:'Page.navigatedWithinDocument',sessionId:scope.sessionId,params:{frameId:scope.frameId,url:scope.pageURL+'#new'}},
	] satisfies CdpEvent[]){
		const {witness,received}=fixture();const pending=witness.accept(received);
		assert.throws(()=>witness.observe(event));await assert.rejects(pending);assert.notEqual(witness.publicRecords()[0]!.stage,'accepted');
	}
});

test('a modified frame, loader or mismatched Fetch/Network identity is refused',async()=>{
	for(const modify of [
		(e:CdpEvent)=>{e.params.frameId='different-frame';},
		(e:CdpEvent)=>{e.params.loaderId='different-loader';},
		(e:CdpEvent)=>{e.params.documentURL=scope.origin+'/other';},
		(e:CdpEvent)=>{e.params.redirectResponse={status:302};},
	]){
		const {witness}=fixture(),event=network();modify(event);assert.throws(()=>witness.observe(event));
	}
	const {witness,nonce}=fixture(),event=extra(nonce);event.params.requestId='fetch-1';assert.throws(()=>witness.observe(event),/identities differ/);
});

test('the witness snapshots browser observations instead of accepting later object mutation',async()=>{
	const {witness,nonce,received}=fixture(),event=network();
	(event.params.request as Record<string,unknown>).postData='a different actual payload';witness.observe(event);
	(event.params.request as Record<string,unknown>).postData=text;witness.observe(extra(nonce));
	await assert.rejects(witness.accept(received),/bodySha256|Expected values/);
});

test('server request bytes cannot change while wire events are pending',async()=>{
	const {witness,nonce,received}=fixture();const accepted=witness.accept(received);received.body[0]=32;
	witness.observe(network());witness.observe(extra(nonce));await assert.rejects(accepted,/bytes changed/);
});

test('prepared/accepted requests cannot be called committed and execution IDs cannot be reused',async()=>{
	const uncommitted=fixture();uncommitted.witness.observe(network());uncommitted.witness.observe(extra(uncommitted.nonce));await uncommitted.witness.accept(uncommitted.received);
	assert.throws(()=>uncommitted.witness.endExecution('actual-execution-1'),/committed/);
	const prepared=fixture();assert.throws(()=>prepared.witness.committed('fetch-1'));
	const orphan=new BrowserRequestWitness(scope);orphan.beginExecution('one',100);orphan.observe(network());assert.throws(()=>orphan.endExecution('one'),/matching paused request/);
	const reused=new BrowserRequestWitness(scope);reused.beginExecution('same',100);reused.endExecution('same');assert.throws(()=>reused.beginExecution('same',100),/reused/);
});

test('expired proof and reversed controller clocks remain failures',async()=>{
	let now=10;const expired=fixture({now:()=>now,ttlMs:100});expired.witness.observe(network());expired.witness.observe(extra(expired.nonce));now=111;
	await assert.rejects(expired.witness.accept(expired.received),/expired/);
	now=10;const reversed=fixture({now:()=>now});now=9;assert.throws(()=>reversed.witness.observe(network()),/clock reversed/);
});

test('event-loop blockage cannot extend the bound on missing wire evidence',async()=>{
	const {witness,nonce,received}=fixture({waitMs:5});const pending=witness.accept(received);
	const until=performance.now()+35;while(performance.now()<until){/* Deliberately prevent setTimeout from firing. */}
	witness.observe(network());witness.observe(extra(nonce));await assert.rejects(pending,/wait deadline/);
});

test('contradictory and pre-pause ExtraInfo records cannot be silently discarded',async()=>{
	const f=fixture();f.witness.observe(network());f.witness.observe(extra(f.nonce));const missing=extra(f.nonce);missing.params.headers={};
	assert.throws(()=>f.witness.observe(missing),/repeated/);await assert.rejects(f.witness.accept(f.received));
	const witness=new BrowserRequestWitness(scope,{waitMs:30});witness.beginExecution('one',100);
	const early=extra('unused');early.params.headers={};witness.observe(early);
	const continuation=witness.observe(pause())!,nonce=continuation.headers.find(row=>row.name===REQUEST_PROOF_HEADER)!.value;
	witness.permitContinuation('fetch-1');witness.observe(network());await assert.rejects(witness.accept({nonce,method:'POST',url,body:Buffer.from(text)}),/wire request proof/);
});

test('detaching the frame revokes pending proof even if the target session stays open',async()=>{
	const {witness,received}=fixture();const pending=witness.accept(received);
	assert.throws(()=>witness.observe({method:'Page.frameDetached',sessionId:scope.sessionId,params:{frameId:scope.frameId,reason:'swap'}}),/frame detached/);
	await assert.rejects(pending);assert.throws(()=>witness.verifyComplete());
});

test('an unprintable cancellation reason still revokes every pending permission',async()=>{
	const {witness,received}=fixture(),badReason=new Proxy({},{getPrototypeOf(){throw new Error('do not inspect reason');}});
	const pending=witness.accept(received);assert.doesNotThrow(()=>witness.stop(badReason));await assert.rejects(pending,/stopped/);
	assert.throws(()=>witness.beginExecution('later',100));assert.throws(()=>witness.verifyComplete());
});

test('previously unseen late events need the current trusted browser-clock lower bound',()=>{
	const witness=new BrowserRequestWitness(scope);witness.beginExecution('action-A',100);witness.endExecution('action-A');witness.beginExecution('action-B',200);
	const late=network();late.params.timestamp=150;late.params.requestId='previously-unseen-id';
	assert.throws(()=>witness.observe(late),/predates/);assert.throws(()=>witness.verifyComplete());
});

test('protocol accessors cannot change the observed request body between checks',()=>{
	const {witness}=fixture(),event=network();let reads=0;
	Object.defineProperty(event.params.request,'postData',{get(){reads++;return reads===1?'wrong bytes':text;}});
	assert.throws(()=>witness.observe(event),/accessors/);assert.equal(reads,0);
});

test('read-only API requests gain no private permission and cannot create a committed write proof',()=>{
	const witness=new BrowserRequestWitness(scope),read=pause();Object.assign(read.params.request as object,{method:'GET',url:scope.origin+'/api/state'});
	const continued=witness.observe(read)!;assert.equal(continued.requiresProof,false);assert.ok(!continued.headers.some(header=>header.name===REQUEST_PROOF_HEADER));assert.deepEqual(witness.publicRecords(),[]);
	assert.throws(()=>witness.permitContinuation(continued.requestId));
});
