import assert from "node:assert/strict";
import childProcess, { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
function processRunning(pid: number): boolean {
	try { process.kill(pid, 0); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
	if (process.platform === "win32") return true;
	// An orphan can remain as a zombie until the host reaps it; it has already
	// released its cwd and pipes and must not be mistaken for a running fixture.
	const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1000 });
	assert.ifError(status.error);
	assert.ok(status.status === 0 || status.status === 1, status.stderr);
	return status.stdout.trim() !== "" && !status.stdout.trim().startsWith("Z");
}
function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-query-process-"));
	const controller = new AbortController();
	const ctx: ToolContext = {
		workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal,
		toolCallId: "query-process-lifecycle", approve: async () => { throw new Error("read only"); },
	};
	// Windows may release directory handles shortly after the fixture exits.
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	return { root, controller, ctx };
}

/** A finite wrapper and finite pipe holder, with an explicit cooperative test cleanup. */
function pipeFixture(t: TestContext, root: string, wrapperExits: boolean) {
	const wrapper = join(root, "wrapper.cjs");
	const holder = join(root, "holder.cjs");
	const ready = join(root, "ready");
	const spawned = join(root, "spawned");
	const stop = join(root, "stop");
	writeFileSync(holder, `
		const fs = require("node:fs");
		setTimeout(() => process.exit(0), 10000);
		setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 10);
		fs.writeFileSync(${JSON.stringify(ready)}, "ready");
	`);
	writeFileSync(wrapper, `
		const fs = require("node:fs");
		const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(holder)}], {
			stdio: ["ignore", "inherit", "inherit"],
			// Windows otherwise ends this child with its wrapper. Keep the finite
			// holder independent so inherited pipes really outlive the direct child.
			detached: process.platform === "win32", windowsHide: true,
		});
		fs.writeFileSync(${JSON.stringify(spawned)}, String(child.pid));
		child.unref();
		setTimeout(() => process.exit(0), 10000);
		if (${wrapperExits}) setInterval(() => {
			if (fs.existsSync(${JSON.stringify(ready)})) process.exit(0);
		}, 10);
	`);
	let direct: ChildProcess | undefined;
	const original = childProcess.spawn;
	const mocked = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
		const child = Reflect.apply(original, childProcess, args);
		if (Array.isArray(args[1]) && args[1][0] === wrapper) direct = child;
		return child;
	});
	syncBuiltinESMExports();
	const holderRunning = () => {
		if (!existsSync(spawned)) return false;
		const pid = Number(readFileSync(spawned, "utf8"));
		assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid, "holder must have a real PID");
		return processRunning(pid);
	};
	const clean = async () => {
		// Keep the stop file until the actual process exits. An abrupt process
		// exit need not run a JavaScript exit handler on every platform.
		writeFileSync(stop, "stop");
		if (direct) {
			direct.kill("SIGKILL");
			direct.stdin?.destroy(); direct.stdout?.destroy(); direct.stderr?.destroy();
			await waitFor(() => direct!.exitCode !== null || direct!.signalCode !== null, 3000, "wrapper did not exit during cleanup");
		}
		await waitFor(() => !holderRunning(), 12000, "finite pipe holder did not exit during cleanup");
	};
	t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
	return {
		wrapper, direct: () => direct!, ready: () => existsSync(ready) && existsSync(spawned), holderRunning, clean,
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
			assert.equal(fixture.holderRunning(), true, "the descendant must be holding inherited pipes before cancellation");
			controller.abort();
			const result = await bounded(outcome, 1000, "query remained pending after cancellation");
			assert.match(result.error?.message ?? "", /Query cancelled/);
			assert.equal(result.value, undefined);
			assert.ok(fixture.direct().exitCode !== null || fixture.direct().signalCode !== null, "query must wait for direct child exit");
			assert.equal(fixture.holderRunning(), true, "query must settle while the descendant still holds inherited pipes");
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
		assert.equal(fixture.holderRunning(), true, "the descendant must be holding inherited pipes before the deadline");
		const result = await bounded(outcome, Math.max(1, deadline - Date.now()) + 1000, "query remained pending after its deadline");
		assert.match(result.error?.message ?? "", /Query time limit exceeded/);
		assert.equal(result.value, undefined);
		assert.ok(fixture.direct().exitCode !== null || fixture.direct().signalCode !== null, "query must wait for direct child exit");
		assert.equal(fixture.holderRunning(), true, "query must settle while the descendant still holds inherited pipes");
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

for (const exitArrives of [true, false]) {
	test(`query cancellation ${exitArrives ? "waits for direct child exit" : "has a bounded fallback without an exit event"}`, async t => {
		const { ctx, controller } = setup(t);
		let killed = false, unreferenced = false;
		const child = Object.assign(new EventEmitter(), {
			pid: 123, exitCode: null, signalCode: null,
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
			kill: () => { killed = true; return true; },
			unref: () => { unreferenced = true; },
		});
		const mocked = t.mock.method(childProcess, "spawn", () => child as unknown as ChildProcess);
		syncBuiltinESMExports();
		t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
		let returned = false;
		const outcome = runQueryProcess("fixture-only", [], ctx, Date.now() + 5000, 1024)
			.then(() => undefined, (error: Error) => error).finally(() => { returned = true; });
		controller.abort();
		await delay(20);
		assert.equal(returned, false, "failure must allow the direct child time to release its cwd");
		assert.equal(killed, true);
		assert.equal(child.stdin.destroyed, true);
		assert.equal(child.stdout.destroyed, true);
		assert.equal(child.stderr.destroyed, true);
		if (exitArrives) child.emit("exit", null, "SIGKILL");
		const result = await bounded(outcome, 1000, "failure must remain bounded without a direct-child exit");
		assert.match(result?.message ?? "", /Query cancelled/);
		assert.equal(unreferenced, true);
		assert.equal(child.listenerCount("exit"), 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
}
