import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ModelRequest, ModelResponse, ModelStreamHandlers } from "@mountains/providers";
import { BlobStore, defaultTools } from "@mountains/tools";
import { placeholderFor } from "@mountains/context";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, validateApprovalSettings, type EngineOptions, type RecordedResponse } from "../src/index.ts";

// Real host dispatch, process, archive and history. Only model replies are scripted.
type Call = { id: string; name: string; args: Record<string, unknown> };
function reply(calls: Call[] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Offline complete.", reasoning: "fixture", toolCalls: calls.map(c => ({ id: c.id, name: c.name, argumentsJson: JSON.stringify(c.args) })) }, finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 }, httpStatus: 200, error: null, aborted: false };
}
class Steps extends ScriptedModelAdapter {
	private readonly queue: RecordedResponse[];
	private readonly steps: ((request: ModelRequest) => RecordedResponse)[];
	constructor(steps: ((request: ModelRequest) => RecordedResponse)[]) { const q: RecordedResponse[] = []; super(q); this.queue = q; this.steps = steps; }
	override async complete(request: ModelRequest, handlers?: ModelStreamHandlers): Promise<ModelResponse> {
		const step = this.steps[this.requests.length]; assert.ok(step, "unexpected request");
		this.queue.push(step(request)); return super.complete(request, handlers);
	}
}
function content(request: ModelRequest, id: string): string {
	const m = request.messages.find(m => m.role === "tool" && m.toolCallId === id); assert.ok(m?.role === "tool"); return m.content;
}
function fixture(t: TestContext) {
	const base = mkdtempSync(join(tmpdir(), "mountains-archive-integration-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "work"); const archive = join(base, "archive"); mkdirSync(workspace);
	let n = 0;
	function session(adapter: ScriptedModelAdapter, extra: Partial<EngineOptions> = {}) {
		const id = `session-${++n}`;
		return new AgentSession({ workspace, archiveDir: archive, archiveHistory: true, sessionId: id,
			dataDir: join(base, id), adapter, model: "deepseek-flash", thinking: { enabled: true, effort: "high" }, maxTokens: 100,
			budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(base, "spend.jsonl") }), checkpoints: false,
			retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxRequests: 10, maxTurns: 10 }, contextGuard: true,
			toolOptions: { expand: true, archiveSearch: true }, ...extra });
	}
	return { base, workspace, archive, session };
}

