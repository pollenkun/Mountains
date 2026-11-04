import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ToolCall } from "@mountains/protocol";
import { scrubEnv } from "@mountains/tools";
import { loadConfig } from "../src/config.ts";
import { observerHash } from "../src/tool-observer-protocol.ts";
import { RecordedModelController, WALL_CLOCK_SKEW_MS, type ModelControllerOptions } from "../../../packages/computer/test/acceptance/model-controller.ts";
import { ModelFocusObserver } from "../../../packages/computer/test/acceptance/model-focus-observer.ts";
import { focusAlive, focusBirth, focusJournal } from "../../../packages/computer/test/fixtures/focus-journal.ts";
import { isolatedEnv } from "./env.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
const write = (id: string): ToolCall => ({ id, name: "file_write", argumentsJson: JSON.stringify({ path: `${id}.txt`, content: `${id} actual content\n` }) });
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
const readLines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row));
async function fixture(t: TestContext, calls: ToolCall[], overrides: Record<string, unknown> = {}, answer?: (body: any, request: number) => ToolCall[], budgetAlias = false) {
	const root = mkdtempSync(join(tmpdir(), "mountains-cli-observer-")), home = join(root, "home"), workspace = join(root, "workspace"), outDir = join(root, "out");
	for (const dir of [home, workspace, outDir]) mkdirSync(dir);
	const requests: unknown[] = [];
	const server = http.createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk; const parsed = JSON.parse(body); requests.push(parsed);
		const selected = answer ? answer(parsed, requests.length) : requests.length === 1 ? calls : [];
		const delta = selected.length ? { role: "assistant", tool_calls: selected.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.argumentsJson } })) } : { role: "assistant", content: "Offline task complete." };
		const packet = { id: `offline-response-${requests.length}`, object: "chat.completion.chunk", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: selected.length ? "tool_calls" : "stop" }], usage };
		res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify(packet)}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
	const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const config = join(root, "config.json");
	writeFileSync(config, JSON.stringify({ checkpoints: false, requestGuard: true, skills: { enabled: false }, limits: { maxCost: 1 }, approval: { rules: [{ id: "local-fixture-only", decision: "allow" }], fallback: "deny" }, ...overrides }));
	if (budgetAlias) { for (const name of ["budget-a", "budget-b"]) mkdirSync(join(root, name)); symlinkSync(join(root, "budget-a"), join(root, "budget-route"), "dir"); }
	const spendLedger = budgetAlias ? join(root, "budget-route", "spend.jsonl") : join(outDir, "spend.jsonl"), task = "Use only this new temporary workspace for the offline tool test.", runId = "offline-controller-run";
	const expected = { runId, workspace, outDir, spendLedger, task, model: "deepseek-flash", effectiveConfigSha256: observerHash(loadConfig(config, { baseUrl }).config) };
	const env = { ...isolatedEnv(home), MOUNTAINS_BUDGET_USD: "5", MOUNTAINS_BUDGET_CNY: "5", NODE_DISABLE_COMPILE_CACHE: "1" };
	let child: ChildProcess | undefined;
	const start = (options: { ipc?: boolean; flags?: string[]; audit?: boolean } = {}) => {
		child = spawn(process.execPath, [...(options.flags ?? ["--disable-sigusr1"]), MAIN, "run", "--task", task, "--workspace", workspace, "--config", config, "--base-url", baseUrl,
			"--json", "--out", outDir, "--run-id", runId, "--spend-ledger", spendLedger, ...(options.audit === false ? [] : ["--tool-observer-ipc"])],
			{ env, stdio: options.ipc === false ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"] });
		let stdout = "", stderr = ""; child.stdout!.on("data", d => { stdout += d; }); child.stderr!.on("data", d => { stderr += d; });
		const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { child!.once("error", reject); child!.once("close", code => resolve({ code, stdout, stderr })); });
		return { child, closed };
	};
	const attach = (p: ChildProcess, options: Partial<ModelControllerOptions> = {}) => new RecordedModelController(p, { expected,
		journalPath: join(root, "controller.jsonl"), sourcePath: join(root, "cli-source.json"), assertVersion() {},
		before: async () => ({ scope: "offline-node-fixture-no-focus-claim" }), after: async () => ({ scope: "offline-node-fixture-no-focus-claim" }), ...options });
	t.after(async () => {
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			const p = child; await new Promise<void>(r => { const timer = setTimeout(() => p.kill("SIGKILL"), 2000); p.once("close", () => { clearTimeout(timer); r(); }); p.kill("SIGTERM"); });
		}
		server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true });
	});
	return { root, workspace, outDir, spendLedger, requests, expected, start, attach };
}

