import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileSha256, ShadowCheckpoints } from "@mountains/checkpoints";
import { assertToolPairing } from "@mountains/context";
import type { EngineEvent, ToolCall } from "@mountains/protocol";
import { Recorder } from "@mountains/telemetry";
import { generalTools, type ToolResult } from "@mountains/tools";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

function reply(calls: ToolCall[] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "", toolCalls: calls },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash",
		rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
		httpStatus: 200, error: null, aborted: false };
}
const writeCall = (id: string): ToolCall => ({ id, name: "file_write", argumentsJson: JSON.stringify({ path: `${id}.txt`, content: `${id} completed\n` }) });
function fixture(t: TestContext, responses: RecordedResponse[], extra: Partial<EngineOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "mountains-tool-recording-recovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"); mkdirSync(workspace);
	const events: EngineEvent[] = [];
	const executed: { id: string; result: ToolResult }[] = [];
	const tools = generalTools().map(tool => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
		const result = await tool.execute(...args); executed.push({ id: args[1].toolCallId, result }); return result;
	} }));
	const adapter = new ScriptedModelAdapter(responses);
	const options: EngineOptions = { workspace, dataDir: join(root, "data"), archiveDir: join(root, "archive"), appDataDir: join(root, "appdata"),
		adapter, tools, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64,
		requestGuard: true, allowSessionSnapshots: true, checkpoints: true, retry: { maxAttempts: 1, baseDelayMs: 0 },
		budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(root, "spend.jsonl") }), limits: { maxCost: 2 }, onEvent: event => events.push(event), ...extra };
	const agent = new AgentSession(options);
	const recorder = (agent as unknown as { recorder: Recorder }).recorder;
	return { root, workspace, options, adapter, agent, recorder, events, executed };
}
function inject(f: ReturnType<typeof fixture>, fails: (kind: Parameters<Recorder["write"]>[0], data: unknown) => boolean) {
	const original = f.recorder.write;
	f.recorder.write = function (kind, data) {
		if (fails(kind, data)) throw new Error("EIO: synthetic recording write failure");
		return original.call(this, kind, data);
	};
	return () => { f.recorder.write = original; };
}
function toolResults(agent: AgentSession) {
	const messages = agent.builder.plan().messages;
	assertToolPairing(messages);
	return messages.filter(message => message.role === "tool");
}

for (const requestGuard of [false, true]) test(`completed file_write survives one-shot tool.output failure with requestGuard=${requestGuard}`, async t => {
	const f = fixture(t, [reply([writeCall("written")]), reply(), reply()], { requestGuard });
	let faults = 0;
	const restore = inject(f, kind => kind === "tool.output" && faults++ === 0);
	let summary;
	try { summary = await f.agent.run("Create written.txt once."); } finally { restore(); }
	assert.equal(summary.status, "failed", summary.reason); assert.match(summary.reason, /记录|录制/);
	assert.equal(f.adapter.requests.length, 1, "stop before another model request");
	assert.equal(readFileSync(join(f.workspace, "written.txt"), "utf8"), "written completed\n");
	assert.deepEqual(summary.filesChanged, ["written.txt"]);
	assert.deepEqual(summary.checkpoint?.changed, [{ status: "A", path: "written.txt" }]);
	assert.equal(f.events.filter(event => event.type === "run.completed").length, 1);
	assert.equal(f.events.find(event => event.type === "tool.completed")?.ok, true, "recording failure must not rewrite execution as failed");
	assert.equal(toolResults(f.agent)[0]!.content, f.executed[0]!.result.modelContent);
	const snapshot = f.agent.exportSnapshot();
	assert.equal((await f.agent.run("Continue after recording recovers.")).status, "completed");
	assertToolPairing(f.adapter.requests[1]!.messages);
	assert.equal(f.executed.length, 1, "continuation must never replay the completed write");
	assert.doesNotThrow(() => f.agent.exportSnapshot());
	const resumedAdapter = new ScriptedModelAdapter([reply()]);
	const resumed = new AgentSession({ ...f.options, sessionId: snapshot.sessionId, dataDir: join(f.root, "resumed"), adapter: resumedAdapter });
	resumed.restoreSnapshot(snapshot);
	assert.equal((await resumed.run("Resume the recovered snapshot.")).status, "completed");
	assertToolPairing(resumedAdapter.requests[0]!.messages); assert.equal(f.executed.length, 1);
	assert.ok(summary.checkpoint);
	const checkpoints = new ShadowCheckpoints(f.workspace, f.options.appDataDir!);
	assert.deepEqual(checkpoints.restore(summary.checkpoint.tree, ["written.txt"], { "written.txt": fileSha256(join(f.workspace, "written.txt")) }),
		{ restored: [], deleted: ["written.txt"], conflicts: [] });
});

