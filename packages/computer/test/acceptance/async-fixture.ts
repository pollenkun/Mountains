import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {RequestProof} from './request-witness.ts';

type Job={status:'pending'|'completed'|'cancelled';startedAt:number;dueAt:number;cancelledAt?:number};
export interface AsyncState{retryAttempts:number;retries:{attempt:number;receipt:string}[];jobs:Record<string,Job>}
/** Original case7's one failure, retry and five-second delayed operation.
 * Only the service may call apply after its real request proof is accepted.
 * This is fixture behavior, never a model tool or an acceptance verdict. */
export class AsyncFixture{
 private state:AsyncState={retryAttempts:0,retries:[],jobs:{}};
 private readonly timers=new Map<string,ReturnType<typeof setTimeout>>();
 private closed=false;private failure:Error|undefined;
 private readonly append:(kind:string,fields:Record<string,unknown>)=>void;
 private readonly onFailure:()=>void;
 constructor(append:(kind:string,fields:Record<string,unknown>)=>void,onFailure:()=>void){this.append=append;this.onFailure=onFailure;}
 snapshot():AsyncState{return structuredClone(this.state);}
 assertHealthy():void{assert.ok(!this.closed&&!this.failure,'async fixture is closed or failed');}
 private save(kind:string,state:AsyncState,fields:Record<string,unknown>):void{this.append(kind,{...fields,web:structuredClone(state)});this.state=state;}
 apply(path:string,value:unknown,proof:Readonly<RequestProof>):{code:number;body:Record<string,unknown>}{
  this.assertHealthy();assert.ok(value&&typeof value==='object'&&!Array.isArray(value));const body=value as Record<string,unknown>,next=this.snapshot();
  assert.equal(proof.url.split('?')[0]?.endsWith(path),true);const fields={proof};
  if(path==='/api/retry'){
   assert.deepEqual(Object.keys(body),[]);next.retryAttempts++;const success=next.retryAttempts>1;
   if(success)next.retries.push({attempt:next.retryAttempts,receipt:randomUUID()});
   this.save(success?'retry-succeeded':'retry-failed',next,fields);
   return success?{code:200,body:{message:'Retry succeeded'}}:{code:503,body:{error:'Temporary failure. Retry once.'}};
  }
  if(path==='/api/job/start'){
   assert.deepEqual(Object.keys(body),[]);const id=randomUUID(),startedAt=Date.now(),dueAt=startedAt+5000;
   next.jobs[id]={status:'pending',startedAt,dueAt};this.save('job-started',next,{...fields,id});
   this.timers.set(id,setTimeout(()=>{
    this.timers.delete(id);if(this.closed)return;
    try{this.assertHealthy();const completed=this.snapshot();assert.equal(completed.jobs[id]?.status,'pending');completed.jobs[id]!.status='completed';this.save('job-completed',completed,{id,autonomousTimer:true});}
    catch{this.failure??=new Error('async job completion could not be recorded');try{this.onFailure();}catch{/* The fixture stays failed even if its parent notification fails. */}}
   },Math.max(1,dueAt-Date.now())));
   return{code:200,body:{id,message:'Job running'}};
  }
  assert.equal(path,'/api/job/cancel');assert.deepEqual(Object.keys(body),['id']);assert.ok(typeof body.id==='string');
  const id=body.id,job=next.jobs[id],timer=this.timers.get(id);
  if(!job||job.status!=='pending'||!timer){this.save('job-cancel-rejected',next,{...fields,id});return{code:409,body:{error:'Job is no longer pending'}};}
  job.status='cancelled';job.cancelledAt=Date.now();this.save('job-cancelled',next,{...fields,id,timerWasPending:true});clearTimeout(timer);this.timers.delete(id);
  return{code:200,body:{message:'Job cancelled'}};
 }
 close():void{if(this.closed)return;this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();}
}

// Same visible controls and business requests as web/app.js asynchronous().
// No page credential. The private CDP witness authenticates each real POST.
export const ASYNC_PAGE=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mountains Web QA</title>
<style>body{font:17px system-ui;margin:28px}button{font:inherit;padding:7px;margin:7px}</style>
<h1>Failure retry and cancellation</h1><button type="button" id="load">Load data</button>
<button type="button" id="start">Start delayed operation</button><button type="button" id="cancel">Cancel operation</button>
<p id="status" role="status">Ready</p><script>
let jobId;const status=document.querySelector('#status');
async function api(path,body){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error);status.textContent=data.message||'Done';return data;}
for(const [id,run]of [['load',()=>api('/api/retry',{})],['start',async()=>{jobId=(await api('/api/job/start',{})).id;}],['cancel',async()=>{await api('/api/job/cancel',{id:jobId});jobId=null;}]])document.getElementById(id).addEventListener('click',()=>Promise.resolve(run()).catch(error=>{status.textContent='Error: '+error.message;}));
</script></html>`;
