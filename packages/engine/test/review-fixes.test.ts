import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession, BudgetExceeded, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

// Regression checks for the 2026-10-22 code review (B01, B02, B13–B15, B20, P10).
const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
function reply(content = "done", calls: RecordedResponse["message"]["toolCalls"] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : content, reasoning: "", toolCalls: calls },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage, httpStatus: 200, error: null, aborted: false };
}
function fixture(t: TestContext, responses: RecordedResponse[], extra: Partial<EngineOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-fixes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	const adapter = new ScriptedModelAdapter(responses);
	const options: EngineOptions = { workspace, dataDir: join(root, "data"), archiveDir: join(root, "archive"), sessionId: "ses_review_fixes",
		adapter, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64,
		checkpoints: false, requestGuard: true, allowSessionSnapshots: true, retry: { maxAttempts: 1, baseDelayMs: 0 },
		budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(root, "spend.jsonl") }), limits: { maxTurns: 6, maxCost: 2 }, ...extra };
	return { root, workspace, adapter, options, agent: new AgentSession(options) };
}

test("B01: reservations on one shared ledger stop the second request that would exceed the total", (t) => {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-budget-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ledgerPath = join(root, "spend.jsonl");
	const first = new BudgetGuard({ globalLimit: 0.1, ledgerPath });
	const second = new BudgetGuard({ globalLimit: 0.1, ledgerPath });
	first.reserve({ runId: "a", requestId: "a-1", amount: 0.08 }, 1);
	assert.throws(() => second.reserve({ runId: "b", requestId: "b-1", amount: 0.08 }, 1), BudgetExceeded);
});

test("B02: a run's own limit is checked against that run only, while the global total keeps adding up", (t) => {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-budget-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const guard = new BudgetGuard({ globalLimit: 10, ledgerPath: join(root, "spend.jsonl") });
	for (let run = 1; run <= 10; run++) guard.record({ runId: `run-${run}`, requestId: "r1", amount: 0.0008096, partial: false });
	assert.doesNotThrow(() => guard.check(0.0021296, 0.01, "run-11"), "earlier runs' spending does not count against this run");
	assert.throws(() => guard.check(0.0021296, 0.0001, "run-11"), BudgetExceeded, "the run's own limit still holds");
	assert.throws(() => new BudgetGuard({ globalLimit: 0.009, ledgerPath: join(root, "spend.jsonl") }).check(0.002, 1, "run-11"), BudgetExceeded, "the global limit still counts every run");
});

const overloaded: RecordedResponse = { ok: false, message: { role: "assistant", content: "", reasoning: "", toolCalls: [] }, finishReason: null, responseModel: null,
	rawUsage: null, httpStatus: 503, error: { message: "503 Server Overloaded", retryable: true }, aborted: false };

test("a guarded run retries a server error that reports no usage, charging it at worst case", async (t) => {
	const f = fixture(t, [overloaded, overloaded, reply("recovered")], { retry: { maxAttempts: 11, baseDelayMs: 0 } });
	const summary = await f.agent.run("answer");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(summary.finalText, "recovered");
	assert.equal(f.adapter.requests.length, 3);
	assert.equal(summary.totals.usagePartialRequests, 2, "each failed attempt is charged conservatively");
});

test("after ten automatic retries a guarded run pauses with the server's error", async (t) => {
	const ledgerDir = mkdtempSync(join(tmpdir(), "mountains-retry-"));
	t.after(() => rmSync(ledgerDir, { recursive: true, force: true }));
	// Room for eleven worst-case charges, so the retry limit and not the budget ends the run.
	const f = fixture(t, Array.from({ length: 12 }, () => overloaded), { retry: { maxAttempts: 11, baseDelayMs: 0 },
		budget: new BudgetGuard({ globalLimit: 50, ledgerPath: join(ledgerDir, "spend.jsonl") }), limits: { maxTurns: 6, maxCost: 40 } });
	const summary = await f.agent.run("answer");
	assert.equal(summary.status, "failed");
	assert.match(summary.reason, /已自动重试 10 次，先暂停：503 Server Overloaded/);
	assert.equal(f.adapter.requests.length, 11, "the first attempt and ten retries, no more");
});

