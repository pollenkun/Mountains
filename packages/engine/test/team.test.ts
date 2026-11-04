import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ModelAdapter, ModelRequest } from "@mountains/providers";
import { AgentSession, AgentTeam, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

const rawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
let ids = 0;
const call = (name: string, args: Record<string, unknown> = {}) => ({ id: `c${++ids}`, name, argumentsJson: JSON.stringify(args) });
function reply(calls: RecordedResponse["message"]["toolCalls"] = [], content = "Done."): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : content, reasoning: "", toolCalls: calls },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage, httpStatus: 200, error: null, aborted: false };
}
function gate() {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	return { pending, release };
}
/** A model that answers only once released, or reports the abort. */
function held(script: RecordedResponse[], until: Promise<void>): ModelAdapter & { requests: ModelRequest[] } {
	const scripted = new ScriptedModelAdapter(script);
	return { id: "held", requests: scripted.requests, async complete(req, handlers) {
		const aborted = new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
		await Promise.race([until, aborted]);
		if (req.signal?.aborted) return { ...(await new ScriptedModelAdapter([]).complete(req)), aborted: true, error: { message: "已取消", retryable: false } };
		return scripted.complete(req, handlers);
	} };
}
const text = (req: ModelRequest) => req.messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");

function team(t: TestContext, adapters: Record<string, ModelAdapter>, { maxCost = 5, maxGroupSize = 4, maxAgents = 2, choices = undefined as { id: string; efforts: string[] }[] | undefined } = {}) {
	const root = mkdtempSync(join(tmpdir(), "mountains-team-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	const budget = new BudgetGuard({ globalLimit: 10, ledgerPath: join(root, "spend.jsonl") });
	const made: string[] = [];
	const picks: Record<string, { model?: string; effort?: string }> = {};
	const agents = new AgentTeam({ maxCost, maxAgents, maxGroupSize, ...(choices ? { choices } : {}), makeOptions: ({ name, model, effort }): EngineOptions => {
		made.push(name);
		picks[name] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
		const adapter = adapters[name];
		if (!adapter) throw new Error(`no script for ${name}`);
		return { workspace, dataDir: join(root, "data", name), adapter, model: "deepseek-flash", thinking: { enabled: false, effort: "default" },
			maxTokens: 64, checkpoints: false, requestGuard: true, budget, retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 8, maxRequests: 10, maxCost: 2 } };
	} });
	return { agents, workspace, made, picks };
}

test("the root starts agents that work at once and reports their answers back", async (t) => {
	const root = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "a", purpose: "test", task: "Write a.txt" }), call("spawn_agent", { name: "b", purpose: "test", task: "Write b.txt" })]),
		reply([call("wait_agent", { timeout_seconds: 10 })]),
		reply([call("wait_agent", { timeout_seconds: 10 })]),
		reply([], "Both files written."),
	]);
	const a = new ScriptedModelAdapter([reply([call("file_write", { path: "a.txt", content: "a" })]), reply([], "a.txt written")]);
	const b = new ScriptedModelAdapter([reply([call("file_write", { path: "b.txt", content: "b" })]), reply([], "b.txt written")]);
	const f = team(t, { lead: root, a, b });
	const summary = await f.agents.run("Write two files");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(summary.finalText, "Both files written.");
	assert.equal(readFileSync(join(f.workspace, "a.txt"), "utf8"), "a");
	assert.equal(readFileSync(join(f.workspace, "b.txt"), "utf8"), "b");
	assert.equal(summary.totals.requests, 8);
	assert.deepEqual(summary.agents.map((x) => [x.name, x.status, x.requests]), [["lead", "done", 4], ["a", "done", 2], ["b", "done", 2]]);
	assert.deepEqual([...summary.filesChanged].sort(), ["a.txt", "b.txt"]);
	// The root sees both answers, marked as coming from the agents.
	const seen = root.requests.map(text).join("\n");
	assert.match(seen, /<agent_message id="\d+" from="a" type="final_answer">\na\.txt written/);
	assert.match(seen, /<agent_message id="\d+" from="b" type="final_answer">\nb\.txt written/);
	// Each agent knows its place; only the root can start agents.
	assert.match(root.requests[0]!.system, /Never start agents to fill a number/);
	assert.ok(root.requests[0]!.tools.some((x) => x.name === "spawn_agent"));
	// An agent starts on the lead's exact prefix, so the provider's cache serves it.
	assert.equal(a.requests[0]!.system, root.requests[0]!.system);
	assert.deepEqual(a.requests[0]!.tools, root.requests[0]!.tools);
	assert.deepEqual(a.requests[0]!.messages.slice(0, root.requests[0]!.messages.length), root.requests[0]!.messages);
	assert.match(text(a.requests[0]!), /You are a, a sub-agent working from a copy of lead's conversation/);
	assert.deepEqual(a.requests[0]!.tools.slice(-6).map((x) => x.name), ["spawn_agent", "send_message", "wait_agent", "read_messages", "interrupt_agent", "list_agents"]);
	assert.match(text(a.requests[0]!), /<agent_message id="\d+" from="lead" type="task">\nWrite a\.txt\n<\/agent_message>/);
});

