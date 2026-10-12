import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileSha256, ShadowCheckpoints } from "@mountains/checkpoints";
import { assertToolPairing } from "@mountains/context";
import type { EngineEvent, ToolMessage } from "@mountains/protocol";
import type { ModelRequest, ModelResponse, ModelStreamHandlers } from "@mountains/providers";
import { AgentSession, BudgetGuard, COMPACTION_REQUEST, ScriptedModelAdapter, type EngineOptions, type RecordedResponse, type RunSummary } from "../src/index.ts";

// Only the model is replaced. These scenarios use real source files, subprocesses,
// query plans, checkpoints, journals, archive readers, and the public session API.
// They establish workflow correctness, not model quality or provider cache savings.
type Call = { id: string; name: string; args: Record<string, unknown> };
type Step = (request: ModelRequest) => RecordedResponse;
const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
const TIMEOUT = process.platform === "win32" ? 180_000 : 60_000;
const originalSource = "exports.add = (a, b) => a - b;\nexports.multiply = (a, b) => a * b;\n";
const correctSource = originalSource.replace("a - b", "a + b");
const checkSource = "const assert = require('node:assert/strict');\nconst {add, multiply} = require('./arithmetic.cjs');\nfor (const [a,b] of [[2,3],[0,7],[-2,1]]) assert.equal(add(a,b),a+b);\nassert.equal(multiply(3,4),12);\nconsole.log('ARITHMETIC_PASS');\n";
const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, args });
const read = (id: string, path = "arithmetic.cjs"): Call => call(id, "file_read", { path });
const edit = (id: string, oldText: string, newText: string, path = "arithmetic.cjs"): Call => call(id, "file_edit", { path, oldText, newText });
const command = (id: string, argv = [process.execPath, "check.cjs"]): Call => call(id, "command_run", { argv, timeoutMs: 30_000 });
function reply(calls: Call[] = [], content = "The offline fixture checks passed."): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : content, reasoning: "", toolCalls: calls.map(({ id, name, args }) => ({ id, name, argumentsJson: JSON.stringify(args) })) },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage, httpStatus: 200, error: null, aborted: false };
}
class CheckedScript extends ScriptedModelAdapter {
	private readonly queue: RecordedResponse[];
	private readonly steps: Step[];
	private readonly summarize: () => RecordedResponse;
	private next = 0;
	summaryRequests = 0;
	constructor(steps: Step[], summarize = () => reply([], "Source inspections and edits are archived. Continue the current coding task; verify all conclusions with real tools.")) {
		const queue: RecordedResponse[] = [];
		super(queue); this.queue = queue; this.steps = steps; this.summarize = summarize;
	}
	override async complete(request: ModelRequest, handlers?: ModelStreamHandlers): Promise<ModelResponse> {
		assertToolPairing(request.messages);
		if (request.messages.at(-1)?.content === COMPACTION_REQUEST) {
			this.summaryRequests++;
			this.queue.push(this.summarize());
		} else {
			const step = this.steps[this.next++];
			assert.ok(step, "the engine must not issue an unplanned coding request");
			this.queue.push(step(request));
		}
		return super.complete(request, handlers);
	}
	assertFinished() { assert.equal(this.next, this.steps.length, "all planned coding steps ran"); assert.equal(this.remaining, 0); }
}
function output(request: ModelRequest, id: string): ToolMessage {
	const value = request.messages.findLast(message => message.role === "tool" && message.toolCallId === id);
	assert.ok(value?.role === "tool", `missing actual tool result ${id}`);
	return value;
}
function completion(events: EngineEvent[], id: string) {
	const event = events.findLast(event => event.type === "tool.completed" && event.toolCallId === id);
	assert.ok(event?.type === "tool.completed", `missing completion ${id}`);
	assert.ok(event.details && typeof event.details === "object" && !Array.isArray(event.details));
	return { ...event, details: event.details as Record<string, unknown> };
}
function jsonLines(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-practical-coding-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const workspace = join(root, "workspace"); mkdirSync(workspace);
	execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "pipe" });
	writeFileSync(join(workspace, ".gitignore"), "*.local\n");
	writeFileSync(join(workspace, "arithmetic.cjs"), originalSource);
	writeFileSync(join(workspace, "check.cjs"), checkSource);
	const budget = new BudgetGuard({ globalLimit: 100, ledgerPath: join(root, "spend.jsonl") });
	const appDataDir = join(root, "checkpoints");
	const checkpoints = new ShadowCheckpoints(workspace, appDataDir);
	let count = 0;
	function session(adapter: ScriptedModelAdapter, extra: Partial<EngineOptions> = {}) {
		const events: EngineEvent[] = [];
		const options: EngineOptions = { workspace, dataDir: join(root, `session-${++count}`), archiveDir: join(root, "archive"), appDataDir,
			adapter, model: "deepseek-flash", systemPrompt: "Repair the synthetic coding fixture using the provided tools.",
			thinking: { enabled: false, effort: "default" }, maxTokens: 128, requestGuard: true, allowSessionSnapshots: true,
			budget, retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 120, maxRequests: 140, maxCost: 20, maxInputTokens: 20_000_000, maxOutputTokens: 100_000 },
			contextPolicy: { triggerTokens: 100_000, hardLimitTokens: 200_000, compactTokens: 180_000, compactTailTokens: 1000, minBatchTokens: 100 },
			toolOptions: { batchEdit: true, read: { defaultLines: 100, maxLines: 200 } }, ...extra,
			onEvent(event) { events.push(event); extra.onEvent?.(event); },
		};
		return { agent: new AgentSession(options), options, events };
	}
	function restore(summary: RunSummary, expected?: Record<string, string | null>) {
		assert.ok(summary.checkpoint, "a coding run must return a real Git rollback checkpoint");
		const paths = summary.checkpoint.changed.map(change => change.path);
		return checkpoints.restore(summary.checkpoint.tree, paths, expected ?? Object.fromEntries(paths.map(path => [path, fileSha256(join(workspace, path))])));
	}
	function verify(passes: boolean) {
		const result = spawnSync(process.execPath, ["check.cjs"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.error, undefined);
		assert.equal(result.status === 0, passes, result.stderr);
		if (passes) assert.match(result.stdout, /ARITHMETIC_PASS/);
	}
	return { root, workspace, budget, checkpoints, session, restore, verify };
}
function checkAccounting(events: EngineEvent[], options: EngineOptions, summary: RunSummary) {
	assert.equal(events.filter(event => event.type === "run.completed").length, 1);
	const requests = events.filter(event => event.type === "model.request");
	assert.equal(new Set(requests.map(event => event.requestId)).size, requests.length);
	assert.equal(requests.length, summary.totals.requests);
	assert.deepEqual(options.budget.snapshot({ runId: summary.runId }), { requests: summary.totals.requests, spent: summary.totals.cost, reserved: 0, unknownCost: 0 });
	const ledger = jsonLines(join(options.dataDir, "ledger.jsonl"));
	assert.equal(ledger.length, summary.totals.requests);
	assert.equal(ledger.reduce((sum, row) => sum + Number(row.cost), 0), summary.totals.cost);
	assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq));
}

