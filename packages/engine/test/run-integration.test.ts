import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineEvent, ToolMessage } from "@mountains/protocol";
import type { ModelRequest, ModelResponse, ModelStreamHandlers } from "@mountains/providers";
import { generalTools, type ToolDefinition } from "@mountains/tools";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

// Only model replies are scripted. Tool dispatch, files, archives and accounting
// all go through the real AgentSession.
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
	const base = mkdtempSync(join(tmpdir(), "mountains-run-integration-"));
	const workspace = join(base, "workspace"); mkdirSync(workspace);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	let count = 0;
	function session(adapter: ScriptedModelAdapter, extra: Partial<EngineOptions> = {}) {
		const dataDir = join(base, `session-${++count}`);
		const events: EngineEvent[] = [];
		const agent = new AgentSession({
			workspace, dataDir, adapter, model: "deepseek-flash", thinking: { enabled: true, effort: "high" }, maxTokens: 100,
			budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(base, "spend.jsonl") }), checkpoints: false,
			retry: { maxAttempts: 4, baseDelayMs: 1 }, limits: { maxRequests: 20, maxTurns: 20 }, systemPrompt: "Exercise the offline fixture tools.",
			archiveDir: join(base, "archive"),
			toolOptions: { batchEdit: true, read: { defaultLines: 4, maxLines: 8, maxLineChars: 400 } },
			onEvent: (event) => events.push(event), ...extra,
		});
		return { agent, events, dataDir };
	}
	return { base, workspace, session };
}
test("an oversized initial context publishes no request and consumes no retry or budget", async (t) => {
	const f = fixture(t);
	const adapter = new ScriptedModelAdapter([reply()]);
	const { agent, events } = f.session(adapter, { contextPolicy: { triggerTokens: Infinity, hardLimitTokens: 100, compactTokens: Infinity, compactTailTokens: 0, minBatchTokens: 0 } });
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
	const { agent, events } = f.session(adapter, { tools: [...generalTools({ read: { maxLineChars: 10_000 } }), throwing] });
	const result = await agent.run("Handle the failed tool and continue.");
	assert.equal(result.status, "completed", result.reason);
	assert.equal(result.totals.requests, 2);
	assert.equal(completed(events, "throws").ok, false);
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
