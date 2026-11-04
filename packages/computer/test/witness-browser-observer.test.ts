import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {RequestScope} from './acceptance/request-witness.ts';
import {witnessBrowserObserver} from './acceptance/witness-browser-observer.ts';
import {attachRequestWitness} from './acceptance/request-witness-adapter.ts';

import {ObservedBrowser,pageURL} from './fixtures/observed-browser.ts';
type Row=Record<string,unknown>;

const observe=(browser:ObservedBrowser,timeoutMs=1000)=>witnessBrowserObserver(browser,{targetId:'main',allowedURLs:['about:blank',pageURL],verifyOwner:async()=>{},timeoutMs});
const scope=(browser:ObservedBrowser):RequestScope=>({origin:new URL(pageURL).origin,pageURL,targetId:'main',sessionId:'independent-request-session',frameId:String(browser.frames.get('main')!.id),loaderId:String(browser.frames.get('main')!.loaderId)});

test('observer starts before navigation and prepares using real ordered samples; cleanup closes only its own blank target',async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();
	const result=await observer.prepare(scope(browser)),observation=result.observation as Row,calibration=observation.calibration as Row;
	assert.equal((observation.document as Row).generation,1);assert.equal((observation.document as Row).loaderId,'detail-loader');
	assert.ok(Number(calibration.lower)<=Number(calibration.main)&&Number(calibration.main)<=Number(calibration.upper));
	assert.equal(result.browserNotBefore,calibration.upper);observer.verifyComplete();
	const first=observer.close(),second=observer.close();assert.equal(first,second);assert.equal((await first).clockTargetClosed,true);
	assert.deepEqual([...browser.frames.keys()],['main']);assert.equal(browser.sessions.size,0);
	assert.equal(browser.commands.filter(row=>row.method==='Target.createTarget').length,1);
	await assert.rejects(observer.prepare(scope(browser)),/closed/);
});
test('confirm preparation takes a fresh private clock sample and never requests the blocked main renderer',async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();
	const before=await observer.prepare(scope(browser));browser.openDialog();const start=browser.commands.length;
	const during=await observer.prepare(scope(browser));assert.ok(during.browserNotBefore>before.browserNotBefore);
	assert.equal((during.observation.dialog as Row).type,'confirm');
	assert.ok(!browser.commands.slice(start).some(row=>['Page.getFrameTree','Performance.getMetrics'].includes(row.method)&&browser.sessions.get(row.session??'')==='main'));
	assert.throws(()=>observer.verifyComplete(),/dialog/);browser.closeDialog();observer.verifyComplete();await observer.close();
});
test('private request adapter uses the same observer through a live confirm without a cached input permission',async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();
	const adapter=await attachRequestWitness(browser,{targetId:'main',pageURL,verifyOwner:async()=>{},preparation:observer});
	try{
		const first=await adapter.beginExecution('open-confirm');await adapter.endExecution('open-confirm');browser.openDialog();
		const second=await adapter.beginExecution('answer-confirm');assert.ok(second.browserNotBefore>first.browserNotBefore);browser.closeDialog();await adapter.endExecution('answer-confirm');
		assert.equal(adapter.preparations().length,2);adapter.verifyComplete();observer.verifyComplete();
	}finally{await adapter.close();await observer.close();}
});
test('a dialog without live calibration for its document cannot authorize input',async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();browser.openDialog();
	await assert.rejects(observer.prepare(scope(browser)),/no live cross-renderer clock calibration/);assert.throws(()=>observer.verifyComplete());await observer.close();
});
test('returned calibration and recorded events cannot mutate the observer internal proof',async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();
	const first=await observer.prepare(scope(browser)),original=structuredClone(first.observation.calibration);
	(first.observation.calibration as Row).upper=999999;observer.snapshot().events[0]!.kind='mutated';browser.openDialog();
	const second=await observer.prepare(scope(browser));assert.deepEqual(second.observation.calibration,original);assert.notEqual(observer.snapshot().events[0]!.kind,'mutated');
	browser.closeDialog();observer.verifyComplete();await observer.close();
});
test('a close notification without its actual boolean result cannot erase a live dialog',async()=>{
	for(const result of [undefined,'accepted',null]){
		const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();browser.openDialog();browser.emitMain('Page.javascriptDialogClosed',{result});
		assert.throws(()=>observer.verifyComplete(),/missing actual dialog result/);assert.equal(observer.snapshot().dialog?.type,'confirm');await observer.close();
	}
});
test('a clock target created after the startup deadline is still remembered and closed by cleanup',async()=>{
	const browser=new ObservedBrowser();browser.createDelay=75;
	await assert.rejects(observe(browser,50),/independent observation deadline/);
	assert.deepEqual([...browser.frames.keys()],['main']);assert.equal(browser.sessions.size,0);
	assert.equal(browser.commands.filter(row=>row.method==='Target.closeTarget').length,1);
});
test('a new document must establish its own calibration, even when history reuses a loader',async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();await observer.prepare(scope(browser));
	browser.navigate(pageURL,'detail-loader');browser.openDialog();await assert.rejects(observer.prepare(scope(browser)),/no live cross-renderer/);await observer.close();
});
for(const mismatch of ['frameId','loaderId','pageURL','targetId'] as const)test('preparation rejects stale '+mismatch,async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();const stale={...scope(browser),[mismatch]:'stale'};
	await assert.rejects(observer.prepare(stale));assert.throws(()=>observer.verifyComplete());await observer.close();
});
test('unexpected navigation, exception and session loss remain failed instead of silently recreating observation',async()=>{
	for(const kind of ['navigation','exception','session','connection'] as const){
		const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();
		if(kind==='navigation')browser.navigate('http://127.0.0.1:54321/foreign');
		if(kind==='exception')browser.emitMain('Runtime.exceptionThrown',{exceptionDetails:{text:'Actual fixture error'}});
		if(kind==='session')browser.emit('Target.detachedFromTarget',{sessionId:observer.snapshot().sessionId});
		if(kind==='connection')browser.emit('Mountains.connectionClosed');
		assert.throws(()=>observer.verifyComplete());await assert.rejects(observer.prepare(scope(browser)));
		assert.ok(observer.snapshot().events.some(row=>row.kind==='observer-failed'));await observer.close();
		assert.equal(browser.commands.filter(row=>row.method==='Target.createTarget').length,1);
	}
});
test('identical initial blank-frame notifications are allowed; a changed blank document is rejected',async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser),clock=observer.snapshot().clock;
	const frame=structuredClone(browser.frames.get(clock.targetId!)!);browser.emit('Page.frameNavigated',{frame},clock.sessionId);observer.verifyComplete();
	browser.emit('Page.frameNavigated',{frame:{...frame,loaderId:'other-loader'}},clock.sessionId);assert.throws(()=>observer.verifyComplete());await observer.close();
});
test('independent timeout rejects a genuinely paused clock request, and cleanup drains that actual request',async()=>{
	const browser=new ObservedBrowser(),observer=await observe(browser,50);browser.navigate();browser.holdClock=true;
	const started=performance.now();await assert.rejects(observer.prepare(scope(browser)),/independent observation deadline/);assert.ok(performance.now()-started<1000);
	const result=await observer.close();assert.equal(result.clockTargetClosed,true);assert.equal(browser.sessions.size,0);
	await assert.rejects(observer.prepare(scope(browser)),/closed/);assert.equal(observer.snapshot().events.filter(row=>row.kind==='input-prepared').length,0);
});
test('invalid or uncalibrated browser clocks cannot be substituted by a controller wall clock',async()=>{
	for(const invalid of ['not-a-clock',NaN,-1,'outside-calibration']){
		const browser=new ObservedBrowser(),observer=await observe(browser);browser.navigate();
		if(invalid==='outside-calibration')browser.metricsOverride=target=>target==='main'?10000:++browser.clock;else browser.invalidClock=invalid;
		await assert.rejects(observer.prepare(scope(browser)));assert.equal(observer.snapshot().events.filter(row=>row.kind==='input-prepared').length,0);await observer.close();
	}
});
test('invalid bounds and a business page already open are rejected before any observer target is created',async()=>{
	for(const timeout of [0,-1,3001,NaN,1.5]){const browser=new ObservedBrowser();await assert.rejects(observe(browser,timeout));assert.deepEqual(browser.commands,[]);}
	const browser=new ObservedBrowser();browser.navigate();await assert.rejects(observe(browser),/precede/);assert.ok(!browser.commands.some(row=>row.method==='Target.createTarget'));
});
