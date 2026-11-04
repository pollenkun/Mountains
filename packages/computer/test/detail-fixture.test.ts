import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DetailFixture,type DetailState} from './acceptance/detail-fixture.ts';
import {signedFormService} from './acceptance/signed-form-service.ts';
import {BrowserRequestWitness,REQUEST_PROOF_HEADER,type RequestProof} from './acceptance/request-witness.ts';

// Actual disposable HTTP with synthetic browser observations only. These
// tests cannot prove UI actions, dialog handling, navigation or focus safety.
async function setup(failAck=false){
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-detail-component-'))),service=await signedFormService(root,'detail');
	const pageURL=service.origin+'/detail',scope={origin:service.origin,pageURL,targetId:'unit-target',sessionId:'unit-session',frameId:'unit-frame',loaderId:'unit-loader'},witness=new BrowserRequestWitness(scope);let index=0;
	service.bind({accept:request=>witness.accept(request),committed:proof=>{if(failAck)throw new Error('injected ack failure');witness.committed(proof.fetchRequestId);},stop:()=>witness.stop()});
	const state=async()=>await(await fetch(service.origin+'/api/state')).json() as DetailState;
	const post=async(data:unknown)=>{
		const n=++index,execution='call-'+n,body=JSON.stringify(data),url=service.origin+'/api/detail',requestId='fetch-'+n,networkId='network-'+n,sessionId='unit-session';witness.beginExecution(execution,n);
		const paused=witness.observe({sessionId,method:'Fetch.requestPaused',params:{requestId,networkId,frameId:'unit-frame',request:{method:'POST',url,postData:body,headers:{}}}})!;
		const nonce=paused.headers.find(row=>row.name===REQUEST_PROOF_HEADER)!.value;witness.permitContinuation(requestId);
		witness.observe({sessionId,method:'Network.requestWillBeSent',params:{requestId:networkId,frameId:'unit-frame',loaderId:'unit-loader',documentURL:pageURL,timestamp:n,request:{method:'POST',url,postData:body}}});
		witness.observe({sessionId,method:'Network.requestWillBeSentExtraInfo',params:{requestId:networkId,headers:{[REQUEST_PROOF_HEADER]:nonce}}});
		const response=await fetch(url,{method:'POST',headers:{[REQUEST_PROOF_HEADER]:nonce},body}),result=await response.json();if(response.status!==403)witness.endExecution(execution);return{status:response.status,body:result};
	};
	return{root,service,witness,state,post,async close(){await service.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}};
}
test('detail baseline and snapshots keep the original value and cannot mutate live state',()=>{
	const fixture=new DetailFixture(()=>{}),snapshot=fixture.snapshot();assert.deepEqual(snapshot,{detail:'Original detail'});snapshot.detail='Changed';assert.deepEqual(fixture.snapshot(),{detail:'Original detail'});
});
test('detail malformed bodies and failed durable append cannot publish state',()=>{
	let writes=0;const fixture=new DetailFixture(()=>{writes++;throw new Error('injected fsync failure');}),proof={url:'http://127.0.0.1:12345/api/detail'} as RequestProof;
	for(const value of [null,[],{},'Changed',{value:1},{value:'Changed',other:'extra'}])assert.throws(()=>fixture.apply(value,proof));assert.equal(writes,0);
	assert.throws(()=>fixture.apply({value:'Changed'},proof),/fsync failure/);assert.equal(writes,1);assert.deepEqual(fixture.snapshot(),{detail:'Original detail'});
});
test('owned HTTP starts at the other real form page and serves original detail controls without page proof tokens',async()=>{
	const f=await setup();try{
		assert.equal(f.service.url,f.service.origin+'/form');assert.deepEqual(await f.state(),{detail:'Original detail'});
		const form=await(await fetch(f.service.url)).text(),detail=await(await fetch(f.service.origin+'/detail')).text();
		assert.ok(form.includes('<h1>Form validation</h1>')&&form.includes('<a href="/detail">Detail</a>'));
		for(const text of ['Detail value','Edit detail','Save detail','Cancel edit','Refresh page','Test delayed focus',"confirm('Save this test detail?')","alert('Saved test detail')",'window.focus();value.input.focus();',"status.textContent='Edit cancelled'",'},300);'])assert.ok(detail.includes(text),text);
		assert.ok(!detail.includes('qa-token')&&!detail.includes(REQUEST_PROOF_HEADER));assert.equal((await fetch(f.service.origin+'/not-this-fixture')).status,404);
		assert.deepEqual(f.service.verify().map(row=>row.kind),['service-start']);f.witness.verifyComplete();
	}finally{await f.close();}
});
test('exact signed detail write is durable, independently readable and survives fresh GETs until service closes',async()=>{
	const f=await setup();try{
		assert.deepEqual(await f.post({value:'Own detail 山川'}),{status:200,body:{message:'Detail saved'}});
		assert.deepEqual(await f.state(),{detail:'Own detail 山川'});await fetch(f.service.origin+'/detail');assert.deepEqual(await f.state(),{detail:'Own detail 山川'});
		const rows=f.service.verify();assert.deepEqual(rows.map(row=>row.kind),['service-start','request-received','detail-saved']);assert.deepEqual(rows[2]!.web,{detail:'Own detail 山川'});f.witness.verifyComplete();await f.service.close();await assert.rejects(fetch(f.service.url));
	}finally{await f.close();}
});
test('unproved detail writes cannot change the original state',async()=>{
	const f=await setup();try{
		const response=await fetch(f.service.origin+'/api/detail',{method:'POST',body:JSON.stringify({value:'Unproved'})});assert.equal(response.status,403);
		assert.equal(f.service.verify().filter(row=>row.kind==='detail-saved').length,0);assert.throws(()=>f.service.assertHealthy());
	}finally{await f.close();}
});
test('lost acknowledgment keeps the real detail effect but makes this run fail',async()=>{
	const f=await setup(true);try{
		assert.equal((await f.post({value:'Durable before lost ack'})).status,403);assert.deepEqual(f.service.verify().find(row=>row.kind==='detail-saved')!.web,{detail:'Durable before lost ack'});
		assert.throws(()=>f.service.assertHealthy());await assert.rejects(f.service.close());await assert.rejects(fetch(f.service.url));
	}finally{await f.close();}
});
