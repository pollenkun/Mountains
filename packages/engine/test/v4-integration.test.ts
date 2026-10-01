import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent, ToolMessage } from "@mountains/protocol";
import type { ModelRequest, ModelResponse, ModelStreamHandlers } from "@mountains/providers";
import { defaultTools, MemoryStore, QueryRecipeStore, renderMemory, verifyMemory, Workspace, type ToolDefinition } from "@mountains/tools";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

// Only model replies are scripted. Tool dispatch, files, archives, compression,
// memory validation and accounting all go through the real AgentSession.
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
function reply(calls: { id: string; name: string; args: Record<string, unknown> }[] = []): RecordedResponse {
	return {
		ok: true, message: { role: "assistant", content: calls.length ? "" : "Offline workflow complete.", reasoning: "scripted protocol exercise", toolCalls: calls.map(({ id, name, args }) => ({ id, name, argumentsJson: JSON.stringify(args) })) },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage: usage, httpStatus: 200, error: null, aborted: false,
	};
}
type Step = (request: ModelRequest) => RecordedResponse;
class CheckedScript extends ScriptedModelAdapter {
	private readonly queue: RecordedResponse[];
	private readonly steps: Step[];
	constructor(steps: Step[]) {
		const queue: RecordedResponse[] = [];
		super(queue); this.queue = queue; this.steps = steps;
	}
	override async complete(request: ModelRequest, handlers?: ModelStreamHandlers): Promise<ModelResponse> {
		const step = this.steps[this.requests.length];
		assert.ok(step, "AgentSession must not send an unplanned request");
		this.queue.push(step(request));
		return super.complete(request, handlers);
	}
}
function output(request: ModelRequest, id: string): ToolMessage {
	const result = request.messages.find((message) => message.role === "tool" && message.toolCallId === id);
	assert.ok(result?.role === "tool", `missing actual tool result for ${id}`);
	return result;
}
function completed(events: EngineEvent[], id: string) {
	const event = events.find((event) => event.type === "tool.completed" && event.toolCallId === id);
	assert.ok(event?.type === "tool.completed", `missing completion for ${id}`);
	assert.ok(event.details !== null && typeof event.details === "object" && !Array.isArray(event.details), `invalid completion details for ${id}`);
	return { ...event, details: event.details as Record<string, unknown> };
}
function fixture(t: TestContext) {
	const base = mkdtempSync(join(tmpdir(), "mountains-v4-integration-"));
	const workspace = join(base, "workspace"); mkdirSync(workspace);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const memory = new MemoryStore(join(base, "state", "memory.jsonl"));
	const recipes = new QueryRecipeStore(join(base, "state", "recipes.json"));
	let count = 0;
	function session(adapter: ScriptedModelAdapter, extra: Partial<EngineOptions> = {}) {
		const dataDir = join(base, `session-${++count}`);
		const events: EngineEvent[] = [];
		const currentMemory = renderMemory(verifyMemory(new Workspace(workspace), memory.entries(), { strict: true }));
		const agent = new AgentSession({
			workspace, dataDir, adapter, model: "deepseek-flash", thinking: { enabled: true, effort: "high" }, maxTokens: 100,
			budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(base, "spend.jsonl") }), checkpoints: false,
			retry: { maxAttempts: 4, baseDelayMs: 1 }, limits: { maxRequests: 20, maxTurns: 20 }, systemPrompt: "Exercise the offline fixture tools.",
			contextGuard: true, archiveDir: join(base, "archive"), archiveHistory: true, memory: currentMemory,
			toolOptions: { batchEdit: true, queryPlans: true, memory, verifiedMemory: true, recipes, expand: true, read: { defaultLines: 4, maxLines: 8, maxLineChars: 400, dedupe: true } },
			onEvent: (event) => events.push(event), ...extra,
		});
		return { agent, events, dataDir };
	}
	return { base, workspace, memory, recipes, session };
}
const methodSteps = [
	{ id: "package", op: "glob", patterns: ["package.json"] },
	{ id: "test", op: "json_field", path: { from: "package", expect: "one" }, field: ["scripts", "test"] },
	{ id: "runner", op: "json_field", path: "settings.json", field: ["runner"] },
];

