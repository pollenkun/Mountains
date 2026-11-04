import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {writerProcessIdentity,parseProcessObservation,writerState,readWriterProcess,readProcessBatch,readExecutableProcess,type WriterProcessIdentity} from './acceptance/process-identity.ts';
import {inspectRecoveryWriters} from './acceptance/recovery-writers.ts';
import type {ContainerAttempt} from './acceptance/container-outcome.ts';
import type {CreationRecovery} from './acceptance/account-journal.ts';

const birth:WriterProcessIdentity={schema:'macos-kinfo-starttime-v1',pid:12345,bootId:'01234567-89ab-cdef-0123-456789abcdef',startSeconds:'1790000000',startMicroseconds:123456};
const attempt:ContainerAttempt={nonce:'11111111-1111-1111-1111-111111111111',writerPath:'/fresh-test/writer',writerSha256:'a'.repeat(64),requestSha256:'b'.repeat(64),outcomeDevice:'1',outcomeInode:'2',writer:birth};
const recovery=():CreationRecovery=>({needsIndependentReconciliation:true,attempts:[structuredClone(attempt)],candidates:[]});

test('OS writer identities preserve microseconds and never accept old seconds-only receipts',()=>{
 const parsed=writerProcessIdentity(birth);assert.deepEqual(parsed,birth);assert.notEqual(parsed,birth);
 assert.deepEqual(parseProcessObservation(JSON.stringify({status:'alive',identity:birth})),{status:'alive',identity:birth});
 assert.deepEqual(parseProcessObservation('{"status":"absent"}'),{status:'absent'});
 assert.deepEqual(parseProcessObservation('{"status":"unknown","reason":"process-query-failed"}'),{status:'unknown',reason:'process-query-failed'});
 for(const value of [{...birth,startMicroseconds:undefined},{...birth,startMicroseconds:-1},{...birth,startMicroseconds:1_000_000},{...birth,startSeconds:1790000000},{...birth,pid:0},{...birth,pid:2_147_483_648},{...birth,bootId:'old-session'},{...birth,private:'PRIVATE-PROBE-CONTENT'}]){
  assert.throws(()=>writerProcessIdentity(value),error=>String(error)==='Error: Invalid OS writer identity; process state remains unknown');
 }
 for(const value of ['null','{','{"status":"absent","private":"PRIVATE-PROBE-CONTENT"}','{"status":"alive"}','{"status":"unknown","reason":"PRIVATE-PROBE-CONTENT"}']){
  assert.throws(()=>parseProcessObservation(value),error=>String(error)==='Error: Invalid OS process observation; process state remains unknown');
 }
});
test('PID reuse, a new boot and a microsecond difference prove only the old writer is gone',()=>{
 assert.equal(writerState(birth,{status:'alive',identity:birth}),'alive');
 for(const identity of [{...birth,startMicroseconds:birth.startMicroseconds+1},{...birth,startSeconds:'1790000001'},{...birth,bootId:'11234567-89ab-cdef-0123-456789abcdef'}])assert.equal(writerState(birth,{status:'alive',identity}),'exited');
 assert.equal(writerState(birth,{status:'absent'}),'exited');
 assert.equal(writerState(birth,{status:'unknown',reason:'process-query-failed'}),'unknown');
 assert.equal(writerState(birth,{status:'alive',identity:{...birth,pid:12346}}),'unknown');
});
test('recovery waits for living writers and keeps missing or failed identity reads unknown',async()=>{
 for(const status of ['alive','exited','unknown'] as const){
  const seen:number[]=[],result=await inspectRecoveryWriters(recovery(),{read:async pid=>{seen.push(pid);return status==='alive'?{status:'alive',identity:birth}:status==='exited'?{status:'absent'}:{status:'unknown',reason:'process-query-failed'};}});
  assert.deepEqual(seen,[birth.pid]);assert.equal(result.allWritersExited,status==='exited');assert.deepEqual(result.writers,[{nonce:attempt.nonce,state:status}]);
 }
 const legacy=recovery();delete legacy.attempts[0]!.writer;let calls=0;
 const missing=await inspectRecoveryWriters(legacy,{read:async()=>{calls++;return{status:'absent'};}});assert.equal(calls,0);assert.equal(missing.allWritersExited,false);assert.equal(missing.writers[0]!.state,'unknown');
 assert.equal((await inspectRecoveryWriters(recovery(),{read:async()=>{throw new Error('private failure');}})).allWritersExited,false);
 const controller=new AbortController();controller.abort();assert.equal((await inspectRecoveryWriters(recovery(),{read:async()=>{calls++;return{status:'absent'};}},controller.signal)).allWritersExited,false);assert.equal(calls,0);
});
test('recovery freezes all birth records before querying and never treats unbound candidates as safe',async()=>{
 const f=recovery();f.attempts.push({...structuredClone(attempt),nonce:'22222222-2222-2222-2222-222222222222'});
 let calls=0;const result=await inspectRecoveryWriters(f,{read:async()=>{
  calls++;f.attempts[1]!.writer!.startMicroseconds=654321;return calls===1?{status:'absent'}:{status:'alive',identity:birth};
 }});assert.equal(result.allWritersExited,false);assert.deepEqual(result.writers.map(value=>value.state),['exited','alive']);
 const unbound=recovery();unbound.attempts=[];unbound.candidates=[{requestId:'legacy',record:{id:'new',sourceId:'local',parentId:null,kind:'container',fingerprint:'a'.repeat(64)},outcome:'unknown'}];
 assert.equal((await inspectRecoveryWriters(unbound,{read:async()=>({status:'absent'})})).allWritersExited,false);
 const linked=recovery();linked.candidates=[{...unbound.candidates[0]!,attempt:structuredClone(attempt)}];
 assert.equal((await inspectRecoveryWriters(linked,{read:async()=>({status:'absent'})})).allWritersExited,true);
 linked.candidates[0]!.attempt!.writer!.startMicroseconds++;assert.equal((await inspectRecoveryWriters(linked,{read:async()=>({status:'absent'})})).allWritersExited,false);
});
test('the actual OS-only helper reads a live own process consistently and recognizes its exit',{skip:process.platform!=='darwin',timeout:30_000},async context=>{
 // Resolve an installed compiler, avoiding the macOS installer stub. These
 // probes import Darwin/Foundation only, never EventKit/AppKit/AX/input APIs.
 const selected=spawnSync('/usr/bin/xcode-select',['--print-path'],{encoding:'utf8',timeout:3000}),developer=selected.status===0?selected.stdout.trim():'';
 const compiler=developer?[join(developer,'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'),join(developer,'usr/bin/swiftc')].find(existsSync):undefined;
 const sdk=developer?[join(developer,'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'),join(developer,'SDKs/MacOSX.sdk')].find(existsSync):undefined;
 if(!compiler||!sdk){context.skip('An already installed Swift compiler/SDK is required for the OS-only probe');return;}
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-process-identity-'))),path=join(root,'ReadProcessIdentity');
 const child=spawn(process.execPath,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});const closed=once(child,'close');
 try{
  await once(child.stdout,'data');assert.ok(child.pid);
  const source=(name:string)=>fileURLToPath(new URL('./acceptance/native/'+name,import.meta.url));
  const build=spawnSync(compiler,['-sdk',sdk,'-swift-version','6','-warnings-as-errors','-parse-as-library',source('ProcessIdentity.swift'),source('ReadProcessIdentity.swift'),'-o',path],{encoding:'utf8',timeout:20_000});assert.equal(build.status,0,build.stderr);
  const binary={path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
  const first=await readWriterProcess(binary,child.pid),second=await readWriterProcess(binary,child.pid);
  assert.equal(first.status,'alive',JSON.stringify(first));assert.deepEqual(second,first);assert.ok(first.status==='alive');assert.equal(first.identity.pid,child.pid);
  const executable=await readExecutableProcess(binary,child.pid);assert.ok(executable);assert.deepEqual(executable.observation,first);assert.equal(realpathSync(executable.executable),realpathSync(process.execPath));
  const batchStarted=performance.now(),batch=await readProcessBatch(binary,[child.pid,process.pid]);context.diagnostic('OS-only two-process batch '+(performance.now()-batchStarted).toFixed(1)+' ms; no UI or accounts');assert.deepEqual(batch.get(child.pid),first);assert.equal(batch.get(process.pid)?.status,'alive');
  child.kill('SIGKILL');await closed;
  assert.equal(writerState(first.identity,await readWriterProcess(binary,child.pid)),'exited');
  assert.equal(await readExecutableProcess(binary,child.pid),null,'a dead process cannot retain an executable authorization');
  assert.equal(batch.get(child.pid)?.status,'alive','the prior OS observation must remain a historical snapshot');assert.equal((await readProcessBatch(binary,[child.pid])).get(child.pid)?.status,'absent');
  assert.deepEqual(await readWriterProcess({...binary,sha256:'0'.repeat(64)},process.pid),{status:'unknown',reason:'process-query-failed'});
  assert.equal(await readExecutableProcess({...binary,sha256:'0'.repeat(64)},process.pid),null);
  const aborted=new AbortController();aborted.abort();assert.equal((await readWriterProcess(binary,process.pid,aborted.signal)).status,'unknown');
  const bad=join(root,'bad-probe');writeFileSync(bad,`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({status:'alive',identity:${JSON.stringify({...birth,pid:process.pid+1})}}));\n`,{mode:0o700});
  assert.equal((await readWriterProcess({path:bad,sha256:createHash('sha256').update(readFileSync(bad)).digest('hex')},process.pid)).status,'unknown');
  assert.equal((await readProcessBatch({path:bad,sha256:createHash('sha256').update(readFileSync(bad)).digest('hex')},[process.pid])).get(process.pid)?.status,'unknown');
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}rmSync(root,{recursive:true,force:true});}
});
