import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import type { ModelAdapter, ModelResponse } from "@mountains/providers";
import { AgentSession } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";
import { ScriptedModelAdapter, type RecordedResponse } from "../src/replay.ts";
import { validateApprovalSettings } from "../src/approval-settings.ts";
import type { ApprovalEvidence } from "../src/model-approval.ts";

const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
function reply(write = false): RecordedResponse {
	return {
		ok: true,
		message: {
			role: "assistant", content: write ? "" : "Done.", reasoning: "",
			toolCalls: write ? [{ id: "write", name: "file_write", argumentsJson: JSON.stringify({ path: "new.txt", content: "must-not-write-after-revocation" }) }] : [],
		},
		finishReason: write ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage,
		httpStatus: 200, error: null, aborted: false,
	};
}
function allow(evidence: ApprovalEvidence): ModelResponse {
	return {
		...reply(),
		message: {
			role: "assistant", reasoning: "", toolCalls: [],
			content: JSON.stringify({ decision: "allow", authorization: [{ requestId: evidence.userRequests[0]!.id, quote: evidence.userRequests[0]!.text }] }),
		},
		responseId: null, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 110, partial: false },
		requestBody: null, startedAt: Date.now(), firstByteAt: Date.now(), finishedAt: Date.now(), retryAfterMs: null,
	};
}

for (const pauseAt of ["main-model", "approval-model"] as const) {
	test(`new input revokes an old run while waiting for ${pauseAt}; a late allow cannot write`, { timeout: 5000 }, async (t) => {
		const base = mkdtempSync(join(tmpdir(), "mountains-approval-revocation-"));
		t.after(() => rmSync(base, { recursive: true, force: true }));
		const workspace = join(base, "work"); mkdirSync(workspace);
		let entered!: () => void;
		let release!: () => void;
		const arrival = new Promise<void>((resolve) => { entered = resolve; });
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const scripted = new ScriptedModelAdapter([reply(true), reply()]);
		let firstMain = true;
		const main: ModelAdapter = {
			id: "offline-main-with-revocation-window",
			async complete(request, handlers) {
				if (firstMain && pauseAt === "main-model") { firstMain = false; entered(); await pending; }
				return scripted.complete(request, handlers);
			},
		};
		let judgeRequests = 0;
		const judge: ModelAdapter = {
			id: "offline-late-allow",
			async complete(request) {
				judgeRequests++;
				const evidence = JSON.parse(request.messages[0]!.content) as ApprovalEvidence;
				if (pauseAt === "approval-model") { entered(); await pending; }
				return allow(evidence);
			},
		};
		const settings = validateApprovalSettings({
			model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_OFFLINE_APPROVAL_KEY", profile: "deepseek",
			thinking: { enabled: false, effort: "default" }, maxTokens: 64, maxInputChars: 20_000,
			timeoutMs: 1000, maxRequests: 10, maxDenials: 3, maxCost: 0.25,
			pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "offline-test" },
		}, "USD");
		const events: EngineEvent[] = [];
		const agent = new AgentSession({
			workspace, dataDir: join(base, "data"), adapter: main, model: "deepseek-flash",
			thinking: { enabled: true, effort: "high" }, maxTokens: 64, checkpoints: false,
			budget: new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: join(base, "spend.jsonl") }),
			retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 8, maxRequests: 8, maxCost: 1 },
			modelApproval: { settings, adapter: judge }, onEvent: event => events.push(event),
		});
		const running = agent.run("Create new.txt with the requested contents.");
		await arrival;
		const overlapping = await agent.run("Stop. I revoke permission to write any files.").then(
			() => ({ rejected: false, reason: "" }),
			(error: Error) => ({ rejected: true, reason: error.message }),
		);
		release();
		const result = await running;
		assert.equal(overlapping.rejected, true, "the session must not start a second overlapping run");
		assert.match(overlapping.reason, /正在运行/);
		assert.equal(result.status, "limit", result.reason);
		assert.match(result.reason, /用户已发来新指令/);
		assert.equal(existsSync(join(workspace, "new.txt")), false, "revocation must prevent the actual file write");
		assert.equal(events.some(event => event.type === "tool.completed" && event.tool === "file_write" && event.ok), false);
		assert.equal(judgeRequests, pauseAt === "main-model" ? 0 : 1);
		assert.equal(scripted.requests.length, 1, "the revoked run must not call the main model again");
	});
}

test("revocation on the allow event blocks the real write before tool execution", { timeout: 5000 }, async (t) => {
	const base = mkdtempSync(join(tmpdir(), "mountains-approval-final-revocation-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "work"); mkdirSync(workspace);
	const main = new ScriptedModelAdapter([reply(true), reply()]);
	let judgeRequests = 0;
	const judge: ModelAdapter = {
		id: "offline-immediate-allow",
		async complete(request) {
			judgeRequests++;
			return allow(JSON.parse(request.messages[0]!.content) as ApprovalEvidence);
		},
	};
	const settings = validateApprovalSettings({
		model: "deepseek-flash", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_OFFLINE_APPROVAL_KEY", profile: "deepseek",
		thinking: { enabled: false, effort: "default" }, maxTokens: 64, maxInputChars: 20_000,
		timeoutMs: 1000, maxRequests: 10, maxDenials: 3, maxCost: 0.25,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1, version: "offline-test" },
	}, "USD");
	const events: EngineEvent[] = [];
	const revocation: { result?: Promise<{ rejected: boolean; reason: string }> } = {};
	let agent!: AgentSession;
	agent = new AgentSession({
		workspace, dataDir: join(base, "data"), adapter: main, model: "deepseek-flash",
		thinking: { enabled: true, effort: "high" }, maxTokens: 64, checkpoints: false,
		budget: new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: join(base, "spend.jsonl") }),
		retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 8, maxRequests: 8, maxCost: 1 },
		modelApproval: { settings, adapter: judge },
		onEvent(event) {
			events.push(event);
			if (event.type === "approval.resolved" && event.decision === "allow") {
				revocation.result = agent.run("Stop. I revoke permission to write any files.").then(
					() => ({ rejected: false, reason: "" }),
					(error: Error) => ({ rejected: true, reason: error.message }),
				);
			}
		},
	});
	const result = await agent.run("Create new.txt with the requested contents.");
	assert.ok(revocation.result, "the test must revoke after receiving an actual allow event");
	const overlapping = await revocation.result;
	assert.equal(overlapping.rejected, true);
	assert.match(overlapping.reason, /正在运行/);
	assert.equal(result.status, "limit", result.reason);
	assert.match(result.reason, /用户已发来新指令/);
	assert.equal(existsSync(join(workspace, "new.txt")), false, "a late revocation must still prevent the real write");
	assert.equal(events.some(event => event.type === "tool.completed" && event.tool === "file_write" && event.ok), false);
	assert.equal(judgeRequests, 1);
	assert.equal(main.requests.length, 1);
});