test("three offline sessions carry real evidence through plans, batch edits, compression, archives and revalidation", async (t) => {
	const f = fixture(t);
	const originalPackage = '{\n  "name": "fixture",\n  "scripts": {\n    "test": "node --test legacy.test.js",\n    "lint": "node --check app.js"\n  }\n}\n';
	writeFileSync(join(f.workspace, "package.json"), originalPackage);
	writeFileSync(join(f.workspace, "settings.json"), '{"runner":"legacy","unrelated":true}\n');
	const logLines = Array.from({ length: 600 }, (_, index) => `line ${index + 1}: ${"bounded historical evidence ".repeat(12)}`);
	logLines[300] = "HISTORICAL_MIDDLE=archived-version";
	writeFileSync(join(f.workspace, "build.log"), `${logLines.join("\n")}\n`);
	let rawRef = ""; let recipeId = ""; let memoryId = "";
	const first = new CheckedScript([
		() => reply([{ id: "locate", name: "query_plan", args: { steps: [
			{ id: "find", op: "search", pattern: "legacy.test.js", glob: "*.json" },
			{ id: "source", op: "read", path: { from: "find", expect: "one" }, startLine: 1, endLine: 7 },
		] } }]),
		(request) => {
			assert.match(output(request, "locate").content, /\[source\] package\.json/);
			assert.match(output(request, "locate").content, /node --test legacy\.test\.js/);
			// No file_read or expectedHash: the plan's published read must grant the edit permission.
			return reply([{ id: "batch", name: "file_edit", args: { path: "package.json", edits: [
				{ oldText: '"name": "fixture"', newText: '"name": "fixture-v4"' },
				{ oldText: "node --test legacy.test.js", newText: "node --test integration.test.js" },
			] } }]);
		},
		(request) => {
			assert.match(output(request, "batch").content, /2 replacement\(s\)/);
			return reply([{ id: "save-method", name: "query_plan", args: { steps: methodSteps, saveAs: "Read current test and runner settings" } }]);
		},
		(request) => {
			const content = output(request, "save-method").content;
			assert.match(content, /node --test integration\.test\.js/);
			recipeId = /Saved method (q_[0-9a-f]{16})/.exec(content)?.[1] ?? "";
			assert.ok(recipeId);
			return reply([{ id: "truncated-log", name: "file_read", args: { path: "build.log" } }]);
		},
		(request) => {
			const content = output(request, "truncated-log").content;
			assert.match(content, /lines 1-4 of 600/);
			assert.doesNotMatch(content, /HISTORICAL_MIDDLE/);
			rawRef = /fullOutputRef=([^\s]+)/.exec(content)?.[1] ?? "";
			assert.ok(rawRef);
			return reply([{ id: "recover-middle", name: "context_expand", args: { ref: rawRef, offset: 301, limit: 1 } }]);
		},
		(request) => {
			assert.match(output(request, "recover-middle").content, /original archived bytes[\s\S]*HISTORICAL_MIDDLE=archived-version/);
			const compressed = output(request, "truncated-log").content;
			assert.ok(compressed.includes(`raw_ref=${rawRef}`), "compression must preserve the exact raw recovery handle");
			assert.doesNotMatch(compressed, /line 1: bounded/);
			return reply([{ id: "save-fact", name: "memory_record", args: {
				note: "MODEL_INFERENCE_MUST_NOT_BE_INJECTED: this command always succeeds",
				evidence: [{ path: "package.json", start_line: 2, end_line: 2 }],
				fact: { kind: "package-script", path: "package.json", selector: "/scripts/test" },
				dependencies: [{ kind: "json-field", path: "settings.json", selector: "/runner" }], coverage: "declared-complete",
			} }]);
		},
		(request) => {
			memoryId = /Recorded note (m\d+)/.exec(output(request, "save-fact").content)?.[1] ?? "";
			assert.ok(memoryId); return reply();
		},
	]);
	const s1 = f.session(first, { masking: { enabled: true, triggerTokens: 1, keepRecentToolResults: 1, minBatchTokens: 0, hardLimitTokens: 100_000 } });
	const result1 = await s1.agent.run("Update both package fields; inspect the old middle log and retain only checked configuration facts.");
	assert.equal(result1.status, "completed", result1.reason);
	assert.deepEqual(result1.filesChanged, ["package.json"]);
	assert.equal(readFileSync(join(f.workspace, "package.json"), "utf8"), originalPackage.replace('"fixture"', '"fixture-v4"').replace("legacy.test.js", "integration.test.js"));
	assert.equal(completed(s1.events, "batch").details.replacements, 2);
	assert.equal(completed(s1.events, "truncated-log").details.truncated, true);
	assert.ok(s1.events.some((event) => event.type === "context.revision" && event.maskedRefs.length > 0 && event.tokensAfter < event.tokensBefore), "a real smaller context revision must have been published");
	assert.ok(s1.agent.builder.plan().revision > 0);
	assert.equal(f.memory.entries().length, 1);
	assert.equal(f.recipes.entries(f.workspace).length, 1);
	assert.doesNotMatch(readFileSync(f.recipes.file, "utf8"), /node --test integration\.test\.js|archived-version/, "methods must not store old answers");

	// Change the live log: recovering the first session's raw ref must still show historical bytes.
	logLines[300] = "CURRENT_MIDDLE=live-version";
	writeFileSync(join(f.workspace, "build.log"), `${logLines.join("\n")}\n`);
	const second = new CheckedScript([
		(request) => {
			assert.match(request.system, /package\.json \/scripts\/test = "node --test integration\.test\.js"/);
			assert.doesNotMatch(request.system, /MODEL_INFERENCE_MUST_NOT_BE_INJECTED/);
			return reply([{ id: "query-valid", name: "memory_query", args: { id: memoryId } }, { id: "list-methods", name: "query_recipe", args: { action: "list" } }]);
		},
		(request) => {
			assert.match(output(request, "query-valid").content, /node --test integration\.test\.js/);
			assert.ok(output(request, "list-methods").content.includes(recipeId));
			assert.doesNotMatch(output(request, "list-methods").content, /node --test integration\.test\.js/);
			return reply([{ id: "reuse-method", name: "query_recipe", args: { action: "replay", id: recipeId } }]);
		},
		(request) => {
			assert.match(output(request, "reuse-method").content, /evidence was read now[\s\S]*node --test integration\.test\.js[\s\S]*= "legacy"/);
			return reply([{ id: "history-other-session", name: "context_expand", args: { ref: rawRef, offset: 301, limit: 1 } }, { id: "current-log", name: "file_read", args: { path: "build.log", startLine: 301, endLine: 301 } }]);
		},
		(request) => {
			assert.match(output(request, "history-other-session").content, /HISTORICAL_MIDDLE=archived-version/);
			assert.doesNotMatch(output(request, "history-other-session").content, /CURRENT_MIDDLE/);
			assert.match(output(request, "current-log").content, /CURRENT_MIDDLE=live-version/); return reply();
		},
	]);
	const s2 = f.session(second);
	const result2 = await s2.agent.run("Reuse checked notes and the saved lookup, distinguishing archived output from current files.");
	assert.equal(result2.status, "completed", result2.reason);
	assert.equal(completed(s2.events, "reuse-method").details.replayed, true);
	assert.deepEqual(completed(s2.events, "query-valid").details.valid, [memoryId]);
	assert.equal(completed(s2.events, "history-other-session").details.kind, "raw");
	assert.notEqual(result1.sessionId, result2.sessionId);

	// The cited line and fact value remain identical. Only one registered dependency changes.
	const evidenceLine = readFileSync(join(f.workspace, "package.json"), "utf8").split("\n")[1];
	writeFileSync(join(f.workspace, "settings.json"), '{"runner":"current","unrelated":true}\n');
	const third = new CheckedScript([
		(request) => {
			assert.doesNotMatch(request.system, /node --test integration\.test\.js/);
			assert.match(request.system, /dependency-changed/);
			return reply([{ id: "query-stale", name: "memory_query", args: { id: memoryId } }]);
		},
		(request) => {
			assert.match(output(request, "query-stale").content, /dependency-changed/);
			assert.doesNotMatch(output(request, "query-stale").content, /node --test integration\.test\.js/);
			return reply([{ id: "refresh-method", name: "query_recipe", args: { action: "replay", id: recipeId } }]);
		},
		(request) => {
			const content = output(request, "refresh-method").content;
			assert.match(content, /node --test integration\.test\.js[\s\S]*= "current"/);
			assert.doesNotMatch(content, /= "legacy"/);
			return reply([{ id: "fresh-source", name: "file_read", args: { path: "settings.json" } }]);
		},
		(request) => { assert.match(output(request, "fresh-source").content, /"runner":"current"/); return reply(); },
	]);
	const s3 = f.session(third);
	const result3 = await s3.agent.run("Recheck prior knowledge after configuration changes and read the current value.");
	assert.equal(result3.status, "completed", result3.reason);
	assert.deepEqual(completed(s3.events, "query-stale").details.valid, []);
	assert.deepEqual(completed(s3.events, "query-stale").details.stale, [{ id: memoryId, reasons: ["dependency-changed"] }]);
	assert.equal(completed(s3.events, "refresh-method").details.replayed, true);
	assert.equal(readFileSync(join(f.workspace, "package.json"), "utf8").split("\n")[1], evidenceLine);
	assert.notEqual(result2.sessionId, result3.sessionId);
	for (const events of [s1.events, s2.events, s3.events]) assert.ok(events.filter((event) => event.type === "tool.completed").every((event) => event.ok));

	// Changed applicability must reject the method instead of silently replaying it.
	const mode = statSync(f.workspace).mode & 0o777;
	chmodSync(f.workspace, mode ^ 0o020);
	const refused = new CheckedScript([
		() => reply([{ id: "inapplicable-method", name: "query_recipe", args: { action: "replay", id: recipeId } }]),
		(request) => {
			assert.match(output(request, "inapplicable-method").content, /no longer applies/);
			assert.doesNotMatch(output(request, "inapplicable-method").content, /node --test integration\.test\.js/);
			return reply([{ id: "replacement-plan", name: "query_plan", args: { steps: methodSteps } }]);
		},
		(request) => { assert.match(output(request, "replacement-plan").content, /= "current"/); return reply(); },
	]);
	try {
		const s4 = f.session(refused);
		assert.equal((await s4.agent.run("Rebuild a lookup whose environment has changed.")).status, "completed");
		assert.equal(completed(s4.events, "inapplicable-method").ok, false);
		assert.equal(completed(s4.events, "replacement-plan").ok, true);
	} finally { chmodSync(f.workspace, mode); }
});