test("a searched bug survives a failed atomic edit and incorrect repair, then passes and rolls back without changing Git state", { timeout: TIMEOUT }, async t => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "settings.local"), "mode=original\r\n");
	writeFileSync(join(f.workspace, "staged.txt"), "staged content\n");
	execFileSync("git", ["add", "--", "staged.txt"], { cwd: f.workspace });
	writeFileSync(join(f.workspace, "staged.txt"), "unstaged content must survive\n");
	const index = readFileSync(join(f.workspace, ".git", "index"));
	const head = readFileSync(join(f.workspace, ".git", "HEAD"));
	const config = readFileSync(join(f.workspace, ".git", "config"));
	f.verify(false);
	const adapter = new CheckedScript([
		() => reply([call("discover", "query_plan", { steps: [{ id: "find", op: "search", pattern: "exports.add", glob: "*.cjs" }, { id: "source", op: "read", path: { from: "find", expect: "one" } }, { id: "test", op: "read", path: "check.cjs" }] }), read("settings", "settings.local"), command("baseline")]),
		request => {
			assert.match(output(request, "discover").content, /a - b/);
			assert.match(output(request, "baseline").content, /AssertionError/);
			return reply([call("atomic-failure", "file_edit", { path: "arithmetic.cjs", edits: [{ oldText: "a - b", newText: "a + b" }, { oldText: "nonexistent old text", newText: "never" }] })]);
		},
		request => {
			assert.match(output(request, "atomic-failure").content, /oldText/);
			assert.equal(readFileSync(join(f.workspace, "arithmetic.cjs"), "utf8"), originalSource, "no partial commit from the rejected batch");
			return reply([edit("wrong-fix", "a - b", "a + b + 1"), command("wrong-tests")]);
		},
		request => {
			assert.match(output(request, "wrong-tests").content, /AssertionError/);
			return reply([edit("correct-fix", "a + b + 1", "a + b"), edit("settings-edit", "mode=original", "mode=repaired", "settings.local"), call("new-note", "file_write", { path: "repair-note.local", content: "Synthetic repair verified.\n" }), command("passing-tests")]);
		},
		request => { assert.match(output(request, "passing-tests").content, /ARITHMETIC_PASS/); return reply(); },
	]);
	const { agent, events, options } = f.session(adapter);
	const result = await agent.run("Find and fix addition, run the tests, and record the synthetic repair.");
	assert.equal(result.status, "completed", result.reason); adapter.assertFinished(); f.verify(true);
	assert.deepEqual(["baseline", "atomic-failure", "wrong-tests"].map(id => completion(events, id).ok), [false, false, false]);
	assert.equal(completion(events, "passing-tests").ok, true);
	assert.deepEqual(result.checkpoint?.changed, [{ status: "M", path: "arithmetic.cjs" }, { status: "A", path: "repair-note.local" }, { status: "M", path: "settings.local" }]);
	assert.deepEqual(f.restore(result), { restored: ["arithmetic.cjs", "settings.local"], deleted: ["repair-note.local"], conflicts: [] });
	f.verify(false);
	assert.equal(readFileSync(join(f.workspace, "settings.local"), "utf8"), "mode=original\r\n");
	assert.equal(readFileSync(join(f.workspace, "staged.txt"), "utf8"), "unstaged content must survive\n");
	assert.deepEqual(readFileSync(join(f.workspace, ".git", "index")), index);
	assert.deepEqual(readFileSync(join(f.workspace, ".git", "HEAD")), head);
	assert.deepEqual(readFileSync(join(f.workspace, ".git", "config")), config);
	checkAccounting(events, options, result);
});

