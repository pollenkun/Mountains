import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import { ChatCompletionsAdapter, estimateCost, pricingFor, type RawUsage } from "@mountains/providers";
import { generalTools } from "@mountains/tools";
import { AgentSession } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";

// Fake HTTP replies only. The adapter, SSE parser, engine, file tool and budget journal are real.
const fullUsage: RawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
	prompt_tokens_details: { cached_tokens: 20 }, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80 };
type Round = { responseModel: string; read?: boolean; rawUsage?: RawUsage | null };
function fixture(t: TestContext, model: string, rounds: Round[], guarded = true) {
	const base = mkdtempSync(join(tmpdir(), "mountains-provider-accounting-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "workspace"); mkdirSync(workspace);
	writeFileSync(join(workspace, "a.txt"), "LOCAL_FILE_READ_FROM_DISK\n");
	const bodies: Record<string, unknown>[] = [];
	let roundIndex = 0;
	const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
		assert.equal(typeof init?.body, "string");
		bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
		const round = rounds[roundIndex++];
		assert.ok(round, "offline response script exhausted");
		const delta = round.read ? { role: "assistant", tool_calls: [{ index: 0, id: "read-a", type: "function",
			function: { name: "file_read", arguments: JSON.stringify({ path: "a.txt" }) } }] }
			: { role: "assistant", content: "Read complete." };
		const frames = [
			{ choices: [{ index: 0, delta, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: round.read ? "tool_calls" : "stop" }],
				...(round.rawUsage === null ? {} : { usage: round.rawUsage ?? fullUsage }) },
		];
		const text = frames.map(frame => `data: ${JSON.stringify({ id: `offline-${roundIndex}`, object: "chat.completion.chunk", model: round.responseModel, ...frame })}\n\n`).join("") + "data: [DONE]\n\n";
		return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const adapter = new ChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "OFFLINE_FAKE_KEY", fetch: fakeFetch });
	const currency = pricingFor(model)!.currency;
	const budget = new BudgetGuard({ globalLimit: 1, currency, ledgerPath: join(base, "spend.jsonl") });
	const dataDir = join(base, "data");
	const events: EngineEvent[] = [];
	const agent = new AgentSession({ workspace, dataDir, adapter, model, requestGuard: guarded,
		tools: generalTools().filter(tool => tool.name === "file_read" || tool.name === "context_expand"),
		thinking: { enabled: model === "glm-5.3-flash" || model === "kimi-k2.7-code", effort: "default" },
		maxTokens: 64, budget, checkpoints: false, retry: { maxAttempts: 1, baseDelayMs: 0 },
		limits: { maxTurns: 3, maxRequests: 3, maxCost: 1 }, onEvent: event => events.push(event) });
	const ledger = () => readFileSync(join(dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as {
		model: string; startedAt: string; cost: number; costPartial: boolean; priceVersion: string; pricePeriod: string;
	});
	return { agent, budget, bodies, events, ledger };
}

for (const [model, responseModel, perRequest] of [
	["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14", 0.00005],
	["openai/gpt-4.1-mini", "openai/gpt-4.1-mini-2025-04-14", 0.000055],
	["qwen-plus", "qwen-plus-2025-12-01", 0.0008832],
	["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-7B-Instruct", 0],
] as const) {
	test(`${model}: registered response identity completes two rounds with a real file read and route prices`, async t => {
		const f = fixture(t, model, [{ responseModel, read: true }, { responseModel }]);
		const result = await f.agent.run("Read a.txt and report its contents.");
		assert.equal(result.status, "completed", result.reason);
		assert.equal(f.bodies.length, 2);
		assert.ok(f.bodies.every(body => body.model === model));
		assert.ok(JSON.stringify(f.bodies[1]).includes("LOCAL_FILE_READ_FROM_DISK"));
		assert.ok(f.events.some(event => event.type === "tool.completed" && event.tool === "file_read" && event.ok));
		assert.equal(result.totals.usagePartialRequests, 0);
		assert.ok(Math.abs(result.totals.cost - 2 * perRequest) < 1e-12);
		assert.equal(f.budget.snapshot({ runId: result.runId }).spent, result.totals.cost);
		assert.equal(f.budget.snapshot({ runId: result.runId }).unknownCost, 0);
		const rows = f.ledger();
		assert.equal(rows.length, 2);
		assert.ok(rows.every(row => row.model === responseModel && !row.costPartial));
		assert.ok(rows.every(row => row.priceVersion === pricingFor(model)!.version && row.pricePeriod === "flat"));
		const usageEvents = f.events.filter(event => event.type === "usage");
		assert.equal(usageEvents.length, 2);
		assert.ok(usageEvents.every(event => event.model === responseModel && event.cost !== null && Math.abs(event.cost - perRequest) < 1e-12));
		if (model === "openai/gpt-4.1-mini") {
			assert.ok(result.totals.cost > 2 * estimateCost("gpt-4.1-mini", fullUsage, new Date())!.amount,
				"OpenRouter must retain its own higher route price instead of the upstream OpenAI price");
		}
	});
}

for (const [model, responseModel] of [
	["openai/gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"],
	["openai/gpt-4.1-mini", "gpt-4.1-mini"],
	["gpt-4.1-mini", "openai/gpt-4.1-mini-2025-04-14"],
	["gpt-4.1-mini", "gpt-4.1-mini-2026-10-03"],
	["qwen-plus", "qwen-plus-2026-10-03"],
	["Qwen/Qwen2.5-7B-Instruct", "Pro/Qwen/Qwen2.5-7B-Instruct"],
] as const) {
	test(`${model} rejects unregistered or differently routed response ${responseModel} before tools`, async t => {
		const f = fixture(t, model, [{ responseModel, read: true }]);
		const result = await f.agent.run("Read a.txt.");
		assert.equal(result.status, "limit");
		assert.equal(f.bodies.length, 1);
		assert.equal(result.totals.usagePartialRequests, 1);
		assert.equal(f.events.some(event => event.type === "tool.completed"), false);
		const rows = f.ledger();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.model, responseModel);
		assert.equal(rows[0]!.costPartial, true);
		const saved = f.budget.snapshot({ runId: result.runId });
		assert.equal(saved.spent, result.totals.cost);
		assert.equal(saved.unknownCost, result.totals.cost);
		assert.equal(saved.reserved, 0);
		const restored = new BudgetGuard({ globalLimit: 1, currency: result.totals.currency, ledgerPath: f.budget.ledgerPath });
		assert.deepEqual(restored.snapshot({ runId: result.runId }), saved);
	});
}

