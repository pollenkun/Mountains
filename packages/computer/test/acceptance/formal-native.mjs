import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {appendFileSync,readFileSync,writeFileSync,existsSync,realpathSync,readdirSync,lstatSync,openSync,closeSync,constants,writeSync,fstatSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {createComputerTools} from '../../src/tools.ts';
import {xa11yDesktop} from '../../src/backend.ts';
import {nativeCoordinator} from '../../src/coordinator.ts';
import {computerUseInstructions} from '../../src/skill.ts';
import {Workspace,FileStateTracker} from '@mountains/tools';
import {checkFrozenVersion,sha256} from './integrity.ts';
import {taskPrompts} from './prompts.ts';
import {signedNativeController} from './native-controller.ts';
import {FocusTargetCandidates} from './focus-targets.ts';
import {readWriterProcess,writerState} from './process-identity.ts';
import {stopFocusMonitor} from './stop-monitor.ts';
import {assertFormalNativeRequest} from './formal-native-policy.ts';
import {readNativePeer} from './native-peer.ts';
import {nativeCaseWindows} from './native-case5.ts';

// Formal, partial execution of one unchanged native case. No canned UI sequence,
// office/account adapters, Web tabs or model API can be reached from this entry.
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../../..');
assert.ok(process.argv[2],'pass one freshly prepared run root');
const root=realpathSync(process.argv[2]),base=realpathSync(join(homedir(),'Movies','Mountains 测试素材'));
assert.equal(dirname(root),base,'formal partial runs must be direct children of the test-material directory');
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));assert.equal(manifest.root,root);assert.equal(manifest.phase,'prepared_only');
const freezePath=join(root,'evidence/freeze.json'),fixed=checkFrozenVersion(freezePath,undefined,{repo,root});
const verifyFixed=()=>checkFrozenVersion(freezePath,fixed.sha256,{repo,root});
const selectedCase=process.argv.includes('--case')?Number(process.argv[process.argv.indexOf('--case')+1]):1;
assert.ok([1,2,4,5].includes(selectedCase),'only independently reviewed native cases 1, 2, 4 and 5 are available');
const cases=JSON.parse(readFileSync(join(here,'cases.json'),'utf8')),spec=cases.cases.find(value=>value.id===selectedCase);
const task=taskPrompts(cases,manifest,'http://127.0.0.1:1').find(value=>value.id===selectedCase);
const mode='phasedInput=true (explicit opt-in; default path not covered)';
const plan={version:1,runner:'self',formal:true,partial:true,root,at:Date.now(),freezeSha256:fixed.sha256,inputMode:mode,allowedCaseIds:[selectedCase],totalCases:20,task,
 priorFailedNativeCase1:join(base,'formal-native-20261019-92903072/evidence/partial-verdict.json'),
 blocked:cases.cases.filter(value=>value.id!==selectedCase).map(value=>({id:value.id,reason:[12,15,16,19].includes(value.id)?'Account isolation/exact-ID inventories and cleanup are not proven':value.id===17?'Clipboard guardian and rich document path are not proven':value.id===1?'Prior recorded formal failure: closed native popup took global keyboard focus; not rerun without a fix':value.id===2||value.id===4?'Not selected for this registered partial execution':'This execution entry has not yet proven ownership and cleanup for this case'})),
 newPaidCallsAllowed:false,noUserAccountOrBrowserProfile:true};