test("a process-side source change rejects stale edits, and rollback refuses to overwrite a later human change", { timeout: TIMEOUT }, async t => {
	const f = fixture(t);
	const external = "// concurrently generated header\n";
	const adapter = new CheckedScript([
		() => reply([read("read-before")]),
		() => reply([command("generate", [process.execPath, "-e", `const fs=require('node:fs');const p='arithmetic.cjs';fs.writeFileSync(p,${JSON.stringify(external)}+fs.readFileSync(p,'utf8'));`]), edit("stale-edit", "a - b", "a + b")]),
		request => {
			assert.match(output(request, "stale-edit").content, /重新读取/);
			assert.equal(readFileSync(join(f.workspace, "arithmetic.cjs"), "utf8"), external + originalSource);
			return reply([read("fresh-read")]);
		},
		() => reply([edit("fresh-edit", "a - b", "a + b"), command("verify")]),
		request => { assert.match(output(request, "verify").content, /ARITHMETIC_PASS/); return reply(); },
	]);
	const { agent, events, options } = f.session(adapter);
	const result = await agent.run("Repair addition while preserving concurrent source updates.");
	assert.equal(result.status, "completed", result.reason); adapter.assertFinished();
	assert.equal(completion(events, "stale-edit").ok, false);
	const after = fileSha256(join(f.workspace, "arithmetic.cjs"));
	const humanVersion = external + correctSource + "// later user edit\n";
	writeFileSync(join(f.workspace, "arithmetic.cjs"), humanVersion);
	const blocked = f.restore(result, { "arithmetic.cjs": after });
	assert.equal(blocked.conflicts.length, 1); assert.deepEqual(blocked.restored, []);
	assert.equal(readFileSync(join(f.workspace, "arithmetic.cjs"), "utf8"), humanVersion);
	checkAccounting(events, options, result);
});