test("real CLI waits for durable parent proof before writing and generates its own source index after close", { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("first"), write("second")]), entered = gate(), release = gate();
	const cli = f.start(); const order: string[] = [];
	const controller = f.attach(cli.child, {
		before: async identity => {
			order.push(`before:${identity.toolCallId}`); assert.equal(existsSync(join(f.workspace, `${identity.toolCallId}.txt`)), false);
			if (identity.toolCallId === "first") { entered.release(); await release.promise; }
			return { synthetic: true };
		},
		after: async (identity, result) => {
			order.push(`after:${identity.toolCallId}`); assert.equal(result.dispatch, "returned");
			assert.equal(readFileSync(join(f.workspace, `${identity.toolCallId}.txt`), "utf8"), `${identity.toolCallId} actual content\n`); return { diskReadback: true };
		},
	});
	try {
		await Promise.race([entered.promise, cli.closed.then(r => { throw new Error(`CLI stopped before observation: ${r.stderr}`); })]);
		assert.equal(existsSync(join(f.workspace, "first.txt")), false); assert.equal(existsSync(join(f.root, "cli-source.json")), false); release.release();
		const [run, proof] = await Promise.all([cli.closed, controller.completion]); assert.equal(run.code, 0, run.stderr); assert.equal(proof.accepted, true, proof.failure ?? "");
		assert.deepEqual(order, ["before:first", "after:first", "before:second", "after:second"]);
		const source = JSON.parse(readFileSync(proof.sourcePath, "utf8")); assert.equal(source.childPid, cli.child.pid); assert.equal(source.accepted, true);
		assert.ok(source.files.some((file: any) => file.path.replaceAll("\\", "/").endsWith("/ledger.jsonl"))); assert.ok(source.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.sha256)));
		const rows = readLines(join(f.root, "controller.jsonl")), before = rows.filter(r => r.kind === "before");
		assert.equal(before.length, 2); assert.equal(before[0].source.requestId, before[1].source.requestId, "two tools share one settled model request");
		assert.notEqual(before[0].executionId, before[1].executionId); assert.equal(rows.at(-1).kind, "cli-closed");
		for (const after of rows.filter(r => r.kind === "after")) {
			const permission = rows.find(r => r.kind === "permission" && r.executionId === after.executionId); assert.ok(permission);
			assert.deepEqual(after.envelope.permitted, permission.permitted);
			assert.ok(after.envelope.requested.monotonicMs <= after.envelope.permitted.monotonicMs && after.envelope.permitted.monotonicMs <= after.envelope.received.monotonicMs);
			assert.ok(after.started.wallTimeMs + WALL_CLOCK_SKEW_MS >= permission.permitted.at && after.finished.wallTimeMs <= after.envelope.received.at + WALL_CLOCK_SKEW_MS);
		}
		assert.equal(f.requests.length, 2); assert.equal(JSON.parse(run.stdout).totals.requests, 2);
	} finally { release.release(); }
});

