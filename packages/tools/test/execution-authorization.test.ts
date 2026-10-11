import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createCommandTool, createEditTool, createWriteTool, FileStateTracker, sha256, Workspace, type ToolContext, type ToolResult } from "../src/index.ts";

const quotedFilename = process.platform === "win32" ? "a 'file'.txt" : 'a "file".txt';
const revoked = "execution authorization revoked";
const commandOptions = { timeout: process.platform === "win32" ? 20_000 : 10_000 };
const fileOptions = { timeout: 10_000 };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mountains-execution-authorization-")));
	const controller = new AbortController();
	t.after(() => { controller.abort(); rmSync(root, { recursive: true, force: true }); });
	const ctx: ToolContext = {
		workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal,
		toolCallId: t.name, approve: async () => "allow",
	};
	return { root, ctx, controller };
}

function sentinelCommand() {
	return { argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("sentinel.txt", "command really ran\\n")'], timeoutMs: process.platform === "win32" ? 15_000 : 5000 };
}

const scenarios = [
	{ name: "create", original: null, edit: false, args: { content: "新文件\r\n没有末尾换行" }, after: "新文件\r\n没有末尾换行" },
	{ name: "single edit", original: "alpha\r\nbeta\r\n末尾没有换行", edit: true, args: { oldText: "alpha\nbeta", newText: "甲\n乙" }, after: "甲\r\n乙\r\n末尾没有换行" },
	{ name: "batch edit", original: "alpha\r\nbeta\r\n末尾没有换行", edit: true, args: { edits: [{ oldText: "alpha", newText: "甲" }, { oldText: "beta", newText: "乙" }] }, after: "甲\r\n乙\r\n末尾没有换行" },
	{ name: "overwrite", original: "original bytes\r\n末尾没有换行", edit: false, args: { content: "覆盖后的字节\n", createOnly: false, expectedHash: sha256("original bytes\r\n末尾没有换行") }, after: "覆盖后的字节\n" },
] satisfies { name: string; original: string | null; edit: boolean; args: Record<string, unknown>; after: string }[];

function fileFixture(t: TestContext, scenario: typeof scenarios[number], approveFileWrites = true) {
	const f = fixture(t);
	const rel = `目录/${quotedFilename}`;
	const path = join(f.root, rel);
	const originalBytes = scenario.original === null ? null : Buffer.from(scenario.original);
	if (originalBytes !== null) {
		mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, originalBytes);
		f.ctx.files.record(rel, sha256(originalBytes));
	}
	const tool = scenario.edit ? createEditTool({ batch: true, approveFileWrites }) : createWriteTool({ approveFileWrites });
	const unchanged = () => {
		if (originalBytes === null) {
			assert.equal(existsSync(path), false, "Revocation must not create the requested file");
			assert.equal(existsSync(dirname(path)), false, "Revocation must not create a parent directory");
		} else {
			assert.deepEqual(readFileSync(path), originalBytes, "Revocation must preserve every original byte");
			assert.ok(!readdirSync(dirname(path)).some(name => name.endsWith(".tmp")), "No temporary mutation file may be left behind");
		}
	};
	return { ...f, path, tool, args: { path: rel, ...scenario.args }, unchanged };
}

