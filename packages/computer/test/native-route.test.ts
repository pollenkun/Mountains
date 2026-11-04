import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsonHelper } from "../src/helper.ts";
import { MacPointer } from "../src/pointer-mac.ts";
import { interruptedInputTarget, interruptedPointer, nativeCommandRoute, PointerInputError } from "../src/native-route.ts";

const owner={pid:10,instance:"1",window:100,bounds:{x:10,y:20,width:300,height:400}};
const target={...owner,pid:20,instance:"2",window:200};
const command={op:"key" as const,...owner,key:"a",held:[]};
const selected=(op="key")=>({schema:"mac-command-target-v1",op,owner:structuredClone(owner),target:structuredClone(target)});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test("an unverified attempted drag point cannot become a background drop position",()=>{
	for(const positionVerified of [false,"unknown",null]){
		const error=new PointerInputError(new Error("move status unknown"),nativeCommandRoute(selected("drag"),{...command,op:"drag"}),true,{x:10,y:20,button:"left",released:false,positionVerified});
		assert.equal(error.pointer,null);assert.equal(interruptedPointer(error),null);assert.match(error.message,/no drop position was guessed/);
	}
});

test("the pointer ledger retains the exact remote AX anchor for original-address release",()=>{
	const source=readFileSync(new URL("../src/pointer-mac.ts",import.meta.url),"utf8"),from=source.indexOf("function verifyProcess(c)"),to=source.indexOf("let inputSent",from),copyStart=source.indexOf("function pointerTarget(c)"),copyEnd=source.indexOf("function beginPointer",copyStart),releaseStart=source.indexOf("function deliverRelease(e, c, x, y)"),releaseEnd=source.indexOf("function releaseKey",releaseStart);
	const bounds={x:10,y:20,width:300,height:400},root={id:100},original={id:200};let child=original;
	const array=(values:unknown[])=>({count:values.length,objectAtIndex:(index:number)=>values[index]}),sent:number[]=[];
	const windows=[10,20].map((pid,index)=>({kCGWindowNumber:(index+1)*100,kCGWindowOwnerPID:pid,kCGWindowLayer:0,kCGWindowBounds:{X:10,Y:20,Width:300,Height:400}}));
	const api=runInNewContext(`${source.slice(from,to)}${source.slice(copyStart,copyEnd)}${source.slice(releaseStart,releaseEnd)};({resolveInputTarget,windowRecord,pointerTarget,deliverRelease})`,{
		inputSent:false,localLocation:true,exactAXWindow:()=>root,Ref:()=>[],elementRole:()=>"AXGroup",axAttribute:(el:unknown,name:string)=>name==="AXChildren"?array(el===root?[child]:[]):null,
		ObjC:{castRefToObject:(value:unknown)=>value,deepUnwrap:(value:unknown)=>value},
		$:{CFEqual:(a:unknown,b:unknown)=>a===b,_AXUIElementGetWindow:(el:{id:number},out:number[])=>{out[0]=el.id;return 0;},CGWindowListCopyWindowInfo:()=>array(windows),CGEventSetIntegerValueField:()=>{},CGEventSetWindowLocation:()=>{},CGEventPostToPid:(pid:number)=>sent.push(pid),kCGEventTargetUnixProcessID:40,NSRunningApplication:{runningApplicationWithProcessIdentifier:(pid:number)=>({isNil:()=>false,launchDate:{isNil:()=>false,timeIntervalSince1970:pid/10}})}}
	}) as{resolveInputTarget:(c:unknown)=>any;pointerTarget:(c:unknown)=>any;windowRecord:(c:unknown)=>unknown;deliverRelease:(event:unknown,c:unknown,x:number,y:number)=>void};
	const routed=api.resolveInputTarget({pid:10,instance:"1",window:100,bounds}),stored=api.pointerTarget(routed);
	assert.equal(stored.hostTarget.inputAnchor.element,original);assert.notEqual(stored.hostTarget.inputAnchor.path,routed.hostTarget.inputAnchor.path);
	routed.hostTarget.inputAnchor.path[0]=99;bounds.x=99;
	assert.doesNotThrow(()=>api.windowRecord(stored));api.deliverRelease({},stored,20,30);assert.deepEqual(sent,[20]);
	child={id:200};assert.throws(()=>api.deliverRelease({},stored,20,30),/host remote input receiver changed/);assert.deepEqual(sent,[20]);
});
/** Node fixture only: never starts osascript, reads AX, or sends desktop input. */
function fixture(mode:string){
	const program=`let pending;const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{
	 const c=JSON.parse(line),send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
	 if(c.op==='guard_start'||c.op==='guard_end'){send({id:c.id,ok:true,unchanged:true});return;}
	 if(c.op==='route_ack'){
	  if(!pending||c.id!==pending.id||c.routeToken!==pending.routeToken||JSON.stringify(c.route)!==JSON.stringify(pending.route))process.exit(71);
	  if(${JSON.stringify(mode)}==='exit'){process.exit(7);return;}if(${JSON.stringify(mode)}==='timeout')return;
	  if(${JSON.stringify(mode)}==='refuse'){send({id:c.id,ok:false,inputSent:false,error:'exact window changed'});return;}
	  if(${JSON.stringify(mode)}==='held'){send({id:c.id,ok:false,inputSent:true,error:'after down',inputPointer:{x:31,y:42,button:'right',released:false}});return;}
	  send({id:c.id,ok:true});return;
	 }
	 if(${JSON.stringify(mode)}==='missing'){send({id:c.id,ok:true});return;}
	 const route={schema:'mac-command-target-v1',op:c.op,owner:{pid:c.pid,instance:c.instance,window:c.window,bounds:c.bounds},target:${JSON.stringify(target)}};
	 if(${JSON.stringify(mode)}==='wrong-owner')route.owner.pid=11;
	 if(${JSON.stringify(mode)}==='wrong-op')route.op='text';
	 if(${JSON.stringify(mode)}==='wrong-box')route.target.bounds.width=0;
	 const record={id:c.id,kind:'input-route',routeToken:c.routeToken,route};
	 if(${JSON.stringify(mode)}==='wrong-token')record.routeToken='different';
	 pending={id:c.id,routeToken:c.routeToken,route};
	 if(${JSON.stringify(mode)}==='duplicate'){process.stdout.write(JSON.stringify(record)+'\\n'+JSON.stringify(record)+'\\n'+JSON.stringify({id:c.id,ok:true})+'\\n');return;}
	 if(${JSON.stringify(mode)}==='extra-final'){process.stdout.write(JSON.stringify(record)+'\\n'+JSON.stringify({id:c.id,ok:true})+'\\n'+JSON.stringify(record)+'\\n');return;}
	 send(record);
	});`;
	const helper=new JsonHelper(process.execPath,["-e",program]),pointer=new MacPointer();
	Object.defineProperty(pointer,"helper",{value:helper});
	// Fake NSEvent data stops pointer fixtures from compiling or starting a native helper.
	Object.defineProperty(pointer,"eventData",{value:Promise.resolve({mouse:async()=>({}),close:async()=>{}}),writable:true});
	return {pointer,helper};
}

