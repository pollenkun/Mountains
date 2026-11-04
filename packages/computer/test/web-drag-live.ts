// Real-Chrome check for background drag in web_act. Run inside a test machine's desktop session:
//   MOUNTAINS_WEB_DRAG_LIVE=1 node packages/computer/test/web-drag-live.ts
// It serves test/fixtures/web-drag on 127.0.0.1, then drives a headless and a headed Chrome, each with a throwaway
// profile: an HTML drag-and-drop card, a pointer-event slider, a native range input and a file drop area. Every
// drag is confirmed by the page's own status text. On macOS it also records the front app before and after.
// "headed-attached" is a headed Chrome this script starts itself (open -g) and the tools attach to, so the drag can be
// checked in a visible window even where Chrome's own start takes the front (which the tools refuse).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { FileStateTracker, Workspace, type ToolContext, type ToolDefinition } from "@mountains/tools";
import { CdpConnection, WebBrowser, chromeArguments, createWebTools, parseDevToolsActivePort } from "../src/web.ts";

if (process.env.MOUNTAINS_WEB_DRAG_LIVE !== "1") { console.error("Set MOUNTAINS_WEB_DRAG_LIVE=1 to run this real-Chrome check."); process.exit(2); }
const chrome = process.env.MOUNTAINS_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = mkdtempSync(join(tmpdir(), "mountains-web-drag-"));
const page = readFileSync(fileURLToPath(new URL("./fixtures/web-drag/index.html", import.meta.url)));
const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
const file = join(root, "report.txt"); writeFileSync(file, "hello drag world");
const front = () => process.platform === "darwin" ? execFileSync("osascript", ["-l", "JavaScript", "-e", 'Application("System Events").processes.whose({frontmost:true})[0].name()'], { encoding: "utf8" }).trim() : "";
const ctx = (): ToolContext => ({ workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "live", approve: async () => "allow" });
const report: Record<string, unknown>[] = [];
const idOf = (content: string, role: string, name: string) => content.match(new RegExp(`(e\\d+) ${role} "${name}"`))?.[1];

async function attached(): Promise<WebBrowser> {
	const profile = join(root, "attached"), app = chrome.replace(/\/Contents\/MacOS\/Google Chrome$/, "");
	execFileSync("open", ["-g", "-n", "-a", app, "--args", ...chromeArguments(profile, false).filter(arg => arg !== "--no-startup-window")]);
	const port = join(profile, "DevToolsActivePort");
	for (let i = 0; i < 100 && !existsSync(port); i++) await delay(100);
	const endpoint = parseDevToolsActivePort(readFileSync(port, "utf8"));
	if (!endpoint) throw new Error("Chrome wrote no DevTools endpoint");
	await delay(1500);
	// Chrome's own start may take the front; put Finder back so the drags run with Chrome in the background.
	const frontAfterChromeStart = front();
	execFileSync("osascript", ["-e", 'tell application "Finder" to activate']);
	await delay(1000);
	report.push({ mode: "headed-attached", frontAfterChromeStart, frontBeforeDrags: front() });
	return new WebBrowser({ connect: () => CdpConnection.open(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`), downloadDir: join(root, "downloads") });
}

for (const mode of ["headless", "headed", "headed-attached"] as const) {
	const browser = mode === "headed-attached" ? await attached() : new WebBrowser({ chromePath: chrome, profileDir: join(root, mode), downloadDir: join(root, "downloads"), headless: mode === "headless" });
	const tools: Record<string, ToolDefinition> = Object.fromEntries(createWebTools({ browser, consent: { granted: true } }).map(tool => [tool.name, tool]));
	const frontBefore = front();
	try {
		let read = await tools.web_read!.execute({ url }, ctx());
		// Headed Chrome may take the front on its first start; the browser refuses that launch. Record it and try once more.
		if (!read.ok) { report.push({ mode, read: read.modelContent.slice(0, 1500), frontAfterRefusal: front() }); read = await tools.web_read!.execute({ url }, ctx()); }
		if (!read.ok) report.push({ mode, retry: read.modelContent.slice(0, 1500) });
		const text = read.modelContent, ids = { card: idOf(text, "button", "Card A"), done: idOf(text, "button", "Done column"), brightness: idOf(text, "slider", "Brightness"), volume: idOf(text, "slider", "Volume"), zone: idOf(text, "button", "Drop files here") };
		const steps: [string, Record<string, unknown>, string][] = [
			["html drag", { action: "drag", id: ids.card, to: ids.done }, "Card A moved to Done"],
			["pointer slider", { action: "drag", id: ids.brightness, dx: 150, dy: 0 }, "Brightness set to"],
			["native range", { action: "drag", id: ids.volume, dx: 40, dy: 0 }, "Volume set to"],
			["file drop", { action: "drop", id: ids.zone, files: [file] }, "Dropped: report.txt (16 bytes"],
		];
		for (const [name, step, expected] of steps) {
			const started = performance.now();
			const result = await tools.web_act!.execute({ ...step, expect: { property: "text", value: expected } }, ctx());
			report.push({ mode, name, ms: Math.round(performance.now() - started), outcome: result.details.outcome, dispatched: result.details.dispatched, ...(result.details.outcome === "confirmed" ? {} : { text: result.modelContent.slice(0, 1500) }) });
			console.error(`${new Date().toISOString()} ${mode} ${name}: ${String(result.details.outcome)}`);
		}
		report.push({ mode, ids, frontBefore, frontAfter: front() });
	} catch (error) { report.push({ mode, error: error instanceof Error ? error.stack : String(error) }); }
	finally {
		await browser.close().catch(error => report.push({ mode, closeError: String(error) }));
		if (mode === "headed-attached") try { execFileSync("pkill", ["-f", join(root, "attached")]); } catch { /* already gone */ }
	}
}
server.close(); rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 1));
