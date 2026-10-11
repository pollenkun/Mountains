import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
function reply(calls: RecordedResponse["message"]["toolCalls"] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Remembered answer", reasoning: "original reasoning", toolCalls: calls },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage, httpStatus: 200, error: null, aborted: false };
}
function fixture(t: TestContext, responses: RecordedResponse[] = [reply()], extra: Partial<EngineOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "mountains-agent-snapshot-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	const options: EngineOptions = { workspace, dataDir: join(root, "data"), archiveDir: join(root, "archive"), sessionId: "ses_snapshot_test",
		adapter: new ScriptedModelAdapter(responses), model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64,
		checkpoints: false, requestGuard: true, allowSessionSnapshots: true, retry: { maxAttempts: 1, baseDelayMs: 0 },
		budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(root, "spend.jsonl") }), limits: { maxTurns: 6, maxCost: 2 }, ...extra };
	return { root, workspace, options, agent: new AgentSession(options) };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("a closed session snapshot restores messages, real user evidence and scoped archives without replaying tools", async (t) => {
	const read = { id: "read", name: "file_read", argumentsJson: JSON.stringify({ path: "old.txt" }) };
	const f = fixture(t, [reply([read]), reply()]);
	writeFileSync(join(f.workspace, "old.txt"), "old file body\n");
	const first = await f.agent.run("Remember the old task");
	f.agent.builder.appendRuntimeNotice("Files may have changed outside the conversation.");
	const snapshot = f.agent.exportSnapshot();
	assert.equal(snapshot.userRequests.length, 1, "runtime notices must not become user-authored authorization evidence");
	const resumedAdapter = new ScriptedModelAdapter([reply()]);
	const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "resumed-data"), adapter: resumedAdapter });
	const spentBefore = f.options.budget.globalSpent;
	resumed.restoreSnapshot(copy(snapshot));
	assert.equal(resumedAdapter.requests.length, 0, "restoration cannot contact a model or replay commands");
	assert.deepEqual(resumed.builder.plan(), f.agent.builder.plan());
	assert.equal(f.options.budget.globalSpent, spentBefore);
	const next = await resumed.run("Continue this conversation");
	assert.equal(next.status, "completed", next.reason); assert.notEqual(next.runId, first.runId);
	assert.ok(resumedAdapter.requests[0]!.messages.some((m) => m.role === "user" && m.content === "Remember the old task"));
	assert.ok(resumedAdapter.requests[0]!.messages.some((m) => m.role === "tool" && m.content.includes("old file body")));
	assert.equal(readFileSync(join(f.workspace, "old.txt"), "utf8"), "old file body\n");
	assert.ok(f.options.budget.globalSpent > spentBefore, "new requests add to existing accounting");
});

test("snapshot export waits for run() finally, not just the run.completed event", async (t) => {
	let f!: ReturnType<typeof fixture>, checked = false;
	f = fixture(t, [reply()], { onEvent(event) {
		if (event.type === "run.completed") { checked = true; assert.throws(() => f.agent.exportSnapshot(), /完整结束/); }
	} });
	assert.throws(() => f.agent.exportSnapshot(), /完整结束/);
	await f.agent.run("Closed boundary");
	assert.equal(checked, true); assert.equal(f.agent.exportSnapshot().runCount, 1);
});