test("resolved command addresses are private immutable copies and retain a remote target",()=>{
	const raw=selected(),route=nativeCommandRoute(raw,command);
	raw.target.pid=30;raw.target.bounds.x=99;
	assert.equal(route.target.pid,20);assert.equal(route.target.bounds.x,10);assert.ok(Object.isFrozen(route.target.bounds));
	const failure=new PointerInputError(new Error("stopped"),route,true);
	assert.deepEqual(interruptedInputTarget(failure),target);
	assert.equal(interruptedPointer(failure),null,"transport loss has no verified last pointer position");
	assert.equal(interruptedInputTarget(new PointerInputError(new Error("not sent"),route,false)),null);
	assert.equal(interruptedInputTarget(new Error("not a route receipt")),null);
});

test("the actual Node helper waits for an ACK after the private route callback",async()=>{
	const {pointer}=fixture("success");
	try{
		await pointer.send({op:"guard_start",pid:owner.pid});await pointer.send(command);
		const end=await pointer.send({op:"guard_end"});
		assert.deepEqual(end.inputTargetPids,[20]);assert.equal(end.inputRoutesComplete,true);
		assert.deepEqual((end.inputRoutes as unknown[])[0],selected());
		await pointer.send({op:"guard_start",pid:owner.pid});assert.deepEqual((await pointer.send({op:"guard_end"})).inputTargetPids,[]);
	}finally{await pointer.close();}
});

