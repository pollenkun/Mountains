import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { blockLabel, blocks, callLabel, EMPTY, leadingKind, liveEdits, reduce, type Transcript } from "../src/renderer/transcript.ts";
import { approvalBoard, paymentsBoard } from "./boards.ts";

function play(events: ReturnType<typeof paymentsBoard>): Transcript {
	return events.reduce((state, event) => reduce(state, event, 0), EMPTY);
}

describe("desktop transcript", () => {
	test("folded: calls between two messages share a line; pictures, recall and skills stay apart", () => {
		const shown = blocks(play(paymentsBoard()).items, true).map((block) => block.type === "tools" ? blockLabel(block.calls) : block.item.type);
		assert.deepEqual(shown, [
			"user",
			"运行了命令",
			"assistant",
			"读取了文件，运行了命令",
			"读取了 Computer-use",
			"查看了 2 张图片",
			"回忆了这次对话",
			"修改了文件",
			"assistant",
			"运行了命令",
		]);
	});

	test("a message sent mid-run shows where it was sent, and a streaming reply finishes in place", () => {
		const base = { protocolVersion: "0.1.0" as const, sessionId: "s", runId: "r", eventId: "e", time: "t" };
		const events = [
			{ ...base, seq: 1, type: "run.started" as const, task: "写说明" },
			{ ...base, seq: 2, type: "message.delta" as const, turnId: "t1", kind: "text" as const, text: "先写" },
			{ ...base, seq: 3, eventId: "i", type: "run.interjected" as const, id: "r:interject:1", text: "简短点" },
			{ ...base, seq: 4, type: "message.delta" as const, turnId: "t1", kind: "text" as const, text: "开头" },
		];
		const items = events.reduce((state, event) => reduce(state, event, 0), EMPTY).items.map((item) => item.type === "user" || item.type === "assistant" ? `${item.type}:${item.text}` : item.type);
		assert.deepEqual(items, ["user:写说明", "assistant:先写开头", "user:简短点"]);
	});

	test("loose: one line per call, except the groups that never merge", () => {
		const shown = blocks(play(paymentsBoard()).items, false).filter((block) => block.type === "tools").map((block) => block.type === "tools" ? block.calls.length : 0);
		assert.deepEqual(shown, [1, 1, 1, 1, 1, 2, 1, 1, 1]);
	});

	test("a folded group takes the icon of its most frequent kind", () => {
		const group = blocks(play(paymentsBoard()).items, true)[3];
		assert.ok(group?.type === "tools");
		assert.equal(leadingKind(group.calls), "read");
	});

	test("a retryable failure is one reconnecting line, and a later reply clears it", () => {
		const base = { protocolVersion: "0.1.0" as const, sessionId: "s", runId: "r", time: "t", seq: 1 };
		const once = reduce(EMPTY, { ...base, eventId: "e1", type: "error", message: "overloaded", retryable: true }, 0);
		const twice = reduce(once, { ...base, eventId: "e2", seq: 2, type: "error", message: "overloaded", retryable: true }, 0);
		const line = twice.items.find((item) => item.type === "error");
		assert.equal(twice.items.filter((item) => item.type === "error").length, 1);
		assert.equal(line?.type === "error" && line.reconnecting && line.attempt, 2);
		const replied = reduce(twice, { ...base, eventId: "e3", seq: 3, type: "message.delta", turnId: "t1", kind: "text", text: "好" }, 0);
		assert.equal(replied.items.some((item) => item.type === "error"), false);
	});

	test("a recall row says how many days ago, not the words that were searched", () => {
		const call = { id: "r", tool: "memory_search", kind: "recall" as const, target: "请", status: "done" as const, startedAt: 0, recallDays: 3 };
		assert.deepEqual(callLabel(call), { verb: "回忆了 3 天前的对话", target: "" });
		const loose = blocks([
			{ type: "tool", id: "a", call: { ...call, id: "a" } },
			{ type: "tool", id: "b", call: { ...call, id: "b", target: "帮", recallDays: 1 } },
		], false);
		assert.deepEqual(loose.map((block) => block.type === "tools" ? block.calls.length : 0), [1, 1]);
	});

	test("an edit row carries its line counts and the diff", () => {
		const edit = play(paymentsBoard()).items.find((item) => item.type === "tool" && item.call.tool === "file_edit");
		assert.ok(edit?.type === "tool");
		assert.equal(edit.call.added, 18);
		assert.equal(edit.call.removed, 42);
		assert.deepEqual(callLabel(edit.call), { verb: "修改了", target: "src/webhook.ts" });
	});

	test("an approval stays until it is answered or resolved; a running call reads as in progress", () => {
		const state = play(approvalBoard());
		assert.equal(state.approvals.length, 1);
		assert.equal(state.approvals[0]?.command, "git push --force origin main");
		const reading = state.items.find((item) => item.type === "tool" && item.call.status === "running");
		assert.ok(reading?.type === "tool");
		assert.deepEqual(callLabel(reading.call), { verb: "正在读取", target: ".github/pull_request_template.md" });
	});

	test("streamed text joins one reply until a tool call starts", () => {
		const state = play(paymentsBoard());
		const replies = state.items.filter((item) => item.type === "assistant").map((item) => item.type === "assistant" ? item.text : "");
		assert.deepEqual(replies, ["有 2 个测试失败，都卡在签名过期的判断上。", "按 10 月 21 日定的 300 秒容差改好了，41 个测试全部通过。"]);
	});
});