for (const phase of ["before", "after"] as const) test(`real CLI ${phase} controller failure stops pending tools and keeps actual artifacts`, { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("first"), write("second")]), cli = f.start();
	const syntheticSecret = "synthetic-private-callback-text";
	const controller = f.attach(cli.child, { [phase]: async () => { throw new Error(syntheticSecret); } });
	const [run, proof] = await Promise.all([cli.closed, controller.completion]); assert.equal(run.code, 1, run.stderr); assert.equal(proof.accepted, false);
	assert.equal(existsSync(join(f.workspace, "first.txt")), phase === "after"); assert.equal(existsSync(join(f.workspace, "second.txt")), false);
	assert.equal(JSON.parse(run.stdout).status, "failed"); assert.equal(f.requests.length, 1);
	assert.equal(readFileSync(join(f.root, "controller.jsonl"), "utf8").includes(syntheticSecret), false);
	assert.equal(existsSync(join(f.root, "cli-source.json")), false);
});

for (const kind of ["no-ipc", "unsafe-node-arguments"] as const) test(`explicit observer with ${kind} refuses before HTTP`, { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("never")]);
	const cli = f.start(kind === "no-ipc" ? { ipc: false } : { flags: ["--disable-sigusr1", "--enable-source-maps"] });
	const result = await cli.closed; assert.equal(result.code, 1); assert.equal(f.requests.length, 0);
	assert.equal(existsSync(join(f.workspace, "never.txt")), false); assert.match(result.stderr, /IPC|clean Node/);
});

for (const corruption of ["response-id", "argument-hash", "missing-settlement"] as const) test(`controller rejects ${corruption} corruption before actual tool execution`, { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("never")]), cli = f.start(); let changed = false;
	cli.child.prependListener("message", (packet: any) => {
		if (changed || packet.phase !== "before") return; changed = true;
		const file = corruption === "missing-settlement" ? f.spendLedger : join(f.outDir, "recording.jsonl"), rows = readLines(file);
		if (corruption === "missing-settlement") writeFileSync(file, rows.filter(r => r.kind !== "budget.settle").map(r => JSON.stringify(r) + "\n").join(""));
		else {
			const row = rows.find(r => r.kind === "model.response");
			if (corruption === "response-id") row.data.responseId = "different-offline-response";
			else row.data.toolCallIdentities[0].argumentsSha256 = "f".repeat(64);
			writeFileSync(file, rows.map(r => JSON.stringify(r) + "\n").join(""));
		}
	});
	const controller = f.attach(cli.child); const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(changed, true); assert.notEqual(run.code, 0); assert.equal(proof.accepted, false); assert.equal(existsSync(join(f.workspace, "never.txt")), false);
	assert.equal(f.requests.length, 1);
});

test("post-execution recording edits cannot turn a live result into an accepted source index", { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("written")]), cli = f.start(); let changed = false;
	cli.child.prependListener("message", (packet: any) => {
		if (packet.phase !== "finish") return;
		const file = join(f.outDir, "recording.jsonl"), rows = readLines(file), output = rows.find(r => r.kind === "tool.output");
		output.data.execution.dispatch = "not-started"; writeFileSync(file, rows.map(r => JSON.stringify(r) + "\n").join("")); changed = true;
	});
	const controller = f.attach(cli.child); const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(changed, true); assert.equal(readFileSync(join(f.workspace, "written.txt"), "utf8"), "written actual content\n");
	assert.equal(proof.accepted, false); assert.equal(existsSync(join(f.root, "cli-source.json")), false);
});

test("command tool children have no inherited observer channel", { timeout: 10_000 }, async t => {
	const script = "require('node:fs').writeFileSync('own-child.json',JSON.stringify({send:typeof process.send,connected:process.connected??false,channel:!!process.channel,fd:process.env.NODE_CHANNEL_FD??null,serialization:process.env.NODE_CHANNEL_SERIALIZATION_MODE??null}))";
	const call: ToolCall = { id: "child", name: "command_run", argumentsJson: JSON.stringify({ argv: [process.execPath, "-e", script] }) };
	const f = await fixture(t, [call]), cli = f.start(), controller = f.attach(cli.child);
	const [run, proof] = await Promise.all([cli.closed, controller.completion]); assert.equal(run.code, 0, run.stderr); assert.equal(proof.accepted, true, proof.failure ?? "");
	assert.deepEqual(JSON.parse(readFileSync(join(f.workspace, "own-child.json"), "utf8")), { send: "undefined", connected: false, channel: false, fd: null, serialization: null });
	assert.deepEqual(scrubEnv({ NODE_CHANNEL_FD: "3", NODE_CHANNEL_SERIALIZATION_MODE: "json", PATH: "/own-test" }), { PATH: "/own-test" });
});