for(const mode of ["exit","timeout","refuse","missing","wrong-owner","wrong-op","wrong-box","wrong-token","duplicate","extra-final"])
test(`native target receipt survives or refuses the real helper failure: ${mode}`,async()=>{
	const {pointer,helper}=fixture(mode);
	try{
		await pointer.send({op:"guard_start",pid:owner.pid});
		let failure:PointerInputError|undefined;
		try{await pointer.send(command,mode==="timeout"?120:1000);assert.fail("bad helper unexpectedly succeeded");}
		catch(error){assert.ok(error instanceof PointerInputError,String(error));failure=error;}
		assert.ok(failure);
		if(["exit","timeout","refuse","duplicate","extra-final"].includes(mode))assert.deepEqual(failure.route?.target,target);
		else assert.equal(failure.route,null);
		assert.equal(failure.inputMayHaveBeenSent,["exit","timeout"].includes(mode),"duplicate/early-final records are rejected before any ACK write");
		if(mode==="refuse")assert.equal(interruptedInputTarget(failure),null);
		if(["exit","timeout","wrong-owner","wrong-op","wrong-box","wrong-token","duplicate","extra-final"].includes(mode))assert.equal(helper.pid,null,"stopped helper must not keep dispatching after rejection");
		assert.equal(interruptedPointer(failure),null);
		if(mode==="exit"||mode==="timeout"){
			const end=await pointer.send({op:"guard_end"});assert.deepEqual(end.inputTargetPids,[20]);assert.equal(end.inputRoutesComplete,false);
		}
	}finally{await pointer.close();}
});

test("a final pointer refusal preserves its real last point, never the planned destination",async()=>{
	const {pointer}=fixture("held");
	try{
		await assert.rejects(pointer.send({...owner,op:"drag",x:10,y:20,x2:299,y2:399}),error=>{
			assert.ok(error instanceof PointerInputError);assert.deepEqual(interruptedPointer(error),{target,at:[31,42],button:"right"});return true;
		});
	}finally{await pointer.close();}
});

test("a rejection before ACK stops the child without authorizing its effect",async()=>{
	let callback=false;const helper=new JsonHelper(process.execPath,["-e",`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const c=JSON.parse(s);if(c.op==='route_ack')process.exit(81);process.stdout.write(JSON.stringify({id:c.id,kind:'input-route',routeToken:c.routeToken,route:{}})+'\\n')});`]);
	try{await assert.rejects(helper.send({op:"key",routeToken:"owned-nonce-123456"},1000,true,()=>{callback=true;throw new Error("parent refused route");}),/parent refused route/);assert.equal(callback,true);assert.equal(helper.pid,null);}
	finally{await helper.dispose();}
});

test("native cleanup releases the recorded renderer at its last point and refuses unknown points",async()=>{
	const source=readFileSync(new URL("../src/backend.ts",import.meta.url),"utf8"),start=source.indexOf("async pointer(app,"),end=source.indexOf("async key(app,",start);
	const {stripTypeScriptTypes}=await import("node:module");
	const body=stripTypeScriptTypes(`({${source.slice(start,end)}}).pointer`);
	for(const position of [null,{x:31,y:42,button:"right",released:false},{x:31,y:42,button:"right",released:true}]){
		const failure=new PointerInputError(new Error("interrupted"),nativeCommandRoute(selected("drag"),{...command,op:"drag"}),true,position),sent:Record<string,unknown>[]=[];
		const run=runInNewContext(body,{PointerInputError,interruptedPointer,interruptedInputTarget,macOnly:()=>{},macWindowNumber:async()=>({id:owner.window,bounds:owner.bounds}),options:{cursor:false},helper:()=>({send:async(c:Record<string,unknown>)=>{sent.push(c);if(c.op==="drag")throw failure;return {};}})}) as(app:unknown,window:unknown,gesture:unknown)=>Promise<void>;
		await assert.rejects(run({...owner,name:"Own fixture"},{},{kind:"drag",from:[10,20],to:[299,399]}),error=>error===failure);
		if(position&&!position.released){assert.equal(sent.length,2);assert.equal(sent[1]!.pid,20);assert.equal(sent[1]!.window,200);assert.equal(sent[1]!.instance,"2");assert.equal(sent[1]!.x,31);assert.equal(sent[1]!.y,42);}
		else assert.equal(sent.length,1,"no extra mouse release when already released or the last point is unknown");
	}
});

