import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {computerUseSkill} from '../../src/skill.ts';
import {assertDiagnosticRequest,diagnosticApproval} from './diagnostic-policy.ts';
import {requireRealMachineAcceptanceSafety} from './safety-gate.ts';
import {checkFrozenVersion} from './integrity.ts';
import {pinRuntimeTasks,checkRuntimeTasks} from './runtime-pin.ts';
import {stopFocusMonitor} from './stop-monitor.ts';
import {FocusTargetCandidates,observeFocusTargets} from './focus-targets.ts';
import {readWriterProcess,writerState} from './process-identity.ts';
import {FileStateTracker,Workspace} from '@mountains/tools';

const root=resolve(process.argv[2]||''),here=dirname(fileURLToPath(import.meta.url)),diagnostic=process.argv.includes('--diagnostic');
requireRealMachineAcceptanceSafety();
if(!process.argv[2])throw new Error('usage: operator.mjs run-root [--diagnostic]');
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
if(manifest.root!==root)throw new Error('wrong root');
if(!diagnostic)throw new Error('Formal acceptance is disabled pending account isolation, controller-generated evidence and independent safety review');
if(!diagnostic&&!existsSync(join(root,'evidence/freeze.json')))throw new Error('freeze the reviewed formal suite first');
const freezePath=join(root,'evidence/freeze.json'),reviewedFreeze=existsSync(freezePath)?checkFrozenVersion(freezePath,undefined,{repo:resolve(here,'../../../..'),root}):null;
let runtimePin;
const verifyFrozen=()=>{if(reviewedFreeze){checkFrozenVersion(freezePath,reviewedFreeze.sha256,{repo:resolve(here,'../../../..'),root});if(runtimePin)checkRuntimeTasks(root,reviewedFreeze.sha256,runtimePin.sha256);}};
const startedAt=Date.now(),startedMonotonicMs=performance.now(),journal=join(root,'evidence/operator.jsonl');
writeFileSync(journal,'',{flag:'wx',mode:0o600});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const log=value=>appendFileSync(journal,JSON.stringify({at:Date.now(),monotonicMs:performance.now(),...value})+'\n');
let calls=0,currentCase=null,skill,monitor,monitorBirth,monitorCandidates,monitorStopped=false,monitorStopRequested=false,shutdownPromise;
const processBinaryPath=join(root,'build/ReadProcessIdentity'),processBinary={path:processBinaryPath,sha256:manifest.fixtureHashes[processBinaryPath]};
const fixtures=[];
log({sessionStart:true,startedAt,startedMonotonicMs,pid:process.pid,diagnostic,strictBackground:true,freezeSha256:reviewedFreeze?.sha256??null});
const startFixture=(file,args,label)=>{
 const child=spawn(file,args,{stdio:['pipe','pipe','pipe']});fixtures.push({child,label});
 child.stderr.on('data',data=>log({fixtureError:label,text:String(data)}));
 child.once('error',error=>{child.startError=error;log({fixtureError:label,text:String(error)});});
 child.once('exit',(code,signal)=>log({fixtureExit:label,pid:child.pid,code,signal}));
 log({fixtureStart:label,pid:child.pid,file,args});return child;
};
const waitReady=async(child,predicate,label)=>{
 const deadline=Date.now()+5000;
 for(;;){
  if(child.startError||child.exitCode!==null||child.signalCode!==null)throw new Error(label+' stopped before ready');
  if(predicate())return;
  if(Date.now()>deadline)throw new Error(label+' startup receipt did not arrive');
  await new Promise(resolve=>setTimeout(resolve,40));
 }
};
const stopChild=async(child,label)=>{
 if(child.exitCode!==null||child.signalCode!==null||!child.pid)return;
 await new Promise((accept,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(label+' did not stop promptly'));},2000);
  child.once('exit',()=>{clearTimeout(timer);accept();});child.kill('SIGTERM');
 });
};
const shutdown=()=>shutdownPromise??=(async()=>{
 const errors=[];
 try{await skill?.dispose();}catch(error){errors.push(String(error));}
 for(const {child,label}of [...fixtures].reverse())try{await stopChild(child,label);}catch(error){errors.push(String(error));}
 if(monitorStopped)errors.push('independent focus monitor stopped unexpectedly');
 if(monitor&&!monitorStopped){monitorStopRequested=true;const monitorProcess=await readWriterProcess(processBinary,monitor.pid);log({monitorStopRequested:true,monitorProcess});if(!monitorBirth||writerState(monitorBirth,monitorProcess)!=='alive')errors.push('independent focus monitor identity changed or became unknown');try{await stopFocusMonitor(monitor);}catch(error){errors.push(String(error));}}
 try{monitorCandidates?.close();}catch(error){errors.push(String(error));}
 log({sessionEnd:true,totalCalls:calls,wallMs:performance.now()-startedMonotonicMs,openCase:currentCase?.id??null,cleanupErrors:errors});
 if(errors.length)throw new Error(errors.join('; '));
})();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void shutdown().finally(()=>process.exit(130));});
const external=(file,args)=>new Promise((accept,reject)=>{
 verifyFrozen();
 const child=spawn(process.execPath,[join(here,file),...args],{stdio:['ignore','pipe','pipe']});let out='',err='';
 child.stdout.on('data',data=>{out+=data;});child.stderr.on('data',data=>{err+=data;});
 child.once('error',reject);child.once('exit',code=>code===0?accept(out.trim()):reject(new Error(err||out)));
});
try{
 monitor=spawn(join(root,'build/FocusMonitor'),[join(root,'evidence/focus.jsonl'),...manifest.watchBundles],{stdio:['pipe','ignore','pipe']});
 monitor.stderr.on('data',data=>log({monitorError:String(data)}));
 monitor.once('error',error=>{monitor.startError=error;log({monitorError:String(error)});});
 monitor.once('exit',(code,signal)=>{monitorStopped=true;log({monitorExit:{code,signal,requested:monitorStopRequested}});});
 const monitorProcess=await readWriterProcess(processBinary,monitor.pid);log({monitorStart:{pid:monitor.pid,process:monitorProcess}});
 if(monitorProcess.status!=='alive')throw new Error('monitor OS process identity is unavailable');monitorBirth=monitorProcess.identity;
 await waitReady(monitor,()=>{try{return readFileSync(join(root,'evidence/focus.jsonl'),'utf8').includes('"kind":"ready"');}catch{return false;}},'focus monitor');
 monitorCandidates=new FocusTargetCandidates(join(root,'evidence/focus.jsonl'));
 skill=computerUseSkill({cursor:false,imageInput:true,web:{profileDir:join(root,'browser')}});
 const definitions=Object.fromEntries(skill.tools.map(tool=>[tool.name,tool]));
 const ctx={workspace:new Workspace(join(root,'workspace')),files:new FileStateTracker(),async approve(request){
  const decision=diagnosticApproval(request);
  log({approval:request,decision,answeredBy:'test-script',authorization:decision==='allow'?'Test script answered this individual approval; this is not a standing user authorization':'Test script denied foreground/global pointer use'});return decision;
 }};
 const server=startFixture(process.execPath,[join(here,'web/server.mjs'),join(root,'web')],'web');
 await waitReady(server,()=>existsSync(join(root,'web/server.json')),'Web fixture');
 const webURL=JSON.parse(readFileSync(join(root,'web/server.json'),'utf8')).url;
 if(reviewedFreeze){runtimePin=pinRuntimeTasks(root,reviewedFreeze.sha256,server.pid,join(here,'cases.json'));log({runtimePin});}
 const native=startFixture(join(root,'build/Mountains QA.app/Contents/MacOS/MountainsQA'),[join(root,'native')],'native');
 await waitReady(native,()=>existsSync(join(root,'native/state-A.json'))&&existsSync(join(root,'native/state-B.json')),'native fixture');
 emit({ready:true,pid:process.pid,diagnostic,manifest:join(root,'manifest.json'),webURL,nativePid:native.pid});
 for await(const line of createInterface({input:process.stdin})){
  if(!line.trim())continue;
  let request;try{request=JSON.parse(line);}catch(error){emit({error:String(error)});continue;}
  let activeCall;
  try{
   if(shutdownPromise||monitorStopped)throw new Error('session stopped; no further input');
   if(request.close){await shutdown();emit({closed:true});break;}
   if(request.begin){
    if(currentCase)throw new Error('previous case is still open');
    const id=Number(request.case);if(!Number.isInteger(id)||id<1||id>20)throw new Error('invalid case');
    if(id>=11&&id<=19)throw new Error('Office cases are disabled until local accounts, exact object IDs, inventories and cleanup are independently proven');
    const frozenPrompt=runtimePin?checkRuntimeTasks(root,reviewedFreeze.sha256,runtimePin.sha256).prompts.find(item=>item.id===id):null;
    if(frozenPrompt)log({taskDelivered:frozenPrompt});
    currentCase={id,started:Date.now(),startedMonotonicMs:performance.now(),callStart:calls};log({caseStart:currentCase});
    emit({case:id,...(frozenPrompt?{task:frozenPrompt.text}:{}),before:await external('checkpoint.mjs',[root,String(id),'before',request.window??''])});continue;
   }
   if(request.finish){
    if(!currentCase)throw new Error('no active case');
    const active=currentCase;
    try{
     const checkpoint=await external('checkpoint.mjs',[root,String(active.id),'complete',request.window??active.window??'']);
     const dataVerdict=JSON.parse(await external('verify.mjs',[root,String(active.id),'--runner','self']));
     const record={id:active.id,wallMs:performance.now()-active.startedMonotonicMs,calls:calls-active.callStart,checkpoint,dataVerdict};
     log({caseEnd:record});currentCase=null;emit(record);
    }catch(error){log({caseEnd:{id:active.id,wallMs:performance.now()-active.startedMonotonicMs,calls:calls-active.callStart,dataVerdict:{passed:false,error:String(error)}}});currentCase=null;throw error;}
    continue;
   }
   if(request.checkpoint){
    if(!currentCase)throw new Error('no active case');
    emit({checkpoint:await external('checkpoint.mjs',[root,String(currentCase.id),request.checkpoint,request.window??currentCase.window??''])});continue;
   }
   if(!currentCase&&!(diagnostic&&request.diagnostic))throw new Error('begin a case first');
   if(Date.now()-startedAt>1800000||calls>=300)throw new Error('whole-suite time or tool-call limit exceeded');
   const tool=definitions[request.tool];if(!tool)throw new Error('unknown tool');
   verifyFrozen();
   assertDiagnosticRequest(request.tool,request.args??{},{nativePid:native.pid,webURL,workspace:join(root,'workspace')});
   if(native.exitCode!==null||native.signalCode!==null)throw new Error('Owned fixture process exited; no input is permitted');
   if([request.args,...(request.args?.steps??[])].some(args=>args?.action==='bring_to_front'||args?.allow_real_pointer))throw new Error('foreground and global-pointer actions are forbidden in this suite');
   const call=++calls,started=performance.now(),controller=new AbortController();
   activeCall={call,started};
   const timeout=setTimeout(()=>controller.abort(new Error('tool request deadline')),request.timeoutMs??45000);
   log({call,case:currentCase?.id??null,request});
   try{
    const targetBefore=await observeFocusTargets(processBinary,monitorCandidates.read(),controller.signal);
    const execution={at:Date.now(),startMonotonicMs:performance.now()};
    const result=await tool.execute(request.args??{},{...ctx,signal:controller.signal,toolCallId:'acceptance-'+call});
    execution.end=Date.now();execution.endMonotonicMs=performance.now();
    const targetPid=result.details?.pid;
    const targetAfter=Number.isSafeInteger(targetPid)&&targetPid>0?await observeFocusTargets(processBinary,[targetPid],controller.signal):{at:Date.now(),end:Date.now(),processes:[]};
    if(currentCase&&typeof result.details?.window==='string')currentCase.window=result.details.window;
    const {images,...receipt}=result,imagePaths=(images??[]).map((image,index)=>{
     const path=join(root,'evidence',`image-${call}-${index}.png`);writeFileSync(path,Buffer.from(image.data,'base64'),{flag:'wx'});return path;
    });
    const record={call,case:currentCase?.id??null,elapsedMs:performance.now()-started,execution,targetBefore,targetAfter,result:receipt,imagePaths};log(record);emit({...record,result:{...receipt,details:{...receipt.details,menus:undefined}}});
   }finally{clearTimeout(timeout);}
  }catch(error){const record=activeCall?{call:activeCall.call,elapsedMs:performance.now()-activeCall.started,error:String(error),case:currentCase?.id??null}:{request,error:String(error),case:currentCase?.id??null};log(record);emit(record);}
 }
}catch(error){log({startupOrSessionError:String(error)});throw error;}
finally{await shutdown();process.stdin.pause();process.stdin.unref?.();}
