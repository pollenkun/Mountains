import assert from 'node:assert/strict';
import {sha256} from './integrity.ts';
import {verifyWebRequestPairs} from './web-request-pairs.ts';
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Row;};
interface Expected{targetId:string;url:string;first:string;second:string;edited:string}
const task=(id:string,name:string)=>({id,name,comment:''});
function page(record:Row,expected:Expected):Row{
 const value=object(record.page);assert.equal(value.provider,'separate raw CDP read-only connection');assert.equal(value.target,expected.targetId);assert.equal(value.url,expected.url);
 assert.ok(typeof record.at==='number'&&typeof record.capturedAt==='number'&&typeof value.at==='number'&&record.at<=value.at&&value.at<=record.capturedAt);return value;
}
function rows(value:Row,wanted:readonly {id:string;name:string}[]):void{
 assert.ok(Array.isArray(value.taskRows));assert.deepEqual(value.taskRows,wanted.map(item=>({id:item.id,fields:[{label:'Task '+item.id,value:item.name}]})));
}
export function verifyWebTasksSorted(record:Row,expected:Expected):void{
 assert.deepEqual(record.web,{tasks:[task('own-1',expected.edited),task('own-2',expected.second)]});const value=page(record,expected);assert.equal(value.status,'Descending');rows(value,[{id:'own-2',name:expected.second},{id:'own-1',name:expected.edited}]);
}
/** Check all four transitions, actual inverse order before deletion, a model's
 * individual script-answered question and the final independent exact-tab DOM. */
export function verifyWebTasksReadback(input:{before:unknown;end:Row;sorted:Row},expected:Expected):void{
 const {end,sorted}=input;assert.deepEqual(input.before,{tasks:[]});assert.ok(Array.isArray(end.webEvents));
 const events=end.webEvents as Row[],outcomes=verifyWebRequestPairs(events,[
  {kind:'task-created',path:'/api/tasks',body:{action:'create',name:expected.first}},
  {kind:'task-created',path:'/api/tasks',body:{action:'create',name:expected.second}},
  {kind:'task-edited',path:'/api/tasks',body:{action:'edit',id:'own-1',name:expected.edited}},
  {kind:'task-deleted',path:'/api/tasks',body:{action:'delete',id:'own-1'}},
 ],expected.url);
 assert.deepEqual(outcomes.map(row=>row.id),['own-1','own-2','own-1','own-1']);
 const states=[{tasks:[task('own-1',expected.first)]},{tasks:[task('own-1',expected.first),task('own-2',expected.second)]},{tasks:[task('own-1',expected.edited),task('own-2',expected.second)]},{tasks:[task('own-2',expected.second)]}];
 for(let i=0;i<outcomes.length;i++)assert.deepEqual(outcomes[i]!.web,states[i]);assert.deepEqual(end.web,states[3]);verifyWebTasksSorted(sorted,expected);
 assert.ok(typeof outcomes[2]!.at==='number'&&typeof outcomes[3]!.at==='number'&&Number(sorted.at)>=Number(outcomes[2]!.at)&&Number(sorted.capturedAt)<=Number(outcomes[3]!.at));
 const question=object(end.deletionConfirmation),answer=object(question.answer),approval=object(outcomes[3]!.approval),proof=object(outcomes[3]!.proof);
 const {consumedAt,consumed,executionId,...original}=approval;assert.deepEqual(original,answer);assert.equal(consumed,true);assert.equal(executionId,proof.permissionExecutionId);assert.equal(approval.effect,'delete');assert.equal(approval.id,'own-1');assert.equal(approval.name,expected.edited);assert.equal(approval.decision,'allow');assert.equal(approval.answeredBy,'test-script');assert.ok(typeof approval.approvalId==='string'&&approval.approvalId.length>0);
 assert.equal(approval.stateSha256,sha256(JSON.stringify(states[2])));const asked=object(question.question);for(const key of ['effect','tab','id','name','question'])assert.deepEqual(approval[key],asked[key]);assert.equal(question.askedAt,approval.askedAt);
 assert.ok(typeof approval.question==='string'&&/delete|删除/i.test(approval.question)&&approval.question.includes('own-1')&&approval.question.includes(expected.edited));
 assert.ok(typeof approval.askedAt==='number'&&typeof approval.approvedAt==='number'&&typeof consumedAt==='number'&&approval.askedAt<=approval.approvedAt&&Number(sorted.capturedAt)<=approval.approvedAt&&approval.approvedAt<=consumedAt&&consumedAt<=Number(outcomes[3]!.at));
 const scope=object(approval.scope);assert.equal(scope.targetId,expected.targetId);assert.equal(scope.pageURL,expected.url);for(const key of ['targetId','sessionId','frameId','loaderId'])assert.equal(scope[key],proof[key]);
 const value=page(end,expected);assert.equal(value.status,'delete own-1');rows(value,[{id:'own-2',name:expected.second}]);assert.ok(Number(end.at)>=Number(outcomes[3]!.at));
}
