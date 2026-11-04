import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the actual helper's foreground logic, with OS observations substituted.
// This catches changes inside the JXA string that fake Desktop tests cannot see.
const source = readFileSync(new URL("../src/pointer-mac.ts", import.meta.url), "utf8");
const start = source.indexOf("let guard = null, deadline = 0;");
const end = source.indexOf("function perform(c)", start);
assert.ok(start > 0 && end > start);
const nativeGuard = source.slice(start, end);

test("the actual route ACK tracks its remote renderer before observing global focus",()=>{
	const part=(from:string,to:string)=>{const a=source.indexOf(from),b=source.indexOf(to,a);assert.ok(a>0&&b>a);return source.slice(a,b);};
	const ack=part('if(c.op==="route_ack"){','}else{');
	const original={pid:10},remote={pid:42},scopeTargets=new Set<number>(),guard={front:10,target:20,typing:original,observedAt:1,byUser:false,focusChanged:false};
	const context={guard,monitorFocus:original,scopeTargets,lifetimePhase:"active",lifetimeScope:"own-scope",helperClosing:false,lifetimeReadOnly:new Set(),phasedInput:true,pendingCommand:null as unknown,
		focusedElement:()=>remote,elementPid:(el:{pid:number})=>el.pid,focusInTargetSheet:()=>false,userInputSince:()=>false,workspace:{frontmostApplication:{processIdentifier:10}},$:{CFEqual:(a:object,b:object)=>a===b},windowRecord:()=>{},
		resolveInputTarget:(c:{pid:number})=>({...c,pid:42,instance:"remote-birth",hostTarget:{pid:c.pid}})};
	const api=runInNewContext(part("function targetInScope(pid)","// Seconds since the user")+part("function prepareCommandRoute(c)","function perform(c)")+part("function validateLifetimeCommand(c)","function lifetimeBusinessEOF()")+`;function acknowledge(c){${ack}}return c;}({validateLifetimeCommand,prepareCommandRoute,acknowledge,monitorState})`,context);
	const command={id:1,op:"click",pid:20,instance:"host-birth",window:9,bounds:{x:0,y:0,width:100,height:100},routeToken:"own-long-private-route-token",lifecycleScope:"own-scope"};
	api.validateLifetimeCommand(command);const pending=api.prepareCommandRoute(command);context.pendingCommand=pending;
	const ackCommand={id:command.id,op:"route_ack",routeToken:command.routeToken,route:pending.route,lifecycleScope:command.lifecycleScope};api.validateLifetimeCommand(ackCommand);const actual=api.acknowledge(ackCommand);
	assert.equal(actual.pid,42);assert.deepEqual([...scopeTargets],[20,42]);api.monitorState();
	assert.equal(guard.focusChanged,true);assert.equal(guard.typing,original,"a renderer receiving our input is not an unrelated human focus destination");
});

test("a hardware click into an earlier recipient is still the user taking over that scope",()=>{
	const from=source.indexOf("function userClickedTargetSince(t)"),to=source.indexOf("function targetName()",from);assert.ok(from>0&&to>from);
	let top=20;const guard={target:12},scopeTargets=new Set([12,20]);
	const $={CGEventSourceSecondsSinceLastEventType:(_source:number,type:number)=>type===1?0.01:10,CGEventCreate:()=>({}),CGEventGetLocation:()=>({x:5,y:5}),CGWindowListCopyWindowInfo:()=>({count:1,objectAtIndex:()=>({kCGWindowLayer:0,kCGWindowOwnerPID:top,kCGWindowBounds:{X:0,Y:0,Width:10,Height:10}})}),NSProcessInfo:{processInfo:{processIdentifier:999}}};
	const click=runInNewContext(source.slice(from,to)+";userClickedTargetSince",{guard,scopeTargets,$,Date:{now:()=>1000},ObjC:{castRefToObject:(x:unknown)=>x,deepUnwrap:(x:unknown)=>x},targetInScope:(pid:number)=>scopeTargets.has(pid)}) as(t:number)=>boolean;
	assert.equal(click(900),true);top=30;assert.equal(click(900),false);
});

