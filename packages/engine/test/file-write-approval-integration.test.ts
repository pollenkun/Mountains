import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isValidEvent, type EngineEvent } from "@mountains/protocol";
import { sha256, type ApprovalRequest } from "@mountains/tools";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
function reply(calls: { id: string; name: string; args: Record<string, unknown> }[] = []): RecordedResponse {
	return {
		ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "", toolCalls: calls.map((call) => ({ id: call.id, name: call.name, argumentsJson: JSON.stringify(call.args) })) },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage, httpStatus: 200, error: null, aborted: false,
	};
}
const edits = [
	{ id: "single", name: "file_edit", args: { path: "single.txt", oldText: "alpha", newText: "甲", expectedHash: sha256("alpha\nbeta\n") } },
	{ id: "batch", name: "file_edit", args: { path: "batch.txt", edits: [{ oldText: "alpha", newText: "甲" }, { oldText: "beta", newText: "乙" }], expectedHash: sha256("alpha\nbeta\n") } },
	{ id: "create", name: "file_write", args: { path: "created.txt", content: "新建\n" } },
	{ id: "overwrite", name: "file_write", args: { path: "overwrite.txt", content: "覆盖\n", createOnly: false, expectedHash: sha256("alpha\nbeta\n") } },
];
function fixture(t: TestContext, extra: Partial<EngineOptions> = {}) {
	const base = mkdtempSync(join(tmpdir(), "mountains-file-approval-engine-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const workspace = join(base, "work"); mkdirSync(workspace);
	for (const name of ["single.txt", "batch.txt", "overwrite.txt"]) writeFileSync(join(workspace, name), "alpha\nbeta\n");
	const events: EngineEvent[] = [];
	const adapter = new ScriptedModelAdapter([reply(edits), reply()]);
	const agent = new AgentSession({
		workspace, dataDir: join(base, "data"), adapter, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 128,
		checkpoints: false, budget: new BudgetGuard({ globalLimit: 1, ledgerPath: join(base, "spend.jsonl") }),
		retry: { maxAttempts: 1, baseDelayMs: 0 }, approval: { rules: [], fallback: "ask" }, onEvent: (event) => events.push(event),
		toolOptions: { batchEdit: true }, ...extra,
	});
	return { agent, workspace, adapter, events };
}
function originals(workspace: string) {
	for (const name of ["single.txt", "batch.txt", "overwrite.txt"]) assert.equal(readFileSync(join(workspace, name), "utf8"), "alpha\nbeta\n");
	assert.equal(existsSync(join(workspace, "created.txt")), false);
}

test("EngineOptions keeps file approval off by default, even with an asking policy", async (t) => {
	const f = fixture(t, { askApproval: async () => { assert.fail("default file writes must not call the approval UI"); } });
	const summary = await f.agent.run("Apply the four scripted file changes.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(f.events.some((event) => event.type === "approval.requested"), false);
	assert.deepEqual(summary.filesChanged, ["single.txt", "batch.txt", "created.txt", "overwrite.txt"]);
});

for (const decision of ["allow", "deny"] as const) {
	test(`toolOptions.approveFileWrites passes ${decision} through the real engine for every file write path`, async (t) => {
		const requests: ApprovalRequest[] = [];
		const f = fixture(t, { toolOptions: { batchEdit: true, approveFileWrites: true }, askApproval: async (request) => { requests.push(request); return decision; } });
		const summary = await f.agent.run("Apply the four scripted file changes.");
		assert.equal(summary.status, "completed", summary.reason);
		assert.equal(requests.length, 4);
		assert.deepEqual(requests.map((request) => request.toolCallId), edits.map((call) => call.id));
		for (const [index, request] of requests.entries()) {
			const call = edits[index]!;
			assert.equal(request.command, `${call.name} ${JSON.stringify(call.args, null, 2)}`);
			assert.equal(request.risk, "workspace-write");
			assert.ok(request.explanation.includes(call.args.path));
		}
		for (const event of f.events) assert.equal(isValidEvent(event), true, event.type);
		const requested = f.events.filter((event) => event.type === "approval.requested");
		const resolved = f.events.filter((event) => event.type === "approval.resolved");
		assert.equal(requested.length, 4);
		assert.equal(resolved.length, 4);
		assert.ok(resolved.every((event) => event.type === "approval.resolved" && event.decision === decision));
		const results = f.events.filter((event) => event.type === "tool.completed");
		assert.equal(results.length, 4);
		assert.ok(results.every((event) => event.type === "tool.completed" && event.ok === (decision === "allow")));
		if (decision === "allow") {
			assert.equal(readFileSync(join(f.workspace, "single.txt"), "utf8"), "甲\nbeta\n");
			assert.equal(readFileSync(join(f.workspace, "batch.txt"), "utf8"), "甲\n乙\n");
			assert.equal(readFileSync(join(f.workspace, "created.txt"), "utf8"), "新建\n");
			assert.equal(readFileSync(join(f.workspace, "overwrite.txt"), "utf8"), "覆盖\n");
			assert.deepEqual(summary.filesChanged, ["single.txt", "batch.txt", "created.txt", "overwrite.txt"]);
		} else {
			originals(f.workspace);
			assert.deepEqual(summary.filesChanged, [], "denial must not add files to the checkpoint list");
		}
	});
}

test("engine cancellation during file approval cannot execute the late-approved write or later calls", async (t) => {
	let entered!: () => void;
	let release!: (decision: "allow") => void;
	const arrival = new Promise<void>((resolve) => { entered = resolve; });
	const pending = new Promise<"allow">((resolve) => { release = resolve; });
	const controller = new AbortController();
	let approvals = 0;
	const f = fixture(t, { toolOptions: { batchEdit: true, approveFileWrites: true }, askApproval: async () => { approvals++; entered(); return pending; } });
	const running = f.agent.run("Apply the four scripted file changes.", controller.signal);
	await arrival;
	originals(f.workspace);
	controller.abort();
	release("allow");
	const summary = await running;
	assert.equal(summary.status, "cancelled", summary.reason);
	assert.equal(approvals, 1);
	assert.equal(f.adapter.requests.length, 1);
	assert.deepEqual(summary.filesChanged, []);
	assert.equal(f.events.some((event) => event.type === "tool.completed" && event.ok), false);
	originals(f.workspace);
});
