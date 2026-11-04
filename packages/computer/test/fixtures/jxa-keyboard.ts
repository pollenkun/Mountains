import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export interface KeyboardProbeOptions {
	wait?: "eof" | "error" | "other-front" | "new-birth";
	postThenThrow?: number;
	failUps?: number[];
	rejectBeforePost?: boolean;
}
export interface KeyEvent {route:string;target:number;key:number;down:boolean;flags:number}

/** Actual JXA command, routing, pair cleanup, PSN shortcut and releaseKey code.
 * Quartz/AX are array-only fakes. This never imports or runs native input APIs. */
export function keyboardProbe(options:KeyboardProbeOptions={}){
	const source=readFileSync(new URL("../../src/pointer-mac.ts",import.meta.url),"utf8");
	const keys=source.indexOf("const inputKeys ="),performEnd=source.indexOf('let buffer = ""',keys);
	const release=source.indexOf("function releaseKey(e, c)"),releaseEnd=source.indexOf("let mouseEventNumber",release);
	const menu=source.indexOf("let menuShortcutReady = null;"),menuEnd=source.indexOf("// Paste:",menu);
	const data=source.indexOf('implementation: n => {',source.indexOf('"onData:":')),dataEnd=source.indexOf('\n} } } });',data);
	assert.ok(keys>0&&performEnd>keys&&release>0&&releaseEnd>release&&menuEnd>menu&&dataEnd>data);
	const events:KeyEvent[]=[],attempts:KeyEvent[]=[],held=new Set<number>(),records:Record<string,unknown>[]=[],checkedBirths:string[]=[];
	let front=10,birth="original",waitHandled=false,postThrew=false,sequence=0;
	const verifyProcess=(command:{pid:number;instance:string})=>{
		checkedBirths.push(command.instance+"/"+birth);
		if(command.pid!==10||command.instance!==birth)throw new Error("original process generation changed");
	};
	const post=(route:string,target:number,event:{key:number;down:boolean;flags:number})=>{
		const copy={route,target,key:event.key,down:event.down,flags:event.flags};attempts.push(copy);
		if(!event.down&&options.failUps?.includes(event.key))throw new Error("injected up failed for "+event.key);
		events.push(copy);if(event.down)held.add(event.key);else held.delete(event.key);
		if(event.down&&options.postThenThrow===event.key&&!postThrew){postThrew=true;throw new Error("post applied down then threw");}
	};
	const receiver={};
	const context:Record<string,unknown>={helperClosing:false,activeCommand:null,deadline:0,inputSent:false,inputPointer:null,at:null,shownOn:-1,
		KEYS:{a:0,Enter:36},FLAGS:{Meta:0x100000,Shift:0x20000,Ctrl:0x40000,Alt:0x80000},
		workspace:{get frontmostApplication(){return {processIdentifier:front};}},
		checkGuard:()=>{if(context.helperClosing)throw new Error("controller closed");},
		verifyProcess,verifyKeyWindow:()=>{},rejectKnownPaymentReceiver:()=>{},verifyReceiver:()=>receiver,
		windowRecord:()=>{},resolveInputTarget:(command:unknown)=>command,focus:()=>{},exactAXWindow:()=>null,axAttribute:()=>null,
		stamp:(_event:unknown,command:{pid:number;instance:string})=>{verifyProcess(command);if(options.rejectBeforePost)throw new Error("validation refused before down");},
		deliverRelease:(event:{key:number;down:boolean;flags:number},command:{pid:number;instance:string})=>{verifyProcess(command);post("PID-cleanup",command.pid,event);},
		reply:(record:Record<string,unknown>)=>records.push(JSON.parse(JSON.stringify(record))),think:()=>{},finishHelper:()=>{},
		wait:()=>{if(waitHandled)return;waitHandled=true;
			if(options.wait==="eof")context.helperClosing=true;
			if(options.wait==="error")throw new Error("injected RunLoop exception");
			if(options.wait==="other-front")front=30;
			if(options.wait==="new-birth")birth="replacement";
		},
		input:{readInBackgroundAndNotify:undefined},handler:{},ObjC:{bindFunction:()=>{}},
		$:Object.assign((value:unknown)=>({dataUsingEncoding:()=>({bytes:value})}),{
			NSString:{alloc:{initWithDataEncoding:(value:{text:string})=>({js:value.text})}},NSUTF8StringEncoding:4,NSUTF16LittleEndianStringEncoding:0x14000100,
			NSProcessInfo:{processInfo:{processIdentifier:999}},NSTimer:{scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats:()=>null},
			CFEqual:(a:unknown,b:unknown)=>a===b,AXUIElementCreateApplication:()=>null,
			NSMutableData:{dataWithLength:()=>({mutableBytes:{pid:0}})},GetProcessForPID:(pid:number,target:{pid:number})=>{target.pid=pid;return 0;},
			CGEventCreateKeyboardEvent:(_source:unknown,key:number,down:boolean)=>({key,down,flags:0}),
			CGEventSetFlags:(event:{flags:number},flags:number)=>{event.flags=flags;},CGEventSetType:()=>{},CGEventKeyboardSetUnicodeString:()=>{},
			CGEventPostToPid:(pid:number,event:{key:number;down:boolean;flags:number})=>post("PID",pid,event),
			CGEventPostToPSN:(target:{pid:number},event:{key:number;down:boolean;flags:number})=>post("PSN",target.pid,event),
			CGEventPost:(_tap:unknown,event:{key:number;down:boolean;flags:number})=>post("HID",front,event),
		})
	};
	const api=runInNewContext(`(()=>{${source.slice(release,releaseEnd)};${source.slice(menu,menuEnd)};${source.slice(keys,performEnd)};let buffer='',idle=null,pendingCommand=null;const onData=${source.slice(data+'implementation: '.length,dataEnd)}\n};return {send(command){const text=JSON.stringify(command)+'\\n';onData({userInfo:{objectForKey:()=>({length:text.length,text})}});}};})()`,context) as {send(command:Record<string,unknown>):void};
	return {events,attempts,held,records,checkedBirths,
		send(op:"key"|"text"|"type_focus"|"ping",heldModifiers:string[]=[],foreground=false){
			const id=++sequence,command={id,op,pid:10,instance:"original",window:100,bounds:{x:0,y:0,width:300,height:300},key:"a",text:"你好 🌍",held:heldModifiers,foregroundAuthorized:foreground||op==="type_focus",cursor:false,routeToken:"own-keyboard-fixture-route-123"};
			api.send(command);
			const route=records.at(-1)!;
			if(route.kind==="input-route")api.send({op:"route_ack",id,routeToken:command.routeToken,route:route.route});
			return records.at(-1)!;
		}
	};
}
