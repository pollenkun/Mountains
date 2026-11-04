/** Opt-in, free desktop acceptance: node packages/computer/test/verify-macos.ts [output-directory].
 * Starts only disposable fixtures, drives the real plugin, and checks independent app/DOM state.
 */
import {requireRealMachineAcceptanceSafety} from './acceptance/safety-gate.ts';
import assert from 'node:assert/strict';
import { execFile,spawn,type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import {computerUseSkill} from '../src/skill.ts';
import {cleanupAll} from './fixtures/cleanup.ts';
import {onTestTermination} from './fixtures/signals.ts';
import { decodePng } from '../src/image.ts';
import { FileStateTracker, Workspace, type ToolContext, type ToolResult } from '@mountains/tools';
requireRealMachineAcceptanceSafety();
if(process.platform!=='darwin')throw new Error('This diagnostic requires macOS.');
if(process.env.MOUNTAINS_ACCEPTANCE_FOREGROUND==='1')throw new Error('Foreground and real-pointer experiments are disabled in this background diagnostic; they require a separately reviewed restoration harness.');
const run=promisify(execFile),pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const directory=process.argv[2]??await mkdtemp(join(tmpdir(),'mountains-native-acceptance-'));
await mkdir(directory,{recursive:true});
const lifecycle=new AbortController();
const records:{name:string;passed:boolean;error?:string;milliseconds:number}[]=[],receipts:unknown[]=[];
const processes:{child:ChildProcess;executable:string}[]=[];
const clients:ReturnType<typeof computerUseSkill>[]=[];
const approvals:{request:unknown;decision:string;answeredBy:string}[]=[];
const sourceHashes:Record<string,string>={};
for(const name of await readdir(fileURLToPath(new URL('../src/',import.meta.url))))if(name.endsWith('.ts'))sourceHashes[`src/${name}`]=createHash('sha256').update(await readFile(new URL(`../src/${name}`,import.meta.url))).digest('hex');
for(const path of ['verify-macos.ts','fixtures/native-app.swift','fixtures/web-app.swift','../native/capture.swift'])sourceHashes[path]=createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex');

const model=(name:string)=>readFile(join(directory,name),'utf8').then(JSON.parse);
const context=():ToolContext=>({workspace:new Workspace(process.cwd()),files:new FileStateTracker(),signal:lifecycle.signal,toolCallId:'local-fixture',approve:async request=>{const decision=request.command==='Use computer use in this conversation'?'allow':'deny';approvals.push({request,decision,answeredBy:'test-script: this individual approval only'});return decision;}});
function client(){const skill=computerUseSkill({imageInput:true,cursor:false,settleMaxMs:1000,settleMs:40});clients.push(skill);return Object.fromEntries(skill.tools!.map(t=>[t.name,t]));}
async function call(t:ReturnType<typeof client>,tool:string,args:Record<string,unknown>,c=context()){
 lifecycle.signal.throwIfAborted();const r=await t[tool]!.execute(args,{...c,signal:AbortSignal.any([c.signal,lifecycle.signal])});receipts.push({tool,args,result:{...r,images:undefined}});return r;
}
async function read(t:ReturnType<typeof client>,pid:number,window:number){const r=await call(t,'screen_read',{app:String(pid),window:`w:${window}`,full:true});assert.equal(r.ok,true,r.modelContent);return r;}
function id(r:ToolResult,label:string,role?:string){const line=r.modelContent.split('\n').find(l=>l.includes(label)&&(!role||l.includes(role)));const match=line?.match(/^\s*(e\d+) /);assert.ok(match,`missing ${label} in ${r.modelContent}`);return match[1]!;}
async function act(t:ReturnType<typeof client>,pid:number,r:ToolResult,args:Record<string,unknown>){const result=await call(t,'screen_act',{app:String(pid),snapshot:r.details?.snapshot,...args});assert.notEqual(result.details?.outcome,'not_executed',result.modelContent);assert.equal((result.details?.foreground as {unchanged?:boolean}|undefined)?.unchanged,true,result.modelContent);return result;}
async function test(name:string,fn:()=>Promise<void>){if(process.env.MOUNTAINS_ACCEPTANCE_FILTER&&!name.includes(process.env.MOUNTAINS_ACCEPTANCE_FILTER))return;const start=performance.now();try{await fn();records.push({name,passed:true,milliseconds:performance.now()-start});console.log(`PASS ${name}`);}catch(e){records.push({name,passed:false,error:String(e),milliseconds:performance.now()-start});console.log(`FAIL ${name}: ${String(e)}`);}}
async function build(name:string,source:string){const bundle=join(directory,`${name}.app`),contents=join(bundle,'Contents'),executable=join(contents,'MacOS',name);await mkdir(join(contents,'MacOS'),{recursive:true});await run('swiftc',['-O','-o',executable,fileURLToPath(new URL(`fixtures/${source}`,import.meta.url))]);const identifier=`dev.mountains.fixture.${randomUUID()}`;
 await writeFile(join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleName</key><string>${name}</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/></dict></plist>`);
 lifecycle.signal.throwIfAborted();const child=spawn(executable,[directory,'Mountains Acceptance'],{stdio:['pipe','ignore','ignore']});processes.push({child,executable});await new Promise<void>((accept,reject)=>{child.once('spawn',()=>accept());child.once('error',reject);});return child;}
async function ready(file:string){for(let i=0;i<100;i++){try{return await model(file);}catch{await pause(100);}}throw new Error(`fixture did not create ${file}`);}
async function control(index:number,op:string,extra:Record<string,unknown>={}){lifecycle.signal.throwIfAborted();const nonce=randomUUID();await writeFile(join(directory,'control.json'),JSON.stringify({nonce,index,op,...extra}));for(let i=0;i<100;i++){if((await model(`window-${index}.json`)).lastCommand===nonce)return;await pause(20);}throw new Error('fixture control timeout');}
async function webControl(op:string){lifecycle.signal.throwIfAborted();const nonce=randomUUID();await writeFile(join(directory,'web-control.json'),JSON.stringify({nonce,op}));for(let i=0;i<100;i++){if((await model('web.json')).lastCommand===nonce)return;await pause(20);}throw new Error('web fixture control timeout');}
const beforeFront=JSON.parse((await run('osascript',['-l','JavaScript','-e','ObjC.import("Cocoa");JSON.stringify({pid:Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),mouse:ObjC.deepUnwrap($.NSEvent.mouseLocation)});'])).stdout);
let shutdownPromise:Promise<void>|undefined;
const shutdown=()=>shutdownPromise??=(async()=>{
 const cleanupErrors=await cleanupAll([
  ...clients.map((skill,index)=>({name:'dispose tool client '+index,run:()=>skill.dispose!()})),
  ...processes.map(({child,executable})=>({name:'stop owned fixture '+executable,async run(){
   if(child.exitCode!==null||child.signalCode!==null)return;
   await new Promise<void>((accept,reject)=>{const timer=setTimeout(()=>child.kill('SIGKILL'),1000);child.once('exit',()=>{clearTimeout(timer);accept();});child.once('error',reject);child.kill('SIGTERM');});
  }})),
 ]);
 if(cleanupErrors.length){records.push({name:'owned resources stopped',passed:false,error:JSON.stringify(cleanupErrors),milliseconds:0});process.exitCode=1;}
 await writeFile(join(directory,'acceptance.json'),JSON.stringify({diagnostic:true,environment:{platform:process.platform,node:process.version,sourceHashes,filter:process.env.MOUNTAINS_ACCEPTANCE_FILTER??null,foregroundOptIn:false},records,receipts,approvals,cleanupErrors},null,2));
 console.log(`Evidence: ${join(directory,'acceptance.json')}`);

})();
const removeTerminationHandlers=onTestTermination(lifecycle,shutdown);
try{
 const nativeChild=await build('MountainsNativeAcceptance','native-app.swift'),native=await ready('window-1.json'),second=await ready('window-2.json');assert.equal(native.pid,nativeChild.pid);assert.equal(second.pid,nativeChild.pid);
 const webChild=await build('MountainsWebAcceptance','web-app.swift'),web=await ready('web.json');assert.equal(web.pid,webChild.pid);
 const a=client(),b=client();
 await test('native multilingual replacement is real app state',async()=>{const r=await read(a,native.pid,native.window);const result=await act(a,native.pid,r,{action:'set_value',id:id(r,'Text 1','text_field'),text:'你好 Ελληνικά 🌍'});assert.equal(result.details?.outcome,'confirmed');await pause(100);assert.equal((await model('window-1.json')).value,'你好 Ελληνικά 🌍');});
 await test('ignored native write stays unconfirmed',async()=>{await control(1,'mode',{mode:'ignore'});const r=await read(a,native.pid,native.window),result=await act(a,native.pid,r,{action:'set_value',id:id(r,'Text 1','text_field'),text:'must not appear'});assert.equal(result.details?.outcome,'unconfirmed');assert.equal((await model('window-1.json')).value,'你好 Ελληνικά 🌍');await control(1,'mode',{mode:'normal'});});
 await test('delayed native write waits for observed state',async()=>{await control(1,'mode',{mode:'delay'});const r=await read(a,native.pid,native.window),result=await act(a,native.pid,r,{action:'set_value',id:id(r,'Text 1','text_field'),text:'Delayed native'});assert.equal(result.details?.outcome,'confirmed');await pause(100);assert.equal((await model('window-1.json')).value,'Delayed native');await control(1,'mode',{mode:'normal'});});
 await test('moved window refuses an earlier receipt',async()=>{const r=await read(a,native.pid,native.window);await control(1,'move');const result=await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'set_value',id:id(r,'Text 1','text_field'),text:'wrong'});assert.equal(result.details?.outcome,'not_executed');assert.equal((await model('window-1.json')).value,'Delayed native');});
 await test('replaced native control cannot receive an old id',async()=>{const r=await read(a,native.pid,native.window);await control(1,'replace');const result=await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'set_value',id:id(r,'Text 1','text_field'),text:'wrong'});assert.equal(result.details?.outcome,'not_executed');assert.equal((await model('window-1.json')).value,'Delayed native');});
 await test('native button effect is independently counted',async()=>{const state=await model('window-1.json'),r=await read(a,native.pid,native.window),result=await act(a,native.pid,r,{action:'press',id:id(r,'Increment 1','button'),expect:{id:id(r,'Count:'),property:'value',value:`Count: ${state.presses+1}`}});assert.equal(result.details?.outcome,'confirmed');await pause(100);assert.equal((await model('window-1.json')).presses,state.presses+1);});
 await test('web multilingual input and selection edit change the DOM',async()=>{let r=await read(a,web.pid,web.window);let result=await act(a,web.pid,r,{action:'set_value',id:id(r,'Web text','text_field'),text:'你好 Ελληνικά 🌍'});assert.equal(result.details?.outcome,'confirmed');await pause(180);assert.equal((await model('web.json')).value,'你好 Ελληνικά 🌍');r=await read(a,web.pid,web.window);await act(a,web.pid,r,{action:'select_text',id:id(r,'Web text','text_field'),text:'Ελληνικά'});r=await read(a,web.pid,web.window);result=await act(a,web.pid,r,{action:'type',id:id(r,'Web text','text_field'),text:'世界',expect:{id:id(r,'Web text','text_field'),property:'value',value:'你好 世界 🌍'}});assert.equal(result.details?.outcome,'confirmed');await pause(180);assert.equal((await model('web.json')).value,'你好 世界 🌍');});
 await test('readonly web input is not fabricated into success',async()=>{const r=await read(a,web.pid,web.window),result=await act(a,web.pid,r,{action:'set_value',id:id(r,'Read only','text_field'),text:'wrong'});assert.notEqual(result.details?.outcome,'confirmed');assert.equal((await model('web.json')).readonly,'Fixed');});
 await test('delayed web effect is confirmed by the expected field',async()=>{const r=await read(a,web.pid,web.window),result=await act(a,web.pid,r,{action:'press',id:id(r,'Delayed change','button'),expect:{id:id(r,'Web text','text_field'),property:'value',value:'Delayed'}});assert.equal(result.details?.outcome,'confirmed');await pause(180);assert.equal((await model('web.json')).value,'Delayed');});
 await test('replaced web input cannot receive an earlier element id',async()=>{await webControl('focus');const before=await model('web.json'),r=await read(a,web.pid,web.window);await webControl('replace');const result=await call(a,'screen_act',{app:String(web.pid),snapshot:r.details?.snapshot,action:'set_value',id:id(r,'Web text','text_field'),text:'wrong replacement'});assert.notEqual(result.details?.outcome,'confirmed',result.modelContent);await pause(180);const after=await model('web.json');assert.equal(after.replacements,before.replacements+1);assert.equal(after.value,before.value);});
 await test('replaced empty web field cannot inherit the old text receiver',async()=>{await webControl('empty');await webControl('focus');const r=await read(a,web.pid,web.window);await webControl('replace');const result=await call(a,'screen_act',{app:String(web.pid),snapshot:r.details?.snapshot,action:'set_value',id:id(r,'Web text','text_field'),text:'wrong empty replacement'});assert.notEqual(result.details?.outcome,'confirmed',result.modelContent);await pause(180);assert.equal((await model('web.json')).value,'');});
 await test('moved web window refuses an earlier observation',async()=>{const before=await model('web.json'),r=await read(a,web.pid,web.window);await webControl('move');const result=await call(a,'screen_act',{app:String(web.pid),snapshot:r.details?.snapshot,action:'set_value',id:id(r,'Web text','text_field'),text:'wrong moved window'});assert.equal(result.details?.outcome,'not_executed');assert.equal((await model('web.json')).value,before.value);});
 // Remove the blinking text caret before checking unchanged screenshot receipts.
 {const r=await read(a,web.pid,web.window);await act(a,web.pid,r,{action:'press',id:id(r,'Event canvas','group')});}
 for(const target of [{name:'native',pid:native.pid,window:native.window,file:'window-1.json',y:.65},{name:'web',pid:web.pid,window:web.window,file:'web.json',y:.62}]){
  for(const [action,property]of [['click','clicks'],['double_click','doubleClicks'],['right_click','rightClicks'],['scroll','scrolls'],['drag','drags'],['key','keys']] as const){
   await test(`${target.name} ${action} reaches the intended canvas`,async()=>{const before=await model(target.file),look=await call(a,'screen_look',{app:String(target.pid),window:`w:${target.window}`});assert.equal(look.ok,true,look.modelContent);const width=Number(look.details?.width),height=Number(look.details?.height);
    const args={action,image:look.details?.image,...(action==='key'?{key:'k'}:{x:width*.5,y:height*target.y}),...(action==='scroll'?{dy:3}:{}),...(action==='drag'?{x2:width*.7,y2:height*(target.y+.04)}:{})};
    await act(a,target.pid,look,args);await pause(200);const after=await model(target.file);if(property==='keys')assert.equal(after[property],before[property]+'k');else assert.ok(after[property]>before[property],`${property} did not change`);
   });
  }
 }
 await test('two agents can prepare different windows of one app without stale cross-window writes',async()=>{const [one,two]=await Promise.all([read(a,native.pid,native.window),read(b,native.pid,second.window)]);const results=await Promise.all([act(a,native.pid,one,{action:'set_value',id:id(one,'Text 1','text_field'),text:'Agent A'}),act(b,native.pid,two,{action:'set_value',id:id(two,'Text 2','text_field'),text:'Agent B'})]);assert.ok(results.every(r=>r.details?.outcome==='confirmed'));await pause(100);assert.equal((await model('window-1.json')).value,'Agent A');assert.equal((await model('window-2.json')).value,'Agent B');});
 await test('two agents in different apps do not cross their text',async()=>{const [one,two]=await Promise.all([read(a,native.pid,second.window),read(b,web.pid,web.window)]);const results=await Promise.all([act(a,native.pid,one,{action:'set_value',id:id(one,'Text 2','text_field'),text:'Native lane'}),act(b,web.pid,two,{action:'set_value',id:id(two,'Web text','text_field'),text:'Web lane'})]);assert.ok(results.every(r=>r.details?.outcome==='confirmed'));await pause(180);assert.equal((await model('window-2.json')).value,'Native lane');assert.equal((await model('web.json')).value,'Web lane');});
 await test('two windows route keyboard events to their own canvas',async()=>{
  for(const target of [{index:1,window:native.window},{index:2,window:second.window}]){const look=await call(a,'screen_look',{app:String(native.pid),window:`w:${target.window}`});assert.equal(look.ok,true,look.modelContent);await act(a,native.pid,look,{action:'click',image:look.details?.image,x:Number(look.details?.width)*.5,y:Number(look.details?.height)*.65});}
  const baseline=await Promise.all([model('window-1.json'),model('window-2.json')]);
  for(let round=0;round<5;round++){
   const [one,two]=await Promise.all([read(a,native.pid,native.window),read(b,native.pid,second.window)]);
   const actions=[()=>act(a,native.pid,one,{action:'key',key:'a'}),()=>act(b,native.pid,two,{action:'key',key:'b'})];if(round%2)actions.reverse();
   const results=await Promise.all(actions.map(run=>run()));assert.ok(results.every(r=>r.details?.error===undefined),JSON.stringify(results.map(r=>r.details)));await pause(100);
   assert.equal((await model('window-1.json')).keys,baseline[0].keys+'a'.repeat(round+1));assert.equal((await model('window-2.json')).keys,baseline[1].keys+'b'.repeat(round+1));
  }
 });
 await test('app-wide menus reach only the explicitly selected window',async()=>{
  for(const target of [native,second]){const look=await call(a,'screen_look',{app:String(native.pid),window:`w:${target.window}`});await act(a,native.pid,look,{action:'click',image:look.details?.image,x:Number(look.details?.width)*.5,y:Number(look.details?.height)*.65});}
  const menus=await call(a,'screen_read',{app:String(native.pid),menus:true});const menuPath=(menus.details?.menus as {path:string}[]).find(m=>m.path.endsWith(' > Mark window'))?.path;assert.ok(menuPath,menus.modelContent);
  const baseline=await Promise.all([model('window-1.json'),model('window-2.json')]);
  for(let round=0;round<3;round++){
   const [one,two]=await Promise.all([read(a,native.pid,native.window),read(b,native.pid,second.window)]);
   const results=await Promise.all([act(a,native.pid,one,{action:'menu',text:menuPath}),act(b,native.pid,two,{action:'menu',text:menuPath})]);assert.ok(results.every(r=>r.details?.error===undefined),JSON.stringify(results.map(r=>r.details)));await pause(100);
   assert.equal((await model('window-1.json')).menuMarks,baseline[0].menuMarks+round+1);assert.equal((await model('window-2.json')).menuMarks,baseline[1].menuMarks+round+1);
  }
 });
 await test('a new dialog invalidates both agents prepared actions',async()=>{
  const [one,two]=await Promise.all([read(a,native.pid,native.window),read(b,native.pid,second.window)]);await control(1,'popup');
  try{for(const [t,r,label]of [[a,one,'Text 1'],[b,two,'Text 2']] as const){const result=await call(t,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'set_value',id:id(r,label,'text_field'),text:'wrong dialog'});assert.equal(result.details?.outcome,'not_executed');}}
  finally{await control(1,'closePopup');}
 });
 await test('floating panels remain identifiable without hiding the main window',async()=>{
  await control(1,'floatingPopup');
  try{
   const listed=await call(a,'screen_read',{app:String(native.pid)});assert.equal(listed.ok,true,listed.modelContent);
   const floating=(listed.details?.windows as {window:string;title:string}[]).find(w=>w.title==='Disposable dialog');assert.ok(floating,listed.modelContent);
   await read(a,native.pid,native.window);
   const panel=await call(a,'screen_read',{app:String(native.pid),window:floating.window});assert.equal(panel.ok,true,panel.modelContent);
  }finally{await control(1,'closePopup');}
 });
 await test('same-window handoff refuses the previous agents observation',async()=>{const old=await read(a,native.pid,native.window),fresh=await read(b,native.pid,native.window);await act(b,native.pid,fresh,{action:'set_value',id:id(fresh,'Text 1','text_field'),text:'New owner'});const result=await call(a,'screen_act',{app:String(native.pid),snapshot:old.details?.snapshot,action:'set_value',id:id(old,'Text 1','text_field'),text:'Old owner'});assert.equal(result.details?.outcome,'not_executed');await pause(100);assert.equal((await model('window-1.json')).value,'New owner');});
 await test('cancellation after dispatch reads the actual delayed result without retrying',async()=>{
  await control(1,'mode',{mode:'delay'});const r=await read(a,native.pid,native.window),baseline=await model('window-1.json'),abort=new AbortController();
  const pending=call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'set_value',id:id(r,'Text 1','text_field'),text:'Cancelled after send'},{...context(),signal:abort.signal});
  let sent=false;for(let n=0;n<100;n++){if((await model('window-1.json')).writesRequested>baseline.writesRequested){sent=true;abort.abort();break;}await pause(20);}
  const result=await pending;await control(1,'mode',{mode:'normal'});assert.equal(sent,true);assert.equal(result.details?.cancelled,true);assert.equal(result.details?.dispatched,true);assert.equal(result.details?.observed,'Cancelled after send');assert.equal((await model('window-1.json')).writesRequested,baseline.writesRequested+1);
 });
 // Same workload, deterministic tool calls only. No model think time is invented.
 await test('sequential and concurrent preparation produce identical results',async()=>{
  const measurements:{mode:string;milliseconds:number}[]=[];
  for(const mode of ['sequential','concurrent']){
   await control(1,'value',{value:'Baseline 1'});await control(2,'value',{value:'Baseline 2'});
   const start=performance.now();const work=async(t:ReturnType<typeof client>,index:number,window:number)=>{const r=await read(t,native.pid,window);const result=await act(t,native.pid,r,{action:'set_value',id:id(r,`Text ${index}`,'text_field'),text:`Timing ${index}`});assert.equal(result.details?.outcome,'confirmed');};
   if(mode==='sequential'){await work(a,1,native.window);await work(b,2,second.window);}else await Promise.all([work(a,1,native.window),work(b,2,second.window)]);
   await pause(100);assert.equal((await model('window-1.json')).value,'Timing 1');assert.equal((await model('window-2.json')).value,'Timing 2');measurements.push({mode,milliseconds:performance.now()-start});
  }
  await writeFile(join(directory,'timing.json'),JSON.stringify({kind:'local tool replay, not model or throughput benchmark',measurements},null,2));
 });
 await test('large web views remain readable and searchable across pages',async()=>{
  await webControl('large');
  try{
   let r=await call(a,'screen_read',{app:String(web.pid),window:`w:${web.window}`,find:'Pagination marker 4200'});assert.equal(r.ok,true,r.modelContent);assert.equal(r.details?.complete,false,r.modelContent);
   assert.doesNotMatch(r.modelContent,/button "Pagination marker 4200"/);
   for(let page=0;page<10&&r.details?.nextCursor;page++){r=await call(a,'screen_read',{app:String(web.pid),cursor:r.details.nextCursor});assert.equal(r.ok,true,r.modelContent);if(r.modelContent.includes('button "Pagination marker 4200"'))break;}
   assert.match(r.modelContent,/button "Pagination marker 4200"/);
  }finally{await webControl('small');}
 });
 await test('foreground and real pointer are unchanged after all fixture actions',async()=>{for(const file of ['window-1.json','window-2.json','web.json']){const current=await model(file);assert.equal(current.front,beforeFront.pid);assert.deepEqual(current.mouse,[beforeFront.mouse.x,beforeFront.mouse.y]);assert.equal(current.buttons,0);}});
 // This separate opt-in changes foreground deliberately. It cannot count towards
 // the background non-interruption assertion above and never restores focus secretly.
 if(process.env.MOUNTAINS_ACCEPTANCE_FOREGROUND==='1'){
  await test('authorized foreground text updates the native model without clipboard',async()=>{
   await control(1,'value',{value:'Replace this'});let r=await read(a,native.pid,native.window);
   let result=await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'bring_to_front'});assert.equal(result.details?.outcome,'confirmed',result.modelContent);
   await control(1,'focusText');r=await read(a,native.pid,native.window);
   result=await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'key',key:'cmd+a'});
   r=await read(a,native.pid,native.window);
   const value='你好 Ελληνικά 🌍';result=await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'type',id:id(r,'Text 1','text_field'),text:value,expect:{id:id(r,'Text 1','text_field'),property:'value',value}});
   assert.equal(result.details?.outcome,'confirmed',result.modelContent);await pause(100);const state=await model('window-1.json');assert.equal(state.value,value);assert.equal(state.aDown,false);assert.deepEqual(state.mouse,[beforeFront.mouse.x,beforeFront.mouse.y]);
  });
  await test('replaced empty native field cannot inherit foreground typing',async()=>{
   let r=await read(a,native.pid,native.window);await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'bring_to_front'});
   await control(1,'value',{value:''});await control(1,'focusText');r=await read(a,native.pid,native.window);
   await control(1,'replace');await control(1,'focusText');const result=await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'type',id:id(r,'Text 1','text_field'),text:'wrong replacement'});
   assert.notEqual(result.details?.outcome,'confirmed',result.modelContent);await pause(100);assert.equal((await model('window-1.json')).value,'');
  });
  await test('attached sheet capture and closing Return use the exact authorized window',async()=>{
   let r=await read(a,native.pid,native.window);await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'bring_to_front'});
   await control(1,'sheet');const before=await model('window-1.json');assert.ok(before.sheetWindow>0);
   r=await read(a,native.pid,before.sheetWindow);assert.match(r.modelContent,/Finish sheet/);
   const shot=await call(a,'screen_look',{app:String(native.pid),window:`w:${before.sheetWindow}`});assert.equal(shot.ok,true,shot.modelContent);
   const png=Buffer.from(shot.images![0]!.data,'base64');await writeFile(join(directory,'attached-sheet.png'),png);const decoded=decodePng(png);let purple=0;
   for(let p=0;p<decoded.rgba.length;p+=4)if(decoded.rgba[p]!>150&&decoded.rgba[p+1]!<80&&decoded.rgba[p+2]!>100)purple++;
   assert.ok(purple/(decoded.width*decoded.height)>0.4,'sheet capture contains its own purple pixels, not a rescaled parent');
   r=await read(a,native.pid,before.sheetWindow);const grant=await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'bring_to_front'});assert.equal(grant.details?.outcome,'confirmed',grant.modelContent);
   r=await read(a,native.pid,before.sheetWindow);const close=await call(a,'screen_act',{app:String(native.pid),snapshot:r.details?.snapshot,action:'key',key:'Return'});assert.equal(close.details?.dispatched,true,close.modelContent);
   await pause(100);const after=await model('window-1.json');assert.equal(after.closedSheets,before.closedSheets+1);assert.equal(after.sheetWindow,0);assert.equal(after.returnDown,false);assert.deepEqual(after.mouse,[beforeFront.mouse.x,beforeFront.mouse.y]);
  });
  // Real-pointer tests come last: unlike all preceding checks, they explicitly move it.
  const prepareWebDrag=async()=>{
   let r=await read(a,web.pid,web.window);
   r=await call(a,'screen_act',{app:String(web.pid),snapshot:r.details?.snapshot,action:'bring_to_front'});assert.equal(r.details?.outcome,'confirmed',r.modelContent);
   // The full workflow previously edited the field. Put focus on the canvas so
   // a blinking text caret cannot make otherwise identical image receipts stale.
   r=await read(a,web.pid,web.window);const focus=await call(a,'screen_act',{app:String(web.pid),snapshot:r.details?.snapshot,action:'press',id:id(r,'Event canvas','group')});assert.equal(focus.details?.error,undefined,focus.modelContent);
   await pause(200);assert.equal((await model('web.json')).active,'canvas');
  };
  const realWebDrag=async(from:number,to:number,ctx=context()):Promise<ToolResult>=>{
   for(let attempt=0;attempt<3;attempt++){
    // Activation/hover can repaint before dispatch. Refresh only when the plugin
    // explicitly proves that no input was dispatched; never replay uncertain input.
    await pause(150);
    const look=await call(a,'screen_look',{app:String(web.pid),window:`w:${web.window}`});assert.equal(look.ok,true,look.modelContent);
    const width=Number(look.details?.width),height=Number(look.details?.height);
    const result=await call(a,'screen_act',{app:String(web.pid),snapshot:look.details?.snapshot,image:look.details?.image,action:'drag',allow_real_pointer:true,x:width*from,y:height*.62,x2:width*to,y2:height*.66},ctx);
    if(attempt===2||result.details?.outcome!=='not_executed'||result.details?.dispatched!==false||!String(result.details?.error).includes('since that image'))return result;
   }
   throw new Error('unreachable drag attempt');
  };
  await test('authorized real-pointer web drag refuses a covering window without moving the mouse',async()=>{
   await prepareWebDrag();
   await webControl('cover');
   try{
    const before=await model('web.json');assert.ok(before.coverWindow>0);
    const result=await realWebDrag(.45,.75);
    assert.match(String(result.details?.error),/covered|another window/,result.modelContent);
    await pause(150);const after=await model('web.json');assert.equal(after.drags,before.drags);assert.equal(after.clicks,before.clicks);assert.deepEqual(after.mouse,before.mouse);assert.equal(after.buttons,0);
   }finally{await webControl('uncover');}
  });
  await test('authorized real-pointer web drag reaches the DOM and releases its mouse button',async()=>{
   await prepareWebDrag();
   const before=await model('web.json'),result=await realWebDrag(.45,.75);
   assert.equal(result.details?.error,undefined,result.modelContent);assert.equal(result.details?.pointerMode,'real_pointer');assert.equal(result.details?.mode,'foreground_authorized');
   await pause(200);const after=await model('web.json');assert.ok(after.drags>before.drags,'DOM receives a held mouse button');assert.equal(after.buttons,0);assert.equal(after.front,web.pid);assert.notDeepEqual(after.mouse,before.mouse);
  });
  await test('cancelled real-pointer web drag stops and releases its mouse button',async()=>{
   await prepareWebDrag();
   const before=await model('web.json'),abort=new AbortController();let completed=false;
   const pending=realWebDrag(.15,.85,{...context(),signal:abort.signal}).finally(()=>{completed=true});
   let interrupted=false;for(let n=0;n<1000&&!completed;n++){if((await model('web.json')).drags>before.drags){abort.abort();interrupted=true;break;}await pause(20);}
   const result=await pending;assert.equal(interrupted,true,'cancel after real drag begins');assert.equal(result.details?.cancelled,true);assert.equal(result.details?.dispatched,true);
   await pause(200);const after=await model('web.json');assert.equal(after.buttons,0);assert.ok(after.drags>before.drags);assert.equal(after.front,web.pid);
  });
 }
}finally{try{await shutdown();}finally{removeTerminationHandlers();}}
if(records.some(r=>!r.passed))process.exitCode=1;
