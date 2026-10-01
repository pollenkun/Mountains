import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type EngineEvent, eventErrors, isValidEvent } from "@mountains/protocol";
import { AgentSession, BudgetGuard, DEFAULT_RETRY, replayAdapterFromRecording, retryDelayMs, ScriptedModelAdapter } from "../src/index.ts";

const usage = (miss: number, hit: number, out: number) => ({
	prompt_tokens: miss + hit,
	completion_tokens: out,
	total_tokens: miss + hit + out,
	prompt_cache_hit_tokens: hit,
	prompt_cache_miss_tokens: miss,
	completion_tokens_details: { reasoning_tokens: Math.floor(out / 2) },
});

function script() {
	return [
		{
			ok: true,
			message: {
				role: "assistant" as const,
				content: "",
				reasoning: "先看代码和测试。",
				toolCalls: [
					{ id: "c1", name: "file_read", argumentsJson: '{"path": "calc.py"}' },
					{ id: "c2", name: "content_search", argumentsJson: '{"pattern": "def add"}' },
				],
			},
			finishReason: "tool_calls",
			responseModel: "deepseek-flash",
			rawUsage: usage(900, 0, 80),
			httpStatus: 200,
			error: null,
			aborted: false,
		},
		{
			ok: true,
			message: {
				role: "assistant" as const,
				content: "",
				reasoning: "把减号改成加号。",
				toolCalls: [{ id: "c3", name: "file_edit", argumentsJson: '{"path":"calc.py","oldText":"return a - b","newText":"return a + b"}' }],
			},
			finishReason: "tool_calls",
			responseModel: "deepseek-flash",
			rawUsage: usage(150, 896, 60),
			httpStatus: 200,
			error: null,
			aborted: false,
		},
		{
			ok: true,
			message: {
				role: "assistant" as const,
				content: "",
				reasoning: "跑测试。",
				toolCalls: [{ id: "c4", name: "command_run", argumentsJson: '{"argv":["python3","test_calc.py"]}' }],
			},
			finishReason: "tool_calls",
			responseModel: "deepseek-flash",
			rawUsage: usage(120, 1024, 30),
			httpStatus: 200,
			error: null,
			aborted: false,
		},
		{
			ok: true,
			message: { role: "assistant" as const, content: "已修复 add：把 a - b 改为 a + b，测试通过。", reasoning: "完成。", toolCalls: [] },
			finishReason: "stop",
			responseModel: "deepseek-flash",
			rawUsage: usage(100, 1152, 40),
			httpStatus: 200,
			error: null,
			aborted: false,
		},
	];
}

function makeWorkspace(): string {
	const ws = mkdtempSync(join(tmpdir(), "eng-ws-"));
	writeFileSync(join(ws, "calc.py"), "def add(a, b):\n    return a - b\n");
	writeFileSync(join(ws, "test_calc.py"), "from calc import add\nassert add(2, 3) == 5\nprint('ok')\n");
	return ws;
}

function session(ws: string, adapter: ScriptedModelAdapter, events: EngineEvent[], extra: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
	const data = mkdtempSync(join(tmpdir(), "eng-data-"));
	return {
		data,
		s: new AgentSession({
			workspace: ws,
			dataDir: data,
			adapter,
			model: "deepseek-flash",
			thinking: { enabled: true, effort: "high" },
			maxTokens: 32000,
			budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(data, "spend.jsonl") }),
			onEvent: (e) => events.push(e),
			retry: { maxAttempts: 3, baseDelayMs: 1 },
			...extra,
		}),
	};
}