test('native dialogs never receive synthetic key-window events',()=>{
 const from=source.indexOf('function focus(c, keyboard)'),to=source.indexOf('\nfunction ',from+1),body=source.slice(from,to);
 assert.ok(from>0&&to>from);
 for(const [role,subrole]of [['AXWindow','AXSystemDialog'],['AXWindow','AXFloatingWindow'],['AXDialog',null],['AXSheet',null]])for(const attached of [false,true]){
  let writes=0;
  const dollar=Object.assign((value:unknown)=>value,{AXUIElementCreateApplication:()=>({}),AXUIElementSetAttributeValue:()=>{writes++;}});
  const focus=runInNewContext(body+'\n;focus',{ $:dollar, exactAXWindow:()=>({}),elementRole:()=>role,axAttribute:(_el:unknown,key:string)=>key==='AXSubrole'?(subrole?{js:subrole}:null):{},insideWindow:()=>attached }) as (c:{pid:number;window:number},keyboard:boolean)=>boolean;
  assert.equal(focus({pid:20,window:30},true),true);
  assert.equal(writes,0);
 }
 const missing=runInNewContext(body+'\n;focus',{exactAXWindow:()=>null}) as (c:{pid:number;window:number},keyboard:boolean)=>boolean;
 assert.throws(()=>missing({pid:20,window:30},true),/cannot verify the exact native input window/);
 const unknown=runInNewContext(body+'\n;focus',{exactAXWindow:()=>({}),elementRole:()=>"AXWindow",axAttribute:()=>null}) as (c:{pid:number;window:number},keyboard:boolean)=>boolean;
 assert.equal(unknown({pid:20,window:30},true),true);
 const host={pid:20,window:30},remote={pid:40,window:50,hostTarget:host};let contextPid=0;
 const dollar=Object.assign((value:unknown)=>value,{AXUIElementCreateApplication:(pid:number)=>{contextPid=pid;return{};}});
 const proxy=runInNewContext(body+'\n;focus',{$:dollar,exactAXWindow:(c:unknown)=>{assert.equal(c,host);return{};},elementRole:()=>"AXSheet",axAttribute:()=>({}),insideWindow:(_el:unknown,window:number)=>window===host.window}) as (c:typeof remote,keyboard:boolean)=>boolean;
 assert.equal(proxy(remote,true),true);assert.equal(contextPid,0,"remote views must not receive synthetic focus preparation");
});

test('a remote system sheet keeps its host AX keyboard identity while input targets its renderer',()=>{
 const from=source.indexOf('function verifyKeyWindow(c)'),to=source.indexOf('\nfunction ',from+1),body=source.slice(from,to);
 let actualWindow=30,seenPid=0;
 const dollar=Object.assign((value:unknown)=>value,{AXUIElementCreateApplication:(pid:number)=>{seenPid=pid;return{};},_AXUIElementGetWindow:(_el:unknown,id:number[])=>{id[0]=actualWindow;return 0;}});
 const verify=runInNewContext(body+'\n;verifyKeyWindow',{$:dollar,Ref:()=>[],axAttribute:()=>({}),insideWindow:()=>false}) as (c:{pid:number;window:number;hostTarget:{pid:number;window:number}})=>void;
 const c={pid:40,window:50,hostTarget:{pid:20,window:30}};verify(c);assert.equal(seenPid,20);
 actualWindow=31;assert.throws(()=>verify(c),/not in the exact requested window/);
});

