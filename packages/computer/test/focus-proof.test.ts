import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyFocusEvidence,type FocusProof} from './acceptance/focus-proof.ts';
const birth=(pid:number,microseconds=123456)=>({schema:'macos-kinfo-starttime-v1',pid,bootId:'01234567-89ab-cdef-0123-456789abcdef',startSeconds:'1790000000',startMicroseconds:microseconds});
const observation=(pid:number,microseconds=123456)=>({status:'alive',identity:birth(pid,microseconds)});

function evidence():FocusProof{
	const state={focusReadable:true,foregroundPid:11,focusPid:12,keyboardPid:13,foregroundProcess:observation(11),focusProcess:observation(12),keyboardProcess:observation(13),focusToken:1,pointerX:10,pointerY:20,modifierFlags:0};
	return {focus:[
		...[11,12,13].map(observedPid=>subscribed(observedPid,70)),
		{kind:'ready',at:90,...state},...[95,115,135,155,175,195].map(at=>({kind:'sample',at,uptimeMs:at,...state})),{kind:'monitor-observers-stopped',at:208,pendingSubscriptions:0},{kind:'sample',at:210,uptimeMs:210,...state},{kind:'stopped',at:211,...state}
	].map((row,i)=>({...state,...row,sequence:i+1,monitorProcess:observation(99)})),journal:[{monitorStart:{pid:99,process:observation(99)},at:60},{fixtureStart:'own',at:100},{fixtureExit:'own',at:200},{monitorStopRequested:true,monitorProcess:observation(99),at:205},{monitorExit:{requested:true,code:0,signal:null},at:212}],trace:[],maxSampleGapMs:40};
}
function change(input:FocusProof,rows:Record<string,unknown>[]=[]):FocusProof{
	const baseline=input.focus.find(row=>row.kind==='ready');
	return {...input,focus:[...input.focus,...rows.map((row):Record<string,unknown>=>({...baseline,monitorProcess:observation(99),...row}))].sort((a,b)=>Number(a.at)-Number(b.at)).map((row,i)=>({...row,sequence:i+1}))};
}
const subscribed=(pid:number,at=85)=>({kind:'subscribed',at,observedPid:pid,notifications:['AXFocusedUIElementChanged'],subscriptionBefore:observation(pid),subscriptionAfter:observation(pid),subscriptionGeneration:'00000000-0000-0000-0000-'+(pid*1000+at).toString(16).padStart(12,'0')});
function call(input:FocusProof,tool:string,target:number|undefined):FocusProof{
	const processes=target===undefined?[]:[{pid:target,observation:observation(target)}];
	return {...input,trace:[{tool,at:120,end:130,execution:{at:122,end:128},targetBefore:{at:120,end:121,processes},targetAfter:{at:129,end:130,processes},args:{action:'type',text:'own synthetic input'},result:{details:{pid:target,dispatched:true}}}]};
}

