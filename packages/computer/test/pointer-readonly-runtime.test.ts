import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { promisify } from "node:util";
import { MacPointer } from "../src/pointer-mac.ts";
import type { JsonHelper } from "../src/helper.ts";

test("actual JXA can read hardware counters and allocate a separate private event source without posting input", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
	const source = readFileSync(new URL("../src/pointer-mac.ts", import.meta.url), "utf8");
	const start = source.indexOf("let realPointerSource=null;"), end = source.indexOf("function realPointerRelease", start);
	assert.ok(start > 0 && end > start);
	const script = `function run(){ObjC.import("CoreGraphics");return exercise($);function exercise(native){
const allowed=new Set(["CGEventSourceCreate","CGEventCreateMouseEvent","CGEventSourceCounterForEventType","CGEventSourceGetSourceStateID","CGEventGetType"]);
const $=new Proxy(value=>native(value),{get:(_target,name)=>{if(!allowed.has(name))throw new Error("unexpected API in read-only probe: "+name);return native[name];}});
const TYPES={down:1,up:2,rdown:3,rup:4,move:5,drag:6};
${source.slice(start, end)}
const before=realMouseHardwareSequence(),samples=[];
for(let i=0;i<30;i++){const start=Date.now();realMouseHardwareSequence();samples.push(Date.now()-start);}
const event=realPointerEvent("down",10,20),state=Number($.CGEventSourceGetSourceStateID(realPointerSource)),after=realMouseHardwareSequence();
return JSON.stringify({readOnly:true,postedEvents:0,counterTypes:REAL_MOUSE_HARDWARE_TYPES,validCounters:before.every(Number.isSafeInteger)&&after.every(Number.isSafeInteger),privateSourceState:state,allocatedEventType:Number($.CGEventGetType(event)),hardwareChangedDuringReads:before.some((value,index)=>value!==after[index]),samplesMs:samples});}}
`;
	const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 5000 });
	const result = JSON.parse(stdout) as { readOnly: boolean; postedEvents: number; counterTypes: number[]; validCounters: boolean; privateSourceState: number; allocatedEventType: number; hardwareChangedDuringReads: boolean; samplesMs: number[] };
	assert.equal(result.readOnly, true); assert.equal(result.postedEvents, 0); assert.equal(result.validCounters, true);
	assert.notEqual(result.privateSourceState, 0); assert.notEqual(result.privateSourceState, 1); assert.equal(result.allocatedEventType, 1); assert.equal(result.samplesMs.length, 30);
	t.diagnostic(JSON.stringify({ ...result, scope: "read-only hardware metadata and unposted event allocation; does not verify hardware counters during actual HID posting or global input ownership" }));
});

test("the complete bundled pointer program parses in actual JavaScriptCore without execution", { skip: process.platform !== "darwin", timeout: 8000 }, async () => {
	const pointer = new MacPointer(), helper = Reflect.get(pointer, "helper") as JsonHelper;
	try {
		const args = Reflect.get(helper, "args") as string[], index = args.indexOf("-e"); assert.ok(index > 0);
		const script = "function run(argv){new Function(argv[0]);return JSON.stringify({parsed:true,executed:false});}";
		const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, args[index + 1]!], { timeout: 5000 });
		assert.deepEqual(JSON.parse(stdout), { parsed: true, executed: false });
	} finally { await pointer.close(); }
});
