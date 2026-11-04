import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync,existsSync,realpathSync,readdirSync,lstatSync,readlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {RunAwake} from './run-awake.ts';
import {sha256} from './integrity.ts';
import {readExecutableProcess,readWriterProcess,writerState} from './process-identity.ts';
import {FocusTargetCandidates} from './focus-targets.ts';
import {verifyFocusEvidence} from './focus-proof.ts';
import {stopFocusMonitor} from './stop-monitor.ts';

// Technical component only: no UI tools, Chrome, clipboard, accounts or files
// outside the new test root. This is not one of the 20 business acceptances.
const here=dirname(fileURLToPath(import.meta.url)),base=realpathSync(join(homedir(),'Movies','Mountains 测试素材'));
assert.ok(process.argv[2]&&process.argv[3],'pass a new result root and a prior own fixture root');
const root=resolve(process.argv[2]);assert.equal(dirname(root),base);assert.ok(!existsSync(root));mkdirSync(root,{mode:0o700});
const source=realpathSync(process.argv[3]);assert.equal(dirname(source),base);const manifest=JSON.parse(readFileSync(join(source,'manifest.json'),'utf8'));assert.equal(manifest.root,source);
const nativePath=join(source,'build/ReadProcessIdentity'),monitorPath=join(source,'build/FocusMonitor'),probe={path:nativePath,sha256:manifest.fixtureHashes[nativePath]};
for(const path of [nativePath,monitorPath])assert.equal(sha256(readFileSync(path)),manifest.fixtureHashes[path]);
const modules=['verify-run-awake.mjs','run-awake.ts','process-identity.ts','focus-targets.ts','focus-proof.ts','stop-monitor.ts','integrity.ts','native/Monitor.swift','native/FocusSubscriptions.swift','native/ProcessIdentity.swift','native/ReadProcessIdentity.swift','model-focus-observer.ts','../../../../apps/cli/src/tool-observer-protocol.ts'];const sources=Object.fromEntries(modules.map(name=>[join(here,name),sha256(readFileSync(join(here,name)))]));
for(const name of modules.filter(name=>name.startsWith('native/')))assert.equal(sources[join(here,name)],manifest.fixtureHashes[join(here,name)],'reused read-only binary source differs from its pinned build');
writeFileSync(join(root,'plan.json'),JSON.stringify({technicalComponent:true,businessAcceptance:false,paidCalls:0,root,source,fixtureHashes:{[nativePath]:probe.sha256,[monitorPath]:manifest.fixtureHashes[monitorPath]},sources,holdMs:50000,maxSampleGapMs:150,displayWake:false,userActivity:false,persistentSettings:false},null,2),{flag:'wx',mode:0o600});
const journal=[],journalPath=join(root,'controller.jsonl'),focusPath=join(root,'focus.jsonl');
const log=data=>{const row={at:Date.now(),monotonicMs:performance.now(),...data};appendFileSync(journalPath,JSON.stringify(row)+'\n',{mode:0o600});journal.push(row);return row;};
const wait=ms=>new Promise(yes=>setTimeout(yes,ms)),rawFocus=()=>readFileSync(focusPath,'utf8').split('\n').slice(0,-1).filter(Boolean).map(JSON.parse);
const abort=new AbortController();let problem,monitor,monitorClosed,monitorBirth,reader,awake,powerProcess;
const stop=error=>{problem??=String(error);abort.abort(new Error(String(error)));};
const timer=setTimeout(()=>stop('technical power component exceeded its 80000ms deadline'),80000);for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>stop('received '+name));
const started=performance.now(),cleanup=[];
// A failed evidence write makes this component fail, but never skips a real
// resource close. Keep its attempted record in memory for later diagnosis.
const cleanupLog=data=>{try{log(data);}catch{problem??='cleanup journal write failed';journal.push({at:Date.now(),monotonicMs:performance.now(),...data,journalWriteFailed:true});}};
try{
 const owner=await readExecutableProcess(probe,process.pid);assert.ok(owner);assert.equal(realpathSync(owner.executable),realpathSync(process.execPath));log({controller:owner});
 monitor=spawn(monitorPath,[focusPath],{stdio:['pipe','ignore','pipe']});let launchError;monitor.on('error',()=>{launchError='monitor could not start';});monitor.stderr.resume();monitorClosed=new Promise(yes=>monitor.once('close',(code,signal)=>yes({code,signal,...(launchError?{error:launchError}:{})})));
 const observation=await readWriterProcess(probe,monitor.pid);assert.equal(observation.status,'alive');monitorBirth=observation.identity;log({monitorStart:{pid:monitor.pid,process:observation}});
 const deadline=performance.now()+8000;while(!existsSync(focusPath)||!rawFocus().some(row=>row.kind==='ready')){abort.signal.throwIfAborted();assert.ok(performance.now()<deadline,'monitor did not become ready');await wait(20);}
 reader=new FocusTargetCandidates(focusPath,{monitorBirth,maxSampleGapMs:150});log({baseline:reader.snapshot()});log({fixtureStart:true,resource:'case-local power assertion creation, hold and release'});
 awake=new RunAwake(probe,owner.observation.identity,error=>stop(error.message));const ready=await awake.start(abort.signal);powerProcess=ready.process;log({powerReady:ready});reader.snapshot();
 const holdStart=performance.now();while(performance.now()-holdStart<50000){await wait(Math.min(2000,50000-(performance.now()-holdStart)));abort.signal.throwIfAborted();reader.snapshot();log({powerCheck:await awake.check(abort.signal)});reader.snapshot();}
 log({holdMs:performance.now()-holdStart});
}catch(error){stop(error?.stack??error);cleanupLog({componentError:problem});}
finally{
 const clean=async(name,action)=>{try{const evidence=await action();cleanup.push({name,passed:true,evidence});cleanupLog({cleanup:cleanup.at(-1)});}catch(error){problem??=String(error);cleanup.push({name,passed:false,error:String(error)});cleanupLog({cleanup:cleanup.at(-1)});}};
 await clean('release original power process and verify original assertions gone',async()=>awake?await awake.close():{notStarted:true});
 cleanupLog({fixtureExit:true,resource:'case-local power assertion creation, hold and release'});
 await clean('flush and stop original independent focus monitor',async()=>{if(!monitor)return{notStarted:true};const current=await readWriterProcess(probe,monitor.pid);cleanupLog({monitorStopRequested:true,monitorProcess:current});await stopFocusMonitor(monitor);const ended=await monitorClosed;cleanupLog({monitorExit:{requested:true,...ended}});assert.deepEqual(ended,{code:0,signal:null});assert.ok(monitorBirth);assert.equal(writerState(monitorBirth,current),'alive');const after=await readWriterProcess(probe,monitor.pid);assert.equal(writerState(monitorBirth,after),'exited');return{ended,after};});
 await clean('strict complete focus history including assertion creation and release',async()=>{try{assert.ok(reader);const cursor=reader.verifyPrefix();verifyFocusEvidence({focus:rawFocus(),journal,trace:[],maxSampleGapMs:150});return cursor;}finally{reader?.close();}});
 await clean('unchanged component sources and pinned read-only fixture binaries',async()=>{for(const [path,hash]of Object.entries({...sources,[nativePath]:probe.sha256,[monitorPath]:manifest.fixtureHashes[monitorPath]}))assert.equal(sha256(readFileSync(path)),hash);return{unchanged:true};});
 clearTimeout(timer);const result={technicalComponent:true,businessAcceptance:false,passed:!problem,paidCalls:0,root,powerProcess:powerProcess??null,wallMs:performance.now()-started,error:problem??null,cleanup};writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
 const hashes={};const collect=path=>{const stat=lstatSync(path);if(stat.isDirectory())for(const name of readdirSync(path))collect(join(path,name));else hashes[path]=stat.isSymbolicLink()?'symlink:'+readlinkSync(path):sha256(readFileSync(path));};collect(root);writeFileSync(join(root,'sha256-index.json'),JSON.stringify(hashes,null,2),{flag:'wx',mode:0o600});process.stdout.write(JSON.stringify(result)+'\n');if(problem)process.exitCode=1;
}