test('focus evidence brackets fixture cleanup and has live subscriptions for all baseline processes',()=>{
	assert.doesNotThrow(()=>verifyFocusEvidence(evidence()));
});
test('unknown foreground, focus and keyboard PIDs cannot prove noninterruption',()=>{
	for(const key of ['foregroundPid','focusPid','keyboardPid'])for(const value of [0,undefined,-1,NaN]){
		const input=evidence();input.focus=input.focus.map(row=>row.kind==='ready'||row.kind==='sample'||row.kind==='stopped'?{...row,[key]:value}:row);
		assert.throws(()=>verifyFocusEvidence(input),/known process/);
	}
});
test('the keyboard application needs its own current notification subscription',()=>{
	const input=evidence();input.focus=input.focus.filter(row=>row.observedPid!==13);assert.throws(()=>verifyFocusEvidence(change(input)),/subscription/);
});
test('a last log row cannot conceal an unobserved cleanup tail',()=>{
	const input=evidence();input.focus=input.focus.filter(row=>row.kind!=='sample'||Number(row.at)<=135);assert.throws(()=>verifyFocusEvidence(change(input)),/cleanup tail/);
});
test('web and native actual input targets all need live focus subscriptions',()=>{
	for(const tool of ['web_act','screen_act']){
		assert.throws(()=>verifyFocusEvidence(call(evidence(),tool,undefined)),/known process/);
		assert.throws(()=>verifyFocusEvidence(call(evidence(),tool,22)),/subscription/);
		assert.throws(()=>verifyFocusEvidence(change(call(evidence(),tool,22),[{kind:'notification-unavailable',at:95,observedPid:22,notification:'AXFocusedUIElementChanged'}])),/subscription/);
		assert.doesNotThrow(()=>verifyFocusEvidence(change(call(evidence(),tool,22),[subscribed(22)])));
	}
});
test('a PID subscription stops at process termination and must be established again before input',()=>{
	const input=change(call(evidence(),'screen_act',22),[subscribed(22),{kind:'process-terminated',at:110,observedPid:22}]);
	assert.throws(()=>verifyFocusEvidence(input),/subscription/);
	assert.doesNotThrow(()=>verifyFocusEvidence(change(input,[subscribed(22,118)])));
	assert.throws(()=>verifyFocusEvidence(change(input,[{kind:'notification-unavailable',at:115,observedPid:22,notification:'AXFocusedUIElementChanged'}])),/subscription/);
});
test('a subscription gap during a call fails even if a later subscription is present',()=>{
	const input=change(call(evidence(),'web_act',22),[subscribed(22),{kind:'process-terminated',at:125,observedPid:22},subscribed(22,126)]);
	assert.throws(()=>verifyFocusEvidence(input),/stopped during input/);
});
test('URL navigation and new-tab creation need an observed browser process too',()=>{
	for(const args of [{url:'http://127.0.0.1/'},{new_tab:true}]){
		const input=call(evidence(),'web_read',22);input.trace[0]!.args=args;
		assert.throws(()=>verifyFocusEvidence(input),/subscription/);
		assert.doesNotThrow(()=>verifyFocusEvidence(change(input,[subscribed(22)])));
	}
});
test('ordinary reads and screenshots also require the actual target subscription',()=>{
	for(const tool of ['web_read','web_look','screen_read','screen_look']){
		const input=call(evidence(),tool,22);input.trace[0]!.args=tool.startsWith('screen_')?{app:'Own test app'}:{};
		assert.throws(()=>verifyFocusEvidence(input),/subscription/);
		assert.doesNotThrow(()=>verifyFocusEvidence(change(input,[subscribed(22)])));
	}
});
test('calls cannot predate readiness or run after focus observation ends',()=>{
	for(const [at,end]of [[80,85],[215,220],[120,215]]){
		const input=change(call(evidence(),'web_act',22),[subscribed(22)]);input.trace=[{...input.trace[0]!,at:at!,end:end!}];
		assert.throws(()=>verifyFocusEvidence(input),/outside independent/);
	}
});
test('restored focus and delayed notification history cannot become a pass',()=>{
	for(const row of [{kind:'focus'},{kind:'AX-notification',notification:'AXFocusedUIElementChanged',inSystemFocusedApplication:true},{kind:'AX-notification',notification:'AXFocusedUIElementChanged',inSystemFocusedApplication:false}])assert.throws(()=>verifyFocusEvidence(change(evidence(),[{at:140,...row}])));
});
test('monitor errors, missing final observations, gaps and invalid pointer samples all fail',()=>{
	for(const transform of [
		(input:FocusProof)=>{input.focus=input.focus.filter(row=>row.kind!=='stopped');return change(input);},
		(input:FocusProof)=>{input.journal=input.journal.map(row=>row.monitorExit?{...row,monitorExit:{requested:true,code:null,signal:'SIGTERM'}}:row);return input;},
		(input:FocusProof)=>{input.focus=input.focus.map(row=>row.kind==='sample'?{...row,pointerY:null}:row);return input;},
		(input:FocusProof)=>({...input,maxSampleGapMs:10}),
		(input:FocusProof)=>change(input,[{kind:'notification-unavailable',at:160,observedPid:13,notification:'AXFocusedUIElementChanged'}]),
	])assert.throws(()=>verifyFocusEvidence(transform(evidence())));
});

