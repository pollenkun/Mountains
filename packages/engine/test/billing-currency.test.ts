import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import { estimateCost, pricingFor, type Currency } from "@mountains/providers";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, validateApprovalSettings, type EngineOptions, type RecordedResponse } from "../src/index.ts";

const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
function fixture(t: TestContext, model = "deepseek-flash", currency?: Currency, raw: RecordedResponse["rawUsage"] = rawUsage) {
	const root = mkdtempSync(join(tmpdir(), "mountains-billing-currency-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	const response: RecordedResponse = { ok: true, message: { role: "assistant", content: "Done", reasoning: "", toolCalls: [] }, finishReason: "stop", responseModel: model,
		rawUsage: raw, httpStatus: 200, error: null, aborted: false };
	const events: EngineEvent[] = [];
	const selected = currency ?? pricingFor(model)!.currency;
	const options: EngineOptions = { workspace, dataDir: join(root, "data"), model,
		...(currency ? { billingCurrency: currency } : {}), adapter: new ScriptedModelAdapter([response]),
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, requestGuard: true, checkpoints: false,
		budget: new BudgetGuard({ globalLimit: 5, currency: selected, ledgerPath: join(root, "spend.jsonl") }),
		limits: { maxCost: 2 }, retry: { maxAttempts: 1, baseDelayMs: 0 }, onEvent: event => events.push(event) };
	return { root, events, options, response };
}

for (const model of ["deepseek-flash", "deepseek-v4-pro", "glm-5.3-flash", "kimi-k2.7-code"]) {
	test(`explicit CNY bills ${model} totals, usage, ledger and reservations in the selected currency`, async (t) => {
		const f = fixture(t, model, "CNY"); const result = await new AgentSession(f.options).run("Offline billing");
		assert.equal(result.status, "completed", result.reason); assert.equal(result.totals.currency, "CNY");
		const rows = readFileSync(join(f.root, "data", "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		const estimate = estimateCost(model, rawUsage, new Date(rows[0].startedAt), "CNY")!;
		assert.equal(result.totals.cost, estimate.amount); assert.equal(rows[0].cost, estimate.amount); assert.equal(rows[0].currency, "CNY");
		assert.equal(rows[0].priceVersion, pricingFor(model, "CNY")!.version);
		const usage = f.events.find(event => event.type === "usage"); assert.ok(usage?.type === "usage");
		assert.equal(usage.currency, "CNY"); assert.equal(usage.cost, estimate.amount);
		const recording = readFileSync(join(f.root, "data", "recording.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(recording.find(row => row.kind === "meta").data.billingCurrency, "CNY", "Offline replay must keep the original pricing unit");
		const budget = readFileSync(f.options.budget.ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.ok(budget.every(row => row.currency === "CNY"));
		assert.equal(budget.find(row => row.kind === "budget.settle").amount, estimate.amount);
	});
}

test("omitting billingCurrency retains the legacy DeepSeek USD estimate", async (t) => {
	const f = fixture(t); const result = await new AgentSession(f.options).run("Legacy billing");
	assert.equal(result.totals.currency, "USD");
	const row = JSON.parse(readFileSync(join(f.root, "data", "ledger.jsonl"), "utf8").trim());
	assert.equal(result.totals.cost, estimateCost("deepseek-flash", rawUsage, new Date(row.startedAt))!.amount);
	assert.equal(row.priceVersion, pricingFor("deepseek-flash")!.version);
	const recording = readFileSync(join(f.root, "data", "recording.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(Object.hasOwn(recording.find(row => row.kind === "meta").data, "billingCurrency"), false, "Legacy metadata remains unchanged");
});

test("currency selection rejects an unavailable price or a mismatched BudgetGuard before any request", (t) => {
	const f = fixture(t);
	assert.throws(() => new AgentSession({ ...f.options, billingCurrency: "CNY" }), /币种一致/);
	assert.throws(() => new AgentSession({ ...f.options, model: "glm-5.3-flash", billingCurrency: "USD" }), /没有该币种/);
	assert.throws(() => new AgentSession({ ...f.options, billingCurrency: "INVALID" as Currency }), /USD 或 CNY/);
	assert.equal((f.options.adapter as ScriptedModelAdapter).requests.length, 0);
});

test("partial CNY usage preserves conservative spending and its unknown flag", async (t) => {
	const f = fixture(t, "deepseek-flash", "CNY", {}); const result = await new AgentSession(f.options).run("Incomplete usage");
	assert.equal(result.status, "limit"); assert.equal(result.totals.usagePartialRequests, 1); assert.ok(result.totals.cost > 0);
	const row = JSON.parse(readFileSync(join(f.root, "data", "ledger.jsonl"), "utf8").trim());
	assert.equal(row.currency, "CNY"); assert.equal(row.costPartial, true);
	assert.ok(f.options.budget.snapshot({ runId: result.runId }).unknownCost > 0);
});

test("approval pricing validates the selected task currency and requires explicit cross-currency conversion", (t) => {
	const f = fixture(t, "deepseek-flash", "CNY");
	const settings = validateApprovalSettings({ model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_OFFLINE_KEY", profile: "deepseek",
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, maxInputChars: 20_000, timeoutMs: 1000, maxRequests: 4, maxDenials: 2, maxCost: 1,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "test" } }, "USD");
	assert.throws(() => new AgentSession({ ...f.options, modelApproval: { settings, adapter: f.options.adapter } }), /跨币种/);
	const converted = { ...settings, conversion: { rate: 7, asOf: "2026-10-01" } };
	assert.doesNotThrow(() => new AgentSession({ ...f.options, modelApproval: { settings: converted, adapter: f.options.adapter } }));
	assert.doesNotThrow(() => new AgentSession({ ...f.options, modelApproval: { settings: { ...settings, pricing: { ...settings.pricing, currency: "CNY" } }, adapter: f.options.adapter } }));
});

for (const nativeCurrency of ["CNY", "USD"] as const) {
	test(`approval-model ${nativeCurrency} costs are settled into the selected CNY task ledger`, async (t) => {
		const f = fixture(t, "deepseek-flash", "CNY");
		const settings = validateApprovalSettings({ model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_OFFLINE_KEY", profile: "deepseek",
			thinking: { enabled: false, effort: "default" }, maxTokens: 64, maxInputChars: 50_000, timeoutMs: 1000, maxRequests: 4, maxDenials: 2, maxCost: 1,
			pricing: { currency: nativeCurrency, inputPerMillion: 1, outputPerMillion: 1, version: "offline-approval" },
			...(nativeCurrency === "USD" ? { conversion: { rate: 7, asOf: "2026-10-01" } } : {}) }, "CNY");
		const write: RecordedResponse = { ...f.response, finishReason: "tool_calls", message: { role: "assistant", content: "", reasoning: "", toolCalls: [{ id: "write", name: "file_write", argumentsJson: '{"path":"approved.txt","content":"approved"}' }] } };
		f.options.adapter = new ScriptedModelAdapter([write, f.response]);
		f.options.modelApproval = { settings, adapter: { id: "offline-approval", async complete(req) {
			const evidence = JSON.parse(req.messages[0]!.content);
			const response = { ...f.response, message: { ...f.response.message, content: JSON.stringify({ decision: "allow", authorization: [{ requestId: evidence.userRequests[0].id, quote: evidence.userRequests[0].text }] }) } };
			return new ScriptedModelAdapter([response]).complete(req);
		} } };
		const result = await new AgentSession(f.options).run("Create approved.txt");
		assert.equal(result.status, "completed", result.reason); assert.equal(result.totals.approvalRequests, 1);
		const expected = (100 + 10) / 1_000_000 * (nativeCurrency === "USD" ? 7 : 1);
		assert.equal(result.totals.approvalCost, expected);
		const rows = readFileSync(join(f.root, "data", "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.ok(rows.every(row => row.currency === "CNY"));
		assert.equal(rows.find(row => row.purpose === "approval").cost, expected);
		const approval = f.events.find(event => event.type === "usage" && event.pricePeriod === "configured-approval");
		assert.ok(approval?.type === "usage"); assert.equal(approval.currency, "CNY"); assert.equal(approval.cost, expected);
	});
}
