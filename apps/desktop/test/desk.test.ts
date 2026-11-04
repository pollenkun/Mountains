import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EngineEvent } from "@mountains/protocol";
import { ShadowCheckpoints } from "@mountains/checkpoints";
import { createDesk } from "../src/main/desk.ts";
import type { EngineHost, HostOptions } from "../src/main/engine-host.ts";

function fakeHost() {
	const listeners = new Set<(event: EngineEvent) => void>();
	const commands: unknown[] = [];
	let seq = 1;
	const emit = (event: Record<string, unknown>) => {
		for (const listener of listeners) listener({ protocolVersion: "0.1.0", sessionId: "s", runId: "r", seq: seq++, eventId: `e${seq}`, time: new Date().toISOString(), ...event } as EngineEvent);
	};
	const host = {
		onEvent(listener: (event: EngineEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
		handleCommand(command: unknown) {
			commands.push(command);
			const c = command as { type?: string; task?: string };
			if (c.type === "run.start") emit({ type: "run.started", task: c.task });
		},
		choose() {},
		preferences() { return {}; },
		setPlan() {},
		async compact() { return { before: 100, after: 10 }; },
		async reload() {},
		async dispose() {},
	};
	return { host: host as unknown as EngineHost, commands, emit };
}

test("conversations keep their own session, list order, status and history across a restart", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-"));
	const made: ReturnType<typeof fakeHost>[] = [];
	const options = { dataDir, workspace: "/Users/me/Mountains", createHost: () => { const fake = fakeHost(); made.push(fake); return fake.host; } };
	const desk = createDesk(options);
	const seen: string[] = [];
	desk.onEvent((id, event) => seen.push(`${id}:${event.type}`));

	const a = desk.create(), b = desk.create();
	assert.equal(desk.command("c_000000000000", { type: "run.start", task: "x" }), false, "unknown conversation");
	assert.ok(desk.command(a.id, { protocolVersion: "0.1.0", type: "run.start", task: "把支付的测试跑一遍\n失败的修掉" }));
	assert.equal(made.length, 1, "a host is made on a conversation's first command");
	assert.equal(desk.list().find((c) => c.id === a.id)?.title, "把支付的测试跑一遍 失败的修掉");
	assert.equal(desk.list().find((c) => c.id === a.id)?.status, "running");
	made[0]!.emit({ type: "approval.requested", toolCallId: "t1", command: "git push", cwd: ".", risk: "dangerous", explanation: "" });
	assert.equal(desk.running()[0]?.status, "waiting");
	made[0]!.emit({ type: "run.completed", status: "completed", reason: "done", turns: 1, totals: { requests: 1, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } });
	assert.equal(desk.running().length, 0);
	assert.deepEqual(seen.filter((entry) => entry.startsWith(a.id)).map((entry) => entry.split(":")[1]), ["run.started", "approval.requested", "run.completed"]);

	desk.update(b.id, { pinned: true, title: "  给 API 加限流  " });
	assert.deepEqual(desk.list().map((c) => c.id), [b.id, a.id], "pinned first");

	const again = createDesk(options);
	assert.deepEqual(again.list().map((c) => [c.id, c.title]), [[b.id, "给 API 加限流"], [a.id, "把支付的测试跑一遍 失败的修掉"]]);
	assert.deepEqual(again.history(a.id).map((event) => event.type), ["run.started", "approval.requested", "run.completed"]);

	await again.remove(a.id);
	assert.equal(existsSync(join(dataDir, a.id)), false);
	assert.deepEqual(again.list().map((c) => c.id), [b.id]);
	await again.remove("../escape");
	assert.ok(existsSync(dataDir));
});

test("search finds a conversation by what was asked or answered, with the words around the hit", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-search-"));
	const made: ReturnType<typeof fakeHost>[] = [];
	const desk = createDesk({ dataDir, createHost: () => { const fake = fakeHost(); made.push(fake); return fake.host; } });
	const a = desk.create(), b = desk.create();
	desk.command(a.id, { type: "run.start", task: "重构支付回调" });
	made[0]!.emit({ type: "message.completed", turnId: "t", text: "Stripe 现在建议的时间容差是 5 分钟。旧代码里有两套校验，我把它们合成一个。", reasoningChars: 0, toolCalls: [] });
	desk.command(b.id, { type: "run.start", task: "给 API 加限流，突发流量的容差放宽一点" });
	const hits = desk.search("容差");
	const byTitle = new Map(hits.map((hit) => [hit.title, hit]));
	assert.equal(hits.length, 2);
	assert.equal(byTitle.get("给 API 加限流，突发流量的容差放宽一点")?.byUser, true);
	const reply = byTitle.get("重构支付回调")!;
	assert.equal(reply.byUser, false);
	assert.equal(reply.match, "容差");
	assert.equal(reply.before, "Stripe 现在建议的时间");
	assert.ok(reply.after.startsWith("是 5 分钟"));
	assert.deepEqual(desk.search("   "), []);
	assert.deepEqual(desk.search("不存在的词"), []);
});

