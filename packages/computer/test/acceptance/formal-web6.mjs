import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync,readdirSync,lstatSync,readlinkSync,openSync,closeSync,constants,fstatSync,writeSync,fsyncSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {WebBrowser,createWebTools} from '../../src/web.ts';
import {computerUseInstructions} from '../../src/skill.ts';
import {Workspace,FileStateTracker} from '@mountains/tools';
import {signedFormService} from './signed-form-service.ts';
import {attachRequestWitness} from './request-witness-adapter.ts';
import {witnessBrowserObserver} from './witness-browser-observer.ts';
import {documentRequestWitness} from './document-request-witness.ts';
import {readWriterProcess,readExecutableProcess,writerState} from './process-identity.ts';
import {FocusTargetCandidates} from './focus-targets.ts';
import {verifyFocusEvidence} from './focus-proof.ts';
import {checkFrozenVersion,sha256} from './integrity.ts';
import {stopFocusMonitor} from './stop-monitor.ts';
import {assertFormalWebRequest,formalWebNavigates} from './formal-web-policy.ts';
import {controllerInput} from './controller-input.ts';
import {RunAwake} from './run-awake.ts';
import {TaskDeletionPermit} from './task-deletion-permit.ts';
import {verifyWebTasksSorted} from './web-tasks-readback.ts';
import {verifyWebRecordsPhase} from './web-records-readback.ts';
import {verifyWebDetailPhase} from './web-detail-readback.ts';
import {verifyWebDataWithTarget} from './web-verifier-channel.ts';
import {taskPrompts} from './prompts.ts';
import {toolTrace} from './trace.mjs';

