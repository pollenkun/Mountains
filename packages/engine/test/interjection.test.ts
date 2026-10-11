import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertToolPairing } from "@mountains/context";
import { isValidEvent, PROTOCOL_VERSION, type EngineEvent } from "@mountains/protocol";
import type { ModelAdapter, ModelRequest } from "@mountains/providers";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, validateApprovalSettings, type EngineOptions, type RecordedResponse } from "../src/index.ts";

const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
const write = (id: string, path = `${id}.txt`) => ({ id, name: "file_write", argumentsJson: JSON.stringify({ path, content: id }) });
function reply(calls: RecordedResponse["message"]["toolCalls"] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "kept reasoning", toolCalls: calls },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage, httpStatus: 200, error: null, aborted: false };
}
function gate<T>() {
	let release!: (value: T) => void;
	const pending = new Promise<T>((resolve) => { release = resolve; });
	return { pending, release };
}
function fixture(t: TestContext, responses: RecordedResponse[], extra: Partial<EngineOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "mountains-interjection-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	const events: EngineEvent[] = [];
	const scripted = new ScriptedModelAdapter(responses);
	const agent = new AgentSession({ workspace, dataDir: join(root, "data"), adapter: scripted, model: "deepseek-flash",
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, checkpoints: false, requestGuard: true,
		budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(root, "spend.jsonl") }),
		retry: { maxAttempts: 2, baseDelayMs: 0 }, limits: { maxTurns: 6, maxRequests: 8, maxCost: 2 },
		approval: { rules: [], fallback: "ask" }, toolOptions: { approveFileWrites: true }, allowInterjection: true,
		...extra, onEvent(event) { events.push(event); extra.onEvent?.(event); },
	});
	return { root, workspace, agent, events, scripted };
}

test("runtime input preserves the streaming run, revokes old writes and reaches the next request in FIFO order", async (t) => {
	const entered = gate<void>(), release = gate<void>();
	const seen: ModelRequest[] = [];
	let approvals = 0;
	const f = fixture(t, [reply([write("old")]), reply([write("new")]), reply()], { askApproval: async () => { approvals++; return "allow"; } });
	f.agent.options.adapter = { id: "deferred-stream", async complete(req, handlers) {
		seen.push(req);
		if (seen.length === 1) { handlers?.onText?.("stream"); entered.release(); await release.pending; }
		return f.scripted.complete(req, handlers);
	} };
	const running = f.agent.run("Original task");
	await entered.pending;
	const a = f.agent.interject("First adjustment"), b = f.agent.interject("Second adjustment");
	assert.equal(a.accepted, true); assert.equal(b.accepted, true);
	assert.equal(seen[0]!.signal?.aborted, false);
	release.release();
	const summary = await running;
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(existsSync(join(f.workspace, "old.txt")), false);
	assert.equal(readFileSync(join(f.workspace, "new.txt"), "utf8"), "new");
	assert.equal(approvals, 1, "only the newly proposed operation can request permission");
	assert.equal(seen.length, 3);
	assertToolPairing(seen[1]!.messages);
	assert.deepEqual(seen[1]!.messages.filter((m) => m.role === "user" && !m.content.startsWith("[Runtime evidence notice")).map((m) => m.content), ["Original task", "First adjustment", "Second adjustment"]);
	assert.equal(f.events.filter((e) => e.type === "run.started").length, 1);
	const request = f.events.find((e) => e.type === "model.request" && e.interjectionIds?.length);
	assert.ok(request?.type === "model.request");
	assert.deepEqual(request.interjectionIds, [a.accepted ? a.id : "", b.accepted ? b.id : ""]);
	for (const event of f.events) { assert.equal(isValidEvent(event), true); assert.equal(event.protocolVersion, PROTOCOL_VERSION); }
});

