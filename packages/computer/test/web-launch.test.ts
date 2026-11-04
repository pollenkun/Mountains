import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { ToolContext, ToolDefinition } from "@mountains/tools";
import { BrowserClients } from "../src/browser-clients.ts";
import { InputCoordinator } from "../src/coordinator.ts";
import { PageInterlock } from "../src/page-interlock.ts";
import { isAppLauncher, parseAppLaunchReceipt, type AppLaunchReceipt } from "../src/launcher-mac.ts";
import type { WebBrowser, WebToolOptions, CdpLike } from "../src/web.ts";

// Execute the actual module with only its OS/transport boundary replaced. This
// exercises start, connection, cleanup and public tool error handling together;
// no launcher, Chrome process, AppKit API or GUI is invoked.
const source = stripTypeScriptTypes(readFileSync(new URL("../src/web.ts", import.meta.url), "utf8"))
	.replace(/^import .*;\r?\n/gm, "")
	.replace(/^export /gm, "")
	.replaceAll("import.meta.url", JSON.stringify(new URL("../src/web.ts", import.meta.url).href));
const clean: AppLaunchReceipt = { pid: 300, gaveBack: 0, frontTaken: 0, restoreRequests: 0, returnFailed: false, watchStopped: null };

class Child extends EventEmitter {
	pid: number | undefined = 123;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stdout = new PassThrough();
	stdin = new PassThrough();
	kills: string[] = [];
	exit(code = 0) { this.exitCode = code; this.emit("exit", code); }
	close() { this.stdout.end(); this.emit("close", this.exitCode, this.signalCode); }
	kill(signal: string) { this.kills.push(signal); this.signalCode = signal; this.emit("exit", null, signal); this.close(); return true; }
}

