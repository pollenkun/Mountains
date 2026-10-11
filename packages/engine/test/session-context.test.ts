import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { assertToolPairing, type ContextPolicy } from "@mountains/context";
import type { ModelRequest, ModelResponse, ModelStreamHandlers } from "@mountains/providers";
import { AgentSession, BudgetGuard, COMPACTION_REQUEST, ScriptedModelAdapter, SYSTEM_PROMPT, TOOL_NOTES, type EngineOptions, type RecordedResponse } from "../src/index.ts";

// Real host, tools, files and ledger; only model decisions and reported usage are scripted.
type Call = { id: string; name: string; args: Record<string, unknown> };
function reply(calls: Call[] = [], promptTokens = 120): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "analysis",
		toolCalls: calls.map(call => ({ id: call.id, name: call.name, argumentsJson: JSON.stringify(call.args) })) },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash",
		rawUsage: { prompt_tokens: promptTokens, prompt_cache_hit_tokens: promptTokens - 20, prompt_cache_miss_tokens: 20, completion_tokens: 12, total_tokens: promptTokens + 12, completion_tokens_details: { reasoning_tokens: 4 } },
		httpStatus: 200, error: null, aborted: false };
}
class Steps extends ScriptedModelAdapter {
	private readonly queue: RecordedResponse[];
	private readonly steps: ((request: ModelRequest) => RecordedResponse)[];
	constructor(steps: ((request: ModelRequest) => RecordedResponse)[]) { const queue: RecordedResponse[] = []; super(queue); this.queue = queue; this.steps = steps; }
	override async complete(request: ModelRequest, handlers?: ModelStreamHandlers): Promise<ModelResponse> {
		const step = this.steps[this.requests.length]; assert.ok(step, "unexpected extra model request");
		this.queue.push(step(request)); return super.complete(request, handlers);
	}
}
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "session-context-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	writeFileSync(join(workspace, "calc.cjs"), "exports.add = (a, b) => a - b;\n");
	let serial = 0;
	function options(adapter: ScriptedModelAdapter, extra: Partial<EngineOptions> = {}): EngineOptions {
		const id = `session-${++serial}`;
		return { workspace, dataDir: join(root, id), sessionId: id, adapter, model: "deepseek-flash",
			thinking: { enabled: true, effort: "high" }, maxTokens: 32000, checkpoints: false,
			budget: new BudgetGuard({ globalLimit: 100, ledgerPath: join(root, "spend.jsonl") }),
			limits: { maxTurns: 20, maxRequests: 20, maxCost: 10 }, retry: { maxAttempts: 1, baseDelayMs: 0 }, ...extra };
	}
	return { root, workspace, options };
}

test("a session keeps the configured thinking, the system prompt with tool notes, and one repository brief", async t => {
	const f = fixture(t);
	const adapter = new Steps([
		() => reply([{ id: "read", name: "file_read", args: { path: "calc.cjs" } }]),
		() => reply(),
		() => reply(),
	]);
	const options = f.options(adapter, { thinking: { enabled: true, effort: "low" } });
	const session = new AgentSession(options);
	assert.equal((await session.run("What does add do?")).status, "completed");
	assert.equal((await session.run("And is it correct?")).status, "completed");
	for (const request of adapter.requests) {
		assert.deepEqual(request.thinking, { enabled: true, effort: "low" }, "the configured thinking is kept");
		assert.equal(request.system, SYSTEM_PROMPT + TOOL_NOTES);
		assert.ok(!request.messages.some(m => m.content.startsWith("[Runtime workflow reminder")), "no per-batch reminder");
	}
	const last = adapter.requests.at(-1)!;
	assert.equal(last.messages.filter(m => m.content.includes("[Repository facts")).length, 1, "brief once per session");
	assert.deepEqual(last.tools.slice(-2).map(t => t.name), ["session_search", "task_note"]);
	assert.match(last.tools.find(t => t.name === "file_edit")!.description, /./);
	assert.equal(session.options.toolOptions?.editFeedback, true, "edit feedback is on");
});

test("a session resumes after a restart with its session search rebuilt", async t => {
	const f = fixture(t);
	const archiveDir = join(f.root, "archive");
	const first = new ScriptedModelAdapter([reply([{ id: "read", name: "file_read", args: { path: "calc.cjs" } }]), reply()]);
	const base = { allowSessionSnapshots: true, archiveDir, sessionId: "ses_product_resume" };
	const session = new AgentSession(f.options(first, base));
	assert.equal((await session.run("Remember marker PRODUCT_RESUME_91. Read calc.cjs.")).status, "completed");
	const snapshot = JSON.parse(JSON.stringify(session.exportSnapshot()));
	const resumedAdapter = new Steps([
		request => {
			assert.ok(request.messages.some(m => m.content.includes("PRODUCT_RESUME_91")), "history restored");
			return reply([{ id: "find-user", name: "session_search", args: { needle: "PRODUCT_RESUME_91" } }, { id: "find-source", name: "session_search", args: { needle: "a - b" } }]);
		},
		request => {
			const user = JSON.parse(request.messages.find(m => m.role === "tool" && m.toolCallId === "find-user")!.content);
			const source = JSON.parse(request.messages.find(m => m.role === "tool" && m.toolCallId === "find-source")!.content);
			assert.equal(user.ok, true); assert.ok(user.matches.some((hit: { role: string }) => hit.role === "user"));
			assert.equal(source.ok, true); assert.ok(source.matches.some((hit: { toolCallId?: string }) => hit.toolCallId === "read"));
			return reply();
		},
	]);
	const resumed = new AgentSession(f.options(resumedAdapter, { ...base, sessionId: "ses_product_resume" }));
	resumed.restoreSnapshot(snapshot);
	assert.equal(resumedAdapter.requests.length, 0, "restoring sends no request");
	assert.equal((await resumed.run("What did I ask you to remember?")).status, "completed");
	assert.equal(resumedAdapter.requests.length, 2);
});