for (const boundary of ["first-edit", "ignored-edit", "new-file"] as const) {
	test(`cancelling after ${boundary} checkpoints exactly completed coding mutations and permits safe rollback`, { timeout: TIMEOUT }, async t => {
		const f = fixture(t); const controller = new AbortController();
		writeFileSync(join(f.workspace, "settings.local"), "mode=original\n");
		const adapter = new CheckedScript([
			() => reply([read("read-source"), read("read-settings", "settings.local")]),
			() => reply([edit("first-edit", "a - b", "a + b"), edit("ignored-edit", "mode=original", "mode=repaired", "settings.local"), call("new-file", "file_write", { path: "generated.cjs", content: "exports.generated = true;\n" }), command("must-not-run")]),
		]);
		const { agent, events, options } = f.session(adapter, { onEvent(event) { if (event.type === "tool.completed" && event.toolCallId === boundary) controller.abort(); } });
		const result = await agent.run("Apply a small multi-file coding repair.", controller.signal);
		assert.equal(result.status, "cancelled", result.reason); adapter.assertFinished();
		const ordered = ["first-edit", "ignored-edit", "new-file", "must-not-run"];
		assert.deepEqual(ordered.map(id => completion(events, id).ok), ordered.map((_, index) => index <= ordered.indexOf(boundary)));
		assert.equal(completion(events, "must-not-run").details.cancelled, true);
		assertToolPairing(agent.builder.plan().messages);
		assert.equal(agent.exportSnapshot().runCount, 1, "cancelled paired runs remain persistable");
		const expectedPaths = ["arithmetic.cjs", ...(boundary !== "first-edit" ? ["settings.local"] : []), ...(boundary === "new-file" ? ["generated.cjs"] : [])].sort();
		assert.deepEqual(result.checkpoint?.changed.map(change => change.path), expectedPaths);
		const restored = f.restore(result);
		assert.deepEqual(restored.conflicts, []);
		assert.equal(readFileSync(join(f.workspace, "arithmetic.cjs"), "utf8"), originalSource);
		assert.equal(readFileSync(join(f.workspace, "settings.local"), "utf8"), "mode=original\n");
		assert.equal(existsSync(join(f.workspace, "generated.cjs")), false);
		checkAccounting(events, options, result);
	});
}

test("persisting a failed coding attempt restores history but requires a fresh file observation before the next edit", { timeout: TIMEOUT }, async t => {
	const f = fixture(t);
	const firstScript = new CheckedScript([() => reply([read("source")]), () => reply([edit("partial-fix", "a - b", "a + b + 1"), command("failing-check")])]);
	const first = f.session(firstScript, { limits: { maxTurns: 2, maxCost: 20 } });
	const stopped = await first.agent.run("Fix arithmetic and verify it.");
	assert.equal(stopped.status, "limit", stopped.reason); firstScript.assertFinished();
	assert.equal(completion(first.events, "failing-check").ok, false);
	const path = join(f.root, "session-snapshot.json");
	writeFileSync(path, JSON.stringify(first.agent.exportSnapshot()));
	const before = f.budget.globalSpent;
	const nextScript = new CheckedScript([
		request => { assert.match(output(request, "failing-check").content, /AssertionError/); return reply([edit("unobserved", "a + b + 1", "a + b")]); },
		request => { assert.match(output(request, "unobserved").content, /先用 file_read/); return reply([read("new-observation")]); },
		() => reply([edit("repair", "a + b + 1", "a + b"), command("new-check")]),
		request => { assert.match(output(request, "new-check").content, /ARITHMETIC_PASS/); return reply(); },
	]);
	const next = f.session(nextScript, { sessionId: first.agent.sessionId });
	next.agent.restoreSnapshot(JSON.parse(readFileSync(path, "utf8")));
	assert.equal(nextScript.requests.length, 0); assert.equal(f.budget.globalSpent, before);
	assert.equal(readFileSync(join(f.workspace, "arithmetic.cjs"), "utf8"), originalSource.replace("a - b", "a + b + 1"));
	const result = await next.agent.run("Continue the repair from its failed test.");
	assert.equal(result.status, "completed", result.reason); nextScript.assertFinished(); f.verify(true);
	assert.notEqual(result.runId, stopped.runId);
	assert.ok(next.events[0]!.seq > first.events.at(-1)!.seq);
	assert.equal(next.agent.exportSnapshot().runCount, 2);
	assert.deepEqual(f.restore(result).conflicts, []);
	assert.equal(readFileSync(join(f.workspace, "arithmetic.cjs"), "utf8"), originalSource.replace("a - b", "a + b + 1"), "the second run's rollback starts at the interrupted code, not the first run baseline");
	checkAccounting(first.events, first.options, stopped); checkAccounting(next.events, next.options, result);
});

