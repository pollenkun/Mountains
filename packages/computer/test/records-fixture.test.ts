import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {RecordsFixture,type RecordsState} from './acceptance/records-fixture.ts';
import {signedFormService} from './acceptance/signed-form-service.ts';
import {BrowserRequestWitness,REQUEST_PROOF_HEADER,type RequestProof} from './acceptance/request-witness.ts';
// Real own HTTP but synthetic CDP observations. These are component checks,
// never live Chrome, model-driven business completion or focus evidence.
async function setup(failAck=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-records-component-'))),service=await signedFormService(root,'records'),scope={origin:service.origin,pageURL:service.url,targetId:'unit-target',sessionId:'unit-session',frameId:'unit-frame',loaderId:'unit-loader'},witness=new BrowserRequestWitness(scope);let index=0;
 service.bind({accept:request=>witness.accept(request),committed:proof=>{if(failAck)throw new Error('injected ack failure');witness.committed(proof.fetchRequestId);},stop:()=>witness.stop()});
 const state=async()=>await(await fetch(service.origin+'/api/state')).json() as RecordsState;
 const post=async(data:unknown)=>{const n=++index,execution='call-'+n,body=JSON.stringify(data),url=service.origin+'/api/records',requestId='fetch-'+n,networkId='network-'+n,sessionId='unit-session';witness.beginExecution(execution,n);
  const command=witness.observe({sessionId,method:'Fetch.requestPaused',params:{requestId,networkId,frameId:'unit-frame',request:{method:'POST',url,postData:body,headers:{}}}})!;const nonce=command.headers.find(row=>row.name===REQUEST_PROOF_HEADER)!.value;witness.permitContinuation(requestId);
  witness.observe({sessionId,method:'Network.requestWillBeSent',params:{requestId:networkId,frameId:'unit-frame',loaderId:'unit-loader',documentURL:service.url,timestamp:n,request:{method:'POST',url,postData:body}}});witness.observe({sessionId,method:'Network.requestWillBeSentExtraInfo',params:{requestId:networkId,headers:{[REQUEST_PROOF_HEADER]:nonce}}});
  const response=await fetch(url,{method:'POST',headers:{[REQUEST_PROOF_HEADER]:nonce},body}),result=await response.json();if(response.status!==403)witness.endExecution(execution);return{status:response.status,body:result};
 };
 return{root,service,witness,state,post,async close(){await service.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}};
}
test('record dataset and snapshots retain all original metadata without exposing live state',()=>{
 const f=new RecordsFixture(()=>{}),state=f.snapshot();assert.equal(state.records.length,13);assert.deepEqual(state.records.filter(row=>row.name==='Quarterly report').map(row=>row.id),['record-103','record-111']);assert.deepEqual(state.records.map(row=>row.amount),Array.from({length:13},(_,i)=>i+1));state.records[0]!.name='Changed';assert.equal(f.snapshot().records[0]!.name,'Record 101');
});
test('record journal failure cannot publish new state and malformed shapes cannot modify metadata',()=>{
 let writes=0;const f=new RecordsFixture(()=>{writes++;throw new Error('injected journal failure');}),before=f.snapshot(),proof={url:'http://127.0.0.1:1234/api/records'} as RequestProof;
 assert.throws(()=>f.apply({id:'record-111',comment:'Changed'},proof));assert.deepEqual(f.snapshot(),before);assert.equal(writes,1);
 for(const data of [{id:111,comment:'Changed'},{id:'record-111',comment:3},{id:'record-111',comment:'Changed',name:'Changed'},[],null])assert.throws(()=>f.apply(data,proof));assert.equal(writes,1);assert.deepEqual(f.snapshot(),before);
});
test('real signed record endpoint changes only one comment and closes the exact service',async()=>{
 const f=await setup();try{const before=await f.state(),html=await(await fetch(f.service.url)).text();assert.ok(html.includes('Next page')&&html.includes('Filter records')&&!html.includes('qa-token'));assert.equal((await f.post({id:'record-111',comment:'Edited exact item'})).status,200);
  const expected=structuredClone(before);expected.records[10]!.comment='Edited exact item';assert.deepEqual(await f.state(),expected);const rows=f.service.verify();assert.deepEqual(rows.map(row=>row.kind),['service-start','request-received','record-edited']);assert.deepEqual(rows[2]!.web,expected);f.witness.verifyComplete();await f.service.close();await assert.rejects(fetch(f.service.url));
 }finally{await f.close();}
});
test('unknown record cannot fall back to a selected or adjacent row',async()=>{
 const f=await setup();try{const before=await f.state();assert.equal((await f.post({id:'record-999',comment:'Wrong'})).status,404);assert.deepEqual(await f.state(),before);assert.equal(f.service.verify().find(row=>row.kind==='record-rejected')!.id,'record-999');f.witness.verifyComplete();}finally{await f.close();}
});
test('lost record acknowledgment retains durable actual effect but fails and closes service',async()=>{
 const f=await setup(true);try{assert.equal((await f.post({id:'record-111',comment:'Committed before lost ack'})).status,403);const changed=f.service.verify().find(row=>row.kind==='record-edited')!.web as RecordsState;assert.equal(changed.records[10]!.comment,'Committed before lost ack');assert.throws(()=>f.service.assertHealthy());await assert.rejects(f.service.close());await assert.rejects(fetch(f.service.url));}finally{await f.close();}
});
test('record endpoint rejects a request without private browser proof before any edit',async()=>{
 const f=await setup();try{const response=await fetch(f.service.origin+'/api/records',{method:'POST',body:JSON.stringify({id:'record-111',comment:'Unproved'})});assert.equal(response.status,403);assert.equal(f.service.verify().filter(row=>row.kind==='record-edited').length,0);assert.throws(()=>f.service.assertHealthy());}finally{await f.close();}
});