test("a tool call's output is read back from the conversation's own run records", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-"));
	const desk = createDesk({ dataDir, createHost: () => fakeHost().host });
	const a = desk.create(), b = desk.create();
	mkdirSync(join(dataDir, a.id, "run-1"), { recursive: true });
	writeFileSync(join(dataDir, a.id, "run-1", "recording.jsonl"), [
		JSON.stringify({ kind: "tool.input", data: { toolCallId: "call_1", modelContent: "not this" } }),
		JSON.stringify({ kind: "tool.output", data: { toolCallId: "call_1", modelContent: "exit code 0\nhello" } }),
		"{\"kind\":\"tool.output\",\"data\":{\"toolCallId\":\"call_2\"",
	].join("\n"));
	assert.equal(desk.toolOutput(a.id, "call_1"), "exit code 0\nhello");
	assert.equal(desk.toolOutput(a.id, "call_2"), null, "a torn line is skipped");
	assert.equal(desk.toolOutput(b.id, "call_1"), null, "another conversation's records are not searched");
	assert.equal(desk.toolOutput("../x", "call_1"), null);
});

test("going back to a message keeps what came before it, sets the rest aside and restores the context then", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-rewind-"));
	const made: ReturnType<typeof fakeHost>[] = [];
	const desk = createDesk({ dataDir, workspace: dataDir, createHost: () => { const fake = fakeHost(); made.push(fake); return fake.host; } });
	const a = desk.create();
	const done = { type: "run.completed", status: "completed", reason: "", turns: 1, totals: { requests: 1, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } };
	desk.command(a.id, { type: "run.start", task: "第一条" });
	made[0]!.emit(done);
	writeFileSync(join(dataDir, a.id, "session.json"), "{\"after\":1}\n");
	desk.command(a.id, { type: "run.start", task: "第二条" });
	made[0]!.emit(done);
	const second = desk.history(a.id).filter((e) => e.type === "run.started")[1]!;
	const { events } = await desk.rewind(a.id, second.eventId, { files: false });
	assert.deepEqual(events.map((e) => e.type), ["run.started", "run.completed"]);
	assert.deepEqual(desk.history(a.id).map((e) => e.type === "run.started" ? e.task : e.type), ["第一条", "run.completed"]);
	assert.equal(readFileSync(join(dataDir, a.id, "session.json"), "utf8").trim(), "{\"after\":1}", "the context as it was before the second message");
	assert.equal(readdirSync(join(dataDir, a.id, "branches")).length, 1);
	await assert.rejects(desk.rewind(a.id, "no-such-run", { files: false }));
});