test("compacted and restored coding history can recover deleted source bytes without replaying the old command", { timeout: TIMEOUT }, async t => {
	const f = fixture(t);
	const needle = "historical-rule-saffron";
	const source = `// ${needle}\r\nexports.rate = value => value * 3;\r\n${"// historical implementation details\r\n".repeat(30)}`;
	writeFileSync(join(f.workspace, "legacy.cjs"), source);
	let rawRef = "";
	const firstScript = new CheckedScript([
		() => reply([call("legacy-read", "file_read", { path: "legacy.cjs", startLine: 1, endLine: 3 }), command("run-once", [process.execPath, "-e", "require('node:fs').appendFileSync('execution-count.local','once\\n');console.log('ARCHIVED_COMMAND_RAN')"])]),
		request => { rawRef = /fullOutputRef=(\S+)/.exec(output(request, "legacy-read").content)?.[1] ?? ""; assert.ok(rawRef); return reply(); },
	]);
	const first = f.session(firstScript);
	assert.equal((await first.agent.run("Inspect and test the historical implementation.")).status, "completed");
	const compacted = await first.agent.compactNow();
	assert.equal(compacted.revision?.reason, "compaction"); assert.ok(compacted.revision!.removedGroups);
	assert.ok(!first.agent.builder.plan().messages.some(message => message.role === "tool" && message.toolCallId === "legacy-read"));
	const snapshot = JSON.parse(JSON.stringify(first.agent.exportSnapshot()));
	rmSync(join(f.workspace, "legacy.cjs"));
	const nextScript = new CheckedScript([
		() => reply([call("find-history", "session_search", { needle }), call("recover-source", "context_expand", { ref: rawRef, offsetBytes: 0, maxBytes: 12_000 })]),
		request => {
			const search = JSON.parse(output(request, "find-history").content) as { complete: boolean; matches: { toolCallId: string }[] };
			assert.equal(search.complete, true); assert.ok(search.matches.some(match => match.toolCallId === "legacy-read"));
			const archived = output(request, "recover-source").content;
			const recovered = archived.slice(archived.indexOf("\n") + 1);
			assert.equal(recovered, source, "recall returns the archived CRLF bytes after the source is deleted");
			return reply([call("recreate", "file_write", { path: "legacy.cjs", content: recovered }), command("verify-recreated", [process.execPath, "-e", "require('node:assert/strict').equal(require('./legacy.cjs').rate(7),21);console.log('RESTORED_SOURCE_PASS')"])]);
		},
		request => { assert.match(output(request, "verify-recreated").content, /RESTORED_SOURCE_PASS/); return reply(); },
	]);
	const next = f.session(nextScript, { sessionId: first.agent.sessionId });
	next.agent.restoreSnapshot(snapshot);
	assert.equal(readFileSync(join(f.workspace, "execution-count.local"), "utf8"), "once\n");
	const result = await next.agent.run("Restore the deleted historical implementation from captured evidence and verify it.");
	assert.equal(result.status, "completed", result.reason); nextScript.assertFinished();
	assert.equal(readFileSync(join(f.workspace, "legacy.cjs"), "utf8"), source);
	assert.equal(readFileSync(join(f.workspace, "execution-count.local"), "utf8"), "once\n", "history restoration cannot execute archived commands");
	assert.deepEqual(result.checkpoint?.changed, [{ status: "A", path: "legacy.cjs" }]);
	assert.deepEqual(f.restore(result).deleted, ["legacy.cjs"]);
	checkAccounting(next.events, next.options, result);
});

