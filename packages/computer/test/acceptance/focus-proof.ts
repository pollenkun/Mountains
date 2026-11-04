import assert from 'node:assert/strict';
import {duration,focusNotificationVerdict,timedInterval} from './integrity.ts';
import {writerProcessIdentity,type WriterProcessIdentity} from './process-identity.ts';
import {reportedFocusTargets} from './model-focus-observer.ts';

type Row=Record<string,unknown>;
export interface FocusProof{
	focus:readonly Row[];
	journal:readonly Row[];
	trace:readonly {tool:string;at:number;end:number;engineDispatch?:'not-started'|'returned'|'threw';execution?:Row;targetBefore?:Row;targetAfter?:Row;args:Row;result:{details?:Row}}[];
	maxSampleGapMs:number;
}
const pid=(value:unknown,label:string):number=>{
	assert.ok(typeof value==='number'&&Number.isSafeInteger(value)&&value>0,label+' must identify a known process');return value;
};
const time=(row:Row):number=>duration(row.at,'focus evidence time');
const focusNotice='AXFocusedUIElementChanged';
const processBirth=(value:unknown,expectedPid:number,label:string):WriterProcessIdentity=>{
	assert.ok(value&&typeof value==='object'&&!Array.isArray(value),label+' has no OS process observation');
	const observation=value as Row;assert.equal(observation.status,'alive',label+' has no live OS process observation');
	const birth=writerProcessIdentity(observation.identity);assert.equal(birth.pid,expectedPid,label+' has a different PID');return birth;
};
const failedSubscription=(row:Row,target:number)=>row.observedPid===target&&(
	row.kind==='process-terminated'||row.kind==='subscription-invalidated'||row.kind==='notification-identity-unavailable'
	||row.kind==='notification-unavailable'&&(!row.notification||row.notification===focusNotice));

/** Missing observations fail this evidence check. Passing it is not a claim
 * that polling can detect every arbitrarily brief, unreported OS transition. */