test("usage events add up to the conversation's spend, and the latest prompt sets the context gauge", () => {
	const state = play(paymentsBoard());
	assert.equal(state.spend.requests, 10);
	assert.equal(state.spend.currency, "CNY");
	assert.ok(Math.abs(state.spend.cost - 0.062) < 1e-9);
	assert.equal(state.spend.output, 6000);
	const last = paymentsBoard().filter((event) => event.type === "usage").at(-1);
	assert.ok(last?.type === "usage");
	assert.equal(state.context, (last.usage.input ?? 0) + (last.usage.cacheRead ?? 0));
	assert.equal(state.items.length, play(paymentsBoard()).items.length, "usage adds no rows");

	test("a context change shows as a line: compacting, compacted, and folds in a row as one", () => {
		const base = { protocolVersion: "0.1.0" as const, sessionId: "s", runId: "r", seq: 1, time: "t" };
		const request = { ...base, eventId: "q", type: "model.request" as const, turnId: "t", requestId: "q", attempt: 1, isRetry: false, purpose: "compaction", segments: [], prefixHash: "", firstChangedSegment: null };
		const revision = (eventId: string, reason: string, maskedRefs: string[]) => ({ ...base, eventId, type: "context.revision" as const, reason, maskedRefs, tokensBefore: 10, tokensAfter: 5 });
		const lines = (events: Parameters<typeof reduce>[1][]) => events.reduce((state, event) => reduce(state, event, 0), EMPTY).items.map((item) => item.type === "revision" ? `${item.state}:${item.count}` : item.type);
		assert.deepEqual(lines([request]), ["compacting:0"]);
		assert.deepEqual(lines([request, revision("a", "compaction", ["x"])]), ["compacted:0"]);
		assert.deepEqual(lines([revision("a", "lossless", ["x", "y"]), revision("b", "lossless", ["z"])]), ["folded:3"]);
		assert.deepEqual(lines([{ ...request, purpose: "agent-turn" }]), [], "an ordinary request draws nothing");
		assert.deepEqual(lines([request, { ...base, eventId: "e", type: "error" as const, message: "断了", retryable: false }]), ["error"], "a failed summary leaves no line saying it is still running");
	});
});

test("a file the model is still writing counts as it is written, and hands over to its result", () => {
	const at = { protocolVersion: "0.1.0", sessionId: "s", runId: "r", seq: 1, time: "" };
	let state: Transcript = reduce(EMPTY, { ...at, eventId: "1", type: "run.started", task: "write" } as never, 0);
	for (const text of ['{"path":"a.md","con', 'tent":"one\\ntwo', '\\nthree"}']) state = reduce(state, { ...at, eventId: "2", type: "tool.writing", turnId: "t", index: 0, tool: "file_write", text } as never, 0);
	assert.deepEqual(liveEdits(state), [{ path: "a.md", added: 3, removed: 0 }]);
	state = reduce(state, { ...at, eventId: "3", type: "tool.requested", turnId: "t", toolCallId: "c", tool: "file_write", args: { path: "a.md" } } as never, 0);
	state = reduce(state, { ...at, eventId: "4", type: "tool.completed", turnId: "t", toolCallId: "c", tool: "file_write", ok: true, summary: "", durationMs: 1, details: { path: "a.md", content: "one\ntwo\nthree" } } as never, 0);
	assert.deepEqual(liveEdits(state), [{ path: "a.md", added: 3, removed: 0 }]);
	state = reduce(state, { ...at, eventId: "5", type: "run.completed", status: "completed", reason: "", turns: 1, totals: {} } as never, 0);
	assert.deepEqual(liveEdits(state), []);
});

