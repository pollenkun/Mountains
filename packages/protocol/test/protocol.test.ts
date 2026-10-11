import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HIGH_PRIORITY_EVENTS, isValidCommand, isValidEvent, PROTOCOL_VERSION } from "../src/index.ts";

const base = { protocolVersion: PROTOCOL_VERSION, sessionId: "s", runId: "r", seq: 1, eventId: "e", time: "2026-09-25T00:00:00Z" };

describe("协议 schema", () => {
	test("合法事件通过，缺字段或类型错误被拒绝", () => {
		assert.ok(isValidEvent({ ...base, type: "run.started", task: "t" }));
		assert.ok(!isValidEvent({ ...base, type: "run.started" }));
		assert.ok(!isValidEvent({ ...base, seq: 0, type: "run.started", task: "t" }));
		assert.ok(!isValidEvent({ ...base, protocolVersion: "9.9.9", type: "run.started", task: "t" }));
		assert.ok(!isValidEvent({ ...base, type: "no.such.event" }));
	});
	test("usage 事件：缺失字段为 null 而不是 0", () => {
		const ev = {
			...base,
			type: "usage",
			turnId: "t1",
			requestId: "q",
			model: "deepseek-flash",
			usage: { input: 1, cacheRead: 2, cacheWrite: null, output: 3, reasoning: null, total: 6, partial: false },
			rawUsage: {},
			cost: 0.1,
			currency: "USD",
			costEstimated: true,
			priceVersion: "v",
			pricePeriod: "peak",
			durationMs: 1,
			firstTokenMs: null,
		};
		assert.ok(isValidEvent(ev));
		const receipt = { kind: "openrouter-usage-cost", endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini", currency: "USD", amount: 0.1, inputTokens: 3, outputTokens: 3, totalTokens: 6 };
		assert.ok(isValidEvent({ ...ev, model: receipt.model, costEstimated: false, billingReceipt: receipt }), "官方费用证据能与未知缓存统计分开传输");
		assert.ok(!isValidEvent({ ...ev, costEstimated: "false" }));
		assert.ok(!isValidEvent({ ...ev, billingReceipt: { ...receipt, amount: -1 } }));
		assert.ok(!isValidEvent({ ...ev, billingReceipt: { ...receipt, inputTokens: 0.5 } }));
		assert.ok(!isValidEvent({ ...ev, billingReceipt: { ...receipt, kind: "untrusted-quote" } }));
		assert.ok(isValidEvent({ ...ev, cost: null, billingReceiptRejected: true }));
		assert.ok(!isValidEvent({ ...ev, billingReceiptRejected: false }));
	});
	test("高优先级事件集合包含审批与完成", () => {
		for (const t of ["approval.requested", "run.completed", "error"] as const) assert.ok(HIGH_PRIORITY_EVENTS.has(t));
	});
	test("命令 schema", () => {
		assert.ok(isValidCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "x" }));
		assert.ok(isValidCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: "c", decision: "always" }));
		assert.ok(!isValidCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: "c", decision: "maybe" }));
	});
});
