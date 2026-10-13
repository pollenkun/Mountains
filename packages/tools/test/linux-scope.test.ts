import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createCommandTool, DEFAULT_COMMAND_LIMITS } from "../src/command.ts";
import { parseLinuxScopeState, probeLinuxScope, spawnLinuxScope, type LinuxScopeHost } from "../src/linux-scope.ts";
import { LINUX_SCOPE_RUNNER } from "../src/linux-scope-runner.ts";
import { BlobStore, FileStateTracker, Workspace } from "../src/workspace.ts";
import type { ToolContext } from "../src/types.ts";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "linux-scope-test-")));
	const abort = new AbortController();
	t.after(() => { abort.abort(); rmSync(root, { recursive: true, force: true }); });
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), blobs: new BlobStore(join(root, "blobs")),
		signal: abort.signal, toolCallId: t.name, approve: async () => "allow" };
	return { root, abort, ctx };
}
const state = (tasks: string, active = "active", load = "loaded") => ({ status: 0, stdout: `LoadState=${load}\nActiveState=${active}\nTasksCurrent=${tasks}\n` });

test("scope capability probe uses literal argv and only trusted bootstrap metadata", { skip: process.platform !== "linux" }, async () => {
	let calls = 0;
	assert.equal(await probeLinuxScope({ environment: { HOME: "/home/test", NODE_OPTIONS: "--require=/evil", OPENAI_API_KEY: "secret", PATH: "/evil" },
		run: async (_command, args, env) => { if (args[1] === "kill") return { status: 0, stdout: "" }; calls++; assert.ok(args.includes("--expand-environment=no")); assert.ok(args.includes("--scope"));
			assert.ok(args.includes("$MOUNTAINS_LITERAL")); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
			assert.equal(env.PATH, "/usr/bin:/bin"); return { status: 0, stdout: "1\n" }; } }), true);
	assert.equal(calls, 1);
	assert.equal(await probeLinuxScope({ run: async () => ({ status: null, stdout: "" }) }), false);
	assert.equal(await probeLinuxScope({ run: async () => { throw new Error("unavailable"); } }), false);
});

test("scope state rejects ambiguous, malformed and unknown process counts", () => {
	assert.deepEqual(parseLinuxScopeState(state("0").stdout), { load: "loaded", active: "active", tasks: 0 });
	assert.equal(parseLinuxScopeState(state("oops").stdout), undefined);
	assert.equal(parseLinuxScopeState(state("0").stdout + "TasksCurrent=1\n"), undefined);
	assert.equal(parseLinuxScopeState("LoadState=loaded\nActiveState=inactive\n"), undefined);
	assert.equal(parseLinuxScopeState(state("9007199254740999").stdout), undefined);
});

for (const platform of ["linux", "darwin"] as const) test(`${platform} fallback explicitly reports uncertainty without corrupting success or capture`, async t => {
	const f = fixture(t);
	const result = await createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 4096 }, {}, {
		platform, probeLinuxScope: async () => false,
	}).execute({ argv: [process.execPath, "-e", "process.stdout.write('whole output')"] }, f.ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(result.details.processTreeCleanupMode, "best-effort");
	assert.equal(result.details.processTreeCleanupConfirmed, false);
	assert.equal(result.details.captureComplete, true); assert.ok(result.fullOutputRef); assert.equal(result.details.partialOutputRef, undefined);
	assert.match(result.summary, /best-effort\/unconfirmed/);
	assert.doesNotMatch(result.modelContent, /best-effort/, "routine best-effort cleanup is not repeated to the model");
	assert.equal(f.ctx.blobs!.get(result.fullOutputRef!), "whole output");
});

test("cancellation and authorization are rechecked after asynchronous scope probing", async t => {
	const f = fixture(t); let launched = 0;
	const tool = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", probeLinuxScope: async () => { f.abort.abort(); return true; },
		spawnLinuxScope: () => { launched++; throw new Error("must not launch"); } });
	const result = await tool.execute({ argv: [process.execPath, "-e", ""] }, f.ctx);
	assert.equal(result.details.cancelled, true); assert.equal(launched, 0);
	const g = fixture(t); let checked = false;
	g.ctx.assertExecutionAllowed = () => { checked = true; throw new Error("authorization changed"); };
	const refused = await createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", probeLinuxScope: async () => true,
		spawnLinuxScope: () => { launched++; throw new Error("must not launch"); } }).execute({ argv: [process.execPath, "-e", ""] }, g.ctx);
	assert.equal(checked, true); assert.equal(launched, 0); assert.match(refused.modelContent, /authorization changed/);
});

