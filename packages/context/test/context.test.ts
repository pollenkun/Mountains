import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CachePlanner, ContextBuilder, type ContextPlan, diffPlans, explainCacheMiss, placeholderFor } from "../src/index.ts";

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
});

describe("分批遮蔽", () => {
	test("达到阈值才一次性遮蔽一大批；两次修订之间前缀哈希不变；最近 K 个保留完整", () => {
		const planner = new CachePlanner({ enabled: true, triggerTokens: 6000, keepRecentToolResults: 2, minBatchTokens: 1000, hardLimitTokens: 1e9 });
		const b = new ContextBuilder({ system: "sys", tools: TOOLS });
		b.appendUser("任务");
		const revisions: number[] = [];
		let prev = b.plan();
		for (let i = 0; i < 30; i++) {
			turn(b, i);
			const r = planner.beforeRequest(b, 4000);
			const next = b.plan();
			if (r) {
				revisions.push(i);
				assert.ok(r.maskedRefs.length >= 2, "一批遮蔽多个");
				assert.ok(r.tokensAfter < r.tokensBefore);
				assert.equal(diffPlans(prev, next).reasons[0], "上下文修订（分批遮蔽）");
			} else {
				assert.ok(isPrefixExtension(prev, next), `第 ${i} 轮在两次修订之间改变了前缀`);
			}
			prev = next;
		}
		assert.ok(revisions.length >= 2 && revisions.length <= 10, `修订次数 ${revisions.length}`);
		const tools = prev.segments.filter((s) => s.kind === "file_content" || s.kind === "masked_placeholder");
		assert.equal(tools.at(-1)?.kind, "file_content");
		assert.equal(tools.at(-2)?.kind, "file_content");
		// 推理与工具调用永不遮蔽
		for (const m of prev.messages) if (m.role === "assistant") assert.match(m.reasoning, /^思考/);
	});

	test("遮蔽收益不足 minBatchTokens 时不修订", () => {
		const planner = new CachePlanner({ enabled: true, triggerTokens: 10, keepRecentToolResults: 1, minBatchTokens: 1e9, hardLimitTokens: 1e9 });
		const b = new ContextBuilder({ system: "s", tools: TOOLS });
		b.appendUser("t");
		turn(b, 0);
		turn(b, 1);
		assert.equal(planner.beforeRequest(b, 0), null);
	});

	test("硬保护：接近窗口时即使未开启遮蔽也强制修订", () => {
		const planner = new CachePlanner({ enabled: false, triggerTokens: Infinity, keepRecentToolResults: 0, minBatchTokens: 0, hardLimitTokens: 3000 });
		const b = new ContextBuilder({ system: "s", tools: TOOLS });
		b.appendUser("t");
		for (let i = 0; i < 4; i++) turn(b, i);
		const r = planner.beforeRequest(b, 1000);
		assert.equal(r?.reason, "hard-limit");
	});

	test("exactTrigger：用上一次实际输入 + 新增估算判断压力；关闭时行为不变", () => {
		const cfg = { enabled: false, triggerTokens: Infinity, keepRecentToolResults: 0, minBatchTokens: 0, hardLimitTokens: 3000 };
		const build = () => { const b = new ContextBuilder({ system: "s", tools: TOOLS }); b.appendUser("t"); for (let i = 0; i < 3; i++) turn(b, i); return b; };
		// 关闭：即使记了实际用量，也按整段估算触发
		const off = new CachePlanner(cfg), b0 = build();
		off.noteUsage(b0.plan().totalTokensEst, b0.revision, 100);
		turn(b0, 3);
		assert.equal(off.beforeRequest(b0, 1000)?.reason, "hard-limit");
		// 开启：实际输入远小于估算时不触发，前缀保持不变
		const on = new CachePlanner({ ...cfg, exactTrigger: true }), b1 = build();
		const before = b1.plan();
		on.noteUsage(before.totalTokensEst, b1.revision, 100);
		turn(b1, 3, 10);
		assert.equal(on.beforeRequest(b1, 1000), null);
		assert.ok(isPrefixExtension(before, b1.plan()));
		assert.equal(on.pressure(b1), 100 + Math.ceil((b1.plan().totalTokensEst - before.totalTokensEst) * 1.2) + 1024);
		// 开启：实际输入已接近上限时照常触发；修订之后旧的校准作废，退回整段估算
		const b2 = build();
		on.noteUsage(b2.plan().totalTokensEst, b2.revision, 1900);
		turn(b2, 3, 10);
		assert.equal(on.beforeRequest(b2, 1000)?.reason, "hard-limit");
		assert.equal(on.pressure(b2), b2.plan().totalTokensEst);
		// 开启：估算偏低（实际更大）时比整段估算更早触发
		const b3 = new ContextBuilder({ system: "s", tools: TOOLS }); b3.appendUser("t"); turn(b3, 0);
		on.noteUsage(b3.plan().totalTokensEst, b3.revision, 2500);
		turn(b3, 1, 10); turn(b3, 2, 10);
		assert.ok(b3.plan().totalTokensEst + 1000 < 3000);
		assert.equal(on.beforeRequest(b3, 1000)?.reason, "hard-limit");
	});

	test("占位符确定、注明引用 ID", () => {
		const meta = { kind: "file_content" as const, ref: "blob_abc", target: "a.py:1-120" };
		assert.equal(placeholderFor("file_read", meta, 1234), placeholderFor("file_read", meta, 1234));
		assert.match(placeholderFor("file_read", meta, 1234), /ref=blob_abc/);
		assert.match(placeholderFor("file_read", meta, 1234), /read the file again/);
		// 有取回工具时写明用引用取回
		assert.match(placeholderFor("file_read", meta, 1234, "context_expand"), /call context_expand with this ref for the text shown then/);
		assert.match(placeholderFor("command_run", { ...meta, kind: "tool_output" }, 1234, "context_expand"), /call context_expand with this ref to see it again/);
	});

	test("遮蔽时使用构造时给出的取回工具名", () => {
		const b = new ContextBuilder({ system: "s", tools: TOOLS, expandTool: "context_expand" });
		for (let i = 0; i < 4; i++) turn(b, i);
		const r = b.maskOlderToolResults({ enabled: true, triggerTokens: 0, keepRecentToolResults: 1, minBatchTokens: 0, hardLimitTokens: 1e9 }, "threshold");
		assert.ok(r && r.maskedIndices.length === 3);
		const masked = b.plan().messages.filter((m) => m.role === "tool" && m.content.startsWith("[earlier"));
		assert.equal(masked.length, 3);
		assert.ok(masked.every((m) => m.role === "tool" && m.content.includes("call context_expand with this ref")));
	});
});