test("query_plan reads/searches instead of '记了笔记', task_note shows progress, auto-approval states track shimmer/denial, and partial-usage stop text is suppressed", () => {
	const at = { protocolVersion: "0.1.0" as const, sessionId: "s", runId: "r", seq: 1, time: "" };
	let state = reduce(EMPTY, { ...at, eventId: "1", type: "run.started", task: "检查" } as never, 0);
	state = reduce(state, {
		...at, eventId: "2", type: "tool.requested", turnId: "t", toolCallId: "qp1", tool: "query_plan",
		args: { steps: [{ id: "s1", op: "search", pattern: "Token" }, { id: "r1", op: "read", path: "src/app.ts" }] },
	} as never, 0);
	state = reduce(state, {
		...at, eventId: "3", type: "tool.completed", turnId: "t", toolCallId: "qp1", tool: "query_plan",
		ok: true, summary: "ok", durationMs: 4, details: {},
	} as never, 0);
	state = reduce(state, {
		...at, eventId: "4", type: "tool.requested", turnId: "t", toolCallId: "tn1", tool: "task_note",
		args: { next: "准备清理", facts: ["已完成目录检查"] },
	} as never, 0);
	state = reduce(state, {
		...at, eventId: "5", type: "tool.completed", turnId: "t", toolCallId: "tn1", tool: "task_note",
		ok: true, summary: "ok", durationMs: 1, details: {},
	} as never, 0);
	state = reduce(state, {
		...at, eventId: "6", type: "tool.requested", turnId: "t", toolCallId: "cmd1", tool: "command_run",
		args: { argv: ["rm", "-rf", "tmp"] },
	} as never, 0);
	state = reduce(state, {
		...at, eventId: "7", type: "approval.requested", turnId: "t", toolCallId: "cmd1", tool: "command_run",
		command: "rm -rf tmp", cwd: "/ws", risk: "dangerous", source: "model", explanation: "正在自动审批",
	} as never, 0);
	assert.equal(state.approvals.length, 0, "auto-approval does not open a human approval card");
	const reviewing = state.items.find((item) => item.type === "tool" && item.call.id === "cmd1");
	assert.ok(reviewing?.type === "tool" && reviewing.call.approvalState === "reviewing");

	state = reduce(state, {
		...at, eventId: "8", type: "approval.requested", turnId: "t", toolCallId: "cmd1", tool: "command_run",
		command: "rm -rf tmp", cwd: "/ws", risk: "dangerous", source: "model", explanation: "正在获取更多上下文",
	} as never, 0);
	const fetching = state.items.find((item) => item.type === "tool" && item.call.id === "cmd1");
	assert.ok(fetching?.type === "tool" && fetching.call.approvalState === "fetching_context");

	state = reduce(state, {
		...at, eventId: "9", type: "approval.resolved", turnId: "t", toolCallId: "cmd1", decision: "deny", source: "model",
	} as never, 0);
	state = reduce(state, {
		...at, eventId: "10", type: "tool.completed", turnId: "t", toolCallId: "cmd1", tool: "command_run",
		ok: false, summary: "未执行：超出范围", durationMs: 2, details: { decision: "deny" },
	} as never, 0);
	state = reduce(state, {
		...at, eventId: "11", type: "run.completed", status: "limit",
		reason: "请求用量不完整，已保守计费并停止后续操作", turns: 1, totals: {},
	} as never, 0);

	const qp = state.items.find((item) => item.type === "tool" && item.call.id === "qp1");
	assert.ok(qp?.type === "tool");
	assert.equal(qp.call.kind, "read");
	assert.deepEqual(callLabel(qp.call), { verb: "读取了", target: "src/app.ts" });

	const tn = state.items.find((item) => item.type === "tool" && item.call.id === "tn1");
	assert.ok(tn?.type === "tool");
	assert.deepEqual(callLabel(tn.call), { verb: "整理了任务进度", target: "准备清理" });

	const denied = state.items.find((item) => item.type === "tool" && item.call.id === "cmd1");
	assert.ok(denied?.type === "tool");
	assert.equal(denied.call.approvalState, "denied");
	assert.equal(state.items.some((item) => item.type === "error"), false, "deprecated partial-usage limit text never adds an error row");
});

