import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createCommandTool, DEFAULT_COMMAND_LIMITS, type CommandLimits } from "../src/command.ts";
import { BlobStore, FileStateTracker, Workspace } from "../src/workspace.ts";
import type { ToolContext } from "../src/types.ts";

const MiB = 1024 * 1024;
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "command-capture-limit-"));
	const controller = new AbortController();
	const blobs = new BlobStore(join(root, "blobs"), { workspaceRoot: root, sessionId: "free-command-test" });
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), blobs,
		signal: controller.signal, toolCallId: t.name, approve: async () => "allow" };
	t.after(() => { controller.abort(); rmSync(root, { recursive: true, force: true }); });
	const write = (name: string, script: string) => { const path = join(root, name); writeFileSync(path, script); return path; };
	return { root, controller, ctx, blobs, write };
}

test("capture limits validate before spawn; zero and nonfinite values cannot disable the ceiling", () => {
	for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "4096", null]) {
		assert.throws(() => createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: value } as CommandLimits), /captureMaxBytes/);
	}
	assert.doesNotThrow(() => createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 1 }));
	const ordinary = createCommandTool(), bounded = createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 4 * MiB });
	assert.equal(bounded.description, ordinary.description, "host capture policy must not alter frozen-model tool descriptions");
	assert.deepEqual(bounded.parameters, ordinary.parameters);
});

for (const mode of ["continuous", "single-write"] as const) {
	test(`32 MiB ${mode} producer keeps only 4 MiB and never claims a full archive`, { timeout: process.platform === "win32" ? 30_000 : 10_000 }, async t => {
		const f = fixture(t);
		const script = f.write(`${mode}.cjs`, mode === "continuous"
			? "const b=Buffer.alloc(65536,97);let i=0;function send(){while(i<512){i++;if(!process.stdout.write(b)){process.stdout.once('drain',send);return;}}}send();"
			: "process.stdout.write(Buffer.alloc(32*1024*1024,98));");
		const result = await createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 4 * MiB })
			.execute({ argv: [process.execPath, script], timeoutMs: process.platform === "win32" ? 15_000 : 5000 }, f.ctx);
		assert.equal(result.ok, false);
		assert.equal(result.details.outputLimited, true);
		assert.equal(result.details.captureComplete, false);
		assert.equal(result.details.outputBytes, 4 * MiB);
		assert.ok(Number(result.details.observedOutputBytes) > 4 * MiB);
		assert.equal(result.fullOutputRef, undefined);
		assert.match(result.modelContent, /command stopped; remaining output discarded/);
		assert.doesNotMatch(result.modelContent, /fullOutputRef=|output truncated, full /);
		assert.equal(typeof result.details.partialOutputRef, "string");
		const archive = f.blobs.inspectCommand(String(result.details.partialOutputRef), f.ctx.toolCallId, { maxArchiveBytes: 4 * MiB });
		assert.ok(archive);
		assert.equal(archive.bytes.length, 4 * MiB);
		assert.equal(archive.commandState.captureComplete, false);
		assert.equal(archive.bytes.every(byte => byte === (mode === "continuous" ? 97 : 98)), true);
	});
}

test("exact capture cap keeps every byte, including shared stdout/stderr, and remains a complete archive", async t => {
	const f = fixture(t), bytes = 128 * 1024;
	const script = f.write("exact.cjs", `process.stdout.write(Buffer.alloc(${bytes / 2},97));process.stderr.write(Buffer.alloc(${bytes / 2},98));`);
	const result = await createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: bytes })
		.execute({ argv: [process.execPath, script] }, f.ctx);
	assert.equal(result.ok, true);
	assert.equal(result.details.captureComplete, true);
	assert.equal(result.details.outputLimited, false);
	assert.equal(result.details.outputBytes, bytes);
	assert.ok(result.fullOutputRef);
	const archive = f.blobs.inspectCommand(result.fullOutputRef, f.ctx.toolCallId, { maxArchiveBytes: bytes });
	assert.equal(archive?.commandState.captureComplete, true);
	assert.equal(archive?.bytes.filter(byte => byte === 97).length, bytes / 2);
	assert.equal(archive?.bytes.filter(byte => byte === 98).length, bytes / 2);
});

test("a fast zero exit is still a failed command when its shared stream exceeds the cap", async t => {
	const f = fixture(t), script = f.write("fast.cjs", "process.stdout.write('a'.repeat(512));process.stderr.write('b'.repeat(512));");
	const result = await createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 800 }).execute({ argv: [process.execPath, script] }, f.ctx);
	assert.equal(result.ok, false);
	assert.equal(result.details.outputLimited, true);
	assert.equal(result.details.outputBytes, 800);
	assert.equal(result.details.captureComplete, false);
	assert.equal(result.fullOutputRef, undefined);
});

test("a bounded nonzero exit preserves the real exit code without confusing failure with incomplete capture", async t => {
	const f = fixture(t), script = f.write("nonzero.cjs", "process.stdout.write('failure details');process.exitCode=7;");
	const result = await createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 1024 }).execute({ argv: [process.execPath, script] }, f.ctx);
	assert.equal(result.ok, false);
	assert.equal(result.details.exitCode, 7);
	assert.equal(result.details.captureComplete, true);
	assert.equal(result.details.outputLimited, false);
	assert.equal(result.details.outputBytes, Buffer.byteLength("failure details"));
	assert.ok(result.fullOutputRef);
});

