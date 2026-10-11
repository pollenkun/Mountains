import assert from "node:assert/strict";
import { test } from "node:test";
import { join, win32 } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { findWindowsGitBash } from "../src/windows-command.ts";
import { createCommandTool, DEFAULT_COMMAND_LIMITS, type CommandExecutionHost } from "../src/command.ts";
import type { WindowsJobCleanup as WindowsCleanupResult, WindowsJobProcess } from "../src/windows-job.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";
import type { ToolContext } from "../src/types.ts";

function installation(root: string) {
	return [win32.join(root, "cmd", "git.exe"), win32.join(root, "bin", "bash.exe")];
}

function files(paths: string[]) {
	const found = new Set(paths.map(path => win32.normalize(path).toLowerCase()));
	return { isFile: (path: string) => found.has(win32.normalize(path).toLowerCase()) };
}

test("Windows shell scripts choose the Git for Windows wrapper in Program Files", () => {
	const root = "C:\\Program Files\\Git";
	assert.equal(findWindowsGitBash({ ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows\\System32" }, files(installation(root))), win32.join(root, "bin", "bash.exe"));
});

test("Windows Bash discovery supports case-insensitive environment names and per-user Git", () => {
	const root = "C:\\Users\\tester\\AppData\\Local\\Programs\\Git";
	assert.equal(findWindowsGitBash({ localappdata: "C:\\Users\\tester\\AppData\\Local" }, files(installation(root))), win32.join(root, "bin", "bash.exe"));
});

test("Windows Bash discovery supports a custom Git installation found through PATH", () => {
	const root = "D:\\Tools\\Portable Git";
	assert.equal(findWindowsGitBash({ Path: '"D:\\Tools\\Portable Git\\cmd";C:\\Windows\\System32' }, files(installation(root))), win32.join(root, "bin", "bash.exe"));
});

test("Windows Bash discovery rejects WSL and an unrelated PATH bash", () => {
	assert.equal(findWindowsGitBash({ PATH: "C:\\Windows\\System32;D:\\OtherShell\\bin" }, files([
		"C:\\Windows\\System32\\bash.exe", "D:\\OtherShell\\bin\\bash.exe",
	])), undefined);
});

test("Windows Bash discovery requires Git itself and its environment-setting wrapper", () => {
	const root = "C:\\Program Files\\Git";
	assert.equal(findWindowsGitBash({ ProgramFiles: "C:\\Program Files" }, files([win32.join(root, "bin", "bash.exe")])), undefined);
	assert.equal(findWindowsGitBash({ ProgramFiles: "C:\\Program Files" }, files([
		win32.join(root, "cmd", "git.exe"), win32.join(root, "usr", "bin", "bash.exe"),
	])), undefined);
});

/** A fake OS owns the whole job independently of whether its command parent survived. */
function fakeJob(options: { cleanupFailure?: boolean; inheritedPipes?: boolean } = {}) {
	const child = new EventEmitter() as WindowsJobProcess;
	const stdout = new PassThrough(), stderr = new PassThrough();
	Object.assign(child, { pid: 20001, exitCode: null, signalCode: null, stdout, stderr, stdin: new PassThrough() });
	const live = new Set([20002, 20003]);
	const unrelated = 20004;
	const systemProcesses = new Set([...live, unrelated]);
	let stopCalls = 0, fallbackKills = 0, unrefCalls = 0;
	let finishResolve!: (value: WindowsCleanupResult) => void;
	const finished = new Promise<WindowsCleanupResult>(resolve => { finishResolve = resolve; });
	let exited = false;
	const close = (code: number | null, signal: NodeJS.Signals | null, confirmed: boolean) => {
		if (exited) return;
		exited = true;
		if (confirmed) { for (const pid of live) systemProcesses.delete(pid); live.clear(); }
		Object.assign(child, { exitCode: code, signalCode: signal });
		finishResolve(confirmed ? { confirmed: true } : { confirmed: false, error: "假系统拒绝清理，后台进程未确认结束" });
		child.emit("exit", code, signal);
		if (!options.inheritedPipes) { stdout.end(); stderr.end(); child.emit("close", code, signal); }
	};
	Object.assign(child, {
		kill(signal: NodeJS.Signals = "SIGTERM") { fallbackKills++; close(null, signal, false); return true; },
		unref() { unrefCalls++; return child; },
		windowsJob: {
			finish: () => finished,
			async stop(): Promise<WindowsCleanupResult> {
				stopCalls++;
				if (options.cleanupFailure) return { confirmed: false, error: "假系统拒绝清理，后台进程未确认结束" };
				close(null, "SIGKILL", true);
				return { confirmed: true };
			},
		},
	});
	return {
		child, stdout, stderr, live, unrelated, systemProcesses,
		parentExits() { live.delete(20002); systemProcesses.delete(20002); },
		naturalExit(code = 0) { close(code, null, true); },
		counts: () => ({ stopCalls, fallbackKills, unrefCalls }),
	};
}

function fixture(t: TestContext, options: Parameters<typeof fakeJob>[0] = {}) {
	const root = mkdtempSync(join(tmpdir(), "mountains-windows-command-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const controller = new AbortController();
	const job = fakeJob(options);
	let spawnEntered!: () => void;
	const spawned = new Promise<void>(resolve => { spawnEntered = resolve; });
	const launches: { program: string; argv: string[]; env: NodeJS.ProcessEnv }[] = [];
	const execution: CommandExecutionHost = {
		platform: "win32",
		environment: { ProgramFiles: "C:\\Program Files", Path: "C:\\Windows\\System32", DEEPSEEK_API_KEY: "fake-test-only-key" },
		windows: files(installation("C:\\Program Files\\Git")),
		spawn() { assert.fail("Windows commands must use the Job Object launcher"); },
		spawnWindowsJob(program, argv, options) {
			launches.push({ program, argv, env: options.env }); spawnEntered(); return job.child;
		},
	};
	const ctx: ToolContext = {
		workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal,
		toolCallId: t.name, approve: async () => "allow",
	};
	return { job, ctx, execution, controller, spawned, launches };
}

test("Windows argv remains a direct program and argument list, and removes credentials", async t => {
	const f = fixture(t), argv = ["C:\\Tools\\node.exe", "-e", "quoted & text 日本語"];
	const running = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, f.execution).execute({ argv }, f.ctx);
	await f.spawned;
	f.job.naturalExit();
	const result = await running;
	assert.equal(result.ok, true, result.modelContent);
	assert.deepEqual(f.launches[0]?.argv, argv.slice(1));
	assert.equal(f.launches[0]?.program, argv[0]);
	assert.equal(f.launches[0]?.env.DEEPSEEK_API_KEY, undefined);
	assert.equal(result.details.processTreeCleanupConfirmed, true);
});

test("Windows shellScript uses the selected Git wrapper and preserves Bash syntax", async t => {
	const f = fixture(t), shellScript = "printf '%s\\n' one | cat > result.txt";
	const running = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, f.execution).execute({ shellScript }, f.ctx);
	await f.spawned; f.job.naturalExit();
	assert.equal((await running).ok, true);
	assert.equal(f.launches[0]?.program, "C:\\Program Files\\Git\\bin\\bash.exe");
	assert.deepEqual(f.launches[0]?.argv, ["-c", shellScript]);
});

test("Windows missing Git produces an install message and never launches PowerShell as the target shell", async t => {
	const f = fixture(t); f.execution.windows = files([]);
	const result = await createCommandTool(DEFAULT_COMMAND_LIMITS, {}, f.execution).execute({ shellScript: "echo hi | cat" }, f.ctx);
	assert.equal(result.ok, false);
	assert.match(result.modelContent, /请安装 Git for Windows/);
	assert.equal(f.launches.length, 0);
});

test("Windows cancellation clears the fake job after its command parent already exited", async t => {
	const f = fixture(t);
	const running = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, f.execution).execute({ argv: ["node", "spawn-background.js"] }, f.ctx);
	await f.spawned;
	f.job.parentExits();
	assert.deepEqual([...f.job.live], [20003], "the descendant outlives its command parent");
	f.controller.abort();
	const result = await running;
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.processTreeCleanupConfirmed, true);
	assert.equal(f.job.live.size, 0);
	assert.equal(f.job.systemProcesses.has(f.job.unrelated), true, "the unrelated process remains outside the job");
	assert.equal(f.job.counts().stopCalls, 1);
	assert.equal(f.job.counts().fallbackKills, 0);
});

test("Windows command timeout uses the same whole-job cleanup", async t => {
	const f = fixture(t);
	const result = await createCommandTool({ ...DEFAULT_COMMAND_LIMITS, defaultTimeoutMs: 10, maxTimeoutMs: 10 }, {}, f.execution)
		.execute({ argv: ["node", "wait.js"] }, f.ctx);
	assert.equal(result.ok, false);
	assert.equal(result.details.timedOut, true);
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.processTreeCleanupConfirmed, true);
	assert.equal(f.job.live.size, 0);
	assert.equal(f.job.counts().stopCalls, 1);
});