test("an audited CLI with requestGuard disabled makes no model request", { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("never")], { requestGuard: false }), cli = f.start();
	const run = await cli.closed;
	assert.equal(run.code, 1); assert.match(run.stderr, /requestGuard/); assert.equal(f.requests.length, 0);
	assert.equal(existsSync(join(f.workspace, "never.txt")), false);
});

for (const corruption of ["result-text", "input-text", "extra-execution", "extra-agent"] as const) test(`final source checks reject ${corruption} even when CLI reports completion`, { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("written")]), cli = f.start(); let changed = false;
	cli.child.prependListener("message", (packet: any) => {
		if (packet.phase !== "finish") return;
		const file = join(f.outDir, "recording.jsonl"), rows = readLines(file), input = rows.find(r => r.kind === "tool.input"), output = rows.find(r => r.kind === "tool.output");
		if (corruption === "result-text") {
			const original = output.data.modelContent;
			output.data.modelContent = (original[0] === "X" ? "Y" : "X") + original.slice(1);
			assert.equal(Buffer.byteLength(output.data.modelContent), Buffer.byteLength(original));
			writeFileSync(file, rows.map(r => JSON.stringify(r) + "\n").join(""));
		} else if (corruption === "input-text") {
			input.data.arguments = input.data.arguments.replace("actual content", "forged content");
			writeFileSync(file, rows.map(r => JSON.stringify(r) + "\n").join(""));
		} else if (corruption === "extra-execution") {
			const executionId = randomUUID();
			for (const row of [input, output]) { const extra = structuredClone(row); extra.data.executionId = executionId; appendFileSync(file, JSON.stringify(extra) + "\n"); }
		} else {
			const dir = join(f.outDir, "agents", "forged"); mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "recording.jsonl"), rows.map(r => JSON.stringify(r) + "\n").join(""));
			writeFileSync(join(dir, "ledger.jsonl"), readFileSync(join(f.outDir, "ledger.jsonl")));
		}
		changed = true;
	});
	const controller = f.attach(cli.child); const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(changed, true); assert.equal(proof.accepted, false);
	assert.equal(existsSync(join(f.root, "cli-source.json")), false);
	assert.equal(readFileSync(join(f.workspace, "written.txt"), "utf8"), "written actual content\n");
});

test("a final response with no tools still has a live model bill and complete settlement proof", { timeout: 10_000 }, async t => {
	const f = await fixture(t, []), cli = f.start(), controller = f.attach(cli.child);
	const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(proof.accepted, true, proof.failure ?? "");
	const rows = readLines(join(f.root, "controller.jsonl")); assert.equal(rows.filter(r => r.kind === "model").length, 1);
	assert.equal(rows.filter(r => r.kind === "before" || r.kind === "after").length, 0);
	assert.equal(JSON.parse(run.stdout).totals.requests, 1);
});

for (const corruption of ["lower-cost", "omitted-bill", "invented-bill"] as const) test(`a no-tool final response cannot hide ${corruption}`, { timeout: 10_000 }, async t => {
	const f = await fixture(t, []), cli = f.start(); let changed = false;
	cli.child.prependListener("message", (packet: any) => {
		if (packet.phase !== "finish") return;
		const file = join(f.outDir, "ledger.jsonl"), rows = readLines(file);
		if (corruption === "lower-cost") { rows[0].cost = 0; writeFileSync(file, rows.map(r => JSON.stringify(r) + "\n").join("")); }
		else if (corruption === "omitted-bill") writeFileSync(file, "");
		else { const extra = structuredClone(rows[0]); extra.requestId = randomUUID(); appendFileSync(file, JSON.stringify(extra) + "\n"); }
		changed = true;
	});
	const controller = f.attach(cli.child); const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(changed, true); assert.equal(proof.accepted, false);
	assert.equal(existsSync(join(f.root, "cli-source.json")), false);
});