test("input arriving during a final answer continues the same run instead of being dropped", async (t) => {
	const entered = gate<void>(), release = gate<void>();
	const f = fixture(t, [reply(), reply()]);
	let calls = 0;
	f.agent.options.adapter = { id: "deferred-final", async complete(req, handlers) {
		if (++calls === 1) { entered.release(); await release.pending; }
		return f.scripted.complete(req, handlers);
	} };
	const running = f.agent.run("First question"); await entered.pending;
	assert.equal(f.agent.interject("Follow-up question").accepted, true); release.release();
	assert.equal((await running).status, "completed");
	assert.equal(calls, 2);
	assert.equal(f.scripted.requests[1]!.messages.at(-1)?.content, "Follow-up question");
});

test("an already spawned command finishes before interjection is delivered", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
	const script = 'const fs=require("node:fs");fs.writeFileSync("started.txt","started");const timer=setInterval(()=>{if(fs.existsSync("release.txt")){clearInterval(timer);fs.writeFileSync("completed.txt","completed");}},10);';
	const call = { id: "running-command", name: "command_run", argumentsJson: JSON.stringify({ argv: [process.execPath, "-e", script], timeoutMs: 2000 }) };
	const f = fixture(t, [reply([call]), reply()], { askApproval: async () => "allow" });
	const running = f.agent.run("Run the local command");
	for (let n = 0; n < 150 && !existsSync(join(f.workspace, "started.txt")); n++) await delay(10);
	assert.equal(existsSync(join(f.workspace, "started.txt")), true, "the real command must have started before input is sent");
	assert.equal(f.agent.interject("Continue after the current command").accepted, true);
	writeFileSync(join(f.workspace, "release.txt"), "release");
	const result = await running;
	assert.equal(result.status, "completed", result.reason);
	assert.equal(readFileSync(join(f.workspace, "completed.txt"), "utf8"), "completed");
	assert.ok(f.events.some((event) => event.type === "tool.completed" && event.toolCallId === call.id && event.ok));
	assert.equal(f.scripted.requests[1]!.messages.at(-1)?.content, "Continue after the current command");
});

for (const status of [429, 500]) test(`input received before an HTTP ${status} retry is replanned into that retry without another run`, async (t) => {
	const failure = { ...reply(), ok: false, httpStatus: status, error: { message: "retry locally", retryable: true } };
	let f!: ReturnType<typeof fixture>;
	f = fixture(t, [failure, reply()], { onEvent(event) {
		if (event.type === "error" && event.retryable) assert.equal(f.agent.interject("Apply on retry").accepted, true);
	} });
	const summary = await f.agent.run("Retry task");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(f.scripted.requests.length, 2);
	assert.equal(f.scripted.requests[1]!.messages.at(-1)?.content, "Apply on retry");
	const requests = f.events.filter((e) => e.type === "model.request");
	assert.equal(requests[1]?.isRetry, true);
	assert.equal(requests[1]?.interjectionIds?.length, 1);
});

test("input accepted by a context-revision callback is included before a retry receives an authorization epoch", async (t) => {
	const failure = { ...reply(), ok: false, httpStatus: 500, error: { message: "retry", retryable: true } };
	let f!: ReturnType<typeof fixture>;
	let first = false, second = false;
	const adjustment = `Large adjustment ${"A".repeat(45_000)}`;
	// The second read supersedes the first, so the retry after the adjustment folds it.
	const read = (id: string) => reply([{ id, name: "file_read", argumentsJson: '{"path":"large.txt","force":true}' }]);
	f = fixture(t, [read("large-read"), read("large-read-again"), failure, reply()], {
		contextPolicy: { triggerTokens: 18_000, hardLimitTokens: 100_000, compactTokens: 90_000, compactTailTokens: 10_000, minBatchTokens: 0 },
		toolOptions: { read: { defaultLines: 100, maxLines: 100 } }, onEvent(event) {
			if (event.type === "error" && event.retryable) { first = true; assert.equal(f.agent.interject(adjustment).accepted, true); }
			if (event.type === "context.revision" && first && !second) { second = true; assert.equal(f.agent.interject("Second adjustment during folding").accepted, true); }
		},
	});
	writeFileSync(join(f.workspace, "large.txt"), `${"X".repeat(300)}\n`.repeat(50));
	const result = await f.agent.run("Read then retry locally");
	assert.equal(result.status, "completed", result.reason); assert.equal(second, true, "a real fold must open this callback window");
	const users = f.scripted.requests.at(-1)!.messages.filter((m) => m.role === "user").map((m) => m.content);
	assert.ok(users.includes(adjustment)); assert.equal(users.at(-1), "Second adjustment during folding");
	const request = f.events.filter((e) => e.type === "model.request").at(-1);
	assert.equal(request?.interjectionIds?.length, 2);
});