test('known numeric PIDs without independent OS birth observations cannot pass',()=>{
	for(const key of ['foregroundProcess','focusProcess','keyboardProcess'])for(const value of [undefined,{status:'unknown',reason:'process-query-failed'},{status:'absent'},observation(999)]){
		const input=evidence();input.focus=input.focus.map(row=>row.kind==='ready'||row.kind==='sample'||row.kind==='stopped'?{...row,[key]:value}:row);
		assert.throws(()=>verifyFocusEvidence(input),/process observation|different PID/);
	}
});
test('a recycled baseline PID fails even if numeric foreground and focus never change',()=>{
	for(const key of ['foregroundProcess','focusProcess','keyboardProcess']){
		const input=evidence();input.focus=input.focus.map(row=>row.kind==='sample'&&row.at===155?{...row,[key]:observation(key==='foregroundProcess'?11:key==='focusProcess'?12:13,654321)}:row);
		assert.throws(()=>verifyFocusEvidence(input),/process identity changed/);
	}
});
test('subscription before and after identity must agree and match the baseline process',()=>{
	for(const mode of ['missing','during','prior']){
		const input=evidence();input.focus=input.focus.map(row=>row.kind==='subscribed'&&row.observedPid===11?{...row,subscriptionBefore:mode==='missing'?undefined:mode==='prior'?observation(11,654321):observation(11),subscriptionAfter:observation(11,654321)}:row);
		assert.throws(()=>verifyFocusEvidence(input),/process observation|process changed|replaced process/);
	}
});
test('a reused target PID or unavailable callback identity invalidates an input interval',()=>{
	for(const kind of ['subscription-invalidated','notification-identity-unavailable']){
		const input=change(call(evidence(),'screen_act',22),[subscribed(22),{kind,at:125,observedPid:22},subscribed(22,126)]);
		assert.throws(()=>verifyFocusEvidence(input));
	}
	const input=change(call(evidence(),'web_act',22),[subscribed(22),{...subscribed(22,125),subscriptionBefore:observation(22,654321),subscriptionAfter:observation(22,654321)}]);
	assert.throws(()=>verifyFocusEvidence(input),/subscription belongs to a replaced process/);
});

test('target PID reuse is rejected by controller OS probes even when the monitor missed its termination',()=>{
	const input=change(call(evidence(),'web_act',22),[subscribed(22)]);input.trace=structuredClone(input.trace);
	input.trace[0]!.targetAfter={at:129,end:130,processes:[{pid:22,observation:observation(22,654321)}]};assert.throws(()=>verifyFocusEvidence(input),/actual input target process changed/);
	input.trace[0]!.targetBefore={at:120,end:121,processes:[{pid:22,observation:observation(22,654321)}]};assert.throws(()=>verifyFocusEvidence(input),/subscription belongs to a replaced process/);
});
test('independent process boundaries must bracket execution and cannot be missing, repeated or unknown',()=>{
	for(const patch of [
		{execution:undefined},{targetBefore:undefined},{targetAfter:undefined},
		{targetBefore:{at:123,end:124,processes:[{pid:22,observation:observation(22)}]}},
		{targetAfter:{at:126,end:127,processes:[{pid:22,observation:observation(22)}]}},
		{targetBefore:{at:120,end:121,processes:[]}},
		{targetAfter:{at:129,end:130,processes:[{pid:22,observation:{status:'absent'}}]}},
		{targetAfter:{at:129,end:130,processes:[{pid:22,observation:observation(22)},{pid:22,observation:observation(22)}]}},
	]){
		const input=change(call(evidence(),'screen_act',22),[subscribed(22)]);input.trace=[{...input.trace[0]!,...patch} as FocusProof['trace'][number]];assert.throws(()=>verifyFocusEvidence(input));
	}
});
test('a target born and subscribed inside the call cannot use its later identity to pass cold-start monitoring',()=>{
	const input=change(call(evidence(),'web_read',22),[subscribed(22,123)]);assert.throws(()=>verifyFocusEvidence(input),/subscription/);
});

