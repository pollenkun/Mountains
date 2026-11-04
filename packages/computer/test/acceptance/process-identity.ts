import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';

export interface WriterProcessIdentity{
 schema:'macos-kinfo-starttime-v1';pid:number;bootId:string;startSeconds:string;startMicroseconds:number;
}
export type ProcessObservation={status:'alive';identity:WriterProcessIdentity}|{status:'absent'}|{status:'unknown';reason:string};
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());return value as Record<string,unknown>;
}
export function writerProcessIdentity(value:unknown):WriterProcessIdentity{
 try{
  const item=object(value,['schema','pid','bootId','startSeconds','startMicroseconds']);assert.equal(item.schema,'macos-kinfo-starttime-v1');
  assert.ok(typeof item.pid==='number'&&Number.isSafeInteger(item.pid)&&item.pid>0&&item.pid<=2_147_483_647);
  assert.ok(typeof item.bootId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.bootId));
  assert.ok(typeof item.startSeconds==='string'&&/^[1-9]\d{0,18}$/.test(item.startSeconds));
  assert.ok(typeof item.startMicroseconds==='number'&&Number.isInteger(item.startMicroseconds)&&item.startMicroseconds>=0&&item.startMicroseconds<1_000_000);
  return{schema:'macos-kinfo-starttime-v1',pid:item.pid,bootId:item.bootId,startSeconds:item.startSeconds,startMicroseconds:item.startMicroseconds};
 }catch{throw new Error('Invalid OS writer identity; process state remains unknown');}
}
export function parseProcessObservation(bytes:string):ProcessObservation{
 try{
  const value=JSON.parse(bytes) as Record<string,unknown>;
  if(value.status==='alive'){object(value,['status','identity']);return{status:'alive',identity:writerProcessIdentity(value.identity)};}
  if(value.status==='absent'){object(value,['status']);return{status:'absent'};}
  object(value,['status','reason']);assert.equal(value.status,'unknown');
  assert.ok(typeof value.reason==='string'&&['invalid-pid','boot-session-unavailable','process-query-failed','process-query-incomplete','start-time-unavailable'].includes(value.reason));
  return{status:'unknown',reason:value.reason};
 }catch{throw new Error('Invalid OS process observation; process state remains unknown');}
}
/** This never kills a PID. A reused PID belongs to another process, and only
 * proves that the old identity has exited. Permissions/unsupported APIs do not. */
export function writerState(expected:WriterProcessIdentity,current:ProcessObservation):'alive'|'exited'|'unknown'{
 const prior=writerProcessIdentity(expected);
 if(current.status==='unknown')return'unknown';if(current.status==='absent')return'exited';
 if(current.status!=='alive')return'unknown';
 const value=writerProcessIdentity(current.identity);
 if(value.pid!==prior.pid)return'unknown';
 return value.bootId===prior.bootId&&value.startSeconds===prior.startSeconds&&value.startMicroseconds===prior.startMicroseconds?'alive':'exited';
}
export async function readWriterProcess(binary:{path:string;sha256:string},pid:number,signal?:AbortSignal):Promise<ProcessObservation>{
 try{
  assert.equal(process.platform,'darwin');assert.ok(isAbsolute(binary.path)&&realpathSync(binary.path)===binary.path&&lstatSync(binary.path).isFile());
  assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'),binary.sha256);
  assert.ok(Number.isSafeInteger(pid)&&pid>0&&pid<=2_147_483_647);signal?.throwIfAborted();
  const output=await new Promise<string>((resolve,reject)=>{
   let result:{failed:boolean;stdout:string}|undefined;
   const child=execFile(binary.path,[String(pid)],{encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:4096,...(signal?{signal}:{})},(error,stdout)=>{result={failed:!!error,stdout};});
   child.once('close',()=>{if(!result||result.failed)reject(new Error('process observation failed'));else resolve(result.stdout);});child.stdin?.end();
  });
  signal?.throwIfAborted();const value=parseProcessObservation(output);
  if(value.status==='alive')assert.equal(value.identity.pid,pid);return value;
 }catch{return{status:'unknown',reason:'process-query-failed'};}
}
export interface ExecutableProcessObservation{pid:number;executable:string;observation:{status:'alive';identity:WriterProcessIdentity}}
/** OS-only executable path, bracketed by the same microsecond process birth.
 * Unknown is not an executable match and cannot authorize signal/connection. */
