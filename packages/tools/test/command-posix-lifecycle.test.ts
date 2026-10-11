import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createCommandTool, DEFAULT_COMMAND_LIMITS } from "../src/command.ts";
import { BlobStore, FileStateTracker, Workspace } from "../src/workspace.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";

interface Identity { pid: number; ppid: number; pgid: number; state: string; birth: string; command: string }
function identities(pids: number[]): Map<number, Identity> {
	const rows = new Map<number, Identity>();
	if (!pids.length) return rows;
	const result = spawnSync("/bin/ps", ["-p", pids.join(","), "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 1000 });
	assert.ifError(result.error);
	for (const line of result.stdout.split("\n")) {
		const a = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
		if (a) rows.set(Number(a[1]), { pid: Number(a[1]), ppid: Number(a[2]), pgid: Number(a[3]), state: a[4]!, birth: a[5]!.replace(/\s+/g, " "), command: a[6]! });
	}
	return rows;
}
const alive = (p: Identity | undefined) => p !== undefined && !p.state.startsWith("Z");
async function until(check: () => boolean, message: string) {
	for (let i = 0; i < 100; i++) { if (check()) return; await delay(20); }
	assert.ok(check(), message);
}
function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "command-posix-lifecycle-"))), script = join(root, "fixture.cjs");
	const controller = new AbortController(), remembered = new Map<number, Identity>();
	const roles = ["parent", "descendant", "unrelated"];
	writeFileSync(script, `
const fs=require('node:fs'),{spawn}=require('node:child_process');
const [root,mode,role]=process.argv.slice(2);
fs.writeFileSync(root+'/'+role+'.pid',String(process.pid));
if(mode==='normal'||mode==='nonzero'){process.stdout.write('complete stdout\\n');process.stderr.write('complete stderr\\n');process.exit(mode==='nonzero'?7:0)}
if(role==='descendant'||role==='unrelated'){process.on('SIGTERM',()=>{});process.stdout.write('descendant ready\\n');setInterval(()=>{},1000)}
else if(mode==='resistant'){process.on('SIGTERM',()=>{});spawn(process.execPath,[__filename,root,mode,'descendant'],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)}
else {spawn(process.execPath,[__filename,root,mode,'descendant'],{detached:mode==='detached',stdio:mode==='detached'?'ignore':['ignore','inherit','inherit']});if(mode==='detached'){setInterval(()=>{},1000)}else setTimeout(()=>process.exit(0),300)}
`);
	const pids = () => roles.filter(role => existsSync(join(root, `${role}.pid`))).map(role => Number(readFileSync(join(root, `${role}.pid`), "utf8")));
	const remember = () => { const current = identities(pids()); for (const [pid, row] of current) if (!remembered.has(pid)) remembered.set(pid, row); return current; };
	const blobs = new BlobStore(join(root, "blobs"), { workspaceRoot: root, sessionId: "posix-lifecycle" });
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), blobs, signal: controller.signal, toolCallId: t.name, approve: async () => "allow" };
	const children: ChildProcess[] = [];
	t.after(async () => {
		controller.abort(); remember();
		for (const prior of remembered.values()) {
			const current = identities([prior.pid]).get(prior.pid);
			if (alive(current) && current!.birth === prior.birth && current!.command.includes(root)) try { process.kill(prior.pid, "SIGKILL"); } catch { /* Gone. */ }
		}
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await until(() => [...identities(pids()).values()].every(p => !alive(p)), "owned fixture processes must be gone");
		rmSync(root, { recursive: true, force: true });
	});
	return { root, script, ctx, blobs, controller, remember, pids, children,
		argv: (mode: string) => [process.execPath, script, root, mode, "parent"],
		async ready() { await until(() => existsSync(join(root, "descendant.pid")), "descendant must start"); return remember(); },
		unrelated() { const child = spawn(process.execPath, [script, root, "unrelated", "unrelated"], { detached: true, stdio: "ignore" }); children.push(child); return child; },
	};
}
async function within<T>(pending: Promise<T>, milliseconds = 6500): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("command exceeded the cleanup deadline")), milliseconds); })]); }
	finally { clearTimeout(timer); }
}

