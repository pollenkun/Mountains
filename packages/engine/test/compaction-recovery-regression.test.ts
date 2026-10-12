import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { assertToolPairing, checkpointArchiveRef } from "@mountains/context";
import type { ToolDefinition } from "@mountains/tools";
import { AgentSession, BudgetGuard, COMPACTION_REQUEST, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, argumentsJson: JSON.stringify(args) });
function reply(toolCalls: RecordedResponse["message"]["toolCalls"] = [], content = "Done."): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: toolCalls.length ? "" : content, reasoning: "", toolCalls },
		finishReason: toolCalls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash",
		rawUsage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 1, total_tokens: 11 },
		httpStatus: 200, error: null, aborted: false };
}
function fixture(t: TestContext, responses: RecordedResponse[], extra: Partial<EngineOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "compaction-recovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	const adapter = new ScriptedModelAdapter(responses);
	const options: EngineOptions = { workspace, dataDir: join(root, "data"), archiveDir: join(root, "archive"), sessionId: "compaction-recovery",
		adapter, model: "deepseek-flash", systemPrompt: "fixture", thinking: { enabled: false, effort: "default" }, maxTokens: 16,
		checkpoints: false, allowSessionSnapshots: true, requestGuard: true, retry: { maxAttempts: 1, baseDelayMs: 0 },
		budget: new BudgetGuard({ globalLimit: 10, ledgerPath: join(root, "spend.jsonl") }),
		limits: { maxTurns: 8, maxCost: 1, maxInputTokens: 1_000_000, maxOutputTokens: 1000 }, ...extra };
	return { root, workspace, options, adapter, session: new AgentSession(options) };
}
const contextPolicy = { triggerTokens: 7000, hardLimitTokens: 11000, compactTokens: 10000, compactTailTokens: 1000, minBatchTokens: 100, settledUserTurns: 2 };
const tools: ToolDefinition[] = [{ name: "context_expand", logicalName: "fixture", description: "offline read fixture", parameters: { type: "object" }, readOnly: true,
	async execute(args) { return { ok: true, modelContent: String(args.key).repeat(Number(args.size ?? 20000)), summary: "read", details: {} }; } }];
const reads = (secondSize = 20000) => [reply([call("first", "context_expand", { key: "a" })]), reply([call("second", "context_expand", { key: "b", size: secondSize })])];

