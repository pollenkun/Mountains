import assert from 'node:assert/strict';
import {test} from 'node:test';
import {disposeBuiltinSkills,FileStateTracker,Workspace,type BuiltinSkill} from '@mountains/tools';
import {computerUseSkill} from '../src/skill.ts';
import type {Desktop} from '../src/backend.ts';
import {MacPointer} from '../src/pointer-mac.ts';
import {InputCoordinator} from '../src/coordinator.ts';

test('hosts close all owned skills even if one cleanup fails, and close duplicate skills once',async()=>{
 const seen:string[]=[];
 const skill=(name:string,fail=false):BuiltinSkill=>({name,body:'',description:'',async dispose(){seen.push(name);if(fail)throw new Error('cleanup failed');}});
 const a=skill('a'),b=skill('b',true),c=skill('c');
 await assert.rejects(disposeBuiltinSkills([a,b,c,a]),AggregateError);
 assert.deepEqual(seen,['c','b','a']);
});

test('disposing an unused computer skill does not start a desktop or browser',async()=>{
 let opened=0;
 const skill=computerUseSkill({desktop:async()=>{opened++;throw new Error('must not start');}});
 await skill.dispose!();await skill.dispose!();assert.equal(opened,0);
});

test('a disposal delayed from an ended input scope cannot poison the live computer skill',async()=>{
 let reads=0,resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;}),coordinator=new InputCoordinator();
 const desktop={ownPids:()=>[],apps:async()=>{reads++;return[];}} as unknown as Desktop,skill=computerUseSkill({desktop:async()=>desktop});let late:Promise<unknown>|undefined;
 try{
  await coordinator.run(new AbortController().signal,async()=>{late=gate.then(()=>skill.dispose!()).catch(error=>error);});
  await coordinator.run(new AbortController().signal,async()=>{resume();assert.match(String(await late),/lease has ended/);});
  const out=await skill.tools!.find(tool=>tool.name==='screen_read')!.execute({},{workspace:new Workspace(process.cwd()),files:new FileStateTracker(),signal:new AbortController().signal,toolCallId:'still-live',approve:async()=>'allow' as const});
  assert.equal(reads,1);assert.doesNotMatch(out.modelContent,/session was closed/);
 }finally{resume();await late;await skill.dispose!();}
});

test('a closed pointer cannot restart a helper even through a read-only command',async()=>{
 const pointer=new MacPointer();await pointer.close();assert.equal(pointer.pid,null);await assert.rejects(pointer.send({op:'ping'}),/closed/);assert.equal(pointer.pid,null);
});

test('a provider that never returns cannot prevent disposal from reporting failure',async()=>{
 let started!:()=>void;const entered=new Promise<void>(accept=>{started=accept;});
 const desktop={ownPids:()=>[],async apps(){started();return new Promise(()=>{});}} as unknown as Desktop;
 const skill=computerUseSkill({desktop:async()=>desktop,disposeTimeoutMs:10});
 const ctx={workspace:new Workspace(process.cwd()),files:new FileStateTracker(),signal:new AbortController().signal,toolCallId:'hang',approve:async()=>'allow' as const};
 void skill.tools!.find(tool=>tool.name==='screen_read')!.execute({},ctx);
 await entered;
 await assert.rejects(skill.dispose!(),error=>error instanceof AggregateError&&error.errors.some((entry:Error)=>entry.message.includes('active calls timed out')));
 const after=await skill.tools!.find(tool=>tool.name==='screen_read')!.execute({},ctx);assert.equal(after.ok,false);assert.equal(after.details?.dispatched,false);
});
