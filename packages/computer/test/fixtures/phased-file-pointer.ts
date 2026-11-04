import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MacPointer } from "../../src/pointer-mac.ts";
import type { PhasedPointerActor } from "../../src/pointer-lifecycle.ts";
import { foundationFileGesture } from "./jxa-file-gesture.ts";

/** Actual MacPointer/JsonHelper/private control pipe and production perform,
 * gesture finally and lifecycle handlers. Posts/global writes become private
 * file records. No AppKit/AX/CG or user's desktop/clipboard is accessed. */
export async function phasedFilePointer(log:string){
	const launch=await foundationFileGesture(log),index=launch.args.indexOf("-e");assert.ok(index>0);
	let program=launch.args[index+1]!;
	const source=readFileSync(new URL("../../src/pointer-mac.ts",import.meta.url),"utf8"),start=source.indexOf("const scopeTargets=new Set()"),end=source.indexOf("function finishHelper()",start),guardStart=source.indexOf("function finishGuard()"),guardEnd=source.indexOf("// Hardware input counts",guardStart);assert.ok(start>0&&end>start&&guardStart>0&&guardEnd>guardStart);
	const prelude='const out=$.NSFileHandle.fileHandleWithStandardOutput;';assert.equal(program.split(prelude).length,2);
	program=program.replace(prelude,prelude+String.raw`
const phaseNonce=ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("MOUNTAINS_POINTER_PHASED"));
const phasedInput=true;let globalFinishAllowed=false,monitorTimer=null,monitorFocus=null,saved=null,clipRestoreFailure=null;
const workspace={frontmostApplication:{processIdentifier:10}};
function focusedElement(){return null;}function userTookTarget(){return false;}function targetName(){return "own file receiver";}
function restoreFront(){record("global-front");}function restoreTypingFocus(){record("global-focus");}
`);
	const globals='let buffer="",idle=null,pendingCommand=null;';assert.equal(program.split(globals).length,2);program=program.replace(globals,globals+source.slice(guardStart,guardEnd)+source.slice(start,end).replace('lifetimeOriginal=Object.freeze','record("baseline");lifetimeOriginal=Object.freeze'));
	const monitor='}},"onProbeWatchdog:":';assert.equal(program.split(monitor).length,2);
	program=program.replace(monitor,'}},"onControl:":{types:["void",["id"]],implementation:n=>lifetimeControlData(n)},"onMonitor:":{types:["void",["id"]],implementation:()=>{}},"onProbeWatchdog:":');
	const read='input.readInBackgroundAndNotify;';assert.equal(program.split(read).length,3);const last=program.lastIndexOf(read);program=program.slice(0,last)+read+'startLifetimeControl();'+program.slice(last+read.length);
	// This new technical fixture deliberately holds Node AX for >2 seconds.
	// Its independent emergency exit is not an ordinary-action speed allowance.
	const watchdog='WithTimeIntervalTargetSelectorUserInfoRepeats(3,';assert.equal(program.split(watchdog).length,2);program=program.replace(watchdog,'WithTimeIntervalTargetSelectorUserInfoRepeats(8,');
	const pointer=new MacPointer(undefined,{phasedInput:true}),actor=Reflect.get(pointer,"phased") as PhasedPointerActor;
	const args=[...launch.args];args[index+1]=program;
	Reflect.set(actor.helper,"command",launch.command);Reflect.set(actor.helper,"args",args);
	return {pointer,actor,program};
}
