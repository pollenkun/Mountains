import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { mouseProbe } from "./fixtures/jxa-mouse.ts";

const source = readFileSync(new URL("../src/pointer-mac.ts", import.meta.url), "utf8");

test("window addressing preserves the native event type instead of replacing it with a window ID", () => {
	const start = source.indexOf("function stamp(e, c, x, y)");
	const end = source.indexOf("let inputSent", start);
	const stamp = runInNewContext(`${source.slice(start, end)};stamp`, {
		$: { CGEventSetIntegerValueField: (event: Record<number, number>, field: number, value: number) => { event[field] = value; }, kCGEventTargetUnixProcessID: 40 },
		windowRecord: () => ({ X:0, Y:0 }),
	}) as (event: Record<number, number>, target: {pid:number;window:number}) => void;
	const event = { 55: 1 };
	stamp(event, { pid:42, window:1234 });
	assert.equal(event[55], 1);
	assert.equal((event as Record<number, number>)[51], 1234);
	assert.equal((event as Record<number, number>)[91], 1234);
	assert.equal((event as Record<number, number>)[40], 42);
});

test("a cleanup release cannot enter a new process that reused the target PID", () => {
	const start = source.indexOf("function deliverRelease(e, c, x, y)");
	const end = source.indexOf("function releaseKey", start);
	let posted = false;
	const release = runInNewContext(`${source.slice(start, end)};deliverRelease`, {
		verifyProcess: () => { throw new Error("target process generation changed"); },
		stamp: () => {}, inputSent:false,
		$: { CGEventPostToPid: () => { posted = true; } },
	}) as (event: object, target: {pid:number}) => void;
	assert.throws(() => release({}, {pid:42}), /generation changed/);
	assert.equal(posted, false);
});

for(const change of ["second-generation-check","last-generation-check","window-closed","window-moved","unexpected-error"])
test(`cleanup preserves exact process identity across address fallback: ${change}`,()=>{
	const checks=source.slice(source.indexOf("function verifyProcess(c)"),source.indexOf("function normalizeActionName"));
	const stamp=source.slice(source.indexOf("function stamp(e, c, x, y)"),source.indexOf("let inputSent"));
	const release=source.slice(source.indexOf("function deliverRelease(e, c, x, y)"),source.indexOf("function releaseKey"));
	let calls=0;const sent:Record<number,number>[]=[];
	const dollar={NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>{calls++;return {isNil:()=>false,launchDate:{isNil:()=>false,timeIntervalSince1970:change==="second-generation-check"&&calls>=2||change==="last-generation-check"&&calls>=3?2:1}};}},
		CGWindowListCopyWindowInfo:()=>{if(change==="unexpected-error")throw new Error("unexpected window query failure");const values=change==="window-moved"?[{kCGWindowNumber:100,kCGWindowOwnerPID:10,kCGWindowBounds:{X:99,Y:2,Width:3,Height:4}}]:[];return {count:values.length,objectAtIndex:(i:number)=>values[i]};},
		CGEventSetIntegerValueField:(event:Record<number,number>,field:number,value:number)=>{event[field]=value;},CGEventPostToPid:(_pid:number,event:Record<number,number>)=>sent.push({...event}),kCGEventTargetUnixProcessID:40};
	const run=runInNewContext(`${checks}${stamp}${release};deliverRelease`,{$:dollar,ObjC:{castRefToObject:(value:unknown)=>value,deepUnwrap:(value:unknown)=>value},inputSent:false,localLocation:true}) as(event:unknown,target:unknown)=>void;
	const dispatch=()=>run({},{pid:10,instance:"1",window:100,bounds:{x:1,y:2,width:3,height:4}});
	if(change==="window-closed"||change==="window-moved"){
		dispatch();assert.equal(calls,3);assert.equal(sent.length,1);for(const field of [51,91,92])assert.equal(sent[0]![field],100);assert.equal(sent[0]![40],10);
	}else{assert.throws(dispatch,change==="unexpected-error"?/unexpected window query/:/generation changed/);assert.deepEqual(sent,[]);}
});