test("a failed summary falls back to a program record and leaves a diagnosed coding bug repairable", { timeout: TIMEOUT }, async t => {
	const f = fixture(t);
	const adapter = new CheckedScript([
		() => reply([read("diagnose"), command("diagnostic-failure")]),
		request => { assert.match(output(request, "diagnostic-failure").content, /AssertionError/); return reply([], "The tests demonstrate the addition bug; repair is still pending."); },
		request => {
			assert.ok(request.messages.some(message => message.content.includes("program record")), "failed model summary must leave factual recovery context");
			return reply([read("observe-after-compaction")]);
		},
		() => reply([edit("repair-after-compaction", "a - b", "a + b"), command("verify-after-compaction")]),
		request => { assert.match(output(request, "verify-after-compaction").content, /ARITHMETIC_PASS/); return reply(); },
	], () => ({ ...reply(), ok: false, message: { role: "assistant", content: "", reasoning: "", toolCalls: [] }, finishReason: null, httpStatus: 503, error: { message: "injected offline summarizer failure", retryable: true } }));
	const { agent, options, events } = f.session(adapter);
	const diagnosed = await agent.run("Diagnose the addition bug without changing code yet.");
	assert.equal(diagnosed.status, "completed", diagnosed.reason);
	const compacted = await agent.compactNow();
	assert.equal(compacted.revision?.reason, "compaction"); assert.equal(adapter.summaryRequests, 1);
	assert.equal(readFileSync(join(f.workspace, "arithmetic.cjs"), "utf8"), originalSource);
	const result = await agent.run("Now fix the diagnosed bug and verify the correction.");
	assert.equal(result.status, "completed", result.reason); adapter.assertFinished(); f.verify(true);
	const records = jsonLines(join(options.dataDir, "recording.jsonl"));
	assert.ok(records.some(record => record.kind === "context.compaction-request" && (record.data as Record<string, unknown>).sent === true && (record.data as Record<string, unknown>).usable === false));
	assert.equal(events.filter(event => event.type === "run.completed").length, 2);
	assert.equal(f.budget.snapshot({ runId: result.runId }).reserved, 0);
	assert.equal(f.budget.globalSpent, diagnosed.totals.cost + compacted.cost + result.totals.cost);
	assert.deepEqual(f.restore(result).conflicts, []);
	f.verify(false);
});

function treeSize(dir: string): { files: number; bytes: number } {
	let files = 0, bytes = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) { const child = treeSize(path); files += child.files; bytes += child.bytes; }
		else { files++; bytes += statSync(path).size; }
	}
	return { files, bytes };
}