test("redacted arguments and file-read results remain verifiable without retaining the synthetic secret in evidence", { timeout: 10_000 }, async t => {
	const secret = "sk-OWNOFFLINETESTabcdefghijklmnopqrstuvwxyz", calls: ToolCall[] = [
		{ id: "write-secret", name: "file_write", argumentsJson: JSON.stringify({ path: "private.txt", content: secret }) },
		{ id: "read-secret", name: "file_read", argumentsJson: JSON.stringify({ path: "private.txt" }) },
	];
	const f = await fixture(t, calls), cli = f.start(), controller = f.attach(cli.child);
	const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(proof.accepted, true, proof.failure ?? "");
	assert.equal(readFileSync(join(f.workspace, "private.txt"), "utf8"), secret);
	for (const file of [join(f.outDir, "recording.jsonl"), join(f.root, "controller.jsonl"), proof.sourcePath]) {
		assert.equal(readFileSync(file, "utf8").includes(secret), false, file);
	}
	const outputs = readLines(join(f.outDir, "recording.jsonl")).filter(r => r.kind === "tool.output");
	assert.ok(outputs.some(r => r.data.modelContent.includes("[REDACTED]")));
	assert.ok(outputs.some(r => r.data.modelContentSha256 !== r.data.recordedModelContentSha256));
});

test("rewriting a controller journal and recomputing its on-disk hash chain cannot manufacture accepted proof", { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("written")]), cli = f.start(); let changed = false;
	cli.child.prependListener("message", (packet: any) => {
		if (packet.phase !== "finish") return;
		const file = join(f.root, "controller.jsonl"), original = readFileSync(file, "utf8"), rows = readLines(file);
		rows.find(r => r.kind === "after").proof.scope = "OFFLINE-node-fixture-no-focus-claim";
		let previous: string | null = null;
		const altered = rows.map(row => { row.previous = previous; const text = JSON.stringify(row) + "\n"; previous = createHash("sha256").update(text).digest("hex"); return text; }).join("");
		assert.equal(Buffer.byteLength(altered), Buffer.byteLength(original)); writeFileSync(file, altered); changed = true;
	});
	const controller = f.attach(cli.child); const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(changed, true); assert.equal(proof.accepted, false);
	assert.equal(existsSync(join(f.root, "cli-source.json")), false);
});

// Windows has no SIGINT for another process: kill("SIGINT") terminates the CLI without its cancellation path.
test("cancelling a real CLI while the parent is observing does not dispatch or retry the pending tool", { timeout: 10_000, skip: process.platform === "win32" && "no SIGINT delivery on Windows" }, async t => {
	const f = await fixture(t, [write("never")]), cli = f.start(), entered = gate(); let cancelled = false;
	const controller = f.attach(cli.child, { before: async (_identity, _args, signal) => {
		entered.release(); await new Promise<void>(resolve => {
			const stop = () => { cancelled = true; resolve(); };
			if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
		}); return { cancelled: true };
	} });
	await Promise.race([entered.promise, cli.closed.then(run => { throw new Error(run.stderr); })]); cli.child.kill("SIGINT");
	const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 130, run.stderr); assert.equal(JSON.parse(run.stdout).status, "cancelled"); assert.equal(proof.accepted, false);
	assert.equal(cancelled, true); assert.equal(existsSync(join(f.workspace, "never.txt")), false); assert.equal(f.requests.length, 1);
	const recording = readLines(join(f.outDir, "recording.jsonl")); assert.equal(recording.filter(r => r.kind === "tool.input").length, 1);
	assert.equal(recording.find(r => r.kind === "tool.output").data.execution.dispatch, "not-started");
});