writeFileSync(join(root,'evidence/run-plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
// Append every actual launch attempt. The controller never overwrites a run.
const registry=join(base,'formal-self-registration-20261019.jsonl');
const registryFd=openSync(registry,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
try{assert.ok(fstatSync(registryFd).isFile());writeSync(registryFd,JSON.stringify({at:Date.now(),root,planSha256:sha256(readFileSync(join(root,'evidence/run-plan.json'))),knownEarlierAttempt:join(base,'formal-authorized-preflight-20261019-LDBtlT/result.json')})+'\n');}finally{closeSync(registryFd);}
const journal=join(root,'evidence/operator.jsonl'),focusPath=join(root,'evidence/focus.jsonl');writeFileSync(journal,'',{flag:'wx',mode:0o600});
const log=value=>appendFileSync(journal,JSON.stringify({at:Date.now(),monotonicMs:performance.now(),...value})+'\n');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const pause=ms=>new Promise(yes=>setTimeout(yes,ms)),lifecycle=new AbortController(),lines=createInterface({input:process.stdin,crlfDelay:Infinity});
const startedAt=Date.now(),startedMonotonicMs=performance.now();
const processPath=join(root,'build/ReadProcessIdentity'),identityBinary={path:processPath,sha256:manifest.fixtureHashes[processPath]};
let monitor,monitorClosed,monitorBirth,reader,socket,launcher,launcherClosed,fixturePid,fixtureBirth,desktop,stopping=false,pending,problem,finished,caseStarted,calls=0,dataVerdict;
const cleanup=[],approvals=[],toolRecords=[];
log({sessionStart:true,diagnostic:false,partial:true,runner:'self',pid:process.pid,startedAt,startedMonotonicMs,strictBackground:true,freezeSha256:fixed.sha256,planSha256:sha256(readFileSync(join(root,'evidence/run-plan.json'))),inputMode:mode});
const waitFor=async(label,read,limit=8000,cleanupOnly=false)=>{const end=performance.now()+limit;while(performance.now()<end){if(!cleanupOnly)lifecycle.signal.throwIfAborted();const value=await read();if(!cleanupOnly)lifecycle.signal.throwIfAborted();if(value)return value;await pause(20);}throw new Error(label+' did not become ready; no action was retried');};
const bounded=async(promise,label,ms=5000)=>{let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(new Error(label+' exceeded '+ms+'ms; cleanup is unverified')),ms);})]);}finally{clearTimeout(timer);}};
const readJSON=path=>JSON.parse(readFileSync(path,'utf8'));
const snapshotNative=()=>{
 const text=readFileSync(join(root,'native/native-events.jsonl'),'utf8'),events=socket.verify(text);
 const states=Object.fromEntries(['A','B'].map(document=>{const state=readJSON(join(root,'native/state-'+document+'.json')),signed=events.findLast(row=>row.kind==='state'&&row.document===document)?.state;assert.deepEqual(state,signed,'receiver state differs from its signed event');assert.equal(state.pid,fixturePid);return[document,state];}));
 return{states,eventCount:events.length,journalSha256:sha256(text)};
};
const external=async(file,args)=>{
 verifyFixed();const child=spawn(process.execPath,[join(here,file),...args],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',value=>{out+=value;});child.stderr.on('data',value=>{err+=value;});
 const [code,signal]=await bounded(once(child,'close'),file,10000).catch(error=>{child.kill('SIGKILL');throw error;});assert.equal(signal,null);assert.equal(code,0,file+' failed: '+err+out);return JSON.parse(out);
};
const rawFocus=()=>{if(!existsSync(focusPath))return[];const data=readFileSync(focusPath,'utf8');return data.split('\n').slice(0,-1).filter(Boolean).map(JSON.parse);};
function stop(reason){problem??=String(reason);stopping=true;lifecycle.abort(new Error(String(reason)));lines.close();process.stdin.pause();process.stdin.unref?.();}
const deadline=setTimeout(()=>stop('original case '+selectedCase+' deadline exceeded ('+spec.deadlineMs+'ms including startup and agent decisions)'),spec.deadlineMs);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop('controller received '+signal));