test("the parent does not ACK a route after cancellation during its callback",async()=>{
	const controller=new AbortController(),{InputCoordinator}=await import("../src/coordinator.ts");let callback=false;
	const helper=new JsonHelper(process.execPath,["-e",`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const c=JSON.parse(s);if(c.op==='route_ack')process.exit(81);process.stdout.write(JSON.stringify({id:c.id,kind:'input-route',routeToken:c.routeToken,route:{}})+'\\n')});`]);
	try{await assert.rejects(new InputCoordinator().run(controller.signal,()=>helper.send({op:"key",routeToken:"owned-nonce-123456"},1000,true,()=>{callback=true;controller.abort(new Error("stop before ACK"));})),/stop before ACK|stopped/);assert.equal(callback,true);assert.equal(helper.pid,null);await delay(1);}
	finally{await helper.dispose();}
});

test("cancelling before ACK cannot synthesize a global mouse release or a key-up",async()=>{
	const {InputCoordinator}=await import("../src/coordinator.ts"),{stripTypeScriptTypes}=await import("node:module");
	const source=readFileSync(new URL("../src/backend.ts",import.meta.url),"utf8"),pointerStart=source.indexOf("async pointer(app,"),keyStart=source.indexOf("async key(app,"),textStart=source.indexOf("async text(app,",keyStart);
	for(const kind of ["drag","key"]){
		const stop=new AbortController(),{pointer,helper}=fixture("success"),original=helper.send.bind(helper),sent:Record<string,unknown>[]=[];
		helper.send=(c,ms,cancellable,record,permit)=>original(c,ms,cancellable,(row,context)=>{record?.(row,context);stop.abort(new Error("cancel before permission"));},permit);
		let captured:PointerInputError|undefined;
		const proxy={send:async(c:Parameters<MacPointer["send"]>[0])=>{sent.push(c);try{return await pointer.send(c);}catch(error){assert.ok(error instanceof PointerInputError);captured=error;throw error;}}};
		const body=stripTypeScriptTypes(kind==="drag"?`({${source.slice(pointerStart,keyStart)}}).pointer`:`({${source.slice(keyStart,textStart)}}).key`);
		const run=runInNewContext(body,{PointerInputError,interruptedPointer,interruptedInputTarget,macOnly:()=>{},macWindowNumber:async()=>({id:owner.window,bounds:owner.bounds}),options:{cursor:false},helper:()=>proxy}) as(...args:unknown[])=>Promise<void>;
		try{
			await assert.rejects(new InputCoordinator().run(stop.signal,()=>kind==="drag"?run({...owner,name:"Own fixture"},{},{kind:"drag",from:[10,20],to:[299,399]},true):run({...owner,name:"Own fixture"},{},"a",[],true)),/cancel before permission|stopped/);
			assert.equal(captured?.inputMayHaveBeenSent,false);assert.deepEqual(sent.map(c=>c.op),[kind]);
			assert.equal(helper.pid,null);
		}finally{await pointer.close();}
	}
});