test("plan mode adds its note to what is sent; goal mode keeps going until the goal is met", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-modes-"));
	const made: ReturnType<typeof fakeHost>[] = [];
	const desk = createDesk({ dataDir, createHost: () => { const fake = fakeHost(); made.push(fake); return fake.host; } });
	const a = desk.create();
	desk.setPlan(a.id, true);
	desk.command(a.id, { type: "run.start", task: "改登录页" });
	assert.match((made[0]!.commands[0] as { task: string }).task, /^改登录页\n\n\[Plan mode/);
	desk.approvePlan(a.id);
	assert.equal(desk.list()[0]!.plan, undefined);
	assert.equal((made[0]!.commands[1] as { task: string }).task, "Go ahead with the plan.");
	const b = desk.create();
	desk.startGoal(b.id, "让测试全部通过");
	const host = made[1]!;
	const done = (text: string) => { host.emit({ type: "message.completed", turnId: "t", text, reasoningChars: 0, toolCalls: [] }); host.emit({ type: "run.completed", status: "completed", reason: "", turns: 1, totals: { requests: 1, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } }); };
	done("还差两个");
	done("GOAL MET");
	done("复查通过\nGOAL MET");
	const tasks = host.commands.map((c) => (c as { task: string }).task);
	assert.equal(tasks.length, 3);
	assert.match(tasks[0]!, /Goal mode/);
	assert.equal(desk.list().find((c) => c.id === b.id)!.goal!.status, "met");
});

test("a restore can be taken back, and nothing is written into the workspace", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-redo-")), workspace = mkdtempSync(join(tmpdir(), "mountains-desk-redo-ws-"));
	writeFileSync(join(workspace, "a.txt"), "one\n");
	let host!: ReturnType<typeof fakeHost>, onRun!: NonNullable<HostOptions["onRun"]>;
	const desk = createDesk({ dataDir, workspace, createHost: (options) => { host = fakeHost(); onRun = options.onRun!; return host.host; } });
	const a = desk.create();
	const outDir = join(dataDir, a.id, "run");
	const tree = new ShadowCheckpoints(workspace, join(outDir, "appdata")).snapshot().tree;
	desk.command(a.id, { type: "run.start", task: "改一下" });
	writeFileSync(join(workspace, "a.txt"), "two\n");
	onRun({ outDir, status: "completed", checkpoint: { tree, changed: [{ status: "M", path: "a.txt" }] } });
	host.emit({ type: "run.completed", status: "completed", reason: "", turns: 1, totals: { requests: 1, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } });
	assert.deepEqual(desk.changes(a.id).files, [{ path: "a.txt", added: 1, removed: 1 }]);
	assert.deepEqual(desk.restore(a.id, null), { restored: ["a.txt"], conflicts: [] });
	assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "one\n");
	assert.equal(desk.changes(a.id).canRedo, true);
	assert.deepEqual(desk.redo(a.id), { restored: ["a.txt"], conflicts: [] });
	assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "two\n");
	assert.equal(desk.changes(a.id).canRedo, false);
	assert.deepEqual(readdirSync(workspace), ["a.txt"], "the workspace holds only its own files");
});

test("streamed pieces reach the disk as one line, and only the latest points are kept", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-pieces-"));
	let host!: ReturnType<typeof fakeHost>;
	const desk = createDesk({ dataDir, createHost: () => { host = fakeHost(); return host.host; } });
	const a = desk.create();
	const finished = { type: "run.completed", status: "completed", reason: "", turns: 1, totals: { requests: 1, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } };
	const seen: string[] = [];
	desk.onEvent((_, event) => seen.push(event.type));
	desk.command(a.id, { protocolVersion: "0.1.0", type: "run.start", task: "写" });
	for (const text of ["一", "二", "三"]) host.emit({ type: "message.delta", turnId: "t", kind: "thinking", text });
	for (const text of ["甲", "乙"]) host.emit({ type: "message.delta", turnId: "t", kind: "text", text });
	host.emit(finished);
	assert.equal(seen.filter((type) => type === "message.delta").length, 5, "the page still gets every piece as it comes");
	assert.deepEqual(desk.history(a.id).flatMap((e) => e.type === "message.delta" ? [`${e.kind}:${e.text}`] : []), ["thinking:一二三", "text:甲乙"]);
	for (let i = 0; i < 45; i++) { desk.command(a.id, { protocolVersion: "0.1.0", type: "run.start", task: `第 ${i} 条` }); host.emit(finished); }
	assert.equal(readdirSync(join(dataDir, a.id, "points")).length, 40);
});