async function sandboxRun(t: TestContext, f: ReturnType<typeof fixture>, mode: string, timeout: number) {
	const entry = join(f.root, "sandbox.mjs"), profile = join(f.root, "sandbox.sb"), output = join(f.root, "result.json");
	writeFileSync(profile, '(version 1)\n(allow default)\n(deny process-exec (literal "/bin/ps"))\n');
	writeFileSync(entry, `import{writeFileSync}from'node:fs';import cp from'node:child_process';import{createCommandTool,DEFAULT_COMMAND_LIMITS}from${JSON.stringify(new URL("../src/command.ts", import.meta.url).href)};import{Workspace,FileStateTracker,BlobStore}from${JSON.stringify(new URL("../src/workspace.ts", import.meta.url).href)};let psThrown;try{cp.execFile('/bin/ps',['-p',String(process.pid)],()=>{})}catch(e){psThrown=e.code}const root=${JSON.stringify(f.root)},started=Date.now();const result=await createCommandTool({...DEFAULT_COMMAND_LIMITS,defaultTimeoutMs:${timeout},captureMaxBytes:4096}).execute({argv:${JSON.stringify(f.argv(mode))}},{workspace:new Workspace(root),files:new FileStateTracker(),blobs:new BlobStore(root+'/blobs',{workspaceRoot:root,sessionId:'posix-lifecycle'}),signal:new AbortController().signal,toolCallId:${JSON.stringify(t.name)},approve:async()=> 'allow'});writeFileSync(${JSON.stringify(output)},JSON.stringify({result,elapsed:Date.now()-started,psThrown}));`);
	const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, entry], { env: { PATH: `/bin:/usr/bin:${dirname(process.execPath)}`, HOME: f.root, TMPDIR: f.root }, stdio: ["ignore", "ignore", "pipe"] });
	f.children.push(child); const stderr: Buffer[] = []; child.stderr.on("data", c => stderr.push(c));
	const finished = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString() || `exit ${code}`))); });
	const observe = setInterval(f.remember, 20);
	try { await within(finished); } finally { clearInterval(observe); }
	return JSON.parse(readFileSync(output, "utf8")) as { result: ToolResult; elapsed: number; psThrown: string };
}

test("real macOS sandbox synchronous ps rejection cannot suppress timeout signals", { skip: process.platform !== "darwin", timeout: 10_000 }, async t => {
	const f = fixture(t), unrelated = f.unrelated();
	const { result, elapsed, psThrown } = await sandboxRun(t, f, "resistant", 1000);
	assert.equal(psThrown, "EPERM"); assert.equal(result.ok, false); assert.equal(result.details.timedOut, true); assert.equal(result.details.signal, "SIGKILL");
	assert.ok(elapsed < 4200, `${elapsed}ms must include only the timeout and bounded cleanup`);
	await until(() => f.pids().filter(pid => pid !== unrelated.pid).every(pid => !alive(identities([pid]).get(pid))), "the resistant command group must stop");
	assert.ok(alive(identities([unrelated.pid!]).get(unrelated.pid!)), "an unrelated same-name process must survive");
	assert.equal(result.details.processTreeCleanupConfirmed, undefined, "do not invent a whole-tree guarantee");
});

test("parent exit with inherited pipes and unavailable identities returns explicit partial failure", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
	const f = fixture(t); const { result, elapsed } = await sandboxRun(t, f, "parent-exits", 5000);
	assert.equal(result.ok, false); assert.equal(result.details.exitCode, 0); assert.equal(result.details.timedOut, false);
	assert.equal(result.details.processTreeCleanupConfirmed, false); assert.equal(result.details.captureComplete, false); assert.equal(result.fullOutputRef, undefined);
	assert.equal(typeof result.details.partialOutputRef, "string"); assert.match(result.modelContent, /清理未确认/); assert.doesNotMatch(result.modelContent, /fullOutputRef=/);
	assert.ok(elapsed < 2000, `${elapsed}ms must not wait for the whole command timeout`);
	assert.equal(f.blobs.inspectCommand(String(result.details.partialOutputRef), t.name, { maxArchiveBytes: 4096 })?.commandState.captureComplete, false);
	const descendant = Number(readFileSync(join(f.root, "descendant.pid"), "utf8"));
	assert.ok(alive(identities([descendant]).get(descendant)), "without an identity do not guess the exited parent's old process group; fixture cleanup owns this survivor");
});