test("input during human approval denies the current call, completes all tool pairs, then reaches the next request", async (t) => {
	const entered = gate<void>(), decision = gate<"allow" | "deny">();
	const f = fixture(t, [reply([write("one"), write("two")]), reply()], { askApproval: async () => { entered.release(); return decision.pending; } });
	const running = f.agent.run("Original writes"); await entered.pending;
	decision.release("deny"); // The caller resolves the displayed approval before accepting input.
	assert.equal(f.agent.interject("Do not write those files").accepted, true);
	const result = await running;
	assert.equal(result.status, "completed", result.reason);
	assert.equal(existsSync(join(f.workspace, "one.txt")), false); assert.equal(existsSync(join(f.workspace, "two.txt")), false);
	assertToolPairing(f.scripted.requests[1]!.messages);
	const denied = f.events.find((e) => e.type === "approval.resolved" && e.decision === "deny");
	const next = f.events.find((e) => e.type === "model.request" && e.interjectionIds?.length);
	assert.ok(denied && next && denied.seq < next.seq);
});

test("input at an allow event prevents the approved real file write", async (t) => {
	let f!: ReturnType<typeof fixture>;
	let injected = false;
	f = fixture(t, [reply([write("late")]), reply()], { askApproval: async () => "allow", onEvent(event) {
		if (!injected && event.type === "approval.resolved" && event.decision === "allow") { injected = true; assert.equal(f.agent.interject("Revoke just before writing").accepted, true); }
	} });
	assert.equal((await f.agent.run("Write late")).status, "completed");
	assert.equal(injected, true); assert.equal(existsSync(join(f.workspace, "late.txt")), false);
	assert.equal(f.events.some((e) => e.type === "tool.completed" && e.ok), false);
});

test("a late approval-model allow is accounted but cannot execute a superseded write", async (t) => {
	const entered = gate<void>(), release = gate<void>();
	const settings = validateApprovalSettings({ model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_TEST_KEY", profile: "deepseek",
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, maxInputChars: 50_000, timeoutMs: 3000, maxRequests: 4, maxDenials: 1, maxCost: 1,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "offline" } }, "USD");
	const judge: ModelAdapter = { id: "deferred-judge", async complete(req) {
		const evidence = JSON.parse(req.messages[0]!.content);
		entered.release(); await release.pending;
		const response = reply(); response.message.content = JSON.stringify({ decision: "allow", authorization: [{ requestId: evidence.userRequests[0].id, quote: evidence.userRequests[0].text }] });
		return new ScriptedModelAdapter([response]).complete(req);
	} };
	const f = fixture(t, [reply([write("judge")]), reply()], { modelApproval: { settings, adapter: judge } });
	const running = f.agent.run("Create judge.txt"); await entered.pending;
	assert.equal(f.agent.interject("Revoked while approval was running").accepted, true); release.release();
	const result = await running;
	assert.equal(result.status, "completed", result.reason);
	assert.equal(result.totals.approvalRequests, 1); assert.equal(result.totals.requests, 3);
	assert.equal(existsSync(join(f.workspace, "judge.txt")), false);
	assert.equal(f.events.some((e) => e.type === "approval.resolved" && e.decision === "allow"), false);
});

