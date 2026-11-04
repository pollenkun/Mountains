import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {signedFormService} from './acceptance/signed-form-service.ts';
import {BrowserRequestWitness,REQUEST_PROOF_HEADER} from './acceptance/request-witness.ts';
import type {AsyncState} from './acceptance/async-fixture.ts';
// Own HTTP and genuine five-second timers; browser observations are synthetic.
// These are service checks, not Chrome/UI or foreground acceptance evidence.
async function setup(failCommit=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-async-component-'))),service=await signedFormService(root,'async');
 const witness=new BrowserRequestWitness({origin:service.origin,pageURL:service.url,targetId:'async-unit-target',sessionId:'async-unit-session',frameId:'async-unit-frame',loaderId:'async-unit-loader'});let index=0;
 service.bind({accept:request=>witness.accept(request),committed:proof=>{if(failCommit)throw new Error('injected commit failure');witness.committed(proof.fetchRequestId);},stop:()=>witness.stop()});
 const post=async(path:string,data:unknown)=>{
  const n=++index,execution='async-unit-'+n,fetchId='async-fetch-'+n,networkId='async-network-'+n,body=JSON.stringify(data),url=service.origin+path,sessionId='async-unit-session';witness.beginExecution(execution,n);
  const command=witness.observe({sessionId,method:'Fetch.requestPaused',params:{requestId:fetchId,networkId,frameId:'async-unit-frame',request:{method:'POST',url,postData:body,headers:{}}}})!;
  const nonce=command.headers.find(row=>row.name===REQUEST_PROOF_HEADER)!.value;witness.permitContinuation(fetchId);
  witness.observe({sessionId,method:'Network.requestWillBeSent',params:{requestId:networkId,frameId:'async-unit-frame',loaderId:'async-unit-loader',documentURL:service.url,timestamp:n,request:{method:'POST',url,postData:body}}});
  witness.observe({sessionId,method:'Network.requestWillBeSentExtraInfo',params:{requestId:networkId,headers:{[REQUEST_PROOF_HEADER]:nonce}}});
  const response=await fetch(url,{method:'POST',headers:{[REQUEST_PROOF_HEADER]:nonce},body}),result=await response.json() as Record<string,unknown>;
  if(response.status!==403)witness.endExecution(execution);return{status:response.status,body:result};
 };
 return{root,service,witness,post,state:async()=>await(await fetch(service.origin+'/api/state')).json() as AsyncState,async close(){await service.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}};
}
test('real async failure/retry and cancellation leave an uncancelled five-second timer able to complete',{timeout:12000},async()=>{
 const f=await setup();try{
  const html=await(await fetch(f.service.url)).text();assert.ok(html.includes('Load data')&&html.includes('Cancel operation'));assert.ok(!html.includes(REQUEST_PROOF_HEADER)&&!html.includes('qa-token'));
  assert.equal((await f.post('/api/retry',{})).status,503);assert.deepEqual((await f.state()).retries,[]);
  assert.equal((await f.post('/api/retry',{})).status,200);const state=await f.state();assert.equal(state.retryAttempts,2);assert.equal(state.retries.length,1);
  const start=await f.post('/api/job/start',{});assert.equal(start.status,200);const cancelledId=String(start.body.id);
  assert.equal((await f.post('/api/job/cancel',{id:cancelledId})).status,200);assert.equal((await f.state()).jobs[cancelledId]?.status,'cancelled');
  const positive=await f.post('/api/job/start',{}),completedId=String(positive.body.id),deadline=(await f.state()).jobs[completedId]!.dueAt;
  while(Date.now()<=deadline+40)await new Promise<void>(yes=>setTimeout(yes,Math.min(50,Math.max(1,deadline+41-Date.now()))));
  const end=await f.state();assert.equal(end.jobs[cancelledId]?.status,'cancelled');assert.equal(end.jobs[completedId]?.status,'completed');
  const events=f.service.verify();assert.deepEqual(events.filter(row=>row.kind==='job-completed').map(row=>row.id),[completedId]);assert.deepEqual(events.filter(row=>row.kind==='job-cancelled').map(row=>row.id),[cancelledId]);
  f.witness.verifyComplete();f.service.assertHealthy();await f.service.close();assert.ok(readFileSync(f.service.journalPath,'utf8').includes('service-stop'));
 }finally{await f.close();}
});
test('public async HTML cannot grant a private request proof',async()=>{
 const f=await setup();try{
  await fetch(f.service.url);const forged=await fetch(f.service.origin+'/api/retry',{method:'POST',headers:{[REQUEST_PROOF_HEADER]:'public-text'},body:'{}'});assert.equal(forged.status,403);
  assert.ok(!f.service.verify().some(row=>row.kind==='retry-failed'));assert.throws(()=>f.service.assertHealthy());
 }finally{await f.close();}
});
test('unknown cancellation preserves the actual pending job; fixture close is not UI cancellation',async()=>{
 const f=await setup();try{
  const start=await f.post('/api/job/start',{}),id=String(start.body.id);assert.equal((await f.post('/api/job/cancel',{id:'another-job'})).status,409);
  assert.equal((await f.state()).jobs[id]?.status,'pending');const verified=f.service.verify();assert.equal(verified.filter(row=>row.kind==='job-cancelled').length,0);await f.service.close();
  // Close destroys the HMAC key. Only the live verification above authenticates
  // these records; the post-close raw read checks that cleanup added no cancel.
  assert.throws(()=>f.service.verify());const rows=readFileSync(f.service.journalPath,'utf8').trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);assert.equal(rows.filter(row=>row.kind==='job-cancelled').length,0);assert.equal((rows.findLast(row=>row.web)?.web as AsyncState).jobs[id]?.status,'pending');
 }finally{await f.close();}
});
test('failed acknowledgment preserves durable retry effect while the service fails',async()=>{
 const f=await setup(true);try{
  assert.equal((await f.post('/api/retry',{})).status,403);const durable=f.service.verify().filter(row=>row.kind==='retry-failed');assert.equal(durable.length,1);assert.equal((durable[0]!.web as AsyncState).retryAttempts,1);assert.throws(()=>f.service.assertHealthy());
 }finally{await f.close();}
});
