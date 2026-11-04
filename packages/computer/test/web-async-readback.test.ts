import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyWebAsyncReadback} from './acceptance/web-async-readback.ts';
import {sha256} from './acceptance/integrity.ts';
function evidence(){
 const expected={targetId:'owned-async-target',url:'http://127.0.0.1:12345/async',after:6100,before:6400};
 const initial={retryAttempts:0,retries:[],jobs:{}},retry={attempt:2,receipt:'server-generated-receipt'},pending={status:'pending',startedAt:1000,dueAt:6000},job={...pending,status:'cancelled',cancelledAt:2000};
 const web={retryAttempts:2,retries:[retry],jobs:{'real-job':job}},events:Record<string,unknown>[]=[{kind:'service-start',web:initial}];
 const kinds=['retry-failed','retry-succeeded','job-started','job-cancelled'],paths=['/api/retry','/api/retry','/api/job/start','/api/job/cancel'];
 const states=[{retryAttempts:1,retries:[],jobs:{}},{retryAttempts:2,retries:[retry],jobs:{}},{retryAttempts:2,retries:[retry],jobs:{'real-job':pending}},web];
 for(let i=0;i<4;i++){const proof={method:'POST',url:new URL(paths[i]!,expected.url).href,fetchRequestId:'fetch-'+i,bodySha256:sha256(JSON.stringify(i===3?{id:'real-job'}:{})),nonceSha256:sha256('nonce-'+i)};events.push({kind:'request-received',url:proof.url,bodySha256:proof.bodySha256,nonceSha256:proof.nonceSha256});events.push({kind:kinds[i],proof,web:states[i],...(i>=2?{id:'real-job'}:{}),...(i===3?{timerWasPending:true}:{})});}
 const page={at:6300,provider:'separate raw CDP read-only connection',target:expected.targetId,url:expected.url,status:'Job cancelled',text:'Failure retry and cancellation\nLoad data\nStart delayed operation\nCancel operation\nJob cancelled'};
 return{input:{before:initial,web,events,page},expected};
}
test('independent async readback requires real ordered transitions and the page beyond original deadline',()=>{const e=evidence();verifyWebAsyncReadback(e.input,e.expected);});
for(const mutation of ['early-page','wrong-tab','wrong-url','wrong-status','missing-controls','completed-job','shortened-timer','unrelated-cancel','reused-request','reused-nonce','received-after-outcome','extra-outcome','missing-request','not-cold'] as const)test('async evidence rejects '+mutation,()=>{
 const e=evidence();const {input}=e;
 switch(mutation){
  case'early-page':input.page.at=5500;break;
  case'wrong-tab':input.page.target='other-tab';break;
  case'wrong-url':input.page.url='http://127.0.0.1:12345/form';break;
  case'wrong-status':input.page.status='Job running';break;
  case'missing-controls':input.page.text='Job cancelled';break;
  case'completed-job':input.web.jobs['real-job'].status='completed';break;
  case'shortened-timer':input.web.jobs['real-job'].dueAt=1100;break;
  case'unrelated-cancel':input.events.at(-1)!.id='another-job';break;
  case'reused-request':(input.events.at(-1)!.proof as Record<string,unknown>).fetchRequestId='fetch-0';break;
  case'reused-nonce':(input.events[4]!.proof as Record<string,unknown>).nonceSha256=(input.events[2]!.proof as Record<string,unknown>).nonceSha256;break;
  case'received-after-outcome':[input.events[1],input.events[2]]=[input.events[2]!,input.events[1]!];break;
  case'extra-outcome':input.events.push({kind:'job-completed'});break;
  case'missing-request':input.events.splice(1,1);break;
  case'not-cold':input.before.retryAttempts=1;break;
 }
 assert.throws(()=>verifyWebAsyncReadback(input,e.expected));
});