test("scroll distances are pixels and large requests use a bounded number of events", () => {
	const start = source.indexOf('case "scroll": {');
	const end = source.indexOf('case "text": {',start);
	const events: {unit:number;dx:number;dy:number}[] = [];
	const run = runInNewContext(`(function(c){const show=false;switch(c.op){${source.slice(start,end)}}})`, {
		$: {
			CGEventCreateScrollWheelEvent2: (_source:unknown,unit:number,_count:number,dy:number,dx:number) => ({unit,dx,dy}),
			CGEventSetLocation: () => {}, CGEventSetFlags: () => {},
			CGEventPostToPid: (_pid:number,event:typeof events[number]) => { events.push(event); },
		},
		stamp: () => {}, held: () => 0, checkGuard: () => {}, wait: () => {}, inputSent:false,
	}) as (request:{op:string;pid:number;x:number;y:number;dx:number;dy:number}) => void;
	run({op:"scroll",pid:42,x:20,y:20,dx:-129,dy:500});
	assert.ok(events.length <= 10, `500 pixels took ${events.length} events`);
	assert.equal(events.reduce((sum,event)=>sum+event.dy,0),-500);
	assert.equal(events.reduce((sum,event)=>sum+event.dx,0),129);
	assert.ok(events.every(event=>event.unit===0));
});

test("background drag never grabs the session mouse or covers the user's apps", () => {
	const f=mouseProbe(),reply=f.send("drag");assert.equal(reply.ok,true);
	assert.equal(f.events[0]!.kind,"down");assert.equal(f.events.at(-1)!.kind,"up");
	assert.ok(f.events.some(event=>event.kind==="drag"));assert.ok(f.events.every(event=>event.route==="PID"&&event.target===10));
});

test("remote input follows an AX-reported backing window, never a geometric lookalike",()=>{
	const start=source.indexOf("function resolveInputTarget(c)"),end=source.indexOf("function stamp",start);
	const root={id:100},child={id:200},bounds={x:10,y:20,width:300,height:400};
	const host={pid:10,instance:"host-start",window:100,bounds};
	const windows=[{kCGWindowNumber:200,kCGWindowOwnerPID:20,kCGWindowLayer:0,kCGWindowBounds:{X:10,Y:20,Width:300,Height:400}},{kCGWindowNumber:300,kCGWindowOwnerPID:30,kCGWindowLayer:0,kCGWindowBounds:{X:10,Y:20,Width:300,Height:400}}];
	const array=(a:unknown[])=>({count:a.length,objectAtIndex:(i:number)=>a[i]});
	const resolve=runInNewContext(`${source.slice(start,end)};resolveInputTarget`,{
		exactAXWindow:()=>root,Ref:()=>[],elementRole:()=>"AXScrollArea",
		axAttribute:(el:unknown,name:string)=>name==="AXChildren"?array(el===root?[child]:[]):null,
		ObjC:{castRefToObject:(x:unknown)=>x,deepUnwrap:(x:unknown)=>x},
		$:{CFEqual:(a:unknown,b:unknown)=>a===b,_AXUIElementGetWindow:(el:{id:number},ref:number[])=>{ref[0]=el.id;return 0;},CGWindowListCopyWindowInfo:()=>array(windows),NSRunningApplication:{runningApplicationWithProcessIdentifier:(pid:number)=>{assert.equal(pid,20);return {isNil:()=>false,launchDate:{isNil:()=>false,timeIntervalSince1970:2}};}}},
	}) as (request:typeof host)=>typeof host & {hostTarget?:typeof host};
	const routed=resolve(host);assert.equal(routed.pid,20);assert.equal(routed.window,200);assert.equal(routed.instance,"2");assert.equal(routed.hostTarget?.window,100);
	windows[0]!.kCGWindowBounds.X=11.5;
	assert.equal(resolve(host),host,"a lookalike window absent from the AX subtree must never be chosen");
});