async function finish(){
 if(finished)return finished;
 return finished=(async()=>{
 clearTimeout(deadline);stopping=true;lines.close();process.stdin.pause();process.stdin.unref?.();
 const clean=async(name,action)=>{try{await action();cleanup.push({name,passed:true});}catch(error){cleanup.push({name,passed:false,error:String(error)});problem??=String(error);}};
 // pending is the actual tool promise, not merely an abort receipt. Do not
 // grant any global restoration before it has returned through its finally.
 if(pending)await clean('wait for actual active input',async()=>{await pending;});
 await clean('close owned desktop helpers',async()=>{await bounded(Promise.resolve(desktop?.close?.()),'desktop close');});
 await clean('close private fixture lifetime stream',async()=>{await socket?.close();});
 await clean('confirm exact owned fixture exited',async()=>{if(fixtureBirth)await waitFor('owned fixture exit',async()=>writerState(fixtureBirth,await readWriterProcess(identityBinary,fixturePid))==='exited',3000,true);});
 await clean('confirm own launcher exited',async()=>{if(launcherClosed){const [code,signal]=await bounded(launcherClosed,'launcher close',3000);assert.equal(code,0);assert.equal(signal,null);}});
 await clean('verify final signed receiver evidence',async()=>{if(fixtureBirth){const snapshot=snapshotNative();log({nativeJournalVerified:snapshot});}});socket?.forgetKey();
 const inputCleanupEndedAt=Date.now();log({inputCleanupEndedAt});
 await clean('stop and flush exact independent monitor',async()=>{if(monitor){
  let identityError;try{assert.equal(writerState(monitorBirth,await readWriterProcess(identityBinary,monitor.pid)),'alive');}catch(error){identityError=error;}
  log({monitorStopRequested:true,monitorProcess:monitorBirth?{status:'alive',identity:monitorBirth}:null,identityError:identityError?String(identityError):null});
  // A failed identity observation must not skip EOF of our own child stream.
  await stopFocusMonitor(monitor);const [code,signal]=await monitorClosed;assert.equal(code,0);assert.equal(signal,null);if(identityError)throw identityError;
 }});
 await clean('check full focus history and cleanup tail',async()=>{try{reader?.verifyPrefix();}finally{reader?.close();}if(monitor){const last=rawFocus().at(-1);assert.equal(last?.kind,'stopped');assert.ok(Math.floor(last.at)>=inputCleanupEndedAt,'final observation predates input cleanup');}});
 await clean('recheck frozen sources and binaries',async()=>{verifyFixed();});
 const elapsed=performance.now()-startedMonotonicMs,caseMs=caseStarted?performance.now()-caseStarted.startedMonotonicMs:elapsed;
 const passed=!!dataVerdict?.passed&&!problem&&calls>0&&calls<=spec.maxToolCalls&&caseMs<=spec.deadlineMs;
 log({caseEnd:{id:selectedCase,wallMs:caseMs,calls,dataVerdict:dataVerdict??{passed:false,error:problem??'not completed'},passed}});
 log({sessionEnd:true,totalCalls:calls,wallMs:elapsed,cleanupErrors:cleanup.filter(row=>!row.passed),partial:true});
 const skillCharacters=Array.from(computerUseInstructions(false)).length;
 const result={runner:'self',formal:true,partial:true,passed:false,suitePassed:false,totalCases:20,root,inputMode:mode,error:problem??null,paidCalls:0,
  cases:cases.cases.map(value=>({id:value.id,title:value.title,...(value.id===selectedCase?{status:passed?'passed':'failed',passed,wallMs:caseMs,calls,approvals:approvals.length,dataVerdict:dataVerdict??null,error:problem??null}:{status:'not_run',passed:false,reason:plan.blocked.find(row=>row.id===value.id).reason})})),
  cleanup,metrics:{wallMs:elapsed,toolCalls:calls,tools:toolRecords.map(row=>({call:row.call,tool:row.tool,toolMs:row.elapsedMs})),warmReadP95Ms:null,ordinaryActionP95Ms:null,commonSpeedGates:'Insufficient samples; at least 30 warm reads and 30 ordinary actions are required',skillCharacters,skillLimit:2500,skillOverage:Math.max(0,skillCharacters-2500)},
  missing:['19 original cases not executed','Full-suite performance, technical checks, and real model-run evidence remain incomplete'],freezeSha256:fixed.sha256};
 writeFileSync(join(root,'evidence/partial-verdict.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
 const hashes={};const collect=path=>{const info=lstatSync(path);assert.ok(!info.isSymbolicLink());if(info.isDirectory())for(const name of readdirSync(path))collect(join(path,name));else if(info.isFile())hashes[path]=sha256(readFileSync(path));};collect(root);
 writeFileSync(join(root,'evidence/sha256-index.json'),JSON.stringify(hashes,null,2),{flag:'wx',mode:0o600});
 emit({finished:true,suitePassed:false,case:selectedCase,casePassed:passed,calls,error:problem??null,result:join(root,'evidence/partial-verdict.json')});process.exitCode=1;
 })();
}

try{
 verifyFixed();caseStarted={id:selectedCase,started:Date.now(),startedMonotonicMs:performance.now(),callStart:0};log({caseStart:caseStarted});log({taskDelivered:task});
 lifecycle.signal.throwIfAborted();monitor=spawn(join(root,'build/FocusMonitor'),[focusPath],{stdio:['pipe','ignore','pipe']});monitorClosed=once(monitor,'close');void monitorClosed.catch(()=>{});monitor.stderr.on('data',value=>log({monitorError:String(value)}));await once(monitor,'spawn');lifecycle.signal.throwIfAborted();
 const monitorProcess=await readWriterProcess(identityBinary,monitor.pid);assert.equal(monitorProcess.status,'alive');monitorBirth=monitorProcess.identity;log({monitorStart:{pid:monitor.pid,process:monitorProcess}});
 await waitFor('independent monitor ready',()=>{assert.equal(monitor.exitCode,null);assert.equal(monitor.signalCode,null);return rawFocus().find(row=>row.kind==='ready');});
 reader=new FocusTargetCandidates(focusPath,{monitorBirth,maxSampleGapMs:150,maxFreshnessMs:150});reader.snapshot();
 lifecycle.signal.throwIfAborted();socket=await signedNativeController(async(peer,pid)=>{
  const path=join(root,'build/ReadFixturePeer'),actual=await readNativePeer({path,sha256:manifest.fixtureHashes[path]},peer);
  assert.equal(actual.pid,pid,'fixture handshake PID differs from OS socket peer');assert.equal(actual.executable,join(root,'build/Mountains QA.app/Contents/MacOS/MountainsQA'),'socket peer is not the exact owned executable');
  fixturePid=actual.pid;fixtureBirth=actual.birth;log({fixturePeerVerified:{pid:actual.pid,birth:actual.birth,executable:actual.executable}});
 });lifecycle.signal.throwIfAborted();
 const bundle=join(root,'build/Mountains QA.app');launcher=spawn('/usr/bin/open',['-g','-W','-n','-a',bundle,'--args',join(root,'native'),socket.path],{stdio:['ignore','ignore','pipe']});launcherClosed=once(launcher,'close');void launcherClosed.catch(()=>{});launcher.stderr.on('data',value=>log({fixtureError:String(value)}));await once(launcher,'spawn');lifecycle.signal.throwIfAborted();
 fixturePid=(await bounded(socket.connected,'fixture handshake',8000)).pid;const process=await readWriterProcess(identityBinary,fixturePid);assert.equal(process.status,'alive');assert.deepEqual(process.identity,fixtureBirth,'fixture peer birth differs after handshake');log({fixtureStart:'native',pid:fixturePid,launcherPid:launcher.pid,birth:fixtureBirth,bundle});
 await waitFor('owned native states',()=>existsSync(join(root,'native/state-A.json'))&&existsSync(join(root,'native/state-B.json')));
 await waitFor('current owned target subscription',()=>{const row=reader.snapshot().subscriptions.find(row=>row.pid===fixturePid);if(!row)return null;assert.deepEqual(row.birth,fixtureBirth);return row;});
 const initial=snapshotNative(),windows=nativeCaseWindows(initial.states,selectedCase),window=windows.A;
 await external('checkpoint.mjs',[root,String(selectedCase),'before']);
 lifecycle.signal.throwIfAborted();desktop=await xa11yDesktop({cursor:false,phasedInput:true});lifecycle.signal.throwIfAborted();const tools=createComputerTools({desktop:async()=>desktop,coordinator:nativeCoordinator,cursor:false});
 const context={workspace:new Workspace(join(root,'workspace')),files:new FileStateTracker(),signal:lifecycle.signal,approve:async request=>{
  const decision=request.command==='Use computer use in this conversation'?'allow':'deny';const row={request,decision,answeredBy:'test-script',authorization:'Test script answered this individual request; no standing user permission'};approvals.push(row);log({approval:row});return decision;
 }};
 emit({ready:true,formal:true,partial:true,task:task.text,app:String(fixturePid),window,windows,inputMode:mode,initial});
 for await(const line of lines){
  if(stopping)break;if(!line.trim())continue;const request=JSON.parse(line);
  if(request.finish){snapshotNative();await external('checkpoint.mjs',[root,String(selectedCase),'complete']);dataVerdict=await external('verify.mjs',[root,String(selectedCase),'--runner','self']);break;}
  const call=++calls,started=performance.now();log({call,case:selectedCase,request});const args={...request.args};
  let record={call,case:selectedCase,tool:request.tool},execution;
  try{
   assert.ok(calls<=spec.maxToolCalls,'original case call limit exceeded');const ownedWindows=nativeCaseWindows(snapshotNative().states,selectedCase);assertFormalNativeRequest(request.tool,args,{pid:fixturePid,windows:Object.values(ownedWindows)});record.ownedWindows=ownedWindows;verifyFixed();
   lifecycle.signal.throwIfAborted();assert.equal(writerState(fixtureBirth,await readWriterProcess(identityBinary,fixturePid)),'alive');
   const before=reader.snapshot(),subscription=before.subscriptions.find(row=>row.pid===fixturePid);assert.ok(subscription);assert.deepEqual(subscription.birth,fixtureBirth);
   record.targetBefore={at:Date.now(),snapshot:before,processes:[{pid:fixturePid,observation:{status:'alive',identity:fixtureBirth}}]};
   const tool=tools.find(tool=>tool.name===request.tool);assert.ok(tool);execution={at:Date.now(),startMonotonicMs:performance.now()};
   let result;pending=tool.execute(args,{...context,toolCallId:'formal-case'+selectedCase+'-'+call});try{result=await pending;}finally{pending=undefined;}execution.end=Date.now();execution.endMonotonicMs=performance.now();
   const {images,...receipt}=result;record={...record,elapsedMs:performance.now()-started,execution,result:receipt};
   // Preserve actual output before any independent check can fail.
   log({...record,result:undefined,actualToolOutput:receipt,rawToolResult:true});
   const receiver=snapshotNative();writeFileSync(join(root,'evidence',`call-${call}-receiver.json`),JSON.stringify(receiver,null,2),{flag:'wx',mode:0o600});
   assert.equal(writerState(fixtureBirth,await readWriterProcess(identityBinary,fixturePid)),'alive');const after=reader.snapshot();assert.deepEqual(after.subscriptions.find(row=>row.pid===fixturePid),subscription);
   record.targetAfter={at:Date.now(),snapshot:after,processes:[{pid:fixturePid,observation:{status:'alive',identity:fixtureBirth}}]};record.receiver=receiver;
   assert.equal(result.ok,true,'first tool attempt failed; no retry is permitted');
   record.elapsedMs=performance.now()-started;log({...record,postcheck:true});toolRecords.push(record);emit({call,case:selectedCase,elapsedMs:record.elapsedMs,result:record.result,receiver:record.receiver});
  }catch(error){record={...record,elapsedMs:performance.now()-started,error:String(error),execution};log(record);toolRecords.push(record);emit({call,case:selectedCase,elapsedMs:record.elapsedMs,error:record.error,result:record.result});throw error;}
 }
 if(!dataVerdict)throw new Error('case ended before independent completion verification');
}catch(error){problem=String(error?.stack??error);log({formalError:problem});emit({error:problem,formal:true,partial:true});}
finally{await finish();}
