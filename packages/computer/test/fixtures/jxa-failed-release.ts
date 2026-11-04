import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** Actual production perform/onData catch, with file-free fake mouse posting.
 * Its original-target mouse-up throws. Nothing imports AppKit or sends input. */
export function productionPointerReleaseFailure():Record<string,unknown>{
	const source=readFileSync(new URL("../../src/pointer-mac.ts",import.meta.url),"utf8");
	const routeStart=source.indexOf("const ROUTED_OPS="),performEnd=source.indexOf('let buffer = ""',routeStart);
	const keysStart=source.indexOf("const inputKeys =");
	const dataStart=source.indexOf('implementation: n => {',source.indexOf('"onData:":')),dataEnd=source.indexOf('\n} } } });',dataStart);
	assert.ok(routeStart>0&&performEnd>routeStart&&dataStart>performEnd&&dataEnd>dataStart);
	const records:Record<string,unknown>[]=[];let api:{send(command:Record<string,unknown>):void;beginPointer:(...args:unknown[])=>unknown};
	const context:Record<string,unknown>={helperClosing:false,activeCommand:null,deadline:0,inputSent:false,inputPointer:null,at:null,shownOn:-1,
		checkGuard:()=>{},windowRecord:()=>{},resolveInputTarget:(command:unknown)=>command,think:()=>{},wait:()=>{},finishHelper:()=>{},
		reply:(record:Record<string,unknown>)=>records.push(JSON.parse(JSON.stringify(record))),input:{readInBackgroundAndNotify:undefined},handler:{},
		$:Object.assign((value:unknown)=>value,{NSString:{alloc:{initWithDataEncoding:(data:{text:string})=>({js:data.text})}},NSUTF8StringEncoding:4,NSTimer:{scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats:()=>null}})};
	context.mouse=(_command:unknown,_kind:string,x:number,y:number,_count:number,cleanup:boolean)=>{
		if(cleanup)throw new Error("injected original-target up failed");
		if(_kind==="down")api.beginPointer(_command,_kind,x,y,1,"pid");
		context.inputSent=true;context.inputPointer={x,y,button:"left",released:false};
	};
	api=runInNewContext(`(()=>{${source.slice(keysStart,performEnd)};let buffer='',idle=null,pendingCommand=null;const onData=${source.slice(dataStart+'implementation: '.length,dataEnd)}\n};return {beginPointer,send(c){const text=JSON.stringify(c)+'\\n';onData({userInfo:{objectForKey:()=>({length:text.length,text})}});}};})()`,context) as typeof api;
	const command={op:"drag",id:1,pid:10,instance:"1",window:100,bounds:{x:0,y:0,width:300,height:300},x:10,y:20,x2:130,y2:140,cursor:false,routeToken:"own-release-failure-route-123"};
	api.send(command);api.send({op:"route_ack",id:1,routeToken:command.routeToken,route:records[0]!.route});
	const result=records.at(-1)!;
	assert.equal(result.ok,false);assert.equal(result.inputSent,true);assert.equal((result.inputPointer as Record<string,unknown>).released,false);assert.match(String(result.error),/original-target up failed/);
	return result;
}
