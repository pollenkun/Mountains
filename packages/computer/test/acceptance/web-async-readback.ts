import assert from 'node:assert/strict';
import {verifyWebRequestPairs} from './web-request-pairs.ts';
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Row;};
/** Signed browser/server identity and live HMAC validation remain the parent's
 * responsibility. This independently checks the unchanged case7 results and
 * a separate exact-tab DOM observation after the original timer deadline. */
export function verifyWebAsyncReadback(input:{before:unknown;web:unknown;events:readonly Row[];page:Row},expected:{targetId:string;url:string;after:number;before:number}):void{
 const {events,page}=input,initial=object(input.before),web=object(input.web);
 assert.deepEqual(initial,{retryAttempts:0,retries:[],jobs:{}});assert.equal(web.retryAttempts,2);assert.ok(Array.isArray(web.retries)&&web.retries.length===1);
 const retry=object(web.retries[0]);assert.equal(retry.attempt,2);assert.ok(typeof retry.receipt==='string'&&retry.receipt.length>0);
 const jobs=object(web.jobs);assert.equal(Object.keys(jobs).length,1);const id=Object.keys(jobs)[0]!,job=object(jobs[id]);assert.equal(job.status,'cancelled');
 for(const key of ['startedAt','dueAt','cancelledAt'])assert.ok(typeof job[key]==='number'&&Number.isFinite(job[key]));
 assert.equal(Number(job.dueAt)-Number(job.startedAt),5000,'original delayed operation was changed');assert.ok(Number(job.cancelledAt)>=Number(job.startedAt)&&Number(job.cancelledAt)<Number(job.dueAt),'cancellation was not before original completion');
 const outcomes=verifyWebRequestPairs(events,[{kind:'retry-failed',path:'/api/retry',body:{}},{kind:'retry-succeeded',path:'/api/retry',body:{}},{kind:'job-started',path:'/api/job/start',body:{}},{kind:'job-cancelled',path:'/api/job/cancel',body:{id}}],expected.url);
 const failed=object(outcomes[0]!.web),succeeded=object(outcomes[1]!.web),started=object(outcomes[2]!.web),cancelled=object(outcomes[3]!.web);
 assert.deepEqual(failed,{retryAttempts:1,retries:[],jobs:{}});assert.deepEqual(succeeded,{retryAttempts:2,retries:web.retries,jobs:{}});
 const pending:Row={...job,status:'pending'};delete pending.cancelledAt;assert.deepEqual(started,{retryAttempts:2,retries:web.retries,jobs:{[id]:pending}});assert.deepEqual(cancelled,web);assert.equal(outcomes[2]!.id,id);assert.equal(outcomes[3]!.id,id);assert.equal(outcomes[3]!.timerWasPending,true);
 assert.equal(page.provider,'separate raw CDP read-only connection');assert.ok(expected.targetId.length>0);assert.equal(page.target,expected.targetId);assert.equal(page.url,expected.url);
 assert.ok(Number.isFinite(expected.after)&&Number.isFinite(expected.before)&&expected.after<=expected.before);assert.ok(typeof page.at==='number'&&page.at>=expected.after&&page.at<=expected.before&&page.at>=Number(job.dueAt),'page was read before the original timer could complete');
 assert.equal(page.status,'Job cancelled');assert.ok(typeof page.text==='string');for(const text of ['Failure retry and cancellation','Load data','Start delayed operation','Cancel operation'])assert.ok(page.text.includes(text));
}