test("real CLI team mode binds each member's actual execution and every bill to its own recording", { timeout: 10_000 }, async t => {
	const counts = new Map<string, number>();
	const f = await fixture(t, [], { thinking: { enabled: true, effort: "ultracode" } }, body => {
		const name = JSON.stringify(body.messages).includes("You are worker, a sub-agent") ? "worker" : "lead";
		const count = (counts.get(name) ?? 0) + 1; counts.set(name, count);
		if (count !== 1) return [];
		return name === "lead" ? [{ id: "spawn-worker", name: "spawn_agent", argumentsJson: JSON.stringify({ name: "worker", purpose: "write a file", task: "Write only member-file.txt in this new temporary workspace." }) }] : [write("member-file")];
	});
	const cli = f.start(), controller = f.attach(cli.child);
	const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(proof.accepted, true, proof.failure ?? "");
	assert.equal(readFileSync(join(f.workspace, "member-file.txt"), "utf8"), "member-file actual content\n");
	const summary = JSON.parse(run.stdout), rows = readLines(join(f.root, "controller.jsonl"));
	assert.equal(summary.agents.length, 2); assert.ok(summary.agents.every((a: any) => a.status === "done"));
	assert.equal(summary.totals.requests, f.requests.length); assert.equal(rows.filter(r => r.kind === "model").length, f.requests.length);
	assert.deepEqual(rows.filter(r => r.kind === "before").map(r => r.agent.name).sort(), ["lead", "worker"]);
	const source = JSON.parse(readFileSync(proof.sourcePath, "utf8"));
	assert.ok(source.files.some((file: any) => file.path.replaceAll("\\", "/").endsWith("/agents/worker/recording.jsonl")));
	assert.ok(source.files.some((file: any) => file.path.replaceAll("\\", "/").endsWith("/agents/worker/ledger.jsonl")));
});

for (const differentRun of [false, true]) test(`budget-only charges for ${differentRun ? "an unknown run" : "the current run"} cannot be omitted from proof`, { timeout: 10_000 }, async t => {
	const f = await fixture(t, []), cli = f.start(); let changed = false;
	cli.child.prependListener("message", (packet: any) => {
		if (packet.phase !== "finish") return;
		const rows = readLines(f.spendLedger), reservation = structuredClone(rows.find(r => r.kind === "budget.reserve")), settlement = structuredClone(rows.find(r => r.kind === "budget.settle"));
		const requestId = randomUUID(), runId = differentRun ? randomUUID() : reservation.runId;
		for (const row of [reservation, settlement]) { row.requestId = requestId; row.runId = runId; appendFileSync(f.spendLedger, JSON.stringify(row) + "\n"); }
		changed = true;
	});
	const controller = f.attach(cli.child); const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(changed, true); assert.equal(proof.accepted, false);
	assert.equal(existsSync(join(f.root, "cli-source.json")), false);
});

test("genuine pre-existing budget history is retained and pinned rather than charged to the new CLI run", { timeout: 10_000 }, async t => {
	const f = await fixture(t, []), old = [
		{ kind: "budget.run-claim", version: 1, currency: "USD", runId: "own-prior-run" },
		{ kind: "budget.reserve", version: 1, currency: "USD", runId: "own-prior-run", requestId: "own-prior-request", worstCost: 0.01, taskLimit: 1, scope: null },
		{ kind: "budget.settle", version: 1, currency: "USD", runId: "own-prior-run", requestId: "own-prior-request", amount: 0.005, partial: false, overrun: false },
	].map(row => JSON.stringify(row) + "\n").join("");
	writeFileSync(f.spendLedger, old); const cli = f.start(), controller = f.attach(cli.child);
	const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(proof.accepted, true, proof.failure ?? "");
	assert.ok(readFileSync(f.spendLedger, "utf8").startsWith(old)); assert.equal(JSON.parse(run.stdout).totals.requests, 1);
	const source = JSON.parse(readFileSync(proof.sourcePath, "utf8"));
	assert.equal(source.spendBaseline.bytes, Buffer.byteLength(old)); assert.equal(source.spendBaseline.rows, 3);
	assert.equal(source.spendBaseline.sha256, createHash("sha256").update(old).digest("hex"));
});