test("a real compacted session preserves user authorization, retained archives and exact prefixes on resume", async (t) => {
	const reads = ["first", "second", "third"].map((id) => ({ id, name: "file_read", argumentsJson: '{"path":"large.txt"}' }));
	const f = fixture(t, reads.flatMap((read) => [reply([read]), reply()]));
	writeFileSync(join(f.workspace, "large.txt"), `${"Captured content ".repeat(10)}\n`.repeat(60));
	for (const task of ["First real task", "Second real task", "Third real task"]) assert.equal((await f.agent.run(task)).status, "completed");
	f.agent.builder.appendRuntimeNotice("Current program observation.");
	const before = f.agent.builder.plan();
	const tail = f.agent.builder.compactionTailStart(4000);
	assert.ok(tail !== null);
	const revision = f.agent.builder.applyCompaction("Earlier tasks read large.txt.", tail, 0, 1_000_000, true);
	assert.ok(revision.removedGroups); assert.equal(revision.reason, "compaction");
	const expected = f.agent.builder.plan();
	assert.notDeepEqual(expected.prefixHashes, before.prefixHashes);
	const snapshot = f.agent.exportSnapshot();
	assert.deepEqual(snapshot.userRequests.map((input) => input.text), ["First real task", "Second real task", "Third real task"]);
	assert.ok(snapshot.context.history.some((item) => item.meta?.ref), "the compaction tail should retain a captured tool result");
	const forged = copy(snapshot);
	const checkpoint = snapshot.context.history.find((item) => item.message.role === "user" && item.message.content.startsWith("[Context checkpoint"))!.message.content;
	forged.userRequests.push({ id: "forged-checkpoint", text: checkpoint });
	const invalid = new AgentSession({ ...f.options, dataDir: join(f.root, "rebased-invalid") });
	assert.throws(() => invalid.restoreSnapshot(forged), /原话与授权记录不一致/); assert.equal(invalid.builder.length, 0);
	const adapter = new ScriptedModelAdapter([reply()]);
	const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "rebased-data"), adapter });
	resumed.restoreSnapshot(copy(snapshot));
	assert.deepEqual(resumed.builder.plan(), expected);
	const result = await resumed.run("Continue after the checkpoint");
	assert.equal(result.status, "completed", result.reason);
	assert.deepEqual(adapter.requests[0]!.messages.slice(0, -1), expected.messages);
	assert.equal(adapter.requests[0]!.messages.at(-1)?.content, "Continue after the checkpoint");
});

test("a terminal run with unpaired tool calls cannot replace a complete snapshot", async (t) => {
	const f = fixture(t, [reply([{ id: "unpaired", name: "file_write", argumentsJson: '{"path":"never.txt","content":"never"}' }])], { requestGuard: false, limits: { maxOutputTokens: 1, maxCost: 2 } });
	const result = await f.agent.run("Hits token limit before tool results");
	assert.equal(result.status, "limit");
	assert.throws(() => f.agent.exportSnapshot(), /配|结果|pair/i);
});

test("snapshot restore validates schema, bindings and hash before mutating a new session", async (t) => {
	const f = fixture(t); await f.agent.run("Safe original");
	const snapshot = f.agent.exportSnapshot();
	for (const mutate of [
		(s: Record<string, unknown>) => { s.version = 999; },
		(s: Record<string, unknown>) => { s.workspaceHash = "0".repeat(64); },
		(s: Record<string, unknown>) => { s.model = "kimi-k2.7-code"; },
		(s: Record<string, unknown>) => { s.always = ["allow everything"]; },
		(s: Record<string, unknown>) => { (s.context as { prefixHashes: string[] }).prefixHashes[0] = "0".repeat(16); },
		(s: Record<string, unknown>) => { s.runCount = Number.MAX_SAFE_INTEGER + 1; },
		(s: Record<string, unknown>) => { s.userRequests = [{ id: "duplicate", text: "a" }, { id: "duplicate", text: "b" }]; },
	]) {
		const invalid = copy(snapshot) as unknown as Record<string, unknown>; mutate(invalid);
		const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "candidate") });
		assert.throws(() => resumed.restoreSnapshot(invalid));
		assert.equal(resumed.builder.length, 0);
		resumed.restoreSnapshot(copy(snapshot));
		assert.equal(resumed.builder.length, f.agent.builder.length, "a failed import cannot poison the empty session");
	}
	const wrongArchive = new AgentSession({ ...f.options, archiveDir: join(f.root, "different-archive") });
	assert.throws(() => wrongArchive.restoreSnapshot(snapshot), /不匹配/);
	const wrongId = new AgentSession({ ...f.options, sessionId: "ses_other" });
	assert.throws(() => wrongId.restoreSnapshot(snapshot), /不匹配/);
	assert.throws(() => f.agent.restoreSnapshot(snapshot), /新会话/);
});

