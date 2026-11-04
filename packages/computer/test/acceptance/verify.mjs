import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {toolTrace} from './trace.mjs';
import {decodePng} from '../../src/image.ts';
import {verifyNativeCase5} from './native-case5.ts';
import {verifyWebFormReadback,verifyWebPageCheckpoint} from './web-form-readback.ts';
import {readPrivateWebTarget} from './web-verifier-channel.ts';
import {verifyWebAsyncReadback} from './web-async-readback.ts';
import {verifyWebTasksReadback} from './web-tasks-readback.ts';
import {verifyWebRecordsReadback} from './web-records-readback.ts';
import {verifyWebDetailReadback} from './web-detail-readback.ts';

const [rootArg,idArg]=process.argv.slice(2),root=resolve(rootArg||''),id=Number(idArg);
if(!rootArg||!Number.isInteger(id)||id<1||id>20)throw new Error('usage: verify.mjs root case-number');
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')),v=manifest.values;
const path=phase=>join(root,'evidence',`case-${String(id).padStart(2,'0')}-${phase}.json`);
const readEvidence=phase=>JSON.parse(readFileSync(path(phase),'utf8'));
const end=readEvidence('complete'),start=readEvidence('before');
let pinnedTarget,webOrigin;
const validateWebPhase=(record,phase)=>verifyWebPageCheckpoint(record,{caseId:id,phase,targetId:pinnedTarget.targetId,origin:webOrigin,after:start.at,before:phase==='complete'?end.capturedAt:end.at});
const evidence=phase=>{const record=readEvidence(phase);if(id>=6&&id<=10)validateWebPhase(record,phase);return record;};
const checking=process.argv.includes('--check');
const runner=process.argv[process.argv.indexOf('--runner')+1];
assert.ok(process.argv.includes('--runner')&&['self','deepseek'].includes(runner),'pass --runner self or --runner deepseek');
const native=end.native,web=checking?JSON.parse(readFileSync(join(root,'web/web-state.json'),'utf8')):end.web,events=end.nativeEvents.filter(event=>event.at*1000>=start.at);
const get=name=>{assert.ok(native[name],'missing native save '+name);const actual=JSON.parse(readFileSync(join(root,'native',name),'utf8'));assert.deepEqual(actual,native[name],'saved native artifact changed after checkpoint');return actual;};
const equalFields=(actual,expected)=>{for(const [key,value]of Object.entries(expected))assert.deepEqual(actual[key],value,'field '+key);};
const saved=tag=>events.filter(event=>event.kind==='saved'&&event.tag===tag);
const flat=record=>(record.app?.windows??[]).flatMap(window=>window.entries);
const text=record=>flat(record).map(entry=>[entry.name,entry.description,entry.value].filter(value=>typeof value==='string').join(' ')).join('\n');
const ownPrefix=()=>assert.ok(text(end).includes(manifest.prefix),'no own test object in final window');
const calls=toolTrace(root,runner).filter(call=>call.at>=start.at&&call.end<=end.at);
const labels=entry=>[entry.name,entry.description,entry.value].filter(value=>typeof value==='string');
const selectedContainer=(record,name)=>{
 const entries=flat(record),target=entries.find(entry=>labels(entry).includes(name));
 if(!target)return false;
 return entries.some(entry=>entry.selected===true&&(target.path===entry.path||target.path.startsWith(entry.path+'/')));
};
const unfiltered=record=>!flat(record).some(entry=>entry.role==='AXSearchField'&&typeof entry.value==='string'&&entry.value.trim());
const deletedByUI=()=>calls.some(call=>call.tool==='screen_act'&&call.result.details.dispatched===true&&[call.args,...(call.args.steps??[])].some(step=>step.action==='menu'&&/(?:^|[>›/])\s*(?:删除(?:日历|列表|备忘录|笔记)?|移到废纸篓|delete(?: calendar| list| note)?|move to trash)(?:…|\.\.\.)?\s*$/i.test(step.text??'')||step.action==='key'&&/^(?:cmd\+)?(?:Backspace|Delete)$/i.test(step.key??'')));
const calendarInventory=record=>{
 const entries=flat(record),outlines=entries.filter(entry=>entry.role==='AXOutline');
 assert.equal(outlines.length,1,'Calendar sidebar must be fully available');
 const sidebar=entries.filter(entry=>entry.path.startsWith(outlines[0].path+'/'));
 assert.ok(!sidebar.some(entry=>entry.expanded===false),'expand Calendar sidebar groups before independent inventory');
 const rows=sidebar.filter(entry=>entry.role==='AXRow');
 const calendars=sidebar.filter(entry=>entry.role==='AXTextField'&&typeof entry.value==='string'&&entry.value.trim()).map(field=>{
  const row=rows.filter(row=>field.path.startsWith(row.path+'/')).sort((a,b)=>b.path.length-a.path.length)[0];
  assert.ok(row,'calendar name has no sidebar row');
  const boxes=sidebar.filter(entry=>entry.path.startsWith(row.path+'/')&&entry.role==='AXCheckBox');
  assert.equal(boxes.length,1,'calendar row checkbox is ambiguous');
  return {name:field.value,account:field.description??'',checked:boxes[0].value};
 });
 assert.ok(calendars.length>0,'empty sidebar is not proof of deletion');
 return calendars.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
};
let checks=[];
try{
 if([12,15,16,19].includes(id))throw new Error('Cannot verify account-backed office data: local account isolation, full original-object inventory and exact-ID deletion evidence are not implemented');
 if(id>=6&&id<=10){
  pinnedTarget=await readPrivateWebTarget({root,caseId:id});
  assert.equal(start.id,id,'cold baseline belongs to another case');assert.equal(start.phase,'before');
  assert.ok(Number.isFinite(start.at)&&start.at>=0&&start.at<=end.at,'invalid cold baseline interval');
  const server=JSON.parse(readFileSync(join(root,'web/server.json'),'utf8')),site=new URL(server.url);
  assert.equal(site.protocol,'http:');assert.equal(site.hostname,'127.0.0.1');assert.equal(site.origin,server.url);webOrigin=site.origin;
  validateWebPhase(end,'complete');
 }
 switch(id){
 case 1:
  equalFields(get('case01.json'),v.native01);assert.equal(saved('case01').length,1);
  equalFields(native['state-B.json'],start.native['state-B.json']);checks.push('saved fields and untouched B');break;
 case 2:{
  for(const [tag,quantity]of [['case02-min',1],['case02-max',9]]){equalFields(get(tag+'.json'),{...v.native02,quantity});assert.equal(saved(tag).length,1);}
  const invalid=events.filter(event=>event.kind==='invalid');
  assert.deepEqual(invalid.map(event=>event.reason),['missing-name','quantity-range','quantity-range']);
  assert.equal(invalid[0].name.trim(),'','name was not actually missing');
  assert.deepEqual(invalid.slice(1).map(event=>({name:event.name,quantity:event.quantity})),[{name:v.native02.name,quantity:'0'},{name:v.native02.name,quantity:'10'}],'both distinct invalid boundaries must actually be attempted');
  assert.equal(events.filter(event=>event.kind==='saved').length,2);checks.push('missing/0/10 refused, 1/9 persisted');break;
 }
 case 3:
  for(const tag of ['case03-single','case03-batch']){equalFields(get(tag+'.json'),v.native03);assert.equal(saved(tag).length,1);}
  assert.equal(events.filter(event=>event.kind==='shortcut-save').length,2);
  assert.equal(events.filter(event=>event.kind==='unrelated-menu-opened').length,0);
  assert.ok(calls.some(call=>call.tool==='screen_act'&&call.args.steps?.some(step=>step.action==='key'&&/^(cmd|meta)\+s$/i.test(step.key))),'missing batch shortcut execution');
  assert.ok(calls.some(call=>call.tool==='screen_act'&&call.args.action==='key'&&/^(cmd|meta)\+s$/i.test(call.args.key??'')),'missing single shortcut execution');
  checks.push('single/batch exact saved content, genuine shortcut, unrelated menu unopened');break;
 case 4:{
  const state=native['state-A.json'],actual=Object.fromEntries(state.rows.map(item=>[item.id,item.done]));
  assert.deepEqual(actual,{'row-A':true,'row-B':true,'row-C':false});
  assert.deepEqual(events.filter(event=>event.kind==='toggle').map(event=>event.item),['row-A','row-B']);
  checks.push('only correct rows toggled in the requested order');break;
 }
 case 5:
  verifyNativeCase5({A:start.native['state-A.json'],B:start.native['state-B.json']},{A:native['state-A.json'],B:native['state-B.json']},events,v.native05);
  checks.push('same titled windows separated, exact panel cancelled, neither document retains a panel and nothing saved');break;
 case 6:
  assert.equal(web.forms.length,1);equalFields(web.forms[0],v.web06);
  assert.equal(end.webEvents.filter(event=>event.kind==='form-invalid').length,1);
  {const server=JSON.parse(readFileSync(join(root,'web/server.json'),'utf8'));
  verifyWebFormReadback(end.page??{},{...v.web06,targetId:pinnedTarget.targetId,url:server.url+'/form',after:Math.max(start.at,...calls.map(call=>call.end)),before:end.capturedAt});}
  checks.push('one rejected and one exact valid server record; independent pinned page fields and submission status agree');break;
 case 7:
  verifyWebAsyncReadback({before:start.web,web,events:end.webEvents,page:end.page??{}},{targetId:pinnedTarget.targetId,url:webOrigin+'/async',after:Math.max(start.at,...calls.map(call=>call.end)),before:end.capturedAt});
  checks.push('exact failed/retry/start/cancel request outcomes; independent page remains cancelled past original timer deadline');break;
 case 8:
  verifyWebTasksReadback({before:start.web,end,sorted:evidence('sorted')},{targetId:pinnedTarget.targetId,url:webOrigin+'/tasks',...v.web08});checks.push('two exact creations, correct edit, real inverse DOM order, individually approved exact deletion and final untouched second task');break;
 case 9:{
  verifyWebRecordsReadback({before:start.web,paged:evidence('paged'),filtered:evidence('filtered'),end},{targetId:pinnedTarget.targetId,url:webOrigin+'/records',...v.web09});
  checks.push('all original fields preserved except one exact target comment; real ordered pre-write pagination/filter checkpoints and independent cleared page; one matched actual POST');break;
 }
 case 10:
  verifyWebDetailReadback({before:start.web,cancelled:evidence('cancelled'),refreshed:evidence('refreshed'),escaped:evidence('escaped'),end,calls},{targetId:pinnedTarget.targetId,url:webOrigin+'/detail',...v.web10});
  checks.push('real observed confirm cancel/accept and alert, exactly one retained old-document request, back/forward/new-loader reload, independent persistence and Escape, delayed focus result and uninterrupted exception observation');break;
 case 11:
  assert.equal(readFileSync(join(root,'workspace/case11.txt'),'utf8'),v.text);assert.equal(end.files['case11.txt']?.text,v.text);assert.ok(text(end).includes(v.text));checks.push('real file and raw AX text match');break;
 case 12:{
  const edited=evidence('edited');assert.ok(text(edited).includes(v.noteFirst));assert.ok(text(edited).includes(v.noteSecond));
  assert.ok(text(edited).includes(v.noteTitle));assert.ok(!text(end).includes(v.noteTitle));
  assert.ok(selectedContainer(end,v.notesFolder),'own Notes folder must remain selected');assert.ok(unfiltered(end),'Notes search must be empty');assert.ok(deletedByUI(),'missing actual delete operation');checks.push('own note actual edited content and deletion');break;
 }
 case 13:
  assert.equal(existsSync(join(root,'workspace/move-me.txt')),false);assert.equal(createHash('sha256').update(readFileSync(join(root,'workspace/已改名/move-me.txt'))).digest('hex'),manifest.assets.moveSha256);assert.equal(end.files['move-me.txt'],undefined);assert.equal(end.files['已改名/move-me.txt']?.sha256,manifest.assets.moveSha256);
  checks.push('same file moved and source removed');break;
 case 14:{
  const image=decodePng(readFileSync(join(root,'workspace','rotate.png')));assert.equal(image.width,160);assert.equal(image.height,320);
  for(let y=0;y<320;y++)for(let x=0;x<160;x++){
   const sourceX=319-y,sourceY=x,offset=(y*160+x)*4;
   assert.deepEqual([...image.rgba.subarray(offset,offset+4)],[sourceX%256,sourceY,(sourceX+3*sourceY)%256,255]);
  }
  checks.push('every decoded pixel rotated counterclockwise');break;
 }
 case 15:
  // Dates need independent NSDate serialization, provided by the raw AX checkpoint extension.
  {const baseline=evidence('baseline'),persisted=evidence('persisted');assert.ok(text(persisted).includes(v.event)&&text(persisted).includes(v.calendar),'persisted event must belong to own calendar');
  assert.equal(persisted.calendarDates?.start,v.eventEditedStart,'independently persisted event time');
  assert.equal(persisted.calendarDates?.end,v.eventEditedEnd,'event duration changed unintentionally');
  const beforeDelete=evidence('before-delete');assert.ok(selectedContainer(beforeDelete,v.calendar),'own calendar must be selected before deletion');assert.ok(deletedByUI(),'missing actual Calendar deletion operation');
  const original=calendarInventory(baseline);assert.ok(!original.some(item=>item.name===v.calendar));
  assert.deepEqual(calendarInventory(beforeDelete).filter(item=>item.name!==v.calendar),original,'pre-existing calendars changed');
  assert.deepEqual(calendarInventory(end),original,'calendar removal must preserve the original full sidebar');
  assert.ok(unfiltered(end));
  assert.ok(!text(end).includes(v.event));assert.ok(!text(end).includes(v.calendar));checks.push('persisted edited date and own calendar/event removal');}break;
 case 16:{
  const completed=evidence('completed'),rows=completed.reminderStates;
  assert.deepEqual(rows,v.reminderItems.map((name,index)=>({name,completed:index<2})));
  assert.ok(!text(end).includes(v.reminders));
  assert.ok(selectedContainer(end,v.safeReminders),'own empty reserve must be selected after deletion');assert.ok(unfiltered(end));assert.ok(deletedByUI());checks.push('three independent states and own list deletion');break;
 }
 case 17:{
  const pdf=evidence('pdf');
  for(const [path,hash]of Object.entries(pdf.source?.hashes??{}))assert.equal(createHash('sha256').update(readFileSync(join(root,path))).digest('hex'),hash,'saved source changed');
  assert.equal(createHash('sha256').update(readFileSync(join(root,'workspace/case17.pdf'))).digest('hex'),end.files['case17.pdf']?.sha256,'PDF changed after checkpoint');
  assert.equal(pdf.pdf?.title,v.richTitle);assert.deepEqual(pdf.pdf?.table,v.table);
  assert.ok(pdf.pdf?.renderedPixelsVerified===true);assert.equal(pdf.source?.title,v.richTitle);assert.deepEqual(pdf.source?.table,v.table);assert.ok(Object.keys(pdf.source?.hashes??{}).length>0);assert.ok(end.files['case17.rtf']||end.files['case17.rtfd']);
  assert.equal(pdf.clipboard?.sameItems,true);checks.push('PDF content/render/source and clipboard hashes independently verified');break;
 }
 case 18:
  assert.ok(text(end).includes(v.macOS??manifest.macOS));
  const navigation=(call,step)=>{
   if(step.action==='menu')return /^(?:显示|View)\s*[>›/]\s*(?:通用|General|关于本机|About)$/.test(step.text??'');
   if(!['press','click'].includes(step.action))return false;
   const previous=calls.filter(other=>other.end<=call.at&&other.result.details.window===call.result.details.window).reverse();
   for(const earlier of previous){
    const line=earlier.result.modelContent.split('\n').find(line=>new RegExp('(?:^|\\s)'+step.id+'\\s').test(line));
    if(!line)continue;
    return !line.trim().startsWith('-')&&/"(?:通用|General|关于本机|About)"/.test(line);
   }
   return false;
  };
  assert.ok(calls.filter(call=>call.tool==='screen_act').every(call=>[...(call.args.steps??[call.args])].every(step=>navigation(call,step))),'only General/About navigation may be sent to System Settings');checks.push('About text matches sw_vers, no value writes');break;
 case 19:{
  const edited=evidence('edited'),receipt=start.native['state-A.json'].receipt;
  assert.ok(text(edited).includes(v.text));assert.ok(text(edited).includes(receipt));
  assert.ok(!text(end).includes(v.transferTitle));
  assert.ok(selectedContainer(end,v.notesFolder));assert.ok(unfiltered(end));assert.ok(deletedByUI());checks.push('runtime receipt and actual document transferred, own note deleted');break;
 }
 case 20:{
  const source=get('case20-source.json');equalFields(source,v.native20);
  assert.notEqual(source.receipt,start.native['state-A.json'].receipt);
  assert.equal(web.reconciliations.length,1);equalFields(web.reconciliations[0],{receipt:source.receipt,amount:source.quantity,note:source.body});
  assert.equal(native['state-A.json'].reconciled,true);checks.push('runtime source, server record and native fetched reconciliation agree');break;
 }
 }
 const verdict={id,passed:true,checks,at:Date.now(),evidence:[path('before'),path('complete')],includesSpeedAndFocus:false};
 if(!process.argv.includes('--check'))writeFileSync(join(root,'evidence',`case-${String(id).padStart(2,'0')}-data-verdict.json`),JSON.stringify(verdict,null,2),{flag:'wx'});
 process.stdout.write(JSON.stringify(verdict)+'\n');
}catch(error){
 process.stdout.write(JSON.stringify({id,passed:false,error:String(error),checks,includesSpeedAndFocus:false})+'\n');process.exitCode=1;
}