test("capture options are pinned after construction and a UTF-8 cut stays explicitly partial", async t => {
	const f = fixture(t), limits = { ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 2 };
	const tool = createCommandTool(limits);
	limits.captureMaxBytes = 1000;
	const result = await tool.execute({ argv: [process.execPath, "-e", "process.stdout.write('中');"] }, f.ctx);
	assert.equal(result.details.outputBytes, 2);
	assert.equal(result.details.captureMaxBytes, 2);
	assert.equal(result.details.invalidUtf8, true);
	assert.equal(result.details.captureComplete, false);
	assert.equal(result.fullOutputRef, undefined);
});

test("no capture ceiling preserves the original full-output behavior and archive metadata", async t => {
	const f = fixture(t), result = await createCommandTool().execute({ argv: [process.execPath, "-e", "process.stdout.write('original');"] }, f.ctx);
	assert.equal(result.ok, true);
	assert.equal(Object.hasOwn(result.details, "outputLimited"), false);
	assert.equal(Object.hasOwn(result.details, "captureComplete"), false);
	assert.ok(result.fullOutputRef);
	assert.equal(Object.hasOwn(f.blobs.inspectCommand(result.fullOutputRef, f.ctx.toolCallId, { maxArchiveBytes: 1024 })!.commandState, "captureComplete"), false);
});

test("an output ceiling and a later user cancellation do not postpone killing a resistant process group", { skip: process.platform !== "darwin" && process.platform !== "linux", timeout: 10_000 }, async t => {
	const f = fixture(t), pidfile = join(f.root, "child.pid");
	const child = f.write("resistant.cjs", "require('node:fs').writeFileSync(process.argv[2],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
	const parent = f.write("tree.cjs", "const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'});setTimeout(()=>process.stdout.write(Buffer.alloc(32*1024*1024,97)),600);setInterval(()=>{},1000);");
	let ownPid: number | undefined;
	t.after(() => {
		if (ownPid) {
			try {
				const command = execFileSync("ps", ["-p", String(ownPid), "-o", "command="], { encoding: "utf8" });
				if (command.includes(child)) process.kill(ownPid, "SIGKILL");
			} catch { /* Exact fixture process already ended. */ }
		}
	});
	const started = Date.now();
	const task = createCommandTool({ ...DEFAULT_COMMAND_LIMITS, captureMaxBytes: 4 * MiB }).execute({ argv: [process.execPath, parent, child, pidfile] }, f.ctx);
	for (let i = 0; i < 100 && !existsSync(pidfile); i++) await new Promise(r => setTimeout(r, 10));
	assert.ok(existsSync(pidfile));
	ownPid = Number(readFileSync(pidfile, "utf8"));
	const timer = setTimeout(() => f.controller.abort(), 950);
	const result = await task;
	clearTimeout(timer);
	assert.equal(result.ok, false);
	assert.equal(result.details.outputLimited, true);
	assert.equal(result.details.cancelled, true);
	assert.ok(Date.now() - started < 3500, "user cancellation cannot extend the first kill deadline");
	let state = "";
	try { state = execFileSync("ps", ["-p", String(ownPid), "-o", "stat="], { encoding: "utf8" }).trim(); } catch { /* Process gone. */ }
	assert.ok(!state || state.startsWith("Z"), `tracked resistant child must stop; got ${state}`);
});

test("custom credential variables are removed from command and ps environments without touching the parent", async t => {
	const f = fixture(t), name = `MODEL_ACCESS_${randomUUID().replaceAll("-", "_")}`;
	const fake = `offline-custom-auth-${randomUUID()}`;
	assert.equal(process.env[name], undefined);
	process.env[name] = fake;
	t.after(() => { delete process.env[name]; });
	const omitted = [name], tool = createCommandTool({ ...DEFAULT_COMMAND_LIMITS, omitEnv: omitted });
	omitted.length = 0;
	const original = childProcess.execFile;
	let psCalls = 0;
	const mock = t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
		if (args[0] === "/bin/ps") {
			psCalls++;
			assert.equal((args[2] as { env: NodeJS.ProcessEnv }).env[name], undefined);
		}
		return Reflect.apply(original, childProcess, args);
	});
	syncBuiltinESMExports();
	try {
		const result = await tool.execute({ argv: [process.execPath, "-e", "process.stdout.write(process.env[process.argv[1]]??'absent');", name] }, f.ctx);
		assert.equal(result.ok, true);
		assert.match(result.modelContent, /absent/);
		assert.equal(JSON.stringify(result).includes(fake), false);
		assert.equal(process.env[name], fake);
		if (process.platform === "darwin") assert.ok(psCalls > 0);
	} finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("explicit environment omissions reject malformed configuration before execution", () => {
	for (const omitEnv of ["MODEL_ACCESS", [""], ["A=B"], ["A\0B"], [3], null]) {
		assert.throws(() => createCommandTool({ ...DEFAULT_COMMAND_LIMITS, omitEnv } as CommandLimits), /omitEnv/);
	}
});