test("Windows output limit uses whole-job cleanup and a later abort cannot start another stop", async t => {
	const f = fixture(t);
	const running = createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 4 }, {}, f.execution)
		.execute({ argv: ["node", "output.js"] }, f.ctx);
	await f.spawned;
	f.job.stdout.write("too many bytes"); f.controller.abort();
	const result = await running;
	assert.equal(result.ok, false);
	assert.equal(result.details.outputLimited, true);
	assert.equal(result.details.outputBytes, 4);
	assert.equal(result.details.processTreeCleanupConfirmed, true);
	assert.equal(f.job.live.size, 0);
	assert.equal(f.job.counts().stopCalls, 1);
});

test("Windows natural command exit preserves its real nonzero code and cleans descendants", async t => {
	const f = fixture(t);
	const running = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, f.execution).execute({ argv: ["node", "exit-254.js"] }, f.ctx);
	await f.spawned; f.job.parentExits(); f.job.naturalExit(254);
	const result = await running;
	assert.equal(result.ok, false);
	assert.equal(result.details.exitCode, 254);
	assert.equal(result.details.processTreeCleanupConfirmed, true);
	assert.equal(f.job.live.size, 0);
	assert.equal(f.job.counts().stopCalls, 0);
});

test("Windows cleanup failure cannot claim success or wait forever on inherited output pipes", { timeout: 2000 }, async t => {
	const f = fixture(t, { cleanupFailure: true, inheritedPipes: true });
	const running = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, f.execution).execute({ argv: ["node", "wait.js"] }, f.ctx);
	await f.spawned; f.controller.abort();
	const result = await running;
	assert.equal(result.ok, false);
	assert.equal(result.details.processTreeCleanupConfirmed, false);
	assert.match(result.modelContent, /后台进程未确认结束/);
	assert.equal(f.job.counts().fallbackKills, 1);
	assert.equal(f.job.counts().unrefCalls, 1);
	assert.equal(f.job.child.stdout.destroyed, true);
	assert.equal(f.job.child.stderr.destroyed, true);
});
