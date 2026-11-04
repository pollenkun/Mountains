import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ownPowerAssertions,isACPower,RunAwake} from './acceptance/run-awake.ts';
const row=(pid:number,type:string,id='0x000123456789abcd',name='caffeinate')=>`   pid ${pid}(${name}): [${id}] 00:00:02 ${type} named: "caffeinate command-line tool"\n`;
test('power preparation accepts only two distinct active assertions owned by the exact child',()=>{
	const other=row(123,'PreventUserIdleDisplaySleep')+row(12,'PreventSystemSleep')+row(12,'PreventUserIdleSystemSleep','0x000123456789abce');
	assert.deepEqual(ownPowerAssertions(other,12),[{id:'0x000123456789abcd',type:'PreventSystemSleep'},{id:'0x000123456789abce',type:'PreventUserIdleSystemSleep'}]);
	assert.deepEqual(ownPowerAssertions(other,1),[]);
	assert.equal(ownPowerAssertions(row(12,'NoIdleSleepAssertion'),12)[0]?.type,'PreventUserIdleSystemSleep');
});
test('power preparation rejects same-PID replacement, duplicates and display or user activity requests',()=>{
	for(const text of [row(12,'PreventSystemSleep')+row(12,'PreventSystemSleep','0x12345678'),row(12,'PreventSystemSleep')+row(12,'PreventUserIdleSystemSleep'),row(12,'PreventSystemSleep',undefined,'other'),row(12,'UserIsActive'),row(12,'PreventUserIdleDisplaySleep'),'pid 12(caffeinate): malformed'])assert.throws(()=>ownPowerAssertions(text,12));
});
test('unknown power source never substitutes for actually observed AC power',()=>{
	assert.equal(isACPower("Now drawing from 'AC Power'\n -InternalBattery-0 80%; AC attached"),true);assert.equal(isACPower("Now drawing from 'Battery Power'\n"),false);
	for(const value of ['',"Now drawing from 'UPS Power'",'AC Power','private text'])assert.throws(()=>isACPower(value));
});
test('the case-local holder never permits arbitrary PID or display/user-active command options',()=>{
	const owner={schema:'macos-kinfo-starttime-v1' as const,pid:process.pid,bootId:'11111111-1111-4111-8111-111111111111',startSeconds:'1790000000',startMicroseconds:123};
	const own=new RunAwake({path:'/not-executed',sha256:'0'.repeat(64)},owner);assert.deepEqual(own.args,['-i','-s','-t','120','-w',String(process.pid)]);assert.ok(Object.isFrozen(own.args));
	assert.throws(()=>new RunAwake({path:'/not-executed',sha256:'0'.repeat(64)},{...owner,pid:process.pid+1}));
});

test('case-local power timeout may cover the original case and bounded cleanup but is never unbounded',()=>{
 const owner={schema:'macos-kinfo-starttime-v1' as const,pid:process.pid,bootId:'11111111-1111-4111-8111-111111111111',startSeconds:'1790000000',startMicroseconds:123},probe={path:'/not-executed',sha256:'0'.repeat(64)};
 assert.deepEqual(new RunAwake(probe,owner,()=>{},180).args,['-i','-s','-t','180','-w',String(process.pid)]);
 for(const seconds of [0,-1,1.5,301,Infinity,NaN])assert.throws(()=>new RunAwake(probe,owner,()=>{},seconds));
});