test("a selected scope startup failure never replays the payload in fallback", async t => {
	const f = fixture(t); let scopes = 0, fallbacks = 0;
	const result = await createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", probeLinuxScope: async () => true,
		spawnLinuxScope: () => { scopes++; throw new Error("scope failed after selection"); },
		spawn: (() => { fallbacks++; throw new Error("fallback forbidden"); }) as typeof spawn,
	}).execute({ argv: [process.execPath, "-e", ""] }, f.ctx);
	assert.equal(result.ok, false); assert.equal(scopes, 1); assert.equal(fallbacks, 0);
});

/** Only the membership read is simulated; actual Node spawn, files, arguments,
 * environment, pipes and exit notifications run on the native Linux kernel. */
function simulatedScope(t: TestContext, mode: "empty" | "unknown" | "nonempty" = "empty") {
	let child: ChildProcess, directory = "", unit = "";
	const signals: string[][] = [];
	const host: LinuxScopeHost = {
		cleanupMs: 30,
		runSync: (() => ({ status: 0 })) as unknown as typeof import("node:child_process").spawnSync,
		spawn: ((command: string, args: string[], options: SpawnOptions) => {
			assert.equal(command, "/usr/bin/systemd-run");
			assert.equal(options.env?.NODE_OPTIONS, undefined); assert.equal(options.env?.NODE_PATH, undefined);
			const node = args.indexOf(process.execPath); const invocation = args.slice(node + 1);
			directory = dirname(invocation.at(-6)!); unit = invocation.at(-1)!;
			const index = invocation.indexOf(LINUX_SCOPE_RUNNER);
			assert.ok(index >= 0);
			invocation[index] = `const orig=require('node:fs').readFileSync;require('node:fs').readFileSync=(p,...a)=>p==='/proc/self/cgroup'?'0::/test/'+process.argv.at(-1)+'\\n':orig(p,...a);\n` + LINUX_SCOPE_RUNNER;
			child = spawn(process.execPath, invocation, options);
			return child;
		}) as unknown as typeof spawn,
		run: async (_command, args) => {
			if (args[1] === "kill") { signals.push(args); if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
			return mode === "unknown" ? { status: null, stdout: "" } : mode === "nonempty" ? state("1", "failed") : state(child && (child.exitCode !== null || child.signalCode !== null) ? "0" : "1");
		},
	};
	t.after(() => { if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); if (directory) rmSync(directory, { recursive: true, force: true }); });
	return { host, signals, unit: () => unit, directory: () => directory };
}

for (const code of [0, 7]) test(`real Node bootstrap preserves raw streams, argv, cwd and target env (exit ${code})`, { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t), scope = simulatedScope(t), preload = join(f.root, "target-preload.cjs");
	writeFileSync(preload, "process.env.PRELOAD_RAN='target';");
	const env = { NODE_OPTIONS: `--require=${preload}`, NODE_PATH: "/target-only", PATH: dirname(process.execPath), VALUE: "literal $VALUE 中文" };
	const values = ["", "a b", "$HOME", "日本語", "a\"quote"];
	const script = `require('node:fs').writeFileSync('observed.json',JSON.stringify({argv0:process.argv0,args:process.argv.slice(1),env:process.env,cwd:process.cwd()}));process.stdout.write(Buffer.from([0,255,65]));process.stderr.write('target stderr');process.exitCode=${code};`;
	const result = await createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", environment: env, probeLinuxScope: async () => true, linuxScope: scope.host,
	}).execute({ argv: ["node", "-e", script, ...values] }, f.ctx);
	assert.equal(result.details.exitCode, code, result.modelContent); assert.equal(result.ok, code === 0, result.modelContent);
	assert.equal(result.details.processTreeCleanupConfirmed, true); assert.equal(result.details.processTreeCleanupMode, "systemd-scope");
	const observed = JSON.parse(readFileSync(join(f.root, "observed.json"), "utf8"));
	assert.equal(observed.argv0, "node"); assert.deepEqual(observed.args, values); assert.equal(observed.cwd, f.root);
	assert.deepEqual(observed.env, { ...env, PRELOAD_RAN: "target" });
	const raw = f.ctx.blobs!.getBytes(result.fullOutputRef!)!;
	assert.ok(raw.includes(Buffer.from([0, 255, 65]))); assert.ok(raw.includes(Buffer.from("target stderr"))); assert.equal(raw.length, 16);
	assert.ok(scope.signals.every(args => args.at(-1) === scope.unit()));
	assert.equal(existsSync(scope.directory()), false);
});