test("a seeded multi-module repair keeps long-session context, archives, processes, and accounting bounded", { timeout: TIMEOUT }, async t => {
	const f = fixture(t);
	// One substantive session, rather than treating each assertion/iteration as a test.
	// The fixed seed varies operands, line endings and where a rejected edit occurs.
	let seed = 0x51a7e;
	const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
	const modules = Array.from({ length: 18 }, (_, index) => ({ index, coefficient: random() % 19 + 2, offset: random() % 11, crlf: random() % 2 === 0 }));
	const commands: string[] = [];
	const exitedProcesses: number[] = [];
	const steps: Step[] = [];
	for (const module of modules) {
		const path = `feature-${module.index}.cjs`;
		const eol = module.crlf ? "\r\n" : "\n";
		const original = `exports.compute = value => value * ${module.coefficient} - ${module.offset};${eol}`;
		const padding = Array.from({ length: 60 }, (_, line) => `// Feature ${module.index} design note ${line}: retain historical evidence while repairing independent arithmetic cases.${eol}`).join("");
		writeFileSync(join(f.workspace, path), original + padding);
		steps.push(() => reply([read(`read-${module.index}`, path)]));
		if (module.index === 7) {
			steps.push(() => reply([edit("long-session-rejected-edit", "does not exist", "must not commit", path)]));
			steps.push(request => { assert.match(output(request, "long-session-rejected-edit").content, /oldText/); return reply([read("refresh-after-rejected-edit", path)]); });
		}
		const id = `verify-${module.index}`; commands.push(id);
		const verify = `const assert=require('node:assert/strict');const fn=require('./${path}').compute;for(const x of [-3,0,4])assert.equal(fn(x),x*${module.coefficient}+${module.offset});console.log('FEATURE_PASS:${module.index}:PID='+process.pid);`;
		steps.push(() => reply([edit(`edit-${module.index}`, `* ${module.coefficient} - ${module.offset}`, `* ${module.coefficient} + ${module.offset}`, path), command(id, [process.execPath, "-e", verify])]));
		steps.push(request => {
			const pid = Number(new RegExp(`FEATURE_PASS:${module.index}:PID=(\\d+)`).exec(output(request, id).content)?.[1]);
			assert.ok(Number.isSafeInteger(pid) && pid > 0);
			assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", "the completed test process must already be reaped");
			exitedProcesses.push(pid);
			return reply([call(`note-${module.index}`, "task_note", { requirements: ["Repair all independent arithmetic modules and keep original evidence recoverable."], facts: [`${path} passed its local assertions.`], next: module.index + 1 === modules.length ? "Run the final aggregate check." : `Inspect feature-${module.index + 1}.cjs.` })]);
		});
	}
	const finalCheck = `const assert=require('node:assert/strict');for(const m of ${JSON.stringify(modules)})for(const x of [-9,0,17])assert.equal(require('./feature-'+m.index+'.cjs').compute(x),x*m.coefficient+m.offset);console.log('ALL_FEATURES_PASS');`;
	steps.push(() => reply([command("all-features", [process.execPath, "-e", finalCheck])]));
	steps.push(request => { assert.match(output(request, "all-features").content, /ALL_FEATURES_PASS/); return reply(); });
	const adapter = new CheckedScript(steps);
	const { agent, events, options } = f.session(adapter, { contextPolicy: { triggerTokens: 11_000, hardLimitTokens: 32_000, compactTokens: 24_000, compactTailTokens: 2000, minBatchTokens: 500 } });
	const result = await agent.run("Repair the 18 independent arithmetic modules, verify each, then run an aggregate regression check.");
	assert.equal(result.status, "completed", result.reason); adapter.assertFinished();
	assert.ok(events.some(event => event.type === "context.revision"), "this scenario must really cross a context boundary");
	assert.ok(agent.builder.plan().totalTokensEst + options.maxTokens < options.contextPolicy!.hardLimitTokens);
	for (const event of events) if (event.type === "model.request") {
		assert.ok(event.segments.reduce((sum, segment) => sum + segment.tokensEst, 0) + options.maxTokens <= options.contextPolicy!.hardLimitTokens, "no oversized source history is dispatched");
	}
	assert.equal(result.checkpoint?.changed.length, modules.length);
	assert.equal(completion(events, "all-features").ok, true);
	for (const id of commands) {
		const finished = completion(events, id);
		assert.equal(finished.ok, true, id);
		assert.equal(finished.details.exitCode, 0);
		assert.equal(finished.details.timedOut, false);
	}
	assert.equal(exitedProcesses.length, modules.length);
	const snapshot = agent.exportSnapshot();
	assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 1_000_000, "active persisted context stays bounded despite many original source reads");
	const archive = treeSize(options.archiveDir!);
	assert.ok(archive.bytes < 4_000_000 && archive.files < 1000, `unexpected archive amplification: ${JSON.stringify(archive)}`);
	assert.ok(statSync(join(options.dataDir, "recording.jsonl")).size < 12_000_000);
	t.diagnostic(JSON.stringify({ seed: "0x51a7e", repairedModules: modules.length, observedExitedProcesses: exitedProcesses.length,
		requests: result.totals.requests, compactionRequests: adapter.summaryRequests,
		contextRevisions: events.filter(event => event.type === "context.revision").length,
		finalContextTokensEstimate: agent.builder.plan().totalTokensEst, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
		archiveFiles: archive.files, archiveBytes: archive.bytes, recordingBytes: statSync(join(options.dataDir, "recording.jsonl")).size }));
	checkAccounting(events, options, result);
	const restored = f.session(new ScriptedModelAdapter([]), { sessionId: agent.sessionId, contextPolicy: options.contextPolicy! });
	restored.agent.restoreSnapshot(JSON.parse(JSON.stringify(snapshot)));
	assert.deepEqual(restored.agent.builder.plan(), agent.builder.plan());
	assert.deepEqual(f.restore(result).conflicts, []);
	const regression = spawnSync(process.execPath, ["-e", finalCheck], { cwd: f.workspace, encoding: "utf8", timeout: 30_000 });
	assert.notEqual(regression.status, 0, "rolling back the long repair must restore the original failing behavior");
});