// Small absolute lines so a few reads cross them; the judgement is the engine's own.
const LINES: ContextPolicy = { triggerTokens: 6_000, hardLimitTokens: 400_000, compactTokens: 300_000, compactTailTokens: 3_000, minBatchTokens: 1_000, settledUserTurns: 2 };
const big = (tag: string, lines = 600) => Array.from({ length: lines }, (_, i) => `${tag} line ${i}: inventory record ${i * 7919 % 1000003} checked, no action needed`).join("\n") + "\n";
const records = (dataDir: string) => readFileSync(join(dataDir, "recording.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const general = { contextPolicy: LINES };

test("past the trigger line a superseded read folds in the background", async t => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "a.txt"), big("alpha"));
	const adapter = new Steps([
		() => reply([{ id: "r1", name: "file_read", args: { path: "a.txt" } }]),
		() => reply([{ id: "r2", name: "file_read", args: { path: "a.txt", force: true } }]),
		request => {
			const notice = request.messages.find(m => m.role === "user" && m.content.includes("Folded 1 earlier tool call (superseded by a later read or edit)"));
			assert.ok(notice, "the first read is folded with its reason");
			assert.match(notice!.content, / ref=blob_v2_[0-9a-f_]+raw_[0-9a-f]{64} restores the full interaction/);
			assert.equal(request.messages.filter(m => m.role === "tool" && m.content.includes("alpha line 500:")).length, 1, "the newer read stays");
			assertToolPairing(request.messages);
			return reply();
		},
	]);
	const session = new AgentSession(f.options(adapter, general));
	assert.equal((await session.run("Read a.txt twice.")).status, "completed");
	const revisions = records(session.options.dataDir).filter(r => r.kind === "context.revision");
	assert.deepEqual(revisions.map(r => r.data.reason), ["lossless"]);
});

test("results from requests before the last two are settled and fold; user messages and final answers stay verbatim", async t => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "a.txt"), big("alpha"));
	const adapter = new Steps([
		() => reply([{ id: "r1", name: "file_read", args: { path: "a.txt" } }]),
		() => ({ ...reply(), message: { ...reply().message, content: "Answer one: alpha has 600 lines." } }),
		request => { assert.ok(request.messages.some(m => m.role === "tool" && m.content.includes("alpha line 500:")), "still kept on the next request"); return reply(); },
		request => {
			assert.ok(!request.messages.some(m => m.role === "tool" && m.content.includes("alpha line 500:")), "settled read folded");
			assert.ok(request.messages.some(m => m.role === "user" && m.content.includes("from an earlier finished request")));
			for (const text of ["Turn 1: read a.txt.", "Turn 2.", "Turn 3.", "Answer one: alpha has 600 lines."]) assert.ok(request.messages.some(m => m.content === text), text);
			return reply();
		},
	]);
	const session = new AgentSession(f.options(adapter, general));
	for (const text of ["Turn 1: read a.txt.", "Turn 2.", "Turn 3."]) assert.equal((await session.run(text)).status, "completed");
});

