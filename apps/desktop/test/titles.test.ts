import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetGuard } from "@mountains/engine";
import type { EngineEvent } from "@mountains/protocol";
import type { Desk } from "../src/main/desk.ts";
import { bindTitles } from "../src/main/titles.ts";

const base = { protocolVersion: "0.1.0" as const, sessionId: "s", runId: "r", seq: 1, eventId: "e", time: "t" };
const usage = { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 40 };

function setup(named?: "user" | "auto") {
	const home = mkdtempSync(join(tmpdir(), "mountains-desktop-titles-"));
	const config = join(home, "config.json"), ledger = join(home, "spend.jsonl");
	writeFileSync(config, `${JSON.stringify({ model: "deepseek-flash", baseUrl: "https://offline.invalid/v1", apiKeyEnv: "DEEPSEEK_API_KEY", checkpoints: false, limits: { maxTurns: 6, maxRequests: 6, maxCost: 5 } })}\n`);
	const listeners: Array<(id: string, event: EngineEvent) => void> = [], named_: Array<[string, string]> = [], bodies: string[] = [];
	const desk = {
		onEvent: (listener: (id: string, event: EngineEvent) => void) => { listeners.push(listener); return () => {}; },
		list: () => [{ id: "c1", title: "把支付的测试跑一遍，失败的修掉。", named }],
		history: () => [
			{ ...base, type: "run.started", task: "把支付的测试跑一遍，失败的修掉。" },
			{ ...base, type: "message.completed", turnId: "t", text: "两个签名测试失败，容差改成 300 秒后全部通过。", reasoningChars: 0, toolCalls: [] },
		],
		nameAuto: (id: string, title: string) => { named_.push([id, title]); },
	} as unknown as Desk;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		bodies.push(String(init?.body ?? ""));
		const chunk = { id: "x", object: "chat.completion.chunk", model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", content: "「修复支付签名测试」" }, finish_reason: "stop" }], usage };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	process.env.DEEPSEEK_API_KEY = "desktop-test-key";
	const emit = (event: EngineEvent) => { for (const listener of listeners) listener("c1", event); };
	return { desk, config, ledger, fetch, named: named_, bodies, emit };
}

const done = { ...base, type: "run.completed", status: "completed", reason: "done", turns: 1, totals: { requests: 1, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "USD" } } as EngineEvent;

test("a conversation's first finished run is named by the run's model, thinking off, and the cost is counted", async () => {
	const t = setup();
	bindTitles(t.desk, { configPath: t.config, spendLedger: t.ledger, fetch: t.fetch }, () => ({ enabled: true }));
	t.emit(done);
	for (let i = 0; i < 50 && !t.named.length; i++) await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(t.named, [["c1", "修复支付签名测试"]]);
	assert.equal(t.bodies.length, 1);
	assert.match(t.bodies[0]!, /"model":"deepseek-flash"/);
	assert.doesNotMatch(t.bodies[0]!, /"tools"/);
	assert.doesNotMatch(t.bodies[0]!, /"thinking":\{"type":"enabled"/);
	assert.match(t.bodies[0]!, /签名测试失败/);
	const spent = JSON.parse(readFileSync(t.ledger, "utf8").trim()) as { kind?: string; amount: number };
	assert.equal(spent.kind, undefined, "a plain spent row: a settle row without its reservation breaks the ledger");
	assert.ok(spent.amount > 0);
	assert.doesNotThrow(() => new BudgetGuard({ globalLimit: 1, currency: "CNY", ledgerPath: t.ledger }), "the ledger still reads");
	t.emit(done);
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(t.bodies.length, 1, "asked only once");
});

test("a conversation the user named, or titles turned off, is left alone", async () => {
	for (const [named, enabled] of [["user", true], [undefined, false]] as const) {
		const t = setup(named);
		bindTitles(t.desk, { configPath: t.config, spendLedger: t.ledger, fetch: t.fetch }, () => ({ enabled }));
		t.emit(done);
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(t.bodies.length, 0);
	}
});