test("omitting the execution hook still starts the real approved command", commandOptions, async t => {
	const f = fixture(t);
	assert.equal(f.ctx.assertExecutionAllowed, undefined);
	const result = await createCommandTool().execute(sentinelCommand(), f.ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(result.details.exitCode, 0);
	assert.equal(readFileSync(join(f.root, "sentinel.txt"), "utf8"), "command really ran\n");
});

test("a failing final execution hook prevents the real command from spawning", commandOptions, async t => {
	const f = fixture(t);
	let checks = 0;
	f.ctx.assertExecutionAllowed = () => { checks++; throw new Error(revoked); };
	const result = await createCommandTool().execute(sentinelCommand(), f.ctx);
	assert.equal(checks, 1);
	assert.equal(result.ok, false);
	assert.match(result.modelContent, /execution authorization revoked/);
	assert.equal(result.details.exitCode, undefined);
	assert.equal(existsSync(join(f.root, "sentinel.txt")), false);
	assert.equal(f.controller.signal.aborted, false, "Revocation must be distinct from cancellation");
});

test("revocation while command approval waits prevents spawning even after a late allow", commandOptions, async t => {
	const f = fixture(t);
	const entered = deferred<void>();
	const approval = deferred<"allow">();
	t.after(() => approval.resolve("allow"));
	let authorized = true;
	let checks = 0;
	f.ctx.approve = async () => { entered.resolve(); return approval.promise; };
	f.ctx.assertExecutionAllowed = () => { checks++; if (!authorized) throw new Error(revoked); };
	const running = createCommandTool().execute(sentinelCommand(), f.ctx);
	await entered.promise;
	assert.equal(existsSync(join(f.root, "sentinel.txt")), false);
	authorized = false;
	approval.resolve("allow");
	const result = await running;
	assert.equal(checks, 1, "Authorization must be checked after approval resolves");
	assert.equal(result.ok, false);
	assert.match(result.modelContent, /execution authorization revoked/);
	assert.equal(existsSync(join(f.root, "sentinel.txt")), false);
	assert.equal(f.controller.signal.aborted, false);
});

for (const scenario of scenarios) {
	test(`${scenario.name}: omitting the hook preserves both legacy and approved file writes`, fileOptions, async t => {
		for (const approveFileWrites of [false, true]) {
			const f = fileFixture(t, scenario, approveFileWrites);
			assert.equal(f.ctx.assertExecutionAllowed, undefined);
			const result = await f.tool.execute(f.args, f.ctx);
			assert.equal(result.ok, true, result.modelContent);
			assert.deepEqual(readFileSync(f.path), Buffer.from(scenario.after));
			assert.equal(result.writes?.length, 1);
		}
	});

	test(`${scenario.name}: a failing hook preserves file bytes and reports no write`, fileOptions, async t => {
		const f = fileFixture(t, scenario);
		let checks = 0;
		f.ctx.assertExecutionAllowed = () => { checks++; throw new Error(revoked); };
		const result = await f.tool.execute(f.args, f.ctx);
		assert.equal(checks, 1);
		assert.equal(result.ok, false);
		assert.match(result.modelContent, /execution authorization revoked/);
		assert.equal(result.writes, undefined);
		f.unchanged();
	});

	test(`${scenario.name}: revocation during the final beforeWrite wait prevents atomic commit`, fileOptions, async t => {
		const f = fileFixture(t, scenario);
		const entered = deferred<void>();
		const checkpoint = deferred<void>();
		t.after(() => checkpoint.resolve());
		let authorized = true;
		let checks = 0;
		f.ctx.assertExecutionAllowed = () => { checks++; if (!authorized) throw new Error(revoked); };
		f.ctx.beforeWrite = async path => {
			assert.equal(path, f.path);
			f.unchanged(); entered.resolve(); await checkpoint.promise;
		};
		const running = f.tool.execute(f.args, f.ctx);
		await entered.promise;
		assert.equal(checks, 0, "The final authorization check must follow the last asynchronous wait");
		f.unchanged();
		authorized = false;
		checkpoint.resolve();
		const result = await running;
		assert.equal(checks, 1);
		assert.equal(result.ok, false);
		assert.match(result.modelContent, /execution authorization revoked/);
		assert.equal(result.writes, undefined);
		assert.equal(f.controller.signal.aborted, false);
		f.unchanged();
	});
}

test("changing authorization after a real command starts does not interrupt that command", commandOptions, async t => {
	const f = fixture(t);
	const started = join(f.root, "started.txt");
	const completed = join(f.root, "completed.txt");
	const release = join(f.root, "release.txt");
	let authorized = true;
	let checks = 0;
	f.ctx.assertExecutionAllowed = () => { checks++; if (!authorized) throw new Error(revoked); };
	// A local file barrier makes the order deterministic. No child can complete
	// before the parent has changed authorization, regardless of machine speed.
	const script = 'const fs = require("node:fs"); fs.writeFileSync("started.txt", "started\\n"); const poll = setInterval(() => { if (fs.existsSync("release.txt")) { clearInterval(poll); fs.writeFileSync("completed.txt", "completed\\n"); } }, 10); setTimeout(() => { process.exit(2); }, 4000).unref();';
	const running = createCommandTool().execute({ argv: [process.execPath, "-e", script], timeoutMs: process.platform === "win32" ? 15_000 : 5000 }, f.ctx);
	let result: ToolResult | null = null;
	try {
		const deadline = Date.now() + (process.platform === "win32" ? 12_000 : 3000);
		while (!existsSync(started) && Date.now() < deadline) await delay(10);
		assert.equal(existsSync(started), true, "The real child must start before authorization changes");
		assert.equal(existsSync(completed), false);
		assert.equal(checks, 1);
		authorized = false;
		writeFileSync(release, "finish this started command\n");
		result = await running;
		assert.equal(result.ok, true, result.modelContent);
		assert.equal(result.details.exitCode, 0);
		assert.equal(result.details.cancelled, false);
		assert.equal(f.controller.signal.aborted, false);
		assert.equal(checks, 1, "A started command must not receive another final execution check");
		assert.equal(readFileSync(completed, "utf8"), "completed\n");
	} finally {
		if (!result) { f.controller.abort(); await running; }
	}
});