test("a final answer waits for agents still working, and their answer continues the same run", async (t) => {
	const release = gate();
	const root = new ScriptedModelAdapter([reply([call("spawn_agent", { name: "a", purpose: "test", task: "Check the tests" })]), reply([], "Too early."), reply([], "Tests pass, says a.")]);
	const a = held([reply([], "All 12 tests pass")], release.pending);
	const f = team(t, { lead: root, a });
	const running = f.agents.run("Check everything");
	while (root.requests.length < 2) await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(root.requests.length, 2, "the root waits instead of finishing");
	release.release();
	const summary = await running;
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(summary.finalText, "Tests pass, says a.");
	assert.match(text(root.requests[2]!), /type="final_answer">\nAll 12 tests pass/);
});

test("a finished agent takes a follow-up task from send_message", async (t) => {
	const root = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "a", purpose: "test", task: "First part" })]),
		reply([call("wait_agent", { timeout_seconds: 10 })]),
		reply([call("send_message", { to: "a", message: "Now the second part" })]),
		reply([call("wait_agent", { timeout_seconds: 10 })]),
		reply([], "Both parts done."),
	]);
	const a = new ScriptedModelAdapter([reply([], "first done"), reply([], "second done")]);
	const f = team(t, { lead: root, a });
	const summary = await f.agents.run("Two parts");
	assert.equal(summary.status, "completed", summary.reason);
	assert.match(text(a.requests[1]!), /<agent_message id="\d+" from="lead" type="message">\nNow the second part/);
	assert.match(text(root.requests[4]!), /second done/);
	assert.equal(summary.agents.find((x) => x.name === "a")?.runs, 2);
});

test("interrupt_agent stops an agent without an answer, and agents stop when the root ends", async (t) => {
	const never = gate();
	const root = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "a", purpose: "test", task: "Long job" }), call("spawn_agent", { name: "b", purpose: "test", task: "Another long job" })]),
		reply([call("interrupt_agent", { to: "a" })]),
		reply([call("interrupt_agent", { to: "b" })]),
		reply([], "Stopped both."),
	]);
	const f = team(t, { lead: root, a: held([reply([], "never")], never.pending), b: held([reply([], "never")], never.pending) });
	const summary = await f.agents.run("Start and stop");
	assert.equal(summary.status, "completed", summary.reason);
	assert.deepEqual(summary.agents.map((x) => x.status), ["done", "stopped", "stopped"]);
	assert.doesNotMatch(root.requests.map(text).join("\n"), /final_answer/);
});

test("spawn_agent refuses more agents than may work at once, and names already taken", async (t) => {
	const never = gate();
	const root = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "a", purpose: "test", task: "x" }), call("spawn_agent", { name: "b", purpose: "test", task: "y" }), call("spawn_agent", { name: "c", purpose: "test", task: "z" }), call("spawn_agent", { name: "a", purpose: "test", task: "again" })]),
		reply([call("interrupt_agent", { to: "a" }), call("interrupt_agent", { to: "b" })]),
		reply([], "ok"),
	]);
	const f = team(t, { lead: root, a: held([], never.pending), b: held([], never.pending) });
	const summary = await f.agents.run("Too many");
	assert.equal(summary.status, "completed", summary.reason);
	const results = text(root.requests[1]!);
	assert.match(results, /2 agents are already working, the most at once/);
	assert.match(results, /^a already exists/m);
	assert.deepEqual(f.made, ["lead", "a", "b"]);
});

test("the team's cost limit stops every agent", async (t) => {
	const never = gate();
	const root = new ScriptedModelAdapter([reply([call("spawn_agent", { name: "a", purpose: "test", task: "x" })]), reply([call("wait_agent", { timeout_seconds: 60 })]), reply([], "never")]);
	const a = new ScriptedModelAdapter([reply([call("wait_agent", { timeout_seconds: 60 })]), reply([], "never")]);
	void never;
	const f = team(t, { lead: root, a }, { maxCost: 0.00005 });
	const summary = await f.agents.run("Spend");
	assert.equal(summary.status, "limit");
	assert.match(summary.reason, /团队估算费用达到上限/);
	assert.ok(summary.agents.every((x) => x.status !== "working"));
});