for (const persistent of [false, true]) test(`recording failure after the second write closes the whole group, persistent=${persistent}`, async t => {
	const f = fixture(t, [reply([writeCall("first"), writeCall("second"), writeCall("third")]), reply()]);
	let failed = false;
	const restore = inject(f, (kind, data) => {
		if (kind === "tool.output" && (data as { toolCallId: string }).toolCallId === "second") { failed = true; return true; }
		return persistent && failed;
	});
	let summary;
	try { summary = await f.agent.run("Create the three files in order."); } finally { restore(); }
	assert.equal(summary.status, "failed", summary.reason); assert.deepEqual(f.executed.map(item => item.id), ["first", "second"]);
	assert.deepEqual(summary.filesChanged, ["first.txt", "second.txt"]);
	assert.deepEqual(summary.checkpoint?.changed, [{ status: "A", path: "first.txt" }, { status: "A", path: "second.txt" }]);
	assert.equal(existsSync(join(f.workspace, "third.txt")), false);
	const results = toolResults(f.agent);
	assert.deepEqual(results.map(message => message.toolCallId), ["first", "second", "third"]);
	for (let i = 0; i < 2; i++) assert.equal(results[i]!.content, f.executed[i]!.result.modelContent);
	assert.match(results[2]!.content, /未执行/);
	assert.equal(f.events.filter(event => event.type === "run.completed").length, 1, "outward completion survives a persistent recorder outage");
	assert.doesNotThrow(() => f.agent.exportSnapshot());
	assert.equal((await f.agent.run("Continue without repeating completed actions.")).status, "completed");
	assertToolPairing(f.adapter.requests[1]!.messages); assert.deepEqual(f.executed.map(item => item.id), ["first", "second"]);
});

for (const phase of ["input", "requested", "completed"] as const) test(`tool ${phase} recording failure preserves execution boundaries`, async t => {
	const f = fixture(t, [reply([writeCall("first"), writeCall("second")])]);
	let failed = false;
	const restore = inject(f, (kind, data) => {
		const event = data as { type?: string; toolCallId?: string };
		const matches = phase === "input" ? kind === "tool.input" : kind === "engine.event" && event.type === `tool.${phase}`;
		if (!failed && matches) { failed = true; return true; } return false;
	});
	let summary;
	try { summary = await f.agent.run("Respect recording boundaries."); } finally { restore(); }
	assert.equal(summary.status, "failed"); assert.deepEqual(f.executed.map(item => item.id), phase === "completed" ? ["first"] : []);
	const results = toolResults(f.agent); assert.equal(results.length, 2);
	if (phase === "completed") assert.equal(results[0]!.content, f.executed[0]!.result.modelContent);
	else assert.match(results[0]!.content, /未执行/);
	assert.match(results[1]!.content, /未执行/); assert.doesNotThrow(() => f.agent.exportSnapshot());
});

