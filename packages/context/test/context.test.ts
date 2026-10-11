import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { ToolSpec } from "@mountains/protocol";
import { assertFitsWindow, assertToolPairing, CachePlanner, checkpointArchiveRef, ContextBuilder, type ContextPlan, type ContextPolicy, diffPlans, explainCacheMiss, type ToolResultMeta } from "../src/index.ts";

const TOOLS = [{ name: "file_read", description: "read", parameters: { type: "object" } }];

function turn(b: ContextBuilder, i: number, size = 400) {
	b.appendAssistant({ role: "assistant", content: "", reasoning: `思考 ${i}`, toolCalls: [{ id: `c${i}`, name: "file_read", argumentsJson: `{"path":"f${i}.py"}` }] });
	b.appendToolResult(`c${i}`, "file_read", `f${i}.py | lines 1-10\n${"x = 1\n".repeat(size)}`, { kind: "file_content", ref: `blob_${i}`, target: `f${i}.py` });
}

function isPrefixExtension(prev: ContextPlan, next: ContextPlan): boolean {
	return prev.prefixHashes.every((h, i) => next.prefixHashes[i] === h);
}

describe("ContextBuilder 只追加不变量", () => {
	test("没有修订时，每一轮的分段前缀都是上一轮的严格前缀扩展", () => {
		const b = new ContextBuilder({ system: "sys", tools: TOOLS });
		b.appendUser("修复 bug");
		let prev = b.plan();
		for (let i = 0; i < 20; i++) {
			turn(b, i);
			const next = b.plan();
			assert.ok(isPrefixExtension(prev, next), `第 ${i} 轮破坏了前缀`);
			assert.equal(diffPlans(prev, next).firstChanged, null);
			prev = next;
		}
		assert.equal(prev.revision, 0);
	});

	test("工具定义与系统提示是前缀的前两段，且内容冻结（外部修改不影响）", () => {
		const tools = [{ name: "a", description: "d", parameters: {} }];
		const b = new ContextBuilder({ system: "s", tools });
		const p1 = b.plan();
		(tools[0] as { description: string }).description = "改了";
		const p2 = b.plan();
		assert.deepEqual(p1.segments.slice(0, 2).map((s) => s.kind), ["system", "tools"]);
		assert.equal(p1.prefixHashes[1], p2.prefixHashes[1]);
	});

	test("发请求前按模型窗口检查：放不下就报错；窗口未知不检查", () => {
		const b = new ContextBuilder({ system: "sys", tools: TOOLS });
		b.appendUser("x ".repeat(5000));
		const plan = b.plan();
		assert.throws(() => assertFitsWindow(plan, 1000, plan.totalTokensEst), /超过模型上下文窗口/);
		assert.doesNotThrow(() => assertFitsWindow(plan, 1000, plan.totalTokensEst + 1000));
		assert.doesNotThrow(() => assertFitsWindow(plan, 1000, undefined));
	});
});

describe("缓存断点诊断", () => {
	test("系统提示变化被识别为动态内容进入前缀", () => {
		const a = new ContextBuilder({ system: "今天 2026-09-25", tools: TOOLS }).plan();
		const b = new ContextBuilder({ system: "今天 2026-09-26", tools: TOOLS }).plan();
		const d = diffPlans(a, b);
		assert.equal(d.firstChanged?.kind, "system");
		assert.match(d.reasons[0] ?? "", /动态内容/);
	});
	test("工具顺序改变被识别", () => {
		const t2 = [...TOOLS, { name: "b", description: "", parameters: {} }];
		const d = diffPlans(new ContextBuilder({ system: "s", tools: t2 }).plan(), new ContextBuilder({ system: "s", tools: [...t2].reverse() }).plan());
		assert.equal(d.firstChanged?.kind, "tools");
	});
	test("前缀未变但未命中：只报告可能过期或供应商侧原因", () => {
		const b = new ContextBuilder({ system: "s", tools: TOOLS });
		b.appendUser("u");
		const p1 = b.plan();
		turn(b, 0);
		const p2 = b.plan();
		assert.equal(explainCacheMiss(diffPlans(p1, p2), 0, 500), "前缀未变但未命中：可能过期或供应商侧原因");
		assert.equal(explainCacheMiss(diffPlans(p1, p2), null, null), "usage 未提供缓存字段");
	});
});

