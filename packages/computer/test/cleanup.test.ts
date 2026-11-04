import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cleanupAll} from './fixtures/cleanup.ts';
import {onTestTermination} from './fixtures/signals.ts';
import {EventEmitter} from 'node:events';

test('clipboard read and evidence failures cannot skip helper, desktop or fixture cleanup',async()=>{
 const ran:string[]=[];
 const errors=await cleanupAll(['clipboard','helper','desktop','fixture','evidence'].map(name=>({name,async run(){ran.push(name);if(name==='clipboard'||name==='evidence')throw new Error(name+' failed');}})));
 assert.deepEqual(ran,['clipboard','helper','desktop','fixture','evidence']);assert.deepEqual(errors.map(item=>item.name),['clipboard','evidence']);
});

test('a second interrupt still waits for the same cleanup before exit',async()=>{
 const events=new EventEmitter(),exits:number[]=[],controller=new AbortController();let finish!:()=>void,calls=0;
 const done=new Promise<void>(accept=>{finish=accept;});
 const remove=onTestTermination(controller,async()=>{calls++;await done;},{on:events.on.bind(events),off:events.off.bind(events),exit:code=>exits.push(code)});
 events.emit('SIGINT');events.emit('SIGINT');events.emit('SIGTERM');await Promise.resolve();
 assert.equal(controller.signal.aborted,true);assert.equal(calls,1);assert.deepEqual(exits,[]);
 finish();await done;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(exits,[130]);remove();assert.equal(events.listenerCount('SIGINT'),0);
});
test('an unresponsive resource is reported while subsequent owned resources still stop',async()=>{
 let stopped=false;
 const errors=await cleanupAll([{name:'hung resource',timeoutMs:10,run:()=>new Promise(()=>{})},{name:'owned fixture',async run(){stopped=true;}}]);
 assert.equal(stopped,true);assert.equal(errors.length,1);assert.match(errors[0]!.error,/deadline/);
});
