import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseReminderInventory,readReminderInventory} from './acceptance/reminder-reader.ts';

function evidence(){return{version:1,kind:'reminders',authorization:'full',coverage:'all-objects',complete:true,fieldScope:'EventKit-public-reminder-v1',sources:[{id:'local',storage:'local',proof:'EventKit.sourceType'}],records:[{id:'list',sourceId:'local',parentId:null,kind:'container',fingerprint:'a'.repeat(64)},{id:'task',sourceId:'local',parentId:'list',kind:'object',fingerprint:'b'.repeat(64)}]};}
test('read-only reminder evidence preserves exact IDs and its limited public-field scope',()=>{
 assert.deepEqual(parseReminderInventory(JSON.stringify(evidence())),evidence());
});
test('partial, duplicate, unknown-parent and unproven reminder evidence never becomes a complete inventory',()=>{
 for(const mutate of [
  (value:ReturnType<typeof evidence>)=>{value.complete=false;},
  (value:ReturnType<typeof evidence>)=>{value.coverage='bounded-interval';},
  (value:ReturnType<typeof evidence>)=>{value.fieldScope='all-private-database-fields';},
  (value:ReturnType<typeof evidence>)=>{value.records.push({...value.records[0]!});},
  (value:ReturnType<typeof evidence>)=>{value.records[1]!.parentId='unrelated-list';},
  (value:ReturnType<typeof evidence>)=>{value.records[1]!.sourceId='missing-account';},
  (value:ReturnType<typeof evidence>)=>{value.records[1]!.fingerprint='';}
 ]){const value=evidence();mutate(value);assert.throws(()=>parseReminderInventory(JSON.stringify(value)),/Invalid read-only reminder evidence/);}
});
test('malformed or foreign-domain helper output cannot leak plaintext through parser errors',()=>{
 const secret='PRIVATE-PROBE-CONTENT';
 const inputs=['{"private":'+secret,JSON.stringify({...evidence(),kind:secret}),JSON.stringify({...evidence(),notes:secret}),JSON.stringify({...evidence(),authorization:secret})];
 for(const input of inputs){try{parseReminderInventory(input);assert.fail('invalid evidence was accepted');}catch(error){assert.equal(String(error),'Error: Invalid read-only reminder evidence; account tests remain disabled');assert.ok(!('cause' in (error as Error)));}}
});
test('the read-only wrapper passes a fingerprint key on stdin and waits for its exact child to exit',{skip:process.platform!=='darwin'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'mountains-reminder-reader-fake-'));
 try{
  const binary=join(root,'fake-reader');
  await writeFile(binary,'#!/usr/bin/env node\n'+`let input='';for await(const part of process.stdin)input+=part;const request=JSON.parse(input);if(request.version!==1||Buffer.from(request.key,'base64').length!==32||process.argv.length!==2)process.exit(2);process.stdout.write(${JSON.stringify(JSON.stringify(evidence()))});`,{mode:0o700});
  assert.deepEqual(await readReminderInventory(binary,new Uint8Array(32).fill(7)),evidence());
  await writeFile(binary,'#!/usr/bin/env node\n'+`process.stdout.write(${JSON.stringify(JSON.stringify({...evidence(),kind:'PRIVATE-PROBE-CONTENT'}))});`,{mode:0o700});
  await assert.rejects(readReminderInventory(binary,new Uint8Array(32)),{message:'Invalid read-only reminder evidence; account tests remain disabled'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cancelling a stuck read-only helper kills it instead of leaving an inventory reader behind',{skip:process.platform!=='darwin'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'mountains-reminder-reader-cancel-'));
 try{
  const binary=join(root,'fake-reader');
  await writeFile(binary,'#!/usr/bin/env node\nprocess.stdin.resume();setInterval(()=>{},1000);',{mode:0o700});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),100);
  try{await assert.rejects(readReminderInventory(binary,new Uint8Array(32),controller.signal),/inventory failed or timed out/);}finally{clearTimeout(timer);}
 }finally{await rm(root,{recursive:true,force:true});}
});