describe("AgentSession（脚本化模型，离线）", () => {
	test("完整闭环：并行读取 → 编辑 → 运行测试 → 最终答复；事件全部符合协议", async () => {
		const ws = makeWorkspace();
		const events: EngineEvent[] = [];
		const adapter = new ScriptedModelAdapter(script());
		const { s, data } = session(ws, adapter, events);
		const summary = await s.run("修复 calc.py 中 add 的 bug");
		assert.equal(summary.status, "completed", summary.reason);
		assert.equal(summary.turns, 4);
		assert.equal(readFileSync(join(ws, "calc.py"), "utf8"), "def add(a, b):\n    return a + b\n");
		assert.deepEqual(summary.filesChanged, ["calc.py"]);
		assert.equal(summary.totals.requests, 4);
		assert.equal(summary.totals.cacheRead, 896 + 1024 + 1152);
		for (const e of events) assert.ok(isValidEvent(e), `${e.type}: ${eventErrors(e).join("; ")}`);
		const seqs = events.map((e) => e.seq);
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq 单调递增");
		const done = events.find((e) => e.type === "run.completed");
		assert.equal(done?.priority, "high");
		assert.ok(events.some((e) => e.type === "approval.requested" && e.priority === "high"));
		const tool = events.find((e) => e.type === "tool.completed" && e.tool === "command_run");
		assert.ok(tool && tool.type === "tool.completed" && tool.ok, "测试命令通过");
		// 推理内容与模型输出原样只追加：第 4 个请求包含前 3 轮的 reasoning
		const lastReq = adapter.requests[3];
		assert.ok(lastReq);
		const reasonings = lastReq.messages.filter((m) => m.role === "assistant").map((m) => (m.role === "assistant" ? m.reasoning : ""));
		assert.deepEqual(reasonings, ["先看代码和测试。", "把减号改成加号。", "跑测试。"]);
		// 只追加：每个请求的消息都是下一个请求的前缀
		for (let i = 1; i < adapter.requests.length; i++) {
			const prev = adapter.requests[i - 1]?.messages ?? [];
			assert.deepEqual(adapter.requests[i]?.messages.slice(0, prev.length), prev);
		}
		const ledger = readFileSync(join(data, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(ledger.length, 4);
		assert.equal(ledger[0].usage.cacheWrite, null, "DeepSeek 缓存写入为未提供，不是 0");
		assert.ok(ledger.every((r: { costEstimated: boolean }) => r.costEstimated));
	});

	test("离线回放：用录制的模型输出重放，事件类型序列与原运行一致", async () => {
		const ws1 = makeWorkspace();
		const ev1: EngineEvent[] = [];
		const { s, data } = session(ws1, new ScriptedModelAdapter(script()), ev1);
		await s.run("修复 calc.py 中 add 的 bug");
		const ws2 = makeWorkspace();
		const ev2: EngineEvent[] = [];
		const replay = replayAdapterFromRecording(join(data, "recording.jsonl"));
		const r2 = await session(ws2, replay, ev2).s.run("修复 calc.py 中 add 的 bug");
		assert.equal(r2.status, "completed");
		const shape = (es: EngineEvent[]) => es.filter((e) => e.type !== "message.delta").map((e) => (e.type === "tool.completed" ? `${e.type}:${e.tool}:${e.ok}` : e.type));
		assert.deepEqual(shape(ev2), shape(ev1));
		assert.equal(replay.remaining, 0);
		assert.equal(readFileSync(join(ws2, "calc.py"), "utf8"), readFileSync(join(ws1, "calc.py"), "utf8"));
	});

	test("预算守卫：全局预算不足时不发请求并以 limit 结束", async () => {
		const ws = makeWorkspace();
		const adapter = new ScriptedModelAdapter(script());
		const data = mkdtempSync(join(tmpdir(), "eng-data-"));
		const s = new AgentSession({
			workspace: ws,
			dataDir: data,
			adapter,
			model: "deepseek-flash",
			thinking: { enabled: true, effort: "high" },
			maxTokens: 32000,
			budget: new BudgetGuard({ globalLimit: 0.001, ledgerPath: join(data, "spend.jsonl") }),
		});
		const r = await s.run("任务");
		assert.equal(r.status, "limit");
		assert.match(r.reason, /全局预算不足/);
		assert.equal(adapter.requests.length, 0);
	});

	test("可重试错误：每次尝试都记账（含 isRetry）", async () => {
		const ws = makeWorkspace();
		const failing = {
			ok: false,
			message: { role: "assistant" as const, content: "", reasoning: "", toolCalls: [] },
			finishReason: null,
			responseModel: null,
			rawUsage: null,
			httpStatus: 503,
			error: { message: "503 Server Overloaded", retryable: true },
			aborted: false,
		};
		const events: EngineEvent[] = [];
		const { s, data } = session(ws, new ScriptedModelAdapter([failing, ...script()]), events);
		const r = await s.run("修复 calc.py 中 add 的 bug");
		assert.equal(r.status, "completed");
		const ledger = readFileSync(join(data, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(ledger.length, 5);
		assert.equal(ledger[0].attempt, 1);
		assert.equal(ledger[0].costPartial, true, "失败请求缺 usage：标记 partial 并按保守口径计费，不当作 0");
		assert.ok(ledger[0].cost > 0);
		assert.equal(ledger[0].currency, "USD");
		assert.equal(ledger[1].isRetry, true);
	});

	test("限流 429（无 usage）不计费：不累计成本、不触发单次费用上限", async () => {
		const ws = makeWorkspace();
		const limited = {
			ok: false,
			message: { role: "assistant" as const, content: "", reasoning: "", toolCalls: [] },
			finishReason: null,
			responseModel: null,
			rawUsage: null,
			httpStatus: 429,
			error: { message: "429 rate limit", retryable: true },
			aborted: false,
		};
		const events: EngineEvent[] = [];
		// 单次上限很低：如果 429 按最坏情况计费，第二次尝试之前就会触发上限
		const { s, data } = session(ws, new ScriptedModelAdapter([limited, limited, ...script()]), events, { limits: { maxCost: 0.05 } });
		const r = await s.run("修复 calc.py 中 add 的 bug");
		assert.equal(r.status, "completed", r.reason);
		const ledger = readFileSync(join(data, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual([ledger[0].cost, ledger[0].costPartial, ledger[1].cost], [0, false, 0]);
	});

	test("未知工具与非法参数返回错误给模型，而不是中断运行", async () => {
		const ws = makeWorkspace();
		const bad = {
			ok: true,
			message: { role: "assistant" as const, content: "", reasoning: "", toolCalls: [{ id: "x1", name: "nope", argumentsJson: "{}" }, { id: "x2", name: "file_read", argumentsJson: "{bad json" }] },
			finishReason: "tool_calls",
			responseModel: "deepseek-flash",
			rawUsage: usage(10, 0, 5),
			httpStatus: 200,
			error: null,
			aborted: false,
		};
		const final = { ...bad, message: { role: "assistant" as const, content: "放弃", reasoning: "", toolCalls: [] }, finishReason: "stop" };
		const adapter = new ScriptedModelAdapter([bad, final]);
		const r = await session(ws, adapter, []).s.run("t");
		assert.equal(r.status, "completed");
		const toolMsgs = adapter.requests[1]?.messages.filter((m) => m.role === "tool") ?? [];
		assert.match(toolMsgs[0]?.role === "tool" ? toolMsgs[0].content : "", /未知工具/);
		assert.match(toolMsgs[1]?.role === "tool" ? toolMsgs[1].content : "", /不是合法 JSON/);
	});

	test("工作区副本可复原：cpSync 复制后运行互不影响", () => {
		const ws = makeWorkspace();
		const copy = mkdtempSync(join(tmpdir(), "eng-copy-"));
		cpSync(ws, copy, { recursive: true });
		assert.equal(readFileSync(join(copy, "calc.py"), "utf8"), readFileSync(join(ws, "calc.py"), "utf8"));
	});
});

describe("重试与预算（与 OpenCode 1.18.32 对齐）", () => {
	test("有 Retry-After 按它等待；否则 2、4、8、16、30 秒", () => {
		assert.deepEqual([1, 2, 3, 4, 5].map((a) => retryDelayMs(DEFAULT_RETRY, a, null)), [2000, 4000, 8000, 16000, 30000]);
		assert.equal(retryDelayMs(DEFAULT_RETRY, 1, 45_000), 45_000);
		assert.equal(DEFAULT_RETRY.maxAttempts, 6);
	});
	test("全局预算按币种累计；非美元计价必须显式给出上限", () => {
		const dir = mkdtempSync(join(tmpdir(), "bg-"));
		const ledgerPath = join(dir, "spend.jsonl");
		const usd = new BudgetGuard({ globalLimit: 1, ledgerPath });
		usd.record({ runId: "r", requestId: "a", amount: 0.4, partial: false });
		const cny = new BudgetGuard({ globalLimit: 10, currency: "CNY", ledgerPath });
		cny.record({ runId: "r", requestId: "b", amount: 3, partial: false });
		assert.equal(new BudgetGuard({ globalLimit: 1, ledgerPath }).globalSpent, 0.4);
		assert.equal(new BudgetGuard({ globalLimit: 10, currency: "CNY", ledgerPath }).globalSpent, 3);
		assert.throws(() => BudgetGuard.fromEnv(ledgerPath, "CNY", {}), /MOUNTAINS_BUDGET/);
		assert.equal(BudgetGuard.fromEnv(ledgerPath, "CNY", { MOUNTAINS_BUDGET: "20" }).globalLimit, 20);
		assert.equal(BudgetGuard.fromEnv(ledgerPath, "USD", { MOUNTAINS_BUDGET_USD: "7" }).globalLimit, 7);
		assert.equal(BudgetGuard.fromEnv(ledgerPath, "USD", {}).globalLimit, 5);
	});
});