test('the monitor birth is bound to controller startup, every journal row and pre-EOF shutdown',()=>{
	for(const mode of ['start','record','stop']){
		const input=evidence();if(mode==='record')input.focus=input.focus.map(row=>row.kind==='sample'&&row.at===155?{...row,monitorProcess:observation(99,654321)}:row);
		else input.journal=input.journal.map(row=>mode==='start'&&row.monitorStart?{...row,monitorStart:{pid:99,process:observation(99,654321)}}:mode==='stop'&&row.monitorStopRequested?{...row,monitorProcess:observation(99,654321)}:row);
		assert.throws(()=>verifyFocusEvidence(input),/replaced monitor|replaced before shutdown/);
	}
});

test('observer registration cannot be silently abandoned or resurrected after the final sample',()=>{
	for(const transform of [
		(input:FocusProof)=>({...input,focus:input.focus.filter(row=>row.kind!=='monitor-observers-stopped')}),
		(input:FocusProof)=>({...input,focus:input.focus.map(row=>row.kind==='monitor-observers-stopped'?{...row,pendingSubscriptions:1}:row)}),
		(input:FocusProof)=>change({...input,focus:input.focus.filter(row=>row.kind!=='monitor-observers-stopped')},[{kind:'monitor-observers-stopped',at:210.5,pendingSubscriptions:0}]),
	])assert.throws(()=>verifyFocusEvidence(change(transform(evidence()))),/shutdown receipt|pending|cleanup tail/);
});

test('a same-birth observer replacement during input cannot conceal a notification gap',()=>{
	const input=change(call(evidence(),'screen_act',22),[subscribed(22),subscribed(22,125)]);assert.throws(()=>verifyFocusEvidence(input),/subscription changed during input/);
	const missing=change(call(evidence(),'screen_act',22),[{...subscribed(22),subscriptionGeneration:undefined}]);assert.throws(()=>verifyFocusEvidence(missing),/subscription generation/);
});

test('final samples cannot make tool calls after the observer shutdown request look monitored',()=>{
	for(const [at,end]of [[206,207],[208.2,209.8]]){
		const input=change(call(evidence(),'web_read',22),[subscribed(22)]);input.trace=[{...input.trace[0]!,at:at!,end:end!}];assert.throws(()=>verifyFocusEvidence(input),/shutdown was requested/);
	}
	const resurrected=change(evidence(),[subscribed(22,209)]);assert.throws(()=>verifyFocusEvidence(resurrected),/reappeared/);
});

test('product dispatched=false cannot hide execute preparation without an observed target',()=>{
	for(const tool of ['screen_act','web_act']){
		const input=call(evidence(),tool,undefined);input.trace[0]!.result.details={dispatched:false};assert.throws(()=>verifyFocusEvidence(input),/PID/);
		input.trace=[{...input.trace[0]!,engineDispatch:'not-started'}];assert.doesNotThrow(()=>verifyFocusEvidence(input));
	}
});

test('every reported target in a batch needs its own independent birth and subscription',()=>{
	let input=change(call(evidence(),'screen_act',22),[subscribed(22)]);input.trace[0]!.args={steps:[{action:'press'},{action:'key'}]};
	input.trace[0]!.result.details={pid:22,targetPids:[22,23],steps:[{pid:22},{pid:23}],dispatched:true};
	assert.throws(()=>verifyFocusEvidence(input),/subscription/);
	input=change(input,[subscribed(23)]);assert.throws(()=>verifyFocusEvidence(input),/missing or repeated/);
	for(const side of ['targetBefore','targetAfter']as const){const boundary=input.trace[0]![side]!;boundary.processes=[...(boundary.processes as unknown[]),{pid:23,observation:observation(23)}];}
	assert.doesNotThrow(()=>verifyFocusEvidence(input));
	input.trace[0]!.result.details={pid:22,steps:[{},{}]};assert.throws(()=>verifyFocusEvidence(input),/PID/);
});

test('a foreground change on an ordinary hint fails even when surrounding samples were restored',()=>{
	const input=change(evidence(),[{kind:'termination-hint',at:140,foregroundPid:23,foregroundProcess:observation(23)}]);
	assert.throws(()=>verifyFocusEvidence(input),/foreground observation changed/);
});