for(const phase of ["after-record-microtask","before-permit"])test(`the actual MacPointer and backend send no cleanup when cancellation wins ${phase}`,async()=>{
	const {InputCoordinator}=await import("../src/coordinator.ts"),{stripTypeScriptTypes}=await import("node:module");
	const source=readFileSync(new URL("../src/backend.ts",import.meta.url),"utf8"),pointerStart=source.indexOf("async pointer(app,"),keyStart=source.indexOf("async key(app,"),textStart=source.indexOf("async text(app,",keyStart);
	for(const kind of ["key","click","background-drag","real-drag"]){
		const stop=new AbortController(),{pointer,helper}=fixture("success"),original=helper.send.bind(helper),sent:Record<string,unknown>[]=[];
		helper.send=(c,ms,cancellable,record,dispatch)=>original(c,ms,cancellable,(row,context)=>{
			record?.(row,context);
			if(phase==="after-record-microtask")queueMicrotask(()=>stop.abort(new Error("cancel in persistence microtask")));
		},dispatch,phase==="before-permit"?()=>{queueMicrotask(()=>stop.abort(new Error("cancel in persistence microtask")));return Promise.resolve();}:undefined);
		let captured:PointerInputError|undefined;
		const proxy={send:async(c:Parameters<MacPointer["send"]>[0])=>{sent.push(c);try{return await pointer.send(c);}catch(error){assert.ok(error instanceof PointerInputError);captured=error;throw error;}}};
		const body=stripTypeScriptTypes(kind==="key"?`({${source.slice(keyStart,textStart)}}).key`:`({${source.slice(pointerStart,keyStart)}}).pointer`);
		const run=runInNewContext(body,{PointerInputError,interruptedPointer,interruptedInputTarget,macOnly:()=>{},macWindowNumber:async()=>({id:owner.window,bounds:owner.bounds}),options:{cursor:false},helper:()=>proxy}) as(...args:unknown[])=>Promise<void>;
		try{
			await assert.rejects(new InputCoordinator().run(stop.signal,()=>kind==="key"?run({...owner,name:"Own fixture"},{},"a",[],true):run({...owner,name:"Own fixture"},{},kind==="click"?{kind:"click",at:[10,20]}:{kind:"drag",from:[10,20],to:[299,399]},kind==="real-drag")),/cancel in persistence microtask/);
			assert.equal(captured?.inputMayHaveBeenSent,false);assert.deepEqual(sent.map(c=>c.op),[kind==="key"?"key":kind==="click"?"click":"drag"]);
			assert.equal(helper.pid,null);
		}finally{await pointer.close().catch(()=>{});}
	}
});

test("an authorized real drag cannot guess a global release when its helper disappears after permission",async()=>{
	const source=readFileSync(new URL("../src/backend.ts",import.meta.url),"utf8"),start=source.indexOf("async pointer(app,"),end=source.indexOf("async key(app,",start),{stripTypeScriptTypes}=await import("node:module");
	const failure=new PointerInputError(new Error("helper disappeared"),nativeCommandRoute(selected("drag"),{...command,op:"drag"}),true),sent:Record<string,unknown>[]=[];
	const run=runInNewContext(stripTypeScriptTypes(`({${source.slice(start,end)}}).pointer`),{PointerInputError,interruptedPointer,interruptedInputTarget,macOnly:()=>{},macWindowNumber:async()=>({id:owner.window,bounds:owner.bounds}),options:{cursor:false},helper:()=>({send:async(c:Record<string,unknown>)=>{sent.push(c);throw failure;}})}) as(...args:unknown[])=>Promise<void>;
	await assert.rejects(run({...owner,name:"Own fixture"},{},{kind:"drag",from:[10,20],to:[299,399]},true),error=>error===failure);
	assert.match(failure.message,/release is unverified/);assert.deepEqual(sent.map(c=>c.op),["drag"]);
});

function nativeProtocol(){
	const source=readFileSync(new URL("../src/pointer-mac.ts",import.meta.url),"utf8");
	const routeStart=source.indexOf("const ROUTED_OPS="),performStart=source.indexOf("function perform(c)",routeStart),performEnd=source.indexOf('let buffer = ""',performStart);
	const keysStart=source.indexOf("const inputKeys =");
	const dataStart=source.indexOf('implementation: n => {',source.indexOf('"onData:":')),dataEnd=source.indexOf('\n} } } });',dataStart);
	assert.ok(routeStart>0&&dataStart>performEnd&&dataEnd>dataStart);
	const effects:string[]=[],records:Record<string,unknown>[]=[],resolved:unknown[]=[],checks:unknown[]=[];
	let now=100,changed=false;
	const context={deadline:0,inputSent:false,inputPointer:null,monitorTimer:null,monitorFocus:null,guard:null,helperClosing:false,activeCommand:null,
		Date:{now:()=>now},checkGuard:()=>{},focus:()=>{effects.push("focus");},verifyKeyWindow:()=>{effects.push("key-ready");},
		windowRecord:(c:Record<string,unknown>)=>{checks.push(c);if(changed&&c.hostTarget)throw new Error("original remote receiver was replaced");},
		resolveInputTarget:(c:Record<string,unknown>)=>{resolved.push(c);return {...c,hostTarget:{...owner,inputAnchor:{retained:true}},...target};},
		reply:(record:Record<string,unknown>)=>records.push(JSON.parse(JSON.stringify(record))),think:()=>{},clipRestore:()=>{},
		input:{readInBackgroundAndNotify:undefined},handler:{},
		$:Object.assign((value:unknown)=>value,{NSString:{alloc:{initWithDataEncoding:(data:{text:string})=>({js:data.text})}},NSUTF8StringEncoding:4,
			NSTimer:{scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats:()=>null},exit:()=>{throw new Error("EOF-exit");}})
	};
	const finishStart=source.indexOf("function finishHelper()"),finishEnd=source.indexOf("ObjC.registerSubclass",finishStart);
	const api=runInNewContext(`(()=>{${source.slice(keysStart,performEnd)};let buffer="",idle=null,pendingCommand=null;${source.slice(finishStart,finishEnd)}const onData=${source.slice(dataStart+'implementation: '.length,dataEnd)}\n};return {send(c){const text=JSON.stringify(c)+'\\n';onData({userInfo:{objectForKey:()=>({length:text.length,text})}});},eof(){onData({userInfo:{objectForKey:()=>({length:0,text:''})}});}};})()`,context) as{send:(value:unknown)=>void;eof:()=>void};
	const request={...owner,op:"prepare_key",id:1,deadline:200,routeToken:"private-route-token-123456",cursor:false};
	const ack=(overrides:Record<string,unknown>={})=>{const record=records[0]!;api.send({op:"route_ack",id:1,routeToken:request.routeToken,route:record.route,...overrides});};
	return {api,effects,records,resolved,checks,request,ack,setTime:(time:number)=>{now=time;},replace:()=>{changed=true;}};
}

