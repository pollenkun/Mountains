import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ChatCompletionsAdapter, type ModelAdapter, type ModelResponse } from "@mountains/providers";
import { AgentSession, BudgetGuard } from "../src/index.ts";

const usage = { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 2, total_tokens: 12 };
const event = (finish: string | null, withUsage: boolean) => `data: ${JSON.stringify({ id: "offline", model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", content: finish === "stop" ? "done" : "partial" }, finish_reason: finish }], ...(withUsage ? { usage } : {}) })}\n\n`;
const response = (text: string | ReadableStream<Uint8Array>) => new Response(text, { headers: { "content-type": "text/event-stream" } });
function failure(kind: "body" | "finish", withUsage: boolean): Response {
	if (kind === "finish") return response(event("network_error", withUsage) + "data: [DONE]\n\n");
	let sent = false;
	return response(new ReadableStream({ async pull(controller) {
		if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(event(null, withUsage))); }
		else { await setImmediate(); controller.error(new TypeError("offline connection reset")); }
	} }));
}
function fixture(t: TestContext, kind: "body" | "finish", withUsage: boolean, requestGuard: boolean, alwaysFail = false) {
	const root = mkdtempSync(join(tmpdir(), "mountains-provider-stream-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"); mkdirSync(workspace);
	let calls = 0; const responses: ModelResponse[] = [];
	const http = new ChatCompletionsAdapter({ baseUrl: "https://offline.invalid/v1", apiKey: "fixture-only", fetch: async () => ++calls === 1 || alwaysFail ? failure(kind, withUsage) : response(event("stop", true) + "data: [DONE]\n\n") });
	const adapter: ModelAdapter = { id: http.id, async complete(req, handlers) { const result = await http.complete(req, handlers); responses.push(result); return result; } };
	const budget = new BudgetGuard({ globalLimit: 100, ledgerPath: join(root, "spend.jsonl") });
	const session = new AgentSession({ workspace, dataDir: join(root, "data"), archiveDir: join(root, "archive"), adapter, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64, requestGuard, checkpoints: false, budget, limits: { maxTurns: 3, maxRequests: 5, maxCost: 10 }, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }, systemPrompt: "Offline fixture" });
	return { session, budget, calls: () => calls, responses, ledger: () => readFileSync(join(root, "data", "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

for (const kind of ["body", "finish"] as const) {
	for (const requestGuard of [false, true]) test(`AgentSession retries HTTP 200 ${kind} failure with complete usage (guard=${requestGuard})`, async t => {
		const f = fixture(t, kind, true, requestGuard); const result = await f.session.run("Reply done.");
		assert.equal(result.status, "completed", result.reason); assert.equal(f.calls(), 2); assert.equal(result.totals.requests, 2);
		assert.equal(f.responses[0]?.error?.retryable, true); assert.equal(result.totals.usagePartialRequests, 0);
		assert.equal(f.ledger().length, 2); assert(f.ledger().every(entry => entry.costPartial === false));
		const snapshot = f.budget.snapshot({ runId: result.runId }); assert.equal(snapshot.unknownCost, 0); assert.equal(snapshot.reserved, 0);
		assert.equal(snapshot.spent, result.totals.cost);
	});

	test(`AgentSession stops HTTP 200 ${kind} failure without usage under requestGuard`, async t => {
		const f = fixture(t, kind, false, true); const result = await f.session.run("Reply done.");
		assert.equal(f.responses[0]?.error?.retryable, true, "transport classification must stay separate from accounting permission");
		assert.equal(result.status, "limit"); assert.equal(f.calls(), 1); assert.equal(result.totals.requests, 1);
		assert.equal(result.totals.usagePartialRequests, 1); assert.equal(f.ledger()[0].costPartial, true);
		const snapshot = f.budget.snapshot({ runId: result.runId }); assert(snapshot.unknownCost > 0); assert.equal(snapshot.reserved, 0);
	});

	test(`AgentSession bounds repeated HTTP 200 ${kind} failures by maxAttempts`, async t => {
		const f = fixture(t, kind, true, true, true); const result = await f.session.run("Reply done.");
		assert.equal(result.status, "failed"); assert.equal(f.calls(), 3); assert.equal(result.totals.requests, 3);
	});
}

for (const raw of ['{"path": "雪.txt"}', '{"path":"unfinished', "null", "[]"]) {
	test(`AgentSession dispatches multiline tool arguments without repairing invalid JSON: ${JSON.stringify(raw)}`, async t => {
		const root = mkdtempSync(join(tmpdir(), "mountains-sse-tool-")); t.after(() => rmSync(root, { recursive: true, force: true }));
		const workspace = join(root, "workspace"); mkdirSync(workspace);
		let calls = 0; let executions = 0; const requests: string[] = [];
		const value = { id: "offline", model: "deepseek-flash", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tool", type: "function", function: { name: "context_expand", arguments: raw } }] }, finish_reason: "tool_calls" }], usage };
		const multiline = JSON.stringify(value, null, 2).split("\n").map(line => `data: ${line}\r\n`).join("") + "\r\ndata: [DONE]\r\n\r\n";
		const adapter = new ChatCompletionsAdapter({ baseUrl: "https://offline.invalid/v1", apiKey: "fixture-only", fetch: async (_input, init) => {
			requests.push(String(init?.body)); return response(++calls === 1 ? multiline : event("stop", true) + "data: [DONE]\n\n");
		} });
		const session = new AgentSession({ workspace, dataDir: join(root, "data"), archiveDir: join(root, "archive"), adapter,
			model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64, requestGuard: true, checkpoints: false,
			budget: new BudgetGuard({ globalLimit: 100, ledgerPath: join(root, "spend.jsonl") }), limits: { maxTurns: 3, maxRequests: 3, maxCost: 10 },
			tools: [{ name: "context_expand", logicalName: "fixture", description: "Offline read-only fixture", readOnly: true, parameters: { type: "object" },
				async execute(args) { executions++; assert.deepEqual(args, { path: "雪.txt" }); return { ok: true, modelContent: "read", summary: "read", details: {} }; } }],
		});
		const result = await session.run("Read the fixture.");
		assert.equal(result.status, "completed", result.reason); assert.equal(calls, 2);
		const valid = raw === '{"path": "雪.txt"}'; assert.equal(executions, valid ? 1 : 0);
		const replay = JSON.parse(requests[1]!) as { messages: { role: string; content: string }[] };
		assert(replay.messages.some(message => message.role === "tool" && (valid ? message.content.includes("read") : /JSON/.test(message.content))));
	});
}
