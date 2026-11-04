import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { foundationFileGesture } from "./jxa-file-gesture.ts";

/** Real JXA/Foundation runtime and command code. Quartz is replaced with JS
 * file writers before any command runs. AppKit and AX are never imported. */
export async function foundationFileKeyboard(log:string){
	const launch=await foundationFileGesture(log),index=launch.args.indexOf("-e");assert.ok(index>0);
	const source=readFileSync(new URL("../../src/pointer-mac.ts",import.meta.url),"utf8");
	const release=source.indexOf("function releaseKey(e, c)"),releaseEnd=source.indexOf("let mouseEventNumber",release);
	const menu=source.indexOf("let menuShortcutReady = null;"),menuEnd=source.indexOf("// Paste:",menu);
	assert.ok(release>0&&releaseEnd>release&&menuEnd>menu);
	let script=launch.args[index+1]!;
	const opening='function run(argv){ObjC.import("Foundation");ObjC.import("stdlib");';
	assert.ok(script.startsWith(opening));assert.ok(script.endsWith("}"));
	const shim=String.raw`
return exercise($,ObjC);
function exercise(native,bridge){
let thrown=false;
const ObjC={bindFunction:()=>{},registerSubclass:definition=>bridge.registerSubclass(definition)};
const emit=e=>{record((e.down?"down:":"up:")+e.key);if(e.down&&!thrown){thrown=true;throw new Error("file-only down post applied then failed");}};
const mocks={CGEventCreateKeyboardEvent:(_source,key,down)=>({key,down,flags:0}),
 CGEventSetFlags:(event,flags)=>{event.flags=flags;},CGEventSetType:()=>{},
 CGEventPostToPid:(_pid,event)=>emit(event),CGEventPostToPSN:(_psn,event)=>emit(event),
 GetProcessForPID:()=>0,AXUIElementCreateApplication:()=>null};
const $=new Proxy(value=>native(value),{get:(_target,name)=>{
 if(Object.prototype.hasOwnProperty.call(mocks,name))return mocks[name];
 if(typeof name==="string"&&/^(CGEvent|AXUIElement|_AX)/.test(name))throw new Error("unmocked input API is forbidden in this file-only probe");
 return native[name];
}});
const KEYS={a:0},FLAGS={Meta:0x100000,Shift:0x20000,Ctrl:0x40000,Alt:0x80000};
const workspace={frontmostApplication:{processIdentifier:30}};
function verifyProcess(){} function verifyKeyWindow(){} function rejectKnownPaymentReceiver(){}
function exactAXWindow(){return null;} function axAttribute(){return null;} function stamp(){} function focus(){}
function deliverRelease(event){emit(event);}
`;
	script=script.replace(opening,opening+shim);
	const insertion="let inputSent=false,inputPointer=null,guard=null,deadline=0,at=null,shownOn=-1;";
	assert.equal(script.split(insertion).length,2);
	script=script.replace(insertion,insertion+source.slice(release,releaseEnd)+source.slice(menu,menuEnd));
	script=script.slice(0,-1)+"}\n}";
	launch.args[index+1]=script;
	return launch;
}