interface Notice { unchanged: boolean; byUser: boolean; frontChanged: boolean; focusChanged: boolean; reason: string; restored:boolean;attributionUnknown:boolean }
test("a missing original guard stays unverified without another focus read or a null dereference",()=>{
	const from=source.indexOf("function finishGuard()"),to=source.indexOf("// Hardware input counts",from);
	const forbidden=()=>{throw new Error("must not query or restore focus without the original guard");};
	const finish=runInNewContext(source.slice(from,to)+";finishGuard",{guard:null,monitorState:forbidden,observeActivation:forbidden,focusedElement:forbidden,restoreFront:forbidden,restoreTypingFocus:forbidden}) as()=>Notice;
	const result=finish();assert.equal(result.unchanged,false);assert.equal(result.restored,false);assert.equal(result.byUser,false);assert.equal(result.attributionUnknown,true);assert.match(result.reason,/original input guard is unavailable after helper shutdown/);
});
function fixture(initialFront=10) {
	let front = initialFront, clock = 1000, inputAt = -1, mouseAt=-1, restoreWorks = true, focusRestoreWorks = true, focusWrites = 0;
	let focused: object = { pid: initialFront, role:"AXTextField",parent:{pid:initialFront,role:"AXWindow"} };
	let appFocus: object | undefined;
	const originalFocus=focused;
	const activations: number[] = [];
	const context = {
		helperClosing: false,
		Date: { now: () => clock },
		workspace: { get frontmostApplication() { return { processIdentifier: front }; } },
		$: {
			CFEqual: (a: object, b: object) => a === b,
			AXUIElementCreateApplication:(pid:number)=>({pid,role:"AXApplication"}),
			CGEventSourceSecondsSinceLastEventType:(_state:number,type:number)=>(clock-(type===10?inputAt:type===5?mouseAt:-100000))/1000,
			NSNumber: { numberWithBool: (value: boolean) => value },
			AXUIElementSetAttributeValue: (el: object) => { focusWrites++; if (focusRestoreWorks) focused = el; },
			NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid: number) => ({
				isNil: () => false,
				activateWithOptions: () => { activations.push(pid); if (restoreWorks) front = pid; },
			}) },
		},
		wait: () => { clock += 60; },
		getFocused: () => focused,
		getAppFocus: () => appFocus ?? focused,
		axAttribute:(el:{role?:string;parent?:object},key:string)=>key==="AXRole"?{js:el.role??"AXTextField"}:key==="AXParent"?el.parent:key==="AXWindows"?{count:0}:null,
	};
	Object.assign(context.$, { call: () => {} });
	// JXA's $ converts a string to an NSString. Only that conversion is needed here.
	const dollar = Object.assign((text: string) => text, context.$);
	const api = runInNewContext(`${nativeGuard}
		focusedElement = () => getFocused();
		foregroundTypingFocus = () => getAppFocus();
		retireSyntheticFocus = () => {};
		elementPid = el => el.pid;
		userClickedTargetSince=()=>false;
		targetName = () => "Test target";
		guard = {front:workspace.frontmostApplication.processIdentifier, target:20, typing:focusedElement(), started:Date.now(), observedAt:Date.now(), restoredAt:0, jumpedAt:0, byUser:false, frontChanged:false};
		({check:checkGuard, activate:observeActivation, finish:finishGuard, sample:monitorState})`, { ...context, $: dollar }) as {
		check(): void; activate(): void; finish(): Notice; sample():void;
	};
	return {
		api, activations,
		change(pid: number, human = false) { clock += 10; front = pid; focused = { pid }; if (human) inputAt = clock; },
		breakRestore() { restoreWorks = false; },
		stealFocus() { clock += 10; focused = { pid: 20 }; },
		auxiliaryFocus(pid: number, human = true) { clock += 10; appFocus = originalFocus; focused = {pid,role:"AXTextField",parent:{pid,role:"AXSheet",parent:{pid:pid===21?20:pid,role:"AXApplication"}}}; if(human)inputAt=clock; },
		moveMouse(){clock+=10;mouseAt=clock;},
		typeInOriginalApp(){clock+=10;inputAt=clock;},
        tabInOtherApp(){clock+=10;inputAt=clock;focused={pid:front,field:"next"};},
		restoreFocus() { clock += 10;focused=originalFocus; },
		breakFocusRestore() { focusRestoreWorks = false; },
		get front() { return front; },
		get focusWrites() { return focusWrites; },
	};
}

test("user switches between unrelated apps continue without rolling back their destination", () => {
	const f = fixture();
	f.change(30, true); f.api.activate();
	f.change(40, true);assert.doesNotThrow(()=>f.api.check());
	assert.equal(f.front, 40);
	assert.deepEqual(f.activations, []);
	const result=f.api.finish();assert.equal(result.unchanged,true);assert.equal(result.attributionUnknown,false);
	assert.equal(f.focusWrites, 0);
});

test("a temporary keyboard-focus theft remains visible after it has already returned",()=>{
	const f=fixture();f.stealFocus();f.api.sample();f.restoreFocus();f.api.sample();
	const result=f.api.finish();assert.equal(result.unchanged,false);assert.equal(result.restored,true);assert.equal(result.focusChanged,true);
});

test("a background dialog's global keyboard focus is restored and reported", () => {
	const f = fixture(); f.stealFocus();
	const result = f.api.finish();
	assert.equal(f.front, 10);
	assert.equal(f.focusWrites, 1);
	assert.equal(result.unchanged, false);assert.equal(result.restored,true);
	assert.equal(result.focusChanged, true);
});