for (const mode of ["unknown", "nonempty"] as const) test(`scope cleanup never turns ${mode} state into confirmation`, { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t), scope = simulatedScope(t, mode);
	const result = await createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", probeLinuxScope: async () => true, linuxScope: scope.host,
	}).execute({ argv: [process.execPath, "-e", ""] }, f.ctx);
	assert.equal(result.ok, false); assert.equal(result.details.processTreeCleanupConfirmed, false);
	assert.match(result.modelContent, /scope cleanup could not be confirmed/);
	assert.equal(existsSync(scope.directory()), true, "unconfirmed range retains owner/request records");
});

function linuxProcessAlive(pid: number): boolean {
	try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"; }
	catch { return false; }
}
async function waitFor(check: () => boolean, message: string) {
	for (let i = 0; i < 100; i++) { if (check()) return; await delay(20); }
	assert.ok(check(), message);
}
for (const mode of ["immediate", "nested", "inherited", "cancel"] as const) test(`native user-systemd owns ${mode} detached descendants and preserves unrelated processes`, { skip: process.platform !== "linux", timeout: 12_000 }, async t => {
	if (!await probeLinuxScope()) { t.skip("existing user-systemd literal-argv scopes unavailable; no host setup attempted"); return; }
	const f = fixture(t), script = join(f.root, "descendants.cjs"), pidFile = join(f.root, "owned.pid");
	writeFileSync(script, `const fs=require('node:fs'),{spawn}=require('node:child_process');
const [mode,pidFile,role]=process.argv.slice(2);
if(role==='leaf'||role==='unrelated'){process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),9000);setInterval(()=>{},1000)}
else if(role==='middle'){const c=spawn(process.execPath,[__filename,mode,pidFile,'leaf'],{detached:true,stdio:'ignore'});fs.writeFileSync(pidFile,String(c.pid));process.send(c.pid);c.unref();process.disconnect()}
else if(mode==='nested'){const c=spawn(process.execPath,[__filename,mode,pidFile,'middle'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>{c.unref();process.exit(0)})}
else{const c=spawn(process.execPath,[__filename,mode,pidFile,'leaf'],{detached:true,stdio:mode==='inherited'?['ignore','inherit','inherit']:'ignore'});fs.writeFileSync(pidFile,String(c.pid));c.unref();if(mode==='cancel')setInterval(()=>{},1000)}
`);
	const unrelated = spawn(process.execPath, [script, mode, pidFile, "unrelated"], { stdio: "ignore" });
	t.after(() => {
		unrelated.kill("SIGKILL");
		// Safety net for a failing native regression: only the uniquely named
		// fixture executable can authorize cleanup of the recorded descendant.
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8"));
			try { if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(script)) process.kill(pid, "SIGKILL"); } catch {}
		}
	});
	const pending = createCommandTool(DEFAULT_COMMAND_LIMITS).execute({ argv: [process.execPath, script, mode, pidFile, "root"], timeoutMs: 5000 }, f.ctx);
	if (mode === "cancel") { await waitFor(() => existsSync(pidFile), "payload must start before cancel"); f.abort.abort(); }
	const result = await pending;
	assert.equal(result.details.processTreeCleanupMode, "systemd-scope", result.modelContent);
	assert.equal(result.details.processTreeCleanupConfirmed, true, result.modelContent);
	assert.equal(result.ok, mode !== "cancel", result.modelContent);
	if (mode === "cancel") assert.equal(result.details.signal, "SIGTERM", "scope TERM must preserve the cooperative root outcome");
	const pid = Number(readFileSync(pidFile, "utf8"));
	await waitFor(() => !linuxProcessAlive(pid), "scope-owned detached descendant must stop");
	assert.equal(linuxProcessAlive(unrelated.pid!), true, "unrelated same-executable process must survive");
});

for (const target of ["plain-script", "signal", "missing"]) test(`Node bootstrap preserves ordinary ${target} execution semantics`, { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t), scope = simulatedScope(t);
	const plain = join(f.root, "plain-script");
	writeFileSync(plain, "printf '%s' \"$1\"; exit 7\n", { mode: 0o700 });
	const argv = target === "plain-script" ? ["./plain-script", "literal $HOME"] : target === "signal"
		? [process.execPath, "-e", "process.kill(process.pid,'SIGTERM')"] : ["./does-not-exist"];
	const result = await createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", probeLinuxScope: async () => true, linuxScope: scope.host }).execute({ argv }, f.ctx);
	assert.equal(result.ok, false, result.modelContent);
	assert.equal(result.details.processTreeCleanupConfirmed, true, result.modelContent);
	if (target === "plain-script") { assert.equal(result.details.exitCode, 7); assert.equal(f.ctx.blobs!.get(result.fullOutputRef!), "literal $HOME"); }
	if (target === "signal") { assert.equal(result.details.exitCode, null); assert.equal(result.details.signal, "SIGTERM"); }
	if (target === "missing") { assert.match(result.modelContent, /failed to start/); assert.equal(f.ctx.blobs!.get(result.fullOutputRef!), ""); }
});

