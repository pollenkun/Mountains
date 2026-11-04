import assert from 'node:assert/strict';
import {test} from 'node:test';
import {POSIX_ONLY} from './fixtures/platform.ts';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {frozenFiles,checkFrozenVersion,sha256,focusNotificationVerdict,duration,timedInterval} from './acceptance/integrity.ts';
import {taskPrompts} from './acceptance/prompts.ts';
import {pinRuntimeTasks,checkRuntimeTasks} from './acceptance/runtime-pin.ts';

test('a frozen directory rejects added files, modified sources and a replaced freeze record',()=>{
 const root=mkdtempSync(join(tmpdir(),'mountains-freeze-'));try{
  const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'app.ts'),'original');
  const path=join(root,'freeze.json');writeFileSync(path,JSON.stringify({root,scopes:[source],files:frozenFiles([source]),fixtures:{}}));
  const pinned=checkFrozenVersion(path).sha256;
  writeFileSync(join(source,'new.ts'),'new file');assert.throws(()=>checkFrozenVersion(path,pinned),/added, deleted or changed/);rmSync(join(source,'new.ts'));
  writeFileSync(join(source,'app.ts'),'modified');assert.throws(()=>checkFrozenVersion(path,pinned),/added, deleted or changed/);writeFileSync(join(source,'app.ts'),'original');
  assert.doesNotThrow(()=>checkFrozenVersion(path,pinned));
  writeFileSync(path,readFileSync(path,'utf8')+'\n');assert.throws(()=>checkFrozenVersion(path,pinned),/freeze.json changed/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('executable files under cache and dependency directories remain part of the freeze',()=>{
 const root=mkdtempSync(join(tmpdir(),'mountains-freeze-dependency-'));try{
  for(const name of ['__pycache__','node_modules'])mkdirSync(join(root,name));
  const file=join(root,'__pycache__/policy.mjs'),dependency=join(root,'node_modules/library.mjs');writeFileSync(file,'original');writeFileSync(dependency,'library');
  const before=frozenFiles([root]);assert.ok(before[file]);assert.ok(before[dependency]);writeFileSync(file,'changed');assert.notDeepEqual(frozenFiles([root]),before);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('negative, nonfinite and reversed clocks cannot become fast samples',()=>{
 for(const value of [-1,NaN,Infinity,undefined])assert.throws(()=>duration(value,'sample'),/nonnegative/);
 assert.throws(()=>timedInterval(200,100,'call'),/nonnegative/);assert.equal(timedInterval(100,120,'call'),20);
});

test('a correct hash cannot make an empty or unrelated source freeze acceptable',()=>{
 const root=mkdtempSync(join(tmpdir(),'mountains-freeze-scope-'));try{
  mkdirSync(join(root,'evidence'));const path=join(root,'evidence/freeze.json');
  const bytes=JSON.stringify({version:3,root,scopes:[],files:{},fixtures:{}});writeFileSync(path,bytes);
  assert.throws(()=>checkFrozenVersion(path,sha256(bytes),{repo:root,root}),/required source/);
  assert.throws(()=>checkFrozenVersion(path,sha256(bytes),{repo:root,root:join(root,'other')}),/another run/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('frozen sources reject a symlink to mutable files outside the source tree',()=>{
 const root=mkdtempSync(join(tmpdir(),'mountains-freeze-'));try{
  const source=join(root,'source');mkdirSync(source);writeFileSync(join(root,'external'),'outside');symlinkSync(join(root,'external'),join(source,'alias'));assert.throws(()=>frozenFiles([source]),/symlink/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('exact task prompts include save tags, runtime values and file destinations',POSIX_ONLY,()=>{
 const cases=JSON.parse(readFileSync(new URL('./acceptance/cases.json',import.meta.url),'utf8'));
 const manifest={root:'/tmp/Mountains 测试素材/test-run',prefix:'M20-own',values:{native01:{name:'runtime value'},native03:{body:'same edit'},reminderItems:['one','two','three'],text:'expected body'}};
 const prompts=taskPrompts(cases,manifest,'http://127.0.0.1:54321');assert.equal(prompts.length,20);
 assert.match(prompts[0]!.text,/case01/);assert.match(prompts[0]!.text,/runtime value/);assert.match(prompts[10]!.text,/workspace\/case11.txt/);assert.match(prompts[3]!.text,/Alpha receipt/);assert.match(prompts[5]!.text,/http:\/\/127.0.0.1:54321\/form/);
 assert.equal(sha256(JSON.stringify(prompts)),sha256(JSON.stringify(taskPrompts(cases,manifest,'http://127.0.0.1:54321'))));
 manifest.values.native01.name='different runtime value';assert.notEqual(sha256(JSON.stringify(prompts)),sha256(JSON.stringify(taskPrompts(cases,manifest,'http://127.0.0.1:54321'))));
});
test('an error after tool dispatch remains a failed trace entry instead of disappearing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mountains-trace-'));try{
  mkdirSync(join(root,'evidence'));
  writeFileSync(join(root,'evidence/operator.jsonl'),[
   {at:100,sessionStart:true,diagnostic:false},{at:101,call:1,case:4,request:{tool:'screen_act',args:{action:'press',id:'e1'}}},
   {at:121,call:1,case:4,elapsedMs:20,error:'transport disconnected after dispatch'},
  ].map(item=>JSON.stringify(item)).join('\n'));
  const {toolTrace}=await import(new URL('./acceptance/trace.mjs',import.meta.url).href);
  const calls=toolTrace(root,'self');assert.equal(calls.length,1);assert.equal(calls[0].result.ok,false);assert.equal(calls[0].result.details.dispatchUnknown,true);assert.equal(calls[0].durationMs,20);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('a restored sample does not turn a delayed focus notification into proof of safety',()=>{
 assert.equal(focusNotificationVerdict({kind:'AX-notification',notification:'AXFocusedUIElementChanged',inSystemFocusedApplication:false}),'unknown');
 assert.equal(focusNotificationVerdict({kind:'AX-notification',notification:'AXFocusedUIElementChanged',inSystemFocusedApplication:true}),'changed');
});

test('runtime tasks pin the single owned server after cold preparation and reject restarting it',POSIX_ONLY,()=>{
 const root=mkdtempSync(join(tmpdir(),'mountains-runtime-pin-'));try{
  mkdirSync(join(root,'web'));mkdirSync(join(root,'evidence'));
  writeFileSync(join(root,'manifest.json'),JSON.stringify({root,prefix:'own',values:{reminderItems:['one','two','three']}}));
  const receipt=join(root,'web/server.json');writeFileSync(receipt,JSON.stringify({pid:42,url:'http://127.0.0.1:54321'}));
  const cases=fileURLToPath(new URL('./acceptance/cases.json',import.meta.url));
  assert.throws(()=>pinRuntimeTasks(root,'base-hash',41,cases),/exact child/);
  const pin=pinRuntimeTasks(root,'base-hash',42,cases);const checked=checkRuntimeTasks(root,'base-hash',pin.sha256);assert.equal(checked.prompts.length,20);assert.match(checked.prompts[5]!.text,/54321\/form/);
  assert.throws(()=>pinRuntimeTasks(root,'base-hash',42,cases),/EEXIST/);
  writeFileSync(receipt,JSON.stringify({pid:43,url:'http://127.0.0.1:54322'}));assert.throws(()=>checkRuntimeTasks(root,'base-hash',pin.sha256),/replaced or restarted/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
