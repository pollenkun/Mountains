import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyWebRecordsReadback} from './acceptance/web-records-readback.ts';
import {sha256} from './acceptance/integrity.ts';
type Row=Record<string,any>;
// Pure evidence counterexamples; not live browser or signing-key proof.
function fixture(){
 const expected={id:'record-111',comment:'Edited exact target',url:'http://127.0.0.1:12345/records',targetId:'target'};
 const before={records:Array.from({length:13},(_,i)=>({id:'record-'+(101+i),name:i===2||i===10?'Quarterly report':'Record '+(101+i),amount:i+1,comment:'Initial '+(101+i)}))},after=structuredClone(before);after.records[10]!.comment=expected.comment;
 const serviceStart={kind:'service-start',at:90,web:structuredClone(before)},proof={method:'POST',url:'http://127.0.0.1:12345/api/records',targetId:'target',fetchRequestId:'fetch',nonceSha256:sha256('nonce'),bodySha256:sha256(JSON.stringify({id:expected.id,comment:expected.comment}))};
 const received={kind:'request-received',at:120,url:proof.url,nonceSha256:proof.nonceSha256,bodySha256:proof.bodySha256},outcome={kind:'record-edited',at:121,id:expected.id,proof,web:structuredClone(after)};
 const checkpoint=(phase:string,at:number,ids:string[],label:string,filter:string):Row=>({id:9,phase,at,capturedAt:at+2,web:structuredClone(before),webEvents:[structuredClone(serviceStart)],page:{provider:'separate raw CDP read-only connection',target:expected.targetId,url:expected.url,at:at+1,recordRows:before.records.filter(row=>ids.includes(row.id)).map(({id,name,comment})=>({id,name,comment})),recordPage:label,fields:[{label:'Filter records',value:filter}]}});
 const paged=checkpoint('paged',100,['record-109','record-110','record-111','record-112'],'Page 3 of 4 / 13 records',''),filtered=checkpoint('filtered',110,['record-103','record-111'],'Page 1 of 1 / 2 records','Quarterly report'),end=checkpoint('complete',130,['record-101','record-102','record-103','record-104'],'Page 1 of 4 / 13 records','');end.web=after;end.webEvents=[serviceStart,received,outcome];end.page.status='Updated '+expected.id;
 return{expected,input:{before,paged,filtered,end}};
}
test('record evidence proves real pagination/filtering before exactly one full-state update',()=>{const f=fixture();verifyWebRecordsReadback(f.input,f.expected);});
for(const kind of ['neighbor-name','neighbor-amount','target-name','target-amount','lost-row','extra-row','wrong-comment','extra-restored-write','labels-only','wrong-paged-order','wrong-paged-row','filter-by-id','wrong-filtered-order','edit-before-filter','filter-before-paged','wrong-target','wrong-request-target','wrong-url','wrong-provider','stale-page-time','bad-request-body','late-received','final-filter','final-page','final-rows','checkpoint-after-write','bad-baseline','wrong-phase'] as const)test('records evidence rejects '+kind,()=>{
 const f=fixture(),{paged,filtered,end,before}=f.input,outcome=end.webEvents[2],received=end.webEvents[1];
 switch(kind){
  case'neighbor-name':end.web.records[0].name=outcome.web.records[0].name='Tampered neighbor';break;
  case'neighbor-amount':end.web.records[0].amount=outcome.web.records[0].amount=999;break;
  case'target-name':end.web.records[10].name=outcome.web.records[10].name='Tampered target';break;
  case'target-amount':end.web.records[10].amount=outcome.web.records[10].amount=999;break;
  case'lost-row':end.web.records.pop();outcome.web.records.pop();break;
  case'extra-row':end.web.records.push({id:'extra'});outcome.web.records.push({id:'extra'});break;
  case'wrong-comment':end.web.records[10].comment=outcome.web.records[10].comment='Wrong';break;
  case'extra-restored-write':end.webEvents.push(structuredClone(received),structuredClone(outcome));break;
  case'labels-only':delete paged.page.recordRows;delete filtered.page.recordRows;paged.page.text='Page 3 of 4 / 13 records record-111';filtered.page.text='2 records record-103 record-111';break;
  case'wrong-paged-order':paged.page.recordRows.reverse();break;
  case'wrong-paged-row':paged.page.recordRows[0].id='record-101';break;
  case'filter-by-id':filtered.page.fields[0].value='record-111';break;
  case'wrong-filtered-order':filtered.page.recordRows.reverse();break;
  case'edit-before-filter':filtered.at=122;filtered.page.at=123;filtered.capturedAt=124;break;
  case'filter-before-paged':filtered.at=95;filtered.page.at=96;filtered.capturedAt=97;break;
  case'wrong-target':filtered.page.target='other';break;
  case'wrong-request-target':outcome.proof.targetId='other';break;
  case'wrong-url':end.page.url+='#other';break;
  case'wrong-provider':end.page.provider='self-reported';break;
  case'stale-page-time':end.page.at=129;break;
  case'bad-request-body':outcome.proof.bodySha256=received.bodySha256=sha256(JSON.stringify({id:'record-103',comment:f.expected.comment}));break;
  case'late-received':[end.webEvents[1],end.webEvents[2]]=[outcome,received];break;
  case'final-filter':end.page.fields[0].value='Quarterly report';break;
  case'final-page':end.page.recordPage='Page 3 of 4 / 13 records';break;
  case'final-rows':end.page.recordRows[0].name='Tampered';break;
  case'checkpoint-after-write':filtered.webEvents.push(structuredClone(outcome));break;
  case'bad-baseline':before.records[0]!.amount=999;break;
  case'wrong-phase':paged.phase='filtered';break;
 }
 assert.throws(()=>verifyWebRecordsReadback(f.input,f.expected));
});