test("an oversized initial context publishes no request and consumes no retry or budget", async (t) => {
	const f = fixture(t);
	const adapter = new ScriptedModelAdapter([reply()]);
	const { agent, events } = f.session(adapter, { masking: { enabled: false, triggerTokens: Infinity, keepRecentToolResults: 1, minBatchTokens: 0, hardLimitTokens: 100 } });
	const result = await agent.run("Necessary instructions must survive. ".repeat(1000));
	assert.equal(result.status, "limit");
	assert.match(result.reason, /CONTEXT_BUDGET_EXCEEDED/);
	assert.equal(adapter.requests.length, 0);
	assert.equal(result.totals.requests, 0);
	assert.equal(result.totals.cost, 0);
	assert.equal(events.some((event) => event.type === "model.request"), false);
	assert.equal(agent.builder.plan().revision, 0);
});

test("a rejected tool promise becomes a protected tool result and the real run continues", async (t) => {
	const f = fixture(t);
	const throwing: ToolDefinition = { name: "throwing_fixture", logicalName: "fixture.throw", description: "Fixture failure", parameters: { type: "object", additionalProperties: false }, readOnly: true, execute: async () => { throw new Error("injected tool exception"); } };
	writeFileSync(join(f.workspace, "large.txt"), "large successful output ".repeat(3000));
	const adapter = new CheckedScript([
		() => reply([{ id: "throws", name: throwing.name, args: {} }, { id: "large-read", name: "file_read", args: { path: "large.txt" } }]),
		(request) => {
			assert.match(output(request, "throws").content, /Tool failed: injected tool exception/);
			return reply();
		},
	]);
	const { agent, events } = f.session(adapter, { tools: [...defaultTools({ expand: true, read: { maxLineChars: 10_000 } }), throwing], masking: { enabled: true, triggerTokens: 1, keepRecentToolResults: 0, minBatchTokens: 0, hardLimitTokens: 100_000 } });
	const result = await agent.run("Handle the failed tool and continue.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(result.totals.requests, 2);
	assert.equal(completed(events, "throws").ok, false);
	assert.ok(events.some((event) => event.type === "context.revision"));
	assert.match(output(adapter.requests[1]!, "throws").content, /^Tool failed:/);
});

test("retry attempts count toward maxRequests before a third upstream request is sent", async (t) => {
	const f = fixture(t);
	const limited: RecordedResponse = { ...reply(), ok: false, finishReason: null, rawUsage: null, httpStatus: 429, error: { message: "fixture rate limit", retryable: true } };
	const adapter = new ScriptedModelAdapter([limited, limited, reply()]);
	const { agent, events, dataDir } = f.session(adapter, { limits: { maxRequests: 2, maxTurns: 10 }, retry: { maxAttempts: 6, baseDelayMs: 1 } });
	const result = await agent.run("A retry must use the same bounded request budget.");
	assert.equal(result.status, "limit");
	assert.match(result.reason, /上游请求上限 2/);
	assert.equal(adapter.requests.length, 2);
	assert.equal(adapter.remaining, 1);
	assert.equal(result.totals.requests, 2);
	assert.equal(result.turns, 1);
	assert.deepEqual(events.filter((event) => event.type === "model.request").map((event) => [event.attempt, event.isRetry]), [[1, false], [2, true]]);
	const ledger = readFileSync(join(dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(ledger.length, 2);
	assert.deepEqual(ledger.map((entry) => entry.isRetry), [false, true]);
});

test("a timed-out command exits, reports a failed tool, and allows the next model request", { timeout: 8000 }, async (t) => {
	const f = fixture(t);
	let childPid = 0;
	const adapter = new CheckedScript([
		() => reply([{ id: "timeout", name: "command_run", args: { argv: [process.execPath, "-e", "console.log('FIXTURE_PID='+process.pid);setInterval(()=>{},1000)"], timeoutMs: 1000 } }]),
		(request) => {
			const content = output(request, "timeout").content;
			assert.match(content, /timed out after 1000ms/);
			childPid = Number(/FIXTURE_PID=(\d+)/.exec(content)?.[1]);
			assert.ok(childPid > 0);
			assert.throws(() => process.kill(childPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
			return reply();
		},
	]);
	const { agent, events } = f.session(adapter);
	const result = await agent.run("A timed-out local tool must not leave its child running.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(result.totals.requests, 2);
	assert.equal(completed(events, "timeout").ok, false);
	assert.equal(completed(events, "timeout").details.timedOut, true);
});