export async function readExecutableProcess(binary:{path:string;sha256:string},pid:number,signal?:AbortSignal):Promise<ExecutableProcessObservation|null>{
 try{
  assert.equal(process.platform,'darwin');assert.ok(isAbsolute(binary.path)&&realpathSync(binary.path)===binary.path&&lstatSync(binary.path).isFile());
  assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'),binary.sha256);assert.ok(Number.isSafeInteger(pid)&&pid>0&&pid<=2_147_483_647);signal?.throwIfAborted();
  const bytes=await new Promise<string>((yes,no)=>{
   let output:{failed:boolean;stdout:string}|undefined;
   const child=execFile(binary.path,['--executable',String(pid)],{encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:8192,...(signal?{signal}:{})},(error,stdout)=>{output={failed:!!error,stdout};});
   child.once('close',()=>{if(!output||output.failed)no(new Error('executable observation failed'));else yes(output.stdout);});child.stdin?.end();
  });
  signal?.throwIfAborted();const row=object(JSON.parse(bytes),['pid','executable','observation']);assert.equal(row.pid,pid);
  assert.ok(typeof row.executable==='string'&&row.executable.length<=4096&&isAbsolute(row.executable)&&!row.executable.includes('\0'));
  const observation=parseProcessObservation(JSON.stringify(row.observation));assert.equal(observation.status,'alive');assert.ok(observation.status==='alive');assert.equal(observation.identity.pid,pid);
  return{pid,executable:row.executable,observation};
 }catch{return null;}
}
/** One short-lived, OS-only probe for the current monitor candidates. All
 * results are untrusted until both the response PID and OS identity match. */
export async function readProcessBatch(binary:{path:string;sha256:string},inputPids:readonly number[],signal?:AbortSignal):Promise<Map<number,ProcessObservation>>{
 const pids=[...inputPids];
 const unknown=():Map<number,ProcessObservation>=>new Map(pids.map(pid=>[pid,{status:'unknown',reason:'process-query-failed'}]));
 try{
  assert.equal(process.platform,'darwin');assert.ok(pids.length>0&&pids.length<=4096&&new Set(pids).size===pids.length);
  for(const pid of pids)assert.ok(Number.isSafeInteger(pid)&&pid>0&&pid<=2_147_483_647);
  assert.ok(isAbsolute(binary.path)&&realpathSync(binary.path)===binary.path&&lstatSync(binary.path).isFile());
  assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'),binary.sha256);signal?.throwIfAborted();
  const output=await new Promise<string>((resolve,reject)=>{
   let result:{failed:boolean;stdout:string}|undefined;
   const child=execFile(binary.path,['--batch',...pids.map(String)],{encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:2*1024*1024,...(signal?{signal}:{})},(error,stdout)=>{result={failed:!!error,stdout};});
   child.once('close',()=>{if(!result||result.failed)reject(new Error('process observation failed'));else resolve(result.stdout);});child.stdin?.end();
  });
  signal?.throwIfAborted();const value=object(JSON.parse(output),['observations']);assert.ok(Array.isArray(value.observations)&&value.observations.length===pids.length);
  const remaining=new Set(pids),observed=new Map<number,ProcessObservation>();
  for(const row of value.observations){const item=object(row,['pid','observation']);assert.ok(typeof item.pid==='number'&&remaining.delete(item.pid));const observation=parseProcessObservation(JSON.stringify(item.observation));if(observation.status==='alive')assert.equal(observation.identity.pid,item.pid);observed.set(item.pid,observation);}
  assert.equal(remaining.size,0);return observed;
 }catch{return unknown();}
}
