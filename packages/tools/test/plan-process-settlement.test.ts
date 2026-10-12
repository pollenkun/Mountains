import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runQueryProcess } from "../src/plan.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";

async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		})]);
	} finally { clearTimeout(timer); }
}
async function waitFor(predicate: () => boolean, ms: number, message: string): Promise<void> {
	const end = Date.now() + ms;
	while (!predicate()) {
		assert.ok(Date.now() < end, message);
		await delay(10);
	}
}
function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-query-process-"));
	const controller = new AbortController();
	const ctx: ToolContext = {
		workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal,
		toolCallId: "query-process-lifecycle", approve: async () => { throw new Error("read only"); },
	};
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, controller, ctx };
}

/** A finite wrapper and finite pipe holder, with an explicit cooperative test cleanup. */
function pipeFixture(t: TestContext, root: string, wrapperExits: boolean) {
	const wrapper = join(root, "wrapper.cjs");
	const holder = join(root, "holder.cjs");
	const ready = join(root, "ready");
	const spawned = join(root, "spawned");
	const stop = join(root, "stop");
	const done = join(root, "done");
	writeFileSync(holder, `
		const fs = require("node:fs");
		process.on("exit", () => fs.writeFileSync(${JSON.stringify(done)}, "done"));
		setTimeout(() => process.exit(0), 10000);
		setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 10);
		process.send("ready");
	`);
	writeFileSync(wrapper, `
		const fs = require("node:fs");
		const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(holder)}], {
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		fs.writeFileSync(${JSON.stringify(spawned)}, "spawned");
		setTimeout(() => process.exit(0), 10000);
		child.on("message", () => {
			child.disconnect();
			child.unref();
			fs.writeFileSync(${JSON.stringify(ready)}, "ready");
			if (${wrapperExits}) process.exit(0);
		});
	`);
	let direct: ChildProcess | undefined;
	const original = childProcess.spawn;
	const mocked = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
		const child = Reflect.apply(original, childProcess, args);
		if (Array.isArray(args[1]) && args[1][0] === wrapper) direct = child;
		return child;
	});
	syncBuiltinESMExports();
	const clean = async () => {
		// Keep the stop file present until the holder confirms exit, even on assertion failure.
		writeFileSync(stop, "stop");
		if (direct) {
			direct.kill("SIGKILL");
			direct.stdin?.destroy(); direct.stdout?.destroy(); direct.stderr?.destroy();
			await waitFor(() => direct!.exitCode !== null || direct!.signalCode !== null, 3000, "wrapper did not exit during cleanup");
		}
		if (existsSync(spawned)) await waitFor(() => existsSync(done), 12000, "finite pipe holder did not exit during cleanup");
	};
	t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
	return {
		wrapper, direct: () => direct!, ready: () => existsSync(ready), done: () => existsSync(done), clean,
	};
}

for (const wrapperExits of [false, true]) {
	test(`query cancellation settles with inherited pipes after wrapper ${wrapperExits ? "exit" : "termination"}`, { timeout: 20000 }, async t => {
		const { root, ctx, controller } = setup(t);
		const fixture = pipeFixture(t, root, wrapperExits);
		const outcome = runQueryProcess(process.execPath, [fixture.wrapper], ctx, Date.now() + 15000, 1024)
			.then(value => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
		try {
			await waitFor(fixture.ready, 5000, "pipe holder did not start");
			if (wrapperExits) await waitFor(() => fixture.direct().exitCode === 0, 3000, "wrapper did not exit");
			controller.abort();
			const result = await bounded(outcome, 1000, "query remained pending after cancellation");
			assert.match(result.error?.message ?? "", /Query cancelled/);
			assert.equal(result.value, undefined);
			assert.equal(fixture.done(), false, "query must settle before inherited pipes close");
			assert.equal(fixture.direct().stdin?.destroyed, true);
			assert.equal(fixture.direct().stdout?.destroyed, true);
			assert.equal(fixture.direct().stderr?.destroyed, true);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally { await fixture.clean(); }
		await outcome;
	});
}

test("query deadline settles while a finite descendant still holds both output pipes", { timeout: 20000 }, async t => {
	const { root, ctx, controller } = setup(t);
	const fixture = pipeFixture(t, root, false);
	const deadline = Date.now() + 3000;
	const outcome = runQueryProcess(process.execPath, [fixture.wrapper], ctx, deadline, 1024)
		.then(value => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
	try {
		await waitFor(fixture.ready, 2500, "pipe holder must start before the query deadline");
		const result = await bounded(outcome, Math.max(1, deadline - Date.now()) + 1000, "query remained pending after its deadline");
		assert.match(result.error?.message ?? "", /Query time limit exceeded/);
		assert.equal(result.value, undefined);
		assert.equal(fixture.done(), false, "query must settle before inherited pipes close");
		assert.equal(fixture.direct().stdin?.destroyed, true);
		assert.equal(fixture.direct().stdout?.destroyed, true);
		assert.equal(fixture.direct().stderr?.destroyed, true);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally { await fixture.clean(); }
	await outcome;
});

test("query processes still drain complete output and accept rg exit codes zero and one", async t => {
	const { ctx, controller } = setup(t);
	const input = Buffer.from("needle\n".repeat(50000));
	for (const code of [0, 1]) {
		const script = `process.stdin.pipe(process.stdout); process.exitCode = ${code};`;
		const result = await runQueryProcess(process.execPath, ["-e", script], ctx, Date.now() + 5000, input.length, input);
		assert.equal(result.code, code);
		assert.equal(result.bytes, input.length);
		assert.equal(result.stdout, input.toString("utf8"));
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	}
});

test("query process failures keep their existing failure classifications", async t => {
	const { root, ctx, controller } = setup(t);
	for (const [script, maxBytes, expected] of [
		['process.stdout.write("too long");', 2, /output limit exceeded/],
		['process.stderr.write("diagnostic");', 1024, /failed or incomplete: diagnostic/],
		['process.exitCode = 2;', 1024, /failed or incomplete: 2/],
	] as const) {
		await assert.rejects(runQueryProcess(process.execPath, ["-e", script], ctx, Date.now() + 5000, maxBytes), expected);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	}
	await assert.rejects(runQueryProcess(join(root, "missing-command"), [], ctx, Date.now() + 5000, 1024), /ENOENT/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
