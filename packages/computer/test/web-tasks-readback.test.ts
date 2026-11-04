import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyWebTasksReadback} from './acceptance/web-tasks-readback.ts';
import {sha256} from './acceptance/integrity.ts';
type Row=Record<string,any>;
// Pure evidence counterexamples, not live Chrome or signing-key proof.
function fixture(){
 const expected={targetId:'target',url:'http://127.0.0.1:12345/tasks',first:'Apple',second:'Pear',edited:'Apple reviewed'};
 const task=(id:string,name:string)=>({id,name,comment:''}),states=[{tasks:[task('own-1',expected.first)]},{tasks:[task('own-1',expected.first),task('own-2',expected.second)]},{tasks:[task('own-1',expected.edited),task('own-2',expected.second)]},{tasks:[task('own-2',expected.second)]}];
 const scope={origin:'http://127.0.0.1:12345',pageURL:expected.url,targetId:'target',sessionId:'session',frameId:'frame',loaderId:'loader'};
 const question={effect:'delete',tab:'t1',id:'own-1',name:expected.edited,question:'Delete own-1 (Apple reviewed)?'},answer={...question,approvalId:'individual-answer',askedAt:155,approvedAt:170,decision:'allow',answeredBy:'test-script',authorization:'Test script answered this individual deletion question; no standing human authorization',stateSha256:sha256(JSON.stringify(states[2])),scope};
 const bodies=[{action:'create',name:expected.first},{action:'create',name:expected.second},{action:'edit',id:'own-1',name:expected.edited},{action:'delete',id:'own-1'}],kinds=['task-created','task-created','task-edited','task-deleted'],ids=['own-1','own-2','own-1','own-1'];
 const events:Row[]=[{kind:'service-start',web:{tasks:[]},at:90}];
 for(let i=0;i<4;i++){const proof={...scope,method:'POST',url:scope.origin+'/api/tasks',fetchRequestId:'fetch-'+i,permissionExecutionId:'call-'+i,bodySha256:sha256(JSON.stringify(bodies[i])),nonceSha256:sha256('nonce-'+i)};events.push({kind:'request-received',url:proof.url,bodySha256:proof.bodySha256,nonceSha256:proof.nonceSha256,at:i===3?180:100+i*10});events.push({kind:kinds[i],id:ids[i],proof,web:states[i],at:i===3?190:101+i*10,...(i===3?{approval:{...answer,executionId:proof.permissionExecutionId,consumedAt:185,consumed:true}}:{})});}
 const rows=(items:{id:string;name:string}[])=>items.map(item=>({id:item.id,fields:[{label:'Task '+item.id,value:item.name}]}));
 const page=(at:number,status:string,items:{id:string;name:string}[])=>({at,provider:'separate raw CDP read-only connection',target:expected.targetId,url:expected.url,status,taskRows:rows(items)});
 const sorted:Row={at:156,capturedAt:160,web:states[2],page:page(158,'Descending',[task('own-2',expected.second),task('own-1',expected.edited)])};
 const end:Row={at:195,capturedAt:210,web:states[3],webEvents:events,page:page(200,'delete own-1',[task('own-2',expected.second)]),deletionConfirmation:{question,askedAt:155,answer}};
 return{input:{before:{tasks:[]},end,sorted},expected};
}
test('tasks evidence proves exact CRUD, real inverse order and one effect-specific question',()=>{const f=fixture();verifyWebTasksReadback(f.input,f.expected);});
for(const kind of ['wrong-first-created','wrong-second-created','wrong-edit-id','extra-restored-edit','not-sorted','fake-descending-label','wrong-final-row','missing-question','session-permission','wrong-loader','changed-approved-state','approval-after-effect','reused-nonce','late-received','not-cold'] as const)test('task evidence rejects '+kind,()=>{
 const f=fixture(),{end,sorted}=f.input,events=end.webEvents as Row[];
 switch(kind){case'wrong-first-created':events[2]!.web.tasks[0].name='Wrong';break;case'wrong-second-created':events[4]!.web.tasks[1].name='Wrong';break;case'wrong-edit-id':events[6]!.id='own-2';break;case'extra-restored-edit':events.splice(7,0,{kind:'task-edited'});break;case'not-sorted':sorted.page.status='Ascending';break;case'fake-descending-label':sorted.page.taskRows.reverse();break;case'wrong-final-row':end.page.taskRows[0].id='own-1';break;case'missing-question':delete end.deletionConfirmation;break;case'session-permission':end.deletionConfirmation.answer.question='Use the web browser in this conversation';break;case'wrong-loader':events[8]!.approval.scope={...events[8]!.approval.scope,loaderId:'new-loader'};end.deletionConfirmation.answer.scope=events[8]!.approval.scope;break;case'changed-approved-state':events[8]!.approval.stateSha256='0'.repeat(64);end.deletionConfirmation.answer.stateSha256='0'.repeat(64);break;case'approval-after-effect':events[8]!.approval.approvedAt=191;end.deletionConfirmation.answer.approvedAt=191;break;case'reused-nonce':events[4]!.proof.nonceSha256=events[2]!.proof.nonceSha256;break;case'late-received':[events[1],events[2]]=[events[2]!,events[1]!];break;case'not-cold':f.input.before.tasks.push({} as never);break;}
 assert.throws(()=>verifyWebTasksReadback(f.input,f.expected));
});