for (const model of ["gpt-4.1-mini", "openai/gpt-4.1-mini", "Qwen/Qwen2.5-7B-Instruct"] as const) {
	test(`${model}: missing usage stays unknown and cannot execute tools, including a free route`, async t => {
		const f = fixture(t, model, [{ responseModel: model, read: true, rawUsage: null }]);
		const result = await f.agent.run("Read a.txt.");
		assert.equal(result.status, "limit");
		assert.equal(result.totals.usagePartialRequests, 1);
		assert.equal(f.events.some(event => event.type === "tool.completed"), false);
		assert.equal(f.ledger()[0]!.costPartial, true);
		assert.equal(f.bodies.length, 1);
	});
}

test("a registered OpenAI date alias still stops when cached-token usage is missing", async t => {
	const f = fixture(t, "gpt-4.1-mini", [{ responseModel: "gpt-4.1-mini-2025-04-14", read: true,
		rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }]);
	const result = await f.agent.run("Read a.txt.");
	assert.equal(result.status, "limit");
	assert.equal(result.totals.usagePartialRequests, 1);
	assert.equal(f.bodies.length, 1);
	assert.equal(f.events.some(event => event.type === "tool.completed"), false);
	assert.equal(f.ledger()[0]!.costPartial, true);
	assert.ok(f.budget.snapshot({ runId: result.runId }).unknownCost > 0);
});

for (const model of ["deepseek-flash", "glm-5.3-flash", "kimi-k2.7-code"] as const) {
	test(`${model}: legacy unguarded CLI prices and actual model evidence are preserved`, async t => {
		const responseModel = model === "deepseek-flash" ? "deepseek-v4-flash" : model;
		const f = fixture(t, model, [{ responseModel, read: true }, { responseModel }], false);
		const result = await f.agent.run("Read a.txt.");
		assert.equal(result.status, "completed", result.reason);
		assert.equal(result.totals.usagePartialRequests, 0);
		assert.ok(f.events.some(event => event.type === "tool.completed" && event.ok));
		const rows = f.ledger();
		assert.equal(rows.length, 2);
		for (const row of rows) {
			assert.equal(row.model, responseModel);
			assert.equal(row.costPartial, false);
			assert.equal(row.cost, estimateCost(responseModel, fullUsage, new Date(row.startedAt))!.amount);
			assert.equal(row.priceVersion, pricingFor(model)!.version);
		}
		assert.equal(result.totals.cost, rows.reduce((sum, row) => sum + row.cost, 0));
	});
}
