import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions } from "../src/index.ts";

// A model served on this computer (LM Studio, Ollama) is not in the price list and costs nothing.
function session(t: TestContext, extra: Partial<EngineOptions>) {
	const base = mkdtempSync(join(tmpdir(), "mountains-local-model-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "workspace"); mkdirSync(workspace);
	const adapter = new ScriptedModelAdapter([{
		ok: true, message: { role: "assistant", content: "Done.", reasoning: "", toolCalls: [] }, finishReason: "stop", responseModel: "qwythos-9b",
		rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, httpStatus: 200, error: null, aborted: false,
	}]);
	return new AgentSession({
		workspace, dataDir: join(base, "data"), adapter, model: "qwythos-9b", thinking: { enabled: false, effort: "high" }, maxTokens: 100,
		budget: new BudgetGuard({ globalLimit: 1, ledgerPath: join(base, "spend.jsonl") }), checkpoints: false, systemPrompt: "Answer briefly.", ...extra,
	});
}

test("a local model outside the price list runs at no cost", async t => {
	const result = await session(t, { localModel: true }).run("Say done.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(result.totals.requests, 1);
	assert.equal(result.totals.cost, 0);
});

test("a local model keeps working under the request guard although it reports no cache usage", async t => {
	const result = await session(t, { localModel: true, requestGuard: true }).run("Say done.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(result.totals.cost, 0);
	assert.equal(result.totals.usagePartialRequests, 0);
});

test("an unpriced model elsewhere is still stopped before any request", async t => {
	await assert.rejects(session(t, {}).run("Say done."), /有限非负数/);
});

test("a catalog model with no price counts tokens and does not require a budget", async t => {
	const result = await session(t, { model: "gpt-image-1" }).run("Say done.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(result.totals.cost, 0);
	assert.equal(result.totals.requests, 1);
	assert.equal(result.totals.input, 100);
	assert.equal(result.totals.output, 10);
});