test("a shared external stop reaches every member before a delayed lead finishes cancelling", { timeout: 5000 }, async t => {
	const rootMayFinish = gate(), allStarted = gate(), membersAborted = gate();
	const started = new Set<string>(), aborted = new Set<string>();
	const waiting = (name: string, delay: Promise<void> | undefined): ModelAdapter => ({ id: `own-waiting-${name}`, async complete(req) {
		const cancelled = new Promise<void>(resolve => {
			const stop = () => { aborted.add(name); if (aborted.has("a") && aborted.has("b")) membersAborted.release(); resolve(); };
			if (req.signal?.aborted) stop(); else req.signal?.addEventListener("abort", stop, { once: true });
		});
		started.add(name); if (started.size === 3) allStarted.release();
		await cancelled; if (delay) await delay;
		// This cancellation fixture still reports its known usage. Missing usage would
		// deliberately reserve the full remaining budget and test a different stop reason.
		return { ...(await new ScriptedModelAdapter([reply()]).complete(req)), aborted: true, error: { message: "local fixture cancelled", retryable: false } };
	} });
	const first = new ScriptedModelAdapter([reply([call("spawn_agent", { name: "a", purpose: "test", task: "local hold" }), call("spawn_agent", { name: "b", purpose: "test", task: "local hold" })])]);
	const leadWait = waiting("lead", rootMayFinish.pending); let rootCalls = 0;
	const root: ModelAdapter = { id: "own-delayed-lead", complete: (req, handlers) => ++rootCalls === 1 ? first.complete(req, handlers) : leadWait.complete(req, handlers) };
	const f = team(t, { lead: root, a: waiting("a", undefined), b: waiting("b", undefined) }), stop = new AbortController();
	const running = f.agents.run("Start two local held agents", stop.signal);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await allStarted.pending; stop.abort();
		await Promise.race([membersAborted.pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("members did not receive the shared stop while lead was still waiting")), 500); })]);
		assert.deepEqual([...aborted].sort(), ["a", "b", "lead"]);
	} finally { clearTimeout(timer); rootMayFinish.release(); await running; }
	const summary = await running; assert.equal(summary.status, "cancelled"); assert.ok(summary.agents.every(a => a.status === "stopped"));
});

test("a message from another agent keeps the run's pending operations; the user's input revokes them", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-team-epoch-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const workspace = join(dir, "work"); mkdirSync(workspace);
	const run = async (from: "user" | "agent") => {
		let session!: AgentSession;
		session = new AgentSession({ workspace, dataDir: join(dir, `data-${from}`), model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64,
			checkpoints: false, requestGuard: true, allowInterjection: true, budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(dir, `spend-${from}.jsonl`) }),
			approval: { rules: [], fallback: "ask" }, toolOptions: { approveFileWrites: true }, limits: { maxTurns: 4, maxRequests: 4, maxCost: 1 },
			adapter: new ScriptedModelAdapter([reply([call("file_write", { path: `${from}-1.txt`, content: "1" }), call("file_write", { path: `${from}-2.txt`, content: "2" })]), reply(), reply()]),
			askApproval: async () => { session.interject("A note", from); return "allow"; } });
		return session.run("Write two files");
	};
	assert.equal((await run("agent")).filesChanged.length, 2);
	// The user's input revokes even the operation just approved.
	assert.equal((await run("user")).filesChanged.length, 0);
});