function fixture(options: { headless?: boolean; platform?: string; existing?: boolean; watchTimeout?: number; leaveError?: boolean; spawnError?: boolean; configureDownloads?: (signal?: AbortSignal) => Promise<void> } = {}) {
	const child = new Child(), coordinator = new InputCoordinator();
	let spawnCount = 0, socketReads = 0, ownedConnections = 0, configured = 0, browserAlive = true, transportCloses = 0;
	let spawnOptions: unknown;
	const sent: string[] = [];
	const cdp: CdpLike = {
		on: () => () => {}, close: async () => { transportCloses++; },
		send: async method => {
			sent.push(method);
			if (method === "SystemInfo.getProcessInfo") return { processInfo: [{ type: "browser", id: options.headless || options.platform === "linux" ? 123 : 300 }] };
			if (method === "Target.getTargets") return { targetInfos: [] };
			if (method === "Browser.close") { browserAlive = false; if (options.headless || options.platform === "linux") child.kill("SIGTERM"); }
			return {};
		},
	};
	const api = runInNewContext(source + "\n;({WebBrowser,createWebTools});", {
		...path, Buffer, URL, Error, AggregateError, Promise, AbortSignal, AbortController, performance,
		process: { platform: options.platform ?? "darwin", env: {}, getuid: () => 1 }, randomUUID, homedir,
		createRequire: () => () => {}, realpathSync: (value: string) => value,
		mkdir: async () => {}, access: async () => {}, BrowserClients, InputCoordinator, PageInterlock,
		BrowserFrames: class { close() {} }, isAppLauncher, parseAppLaunchReceipt,
		appLauncher: () => "/own/native/darwin-universal/launch-app", delay,
		setTimeout: (run: () => void, ms: number) => setTimeout(run, ms === 20_000 && options.watchTimeout !== undefined ? options.watchTimeout : ms), clearTimeout,
		spawn: (_file: string, _args: string[], config: unknown) => {
			spawnCount++; spawnOptions = config;
			if (options.spawnError) queueMicrotask(() => { child.pid = undefined; child.emit("error", new Error("spawn failed")); child.close(); });
			return child;
		},
	}) as { WebBrowser: new (options: WebToolOptions) => WebBrowser; createWebTools: (options: WebToolOptions) => ToolDefinition[] };
	const browser = new api.WebBrowser({ ...(options.headless !== undefined ? { headless: options.headless } : {}), chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", profileDir: "/own/profile" });
	const clients = new BrowserClients(coordinator), endpoint = "ws://127.0.0.1:1234/own-browser";
	Object.assign(browser, {
		coordinator, clients,
		existingSocket: async () => options.existing || socketReads++ > 0 ? endpoint : undefined,
		ownedConnection: async () => { ownedConnections++; return cdp; },
		readProcess: async (pid: number) => browserAlive ? { pid, identity: "own-browser-birth" } : null,
		configureDownloads: async (_cdp: CdpLike, signal?: AbortSignal) => { configured++; await options.configureDownloads?.(signal); },
	});
	if (options.leaveError) clients.leave = async () => { throw new Error("client cleanup failed"); };
	const read = api.createWebTools({ browser, consent: { granted: true } }).find(tool => tool.name === "web_read")!;
	const context = (signal = new AbortController().signal) => ({ signal, toolCallId: "launch-test", workspace: { root: "/own" } }) as ToolContext;
	return { browser, clients, coordinator, child, endpoint, cdp, sent, context,
		read: (signal?: AbortSignal) => read.execute({}, context(signal)),
		stats: () => ({ spawnCount, spawnOptions, ownedConnections, configured, transportCloses }),
		async connected() { for (let i = 0; i < 100 && !ownedConnections; i++) await delay(1); assert.equal(ownedConnections, 1); },
		finish(receipt: unknown = clean, code = 0) { child.stdout.write(JSON.stringify({ pid: 300 }) + "\n" + JSON.stringify(receipt) + "\n"); child.exit(code); child.close(); },
	};
}

test("a ready CDP endpoint cannot return success before the launcher drains its final report", async () => {
	const f = fixture(); let settled = false;
	const reading = f.read().then(result => { settled = true; return result; });
	await f.connected(); f.child.stdout.write('{"pid":300}\n');
	f.child.exit(0); await delay(15);
	assert.equal(settled, false); assert.equal(f.stats().configured, 0);
	// Once Chrome's endpoint is attested, the launcher is told so and only waits out its quiet period.
	assert.equal(String(f.child.stdin.read() ?? ""), "ready\n");
	f.child.stdout.write(JSON.stringify(clean) + "\n"); f.child.close();
	const result = await reading;
	assert.equal(result.ok, true, result.modelContent);
	assert.deepEqual(JSON.parse(JSON.stringify(result.details.launchReceipt)), clean); assert.equal(f.stats().configured, 1);
	assert.equal(JSON.stringify(f.stats().spawnOptions), JSON.stringify({ stdio: ["pipe", "pipe", "ignore"], detached: false }));
	assert.equal(f.stats().spawnCount, 1); await f.browser.close();
});

for (const receipt of [{ ...clean, frontTaken: 1, gaveBack: 1, restoreRequests: 1 }, { ...clean, returnFailed: true }]) {
	test("foreground disruption remains a dispatched failure after the browser endpoint is usable: " + JSON.stringify(receipt), async () => {
		const f = fixture(), reading = f.read(); await f.connected(); f.finish(receipt);
		const result = await reading;
		assert.equal(result.ok, false); assert.equal(result.details.outcome, "failed");
		assert.equal(result.details.dispatched, true); assert.equal(result.details.retryUnsafe, true);
		assert.deepEqual(result.details.launchReceipt, receipt); assert.equal(result.details.pid, 300);
		assert.match(result.modelContent, /interrupted the foreground app.*do not launch Chrome again automatically/);
		assert.equal(f.sent.filter(method => method === "Browser.close").length, 1);
		assert.equal((await f.read()).ok, false); assert.equal(f.stats().spawnCount, 1, "another read must not relaunch");
	});
}

for (const receipt of [{ pid: 300 }, { ...clean, pid: 301 }, "truncated"]) {
	test("missing or mismatched final evidence cannot become success: " + JSON.stringify(receipt), async () => {
		const f = fixture(), reading = f.read(); await f.connected(); f.finish(receipt);
		const result = await reading;
		assert.equal(result.ok, false); assert.equal(result.details.dispatched, true); assert.equal(result.details.retryUnsafe, true);
		assert.equal(result.details.pid, 300, "the attested browser PID must not be replaced by a mismatched report");
		assert.match(result.modelContent, /missing or invalid|does not match/);
		await f.read(); assert.equal(f.stats().spawnCount, 1);
	});
}

test("a new launch without a final report cannot reuse an earlier launch report", async () => {
	const f = fixture(); Object.assign(f.browser, { launchReceipt: { ...clean, pid: 299 } });
	const reading = f.read(); await f.connected(); f.finish({ pid: 300 });
	const result = await reading;
	assert.equal(result.ok, false); assert.equal(result.details.dispatched, true); assert.equal(result.details.retryUnsafe, true);
	assert.equal(result.details.pid, 300); assert.equal(result.details.launchReceipt, undefined);
	assert.equal(f.browser.startupReport(), undefined);
	await f.read(); assert.equal(f.stats().spawnCount, 1);
});

test("an unsuccessful launcher exit cannot hide behind a clean final report", async () => {
	const f = fixture(), reading = f.read(); await f.connected(); f.finish(clean, 1);
	const result = await reading;
	assert.equal(result.ok, false); assert.equal(result.details.dispatched, true); assert.equal(result.details.retryUnsafe, true);
	assert.deepEqual(result.details.launchReceipt, clean); assert.match(result.modelContent, /launcher exited unsuccessfully/);
	await f.read(); assert.equal(f.stats().spawnCount, 1);
});

test("cancelling the watch closes the attested browser and awaits the exact launcher child", async () => {
	const f = fixture(), cancel = new AbortController(), reading = f.read(cancel.signal);
	await f.connected(); cancel.abort(new Error("cancelled by the user"));
	const result = await reading;
	assert.equal(result.details.dispatched, true); assert.equal(result.details.retryUnsafe, true); assert.equal(result.details.cancelled, true);
	assert.match(result.modelContent, /cancelled by the user/); assert.deepEqual(f.child.kills, ["SIGTERM"]);
	assert.equal(f.sent.filter(method => method === "Browser.close").length, 1);
	const state = f.browser as unknown as { child: unknown; childLifetime: unknown };
	assert.equal(state.child, null); assert.equal(state.childLifetime, undefined);
	await f.read(); assert.equal(f.stats().spawnCount, 1);
});

test("an unfinished watch has a deadline and retains dispatched failure through cleanup", async () => {
	const f = fixture({ watchTimeout: 15 }), reading = f.read(); await f.connected();
	const result = await reading;
	assert.equal(result.ok, false); assert.equal(result.details.retryUnsafe, true);
	assert.match(result.modelContent, /timed out waiting for the final app launch report/);
	assert.deepEqual(f.child.kills, ["SIGTERM"]); await f.read(); assert.equal(f.stats().spawnCount, 1);
});

test("cancellation after a clean launch report still blocks a second launch", async () => {
	let ready!: () => void, release!: () => void;
	const configuring = new Promise<void>(resolve => { ready = resolve; });
	const continueConfiguration = new Promise<void>(resolve => { release = resolve; });
	// A CDP request already in flight may resolve normally after cancellation.
	// The connection must check cancellation itself after setup returns.
	const f = fixture({ configureDownloads: async () => { ready(); await continueConfiguration; } });
	const cancel = new AbortController(), reading = f.read(cancel.signal);
	await f.connected(); f.finish(); await configuring;
	cancel.abort(new Error("cancelled after the app launch watch")); release();
	const result = await reading;
	assert.equal(result.ok, false); assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.dispatched, true); assert.equal(result.details.retryUnsafe, true); assert.equal(result.details.cancelled, true);
	assert.deepEqual(JSON.parse(JSON.stringify(result.details.launchReceipt)), clean); assert.equal(result.details.pid, 300);
	assert.match(result.modelContent, /cancelled after the app launch watch/);
	assert.equal(f.sent.filter(method => method === "Browser.close").length, 1);
	assert.equal((await f.read()).details.retryUnsafe, true); assert.equal(f.stats().spawnCount, 1);
});

test("download setup failure after a clean launch report keeps the launch evidence and blocks retry", async () => {
	const f = fixture({ configureDownloads: async () => { throw new Error("download directory permission denied"); } });
	const reading = f.read(); await f.connected(); f.finish();
	const result = await reading;
	assert.equal(result.ok, false); assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.dispatched, true); assert.equal(result.details.retryUnsafe, true);
	assert.deepEqual(JSON.parse(JSON.stringify(result.details.launchReceipt)), clean); assert.equal(result.details.pid, 300);
	assert.match(result.modelContent, /download directory permission denied/);
	assert.equal(f.sent.filter(method => method === "Browser.close").length, 1);
	assert.equal((await f.read()).details.retryUnsafe, true); assert.equal(f.stats().spawnCount, 1);
});