test("real command -> archived lookup -> exact original byte page survives masking and live file changes", async t => {
	const f = fixture(t); const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}: ${"background ".repeat(10)}`);
	lines[200] = "TARGET=immutable original";
	const raw = Buffer.from(lines.join("\r\n") + "\r\n"); writeFileSync(join(f.workspace, "log.txt"), raw);
	let ref = ""; let start = 0; let end = 0;
	const main = new Steps([
		() => reply([{ id: "source-command", name: "command_run", args: { argv: [process.execPath, "-e", 'process.stdout.write(require("node:fs").readFileSync("log.txt"))'] } }]),
		request => {
			const shown = content(request, "source-command"); assert.match(shown, /context_search/); assert.doesNotMatch(shown, /TARGET=immutable/);
			ref = /fullOutputRef=(blob_v2_[a-z0-9_]+)/.exec(shown)?.[1] ?? ""; assert.ok(ref); assert.match(shown, /toolCallId="source-command"/);
			writeFileSync(join(f.workspace, "log.txt"), "TARGET=new live file\n");
			return reply([{ id: "find", name: "context_search", args: { ref, toolCallId: "source-command", needle: "TARGET=" } }]);
		},
		request => {
			const found = JSON.parse(content(request, "find")); assert.equal(found.ok, true, content(request, "find")); assert.equal(found.command.processStatus, "exited-zero");
			assert.equal(found.command.suiteStatus, "not_evaluated"); assert.equal(found.command.captureComplete, null);
			assert.equal(found.matches.length, 1); assert.equal(found.matches[0].line, 201);
			assert.equal(found.matches[0].snippet.text, "TARGET=immutable original\r\n");
			start = found.matches[0].snippet.byteStart; end = found.matches[0].snippet.byteEnd;
			const masked = content(request, "source-command"); assert.match(masked, /output removed/); assert.ok(masked.includes(`raw_ref=${ref}`));
			assert.match(masked, /context_search.*toolCallId="source-command"/);
			return reply([{ id: "page", name: "context_expand", args: { ref, offsetBytes: start, maxBytes: end - start } }]);
		},
		request => {
			const page = content(request, "page"); assert.deepEqual(Buffer.from(page.slice(page.indexOf("\n") + 1)), raw.subarray(start, end)); return reply();
		},
	]);
	const agent = f.session(main, { masking: { enabled: true, triggerTokens: 1, keepRecentToolResults: 1, minBatchTokens: 0, hardLimitTokens: 100_000 } });
	const result = await agent.run("Read the fixture command log and recover the original target line.");
	assert.equal(result.status, "completed", result.reason); assert.equal(main.requests.length, 4);
});

test("archive lookup honors history opt-in and workspace scope through actual engine dispatch", async t => {
	const f = fixture(t); const b = new BlobStore(f.archive, { workspaceRoot: f.workspace, sessionId: "old-session" });
	const ref = b.put(Buffer.from("target original\n"), { kind: "raw", source: { tool: "command_run", toolCallId: "old-command", exitCode: 0, timedOut: false, cancelled: false, signal: null } });
	const other = join(f.base, "other-work"); mkdirSync(other);
	for (const [workspace, history, allowed] of [[f.workspace, false, false], [f.workspace, true, true], [other, true, false]] as const) {
		const main = new Steps([
			() => reply([{ id: "lookup", name: "context_search", args: { ref, toolCallId: "old-command", needle: "target" } }]),
			request => { const value = JSON.parse(content(request, "lookup")); assert.equal(value.ok, allowed); if (allowed) assert.equal(value.matches[0].snippet.text, "target original\n"); return reply(); },
		]);
		const result = await f.session(main, { workspace, archiveHistory: history }).run("Look up the supplied historical command ref.");
		assert.equal(result.status, "completed", result.reason);
	}
});

test("lookup never calls an approval model, and an explicit manual gate still stops it before execution", async t => {
	const f = fixture(t); const b = new BlobStore(f.archive, { workspaceRoot: f.workspace, sessionId: "old" });
	const ref = b.put(Buffer.from("target\n"), { kind: "raw", source: { tool: "command_run", toolCallId: "old", exitCode: 0, timedOut: false, cancelled: false, signal: null } });
	for (const manual of [false, true]) {
		const main = new ScriptedModelAdapter([reply([{ id: "lookup", name: "context_search", args: { ref, toolCallId: "old", needle: "target" } }]), reply()]);
		let executions = 0; let judgeCalls = 0;
		const tools = defaultTools({ expand: true, archiveSearch: true }).map(tool => tool.name !== "context_search" ? tool : { ...tool, async execute(args: Parameters<typeof tool.execute>[0], ctx: Parameters<typeof tool.execute>[1]) { executions++; return tool.execute(args, ctx); } });
		const settings = validateApprovalSettings({ model: "deepseek-flash", maxCost: 0.25, manualTools: manual ? ["context_search"] : [] }, "USD");
		const result = await f.session(main, { tools, modelApproval: { settings, adapter: { id: "must-not-run", async complete() { judgeCalls++; throw new Error("unexpected judge request"); } } } }).run("Search the previously saved command output.");
		assert.equal(judgeCalls, 0); assert.equal(executions, manual ? 0 : 1); assert.equal(result.status, manual ? "limit" : "completed", result.reason);
		assert.equal(main.requests.length, manual ? 1 : 2);
	}
});

test("disabled lookup preserves existing tool definitions and placeholders; only command origins get search hints", () => {
	const spec = (enabled?: boolean) => defaultTools({ expand: true, ...(enabled === undefined ? {} : { archiveSearch: enabled }) }).map(({ name, description, parameters }) => ({ name, description, parameters }));
	assert.deepEqual(spec(), spec(false)); assert.deepEqual(spec(true).slice(0, -1), spec(false)); assert.equal(spec(true).at(-1)?.name, "context_search");
	assert.throws(() => defaultTools({ archiveSearch: true }), /expand/);
	const meta = { kind: "tool_output" as const, ref: "shown", fullOutputRef: "raw", fullOutputSourceCallId: "old-command", target: "test" };
	const prior = "[earlier command_run output removed to save context | test | ~500 tokens | call context_expand with this ref to see it again | ref=shown | raw_ref=raw (complete captured bytes; use a separate range from shown)]";
	assert.equal(placeholderFor("command_run", meta, 500, "context_expand"), prior);
	assert.match(placeholderFor("command_run", meta, 500, "context_expand", "context_search"), /context_search ref=raw toolCallId="old-command"/);
	assert.doesNotMatch(placeholderFor("file_read", meta, 500, "context_expand", "context_search"), /context_search/);
	assert.doesNotMatch(placeholderFor("command_run", { ...meta, fullOutputSourceCallId: "" }, 500, "context_expand", "context_search"), /context_search/);
});