test("automatic compaction recovers an over-hard-limit history with no lossless candidates", async t => {
	const f = fixture(t, [...reads(), reply()], { tools, contextPolicy });
	const result = await f.session.run("Read two different fixtures.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(f.adapter.requests.length, 3, "program recovery needs no summary request");
	assert.ok(f.adapter.requests.every(request => request.messages.at(-1)?.content !== COMPACTION_REQUEST));
	assert.ok(f.adapter.requests.at(-1)!.messages.some(message => message.content.includes("program record")));
	assert.ok(f.session.builder.plan().totalTokensEst + f.options.maxTokens <= contextPolicy.hardLimitTokens);
	assertToolPairing(f.adapter.requests.at(-1)!.messages);
	const records = readFileSync(join(f.options.dataDir, "recording.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.ok(records.some(row => row.kind === "context.compaction-request" && row.data.sent === false && row.data.reason === "context-limit"));
});

test("compactNow recovers the same over-hard-limit history after a turn-limit exit", async t => {
	const f = fixture(t, [...reads(), reply()], { tools, contextPolicy, limits: { maxTurns: 2, maxCost: 1 } });
	assert.equal((await f.session.run("Read two different fixtures.")).status, "limit");
	assert.ok(f.session.builder.plan().totalTokensEst + f.options.maxTokens > contextPolicy.hardLimitTokens);
	const compacted = await f.session.compactNow();
	assert.equal(compacted.revision?.reason, "compaction");
	assert.equal(compacted.cost, 0); assert.equal(f.adapter.requests.length, 2);
	assert.ok(compacted.revision!.tokensAfter + f.options.maxTokens <= contextPolicy.hardLimitTokens);
	assert.equal((await f.session.run("Continue.")).status, "completed");
});

test("program recovery still rejects a candidate whose necessary tail exceeds the hard limit", async t => {
	const f = fixture(t, reads(40000), { tools, contextPolicy });
	const result = await f.session.run("Read two different fixtures.");
	assert.equal(result.status, "limit"); assert.match(result.reason, /CONTEXT_BUDGET_EXCEEDED/);
	const before = f.session.builder.plan();
	await assert.rejects(f.session.compactNow(), { code: "CONTEXT_BUDGET_EXCEEDED" });
	assert.deepEqual(f.session.builder.plan(), before, "an oversized candidate cannot replace history");
	assert.equal(f.adapter.requests.length, 2, "the oversized history never goes to a summarizer");
});

async function nestedFixture(t: TestContext) {
	const needle = "zebra-unrepeatable-evidence";
	const f = fixture(t, [reply([call("old-read", "file_read", { path: "old.txt" })]), reply(),
		reply([], "Earlier work was read."), reply([], "Previous work was compacted."),
		reply([call("live-search", "session_search", { needle })]), reply()], {
		contextPolicy: { triggerTokens: 1_000_000, hardLimitTokens: 2_000_000, compactTokens: 1_800_000, compactTailTokens: 100, minBatchTokens: 100 },
	});
	writeFileSync(join(f.workspace, "old.txt"), `${needle}\n${"old source line\n".repeat(300)}`);
	assert.equal((await f.session.run("Read old.txt.")).status, "completed");
	const first = await f.session.compactNow(); const second = await f.session.compactNow();
	assert.equal(first.revision?.reason, "compaction"); assert.equal(second.revision?.reason, "compaction");
	return { ...f, needle, firstRef: first.revision!.maskedRefs[0]!, snapshot: f.session.exportSnapshot() };
}

test("search restores nested checkpoint evidence after two public compactNow calls", async t => {
	const f = await nestedFixture(t);
	assert.ok(!f.snapshot.context.history.some(item => checkpointArchiveRef(item.message.content) === f.firstRef), "the first archive is only nested");
	assert.equal((await f.session.run("Find earlier evidence.")).status, "completed");
	const live = JSON.parse(f.adapter.requests.at(-1)!.messages.find(message => message.role === "tool" && message.toolCallId === "live-search")!.content);
	const adapter = new ScriptedModelAdapter([reply([call("restored-search", "session_search", { needle: f.needle })]), reply()]);
	const restored = new AgentSession({ ...f.options, dataDir: join(f.root, "restored"), adapter });
	restored.restoreSnapshot(f.snapshot);
	assert.equal(adapter.requests.length, 0);
	assert.equal((await restored.run("Find earlier evidence.")).status, "completed");
	const found = JSON.parse(adapter.requests.at(-1)!.messages.find(message => message.role === "tool" && message.toolCallId === "restored-search")!.content);
	assert.equal(live.matches.length, 1); assert.equal(found.matches.length, 1); assert.equal(found.complete, true);
	for (const key of ["role", "toolCallId", "name", "target", "ref", "text"]) assert.equal(found.matches[0][key], live.matches[0][key], key);
});

test("missing nested checkpoint archives reject restore before importing history", async t => {
	const f = await nestedFixture(t);
	const [, , workspace, session, kind, hash] = f.firstRef.split("_");
	const path = join(f.options.archiveDir!, workspace!, session!, kind!, hash!.slice(0, 2), hash!);
	const original = readFileSync(path); rmSync(path);
	const restored = new AgentSession({ ...f.options, dataDir: join(f.root, "restored") });
	assert.throws(() => restored.restoreSnapshot(f.snapshot), /交互归档缺失/);
	assert.equal(restored.builder.length, 0);
	writeFileSync(path, original);
	assert.doesNotThrow(() => restored.restoreSnapshot(f.snapshot), "a failed restore leaves a usable empty session");
});

test("restoring repeated content-addressed interaction archives preserves every occurrence", async t => {
	const needle = "unique-search-needle";
	const policy = { triggerTokens: 1_000_000, hardLimitTokens: 2_000_000, compactTokens: 1_800_000, compactTailTokens: 100, minBatchTokens: 0, settledUserTurns: 100 };
	const read = (id: string) => reply([call(id, "context_expand", { key: "same" })]);
	const f = fixture(t, [read("a"), read("b"), reply(), read("a"), reply(), read("c"), reply(),
		reply([call("live-search", "session_search", { needle })]), reply()], {
		contextPolicy: policy,
		tools: [{ ...tools[0]!, async execute() { return { ok: true, modelContent: `${needle}\n${"data".repeat(500)}`, summary: "read", details: {} }; } }],
	});
	for (const task of ["Read twice.", "Read again.", "Read once more."]) {
		assert.equal((await f.session.run(task)).status, "completed");
		assert.ok(f.session.builder.losslessRevision(policy, f.options.maxTokens, f.session.builder.plan().totalTokensEst, true));
	}
	const refs = f.session.builder.checkpointArchiveRefs();
	assert.equal(refs.length, 3); assert.equal(new Set(refs).size, 2, "the same archived interaction occurred twice");
	const snapshot = f.session.exportSnapshot();
	assert.equal((await f.session.run("Find earlier evidence.")).status, "completed");
	const live = JSON.parse(f.adapter.requests.at(-1)!.messages.find(message => message.role === "tool" && message.toolCallId === "live-search")!.content);
	const adapter = new ScriptedModelAdapter([reply([call("restored-search", "session_search", { needle })]), reply()]);
	const restored = new AgentSession({ ...f.options, dataDir: join(f.root, "restored"), adapter });
	restored.restoreSnapshot(snapshot);
	assert.equal((await restored.run("Find earlier evidence.")).status, "completed");
	const found = JSON.parse(adapter.requests.at(-1)!.messages.find(message => message.role === "tool" && message.toolCallId === "restored-search")!.content);
	assert.equal(live.complete, true); assert.equal(found.complete, true);
	assert.deepEqual(live.matches.map((hit: { toolCallId: string }) => hit.toolCallId), ["a", "b", "a", "c"]);
	assert.deepEqual(found.matches.map((hit: { toolCallId: string }) => hit.toolCallId), ["a", "b", "a", "c"]);
});