test("an older launch report does not mark a reused endpoint setup failure as a new launch", async () => {
	const f = fixture({ existing: true, configureDownloads: async () => { throw new Error("download setup failed on reuse"); } });
	Object.assign(f.browser, { launchReceipt: clean });
	const peer = new BrowserClients(f.coordinator);
	await peer.join(); await peer.owned(f.endpoint, { pid: 300, identity: "own-browser-birth" });
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await f.read();
		assert.equal(result.ok, false); assert.equal(result.details.outcome, "not_executed");
		assert.equal(result.details.dispatched, false); assert.equal(result.details.retryUnsafe, undefined);
		assert.match(result.modelContent, /download setup failed on reuse/);
	}
	assert.equal(f.stats().spawnCount, 0); assert.equal(f.stats().ownedConnections, 2);
	assert.equal(f.sent.includes("Browser.close"), false);
	await f.browser.close(); await peer.leave(f.endpoint);
});

test("cleanup errors retain the original launch report and do not close an unclaimed browser", async () => {
	const f = fixture({ leaveError: true }), reading = f.read(); await f.connected();
	const receipt = { ...clean, frontTaken: 1 }; f.finish(receipt);
	const result = await reading;
	assert.equal(result.details.dispatched, true); assert.equal(result.details.retryUnsafe, true);
	assert.deepEqual(result.details.launchReceipt, receipt); assert.match(result.modelContent, /interrupted the foreground app/);
	assert.equal(f.sent.includes("Browser.close"), false); assert.equal(f.stats().configured, 0);
});