describe("无损折叠与压缩", () => {
	const tools: ToolSpec[] = ["file_read", "file_edit", "command_run", "task_note", "context_expand"].map(name => ({ name, description: name, parameters: { type: "object" } }));
	const big = "evidence line that the model has already used\n".repeat(400);
	const policy: ContextPolicy = { triggerTokens: 1, hardLimitTokens: 1_000_000, compactTokens: 900_000, compactTailTokens: 100, minBatchTokens: 0 };

	function fixture() {
		const archives = new Map<string, string>();
		const b = new ContextBuilder({ system: "sys", tools, expandTool: "context_expand", publicationGuard: {
			verifyReference: (ref) => archives.has(ref) || ref.startsWith("shown_"),
			archiveInteraction: (content) => {
				const h = createHash("sha256").update(content).digest("hex");
				const ref = `blob_v2_${h}_${"0".repeat(32)}_raw_${h}`;
				archives.set(ref, content);
				return ref;
			},
		} });
		return { b, archives };
	}
	let seq = 0;
	function call(b: ContextBuilder, name: string, args: Record<string, unknown>, opts: { content?: string; visible?: string; meta?: Partial<ToolResultMeta> } = {}) {
		const id = `call_${++seq}`;
		b.appendAssistant({ role: "assistant", content: opts.visible ?? "", reasoning: `why ${id}`, toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }] });
		b.appendToolResult(id, name, opts.content ?? big, { kind: name === "file_read" ? "file_content" : "tool_output", ref: `shown_${id}`, target: String(args.path ?? args.cmd ?? id), ...opts.meta });
		return id;
	}
	const shown = (b: ContextBuilder) => b.plan().messages.map(m => m.content).join("\n");

	test("被后来的编辑覆盖的读取被折叠成一行通知，原文可以取回；用户原话保留", () => {
		const { b, archives } = fixture();
		b.appendUser("修好 parser");
		call(b, "file_read", { path: "a.py" }, { visible: "先看 a.py" });
		call(b, "file_edit", { path: "a.py" }, { content: "edited a.py" });
		b.appendAssistant({ role: "assistant", content: "看结果", reasoning: "r", toolCalls: [] });
		const before = b.plan().messages.slice(1, 3);
		const r = new CachePlanner(policy).beforeRequest(b, 0);
		assert.equal(r?.reason, "lossless");
		assert.equal(r?.removedGroups, 1);
		const plan = b.plan();
		assertToolPairing(plan.messages);
		assert.equal(plan.messages[0]?.content, "修好 parser");
		const notice = plan.messages.find(m => m.content.startsWith("[Context checkpoint"))!;
		assert.match(notice.content, /Folded 1 earlier tool call \(superseded by a later read or edit\): file_read a\.py/);
		assert.match(notice.content, /Your visible text then:\n先看 a\.py/);
		const ref = checkpointArchiveRef(notice.content)!;
		assert.deepEqual(JSON.parse(archives.get(ref)!).messages, before, "归档里是完整的原交互");
		assert.ok(shown(b).includes("edited a.py"), "编辑结果本身不折叠");
	});

	test("同一调用后来又成功一次：旧结果折叠；失败后重试成功：失败也折叠，但失败原因留在通知里", () => {
		const { b } = fixture();
		b.appendUser("跑测试");
		call(b, "command_run", { cmd: "npm test" });
		call(b, "command_run", { cmd: "make" }, { content: `exit=1 missing header\n${big}`, meta: { preserve: "error" } });
		call(b, "command_run", { cmd: "make" }, { content: "ok" });
		call(b, "command_run", { cmd: "npm test" }, { content: "pass" });
		b.appendAssistant({ role: "assistant", content: "都过了", reasoning: "r", toolCalls: [] });
		const r = new CachePlanner(policy).beforeRequest(b, 0);
		assert.equal(r?.removedGroups, 2);
		const text = shown(b);
		assert.match(text, /the same call succeeded again later/);
		assert.match(text, /failed, then succeeded on retry/);
		assert.match(text, /Failure output then: \["exit=1 missing header/);
		assert.ok(text.includes("pass") && text.includes("都过了"));
	});

	test("模型还没回应的结果、工作笔记、编辑都不折叠；没有可折叠内容时不修订", () => {
		const { b } = fixture();
		b.appendUser("task");
		call(b, "task_note", { note: "n" }, { content: "Task note recorded.", meta: { preserve: "unresolved" } });
		call(b, "file_edit", { path: "a.py" });
		call(b, "file_read", { path: "a.py" });
		call(b, "file_read", { path: "a.py" }); // 同一读取再来一次，但模型还没看到它的结果
		const before = b.plan();
		assert.equal(new CachePlanner(policy).beforeRequest(b, 0), null);
		assert.deepEqual(b.plan(), before);
	});

	test("最近两次用户请求之前的结果算已结束，折叠；每条用户消息和最终答复原样保留", () => {
		const { b } = fixture();
		b.appendUser("第一个问题");
		call(b, "file_read", { path: "x.py" });
		b.appendAssistant({ role: "assistant", content: "第一个答复", reasoning: "r", toolCalls: [] });
		b.appendUser("第二个问题");
		call(b, "file_read", { path: "y.py" });
		b.appendAssistant({ role: "assistant", content: "第二个答复", reasoning: "r", toolCalls: [] });
		b.appendUser("第三个问题");
		const r = new CachePlanner(policy).beforeRequest(b, 0);
		assert.equal(r?.removedGroups, 1);
		const text = shown(b);
		assert.match(text, /from an earlier finished request\): file_read x\.py/);
		for (const kept of ["第一个问题", "第一个答复", "第二个问题", "第二个答复", "第三个问题"]) assert.ok(text.includes(kept), kept);
		assert.ok(!text.includes("file_read y.py"), "第二轮仍在最近两次请求之内");
	});

	test("低于触发线不动；省下的量不足一批时不动", () => {
		const { b } = fixture();
		b.appendUser("task");
		call(b, "file_read", { path: "a.py" });
		call(b, "file_edit", { path: "a.py" }, { content: "edited" });
		b.appendAssistant({ role: "assistant", content: "done", reasoning: "r", toolCalls: [] });
		assert.equal(new CachePlanner({ ...policy, triggerTokens: 1e9 }).beforeRequest(b, 0), null);
		assert.equal(new CachePlanner({ ...policy, minBatchTokens: 1e9 }).beforeRequest(b, 0), null);
		assert.equal(b.plan().revision, 0);
	});

	test("压缩：工具交互换成一条带摘要的通知，用户消息与最终答复按原顺序保留，最新交互原样留在尾部", () => {
		const { b, archives } = fixture();
		b.appendUser("第一个问题");
		call(b, "file_read", { path: "x.py" });
		b.appendAssistant({ role: "assistant", content: "第一个答复", reasoning: "r", toolCalls: [] });
		b.appendUser("第二个问题");
		call(b, "command_run", { cmd: "ls" }, { content: "latest listing" });
		const tail = b.compactionTailStart(10);
		assert.ok(tail !== null);
		const turns = b.assistantTurns;
		const r = b.applyCompaction("摘要：x.py 已读过。", tail, 0, 1_000_000, true);
		assert.equal(r.reason, "compaction");
		const plan = b.plan();
		assertToolPairing(plan.messages);
		assert.deepEqual(plan.messages.slice(0, 3).map(m => m.content), ["第一个问题", "第一个答复", "第二个问题"]);
		const notice = plan.messages[3]!;
		assert.match(notice.content, /the summary you wrote below replaces 2 earlier messages/);
		assert.match(notice.content, /<summary>\n摘要：x\.py 已读过。\n<\/summary>$/);
		assert.ok(archives.has(checkpointArchiveRef(notice.content)!));
		assert.ok(plan.messages.at(-1)!.content.includes("latest listing"), "模型还没回应的交互留在尾部");
		assert.equal(b.assistantTurns, turns);
		const restored = new ContextBuilder({ system: "sys", tools, expandTool: "context_expand" });
		restored.restoreState(JSON.parse(JSON.stringify(b.exportState())));
		assert.deepEqual(restored.plan().messages, plan.messages);
	});

	test("没有工具交互可压缩时返回 null", () => {
		const { b } = fixture();
		b.appendUser("只是聊天");
		b.appendAssistant({ role: "assistant", content: "好的", reasoning: "r", toolCalls: [] });
		assert.equal(b.compactionTailStart(10), null);
	});
});