test("input at the approval request revokes an exact stored authorization without requesting a judge", async (t) => {
	const f = fixture(t, [reply([write("static")]), reply()]);
	const settings = validateApprovalSettings({ model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_TEST_KEY", profile: "deepseek",
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, maxInputChars: 50_000, timeoutMs: 3000, maxRequests: 4, maxDenials: 1, maxCost: 1,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "offline" },
		allowRules: [{ id: "exact-write", userRequest: "Create static.txt", tool: "file_write", cwd: f.workspace, arguments: { path: "static.txt", content: "static" } }] }, "USD");
	let injected = false;
	let agent!: AgentSession;
	agent = new AgentSession({ ...f.agent.options, modelApproval: { settings, adapter: { id: "unused-judge", async complete() { throw new Error("the judge must not be requested"); } } },
		onEvent(event) {
			f.events.push(event);
			if (!injected && event.type === "approval.requested") { injected = true; assert.equal(agent.interject("Do not use the old authorization").accepted, true); }
		},
	});
	const result = await agent.run("Create static.txt");
	assert.equal(result.status, "completed", result.reason); assert.equal(injected, true);
	assert.equal(result.totals.approvalRequests ?? 0, 0); assert.equal(existsSync(join(f.workspace, "static.txt")), false);
	assert.equal(f.events.some((e) => e.type === "approval.resolved" && e.decision === "allow"), false);
	assert.equal(f.scripted.requests[1]!.messages.at(-1)?.content, "Do not use the old authorization");
});

test("disabled runtime input adds no event fields, and existing overlapping run still aborts", async (t) => {
	const entered = gate<void>(), release = gate<void>();
	const f = fixture(t, [reply()], { allowInterjection: false });
	f.agent.options.adapter = { id: "legacy-overlap", async complete(req, handlers) { entered.release(); await release.pending; return f.scripted.complete(req, handlers); } };
	const running = f.agent.run("Original"); await entered.pending;
	assert.deepEqual(f.agent.interject("Ignored"), { accepted: false, reason: "disabled" });
	await assert.rejects(f.agent.run("Replacement"), /正在运行/);
	release.release(); const result = await running;
	assert.equal(result.status, "limit");
	assert.equal(f.scripted.requests[0]!.signal?.aborted, true);
	assert.ok(f.events.filter((e) => e.type === "model.request").every((e) => !Object.hasOwn(e, "interjectionIds")));
});

test("pending input is explicitly undelivered when a turn limit prevents another request", async (t) => {
	const entered = gate<void>(), release = gate<void>();
	const f = fixture(t, [reply()], { limits: { maxTurns: 1, maxCost: 1 } });
	f.agent.options.adapter = { id: "limited", async complete(req, handlers) { entered.release(); await release.pending; return f.scripted.complete(req, handlers); } };
	const running = f.agent.run("Original"); await entered.pending;
	assert.equal(f.agent.interject("Cannot send within this limit").accepted, true); release.release();
	const result = await running;
	assert.equal(result.status, "limit"); assert.match(result.reason, /插话未送达/);
	assert.equal(f.scripted.requests.length, 1);
	assert.equal(f.agent.builder.plan().messages.some((m) => m.content === "Cannot send within this limit"), false);
});

test("interjection rejects idle, invalid input, and unsupported exact preflight combination", async (t) => {
	const f = fixture(t, [reply()]);
	assert.deepEqual(f.agent.interject("Idle"), { accepted: false, reason: "idle" });
	assert.throws(() => new AgentSession({ ...f.agent.options, exactInputPreflight: true }), /插话暂不支持精确输入预检/);
	const entered = gate<void>(), release = gate<void>();
	f.agent.options.adapter = { id: "input-validation", async complete(req, handlers) { entered.release(); await release.pending; return f.scripted.complete(req, handlers); } };
	const running = f.agent.run("Original"); await entered.pending;
	assert.deepEqual(f.agent.interject(" "), { accepted: false, reason: "invalid-input" });
	assert.deepEqual(f.agent.interject("x".repeat(65_537)), { accepted: false, reason: "invalid-input" });
	release.release(); await running;
});