test("pending-launch cancellation revokes the private bootstrap request before payload execution", { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t); let directory = "", child: ChildProcess | undefined, polls = 0;
	const host: LinuxScopeHost = {
		spawn: ((_command: string, args: string[], options: SpawnOptions) => {
			const invocation = args.slice(args.indexOf(process.execPath) + 1); directory = dirname(invocation.at(-6)!);
			const index = invocation.indexOf(LINUX_SCOPE_RUNNER);
			// Delay the trusted bootstrap and simulate denied direct signals so the
			// cancellation marker, rather than a lucky kill, must stop the payload.
			invocation[index] = `const orig=require('node:fs').readFileSync;require('node:fs').readFileSync=(p,...a)=>p==='/proc/self/cgroup'?'0::/test/'+process.argv.at(-1)+'\\n':orig(p,...a);setTimeout(()=>{${LINUX_SCOPE_RUNNER}},100);`;
			child = spawn(process.execPath, invocation, options); child.kill = () => false;
			return child;
		}) as unknown as typeof spawn,
		run: async (_command, args) => { if (args[1] === "show") { polls++; return state("0"); } return { status: 0, stdout: "" }; },
	};
	const scoped = spawnLinuxScope(process.execPath, ["-e", "require('node:fs').writeFileSync('ran','bad')"], { cwd: f.root, env: {} }, host);
	scoped.stdout.resume(); scoped.stderr.resume();
	const cleanup = await scoped.linuxScope.stop();
	assert.equal(cleanup.confirmed, true); assert.ok(polls > 1);
	assert.equal(existsSync(join(f.root, "ran")), false); assert.equal(existsSync(directory), false);
});

test("scope startup without membership fails closed and does not leak configuration to output", { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t); let directory = "";
	const host: LinuxScopeHost = {
		spawn: ((_command: string, args: string[], options: SpawnOptions) => {
			const invocation = args.slice(args.indexOf(process.execPath) + 1); directory = dirname(invocation.at(-6)!);
			// This host has no matching scope; execute the unmodified membership gate.
			return spawn(process.execPath, invocation, options);
		}) as unknown as typeof spawn,
		run: async () => state("[not set]", "inactive", "not-found"),
	};
	const result = await createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", probeLinuxScope: async () => true, linuxScope: host, environment: { PRIVATE_PAYLOAD: "do-not-print" } })
		.execute({ argv: [process.execPath, "-e", "require('node:fs').writeFileSync('ran','bad')"] }, f.ctx);
	assert.equal(result.ok, false); assert.match(result.modelContent, /failed to start/); assert.doesNotMatch(result.modelContent, /do-not-print/);
	assert.equal(existsSync(join(f.root, "ran")), false); assert.equal(existsSync(directory), false);
});

for (const protocol of ["oversized", "extra-key", "failure-text"] as const) test(`private scope ${protocol} record is bounded and cannot become command output`, { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t), scope = simulatedScope(t), query = scope.host.run!;
	scope.host.run = async (command, args, env) => {
		if (args[1] === "kill") writeFileSync(join(scope.directory(), protocol === "failure-text" ? "failure" : "outcome.json"),
			protocol === "oversized" ? "PRIVATE_RECORD".repeat(1000) : protocol === "extra-key" ? '{"code":0,"signal":null,"data":"PRIVATE_RECORD"}' : "PRIVATE_RECORD");
		return query(command, args, env);
	};
	const result = await createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", probeLinuxScope: async () => true, linuxScope: scope.host })
		.execute({ argv: [process.execPath, "-e", "process.stdout.write('target only')"] }, f.ctx);
	assert.equal(result.ok, false); assert.equal(result.details.exitCode, null); assert.match(result.modelContent, /failed to start/);
	assert.doesNotMatch(result.modelContent, /PRIVATE_RECORD/); assert.equal(f.ctx.blobs!.get(result.fullOutputRef!), "target only");
});

/** Simulate only scope-wide signal delivery using this test's one recorded
 * payload PID. The helper and payload themselves are real native processes. */