test("the risk 自动审批 gave a call stays on it, and reaches the card when the user is asked", () => {
	const at = { protocolVersion: "0.1.0", sessionId: "s", runId: "r", seq: 1, time: "" };
	let state: Transcript = reduce(EMPTY, { ...at, eventId: "1", type: "run.started", task: "push" } as never, 0);
	state = reduce(state, { ...at, eventId: "2", type: "tool.requested", turnId: "t", toolCallId: "c", tool: "command_run", args: { argv: ["git", "push", "--force"] } } as never, 0);
	state = reduce(state, { ...at, eventId: "3", type: "approval.resolved", toolCallId: "c", decision: "ask", rule: null, level: "high", reason: "x" } as never, 0);
	state = reduce(state, { ...at, eventId: "4", type: "approval.requested", toolCallId: "c", command: "git push --force", cwd: "/", risk: "dangerous", explanation: "你没说要强推", source: "human", level: "high" } as never, 0);
	assert.equal(state.approvals[0]?.level, "high");
	state = reduce(state, { ...at, eventId: "5", type: "approval.resolved", toolCallId: "c", decision: "allow", rule: null } as never, 0);
	const call = state.items.find((item) => item.type === "tool");
	assert.equal(call?.type === "tool" && call.call.level, "high");
});

test("UltraCode: spawn_agent and send_message stand on their own lines even when folded, carry expandable messages, and route team transcripts & approvals", () => {
	const at = { protocolVersion: "0.1.0" as const, sessionId: "s", runId: "r", seq: 1, time: "" };
	let state: Transcript = reduce(EMPTY, { ...at, eventId: "1", type: "run.started", task: "重构认证模块" } as never, 100);
	state = reduce(state, { ...at, eventId: "2", type: "tool.requested", turnId: "t1", toolCallId: "r1", tool: "file_read", args: { path: "src/auth.ts" } } as never, 101);
	state = reduce(state, { ...at, eventId: "3", type: "tool.completed", turnId: "t1", toolCallId: "r1", tool: "file_read", ok: true, summary: "", durationMs: 2, details: {} } as never, 102);
	state = reduce(state, { ...at, eventId: "4", type: "tool.requested", turnId: "t1", toolCallId: "sp1", tool: "spawn_agent", args: { name: "后端", purpose: "检查鉴权中间件", task: "检查 src/auth.ts" } } as never, 103);

	const runningSpawn = state.items.find((item) => item.type === "tool" && item.call.id === "sp1");
	assert.ok(runningSpawn?.type === "tool");
	assert.deepEqual(callLabel(runningSpawn.call), { verb: "正在启动 后端", target: "检查鉴权中间件" });
	assert.equal(state.purposes["后端"], "检查鉴权中间件");

	state = reduce(state, { ...at, eventId: "5", type: "tool.completed", turnId: "t1", toolCallId: "sp1", tool: "spawn_agent", ok: true, summary: "已启动 后端", durationMs: 5, details: { agent: "后端" } } as never, 104);
	state = reduce(state, { ...at, eventId: "6", type: "tool.requested", turnId: "t1", toolCallId: "msg1", tool: "send_message", args: { to: "后端", message: "顺便核对一下 token 过期时间" } } as never, 105);

	const runningMsg = state.items.find((item) => item.type === "tool" && item.call.id === "msg1");
	assert.ok(runningMsg?.type === "tool");
	assert.deepEqual(callLabel(runningMsg.call), { verb: "正在向 后端 发送消息", target: "" });
	assert.equal(runningMsg.call.message, "顺便核对一下 token 过期时间");

	// Subagent starts its own run and spawns a nested member; mid-run send_message reaches the running subagent's log.
	state = reduce(state, { ...at, agent: "后端", eventId: "a1", type: "run.started", task: '[You are 后端]\n\n<agent_message id="1" from="lead" type="task">\n检查 src/auth.ts\n</agent_message>' } as never, 106);
	state = reduce(state, { ...at, eventId: "7", type: "tool.completed", turnId: "t1", toolCallId: "msg1", tool: "send_message", ok: true, summary: "已发给 后端", durationMs: 1, details: { agent: "后端" } } as never, 107);
	state = reduce(state, { ...at, eventId: "8", type: "tool.requested", turnId: "t1", toolCallId: "r2", tool: "file_read", args: { path: "README.md" } } as never, 108);
	state = reduce(state, { ...at, eventId: "9", type: "tool.completed", turnId: "t1", toolCallId: "r2", tool: "file_read", ok: true, summary: "", durationMs: 1, details: {} } as never, 109);

	// Even with folded = true, spawn_agent and send_message never merge into adjacent file_read blocks.
	const foldedBlocks = blocks(state.items, true).map((b) => b.type === "tools" ? b.calls.map((c) => callLabel(c).verb).join("+") : b.item.type);
	assert.deepEqual(foldedBlocks, ["user", "读取了", "启动了 后端", "已向 后端 发送消息", "读取了"]);

	// Nested subagent spawned by 后端 registers its purpose in top-level state.purposes.
	state = reduce(state, { ...at, agent: "后端", eventId: "a2", type: "tool.requested", turnId: "at1", toolCallId: "sub_sp", tool: "spawn_agent", args: { name: "测试", purpose: "跑单元测试", task: "运行测试" } } as never, 110);
	assert.equal(state.purposes["测试"], "跑单元测试");

	// Subagent file edits appear in liveEdits while running, and subagent human approvals surface on state.approvals with agent name.
	state = reduce(state, { ...at, agent: "后端", eventId: "a3", type: "tool.requested", turnId: "at1", toolCallId: "sub_edit", tool: "file_write", args: { path: "src/token.ts" } } as never, 111);
	state = reduce(state, { ...at, agent: "后端", eventId: "a4", type: "tool.completed", turnId: "at1", toolCallId: "sub_edit", tool: "file_write", ok: true, summary: "", durationMs: 2, details: { path: "src/token.ts", content: "export const ok = true;\n" } } as never, 112);
	assert.deepEqual(liveEdits(state), [{ path: "src/token.ts", added: 2, removed: 0 }]);

	state = reduce(state, { ...at, agent: "后端", eventId: "a5", type: "tool.requested", turnId: "at1", toolCallId: "sub_cmd", tool: "command_run", args: { argv: ["npm", "test"] } } as never, 113);
	state = reduce(state, { ...at, agent: "后端", eventId: "a6", type: "approval.requested", toolCallId: "sub_cmd", command: "npm test", cwd: "/ws", risk: "workspace-write", explanation: "运行测试", source: "human" } as never, 114);
	assert.equal(state.approvals.length, 1);
	assert.equal(state.approvals[0]?.agent, "后端");
	state = reduce(state, { ...at, agent: "后端", eventId: "a7", type: "approval.resolved", toolCallId: "sub_cmd", decision: "allow", rule: null } as never, 115);
	assert.equal(state.approvals.length, 0);

	// The running subagent's log holds both its initial task and the mid-run follow-up message from lead.
	const userTexts = state.agents["后端"]!.items.filter((i) => i.type === "user").map((i) => (i as { text: string }).text);
	assert.equal(userTexts.length, 2);
	assert.equal(userTexts[1], "顺便核对一下 token 过期时间");
});


test("failed commands retain the exact model input, including invalid fields and empty objects", () => {
	const base = { protocolVersion: "0.1.0" as const, sessionId: "s", runId: "r", time: "t", seq: 1 };
	for (const args of [{ script: "smartctl -a /dev/disk0", timeout: 30 }, {}]) {
		const requested = reduce(EMPTY, { ...base, eventId: "request", type: "tool.requested", turnId: "t", summary: "command_run", toolCallId: "bad", tool: "command_run", args }, 0);
		const failed = reduce(requested, { ...base, eventId: "result", seq: 2, type: "tool.completed", turnId: "t", modelContentChars: 0, toolCallId: "bad", tool: "command_run", ok: false, durationMs: 0, summary: "需要 argv 或 shellScript", details: { error: "需要 argv 或 shellScript" } }, 1);
		const item = failed.items.find(item => item.type === "tool");
		assert.ok(item?.type === "tool");
		assert.equal(item.call.status, "failed");
		assert.equal(item.call.target, "");
		assert.deepEqual(item.call.input, args);
		assert.equal(item.call.failure, "需要 argv 或 shellScript");
	}
});
