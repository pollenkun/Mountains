import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MacPointer } from "../../src/pointer-mac.ts";
import type { JsonHelper } from "../../src/helper.ts";

/** Real Foundation notifications and production command code. No AppKit, AX,
 * global input, or real event posting: mouse() writes only the caller's file. */
export async function foundationFileGesture(log:string,faults:{downThenThrowAt?:number;dragThenThrowAt?:number;failUp?:boolean}={}):Promise<{command:string;args:string[]}>{
	const source=readFileSync(new URL("../../src/pointer-mac.ts",import.meta.url),"utf8"),pointer=new MacPointer();
	const helper=Reflect.get(pointer,"helper") as JsonHelper,args=[...Reflect.get(helper,"args") as string[]],command=Reflect.get(helper,"command") as string;
	await pointer.close();
	const replyStart=source.indexOf("let helperClosing = false"),replyEnd=source.indexOf("const primaryHeight",replyStart),guardStart=source.indexOf("function checkGuard()"),routeStart=source.indexOf("const ROUTED_OPS="),performEnd=source.indexOf('let buffer = ""',routeStart),finishStart=source.indexOf("function finishHelper()"),finishEnd=source.indexOf("ObjC.registerSubclass",finishStart),dataStart=source.indexOf('implementation: n => {',source.indexOf('"onData:":')),dataEnd=source.indexOf('\n} } } });',dataStart),mouseStart=source.indexOf("let mouseEventNumber"),mouseEnd=source.indexOf("function realPointerLocation",mouseStart);
	for(const index of [replyStart,replyEnd,guardStart,routeStart,performEnd,finishStart,finishEnd,dataStart,dataEnd])assert.ok(index>0);
	const finish=source.slice(finishStart,finishEnd);assert.ok(finish.includes("$.exit(status);"));
	const callback=source.slice(dataStart+'implementation: '.length,dataEnd),eof="helperClosing=true;pendingCommand=null;if(!activeCommand)finishHelper();return;";
	assert.ok(callback.includes(eof));
	const script=String.raw`function run(argv){ObjC.import("Foundation");ObjC.import("stdlib");
const out=$.NSFileHandle.fileHandleWithStandardOutput;
const log=$.NSFileHandle.fileHandleForWritingAtPath($(argv[0]));
function record(kind){log.seekToEndOfFile;log.writeData($(kind+"\n").dataUsingEncoding($.NSUTF8StringEncoding));}
`+source.slice(replyStart,replyEnd)+String.raw`
let inputSent=false,inputPointer=null,guard=null,deadline=0,at=null,shownOn=-1;
function monitorState(){} function observeActivation(){} function windowRecord(){}
function resolveInputTarget(c){return Object.assign({},c,{nativeEvents:{down:"down",up:"up",drag:"drag",rdown:"rdown",rup:"rup",move:"move"}});} function think(){} function clipRestore(){record("restore");}
const wait=seconds=>$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
const TYPES={down:1,up:2,rdown:3,rup:4,move:5,drag:6};function held(){return 0;}function stamp(){}
`+"const fileMouseFaults="+JSON.stringify(faults)+String.raw`;let fileMouseDowns=0,fileMouseDrags=0;
const fileMouseAPI={NSData:{alloc:{initWithBase64EncodedStringOptions:value=>({kind:String(value.js)})}},
 CGEventCreateFromData:(_source,data)=>({type:TYPES[data.kind],kind:data.kind}),CGEventCreateMouseEvent:(_source,type)=>({type,kind:Object.keys(TYPES).find(kind=>TYPES[kind]===type)}),
 CGEventGetType:event=>event.type,CGEventSetIntegerValueField:()=>{},CGEventSetTimestamp:()=>{},CGEventSetLocation:()=>{},CGEventSetFlags:()=>{},
 NSProcessInfo:{processInfo:{systemUptime:100}},CGEventPostToPid:(_pid,event)=>{
  if((event.kind==="up"||event.kind==="rup")&&fileMouseFaults.failUp)throw new Error("file-only mouse up failed");
  record(event.kind);
  if((event.kind==="down"||event.kind==="rdown")&&++fileMouseDowns===fileMouseFaults.downThenThrowAt)throw new Error("file-only down post applied then failed");
  if(event.kind==="drag"&&++fileMouseDrags===fileMouseFaults.dragThenThrowAt)throw new Error("file-only drag post applied then failed");
 }};
function fileMouseRelease(event,c){inputSent=true;fileMouseAPI.CGEventPostToPid(c.pid,event);}
`+source.slice(mouseStart,mouseEnd).replace("let mouseEventNumber = 0, inputPointer = null;","let mouseEventNumber = 0;").replace(/\$\./g,"fileMouseAPI.").replace("deliverRelease(e, c, x, y)","fileMouseRelease(e, c, x, y)")+source.slice(guardStart,routeStart)+source.slice(routeStart,performEnd)+String.raw`
let buffer="",idle=null,pendingCommand=null;
`+finish.replace("$.exit(status);",'record("helper-exit:"+status);$.exit(status);')+String.raw`
ObjC.registerSubclass({name:"MountainsOwnEOFFileProbe",methods:{"onData:":{types:["void",["id"]],implementation:
`+callback.replace(eof,'record("controller-eof");'+eof)+String.raw`
}},"onProbeWatchdog:":{types:["void",["id"]],implementation:()=>{record("watchdog-exit:124");$.exit(124);}}}});
const handler=$.MountainsOwnEOFFileProbe.alloc.init;
const input=$.NSFileHandle.fileHandleWithStandardInput;
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(handler,"onData:","NSFileHandleReadCompletionNotification",input);
$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(3,handler,"onProbeWatchdog:",$(),false);
input.readInBackgroundAndNotify;
$.NSRunLoop.currentRunLoop.run;
}`;
	const program=args.indexOf("-e");assert.ok(program>0);args[program+1]=script;args.push(log);
	return {command,args};
}
