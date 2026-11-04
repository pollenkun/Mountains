import assert from 'node:assert/strict';
import {verifyWebRequestPairs} from './web-request-pairs.ts';
type Row=Record<string,unknown>;
interface Expected{targetId:string;url:string;id:string;comment:string}
// Independently fixed original baseline, including fields not displayed by UI.
const names=['Record 101','Record 102','Quarterly report','Record 104','Record 105','Record 106','Record 107','Record 108','Record 109','Record 110','Quarterly report','Record 112','Record 113'];
const original=()=>({records:names.map((name,index)=>({id:'record-'+(101+index),name,amount:index+1,comment:'Initial '+(101+index)}))});
const object=(value:unknown):Row=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Row;};
function page(record:Row,expected:Expected):Row{
 const value=object(record.page);assert.equal(value.provider,'separate raw CDP read-only connection');assert.equal(value.target,expected.targetId);assert.equal(value.url,expected.url);assert.ok(typeof record.at==='number'&&typeof record.capturedAt==='number'&&typeof value.at==='number'&&record.at<=value.at&&value.at<=record.capturedAt);return value;
}
function layout(value:Row,ids:readonly string[],label:string,filter:string,comment?:string):void{
 const wanted=original().records.filter(row=>ids.includes(row.id)).map(row=>({id:row.id,name:row.name,comment:comment!==undefined&&row.id==='record-111'?comment:row.comment}));
 assert.deepEqual(value.recordRows,wanted);assert.equal(value.recordPage,label);assert.ok(Array.isArray(value.fields));const fields=(value.fields as Row[]).filter(field=>field.label==='Filter records');assert.equal(fields.length,1);assert.equal(fields[0]!.value,filter);
}
export function verifyWebRecordsPhase(record:Row,phase:'paged'|'filtered',expected:Expected):void{
 assert.equal(record.id,9);assert.equal(record.phase,phase);assert.equal(expected.id,'record-111');assert.deepEqual(record.web,original());assert.ok(Array.isArray(record.webEvents));assert.equal(record.webEvents.length,1);assert.equal((record.webEvents[0] as Row).kind,'service-start');assert.deepEqual((record.webEvents[0] as Row).web,original());
 const value=page(record,expected);if(phase==='paged')layout(value,['record-109','record-110','record-111','record-112'],'Page 3 of 4 / 13 records','');
 else layout(value,['record-103','record-111'],'Page 1 of 1 / 2 records','Quarterly report');
}
/** Original 13 rows in full, two actual pre-write DOM checkpoints and exactly
 * one browser-proven mutation. Labels alone cannot prove pagination/filtering. */
export function verifyWebRecordsReadback(input:{before:unknown;paged:Row;filtered:Row;end:Row},expected:Expected):void{
 const {paged,filtered,end}=input;assert.deepEqual(input.before,original());verifyWebRecordsPhase(paged,'paged',expected);verifyWebRecordsPhase(filtered,'filtered',expected);
 assert.ok(Number(paged.capturedAt)<=Number(filtered.at));const target=(object(paged.page).recordRows as Row[]).find(row=>row.id===expected.id);assert.ok(target);const filter=((object(filtered.page).fields as Row[]).filter(row=>row.label==='Filter records'))[0];assert.equal(filter!.value,target.name);
 assert.ok(Array.isArray(end.webEvents));const events=end.webEvents as Row[],outcomes=verifyWebRequestPairs(events,[{kind:'record-edited',path:'/api/records',body:{id:expected.id,comment:expected.comment}}],expected.url);assert.equal(outcomes[0]!.id,expected.id);
 assert.equal(object(outcomes[0]!.proof).targetId,expected.targetId);
 const next=original();next.records.find(row=>row.id===expected.id)!.comment=expected.comment;assert.deepEqual(outcomes[0]!.web,next);assert.deepEqual(end.web,next);
 const received=events.find(row=>row.kind==='request-received')!;assert.ok(typeof received.at==='number'&&typeof outcomes[0]!.at==='number'&&Number(filtered.capturedAt)<=received.at&&received.at<=Number(outcomes[0]!.at)&&Number(outcomes[0]!.at)<=Number(end.at));
 const value=page(end,expected);layout(value,['record-101','record-102','record-103','record-104'],'Page 1 of 4 / 13 records','');assert.equal(value.status,'Updated '+expected.id);
}