test("a conversation kept out of memory is hidden from the others' memory search, and may not read memory itself", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-"));
	const made: HostOptions[] = [];
	const desk = createDesk({ dataDir, createHost: (options) => { made.push(options); return fakeHost().host; } });
	const kept = desk.create(undefined, { save: false, read: false }), plain = desk.create();
	desk.command(kept.id, { protocolVersion: "0.1.0", type: "run.start", task: "a" });
	desk.command(plain.id, { protocolVersion: "0.1.0", type: "run.start", task: "b" });
	assert.equal(made[0]!.memoryOff, true);
	assert.equal(made[1]!.memoryOff, undefined);
	assert.deepEqual(made[1]!.memoryExclude!(), [join(dataDir, kept.id)]);
});

test("team agent events are persisted, update waiting status on human approvals, read subagent toolOutput, and stay distinct from user prompts", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-desk-team-"));
	let host!: ReturnType<typeof fakeHost>;
	const desk = createDesk({ dataDir, createHost: () => { host = fakeHost(); return host.host; } });
	const a = desk.create();

	desk.command(a.id, { protocolVersion: "0.1.0", type: "run.start", task: "并行检查前后端" });
	host.emit({ agent: "前端", type: "run.started", task: '[You are 前端, a sub-agent]\n\n<agent_message id="1" from="lead" type="task">\n检查 UI\n</agent_message>' });
	host.emit({ agent: "前端", type: "approval.requested", toolCallId: "sub_1", command: "npm run lint", cwd: ".", risk: "workspace-write", explanation: "lint", source: "human" });
	assert.equal(desk.running()[0]?.status, "waiting", "a subagent waiting on user approval marks the conversation waiting");
	host.emit({ agent: "前端", type: "approval.resolved", toolCallId: "sub_1", decision: "allow", rule: null });
	assert.equal(desk.running()[0]?.status, "running");
	host.emit({ agent: "前端", type: "message.completed", turnId: "t1", text: "前端没有发现问题。", reasoningChars: 0, toolCalls: [] });
	host.emit({ agent: "前端", type: "run.completed", status: "completed", reason: "", turns: 1, totals: { requests: 1, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } });
	assert.equal(desk.running()[0]?.status, "running", "a subagent finishing does not end the lead conversation");

	host.emit({ type: "message.completed", turnId: "t2", text: "前后端都检查完了。", reasoningChars: 0, toolCalls: [] });
	host.emit({ type: "run.completed", status: "completed", reason: "", turns: 1, totals: { requests: 2, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } });
	assert.equal(desk.running().length, 0);

	// Subagent terminal outputs live under run/agents/<name>/recording.jsonl.
	mkdirSync(join(dataDir, a.id, "run", "agents", "前端"), { recursive: true });
	writeFileSync(join(dataDir, a.id, "run", "agents", "前端", "recording.jsonl"), `${JSON.stringify({ kind: "tool.output", data: { toolCallId: "sub_1", modelContent: "$ npm run lint\n[exit code 0]\nall clean" } })}\n`);
	assert.equal(desk.toolOutput(a.id, "sub_1"), "$ npm run lint\n[exit code 0]\nall clean");

	// Markdown export and search do not treat subagent forkNote prompts as user messages.
	const md = desk.markdown(a.id);
	assert.doesNotMatch(md, /You are 前端/);
	assert.match(md, /## Mountains \(前端\)\n\n前端没有发现问题。/);
	assert.deepEqual(desk.search("You are 前端"), []);
	assert.equal(desk.search("前端没有发现问题")[0]?.byUser, false);
});

