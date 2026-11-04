import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { parseAppLaunchReceipt, requiresManagedChromeLaunch, MANAGED_CHROME_LAUNCH_MESSAGE, type AppLaunchReceipt } from "../src/launcher-mac.ts";

const receipt: AppLaunchReceipt = {pid:123,gaveBack:1,frontTaken:1,restoreRequests:1,returnFailed:false,watchStopped:null};
const output = (value: unknown) => JSON.stringify({pid:123}) + "\n" + JSON.stringify(value) + "\n";

test("launch receipt retains a foreground interruption even when restoration succeeded", () => {
	assert.deepEqual(parseAppLaunchReceipt(output(receipt)),receipt);
});

test("launch receipt preserves the original window and distinguishes key attempts from complete pairs", () => {
	const diagnostics={...receipt,originalWindow:456,keyRestoreRequests:2,keyRestorePairsSent:1};
	assert.deepEqual(parseAppLaunchReceipt(output(diagnostics)),diagnostics);
});

test("optional key-window diagnostics reject a present invalid value", () => {
	for(const field of ["originalWindow","keyRestoreRequests","keyRestorePairsSent"]){
		assert.throws(()=>parseAppLaunchReceipt(output({...receipt,[field]:-1})),/final foreground report is missing or invalid/);
	}
});

for (const value of [undefined,{pid:123},{...receipt,frontTaken:-1},{...receipt,gaveBack:"1"},{...receipt,pid:0},{...receipt,returnFailed:"false"},{...receipt,watchStopped:undefined}]) {
	test("launch receipt rejects missing or malformed final evidence: " + JSON.stringify(value), () => {
		assert.throws(()=>parseAppLaunchReceipt(output(value)),/final foreground report is missing or invalid; do not launch it again/);
	});
}

test("an earlier valid receipt cannot hide a truncated or invalid last line", () => {
	assert.throws(()=>parseAppLaunchReceipt(output(receipt)+"{\"pid\":"),/final foreground report is missing or invalid/);
});

// Exercise the actual backend method with a file-only command boundary. No AppKit,
// osascript, GUI app, or bundled launcher is executed by this test.
const backend = readFileSync(new URL("../src/backend.ts",import.meta.url),"utf8");
const from = backend.indexOf("async launch(name) {"), to = backend.indexOf("async pointer(",from);
assert.ok(from>0&&to>from);
function backendLaunch(stdout: string, commands: unknown[][], bundleId = "dev.own.app") {
	return runInNewContext(stripTypeScriptTypes(`({${backend.slice(from,to)}}).launch`),{
		process:{platform:"darwin"},currentInput:()=>({check(){}}),
		resolveInstalledApp:async()=>({bundleId,path:"/Applications/Own.app"}),
		appLauncher:()=>"/own/launch-app",parseAppLaunchReceipt,requiresManagedChromeLaunch,MANAGED_CHROME_LAUNCH_MESSAGE,
		scopedCommand:async(...args:unknown[])=>{commands.push(args);return {stdout};},
	}) as (name:string)=>Promise<{bundleId:string;launchReceipt:AppLaunchReceipt}>;
}

test("backend launch returns the final receipt alongside its existing bundle identity", async () => {
	const commands: unknown[][] = [], result = await backendLaunch(output(receipt),commands)("Own");
	assert.equal(result.bundleId,"dev.own.app");
	assert.deepEqual(result.launchReceipt,receipt);
	assert.equal(JSON.stringify(commands),JSON.stringify([["/own/launch-app",["--watch","2","/Applications/Own.app"],20_000]]));
});

test("direct Chrome startup is refused before invoking a launcher, without treating Electron as Chrome", async () => {
	for (const id of ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "com.google.chrome.for.testing", "org.chromium.Chromium"]) {
		const commands: unknown[][] = [];
		await assert.rejects(backendLaunch(output(receipt),commands,id)("Chrome"), /use web_read/);
		assert.equal(commands.length,0);
	}
	for (const id of [undefined,"com.github.Electron","com.microsoft.VSCode","com.tinyspeck.slackmacgap","com.google.Chrome.helper","com.google.Chrome.fake"]) assert.equal(requiresManagedChromeLaunch(id),false);
});

test("backend launch refuses success when only the initial PID arrived", async () => {
	const commands: unknown[][] = [];
	await assert.rejects(backendLaunch('{"pid":123}\n',commands)("Own"),/final foreground report is missing or invalid/);
	assert.equal(commands.length,1,"uncertain startup must not cause another launch");
});
