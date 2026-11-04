import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {WebShot} from '../src/web.ts';
import {signedFormService} from './acceptance/signed-form-service.ts';
import {BrowserRequestWitness,REQUEST_PROOF_HEADER} from './acceptance/request-witness.ts';
import {TaskDeletionPermit} from './acceptance/task-deletion-permit.ts';
import type {TaskState} from './acceptance/task-fixture.ts';
// Real own HTTP, signed durable records, synthetic browser/AX observations.
// This never runs Chrome/UI and cannot count as a business acceptance.
async function setup(failDeleteAck=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-tasks-component-'))),service=await signedFormService(root,'tasks'),scope={origin:service.origin,pageURL:service.url,targetId:'unit-target',sessionId:'unit-session',frameId:'unit-frame',loaderId:'unit-loader'},witness=new BrowserRequestWitness(scope),permit=new TaskDeletionPermit(scope,{tab:'t1',id:'own-1',name:'First reviewed'});let index=0,shot:WebShot|undefined;
 service.bind({accept:request=>witness.accept(request),authorizeTaskDeletion:(task,state,proof)=>permit.consume(task,state,proof),committed:proof=>{if(failDeleteAck&&index===4)throw new Error('injected deletion ack failure');witness.committed(proof.fetchRequestId);},stop:()=>witness.stop()});
 const state=async()=>await(await fetch(service.origin+'/api/state')).json() as TaskState;
 const post=async(data:unknown)=>{
  const n=++index,execution='call-'+n,body=JSON.stringify(data),url=service.origin+'/api/tasks',requestId='fetch-'+n,networkId='network-'+n,sessionId='unit-session';
  if(shot)permit.beginExecution(execution,{action:'click',id:'delete'},shot);witness.beginExecution(execution,n);
  const command=witness.observe({sessionId,method:'Fetch.requestPaused',params:{requestId,networkId,frameId:'unit-frame',request:{method:'POST',url,postData:body,headers:{}}}})!;const nonce=command.headers.find(row=>row.name===REQUEST_PROOF_HEADER)!.value;witness.permitContinuation(requestId);
  witness.observe({sessionId,method:'Network.requestWillBeSent',params:{requestId:networkId,frameId:'unit-frame',loaderId:'unit-loader',documentURL:service.url,timestamp:n,request:{method:'POST',url,postData:body}}});witness.observe({sessionId,method:'Network.requestWillBeSentExtraInfo',params:{requestId:networkId,headers:{[REQUEST_PROOF_HEADER]:nonce}}});
  const response=await fetch(url,{method:'POST',headers:{[REQUEST_PROOF_HEADER]:nonce},body}),result=await response.json() as Record<string,unknown>;
  if(response.status!==403){witness.endExecution(execution);if(shot)permit.endExecution(execution);}return{status:response.status,body:result};
 };
 const create=async()=>{assert.equal((await post({action:'create',name:'First'})).status,200);assert.equal((await post({action:'create',name:'Second'})).status,200);assert.equal((await post({action:'edit',id:'own-1',name:'First reviewed'})).status,200);};
 const ask=async()=>{const current=await state();shot={tab:'t1',url:service.url,elements:new Map([['field',{role:'textbox',name:'Task own-1',value:'First reviewed'}],['delete',{role:'button',name:'Delete own-1',value:''}]])} as unknown as WebShot;return permit.issue({effect:'delete',tab:'t1',id:'own-1',name:'First reviewed',question:'Delete own-1 (First reviewed)?'},shot,current);};
 return{service,witness,permit,state,post,create,ask,async close(){await service.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}};
}
test('task service signs each actual transition and consumes exactly the individual deletion answer',async()=>{
 const f=await setup();try{
  const html=await(await fetch(f.service.url)).text();assert.ok(html.includes('Reverse sort')&&!html.includes('qa-token'));await f.create();const answer=await f.ask();assert.equal((await f.post({action:'delete',id:'own-1'})).status,200);
  assert.deepEqual(await f.state(),{tasks:[{id:'own-2',name:'Second',comment:''}]});const rows=f.service.verify(),deleted=rows.find(row=>row.kind==='task-deleted')!;assert.equal((deleted.approval as Record<string,unknown>).approvalId,answer.approvalId);assert.equal((deleted.approval as Record<string,unknown>).consumed,true);assert.deepEqual(rows.filter(row=>String(row.kind).startsWith('task-')).map(row=>row.kind),['task-created','task-created','task-edited','task-deleted']);f.permit.verifyComplete();f.witness.verifyComplete();await f.service.close();await assert.rejects(fetch(f.service.url));
 }finally{await f.close();}
});
test('real DELETE endpoint refuses input without an individual answer, independent of button/key path',async()=>{
 const f=await setup();try{await f.create();assert.equal((await f.post({action:'delete',id:'own-1'})).status,403);assert.equal(f.service.verify().filter(row=>row.kind==='task-deleted').length,0);assert.throws(()=>f.service.assertHealthy());await assert.rejects(f.service.close());await assert.rejects(fetch(f.service.url));}finally{await f.close();}
});
test('an individual answer cannot delete the adjacent task',async()=>{
 const f=await setup();try{await f.create();await f.ask();assert.equal((await f.post({action:'delete',id:'own-2'})).status,403);assert.equal(f.service.verify().filter(row=>row.kind==='task-deleted').length,0);assert.throws(()=>f.service.assertHealthy());}finally{await f.close();}
});
test('lost deletion acknowledgment retains the durable deletion and consumed answer but fails service',async()=>{
 const f=await setup(true);try{await f.create();await f.ask();assert.equal((await f.post({action:'delete',id:'own-1'})).status,403);const deleted=f.service.verify().find(row=>row.kind==='task-deleted')!;assert.deepEqual(deleted.web,{tasks:[{id:'own-2',name:'Second',comment:''}]});assert.equal((deleted.approval as Record<string,unknown>).consumed,true);assert.throws(()=>f.service.assertHealthy());await assert.rejects(f.service.close());await assert.rejects(fetch(f.service.url));}finally{await f.close();}
});