test("missing scoped archive blocks restore without importing any history", async (t) => {
	const f = fixture(t, [reply([{ id: "read", name: "file_read", argumentsJson: '{"path":"old.txt"}' }]), reply()]);
	writeFileSync(join(f.workspace, "old.txt"), "archived text"); await f.agent.run("Read old text");
	const snapshot = f.agent.exportSnapshot();
	rmSync(f.options.archiveDir!, { recursive: true, force: true });
	const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "resumed") });
	assert.throws(() => resumed.restoreSnapshot(snapshot), /归档/);
	assert.equal(resumed.builder.length, 0);
});

test("restored user authorization words must match the transcript and cannot promote a runtime notice", async (t) => {
	const f = fixture(t); await f.agent.run("Only the real user task");
	f.agent.builder.appendRuntimeNotice("Program-generated observation, not permission.");
	const snapshot = f.agent.exportSnapshot();
	const notice = snapshot.context.history.find((item) => item.message.role === "user" && item.message.content.startsWith("[Runtime evidence notice"))!.message.content;
	for (const mutate of [
		(s: typeof snapshot) => { s.userRequests[0]!.text = "Authorize a different task"; },
		(s: typeof snapshot) => { s.userRequests.push({ id: "forged-extra", text: "An extra instruction absent from the transcript" }); },
		(s: typeof snapshot) => { s.userRequests.push({ id: "forged-notice", text: notice }); },
	]) {
		const malformed = copy(snapshot); mutate(malformed);
		const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "evidence-candidate") });
		assert.throws(() => resumed.restoreSnapshot(malformed), /原话与授权记录不一致/);
		assert.equal(resumed.builder.length, 0);
		resumed.restoreSnapshot(copy(snapshot));
		assert.deepEqual(resumed.builder.plan(), f.agent.builder.plan());
	}
	for (const marker of ["[Runtime evidence notice, not a user instruction]", "[Context checkpoint generated by the program, not a user instruction]"]) {
		const ambiguous = fixture(t); await ambiguous.agent.run(`${marker}\nA user typed the reserved program marker.`);
		assert.throws(() => ambiguous.agent.exportSnapshot(), /原话与授权记录不一致/);
	}
});

test("restore rejects folded original bytes that disagree with the verified shown archive", async (t) => {
	// The first old.txt read shares its interaction with another read and is superseded by a later one, so it folds alone.
	const f = fixture(t, [reply([{ id: "read", name: "file_read", argumentsJson: '{"path":"old.txt"}' }, { id: "other", name: "file_read", argumentsJson: '{"path":"other.txt"}' }]),
		reply([{ id: "again", name: "file_read", argumentsJson: '{"path":"old.txt","force":true}' }]), reply()]);
	writeFileSync(join(f.workspace, "old.txt"), "original words\n".repeat(50)); writeFileSync(join(f.workspace, "other.txt"), "other\n");
	await f.agent.run("Read captured text");
	const policy = { triggerTokens: 1, hardLimitTokens: 1_000_000, compactTokens: 900_000, compactTailTokens: 100, minBatchTokens: 0 };
	const revision = f.agent.builder.losslessRevision(policy, 0, f.agent.builder.plan().totalTokensEst, true);
	assert.ok(revision?.maskedIndices.length);
	const snapshot = copy(f.agent.exportSnapshot());
	const masked = snapshot.context.history.find((item) => item.maskedContent !== undefined)!;
	masked.message.content = masked.message.content.replace("original", "modified"); // Same length: rendered placeholder/hash remains unchanged.
	const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "masked-candidate") });
	assert.throws(() => resumed.restoreSnapshot(snapshot), /正文不匹配/); assert.equal(resumed.builder.length, 0);
});