export function verifyFocusEvidence({focus,journal,trace,maxSampleGapMs}:FocusProof):void{
	assert.ok(Number.isFinite(maxSampleGapMs)&&maxSampleGapMs>0,'invalid focus sampling limit');
	assert.ok(focus.length>0,'missing independent focus journal');
	const monitorStarts=journal.filter(row=>row.monitorStart);assert.equal(monitorStarts.length,1,'missing or repeated controller monitor identity');
	const monitorStart=monitorStarts[0]!.monitorStart as Row,monitorPid=pid(monitorStart.pid,'monitor PID'),monitorBirth=processBirth(monitorStart.process,monitorPid,'controller monitor start');
	for(let i=0;i<focus.length;i++){
		assert.equal(focus[i]!.sequence,i+1,'focus journal records missing');time(focus[i]!);
		if(i)assert.ok(time(focus[i]!)>=time(focus[i-1]!),'focus journal clock reversed');
		assert.notEqual(focus[i]!.kind,'fatal','monitor failure');
		assert.deepEqual(processBirth(focus[i]!.monitorProcess,monitorPid,'focus journal monitor'),monitorBirth,'focus journal came from a replaced monitor');
	}
	const readyRows=focus.filter(row=>row.kind==='ready');assert.equal(readyRows.length,1,'missing or repeated focus baseline');const ready=readyRows[0]!;
	assert.equal(ready.focusReadable,true,'no readable baseline focus');
	const baselinePids=new Set(['foregroundPid','focusPid','keyboardPid'].map(key=>pid(ready[key],key)));
	const birthKeys=[['foregroundPid','foregroundProcess'],['focusPid','focusProcess'],['keyboardPid','keyboardProcess']] as const;
	const baselineBirths=new Map<number,WriterProcessIdentity>();
	for(const [key,observation]of birthKeys){const target=pid(ready[key],key),birth=processBirth(ready[observation],target,key);if(baselineBirths.has(target))assert.deepEqual(birth,baselineBirths.get(target),'baseline PID changed identity between reads');baselineBirths.set(target,birth);}
	const samples=focus.filter(row=>row.kind==='sample');assert.ok(samples.length>1,'missing continuous focus samples');
	const starts=journal.filter(row=>row.fixtureStart),exits=journal.filter(row=>row.fixtureExit);
	assert.ok(starts.length>0&&exits.length>0,'missing fixture lifetime');
	const firstStart=Math.min(...starts.map(time)),lastExit=Math.max(...exits.map(time));
	assert.ok(time(ready)<=firstStart&&time(samples[0]!)<=firstStart,'monitor missed fixture startup');
	const stops=journal.filter(row=>row.monitorStopRequested);assert.equal(stops.length,1,'missing or repeated monitor stop request');
	assert.deepEqual(processBirth(stops[0]!.monitorProcess,monitorPid,'controller monitor stop'),monitorBirth,'monitor was replaced before shutdown');
	assert.ok(time(stops[0]!)>=lastExit,'monitor shutdown preceded fixture cleanup');
	assert.ok(time(samples.at(-1)!)>=time(stops[0]!)&&time(samples.at(-1)!)>=lastExit,'monitor missed the cleanup tail');
	const ended=focus.at(-1)!;assert.equal(ended.kind,'stopped','missing final monitor observation');
	const drained=focus.filter(row=>row.kind==='monitor-observers-stopped');assert.equal(drained.length,1,'missing or repeated observer shutdown receipt');assert.equal(drained[0]!.pendingSubscriptions,0,'monitor stopped with registration work still pending');
	assert.ok(time(drained[0]!)>=time(stops[0]!)&&time(drained[0]!)<=time(samples.at(-1)!),'observer shutdown was outside the cleanup tail');
	assert.ok(!focus.some(row=>time(row)>=time(drained[0]!)&&['subscribed','AX-notification'].includes(String(row.kind))),'focus subscription or callback reappeared after observer shutdown');
	assert.ok(time(ended)>=time(samples.at(-1)!),'monitor stopped before its final sample');
	const monitorExits=journal.filter(row=>row.monitorExit);assert.equal(monitorExits.length,1,'missing or repeated monitor exit');
	const exit=monitorExits[0]!,receipt=exit.monitorExit as Row;
	assert.ok(receipt&&receipt.requested===true&&receipt.code===0&&receipt.signal==null,'monitor did not exit normally after the final observation');
	assert.ok(time(exit)>=time(ended),'monitor exit predates its final record');
	const baseline=samples[0]!;
	for(const key of ['pointerX','pointerY','modifierFlags'])assert.ok(typeof baseline[key]==='number'&&Number.isFinite(baseline[key]),'missing global '+key+' sample');
	for(const sample of [ready,...samples,ended]){
		for(const key of ['foregroundPid','focusPid','keyboardPid']){pid(sample[key],key);assert.equal(sample[key],ready[key],'global '+key+' changed');}
		for(const [key,observation]of birthKeys)assert.deepEqual(processBirth(sample[observation],pid(sample[key],key),key),baselineBirths.get(pid(sample[key],key)),'global '+key+' process identity changed');
		assert.equal(sample.focusReadable,true,'focus became unreadable');
		assert.ok(Number.isSafeInteger(sample.focusToken)&&Number(sample.focusToken)>0,'missing actual focus token');
		assert.equal(sample.focusToken,ready.focusToken,'global focused element changed');
	}
	for(const sample of samples)for(const key of ['pointerX','pointerY','modifierFlags'])assert.equal(sample[key],baseline[key],'global '+key+' changed');
	for(let i=1;i<samples.length;i++)assert.ok(timedInterval(samples[i-1]!.uptimeMs,samples[i]!.uptimeMs,'focus sample')<=maxSampleGapMs,'focus sampling gap');
	const observed=focus.filter(row=>time(row)>=time(ready));
	for(const row of observed){
		assert.equal(row.foregroundPid,ready.foregroundPid,'foreground observation changed between samples');
		assert.deepEqual(processBirth(row.foregroundProcess,pid(row.foregroundPid,'observed foreground PID'),'foreground record'),baselineBirths.get(pid(ready.foregroundPid,'baseline foreground PID')),'foreground record came from a replaced process');
		if(row.kind==='AX-notification'&&row.systemKeyboardPidAtNotification!==undefined)assert.equal(row.systemKeyboardPidAtNotification,ready.keyboardPid,'keyboard application changed at notification');
	}
	assert.ok(!observed.some(row=>['focus','keyboard-application','foreground-notification','foreground-sample','focus-read-state'].includes(String(row.kind))),'transient foreground/focus change');
	assert.ok(!observed.some(row=>focusNotificationVerdict(row)==='changed'),'focus notification occurred in the system-focused app, even after restoration');
	assert.ok(!observed.some(row=>focusNotificationVerdict(row)==='unknown'),'historical global focus is unknown after an AX notification');
	assert.ok(!observed.some(row=>row.kind==='notification-identity-unavailable'),'AX notification has no bound live process identity');
	for(const row of observed.filter(row=>row.kind==='AX-notification')){
		const target=pid(row.observedPid,'notified process');assert.deepEqual(processBirth(row.observedProcess,target,'AX notification'),processBirth(row.subscriptionProcess,target,'AX subscription'),'AX notification came from a replaced process');
	}
	const liveSubscription=(target:number,at:number,expected?:WriterProcessIdentity)=>{
		assert.ok(at<time(drained[0]!),'focus subscriptions were already stopped');
		let live:{birth:WriterProcessIdentity;generation:string}|undefined;
		for(const row of focus){
			if(time(row)>at)break;
			if(row.observedPid!==target)continue;
			if(failedSubscription(row,target))live=undefined;
			if(row.kind==='subscribed'&&Array.isArray(row.notifications)&&row.notifications.includes(focusNotice)){
				const before=processBirth(row.subscriptionBefore,target,'subscription before'),after=processBirth(row.subscriptionAfter,target,'subscription after');
				assert.deepEqual(before,after,'process changed while establishing focus subscription');
				assert.ok(typeof row.subscriptionGeneration==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.subscriptionGeneration),'missing focus subscription generation');
				live={birth:after,generation:row.subscriptionGeneration};
			}
		}
		assert.ok(live,'missing current focus subscription for PID '+target);
		if(expected)assert.deepEqual(live.birth,expected,'focus subscription belongs to a replaced process');
		return live;
	};
	for(const target of baselinePids){
		liveSubscription(target,time(ready),baselineBirths.get(target));
		assert.ok(!observed.some(row=>failedSubscription(row,target)),'baseline focus subscription stopped');
	}
	for(const call of trace){
		timedInterval(call.at,call.end,'tool lifetime');
		assert.ok(call.at>=time(ready)&&call.at>=time(samples[0]!)&&call.end<=time(samples.at(-1)!)&&call.end<=time(ended),'tool lifetime was outside independent focus observation');
		assert.ok(call.end<=time(stops[0]!),'tool input continued after monitor shutdown was requested');
		const details=call.result.details??{};
		// A product rejection can still have launched/prepared a window. Only the
		// trusted engine's actual no-execute state exempts it, never a product flag.
		const targets=reportedFocusTargets(call.tool,call.args,{dispatch:call.engineDispatch??'returned',details}).pids;
		for(const target of targets){
		liveSubscription(target,call.at);
		const execution=call.execution;assert.ok(execution,'missing independent input execution interval');
		timedInterval(execution.at,execution.end,'input execution');assert.ok(Number(execution.at)>=call.at&&Number(execution.end)<=call.end,'input execution was outside its call');
		const boundary=(row:Row|undefined,before:boolean):WriterProcessIdentity=>{
			assert.ok(row,'missing independent target process boundary');timedInterval(row.at,row.end,'process boundary');
			assert.ok(Number(row.at)>=call.at&&Number(row.end)<=call.end,'process boundary was outside its call');
			assert.ok(before?Number(row.end)<=Number(execution.at):Number(row.at)>=Number(execution.end),'process boundary did not bracket input');
			assert.ok(Array.isArray(row.processes),'missing independent process observations');
			const matches=(row.processes as Row[]).filter(item=>item.pid===target);assert.equal(matches.length,1,'actual input process was missing or repeated at call boundary');
			return processBirth(matches[0]!.observation,target,'actual input target');
		};
		const before=boundary(call.targetBefore,true),after=boundary(call.targetAfter,false);assert.deepEqual(before,after,'actual input target process changed during the call');
		liveSubscription(target,call.at,before);liveSubscription(target,call.end,after);
		assert.ok(!focus.some(row=>time(row)>=call.at&&time(row)<=call.end&&failedSubscription(row,target)),'target focus subscription stopped during input');
		assert.deepEqual(liveSubscription(target,call.end),liveSubscription(target,call.at),'target focus subscription changed during input');
		}
	}
	for(const call of trace){const reported=call.result.details?.foreground as Row|undefined;assert.ok(!reported||reported.unchanged===true,'product detected a focus violation');}
}
