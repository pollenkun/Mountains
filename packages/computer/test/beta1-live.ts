// Real-desktop check for Computer-use Beta 1. Run only when nobody is using the Mac:
//   MOUNTAINS_BETA1_LIVE=1 node packages/computer/test/beta1-live.ts
// It starts two disposable apps of its own (test/fixtures/beta1-apps.swift) and, when Chrome is installed, one
// Chrome window with a throwaway profile. Set MOUNTAINS_BETA1_ELECTRON_APP to an official Electron.app bundle
// to run the same web checks in a disposable minimal Electron app. The witness app sits in front; every lost activation, lost key window
// and other app activation it records counts as a focus steal. Nothing else on the desktop is operated.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { FileStateTracker, Workspace, type ToolContext, type ToolDefinition, type ToolResult } from "@mountains/tools";
import { createComputerTools, xa11yDesktop } from "../src/index.ts";
import { MacWindowServer } from "../src/window-server-mac.ts";
import { MacCapture } from "../src/capture-mac.ts";
import { appLauncher } from "../src/launcher-mac.ts";
import { WebBrowser, createWebTools } from "../src/web.ts";

if (process.env.MOUNTAINS_BETA1_LIVE !== "1") { console.error("Set MOUNTAINS_BETA1_LIVE=1 to run this real-desktop check."); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), "mountains-beta1-live-"));
const apps = join(root, "beta1-apps"), children: ChildProcess[] = [];
execFileSync("xcrun", ["swiftc", "-O", "-swift-version", "5", fileURLToPath(new URL("./fixtures/beta1-apps.swift", import.meta.url)), "-o", apps], { stdio: "inherit" });
const stamp = Date.now().toString(36);
const state = (name: string) => JSON.parse(readFileSync(join(root, `${name}.json`), "utf8")) as Record<string, unknown>;
async function start(mode: "witness" | "target"): Promise<number> {
	const child = spawn(apps, [mode, join(root, `${mode}.json`), `Beta1 ${mode} ${stamp}`], { stdio: ["pipe", "ignore", "inherit"] });
	children.push(child);
	for (const until = Date.now() + 10_000; Date.now() < until; await delay(100)) if (existsSync(join(root, `${mode}.json`))) return child.pid!;
	throw new Error(`${mode} app did not start`);
}
const ctx = (): ToolContext => ({ workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "live", approve: async () => "deny" });
const execAsync = promisify(execFile);
const timed = async (run: () => Promise<ToolResult>) => { const started = performance.now(); const result = await run(); return { result, ms: performance.now() - started }; };
// Every tool call is logged and bounded, so a hang names its step instead of stalling the whole check.
const startedAt = Date.now();
const step = async <T,>(label: string, run: () => Promise<T>, limitMs = 60_000): Promise<T> => {
	const started = Date.now(); console.error(`… ${new Date().toISOString().slice(11, 23)} ${label}`);
	const timeout = new AbortController();
	try {
		return await Promise.race([run().then(value => { console.error(`✓ ${label} ${Date.now() - started} ms`); return value; }),
			delay(limitMs, undefined, { signal: timeout.signal }).then(() => { throw new Error(`step timed out after ${limitMs / 1000} s: ${label}`); })]);
	} finally { timeout.abort(); }
};
const quantile = (values: number[], q: number) => Math.round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!);
const p95 = (values: number[]) => quantile(values, 0.95);
const report: Record<string, unknown> = {};
const desktop = await xa11yDesktop({ cursor: true });
const pointerInputs: { pid: number | null; gesture: unknown }[] = [];
const sendPointer = desktop.pointer.bind(desktop);
desktop.pointer = async (app, window, gesture, authorized) => {
	pointerInputs.push({ pid: app.pid, gesture });
	return sendPointer(app, window, gesture, authorized);
};
let chromeProfile: string | undefined;
let chromeBrowser: WebBrowser | undefined;
const webPids: number[] = [];
type WitnessState = { pid: number; active: boolean; key: boolean; fieldFocused: boolean; resignActive: number; resignKey: number; otherActivations: { at: number; pid: number; name: string }[]; events: { at: number; event: string }[] };
const witness = () => state("witness") as unknown as WitnessState;
const focusChange = (before: WitnessState, after: WitnessState) => ({
	resignActive: after.resignActive - before.resignActive, resignKey: after.resignKey - before.resignKey,
	otherActivations: after.otherActivations.slice(before.otherActivations.length),
	witnessActiveBefore: before.active, witnessActiveAfter: after.active, keyBefore: before.key, keyAfter: after.key, fieldFocusedAfter: after.fieldFocused,
});
type WindowInfo = { id: number; pid: number; layer: number; alpha: number; bounds: { X: number; Y: number; Width: number; Height: number } };
function windowSnapshot(): { frontPid: number; windows: WindowInfo[] } {
	return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit");ObjC.import("CoreGraphics");const windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17,0)));JSON.stringify({frontPid:Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),windows:windows.map(w=>({id:w.kCGWindowNumber,pid:w.kCGWindowOwnerPID,layer:w.kCGWindowLayer,alpha:w.kCGWindowAlpha,bounds:w.kCGWindowBounds}))})`], { encoding: "utf8", timeout: 10_000 }));
}
function coverage(windowId: number, witnessPid: number) {
	const snapshot = windowSnapshot(), targetIndex = snapshot.windows.findIndex(w => w.id === windowId);
	const witnessIndex = snapshot.windows.findIndex(w => w.pid === witnessPid && w.layer === 0);
	const target = snapshot.windows[targetIndex], cover = snapshot.windows[witnessIndex];
	const a = target?.bounds, b = cover?.bounds;
	const fullyCovered = !!a && !!b && cover.alpha === 1 && witnessIndex >= 0 && witnessIndex < targetIndex &&
		b.X <= a.X && b.Y <= a.Y && b.X + b.Width >= a.X + a.Width && b.Y + b.Height >= a.Y + a.Height;
	return { fullyCovered, frontPid: snapshot.frontPid, targetIndex, witnessIndex, target, cover };
}
type PageReceipt = { heading: string; clicks: number; trusted: boolean | null; revision: number; hasFocus: boolean; visibility: string; events: string[] };
const pageReceipts = new Map<string, PageReceipt>();
// The test page reports its own DOM state independently of screen_act's claimed result.
const pageServer = createServer(async (request, response) => {
	const key = request.url?.split("/")[1] ?? "";
	if (!["chrome", "electron"].includes(key)) { response.writeHead(404).end(); return; }
	if (request.method === "POST" && request.url === `/${key}/state`) {
		let body = "";
		for await (const chunk of request) { body += String(chunk); if (body.length > 16_384) { response.writeHead(413).end(); return; } }
		try {
			const receipt = JSON.parse(body) as PageReceipt;
			if (typeof receipt.heading !== "string" || typeof receipt.clicks !== "number" || typeof receipt.revision !== "number") throw new Error("invalid page receipt");
			if (receipt.revision > (pageReceipts.get(key)?.revision ?? -1)) pageReceipts.set(key, receipt);
			response.writeHead(204).end();
		} catch { response.writeHead(400).end(); }
		return;
	}
	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(`<!doctype html><title>Beta1 web ${key} ${stamp}</title><h1>Beta1 page</h1><button>Visible button</button><script>
	let clicks = 0, trusted = null, revision = 0; const events = [];
	function report() { fetch('/${key}/state', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({heading:document.querySelector('h1').textContent,clicks,trusted,revision:++revision,hasFocus:document.hasFocus(),visibility:document.visibilityState,events:events.slice(-12)})}); }
	document.querySelector('button').addEventListener('click', event => { document.querySelector('h1').textContent = 'Clicked'; clicks++; trusted = event.isTrusted; events.push('click'); report(); });
	for (const name of ['pointerdown','mousedown','pointerup','mouseup']) document.querySelector('button').addEventListener(name, () => { events.push(name); report(); });
	report();
	</script>`);
});
await new Promise<void>(resolve => pageServer.listen(0, "127.0.0.1", resolve));
const pageBase = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}`;

try {
	const targetPid = await start("target");
	await delay(800);
	const witnessPid = await start("witness");
	for (const until = Date.now() + 5_000; Date.now() < until && state("witness").active !== true; ) await delay(100);
	assert.equal(state("witness").active, true, "the witness app must be in front before measuring");
	const measurementStartedAt = Date.now(), before = witness();
	assert.equal(before.key, true, "the witness window must own the keyboard before measuring");
	assert.equal(before.fieldFocused, true, "the witness text field must be focused before measuring");
	const tools = Object.fromEntries(createComputerTools({ desktop: async () => desktop, apps: { "beta1-apps": "act", "Google Chrome": "act", Electron: "act" }, consent: { granted: true }, excludePids: [process.pid], imageInput: true }).map(t => [t.name, t])) as Record<string, ToolDefinition>;
	const focusSteps: { label: string; startedAt: number; endedAt: number; keyboardException: boolean; change: ReturnType<typeof focusChange> }[] = [];
	for (const [name, tool] of Object.entries(tools)) {
		const execute = tool.execute.bind(tool);
		tools[name] = { ...tool, execute: async (args, c) => {
			const label = `${name} ${JSON.stringify(args).slice(0, 80)}`, startedAt = Date.now(), before = witness();
			try { return await step(label, () => execute(args, c)); }
			finally { focusSteps.push({ label, startedAt, endedAt: Date.now(), keyboardException: name === "screen_act" && (args.action === "select" || args.action === "menubar"), change: focusChange(before, witness()) }); }
		} };
	}
	const app = String(targetPid), mainTitle = `Beta1 target ${stamp}`;
	// The target has a second, minimized window: pick the main one by its title.
	const listing = await tools.screen_read!.execute({ app }, ctx());
	const handle = /^Choose window/.test(listing.modelContent) ? listing.modelContent.split("\n").find(line => line.endsWith(JSON.stringify(mainTitle)))?.split(" ")[0] : String(listing.details?.window);
	assert.ok(handle, listing.modelContent);
	report.offscreenListed = /Not on this screen: [^\n]*spare[^\n]*minimized/.test(listing.modelContent);

	// 1. Hot reads.
	const reads: number[] = [];
	let read = await tools.screen_read!.execute({ app, window: handle }, ctx());
	assert.equal(read.ok, true, read.modelContent);
	for (let i = 0; i < 10; i++) { const r = await timed(() => tools.screen_read!.execute({ app, window: handle, full: true }, ctx())); assert.equal(r.result.ok, true, r.result.modelContent); reads.push(r.ms); read = r.result; }
	report.read = { samples: reads.length, p50: quantile(reads, 0.5), p95: p95(reads) };

	// 2. Window images: WindowServer copy versus the ScreenCaptureKit stream, same window.
	const server = await MacWindowServer.open(), windowId = Number(String(read.details?.window).replace(/^w:/, ""));
	const hardware: number[] = [], stream: number[] = [];
	for (let i = 0; i < 10; i++) { const s = performance.now(); assert.ok(await server.capture(windowId, join(root, `hw${i}.png`)), "hardware capture returned no image"); hardware.push(performance.now() - s); }
	const sck = await MacCapture.open();
	if (sck) { for (let i = 0; i < 10; i++) { const s = performance.now(); await sck.frame(windowId, join(root, `sck${i}.png`)); stream.push(performance.now() - s); } await sck.close(); }
	await server.close();
	report.capture = { hardwareP95: p95(hardware), streamP95: stream.length ? p95(stream) : null };
	const look = await timed(() => tools.screen_look!.execute({ app, window: handle }, ctx()));
	report.look = { ok: look.result.ok, ms: look.ms };

	// 3. Native popup in the background.
	const popupId = read.modelContent.match(/(e\d+) (?:pop_up_button|combo_box) "Size"/)?.[1];
	assert.ok(popupId, read.modelContent);
	const choose = await timed(() => tools.screen_act!.execute({ app, window: handle, action: "select", id: popupId, text: "Large" }, ctx()));
	report.popup = { outcome: choose.result.details?.outcome, ms: choose.ms, appSays: state("target").size, note: /held the keyboard[^.]*\./.exec(choose.result.modelContent)?.[0] ?? null };

	// 4. Typing into a background field, one step and as steps.
	read = await tools.screen_read!.execute({ app, window: handle, full: true }, ctx());
	const fieldId = read.modelContent.match(/(e\d+) text_field/)?.[1];
	assert.ok(fieldId, read.modelContent);
	const typing = await timed(() => tools.screen_act!.execute({ app, window: handle, steps: [{ action: "focus", id: fieldId }, { action: "type", id: fieldId, text: "Beta1 你好 🌍" }] }, ctx()));
	report.type = { outcome: typing.result.details?.outcome, ms: typing.ms, appSays: state("target").text };

	// 6. This app's own menu bar item, chosen in the background.
	const bar = await tools.screen_read!.execute({ menubar: true }, ctx());
	const itemId = bar.modelContent.split("\n").find(line => line.includes(`Beta1 status ${mainTitle}`) || line.includes(`pid ${targetPid})`))?.split(" ")[0];
	if (!itemId) report.menubar = { skipped: "this app's status item was not listed", listed: bar.modelContent.split("\n").length - 1 };
	else {
		const menu = await timed(() => tools.screen_act!.execute({ app, action: "menubar", id: itemId }, ctx()));
		const picked = await timed(() => tools.screen_act!.execute({ app, action: "menubar", id: itemId, text: "Beta1 Option B" }, ctx()));
		report.menubar = { readMenuOk: menu.result.ok, chooseOk: picked.result.ok, readMenu: menu.result.details?.outcome, menuMs: menu.ms, listsOptions: /Beta1 Option A/.test(menu.result.modelContent), chose: picked.result.details?.outcome, chooseMs: picked.ms, appSays: state("target").status };
	}

	// 7. A save panel takes a whole path.
	read = await tools.screen_read!.execute({ app, window: handle, full: true }, ctx());
	const saveButton = read.modelContent.match(/(e\d+) button "Save…"/)?.[1];
	assert.ok(saveButton, read.modelContent);
	const openSave = await tools.screen_act!.execute({ app, window: handle, action: "press", id: saveButton }, ctx());
	await delay(800);
	const target = join(root, "saved-beta1.txt");
	const withSheet = await tools.screen_read!.execute({ app }, ctx());
	const sheet = withSheet.modelContent.split("\n").filter(line => /^w:/.test(line)).map(line => line.split(" ")[0]!).find(h => h !== handle && !/spare/.test(withSheet.modelContent.split("\n").find(l => l.startsWith(h)) ?? ""));
	if (!sheet) report.savePanel = { skipped: "no panel window appeared", listing: withSheet.modelContent.slice(0, 300) };
	else {
		const panel = await tools.screen_read!.execute({ app, window: sheet, full: true }, ctx());
		// The fixture opens its panel in this run's own folder; a whole path is refused there (no path field on
		// macOS 26), so the bare name is given, and the result is checked on disk.
		const whole = await tools.screen_act!.execute({ app, window: sheet, action: "file_path", text: target }, ctx());
		const afterWhole = await tools.screen_read!.execute({ app, window: sheet, full: true }, ctx());
		const filled = await timed(() => tools.screen_act!.execute({ app, window: sheet, action: "file_path", text: "saved-beta1.txt", press: true }, ctx()));
		await delay(800);
		const pressed = filled.result.details;
		const filenameLine = (result: ToolResult) => result.modelContent.split("\n").find(line => /text_field/.test(line) && /Untitled(?:\.txt)?/.test(line))?.replace(/\be\d+\b/, "element");
		const originalName = filenameLine(panel), nameAfterRefusal = filenameLine(afterWhole);
		const nameStillUntouched = !!originalName && nameAfterRefusal === originalName;
		report.savePanel = { openOk: openSave.ok, wholePathRefusedUntouched: whole.ok === false && /nothing was typed/.test(whole.modelContent) && nameStillUntouched, nameStillUntouched, originalName, nameAfterRefusal, fillOk: filled.result.ok, fieldsFound: /PathTextField|saveAsNameTextField/.test(JSON.stringify(panel.details)) || filled.result.ok, filled: filled.result.details?.outcome, fillMs: filled.ms, error: filled.result.details?.error ?? null,
			pressed: /Save button was pressed/.test(filled.result.modelContent), outcome: pressed?.outcome, appSaved: state("target").saved, expected: target, onDisk: existsSync(target), contentOnDisk: existsSync(target) ? readFileSync(target, "utf8") : null };
	}

	// 8. The minimized window comes back without activating the app.
	const restore = await timed(() => tools.screen_act!.execute({ app, action: "unminimize", text: `${mainTitle} spare` }, ctx()));
	await delay(500);
	report.unminimize = { outcome: restore.result.details?.outcome, ms: restore.ms, appSaysMinimized: state("target").spareMinimized, appSaysVisible: state("target").spareVisible };

	// 5. Prove the witness covers the web window, then verify the requested DOM change independently.
	async function checkWeb(key: "chrome" | "electron", bundle: string, args: string[]): Promise<Record<string, unknown>> {
		const result: Record<string, unknown> = { executed: true, backgroundClickSucceeded: false };
		try {
			const beforeLaunch = witness(), beforeLaunchFront = windowSnapshot().frontPid;
			assert.equal(beforeLaunchFront, witnessPid, "the witness must be frontmost before launching the web app");
			let pid: number;
			if (key === "chrome") {
				assert.ok(chromeProfile, "Chrome needs this check's fresh profile");
				// Construct and start the real product browser only after recording the witness baseline.
				chromeBrowser = new WebBrowser({ chromePath: join(bundle, "Contents/MacOS/Google Chrome"), profileDir: chromeProfile, downloadDir: join(root, "downloads"), headless: false });
				const webTools = Object.fromEntries(createWebTools({ browser: chromeBrowser, consent: { granted: true } }).map(tool => [tool.name, tool]));
				const launchStartedAt = Date.now();
				let opened: ToolResult | undefined;
				try {
					opened = await step("web_read cold Chrome", () => webTools.web_read!.execute({ url: `${pageBase}/chrome/`, new_tab: true, full: true }, ctx()));
					result.productOpen = { ok: opened.ok, details: opened.details, modelContent: opened.modelContent };
					const owner = await chromeBrowser.ownedProcess();
					pid = Number(opened.details?.pid ?? owner?.pid);
					await delay(200);
				} finally {
					const launchReceipt = chromeBrowser.startupReport() ?? opened?.details?.launchReceipt;
					const focus = focusChange(beforeLaunch, witness());
					result.launch = { path: "web_read", receipts: launchReceipt ? [launchReceipt] : [], launchReceipt, frontBefore: beforeLaunchFront, frontAfter: windowSnapshot().frontPid, focus };
					focusSteps.push({ label: "web_read cold Chrome", startedAt: launchStartedAt, endedAt: Date.now(), keyboardException: false, change: focus });
				}
				assert.ok(opened?.ok, opened?.modelContent ?? "web_read did not return a result");
				assert.ok(chromeBrowser.startupReport(), "web_read did not retain the cold launch report");
			} else {
				const { stdout: launchLog } = await execAsync(appLauncher(), ["--new", "--watch", "5", bundle, ...args], { encoding: "utf8", timeout: 25_000 });
				const launch = launchLog.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
				pid = Number(launch.find(value => Number.isInteger(value.pid))?.pid);
				assert.ok(pid > 0, "launcher returned no application PID"); webPids.push(pid);
				await delay(200);
				result.launch = { receipts: launch, frontBefore: beforeLaunchFront, frontAfter: windowSnapshot().frontPid, focus: focusChange(beforeLaunch, witness()) };
			}
			assert.ok(pid > 0, "the web app returned no owned application PID");
			let first: ToolResult | undefined;
			for (const until = Date.now() + 15_000; Date.now() < until; await delay(300)) {
				first = await tools.screen_read!.execute({ app: String(pid), full: true }, ctx());
				if (first.ok && /button "Visible button"/.test(first.modelContent)) break;
			}
			result.firstRead = first?.modelContent;
			assert.ok(first?.ok && /button "Visible button"/.test(first.modelContent), "the web app did not expose Visible button");
			const window = String(first.details?.window), windowId = Number(window.replace(/^w:/, ""));
			assert.ok(Number.isInteger(windowId) && windowId > 0, "screen_read returned no web window handle");
			const initial = pageReceipts.get(key); result.initialPage = initial;
			assert.equal(initial?.heading, "Beta1 page", "the page itself must confirm the initial heading");
			assert.equal(initial.clicks, 0, "the page was already clicked before this check");
			const beforeCover = coverage(windowId, witnessPid), b = beforeCover.target?.bounds;
			assert.ok(b, "WindowServer did not list the exact web window");
			writeFileSync(join(root, "witness.json.cover"), JSON.stringify({ x: b.X, y: b.Y, width: b.Width, height: b.Height }));
			let coveredWindow = coverage(windowId, witnessPid);
			for (const until = Date.now() + 5_000; Date.now() < until && !coveredWindow.fullyCovered; await delay(150)) coveredWindow = coverage(windowId, witnessPid);
			result.coverage = coveredWindow;
			assert.equal(coveredWindow.fullyCovered, true, "the witness did not fully cover the web window from above");
			assert.equal(coveredWindow.frontPid, witnessPid, "the witness must remain frontmost while the web window is covered");
			await delay(1500);
			const covered = await tools.screen_read!.execute({ app: String(pid), window, full: true }, ctx());
			result.coveredRead = covered.modelContent;
			result.pageAfterCovered = covered.ok && /button "Visible button"/.test(covered.modelContent);
			assert.equal(result.pageAfterCovered, true, "Visible button disappeared after real coverage");
			const button = covered.modelContent.match(/(e\d+) button "Visible button"/)?.[1];
			assert.ok(button, "the covered page has no actionable Visible button ID");
			const headingText = covered.modelContent.match(/(e\d+) static_text = "Beta1 page"/)?.[1];
			assert.ok(headingText, "the covered page has no observable heading text ID");
			const beforeClickCoverage = coverage(windowId, witnessPid);
			result.coverageBeforeClick = beforeClickCoverage;
			assert.equal(beforeClickCoverage.fullyCovered, true, "the web window was exposed before the click");
			await execAsync("/usr/sbin/screencapture", ["-x", join(root, `${key}-before-click.png`)], { timeout: 10_000 });
			const beforeClick = witness(), frontBeforeClick = windowSnapshot().frontPid, pointerStart = pointerInputs.length;
			const click = await timed(() => tools.screen_act!.execute({ app: String(pid), window, action: "click", id: button, expect: { id: headingText, property: "value", value: "Clicked" } }, ctx()));
			for (const until = Date.now() + 2_000; Date.now() < until && pageReceipts.get(key)?.heading !== "Clicked"; await delay(100)) { /* await the page's own receipt */ }
			const afterClick = witness(), page = pageReceipts.get(key), afterCoverage = coverage(windowId, witnessPid);
			result.coverageAfterClick = afterCoverage;
			await execAsync("/usr/sbin/screencapture", ["-x", join(root, `${key}-after-click.png`)], { timeout: 10_000 });
			const readBack = await tools.screen_read!.execute({ app: String(pid), window, full: true }, ctx());
			const focus = focusChange(beforeClick, afterClick);
			const foregroundUnchanged = frontBeforeClick === witnessPid && afterCoverage.frontPid === witnessPid && beforeClick.active && afterClick.active &&
				beforeClick.key && afterClick.key && beforeClick.fieldFocused && afterClick.fieldFocused &&
				focus.resignActive === 0 && focus.resignKey === 0 && focus.otherActivations.length === 0;
			const domChanged = page?.heading === "Clicked" && page.clicks === 1 && page.trusted === true;
			result.click = { ok: click.result.ok, outcome: click.result.details?.outcome, details: click.result.details, message: click.result.modelContent, ms: click.ms, pointerInputs: pointerInputs.slice(pointerStart),
				page, readBack: readBack.modelContent, domChanged, headingReadBack: /"Clicked"/.test(readBack.modelContent), frontBefore: frontBeforeClick, frontAfter: afterCoverage.frontPid, focus, foregroundUnchanged, stillCovered: afterCoverage.fullyCovered };
			result.backgroundClickSucceeded = click.result.ok === true && click.result.details?.outcome === "confirmed" && domChanged && foregroundUnchanged && afterCoverage.fullyCovered;
			result.explicitLimitation = !click.result.ok && click.result.details?.error === "background_click_ineffective" && pointerInputs.length - pointerStart === 1;
			result.pageUnchanged = page?.heading === "Beta1 page" && page.clicks === 0;
			const throughout = focusChange(beforeLaunch, witness());
			result.focusThroughout = throughout;
			result.foregroundUnchangedThroughout = throughout.witnessActiveBefore && throughout.witnessActiveAfter && throughout.resignActive === 0 && throughout.resignKey === 0 && throughout.otherActivations.length === 0;
			result.accepted = result.foregroundUnchangedThroughout && (result.backgroundClickSucceeded || (result.explicitLimitation && result.pageUnchanged && foregroundUnchanged && afterCoverage.fullyCovered));
			return result;
		} catch (error) { return { ...result, accepted: false, error: error instanceof Error ? error.message : String(error) }; }
	}
	const chrome = "/Applications/Google Chrome.app";
	if (existsSync(chrome)) {
		chromeProfile = mkdtempSync(join(tmpdir(), "mountains-beta1-chrome-"));
		report.web = await checkWeb("chrome", chrome, []);
	} else report.web = { executed: false, accepted: false, error: "Google Chrome is not installed" };
	const electron = process.env.MOUNTAINS_BETA1_ELECTRON_APP;
	if (electron && existsSync(electron)) {
		// Minimal official Electron API surface: one BrowserWindow and a local test page. No framework or IPC.
		const entry = join(root, "electron-main.cjs");
		writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root, "electron-profile"))});app.whenReady().then(()=>{const win=new BrowserWindow({x:560,y:420,width:520,height:320,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.once('ready-to-show',()=>win.showInactive());win.loadURL(${JSON.stringify(`${pageBase}/electron/`)});});app.on('window-all-closed',()=>app.quit());`);
		report.electron = await checkWeb("electron", electron, [entry]);
	} else report.electron = { executed: false, accepted: false, reason: electron ? "MOUNTAINS_BETA1_ELECTRON_APP does not exist" : "set MOUNTAINS_BETA1_ELECTRON_APP to include Electron acceptance" };

	const after = witness();
	report.focus = { resignActive: Number(after.resignActive) - Number(before.resignActive), resignKey: Number(after.resignKey) - Number(before.resignKey),
		otherActivations: (after.otherActivations as unknown[]).length - (before.otherActivations as unknown[]).length, witnessStillActive: after.active, fieldStillFocused: after.fieldFocused, witnessStillKey: after.key,
		// Who took the front, and when, against the step log on stderr.
		activations: (after.otherActivations as { at: number; name: string }[]).slice((before.otherActivations as unknown[]).length).map(a => `${new Date(a.at).toISOString().slice(11, 23)} ${a.name}`),
		witnessEvents: (after.events as { at: number; event: string }[]).filter(e => e.at > startedAt).map(e => `${new Date(e.at).toISOString().slice(11, 23)} ${e.event}`),
		steps: focusSteps };
	const webAccepted = (report.web as Record<string, unknown>).accepted === true;
	const electronAccepted = (report.electron as Record<string, unknown>).accepted === true;
	report.webAcceptance = { chromeAccepted: webAccepted, electronAccepted, complete: webAccepted && electronAccepted };
	const popup = report.popup as Record<string, unknown>, type = report.type as Record<string, unknown>, menubar = report.menubar as Record<string, unknown>;
	const save = report.savePanel as Record<string, unknown>, unminimize = report.unminimize as Record<string, unknown>, capture = report.capture as Record<string, unknown>;
	const nativeChecks = {
		minimizedWindowListed: report.offscreenListed === true,
		windowImages: Number(capture.hardwareP95) > 0 && Number(capture.streamP95) > 0 && (report.look as Record<string, unknown>).ok === true,
		popup: popup.outcome === "confirmed" && popup.appSays === "Large",
		type: type.outcome === "confirmed" && type.appSays === "Beta1 你好 🌍",
		menubar: menubar.readMenuOk === true && menubar.chooseOk === true && menubar.listsOptions === true && menubar.appSays === "B",
		save: save.openOk === true && save.fillOk === true && save.wholePathRefusedUntouched === true && save.pressed === true && save.appSaved === target && save.onDisk === true && save.contentOnDisk === "Beta1",
		unminimize: unminimize.outcome === "confirmed" && unminimize.appSaysMinimized === false && unminimize.appSaysVisible === true,
	};
	const nativeAccepted = Object.values(nativeChecks).every(Boolean);
	report.nativeAcceptance = { accepted: nativeAccepted, checks: nativeChecks, failed: Object.entries(nativeChecks).filter(([, ok]) => !ok).map(([name]) => name) };
	const keyEvents = after.events.filter(event => event.at >= measurementStartedAt && event.event === "resignKey");
	const allowedKeyEvents = keyEvents.filter(event => focusSteps.some(step => step.keyboardException && event.at >= step.startedAt && event.at <= step.endedAt));
	const totalKeyLosses = after.resignKey - before.resignKey, frontAtEnd = windowSnapshot().frontPid;
	const focusChecks = {
		noLostActivation: after.resignActive === before.resignActive,
		noOtherAppActivation: after.otherActivations.length === before.otherActivations.length,
		allKeyLossesExplained: keyEvents.length === totalKeyLosses && allowedKeyEvents.length === totalKeyLosses,
		witnessActive: after.active && frontAtEnd === witnessPid,
		witnessKey: after.key,
		fieldFocused: after.fieldFocused,
	};
	const focusAccepted = Object.values(focusChecks).every(Boolean);
	report.focusAcceptance = { accepted: focusAccepted, checks: focusChecks, totalKeyLosses, allowedKeyLosses: allowedKeyEvents.length,
		unexpectedKeyEvents: keyEvents.filter(event => !allowedKeyEvents.includes(event)), frontAtEnd, failed: Object.entries(focusChecks).filter(([, ok]) => !ok).map(([name]) => name) };
	report.acceptance = { accepted: nativeAccepted && focusAccepted && webAccepted && electronAccepted, native: nativeAccepted, focus: focusAccepted, chrome: webAccepted, electron: electronAccepted };
	if (!nativeAccepted || !focusAccepted || !webAccepted || !electronAccepted) process.exitCode = 1;
} finally {
	// All acceptance results above describe the live desktop before cleanup changes any windows.
	await desktop.close?.().catch(() => {});
	let chromeClosed = true;
	await chromeBrowser?.close().catch(error => { chromeClosed = false; report.browserCleanupError = error instanceof Error ? error.message : String(error); process.exitCode = 1; });
	for (const child of children) { child.stdin?.end(); child.kill(); }
	for (const pid of webPids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
	if (chromeProfile && chromeClosed) rmSync(chromeProfile, { recursive: true, force: true });
	pageServer.closeAllConnections();
	await new Promise<void>((resolve, reject) => pageServer.close(error => error ? reject(error) : resolve()));
	console.log(JSON.stringify(report, null, 2));
	rmSync(root, { recursive: true, force: true });
}