function gracefulScope(t: TestContext, pidfile: string, slowTerm = false) {
	const scope = simulatedScope(t), query = scope.host.run!;
	const signals: { signal: string; at: number }[] = [];
	let wrapper: ChildProcess | undefined, payloadPid: number | undefined;
	t.after(() => {
		if (payloadPid) { try { if (readFileSync(`/proc/${payloadPid}/cmdline`, "utf8").includes(pidfile)) process.kill(payloadPid, "SIGKILL"); } catch {} }
	});
	const launch = scope.host.spawn!;
	scope.host.spawn = ((...args: Parameters<typeof spawn>) => { wrapper = Reflect.apply(launch, undefined, args); return wrapper; }) as typeof spawn;
	scope.host.run = async (command, args, env) => {
		if (args[1] !== "kill") return query(command, args, env);
		const signal = args.find(arg => arg.startsWith("--signal="))!.slice("--signal=".length) as NodeJS.Signals;
		signals.push({ signal, at: Date.now() });
		if (signal === "SIGTERM") wrapper?.kill(signal);
		if (existsSync(pidfile)) {
			const pid = payloadPid = Number(readFileSync(pidfile, "utf8"));
			try { process.kill(pid, signal); } catch {}
		}
		if (signal === "SIGTERM") return slowTerm ? new Promise(() => {}) : state("1");
		return query(command, args, env);
	};
	return { ...scope, delivered: signals };
}

test("scope TERM grace preserves a cooperative target's real signal while the wrapper survives TERM", { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t), pidfile = join(f.root, "payload.pid"), scope = gracefulScope(t, pidfile);
	const resultPromise = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { platform: "linux", probeLinuxScope: async () => true, linuxScope: scope.host })
		.execute({ argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000);`] }, f.ctx);
	await waitFor(() => existsSync(pidfile), "payload must be ready");
	f.abort.abort(); const result = await resultPromise;
	assert.equal(result.details.cancelled, true); assert.equal(result.details.signal, "SIGTERM", result.modelContent);
	assert.equal(result.details.processTreeCleanupConfirmed, true); assert.equal(result.details.exitCode, null);
	assert.deepEqual(scope.delivered.map(item => item.signal).slice(0, 2), ["SIGTERM", "SIGKILL"]);
});

test("scope KILL deadline is not delayed by a hanging TERM query or a later cancellation", { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t), pidfile = join(f.root, "payload.pid"), scope = gracefulScope(t, pidfile, true);
	const scoped = spawnLinuxScope(process.execPath, ["-e", `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000);`], { cwd: f.root, env: {} }, scope.host);
	scoped.stdout.resume(); scoped.stderr.resume();
	await waitFor(() => existsSync(pidfile), "resistant payload must be ready");
	const first = scoped.linuxScope.stop(120); await delay(50); const later = scoped.linuxScope.stop(1000);
	assert.equal(later, first, "subsequent stop shares the first deadline");
	assert.equal((await first).confirmed, true);
	const term = scope.delivered.find(item => item.signal === "SIGTERM")!, kill = scope.delivered.find(item => item.signal === "SIGKILL")!;
	assert.ok(kill.at - term.at >= 90, "TERM receives the requested grace");
	assert.ok(kill.at - term.at < 650, `KILL must keep the first deadline, elapsed ${kill.at - term.at}ms`);
	assert.equal(linuxProcessAlive(Number(readFileSync(pidfile, "utf8"))), false);
});

test("scope output cap retains POSIX grace and records a later abort without restarting cleanup", { skip: process.platform !== "linux", timeout: 5000 }, async t => {
	const f = fixture(t), pidfile = join(f.root, "payload.pid"), scope = gracefulScope(t, pidfile);
	let abortTimer: NodeJS.Timeout | undefined;
	const query = scope.host.run!;
	scope.host.run = async (command, args, env) => {
		if (args.includes("--signal=SIGTERM")) abortTimer = setTimeout(() => f.abort.abort(), 100);
		return query(command, args, env);
	};
	const result = await createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 1024 }, {}, { platform: "linux", probeLinuxScope: async () => true, linuxScope: scope.host })
		.execute({ argv: [process.execPath, "-e", `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));process.stdout.write(Buffer.alloc(4096));setInterval(()=>{},1000);`] }, f.ctx);
	clearTimeout(abortTimer);
	assert.equal(result.details.outputLimited, true); assert.equal(result.details.cancelled, true); assert.equal(result.details.signal, "SIGKILL");
	assert.equal(scope.delivered.filter(item => item.signal === "SIGTERM").length, 1);
	const term = scope.delivered.find(item => item.signal === "SIGTERM")!, kill = scope.delivered.find(item => item.signal === "SIGKILL")!;
	assert.ok(kill.at - term.at >= 900); assert.ok(kill.at - term.at < 1700);
});