test("a user opening another process's nonactivating panel keeps its keyboard focus",()=>{
	const f=fixture();f.auxiliaryFocus(30);
	const result=f.api.finish();
	assert.equal(result.unchanged,true);assert.equal(result.attributionUnknown,false);
	assert.equal(f.focusWrites,0);
	assert.equal(result.focusChanged,false);
});

test("hardware input does not excuse a target-owned remote dialog stealing focus",()=>{
	const f=fixture();f.auxiliaryFocus(21);
	const result=f.api.finish();
	assert.equal(result.unchanged,false);assert.equal(result.restored,true);
	assert.equal(f.focusWrites,1);
	assert.equal(result.focusChanged,true);
});

test("focus stays with an unrelated app even if its panel changes without fresh hardware input",()=>{
	const f=fixture();f.auxiliaryFocus(30,false);
	const result=f.api.finish();
	assert.equal(result.unchanged,true);assert.equal(result.restored,true);
	assert.equal(f.focusWrites,0);
	assert.equal(result.focusChanged,false);
});

test("failed keyboard restoration cannot report an unchanged foreground and focus", () => {
	const f = fixture(); f.breakFocusRestore(); f.stealFocus();
	const result = f.api.finish();
	assert.equal(result.unchanged, false);
	assert.equal(result.focusChanged, true);
	assert.match(result.reason, /keyboard focus/);
});

test("hardware input before target activation does not prove that the user selected it", () => {
	const f = fixture();
	f.change(20, true); f.api.activate();
	const result = f.api.finish();
	assert.equal(f.front, 10);
	assert.deepEqual(f.activations, [10]);
	assert.equal(result.byUser, false);assert.equal(result.attributionUnknown,false);
	assert.equal(result.unchanged, false);
});

test("an app's unsolicited activation is restored and the transient change is still reported", () => {
	const f = fixture();
	f.change(20); f.api.activate();
	assert.equal(f.front, 10);
	const result = f.api.finish();
	assert.equal(result.unchanged, false);assert.equal(result.restored,true);
	assert.equal(result.frontChanged, true);
	assert.equal(result.byUser, false);
});

test("target auto-activation restores the user's latest app, not the action's initial app", () => {
	const f = fixture();
	f.change(30, true); f.api.activate();
	f.change(20); f.api.activate();
	assert.equal(f.front,30);
	assert.deepEqual(f.activations,[30]);
	assert.equal(f.api.finish().unchanged,false);
});

test("typing before an automatic target activation is never promoted to user authority",()=>{
	for(const method of ['activate','check','finish'] as const){
		const f=fixture();f.typeInOriginalApp();f.change(20);
		if(method==='check')f.api.check();
		else if(method==='activate')f.api.activate();
		const result=f.api.finish();
		assert.equal(result.byUser,false);assert.equal(result.unchanged,false);
		assert.equal(result.frontChanged,true);assert.equal(result.attributionUnknown,false);assert.equal(f.front,10);
	}
});

test("a failed restoration cannot claim that the foreground was preserved", () => {
	const f = fixture(); f.breakRestore();
	f.change(20); f.api.activate();
	const result = f.api.finish();
	assert.equal(f.front, 20);
	assert.equal(result.unchanged, false);
	assert.equal(result.byUser, false);
	assert.equal(result.frontChanged, true);
	assert.match(result.reason, /could not restore/);
});


test("Tab and a different field in the user's other application do not fail background input",()=>{
 const f=fixture();f.tabInOtherApp();f.api.sample();assert.doesNotThrow(()=>f.api.check());
 const notice=f.api.finish();assert.equal(notice.unchanged,true);assert.equal(notice.focusChanged,false);assert.equal(notice.attributionUnknown,false);assert.equal(f.focusWrites,0);assert.deepEqual(f.activations,[]);
});


test("moving the mouse while the target is already foreground does not count as takeover",()=>{
 const f=fixture(20);f.moveMouse();assert.doesNotThrow(()=>f.api.check());const result=f.api.finish();assert.equal(result.byUser,false);assert.equal(result.unchanged,true);assert.equal(f.focusWrites,0);
});
test("typing while the target is already foreground does count as user intervention",()=>{
 const f=fixture(20);f.typeInOriginalApp();f.api.check();const result=f.api.finish();assert.equal(result.byUser,true);assert.equal(result.unchanged,false);assert.equal(f.focusWrites,0);
});