for (const mode of ["normal", "nonzero"]) test(`ps rejection preserves ${mode} command output and real exit status`, { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
	const f = fixture(t); const { result } = await sandboxRun(t, f, mode, 5000);
	assert.equal(result.ok, mode === "normal"); assert.equal(result.details.exitCode, mode === "normal" ? 0 : 7);
	assert.equal(result.details.captureComplete, true); assert.ok(result.fullOutputRef); assert.equal(result.details.processTreeCleanupConfirmed, undefined);
	assert.match(result.modelContent, /complete stdout/); assert.match(result.modelContent, /complete stderr/);
	assert.deepEqual(f.blobs.inspectCommand(result.fullOutputRef!, t.name, { maxArchiveBytes: 4096 })?.bytes.toString().split("\n").filter(Boolean).sort(), ["complete stderr", "complete stdout"]);
});

test("a late process snapshot cannot send signals after forced pipe closure returns", { skip: process.platform !== "darwin", timeout: 9000 }, async t => {
	const f = fixture(t), original = childProcess.execFile, signals: number[] = [], realKill = process.kill;
	const mocked = t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
		if (args[0] !== "/bin/ps") return Reflect.apply(original, childProcess, args);
		const callback = args.at(-1) as (...values: unknown[]) => void;
		args[args.length - 1] = (...values: unknown[]) => { setTimeout(() => callback(...values), 2400); };
		return Reflect.apply(original, childProcess, args);
	});
	syncBuiltinESMExports();
	t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => { signals.push(pid); return realKill(pid, signal); });
	try {
		const pending = createCommandTool().execute({ argv: f.argv("parent-exits"), timeoutMs: 5000 }, f.ctx);
		await f.ready(); const result = await within(pending);
		assert.equal(result.ok, false); assert.equal(result.details.processTreeCleanupConfirmed, false);
		const count = signals.length; await delay(2700);
		assert.equal(signals.length, count, "late identity reads and old timers must not signal after return");
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("a changed descendant identity is retired without signaling a reused PID", { skip: process.platform !== "darwin", timeout: 10_000 }, async t => {
	const f = fixture(t), original = childProcess.execFile; let changed = false, descendant = 0;
	const signals: number[] = [], realKill = process.kill;
	const mocked = t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
		if (args[0] !== "/bin/ps") return Reflect.apply(original, childProcess, args);
		const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
		args[args.length - 1] = (error: unknown, stdout: string, stderr: string) => callback(error, changed ? stdout.split("\n").map(line => Number(line.trim().split(/\s+/)[0]) === descendant ? line.replace(/\S+\s*$/, "/different-process-identity") : line).join("\n") : stdout, stderr);
		return Reflect.apply(original, childProcess, args);
	});
	syncBuiltinESMExports();
	t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => { signals.push(pid); return realKill(pid, signal); });
	try {
		const pending = createCommandTool().execute({ argv: f.argv("detached"), timeoutMs: 5000 }, f.ctx);
		await f.ready(); descendant = Number(readFileSync(join(f.root, "descendant.pid"), "utf8")); await delay(500);
		changed = true; await delay(300); f.controller.abort(); const result = await within(pending);
		assert.equal(result.details.cancelled, true); assert.ok(!signals.includes(descendant)); assert.ok(!signals.includes(-descendant));
		assert.ok(alive(identities([descendant]).get(descendant)), "the changed identity must be left for independently verified fixture cleanup");
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