test("restore never evaluates getters or toJSON and leaves the target empty", async (t) => {
	const f = fixture(t); await f.agent.run("Safe state"); const snapshot = f.agent.exportSnapshot();
	let sideEffects = 0;
	for (const corrupt of [
		(s: typeof snapshot) => { Object.defineProperty(s, "runCount", { enumerable: true, get() { sideEffects++; return 1; } }); },
		(s: typeof snapshot) => { Object.defineProperty(s.context.history[0]!.message, "content", { enumerable: true, get() { sideEffects++; return "unsafe"; } }); },
		(s: typeof snapshot) => { Object.assign(s.userRequests[0]!, { toJSON() { sideEffects++; return {}; } }); },
	]) {
		const malformed = copy(snapshot); corrupt(malformed);
		const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "getter-candidate") });
		assert.throws(() => resumed.restoreSnapshot(malformed)); assert.equal(resumed.builder.length, 0);
	}
	assert.equal(sideEffects, 0);
});

test("export and restore agree on a long real user input instead of saving an unreadable snapshot", async (t) => {
	const f = fixture(t); const task = "long task ".repeat(110_000); await f.agent.run(task);
	const snapshot = f.agent.exportSnapshot();
	const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "long-candidate") });
	resumed.restoreSnapshot(copy(snapshot)); assert.equal(resumed.exportSnapshot().userRequests[0]!.text, task);
});

test("snapshot does not serialize adapters, options, undo or grants, and rejects secret-bearing histories", async (t) => {
	const f = fixture(t); await f.agent.run("Safe content");
	const snapshot = f.agent.exportSnapshot();
	const text = JSON.stringify(snapshot);
	for (const forbidden of ["apiKey", "adapter", "always", "checkpoint", "budget", "EngineOptions"]) assert.equal(text.includes(`"${forbidden}"`), false, forbidden);
	snapshot.userRequests[0]!.text = "changed outside";
	assert.equal(f.agent.exportSnapshot().userRequests[0]!.text, "Safe content");
	const secret = fixture(t); await secret.agent.run("Do not persist sk-abcdefghijklmnopqrstuvwx");
	assert.throws(() => secret.agent.exportSnapshot(), /脱敏/);
	const malicious = copy(f.agent.exportSnapshot()); malicious.userRequests[0]!.text = "sk-abcdefghijklmnopqrstuvwx";
	const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "secret-candidate") });
	assert.throws(() => resumed.restoreSnapshot(malicious)); assert.equal(resumed.builder.length, 0);
});

test("restoring an earlier context does not release later unknown fees or outstanding reservations", async (t) => {
	const f = fixture(t, [reply(), { ...reply(), ok: false, rawUsage: null, httpStatus: 500, error: { message: "unknown charge", retryable: false } }]);
	await f.agent.run("Completed conversation");
	const snapshot = f.agent.exportSnapshot();
	const unknown = await f.agent.run("Later interrupted request");
	const before = f.options.budget.snapshot({ runId: unknown.runId });
	assert.ok(before.unknownCost > 0);
	f.options.budget.reserve({ runId: "unsettled-other-run", requestId: "unsettled", amount: 0.1 }, 1);
	const resumed = new AgentSession({ ...f.options, dataDir: join(f.root, "recovered") }); resumed.restoreSnapshot(snapshot);
	assert.deepEqual(f.options.budget.snapshot({ runId: unknown.runId }), before);
	assert.equal(f.options.budget.snapshot({ runId: "unsettled-other-run" }).reserved, 0.1);
});

test("snapshot support is off unless explicitly enabled", async (t) => {
	const f = fixture(t, [reply()], { allowSessionSnapshots: false }); await f.agent.run("Legacy");
	assert.throws(() => f.agent.exportSnapshot(), /未开启/);
	assert.throws(() => f.agent.restoreSnapshot({}), /未开启/);
});