test("at the compaction line the model summarizes earlier interactions on the cached prefix; the summary replaces them", async t => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "a.txt"), big("alpha", 1200));
	writeFileSync(join(f.workspace, "b.txt"), big("bravo", 300));
	const archiveDir = join(f.root, "archive");
	const lines = { ...LINES, compactTokens: 32_000 + 20_000 };
	let summaryRequest: ModelRequest | undefined;
	const adapter = new Steps([
		() => reply([{ id: "ra", name: "file_read", args: { path: "a.txt" } }]),
		() => reply([{ id: "rb", name: "file_read", args: { path: "b.txt" } }]),
		request => {
			summaryRequest = request;
			assert.equal(request.messages.at(-1)!.content, COMPACTION_REQUEST);
			assert.ok(request.messages.some(m => m.role === "tool" && m.content.includes("alpha line 900:")), "the summary sees the whole conversation");
			return { ...reply(), message: { ...reply().message, content: "## Goal and requests\n- read both files\n## Facts and values needed later\n- alpha code ALPHA-7" } };
		},
		request => {
			assert.equal(request.messages.slice(0, -1).length < summaryRequest!.messages.length, true);
			assert.ok(!request.messages.some(m => m.content.includes("alpha line 900:")), "the earlier read is gone");
			const notice = request.messages.find(m => m.role === "user" && m.content.includes("<summary>"));
			assert.ok(notice && notice.content.includes("alpha code ALPHA-7") && notice.content.includes("the summary you wrote"));
			assert.ok(request.messages.some(m => m.content === "Read both files."), "user message verbatim");
			assert.ok(request.messages.some(m => m.role === "tool" && m.content.includes("bravo line 200:")), "the newest interaction stays");
			assertToolPairing(request.messages);
			return reply();
		},
	]);
	const session = new AgentSession(f.options(adapter, { ...general, contextPolicy: lines, archiveDir, allowSessionSnapshots: true, sessionId: "ses_compact" }));
	const run = await session.run("Read both files.");
	assert.equal(run.status, "completed");
	assert.equal(run.totals.requests, 4, "the summary request is counted");
	const recs = records(session.options.dataDir);
	assert.deepEqual(recs.filter(r => r.kind === "context.revision").map(r => r.data.reason), ["compaction"]);
	assert.equal(recs.find(r => r.kind === "context.compaction-request")!.data.usable, true);
	// The compacted session restores, and the archived read is still searchable.
	const snapshot = JSON.parse(JSON.stringify(session.exportSnapshot()));
	const resumedAdapter = new Steps([
		() => reply([{ id: "find", name: "session_search", args: { needle: "alpha line 900:" } }]),
		request => {
			const found = JSON.parse(request.messages.find(m => m.role === "tool" && m.toolCallId === "find")!.content);
			assert.ok(found.matches.some((hit: { toolCallId?: string }) => hit.toolCallId === "ra"), "archived read searchable after restore");
			return reply();
		},
	]);
	const resumed = new AgentSession(f.options(resumedAdapter, { ...general, contextPolicy: lines, archiveDir, allowSessionSnapshots: true, sessionId: "ses_compact" }));
	resumed.restoreSnapshot(snapshot);
	assert.equal((await resumed.run("What was on alpha line 900?")).status, "completed");
});

test("when the summary request cannot be used, the program writes its own record and the work continues", async t => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "a.txt"), big("alpha", 1200));
	writeFileSync(join(f.workspace, "b.txt"), big("bravo", 300));
	const adapter = new Steps([
		() => reply([{ id: "ra", name: "file_read", args: { path: "a.txt" } }]),
		() => reply([{ id: "rb", name: "file_read", args: { path: "b.txt" } }]),
		() => reply([{ id: "x", name: "file_read", args: { path: "a.txt" } }]),
		request => {
			const notice = request.messages.find(m => m.role === "user" && m.content.includes("<summary>"));
			assert.ok(notice && notice.content.includes("program record") && notice.content.includes("Files read: a.txt"));
			return reply();
		},
	]);
	const session = new AgentSession(f.options(adapter, { ...general, contextPolicy: { ...LINES, compactTokens: 52_000 } }));
	assert.equal((await session.run("Read both files.")).status, "completed");
	assert.equal(records(session.options.dataDir).find(r => r.kind === "context.compaction-request")!.data.usable, false);
});

test("compactNow summarizes an idle conversation on request", async t => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "a.txt"), big("alpha"));
	const adapter = new Steps([
		() => reply([{ id: "ra", name: "file_read", args: { path: "a.txt" } }]),
		() => reply(),
		request => { assert.equal(request.messages.at(-1)!.content, COMPACTION_REQUEST); return { ...reply(), message: { ...reply().message, content: "## Goal and requests\n- read a.txt" } }; },
		request => { assert.ok(request.messages.some(m => m.content.includes("<summary>\n## Goal and requests\n- read a.txt"))); assert.ok(!request.messages.some(m => m.content.includes("alpha line 500:"))); return reply(); },
	]);
	const session = new AgentSession(f.options(adapter, { ...general, contextPolicy: { ...LINES, compactTailTokens: 0 } }));
	assert.equal((await session.run("Read a.txt.")).status, "completed");
	const done = await session.compactNow();
	assert.equal(done.revision?.reason, "compaction");
	assert.ok(done.cost > 0);
	assert.equal((await session.run("Next.")).status, "completed");
});

test("a smaller assumed context window scales every line with it", t => {
	const f = fixture(t);
	const lines = (window?: number) => {
		const session = new AgentSession(f.options(new ScriptedModelAdapter([]), window === undefined ? {} : { contextWindow: window }));
		return (session as unknown as { planner: { policy: ContextPolicy } }).planner.policy;
	};
	assert.deepEqual({ ...lines(131_072) }, { ...lines(131_072), triggerTokens: 78_643, compactTokens: 117_964, compactTailTokens: 13_107, minBatchTokens: 3_932 });
	assert.equal(lines(262_144).triggerTokens, 157_286);
	assert.ok(lines().triggerTokens > 600_000, "without it the model's own window applies");
	assert.throws(() => lines(100_000_000), /不能大于模型窗口/);
	assert.throws(() => lines(1000), /不小于 32768/);
});