for (const options of [{ headless: true }, { platform: "linux" }]) test("direct browser children do not wait for a launcher report: " + JSON.stringify(options), async () => {
	const f = fixture(options), result = await f.read();
	assert.equal(result.ok, true, result.modelContent); assert.equal(result.details.launchReceipt, undefined);
	assert.equal(f.child.exitCode, null); assert.equal(f.stats().spawnCount, 1);
	await f.browser.close(); assert.deepEqual(f.child.kills, ["SIGTERM"]);
});

test("an existing owned endpoint is shared without spawning or waiting for a launcher", async () => {
	const f = fixture({ existing: true }), peer = new BrowserClients(f.coordinator);
	await peer.join(); await peer.owned(f.endpoint, { pid: 300, identity: "own-browser-birth" });
	const result = await f.read(); assert.equal(result.ok, true, result.modelContent); assert.equal(f.stats().spawnCount, 0);
	await f.browser.close(); assert.equal(f.sent.includes("Browser.close"), false);
	await peer.leave(f.endpoint);
});

test("a launch failure before a child exists stays not executed", async () => {
	const f = fixture({ spawnError: true }), result = await f.read();
	assert.equal(result.details.dispatched, false); assert.equal(result.details.outcome, "not_executed");
	assert.match(result.modelContent, /spawn failed/);
});
