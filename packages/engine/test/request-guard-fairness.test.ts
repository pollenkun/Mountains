import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import type { ModelRequest, ModelResponse } from "@mountains/providers";
import { defaultTools } from "@mountains/tools";
import { AgentSession, type RunLimits } from "../src/driver.ts";
import { validateApprovalSettings } from "../src/approval-settings.ts";
import { BudgetGuard } from "../src/policy.ts";
import { ScriptedModelAdapter, type RecordedResponse } from "../src/replay.ts";

const usage = { prompt_tokens: 2000, completion_tokens: 10, total_tokens: 2010, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2000 };
function reply(read: boolean): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: read ? "" : "done", reasoning: "", toolCalls: read ? [{ id: "read-notes", name: "file_read", argumentsJson: '{"path":"notes.md"}' }] : [] },
		finishReason: read ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage: usage, httpStatus: 200, error: null, aborted: false };
}
/** Both arms use the same response time, including across a provider price-period boundary. */
class FixedTimeScript extends ScriptedModelAdapter {
	override async complete(request: ModelRequest): Promise<ModelResponse> {
		const result = await super.complete(request);
		const at = Date.parse("2026-09-27T04:00:00Z");
		return { ...result, startedAt: at, firstByteAt: at, finishedAt: at + 1 };
	}
}
type BudgetRow = { kind?: string; worstCost?: number; amount?: number; partial?: boolean; overrun?: boolean };
function fixture(t: TestContext) {
	const base = mkdtempSync(join(tmpdir(), "request-guard-fairness-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "workspace"); mkdirSync(workspace);
	// Retain the reported regression's single long line. file_read legitimately clips
	// its displayed line; both arms still receive the same actual tool output.
	writeFileSync(join(workspace, "notes.md"), "中文说明。".repeat(4000));
	const settings = validateApprovalSettings({
		model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_FAIRNESS_KEY", profile: "deepseek",
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, maxInputChars: 20_000, timeoutMs: 200,
		maxRequests: 10, maxDenials: 3, maxCost: 0.25,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "offline-fairness" },
	}, "USD");
	let count = 0;
	return async function run(approval: boolean, options: { requestGuard?: boolean; globalLimit?: number; limits?: Partial<RunLimits> } = {}) {
		const dataDir = join(base, `run-${++count}`); const ledgerPath = join(base, `spend-${count}.jsonl`);
		const budget = new BudgetGuard({ globalLimit: options.globalLimit ?? 1, currency: "USD", ledgerPath });
		const main = new FixedTimeScript([reply(true), reply(false)]); const judge = new ScriptedModelAdapter([]);
		const events: EngineEvent[] = [];
		const agent = new AgentSession({
			workspace, dataDir, adapter: main, tools: defaultTools(), model: "deepseek-flash", thinking: { enabled: true, effort: "high" }, maxTokens: 64,
			budget, checkpoints: false, retry: { maxAttempts: 1, baseDelayMs: 0 }, sessionId: "same-read-only-session", runId: "same-read-only-run",
			limits: { maxTurns: 8, maxRequests: 8, maxCost: 1, maxInputTokens: 100_000, maxOutputTokens: 100_000, ...options.limits },
			...(options.requestGuard === undefined ? {} : { requestGuard: options.requestGuard }),
			...(approval ? { modelApproval: { settings, adapter: judge } } : {}), onEvent: (event) => events.push(event),
		});
		const summary = await agent.run("Read notes.md and summarize.");
		const rows: BudgetRow[] = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
		const reservations = rows.filter((row) => row.kind === "budget.reserve").map((row) => row.worstCost);
		assert.ok(reservations.every((value) => typeof value === "number" && value > 0));
		assert.equal(judge.requests.length, 0, "a pure read must never contact the approval model");
		const snapshot = budget.snapshot({ runId: summary.runId }); assert.equal(snapshot.spent, summary.totals.cost);
		return { summary, mainRequests: main.requests.length, readCalls: events.filter((event) => event.type === "tool.completed" && event.tool === "file_read" && event.ok).length,
			reservations: reservations as number[], settlements: rows.filter((row) => row.kind === "budget.settle").map((row) => ({ amount: row.amount, partial: row.partial, overrun: row.overrun })), snapshot };
	};
}
type Outcome = Awaited<ReturnType<ReturnType<typeof fixture>>>;
function sameReadOnlyOutcome(off: Outcome, on: Outcome): void {
	assert.equal(on.mainRequests, off.mainRequests, "approval must not change main request count when requestGuard is shared");
	assert.equal(on.readCalls, off.readCalls);
	assert.equal(on.summary.status, off.summary.status); assert.equal(on.summary.reason, off.summary.reason);
	assert.equal(on.summary.totals.requests, off.summary.totals.requests);
	assert.equal(on.summary.totals.input, off.summary.totals.input); assert.equal(on.summary.totals.output, off.summary.totals.output);
	assert.equal(on.summary.totals.cacheRead, off.summary.totals.cacheRead);
	assert.equal(on.summary.totals.cost, off.summary.totals.cost);
	assert.deepEqual(on.reservations, off.reservations, "compare original reservation amounts, without rounding or recalculating the bound");
	assert.deepEqual(on.settlements, off.settlements); assert.deepEqual(on.snapshot, off.snapshot);
}

test("shared request guard gives approval off/on identical read-only requests, reservations and final cost", async (t) => {
	const run = fixture(t); const off = await run(false, { requestGuard: true }); const on = await run(true, { requestGuard: true });
	sameReadOnlyOutcome(off, on);
	assert.equal(off.summary.status, "completed"); assert.equal(off.mainRequests, 2); assert.equal(off.readCalls, 1);
	assert.equal(off.reservations.length, 2); assert.equal(off.settlements.length, 2);
});

test("a tight money budget stops both guarded arms after the same real read", async (t) => {
	const run = fixture(t); const calibration = await run(true, { requestGuard: true });
	assert.equal(calibration.summary.status, "completed"); assert.equal(calibration.reservations.length, 2);
	const [first, second] = calibration.reservations as [number, number];
	assert.ok(second > first, "the real read must increase the next observed reservation");
	// Choose between observed public ledger amounts, without copying the engine's
	// byte-to-token or pricing formula. Keep task and approval sub-budgets identical.
	const globalLimit = (first + second) / 2;
	const off = await run(false, { requestGuard: true, globalLimit }); const on = await run(true, { requestGuard: true, globalLimit });
	sameReadOnlyOutcome(off, on);
	assert.equal(off.summary.status, "limit"); assert.match(off.summary.reason, /全局预算不足/);
	assert.equal(off.mainRequests, 1); assert.equal(off.readCalls, 1); assert.equal(off.reservations.length, 1);
});

test("the reported 12000-input limit has the same stopping point with approval off or on under a shared guard", async (t) => {
	const run = fixture(t); const options = { requestGuard: true, limits: { maxInputTokens: 12_000 } };
	const off = await run(false, options); const on = await run(true, options);
	sameReadOnlyOutcome(off, on);
	assert.equal(off.summary.status, "limit"); assert.match(off.summary.reason, /token 上限/);
	assert.equal(off.mainRequests, 1); assert.equal(off.readCalls, 1); assert.equal(off.reservations.length, 1);
});

test("a tight output limit has the same stopping point with approval off or on under a shared guard", async (t) => {
	const run = fixture(t); const options = { requestGuard: true, limits: { maxOutputTokens: 70 } };
	const off = await run(false, options); const on = await run(true, options);
	sameReadOnlyOutcome(off, on);
	assert.equal(off.summary.status, "limit"); assert.match(off.summary.reason, /token 上限/);
	assert.equal(off.mainRequests, 1); assert.equal(off.readCalls, 1); assert.equal(off.reservations.length, 1);
});

test("legacy defaults stay unchanged, while approval always implies request protection", async (t) => {
	const run = fixture(t); const limits = { maxInputTokens: 12_000 };
	const omitted = await run(false, { limits }); const disabled = await run(false, { requestGuard: false, limits });
	sameReadOnlyOutcome(omitted, disabled); assert.equal(omitted.summary.status, "completed"); assert.equal(omitted.mainRequests, 2);
	assert.deepEqual(omitted.reservations, []);
	const guarded = await run(false, { requestGuard: true, limits });
	const implied = await run(true, { limits }); const cannotDisable = await run(true, { requestGuard: false, limits });
	sameReadOnlyOutcome(guarded, implied); sameReadOnlyOutcome(guarded, cannotDisable);
	assert.equal(guarded.mainRequests, 1);
});