test("pausing a goal finishes the current run without starting another, and survives reopening", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mountains-goal-pause-"));
	const fake = fakeHost();
	const desk = createDesk({ dataDir, workspace: tmpdir(), createHost: () => fake.host });
	const c = desk.create();
	desk.startGoal(c.id, "Finish the task");
	desk.pauseGoal(c.id);
	assert.equal(desk.list()[0]!.status, "running");
	assert.equal(desk.list()[0]!.goal!.status, "paused");
	assert.equal(fake.commands.length, 1, "pause must not send run.cancel");
	fake.emit({ type: "message.completed", text: "GOAL MET" });
	fake.emit({ type: "run.completed", status: "completed", reason: "" });
	assert.equal(fake.commands.length, 1, "no automatic verification or next turn after pause");
	const reopened = createDesk({ dataDir, workspace: tmpdir(), createHost: () => fake.host });
	assert.equal(reopened.list()[0]!.goal!.status, "paused");
	desk.resumeGoal(c.id);
	desk.resumeGoal(c.id);
	assert.equal(fake.commands.length, 2, "resume starts exactly one turn");
});

test("editing a running goal ignores the old completion and sends the new goal next turn", () => {
	const fake = fakeHost();
	const desk = createDesk({ dataDir: mkdtempSync(join(tmpdir(), "mountains-goal-edit-")), workspace: tmpdir(), createHost: () => fake.host });
	const c = desk.create();
	desk.startGoal(c.id, "Old goal");
	fake.emit({ type: "message.completed", text: "GOAL MET" });
	fake.emit({ type: "run.completed", status: "completed", reason: "" });
	assert.equal(desk.list()[0]!.goal!.status, "verifying");
	desk.updateGoal(c.id, "New goal");
	assert.equal(fake.commands.length, 2, "editing must leave the current verification alone");
	fake.emit({ type: "message.completed", text: "GOAL MET" });
	fake.emit({ type: "run.completed", status: "completed", reason: "" });
	assert.equal(desk.list()[0]!.goal!.status, "active");
	assert.match((fake.commands[2] as { task: string }).task, /^New goal\n\n\[Goal mode:/);
	desk.pauseGoal(c.id);
	desk.updateGoal(c.id, "Paused revision");
	fake.emit({ type: "run.completed", status: "completed", reason: "" });
	assert.equal(fake.commands.length, 3);
	desk.resumeGoal(c.id);
	assert.match((fake.commands[3] as { task: string }).task, /^Paused revision/);
});

test("resuming during a run never duplicates it; deleting the goal keeps that run and chat", () => {
	const fake = fakeHost();
	const desk = createDesk({ dataDir: mkdtempSync(join(tmpdir(), "mountains-goal-delete-")), workspace: tmpdir(), createHost: () => fake.host });
	const c = desk.create();
	desk.startGoal(c.id, "Keep working");
	desk.pauseGoal(c.id);
	desk.resumeGoal(c.id);
	assert.equal(fake.commands.length, 1);
	fake.emit({ type: "run.completed", status: "completed", reason: "" });
	assert.equal(fake.commands.length, 2);
	desk.deleteGoal(c.id);
	assert.equal(desk.list()[0]!.goal, undefined);
	assert.equal(desk.list()[0]!.status, "running");
	assert.equal(fake.commands.length, 2, "deleting must not cancel");
	fake.emit({ type: "message.completed", text: "Current work finished" });
	fake.emit({ type: "run.completed", status: "completed", reason: "" });
	assert.equal(fake.commands.length, 2);
	assert.equal(desk.list()[0]!.status, "idle");
	assert.ok(desk.history(c.id).length > 0, "chat history remains");
});