// One independently reviewed partial case, driven by model decisions received
// on stdin. There is no stored sequence of UI operations and no account/API
// model/command tool. Startup opens only this new fixture's page, then hands
// every business action to Mountains' production web tools.
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../../..');
const caseId=Number(process.argv[3]??6);assert.ok([6,7,8,9,10].includes(caseId),'this entry supports only cases 6 through 10');const caseName='case'+caseId,caseTag=String(caseId).padStart(2,'0');
assert.ok(process.argv[2],'pass a freshly prepared and frozen run root');
const root=realpathSync(process.argv[2]),base=realpathSync(join(homedir(),'Movies','Mountains 测试素材'));assert.equal(dirname(root),base);
assert.ok(!process.env.NODE_OPTIONS,'formal controller does not load environment-provided Node hooks');
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));assert.equal(manifest.root,root);assert.equal(manifest.phase,'prepared_only');
const fixed=checkFrozenVersion(join(root,'evidence/freeze.json'),undefined,{repo,root}),fixedNow=()=>checkFrozenVersion(join(root,'evidence/freeze.json'),fixed.sha256,{repo,root});
const cases=JSON.parse(readFileSync(join(here,'cases.json'),'utf8')),spec=cases.cases.find(row=>row.id===caseId);
const startedAt=Date.now(),startedMonotonicMs=performance.now(),journalPath=join(root,'evidence/operator.jsonl'),focusPath=join(root,'evidence/focus.jsonl');
writeFileSync(journalPath,'',{flag:'wx',mode:0o600});
const journal=[],log=data=>{const row={at:Date.now(),monotonicMs:performance.now(),...data};appendFileSync(journalPath,JSON.stringify(row)+'\n');journal.push(row);return row;};
const emit=data=>process.stdout.write(JSON.stringify(data)+'\n'),lifecycle=new AbortController(),signal=lifecycle.signal;
const wait=ms=>new Promise(yes=>setTimeout(yes,ms));
const waitFor=async(label,read,maxMs=8000,cleanupOnly=false)=>{const end=performance.now()+maxMs;while(performance.now()<end){if(!cleanupOnly)signal.throwIfAborted();const value=await read();if(value)return value;await wait(20);}throw new Error(label+' did not become ready; no action was retried');};
const bounded=async(promise,label,ms=5000)=>{let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(new Error(label+' timed out; cleanup is unverified')),ms);})]);}finally{clearTimeout(timer);}};
const nativePath=join(root,'build/ReadProcessIdentity'),native={path:nativePath,sha256:manifest.fixtureHashes[nativePath]};
const plan={version:1,formal:true,partial:true,runner:'self',root,caseId,totalCases:20,startedAt,startedMonotonicMs,freezeSha256:fixed.sha256,mode:'production directly owned headless Chrome, fresh profile',inputTransport:{kind:'interactive-self-tty',isTTY:process.stdin.isTTY===true},powerPreparation:{caseLocal:true,requiresAC:true,timeoutSeconds:Math.ceil(spec.deadlineMs/1000)+30,waitForOriginalController:true,requestsDisplayWake:false,requestsUserActivity:false,persistentSettings:false},paidCalls:0,accountOperations:false,allowModelTools:['web_read','web_act'],pendingRuntimeDestination:true};
const planPath=join(root,'evidence/run-plan.json');writeFileSync(planPath,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
const registryFd=openSync(join(base,'formal-self-registration-20261019.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
try{const info=fstatSync(registryFd);assert.ok(info.isFile()&&info.nlink===1);writeSync(registryFd,JSON.stringify({at:Date.now(),root,caseId,planSha256:sha256(readFileSync(planPath)),entry:'formal-web6.mjs'})+'\n');fsyncSync(registryFd);}finally{closeSync(registryFd);}
let deletionPermit,deletionConfirmation;
const recordCheckpoints=[],detailCheckpoints=[];
let awake,monitor,monitorClosed,monitorBirth,reader,service,browser,adapter,browserObserver,documentRequests,cdp,chromeChild,chromeBirth,chromeExecutable,controllerBirth,problem,pending,browserStarted=false,calls=0,dataVerdict,finished;
const cleanup=[],approvals=[],toolRecords=[];
let input;
const stop=reason=>{problem??=String(reason);lifecycle.abort(new Error(String(reason)));input?.cancel(new Error(String(reason)));process.stdin.pause();process.stdin.unref?.();};
input=controllerInput(process.stdin,signal,error=>stop(error.message));
const deadline=setTimeout(()=>stop('original '+caseName+' '+spec.deadlineMs+'ms total deadline exceeded'),spec.deadlineMs);
for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>stop('controller received '+name));
const rawFocus=()=>readFileSync(focusPath,'utf8').split('\n').slice(0,-1).filter(Boolean).map(JSON.parse);
const snapshotServer=()=>{const rows=service.verify(),outcomes=rows.filter(row=>['form-committed','form-invalid'].includes(row.kind)),forms=outcomes.at(-1)?.forms??[],web=caseId!==6?rows.findLast(row=>row.web)?.web:{forms};assert.ok(web);return{rows,forms,web,sha256:sha256(readFileSync(service.journalPath))};};
const cleanupLog=data=>{try{log(data);}catch{problem??='cleanup journal write failed';journal.push({at:Date.now(),monotonicMs:performance.now(),...data,journalWriteFailed:true});}};
async function finish(){
 if(finished)return finished;
 return finished=(async()=>{
  clearTimeout(deadline);input.close();process.stdin.pause();process.stdin.unref?.();
  const clean=async(name,action)=>{const at=Date.now(),startMonotonicMs=performance.now();try{const evidence=await action();cleanup.push({name,passed:true,at,end:Date.now(),startMonotonicMs,endMonotonicMs:performance.now(),evidence:evidence??null});}catch(error){const message=String(error);cleanup.push({name,passed:false,at,end:Date.now(),startMonotonicMs,endMonotonicMs:performance.now(),error:message});problem??=message;}};
  if(pending)await clean('wait for actual active tool',async()=>{await pending;return{actualToolSettled:true};});
  await clean('detach own private CDP session',async()=>{await adapter?.close();return{scope:adapter?.scope,requestProofs:adapter?.publicRecords()};});
  if(browserObserver)await clean('close permanent page observation and its private clock target',async()=>{const evidence=await browserObserver.close();return{...evidence,documentRequests:documentRequests?.snapshot()};});
  await clean('close exact production browser child',async()=>{const child=chromeChild;await bounded(Promise.resolve(browser?.close()),'production Chrome close',12000);return child?{pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode}:null;});
  await clean('independent original Chrome exit',async()=>{if(chromeBirth){const observation=await readWriterProcess(native,chromeBirth.pid);assert.equal(writerState(chromeBirth,observation),'exited');return{original:chromeBirth,observation};}assert.ok(!browserStarted,'Chrome startup has no independently bound original process');return{notStarted:true};});
  await clean('close and verify signed HTTP service',async()=>{if(service){const before=snapshotServer();await service.close();return{verifiedBeforeClose:{rows:before.rows.length,sha256:before.sha256},finalJournalSha256:sha256(readFileSync(service.journalPath))};}});
  cleanupLog({inputCleanupEndedAt:Date.now()});
  await clean('verify case-local power assertions through UI cleanup',async()=>awake?await awake.check():{notStarted:true});
  await clean('release exact case-local power process and assertions',async()=>awake?await awake.close():{notStarted:true});
  cleanupLog({fixtureExit:true,resource:'owned power, Chrome and HTTP fixture'});
  await clean('stop and flush exact independent monitor',async()=>{if(monitor){const observation=await readWriterProcess(native,monitor.pid);let identityError;try{assert.ok(monitorBirth);assert.equal(writerState(monitorBirth,observation),'alive');}catch(error){identityError=String(error);}cleanupLog({monitorStopRequested:true,monitorProcess:observation,identityError:identityError??null});await stopFocusMonitor(monitor);const ended=await monitorClosed;cleanupLog({monitorExit:{requested:true,...ended}});assert.deepEqual(ended,{code:0,signal:null});if(identityError)throw new Error(identityError);return ended;}});
  await clean('verify full focus history and cleanup tail',async()=>{try{assert.ok(reader,'independent focus history was not established');if(reader){const cursor=reader.verifyPrefix();verifyFocusEvidence({focus:rawFocus(),journal,trace:toolTrace(root,'self'),maxSampleGapMs:150});return cursor;}}finally{reader?.close();}});
  await clean('unchanged frozen sources and original controller',async()=>{fixedNow();if(controllerBirth){const current=await readExecutableProcess(native,process.pid);assert.ok(current);assert.deepEqual(current.observation.identity,controllerBirth);return current;}});

  const wallMs=performance.now()-startedMonotonicMs;let passed=!!dataVerdict?.passed&&!problem&&calls>0&&calls<=spec.maxToolCalls&&wallMs<=spec.deadlineMs;
  cleanupLog({caseEnd:{id:caseId,passed,calls,wallMs,dataVerdict:dataVerdict??null}});cleanupLog({sessionEnd:true,partial:true,totalCalls:calls,wallMs,cleanupErrors:cleanup.filter(row=>!row.passed)});
  // Terminal journal writes are evidence too. Their failure must invalidate
  // the authoritative verdict, even after earlier checks found valid data.
  passed=passed&&!problem;
  const skillCharacters={text:Array.from(computerUseInstructions(false)).length,image:Array.from(computerUseInstructions(true)).length};
  const result={runner:'self',formal:true,partial:true,passed:false,suitePassed:false,totalCases:20,root,paidCalls:0,error:problem??null,cases:cases.cases.map(row=>({id:row.id,title:row.title,...(row.id===caseId?{status:passed?'passed':'failed',passed,wallMs,calls,approvals:approvals.length,dataVerdict:dataVerdict??null,error:problem??null}:{status:'not_run',passed:false,reason:'not selected in this registered partial run; previous versions cannot be combined'})})),cleanup,metrics:{wallMs,toolCalls:calls,tools:toolRecords.map(row=>({call:row.call,tool:row.tool,elapsedMs:row.elapsedMs})),skillCharacters,skillLimit:2500,warmReadP95Ms:null,ordinaryActionP95Ms:null,performance:'insufficient samples for the common 30-sample p95 gates'},freezeSha256:fixed.sha256};
  writeFileSync(join(root,'evidence/partial-verdict.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
  const hashes={};const collect=path=>{const info=lstatSync(path);if(info.isDirectory())for(const name of readdirSync(path))collect(join(path,name));else if(info.isSymbolicLink())hashes[path]='symlink:'+readlinkSync(path);else if(info.isFile())hashes[path]=sha256(readFileSync(path));else hashes[path]='nonregular';};collect(root);writeFileSync(join(root,'evidence/sha256-index.json'),JSON.stringify(hashes,null,2),{flag:'wx',mode:0o600});emit({finished:true,formal:true,partial:true,case:caseId,casePassed:passed,calls,wallMs,error:problem??null,root,cleanup});
 })();
}
try{
 const self=await readExecutableProcess(native,process.pid);assert.ok(self);assert.equal(realpathSync(self.executable),realpathSync(process.execPath));controllerBirth=self.observation.identity;
 log({sessionStart:true,diagnostic:false,runner:'self',formal:true,partial:true,pid:process.pid,controller:self,inputTransport:plan.inputTransport,nodeSha256:sha256(readFileSync(process.execPath)),freezeSha256:fixed.sha256,planSha256:sha256(readFileSync(planPath))});
 assert.equal(process.stdin.isTTY,true,'this manually driven self entry requires a persistent interactive TTY');signal.throwIfAborted();

 fixedNow();monitor=spawn(join(root,'build/FocusMonitor'),[focusPath],{stdio:['pipe','ignore','pipe']});let monitorLaunchError;monitor.on('error',error=>{monitorLaunchError=String(error);});monitorClosed=new Promise(yes=>monitor.once('close',(code,signal)=>yes({code,signal,...(monitorLaunchError?{error:monitorLaunchError}:{})})));monitor.stderr?.on('data',()=>{});
 const observation=await readWriterProcess(native,monitor.pid);assert.equal(observation.status,'alive');monitorBirth=observation.identity;log({monitorStart:{pid:monitor.pid,process:observation}});
 await waitFor('independent focus monitor',()=>existsSync(focusPath)&&rawFocus().some(row=>row.kind==='ready'));
 reader=new FocusTargetCandidates(focusPath,{monitorBirth,maxSampleGapMs:150});reader.snapshot();log({fixtureStart:true,resource:'owned power, Chrome and HTTP fixture'});
 awake=new RunAwake(native,controllerBirth,error=>stop(error.message),plan.powerPreparation.timeoutSeconds);log({powerPreparationStartRequested:true,policy:plan.powerPreparation});log({powerPreparationReady:await awake.start(signal)});
 service=await signedFormService(join(root,'web'),caseId===10?'detail':caseId===9?'records':caseId===8?'tasks':caseId===7?'async':'form');writeFileSync(join(root,'web/server.json'),JSON.stringify({url:service.origin,pid:process.pid,controllerBirth}),{flag:'wx',mode:0o600});
 writeFileSync(join(root,'evidence/case-'+caseTag+'-before.json'),JSON.stringify({id:caseId,phase:'before',at:Date.now(),native:{},nativeEvents:[],web:snapshotServer().web,noDOMColdBaseline:true}),{flag:'wx',mode:0o600});
 assert.ok(!existsSync(join(root,'browser')),'formal browser profile must not exist before this run');
 browser=new WebBrowser({headless:true,profileDir:join(root,'browser'),downloadDir:join(root,'workspace/downloads')});
 browserStarted=true;const bootstrap=await browser.open(caseId===10?{newTab:true}:{url:service.url},signal);log({setup:{kind:caseId===10?'blank-before-business-observation':'initial-fixture-page',url:bootstrap.url,tab:bootstrap.tab,targetId:bootstrap.targetId,notAModelBusinessAction:true}});
 chromeChild=browser.child;assert.ok(chromeChild?.pid&&browser.childLifetime?.child===chromeChild&&browser.childLifetime.isBrowser);
 const executable=await readExecutableProcess(native,chromeChild.pid);assert.ok(executable);chromeBirth=executable.observation.identity;chromeExecutable=executable.executable;assert.equal(realpathSync(chromeExecutable),realpathSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
 cdp=await browser.connection(signal);const expectedPort=readFileSync(join(root,'browser/DevToolsActivePort'),'utf8'),[port,path]=expectedPort.trim().split('\n');assert.equal(browser.endpoint,'ws://127.0.0.1:'+port+path);
 const initialCommand=await cdp.send('Browser.getBrowserCommandLine',{},undefined,3000),ownerArgs=initialCommand.arguments.filter(arg=>arg.startsWith('--mountains-browser-owner='));assert.equal(ownerArgs.length,1);
 await waitFor('Chrome focus subscription',()=>reader.snapshot().subscriptions.some(row=>row.pid===chromeChild.pid));
 const owner=async()=>{
  signal.throwIfAborted();assert.equal(browser.child,chromeChild);const at=Date.now(),before=reader.snapshot(),current=await readExecutableProcess(native,chromeChild.pid);assert.ok(current);assert.deepEqual(current.observation.identity,chromeBirth);assert.equal(current.executable,chromeExecutable);
  const processInfo=await cdp.send('SystemInfo.getProcessInfo',{},undefined,3000),roots=processInfo.processInfo.filter(row=>row.type==='browser');assert.equal(roots.length,1);assert.equal(roots[0].id,chromeChild.pid);
  const command=await cdp.send('Browser.getBrowserCommandLine',{},undefined,3000);assert.ok(command.arguments.includes('--user-data-dir='+join(root,'browser'))&&command.arguments.includes(ownerArgs[0]));assert.equal(readFileSync(join(root,'browser/DevToolsActivePort'),'utf8'),expectedPort);
  const after=reader.snapshot(),subscription=before.subscriptions.find(row=>row.pid===chromeChild.pid);assert.ok(subscription);assert.deepEqual(subscription,after.subscriptions.find(row=>row.pid===chromeChild.pid));assert.deepEqual(subscription.birth,chromeBirth);signal.throwIfAborted();
  return{at,end:Date.now(),snapshot:after,processes:[{pid:chromeChild.pid,observation:current.observation}],executable:current.executable};
 };
 if(caseId===10){
  browserObserver=await witnessBrowserObserver(cdp,{targetId:bootstrap.targetId,allowedURLs:['about:blank',service.url,service.origin+'/detail'],verifyOwner:async()=>{await owner();}});
  const initial=await browser.open({tab:bootstrap.tab,url:service.url},signal);log({setup:{kind:'initial-fixture-page-after-observation',url:initial.url,tab:initial.tab,targetId:initial.targetId,notAModelBusinessAction:true}});
  documentRequests=await documentRequestWitness(cdp,{observer:browserObserver,verifyOwner:async()=>{await owner();}});adapter=documentRequests;
 }else adapter=await attachRequestWitness(cdp,{targetId:bootstrap.targetId,pageURL:service.url,verifyOwner:async()=>{await owner();}});
 if(caseId===8)deletionPermit=new TaskDeletionPermit(adapter.scope,{tab:bootstrap.tab,id:'own-1',name:manifest.values.web08.edited});service.bind({...adapter.authorization,authorizeTaskDeletion:(task,state,proof)=>{assert.ok(deletionPermit);return deletionPermit.consume(task,state,proof);}});
 const independentPage=async()=>{browserObserver?.verifyComplete();await owner();fixedNow();const at=Date.now(),child=spawn(process.execPath,[join(here,'read-web.mjs'),root,bootstrap.targetId],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',value=>out+=value);child.stderr.on('data',value=>err+=value);let launchError;child.on('error',error=>{launchError=String(error);});const closed=new Promise(yes=>child.once('close',(code,signal)=>yes({code,signal,...(launchError?{error:launchError}:{})})));const status=await bounded(closed,'independent DOM read',10000).catch(async error=>{child.kill('SIGKILL');await closed;throw error;});assert.deepEqual(status,{code:0,signal:null},err);const page=JSON.parse(out);await owner();browserObserver?.verifyComplete();return{at,capturedAt:Date.now(),page};};
 const tools=createWebTools({browser,consent:{granted:false}}),toolCatalog=tools.map(({name,description,parameters})=>({name,description,parameters})),instructions=computerUseInstructions(false);
 const protocols={...(caseId===10?{checkpointProtocol:{request:{checkpoint:'cancelled, refreshed, then escaped'},instruction:'Send {"checkpoint":"cancelled"} after dismissing the first JS confirm; send {"checkpoint":"refreshed"} after saving, closing alert, back, forward and reload; send {"checkpoint":"escaped"} after reopening HTML edit and pressing Escape. These are independent read-only observations, not UI actions. Keep navigation in separate pure-navigation calls; back/forward/reload may share steps.'}}:{}),...(caseId===9?{checkpointProtocol:{request:{checkpoint:'paged or filtered'},instruction:'After actually finding the target by paging, send {"checkpoint":"paged"}. After filtering by its actual name to two rows and before editing, send {"checkpoint":"filtered"}. These are independent read-only observations, in this order, not UI actions; they do not navigate, type or reset the original total deadline.'}}:{}),...(caseId===8?{confirmationProtocol:{request:{confirm:{effect:'delete',tab:bootstrap.tab,id:'read the actual first item ID',name:'read its edited name',question:'Ask whether to delete this exact id and name'}},instruction:'Send this explicit question after editing and reverse sorting, immediately before one click of that exact Delete button; no other steps in this action. The test script answers this individual request; it is not standing human consent.'}}:{})};
 const task=taskPrompts(cases,manifest,service.origin).find(row=>row.id===caseId),taskPlan={...protocols,caseId,task:task.text,url:service.url,targetId:bootstrap.targetId,tab:bootstrap.tab,instructions,tools:toolCatalog,freezeSha256:fixed.sha256};
 writeFileSync(join(root,'evidence/task-plan.json'),JSON.stringify(taskPlan,null,2),{flag:'wx',mode:0o600});log({taskPresented:task.text,taskPlanSha256:sha256(readFileSync(join(root,'evidence/task-plan.json'))),owner:await owner()});
 const context={workspace:new Workspace(join(root,'workspace')),files:new FileStateTracker(),signal,approve:async request=>{const decision=request.command==='Use the web browser in this conversation'?'allow':'deny';const row={request,decision,answeredBy:'test-script',authorization:'Test script answered this individual request; no standing human authorization'};approvals.push(row);log({approval:row});return decision;}};
 const presented={...protocols,ready:true,formal:true,partial:true,case:caseId,task:task.text,tab:bootstrap.tab,pageAlreadyOpened:true,instructions,tools:toolCatalog,instruction:caseId===10?'The original Form page is open. Read this exact tab, then follow the task through actual page controls. Every business action is your decision through the production tools.':'Use web_read with this exact tab; do not repeat navigation. Every following business action is your decision through the production tools.'};log({modelContextPresented:presented});emit(presented);
 for(;;){
  const line=await input.next();
  signal.throwIfAborted();if(!line.trim())continue;const request=JSON.parse(line);
  if(request.checkpoint){
   if(caseId===10){assert.deepEqual(Object.keys(request),['checkpoint']);const phase=request.checkpoint;assert.equal(phase,['cancelled','refreshed','escaped'][detailCheckpoints.length]);fixedNow();await awake.check(signal);documentRequests.verifyComplete();const receiver=snapshotServer(),captured=await independentPage(),checkpoint={id:10,phase,...captured,native:{},nativeEvents:[],web:receiver.web,webEvents:receiver.rows,webTarget:bootstrap.targetId,browserObserver:browserObserver.snapshot(),documentRequests:documentRequests.snapshot()};verifyWebDetailPhase(checkpoint,phase,{targetId:bootstrap.targetId,url:service.origin+'/detail',...manifest.values.web10});const path=join(root,'evidence/case-10-'+phase+'.json');writeFileSync(path,JSON.stringify(checkpoint,null,2),{flag:'wx',mode:0o600});detailCheckpoints.push(phase);log({checkpoint:phase,checkpointSha256:sha256(readFileSync(path))});emit({checkpoint:phase,observed:true,independent:true});continue;}
   assert.equal(caseId,9);assert.deepEqual(Object.keys(request),['checkpoint']);const phase=request.checkpoint;assert.equal(phase,['paged','filtered'][recordCheckpoints.length],'two ordered pre-write observations are required');fixedNow();await awake.check(signal);const receiver=snapshotServer(),captured=await independentPage(),checkpoint={id:9,phase,...captured,native:{},nativeEvents:[],web:receiver.web,webEvents:receiver.rows,webTarget:bootstrap.targetId};verifyWebRecordsPhase(checkpoint,phase,{targetId:bootstrap.targetId,url:service.url,...manifest.values.web09});const path=join(root,'evidence/case-09-'+phase+'.json');writeFileSync(path,JSON.stringify(checkpoint,null,2),{flag:'wx',mode:0o600});recordCheckpoints.push(phase);log({checkpoint:phase,checkpointSha256:sha256(readFileSync(path))});emit({checkpoint:phase,observed:true,independent:true});continue;
  }
  if(request.confirm){
   assert.equal(caseId,8);assert.deepEqual(Object.keys(request),['confirm']);const askedAt=Date.now(),approval={request:request.confirm,decision:'deny',answeredBy:'test-script',authorization:'Test script answered this individual request; no standing human authorization'};approvals.push(approval);log({confirmationQuestion:{question:request.confirm,askedAt}});
   try{fixedNow();await awake.check(signal);const receiver=snapshotServer(),captured=await independentPage(),sorted={id:8,phase:'sorted',...captured,native:{},nativeEvents:[],web:receiver.web,webEvents:receiver.rows,webTarget:bootstrap.targetId};verifyWebTasksSorted(sorted,{targetId:bootstrap.targetId,url:service.url,...manifest.values.web08});writeFileSync(join(root,'evidence/case-08-sorted.json'),JSON.stringify(sorted,null,2),{flag:'wx',mode:0o600});const answer=deletionPermit.issue(request.confirm,browser.latest(bootstrap.tab),receiver.web,askedAt);deletionConfirmation={question:request.confirm,askedAt,answer};Object.assign(approval,answer);log({approval});emit({confirmation:answer});}
   catch(error){log({approval});throw error;}continue;
  }
  if(request.finish){
   adapter.verifyComplete();service.assertHealthy();if(caseId===8)deletionPermit.verifyComplete();if(caseId===9)assert.deepEqual(recordCheckpoints,['paged','filtered']);if(caseId===10)assert.deepEqual(detailCheckpoints,['cancelled','refreshed','escaped']);
   if(caseId===7){const observationStart=Date.now(),jobs=Object.values(snapshotServer().web.jobs);assert.equal(jobs.length,1);assert.equal(jobs[0].status,'cancelled');const dueAt=jobs[0].dueAt;assert.ok(Number.isFinite(dueAt)&&dueAt<=observationStart+5000);while(Date.now()<=dueAt){signal.throwIfAborted();reader.snapshot();await wait(Math.min(50,Math.max(1,dueAt+1-Date.now())));}log({originalTimerObservation:{at:observationStart,end:Date.now(),dueAt}});}
   const receiver=snapshotServer();if(caseId===6){const invalid=receiver.rows.filter(row=>row.kind==='form-invalid'),valid=receiver.rows.filter(row=>row.kind==='form-committed');assert.equal(invalid.length,1);assert.equal(valid.length,1);assert.equal(invalid[0].proof.bodySha256,sha256(JSON.stringify({name:'',color:'Blue',agree:false})),'the real blank default form was not submitted');}
   log({powerBeforeFinalRead:await awake.check(signal)});const {at,capturedAt,page}=await independentPage();
   const complete={id:caseId,phase:'complete',at,capturedAt,native:{},nativeEvents:[],web:receiver.web,webEvents:receiver.rows,webTarget:bootstrap.targetId,page,serverVerifiedSha256:receiver.sha256,requestProofs:adapter.publicRecords(),...(caseId===10?{browserObserver:browserObserver.snapshot(),documentRequests:documentRequests.snapshot()}:{}),...(caseId===8?{deletionConfirmation}: {})};writeFileSync(join(root,'evidence/case-'+caseTag+'-complete.json'),JSON.stringify(complete,null,2),{flag:'wx',mode:0o600});fixedNow();dataVerdict=(await verifyWebDataWithTarget(root,caseId,bootstrap.targetId,false)).verdict;assert.equal(dataVerdict.passed,true);break;
  }
  const call=++calls,start=performance.now();log({call,case:caseId,request});let record={call,case:caseId,tool:request.tool},execution;
  try{
   assert.ok(calls<=spec.maxToolCalls,'original case call limit exceeded');const args={...request.args};assertFormalWebRequest(request.tool,args,{tab:bootstrap.tab,url:service.url,shot:browser.latest(bootstrap.tab),caseId});fixedNow();record.powerBefore=await awake.check(signal);const before=await owner();record.targetBefore=before;
   const shot=browser.latest(bootstrap.tab),navigates=caseId===10&&formalWebNavigates(request.tool,args,shot);if(caseId===10&&request.tool==='web_act')record.observedControls=(Array.isArray(args.steps)?args.steps:[args]).map(step=>({action:step.action,id:step.id,name:typeof step.id==='string'?shot.elements.get(step.id)?.name:undefined}));
   if(caseId===8&&request.tool==='web_act')deletionPermit.beginExecution(caseName+'-call-'+call,args,shot);if(navigates)await documentRequests.beginNavigation(caseName+'-call-'+call);else await adapter.beginExecution(caseName+'-call-'+call);const tool=tools.find(row=>row.name===request.tool);assert.ok(tool);execution={at:Date.now(),startMonotonicMs:performance.now()};
   pending=tool.execute(args,{...context,toolCallId:'formal-'+caseName+'-'+call});let receipt;try{receipt=await pending;}finally{pending=undefined;execution.end=Date.now();execution.endMonotonicMs=performance.now();}
   const {images,...publicReceipt}=receipt;record={...record,execution,result:publicReceipt,elapsedMs:performance.now()-start};log({...record,result:undefined,actualToolOutput:publicReceipt,rawToolResult:true});
   if(navigates)await documentRequests.endNavigation(caseName+'-call-'+call);else await adapter.endExecution(caseName+'-call-'+call);if(caseId===8&&request.tool==='web_act')deletionPermit.endExecution(caseName+'-call-'+call);record.targetAfter=await owner();record.powerAfter=await awake.check(signal);const receiver=snapshotServer();service.assertHealthy();assert.equal(publicReceipt.ok,true,'first tool attempt failed; no retry admitted');assert.equal(publicReceipt.details.pid,chromeChild.pid);
   writeFileSync(join(root,'evidence','call-'+call+'-server.json'),JSON.stringify(receiver,null,2),{flag:'wx',mode:0o600});record.elapsedMs=performance.now()-start;log({...record,postcheck:true});toolRecords.push(record);emit({call,case:caseId,elapsedMs:record.elapsedMs,result:publicReceipt,signedReceiver:{events:receiver.rows.length,forms:receiver.forms.length,sha256:receiver.sha256}});
  }catch(error){record={...record,error:String(error),execution,elapsedMs:performance.now()-start};log(record);toolRecords.push(record);emit({call,case:caseId,error:record.error,result:record.result});throw error;}
 }
 if(!dataVerdict)throw new Error(caseName+' ended before independent completion verification');
}catch(error){problem=String(error?.stack??error);log({formalError:problem});emit({error:problem,formal:true,partial:true,case:caseId});}
finally{await finish();}