test("a group lead adds members, a member adds one to the same group, and answers go to whoever started the agent", async (t) => {
	const root = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "ui", purpose: "test", task: "Build the page" })]),
		reply([], "Too early."),
		reply([], "The page is built."),
	]);
	const ui = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "ui_css", purpose: "test", task: "Write the styles" })]),
		reply([], "Waiting for css."),
		reply([], "Page done with styles and icons."),
	]);
	const css = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "ui_icons", purpose: "test", task: "Draw the icons" }), call("spawn_agent", { name: "ui_extra", purpose: "test", task: "One too many" })]),
		reply([call("wait_agent", { timeout_seconds: 10 })]),
		reply([], "Styles done; icons by ui_icons."),
	]);
	const icons = new ScriptedModelAdapter([reply([call("read_messages", {})]), reply([], "Icons drawn.")]);
	const f = team(t, { lead: root, ui, ui_css: css, ui_icons: icons }, { maxGroupSize: 3, maxAgents: 6 });
	const summary = await f.agents.run("Build a page");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(summary.finalText, "The page is built.");
	assert.deepEqual(summary.agents.map((x) => [x.name, x.role, x.group, x.startedBy, x.status]), [
		["lead", "lead", null, null, "done"], ["ui", "group lead", "ui", "lead", "done"],
		["ui_css", "member", "ui", "ui", "done"], ["ui_icons", "member", "ui", "ui_css", "done"]]);
	// The group is full at three; the member's helper reports to the member, the member to the group lead, the group lead to lead.
	assert.match(text(css.requests[1]!), /Group ui already has 3 agents, the most per group/);
	assert.match(text(css.requests[2]!), /from="ui_icons" type="final_answer">\nIcons drawn\./);
	assert.match(text(ui.requests[2]!), /from="ui_css" type="final_answer">\nStyles done/);
	assert.match(text(root.requests[2]!), /from="ui" type="final_answer">\nPage done with styles and icons\./);
	assert.match(text(ui.requests[0]!), /You are ui, a sub-agent/);
	assert.match(text(icons.requests[0]!), /You are ui_icons, a sub-agent working from a copy of ui_css's conversation/);
	// Anyone can read what the team has exchanged.
	assert.match(text(icons.requests[1]!), /#1 lead → ui \(task, [\d:]+\)\nBuild the page[\s\S]*#2 ui → ui_css \(task/);
});

test("who may stop whom: a member only those it started; stopping a group lead stops its group", async (t) => {
	const never = gate();
	const root = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "api", purpose: "test", task: "Build the API" })]),
		reply([call("list_agents", {})]),
		reply([call("interrupt_agent", { to: "api" })]),
		reply([], "Stopped."),
	]);
	const api = new ScriptedModelAdapter([reply([call("spawn_agent", { name: "api_db", purpose: "test", task: "Schema" })]), reply([call("interrupt_agent", { to: "lead" })])]);
	const db = held([reply([], "never")], never.pending);
	const f = team(t, { lead: root, api, api_db: db });
	const summary = await f.agents.run("Build");
	assert.equal(summary.status, "completed", summary.reason);
	assert.deepEqual(summary.agents.map((x) => x.status), ["done", "stopped", "stopped"]);
	assert.match(text(root.requests[2]!), /group api:\n {2}api \[group lead\]: [a-z]+[\s\S]*api_db \[started by api\]: working/);
	assert.match(text(root.requests[3]!), /Stopped api, api_db\./);
});

test("the lead picks a model and effort for each agent when there is a choice; with none, spawn_agent is unchanged", async (t) => {
	const lead = new ScriptedModelAdapter([
		reply([call("spawn_agent", { name: "tests", purpose: "test", task: "Run the tests", model: "glm-5.3-flash", effort: "low" }), call("spawn_agent", { name: "docs", purpose: "test", task: "Fix docs", effort: "turbo" })]),
		reply([call("wait_agent", { timeout_seconds: 10 })]),
		reply([], "Done."),
	]);
	const tests = new ScriptedModelAdapter([reply([], "tests pass")]);
	const f = team(t, { lead, tests }, { choices: [{ id: "deepseek-flash", efforts: ["low", "high", "max"] }, { id: "glm-5.3-flash", efforts: ["low", "high", "max"] }] });
	const summary = await f.agents.run("Run tests and fix docs");
	assert.equal(summary.status, "completed", summary.reason);
	assert.deepEqual(f.picks.tests, { model: "glm-5.3-flash", effort: "low" });
	assert.equal(f.made.includes("docs"), false, "an effort the model lacks is refused before anything starts");
	const spawn = lead.requests[0]!.tools.find((tool) => tool.name === "spawn_agent")!;
	const props = (spawn.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
	assert.deepEqual(props.model?.enum, ["deepseek-flash", "glm-5.3-flash"]);
	assert.deepEqual(props.effort?.enum, ["low", "high", "max"]);

	const plain = new ScriptedModelAdapter([reply([], "Nothing to start.")]);
	const g = team(t, { lead: plain }, { choices: [{ id: "deepseek-flash", efforts: [] }] });
	await g.agents.run("Say hi");
	const plainSpawn = plain.requests[0]!.tools.find((tool) => tool.name === "spawn_agent")!;
	assert.deepEqual(Object.keys((plainSpawn.parameters as { properties: object }).properties), ["name", "purpose", "task"]);
});