test("redirecting a budget parent symlink cannot replace the pinned old history", { timeout: 10_000, skip: process.platform === "win32" }, async t => {
	const f = await fixture(t, [], {}, undefined, true);
	const old = JSON.stringify({ kind: "budget.run-claim", version: 1, currency: "USD", runId: "own-prior-run" }) + "\n";
	writeFileSync(f.spendLedger, old); const cli = f.start(); let changed = false;
	cli.child.prependListener("message", (packet: any) => {
		if (packet.phase !== "model" || changed) return;
		const original = readFileSync(f.spendLedger, "utf8"), altered = original.replace("own-prior-run", "own-other-run");
		writeFileSync(join(f.root, "budget-b", "spend.jsonl"), altered);
		unlinkSync(join(f.root, "budget-route")); symlinkSync(join(f.root, "budget-b"), join(f.root, "budget-route"), "dir"); changed = true;
	});
	const controller = f.attach(cli.child); const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(changed, true); assert.equal(proof.accepted, false); assert.equal(existsSync(join(f.root, "cli-source.json")), false);
	assert.notEqual(run.code, 0, "the controller must stop the CLI when its budget file is redirected");
});

test("real CLI can pair the independent focus bridge and finalize it after child close without claiming real focus", { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("observed")]), focus = focusJournal(t);
	const observer = new ModelFocusObserver({ monitor: { pid: 99, exitCode: null, signalCode: null } as ChildProcess, monitorBirth: focusBirth(99), journal: focus.reader,
		processBinary: { path: "/own/fixture-only", sha256: "0".repeat(64) }, fixture: { now: focus.now, read: async (_binary, pids) => new Map(pids.map(pid => [pid, focusAlive(pid)])) } });
	t.after(() => observer.close()); const cli = f.start();
	const controller = f.attach(cli.child, { before: observer.before, after: observer.after, finalizeObservations: observer.finalize });
	const [run, proof] = await Promise.all([cli.closed, controller.completion]); assert.equal(run.code, 0, run.stderr); assert.equal(proof.accepted, true, proof.failure ?? "");
	assert.equal(readFileSync(join(f.workspace, "observed.txt"), "utf8"), "observed actual content\n");
	const rows = readLines(join(f.root, "controller.jsonl"));
	assert.equal(rows.find(r => r.kind === "before").proof.kind, "independent-focus-before");
	assert.equal(rows.find(r => r.kind === "after").proof.kind, "independent-focus-after");
	const last = rows.find(r => r.kind === "observations-finalized"); assert.ok(last); assert.equal(last.proof.componentOnly, true); assert.equal(last.proof.cleanupTailVerified, false);
	assert.equal(rows.at(-1).kind, "cli-closed");
});

for (const kind of ["throws", "never-finishes"] as const) test(`a final focus check that ${kind} cannot publish accepted evidence or erase actual writes`, { timeout: 10_000 }, async t => {
	const f = await fixture(t, [write("preserved")]), cli = f.start(); let aborted = false;
	const controller = f.attach(cli.child, { finalizeObservations: async signal => {
		if (kind === "throws") throw new Error("synthetic-private-final-observation-error");
		return new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve({ late: true }); }, { once: true }));
	} });
	const [run, proof] = await Promise.all([cli.closed, controller.completion]);
	assert.equal(run.code, 0, run.stderr); assert.equal(proof.accepted, false); assert.equal(existsSync(join(f.root, "cli-source.json")), false);
	assert.equal(readFileSync(join(f.workspace, "preserved.txt"), "utf8"), "preserved actual content\n");
	assert.equal(readFileSync(join(f.root, "controller.jsonl"), "utf8").includes("synthetic-private-final-observation-error"), false);
	if (kind === "never-finishes") assert.equal(aborted, true);
});