test("parallel read results settle before a failed run becomes idle", async t => {
	let releaseFirst!: () => void, releaseSecond!: () => void, entered!: () => void, faulted!: () => void;
	const first = new Promise<void>(resolve => { releaseFirst = resolve; });
	const second = new Promise<void>(resolve => { releaseSecond = resolve; });
	const started = new Promise<void>(resolve => { entered = resolve; });
	const fault = new Promise<void>(resolve => { faulted = resolve; });
	let executions = 0;
	const f = fixture(t, [reply(["first", "second"].map(id => ({ id, name: "context_expand", argumentsJson: "{}" }))), reply()], {
		tools: [{ name: "context_expand", logicalName: "fixture.read", description: "Offline read fixture", parameters: { type: "object" }, readOnly: true,
			async execute(_args, ctx) {
				if (++executions === 2) entered(); await (ctx.toolCallId === "first" ? first : second);
				return { ok: true, modelContent: `${ctx.toolCallId} actual result`, summary: "read", details: {} };
			} }],
	});
	const restore = inject(f, (kind, data) => {
		if (kind === "tool.output" && (data as { toolCallId: string }).toolCallId === "first") { faulted(); return true; } return false;
	});
	let settled = false;
	const running = f.agent.run("Read both fixtures.");
	void running.then(() => { settled = true; }, () => { settled = true; });
	try {
		await started; releaseFirst(); await fault; await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(settled, false, "do not clear activeRun while another launched tool is unfinished");
		assert.throws(() => f.agent.exportSnapshot(), /完整结束/); releaseSecond();
		assert.equal((await running).status, "failed");
		assert.deepEqual(toolResults(f.agent).map(message => message.content), ["first actual result", "second actual result"]);
		assert.doesNotThrow(() => f.agent.exportSnapshot());
	} finally { releaseFirst(); releaseSecond(); await running.catch(() => {}); restore(); }
	assert.equal((await f.agent.run("Continue after both results settled.")).status, "completed");
	assertToolPairing(f.adapter.requests[1]!.messages); assert.equal(executions, 2);
});

test("a real tool error remains exact when its output recording fails", async t => {
	const f = fixture(t, [reply([{ id: "missing", name: "file_read", argumentsJson: '{"path":"missing.txt"}' }])]);
	const restore = inject(f, kind => kind === "tool.output");
	let summary;
	try { summary = await f.agent.run("Read the missing file."); } finally { restore(); }
	assert.equal(summary.status, "failed"); assert.equal(f.executed[0]!.result.ok, false);
	assert.equal(toolResults(f.agent)[0]!.content, f.executed[0]!.result.modelContent); assert.doesNotThrow(() => f.agent.exportSnapshot());
});

test("an earlier unpaired terminal run cannot be dispatched by continuation", async t => {
	const f = fixture(t, [reply([writeCall("never")]), reply()], { requestGuard: false, limits: { maxOutputTokens: 1, maxCost: 2 } });
	assert.equal((await f.agent.run("Stop at the output token limit.")).status, "limit");
	assert.throws(() => f.agent.exportSnapshot(), /配|结果|pair/i);
	const summary = await f.agent.run("Do not send incomplete history.");
	assert.equal(summary.status, "limit"); assert.match(summary.reason, /CONTEXT_TOOL_PAIRING/);
	assert.equal(f.adapter.requests.length, 1); assert.equal(f.executed.length, 0);
});

test("no-fault multiple writes retain the ordinary completed flow", async t => {
	const f = fixture(t, [reply([writeCall("first"), writeCall("second")]), reply()]);
	assert.equal((await f.agent.run("Create both files.")).status, "completed");
	assert.deepEqual(f.executed.map(item => item.id), ["first", "second"]); assert.equal(f.adapter.requests.length, 2);
	assertToolPairing(f.adapter.requests[1]!.messages); assert.doesNotThrow(() => f.agent.exportSnapshot());
});

for (const phase of ["hashes", "completed"] as const) test(`final ${phase} recording failure retains checkpoint and coherent completion`, async t => {
	const f = fixture(t, [reply([writeCall("written")]), reply(), reply()]);
	const restore = inject(f, (kind, data) => phase === "hashes" ? kind === "file.hashes" : kind === "engine.event" && (data as { type: string }).type === "run.completed");
	let summary;
	try { summary = await f.agent.run("Finish the write even if final recording fails."); } finally { restore(); }
	assert.equal(summary.status, "failed"); assert.match(summary.reason, /记录|录制/);
	assert.deepEqual(summary.checkpoint?.changed, [{ status: "A", path: "written.txt" }]);
	const completed = f.events.filter(event => event.type === "run.completed");
	assert.equal(completed.length, 1); assert.equal(completed[0]!.status, summary.status); assert.equal(completed[0]!.reason, summary.reason);
	assert.equal(toolResults(f.agent)[0]!.content, f.executed[0]!.result.modelContent);
	assert.doesNotThrow(() => f.agent.exportSnapshot());
	assert.equal((await f.agent.run("Continue after final recording recovers.")).status, "completed");
	assert.equal(f.executed.length, 1); assertToolPairing(f.adapter.requests[2]!.messages);
});