test("the production JXA path does no focus preparation until the exact route ACK",()=>{
	const f=nativeProtocol();f.api.send(f.request);
	assert.equal(f.records[0]!.kind,"input-route");assert.deepEqual(f.effects,[]);assert.equal(f.resolved.length,1);
	f.ack();assert.deepEqual(f.effects,["focus","key-ready"]);assert.equal(f.records.at(-1)!.ok,true);assert.equal(f.resolved.length,1,"ACK must not resolve a new renderer");
	f.ack();assert.equal(f.records.at(-1)!.ok,false);assert.deepEqual(f.effects,["focus","key-ready"],"duplicate ACK cannot execute again");
});

test("key releases cannot go to the user's newly foreground app or a reused PID",()=>{
	const source=readFileSync(new URL("../src/pointer-mac.ts",import.meta.url),"utf8"),from=source.indexOf("function releaseKey(e, c)"),to=source.indexOf("let mouseEventNumber",from);
	for(const front of [10,30])for(const recycled of [false,true]){
		const sent:string[]=[];
		const release=runInNewContext(`${source.slice(from,to)};releaseKey`,{inputSent:false,verifyProcess:()=>{if(recycled)throw new Error("process generation changed");},workspace:{frontmostApplication:{processIdentifier:front}},
			$:{CGEventPost:()=>sent.push("global"),kCGHIDEventTap:0},deliverRelease:()=>sent.push("original-target")}) as(e:unknown,c:unknown)=>void;
		if(recycled)assert.throws(()=>release({}, {...owner,foregroundAuthorized:true}),/generation/);
		else release({}, {...owner,foregroundAuthorized:true});
		assert.deepEqual(sent,recycled?[]:front===10?["global"]:["original-target"]);
	}
	const releaseCase=source.slice(source.indexOf('case "release_key": {'),source.indexOf('case "hover":'));
	assert.match(releaseCase,/releaseKey\(e,c\)/);assert.doesNotMatch(releaseCase,/CGEventPost\(/);
});

for(const variation of ["id","token","route","expired","replaced","eof"])
test(`the production JXA path rejects unsafe pending command: ${variation}`,()=>{
	const f=nativeProtocol();f.api.send(f.request);
	if(variation==="id")f.ack({id:2});
	if(variation==="token")f.ack({routeToken:"old-private-token"});
	if(variation==="route"){const route=structuredClone(f.records[0]!.route) as{target:{pid:number}};route.target.pid=30;f.ack({route});}
	if(variation==="expired"){f.setTime(201);f.ack();}
	if(variation==="replaced"){f.replace();f.ack();}
	if(variation==="eof")assert.throws(()=>f.api.eof(),/EOF-exit/);
	else assert.equal(f.records.at(-1)!.ok,false);
	assert.deepEqual(f.effects,[]);assert.equal(f.resolved.length,1);
});