describe("记忆段", () => {
	test("记忆随系统提示发送（稳定前缀：系统提示 → 工具 → 记忆），没有记忆时系统提示不变", () => {
		const b = new ContextBuilder({ system: "sys", tools: TOOLS, memory: "## Project notes\n- a" });
		assert.equal(b.plan().system, "sys\n\n## Project notes\n- a");
		assert.deepEqual(b.plan().segments.slice(0, 3).map((s) => s.kind), ["system", "tools", "memory"]);
		assert.equal(new ContextBuilder({ system: "sys", tools: TOOLS }).plan().system, "sys");
	});
});

describe("价格感知淘汰", () => {
	const cfg = { enabled: true, triggerTokens: Number.POSITIVE_INFINITY, keepRecentToolResults: 0, minBatchTokens: 0, hardLimitTokens: 900_000, policy: "price-aware" as const, minAgeTurns: 2, minResultTokens: 200 };

	test("命中价较高（GLM，r≈0.29）且旧结果足够大时批量遮蔽；最近 minAgeTurns 轮的结果保留", () => {
		const b = new ContextBuilder({ system: "sys", tools: TOOLS });
		b.appendUser("任务");
		const planner = new CachePlanner({ ...cfg, hitMissRatio: 0.2875 });
		let revision = null;
		for (let i = 0; i < 12 && !revision; i++) {
			turn(b, i);
			revision = planner.beforeRequest(b, 1000);
		}
		assert.ok(revision, "应当触发");
		assert.equal(revision?.reason, "price-aware");
		const plan = b.plan();
		const toolMsgs = plan.messages.filter((m) => m.role === "tool");
		assert.ok(!toolMsgs.at(-1)?.content.startsWith("[earlier"), "最近的结果保留原文");
		assert.ok(toolMsgs[0]?.content.startsWith("[earlier file_read output removed"), "最早的结果被替换");
		assert.ok(revision && revision.tokensAfter < revision.tokensBefore);
	});

	test("命中价几乎免费（DeepSeek，r=0.02）时不遮蔽：省下的携带成本抵不过重算", () => {
		const b = new ContextBuilder({ system: "sys", tools: TOOLS });
		b.appendUser("任务");
		const planner = new CachePlanner({ ...cfg, hitMissRatio: 0.02 });
		for (let i = 0; i < 12; i++) {
			turn(b, i);
			assert.equal(planner.beforeRequest(b, 1000), null, `第 ${i} 轮不应遮蔽`);
		}
		assert.equal(b.plan().revision, 0);
	});

	test("没有价格比时不做任何事；小结果不遮蔽", () => {
		const b = new ContextBuilder({ system: "sys", tools: TOOLS });
		b.appendUser("任务");
		for (let i = 0; i < 8; i++) turn(b, i, 5);
		assert.equal(new CachePlanner(cfg).beforeRequest(b, 1000), null);
		assert.equal(new CachePlanner({ ...cfg, hitMissRatio: 0.5 }).beforeRequest(b, 1000), null, "每个结果都小于 minResultTokens");
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

describe("leanRefs：没有取回工具时占位符不写引用", () => {
	test("关闭时与原来相同；开启时去掉 ref 与 raw_ref；有取回工具时照旧写", () => {
		const meta = { kind: "file_content" as const, ref: "blob_abc", target: "a.py:1-120", fullOutputRef: "blob_raw" };
		assert.match(placeholderFor("file_read", meta, 1234), /ref=blob_abc \| raw_ref=blob_raw/);
		assert.equal(placeholderFor("file_read", meta, 1234, undefined, undefined, true), "[earlier file_read output removed to save context | a.py:1-120 | ~1234 tokens | read the file again if you need it]");
		assert.match(placeholderFor("file_read", meta, 1234, "context_expand", undefined, true), /ref=blob_abc/);
	});
});

describe("兜底换版（rebase）", () => {
	const longTurn = (b: ContextBuilder, i: number, reasoningSize: number, toolSize: number, name = "file_read") => {
		const args = name === "command_run" ? `{"argv":["python","-m","pytest","-q","t${i}.py"]}` : name === "file_edit" ? `{"path":"f${i}.py","oldText":"a","newText":"b"}` : `{"path":"f${i}.py","startLine":1,"endLine":40}`;
		b.appendAssistant({ role: "assistant", content: "", reasoning: "思考".repeat(reasoningSize), toolCalls: [{ id: `c${i}`, name, argumentsJson: args }] });
		b.appendToolResult(`c${i}`, name, name === "command_run" ? `运行 python（exit code ${i % 2}）\n${"x".repeat(toolSize)}` : `f${i}.py | lines 1-40\n${"x = 1\n".repeat(toolSize)}`, { kind: name === "file_read" ? "file_content" : "tool_output", ref: `blob_${i}`, target: `f${i}.py` });
	};

	test("整组移出最早的交互、保留用户原话与最近组、插入执行记录；保留的助手消息原样不动；工具配对成立", () => {
		const b = new ContextBuilder({ system: "s", tools: TOOLS });
		b.appendUser("任务原文：修三个缺陷");
		for (let i = 0; i < 12; i++) longTurn(b, i, 400, 60, i % 3 === 0 ? "command_run" : i % 3 === 1 ? "file_edit" : "file_read");
		b.appendRuntimeNotice("中途的运行时通知");
		for (let i = 12; i < 16; i++) longTurn(b, i, 400, 60);
		const keptBefore = b.plan().messages.slice(-4).map((m) => JSON.stringify(m));
		const r = b.rebase(2000);
		assert.equal(r?.reason, "rebase");
		assert.ok((r?.removedGroups ?? 0) >= 12);
		const msgs = b.plan().messages;
		assert.equal(msgs[0]!.role === "user" && msgs[0]!.content, "任务原文：修三个缺陷");
		assert.ok(msgs.some((m) => m.role === "user" && m.content.includes("中途的运行时通知")), "被移出范围里的用户消息原样保留");
		const cp = msgs.find((m) => m.role === "user" && m.content.startsWith("[Context checkpoint"));
		assert.ok(cp && cp.role === "user");
		assert.match(cp.content, /Files edited: .*f1\.py \(1\)/);
		assert.match(cp.content, /`python -m pytest -q t0\.py` → exit code 0/);
		assert.match(cp.content, /do not repeat commands that change files/);
		assert.deepEqual(msgs.slice(-4).map((m) => JSON.stringify(m)), keptBefore, "最近的组逐字保留");
		for (const m of msgs) if (m.role === "assistant") assert.ok(m.reasoning.length > 0, "保留的助手消息思考完整");
		assert.ok(b.plan().totalTokensEst < r!.tokensBefore);
		assert.equal(b.revision, 1);
	});

	test("只有一组时不换版；规划器：先遮蔽一次，下一次到上限直接换版", () => {
		const one = new ContextBuilder({ system: "s", tools: TOOLS }); one.appendUser("t"); longTurn(one, 0, 10, 10);
		assert.equal(one.rebase(10), null);
		const planner = new CachePlanner({ enabled: false, triggerTokens: Infinity, keepRecentToolResults: 1, minBatchTokens: 0, hardLimitTokens: 4000, rebase: true, rebaseTargetTokens: 1500 });
		const b = new ContextBuilder({ system: "s", tools: TOOLS }); b.appendUser("t");
		for (let i = 0; i < 6; i++) longTurn(b, i, 20, 400);
		const first = planner.beforeRequest(b, 1000);
		assert.equal(first?.reason, "hard-limit", "第一次：遮蔽工具结果");
		for (let i = 6; i < 40; i++) longTurn(b, i, 200, 10);
		const second = planner.beforeRequest(b, 1000);
		assert.equal(second?.reason, "rebase", "同一阶段第二次到上限：换版");
		assert.ok(b.plan().totalTokensEst + 1000 < 4000);
	});

	test("遮蔽后仍放不下（几乎全是思考）时直接换版；关闭 rebase 时行为不变", () => {
		const mk = () => { const b = new ContextBuilder({ system: "s", tools: TOOLS }); b.appendUser("t"); for (let i = 0; i < 30; i++) longTurn(b, i, 300, 2); return b; };
		const on = new CachePlanner({ enabled: false, triggerTokens: Infinity, keepRecentToolResults: 1, minBatchTokens: 0, hardLimitTokens: 4000, rebase: true });
		assert.equal(on.beforeRequest(mk(), 1000)?.reason, "rebase");
		const off = new CachePlanner({ enabled: false, triggerTokens: Infinity, keepRecentToolResults: 1, minBatchTokens: 0, hardLimitTokens: 4000 });
		const r = off.beforeRequest(mk(), 1000);
		assert.notEqual(r?.reason, "rebase");
	});

	test("占位符不再提示重新运行命令", () => {
		const meta = { kind: "tool_output" as const, ref: "blob_x", target: "pytest" };
		assert.ok(!/run it again/.test(placeholderFor("command_run", meta, 100)));
		assert.match(placeholderFor("command_run", meta, 100), /never repeat a command that changes files/);
	});
});