test("B13: a tool that ran keeps its result and the run ends cleanly when archiving fails", async (t) => {
	const write = { id: "w1", name: "file_write", argumentsJson: JSON.stringify({ path: "out.txt", content: "COMPLETED WRITE\n" }) };
	let f!: ReturnType<typeof fixture>;
	f = fixture(t, [reply("", [write]), reply()], { onEvent(event) {
		// Break the archive right after the tool's side effect, as a full disk or a bad mount would.
		if (event.type === "tool.completed") { rmSync(f.options.archiveDir!, { recursive: true, force: true }); writeFileSync(f.options.archiveDir!, "not a directory"); }
	} });
	const summary = await f.agent.run("write the file");
	assert.equal(readFileSync(join(f.workspace, "out.txt"), "utf8"), "COMPLETED WRITE\n", "the side effect happened exactly once");
	assert.equal(summary.status, "failed");
	assert.match(summary.reason, /归档失败/);
	const messages = f.agent.builder.plan().messages;
	assert.ok(messages.some((m) => m.role === "tool" && m.toolCallId === "w1"), "the executed call keeps its paired result");
	assert.equal(f.adapter.remaining, 1, "no further request was sent after the failure");
});

test("B14: compactNow with a cancelled signal changes nothing and sends nothing", async (t) => {
	const f = fixture(t, [reply("first"), reply("second"), reply("summary")]);
	await f.agent.run("turn 1");
	await f.agent.run("turn 2");
	const before = f.agent.builder.plan();
	const requests = f.adapter.requests.length;
	const controller = new AbortController(); controller.abort();
	const result = await f.agent.compactNow(controller.signal);
	assert.equal(result.revision, null);
	assert.equal(f.adapter.requests.length, requests);
	assert.deepEqual(f.agent.builder.plan(), before);
	assert.doesNotThrow(() => f.agent.exportSnapshot(), "the finished session stays exportable");
});

test("B15: compacting a session that has never run does not make it exportable", async (t) => {
	const f = fixture(t, []);
	const result = await f.agent.compactNow();
	assert.equal(result.revision, null);
	assert.throws(() => f.agent.exportSnapshot(), /完整结束/);
});

test("B20: a replayed response keeps its billing receipt for the same verification", async () => {
	const receipt = { kind: "openrouter-usage-cost" as const, endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini", currency: "USD" as const, amount: 0.00001, inputTokens: 10, outputTokens: 5, totalTokens: 15 };
	const adapter = new ScriptedModelAdapter([{ ...reply(), billingReceipt: receipt }, { ...reply(), billingReceiptRejected: true }]);
	const request = { model: "openai/gpt-4.1-mini", system: "s", tools: [], messages: [], thinking: { enabled: false, effort: "default" as const }, maxTokens: 64 };
	assert.deepEqual((await adapter.complete(request)).billingReceipt, receipt);
	assert.equal((await adapter.complete(request)).billingReceiptRejected, true);
});

test("P10: a model summary longer than what it replaces is not published; the program's record is", async (t) => {
	const reads = ["a", "b", "c"].map((id) => ({ id, name: "file_read", argumentsJson: JSON.stringify({ path: "big.txt", startLine: 1, endLine: 400 }) }));
	const long = "summary ".repeat(6000);
	const f = fixture(t, [...reads.flatMap((read) => [reply("", [read]), reply("ok")]), reply(long)], { maxTokens: 32_000 });
	writeFileSync(join(f.workspace, "big.txt"), Array.from({ length: 400 }, (_, i) => `line ${i} of a file`).join("\n"));
	for (const task of ["read once", "read twice", "read thrice"]) await f.agent.run(task);
	const before = f.agent.builder.plan().totalTokensEst;
	const result = await f.agent.compactNow();
	assert.ok(result.revision, "something was compacted");
	const after = f.agent.builder.plan();
	assert.ok(after.totalTokensEst < before, `compaction made the context smaller (${before} -> ${after.totalTokensEst} tokens)`);
	assert.ok(!after.messages.some((m) => m.role === "user" && m.content.includes(long.trim())), "the oversized summary was not published");
	assert.ok(after.messages.some((m) => m.role === "user" && m.content.includes("program record")), "the program's own record replaced the earlier messages");
	assert.ok(!existsSync(join(f.options.archiveDir!, "missing")));
});