test("native custom-action normalization matches provider spelling without losing original casing",()=>{
 const start=source.indexOf("function normalizeActionName(name)"),end=source.indexOf("// A remote view",start);
 const normalize=runInNewContext(`${source.slice(start,end)};normalizeActionName`) as (name:string)=>string;
 assert.equal(normalize("AXScrollToVisible"),"scroll_to_visible");
 assert.equal(normalize("Name:删除\nTarget:0x0\nSelector:(null)"),"name:删除\n_target:0x0\n_selector:(null)");
 assert.equal(normalize("Name:Copy\nTarget:0x0\nSelector:(null)"),"name:_copy\n_target:0x0\n_selector:(null)");
});



test("remote input refuses a host that replaced its renderer while both processes stayed alive",()=>{
 const from=source.indexOf("function verifyProcess(c)"),to=source.indexOf("function stamp",from);
 const bounds={x:10,y:20,width:300,height:400},root={id:100},old={id:200},replacement={id:300};let child=old;
 const host={pid:10,instance:"1",window:100,bounds},array=(a:unknown[])=>({count:a.length,objectAtIndex:(i:number)=>a[i]});
 const windows=[10,20,30].map((pid,i)=>({kCGWindowNumber:(i+1)*100,kCGWindowOwnerPID:pid,kCGWindowLayer:0,kCGWindowBounds:{X:10,Y:20,Width:300,Height:400}}));
 const api=runInNewContext(`${source.slice(from,to)};({resolveInputTarget,windowRecord})`,{
  exactAXWindow:()=>root,Ref:()=>[],elementRole:()=>"AXGroup",axAttribute:(el:unknown,name:string)=>name==="AXChildren"?array(el===root?[child]:[]):null,
  ObjC:{castRefToObject:(v:unknown)=>v,deepUnwrap:(v:unknown)=>v},
  $:{CFEqual:(a:unknown,b:unknown)=>a===b,_AXUIElementGetWindow:(el:{id:number},out:number[])=>{out[0]=el.id;return 0;},CGWindowListCopyWindowInfo:()=>array(windows),NSRunningApplication:{runningApplicationWithProcessIdentifier:(pid:number)=>({isNil:()=>false,launchDate:{isNil:()=>false,timeIntervalSince1970:pid/10}})}}
 }) as {resolveInputTarget:(c:typeof host)=>typeof host;windowRecord:(c:typeof host)=>unknown};
 const routed=api.resolveInputTarget(host);assert.equal(routed.pid,20);api.windowRecord(routed);
 child=replacement;assert.equal(api.resolveInputTarget(host).pid,30);assert.throws(()=>api.windowRecord(routed),/receiver changed/);
});

for(const kind of ["ordinary","password","missingFocus","missingMetadata","payment"])
test(`native keyboard permits missing AX focus and password; refuses known payment: ${kind}`,()=>{
 const from=source.indexOf("function rejectKnownPaymentReceiver(c)"),to=source.indexOf("const retainedReceivers",from);let pid=0;
 const receiver={},dollar=Object.assign((v:unknown)=>v,{AXUIElementCreateApplication:(n:number)=>{pid=n;return {};}});
 const verify=runInNewContext(`${source.slice(from,to)};rejectKnownPaymentReceiver`,{$:dollar,axAttribute:(_el:unknown,name:string)=>name==="AXFocusedUIElement"?(kind==="missingFocus"?null:receiver):kind==="payment"?{js:"cc-number"}:kind==="password"?{js:"password"}:null}) as(c:object)=>void;
 const run=()=>verify({pid:20,hostTarget:{pid:10}});
 if(kind==="payment")assert.throws(run,/payment/);else assert.doesNotThrow(run);
 assert.equal(pid,10);
});
