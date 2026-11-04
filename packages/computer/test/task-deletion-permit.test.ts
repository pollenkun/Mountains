import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {WebShot} from '../src/web.ts';
import type {RequestProof} from './acceptance/request-witness.ts';
import {TaskDeletionPermit,type DeleteQuestion} from './acceptance/task-deletion-permit.ts';
import {sha256} from './acceptance/integrity.ts';
function fixture(){
 const scope={origin:'http://127.0.0.1:12345',pageURL:'http://127.0.0.1:12345/tasks',targetId:'target',sessionId:'session',frameId:'frame',loaderId:'loader'};
 const state={tasks:[{id:'own-1',name:'Edited first',comment:''},{id:'own-2',name:'Second',comment:''}]};
 const shot={tab:'t1',url:scope.pageURL,elements:new Map([['field',{role:'textbox',name:'Task own-1',value:'Edited first'}],['delete',{role:'button',name:'Delete own-1',value:''}]])} as unknown as WebShot;
 const question:DeleteQuestion={effect:'delete',tab:'t1',id:'own-1',name:'Edited first',question:'Delete own-1 (Edited first)?'};
 const proof:RequestProof={...scope,permissionExecutionId:'call-4',browserNotBefore:1,fetchRequestId:'fetch',networkRequestId:'network',method:'POST',url:scope.origin+'/api/tasks',bodySha256:sha256(JSON.stringify({action:'delete',id:'own-1'})),nonceSha256:sha256('nonce'),browserRequestTimestamp:2};
 const permit=new TaskDeletionPermit(scope,{tab:'t1',id:'own-1',name:'Edited first'});return{permit,scope,state,shot,question,proof};
}
test('an explicit model question grants one script answer for exactly the next original-page effect',()=>{
 const f=fixture(),answer=f.permit.issue(f.question,f.shot,f.state);assert.equal(answer.answeredBy,'test-script');assert.equal(answer.decision,'allow');
 answer.name='externally changed receipt';f.permit.beginExecution('call-4',{action:'click',id:'delete'},f.shot);const consumed=f.permit.consume(f.state.tasks[0]!,f.state,f.proof);assert.equal(consumed.name,'Edited first');assert.equal(consumed.consumed,true);f.permit.endExecution('call-4');f.permit.verifyComplete();
 assert.throws(()=>f.permit.consume(f.state.tasks[0]!,f.state,f.proof));assert.throws(()=>f.permit.issue(f.question,f.shot,f.state));
});
for(const kind of ['no-question','wrong-id','wrong-name','wrong-tab','wrong-document','wrong-execution','changed-state','wrong-body','unused-next-effect'] as const)test('individual deletion answer rejects '+kind,()=>{
 const f=fixture();if(kind==='no-question'){assert.throws(()=>f.permit.consume(f.state.tasks[0]!,f.state,f.proof));return;}
 f.permit.issue(f.question,f.shot,f.state);f.permit.beginExecution('call-4',{action:'click',id:'delete'},f.shot);
 switch(kind){case'wrong-id':f.state.tasks[0]!.id='own-2';break;case'wrong-name':f.state.tasks[0]!.name='Second';break;case'wrong-tab':f.proof.targetId='other-target';break;case'wrong-document':f.proof.loaderId='new-loader';break;case'wrong-execution':f.proof.permissionExecutionId='call-5';break;case'changed-state':f.state.tasks[1]!.comment='changed';break;case'wrong-body':f.proof.bodySha256=sha256('{}');break;case'unused-next-effect':assert.throws(()=>f.permit.endExecution('call-4'));return;}
 assert.throws(()=>f.permit.consume(f.state.tasks[0]!,f.state,f.proof));assert.throws(()=>f.permit.verifyComplete());
});
for(const kind of ['missing-specific-question','wrong-visible-name','changed-URL','future-question','wrong-question-id'] as const)test('model question cannot create an answer with '+kind,()=>{
 const f=fixture();let askedAt=Date.now();if(kind==='missing-specific-question')f.question.question='Approved this conversation';if(kind==='wrong-visible-name')f.shot.elements.get('field')!.value='Old name';if(kind==='changed-URL')f.shot.url+='#other';if(kind==='future-question')askedAt+=10000;if(kind==='wrong-question-id')f.question.id='own-2';
 assert.throws(()=>f.permit.issue(f.question,f.shot,f.state,askedAt));
});

test('one deletion answer cannot smuggle sorting, typing or another control into its next action',()=>{
 for(const steps of [[{action:'click',id:'other'},{action:'click',id:'delete'}],[{action:'key',key:'Enter'}],[{action:'click',id:'other'}]]){
  const f=fixture();f.shot.elements.set('other',{role:'button',name:'Reverse sort',value:''} as never);f.permit.issue(f.question,f.shot,f.state);assert.throws(()=>f.permit.beginExecution('call-4',{steps},f.shot));assert.throws(()=>f.permit.consume(f.state.tasks[0]!,f.state,f.proof));
 }
});
