import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ToolCall } from "@mountains/protocol";
import { AgentSession, type EngineOptions } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";
import { ScriptedModelAdapter, type RecordedResponse } from "../src/replay.ts";

function reply(calls: ToolCall[] = []): RecordedResponse {
 return { ok: true, message: { role: "assistant", content: calls.length ? "" : "done", reasoning: "", toolCalls: calls }, finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 1, total_tokens: 11 }, httpStatus: 200, error: null, aborted: false };
}
function fixture(t: TestContext, responses: RecordedResponse[], options: Partial<EngineOptions> = {}) {
 const root = mkdtempSync(join(tmpdir(), "mountains-recovery-audit-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const workspace = join(root, "workspace"); mkdirSync(workspace);
 const adapter = new ScriptedModelAdapter(responses);
 const settings: EngineOptions = { workspace, dataDir: join(root, "data"), adapter, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 16, budget: new BudgetGuard({ globalLimit: 1, ledgerPath: join(root, "spend.jsonl") }), checkpoints: false, ...options };
 return { root, workspace, adapter, settings, session: new AgentSession(settings) };
}

test("null tool arguments yield a recoverable tool error rather than rejecting the run", async t => {
 const f = fixture(t, [reply([{ id: "bad", name: "file_read", argumentsJson: "null" }]), reply()]);
 const result = await f.session.run("Read only valid arguments.");
 assert.equal(result.status, "completed"); assert.equal(f.adapter.requests.length, 2);
 const messages = f.adapter.requests[1]!.messages;
 assert(messages.some(m => m.role === "tool" && m.content.includes("参数必须是 JSON 对象")));
});

for (const ids of [["same", "same"], ["", "other"], ["  ", "other"]]) {
 test(`invalid call IDs ${JSON.stringify(ids)} cannot execute or poison snapshots`, async t => {
  let executed = 0;
  const f = fixture(t, [reply(ids.map(id => ({ id, name: "context_expand", argumentsJson: "{}" })))], { allowSessionSnapshots: true,
   tools: [{ name: "context_expand", logicalName: "fixture", description: "fixture", readOnly: false, parameters: { type: "object" }, async execute() { executed++; return { ok: true, modelContent: "done", summary: "done", details: {} }; } }] });
  const result = await f.session.run("Run only valid calls."); assert.equal(result.status, "failed"); assert.equal(executed, 0);
  assert.doesNotThrow(() => f.session.exportSnapshot());
 });
}

test("a retry aborted from the error callback does not wait the entire backoff", async t => {
 const ac = new AbortController(); let abortedAt = 0;
 const error: RecordedResponse = { ...reply(), ok: false, rawUsage: null, httpStatus: 429, error: { message: "retry fixture", retryable: true } };
 const f = fixture(t, [error], { retry: { maxAttempts: 2, baseDelayMs: 10_000 }, onEvent: e => { if (e.type === "error") { abortedAt = Date.now(); ac.abort(); } } });
 const result = await f.session.run("Fixture", ac.signal);
 assert.equal(result.status, "cancelled"); assert.equal(f.adapter.requests.length, 1); assert(Date.now() - abortedAt < 1000);
});

for (const name of ["command_run", "file_write"]) for (const mode of ["abort", "deadline"]) {
 test(`${name} pending human approval settles on ${mode} without late execution`, async t => {
  let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
  let release!: (value: "allow" | "deny") => void; const approval = new Promise<"allow" | "deny">(resolve => { release = resolve; });
  const ac = new AbortController();
  const args = name === "command_run" ? { argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("marker", "ran")'] } : { path: "marker", content: "ran" };
  const f = fixture(t, [reply([{ id: "action", name, argumentsJson: JSON.stringify(args) }])], { approval: { rules: [], fallback: "ask" }, askApproval: () => { entered(); return approval; }, toolOptions: { approveFileWrites: true }, ...(mode === "deadline" ? { limits: { maxDurationMs: 100 } } : {}) });
  const running = f.session.run("Approve the fixture.", ac.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   await entering; if (mode === "abort") ac.abort();
   const result = await Promise.race([running, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("approval cancellation did not settle")), 1500); })]);
   assert.equal(result.status, mode === "abort" ? "cancelled" : "limit");
   release("allow"); await Promise.resolve(); assert.equal(existsSync(join(f.workspace, "marker")), false);
  } finally { clearTimeout(timer); release("deny"); await running; }
 });
}

test("state roots inside the workspace are rejected before session files are created", t => {
 const f = fixture(t, [reply()]);
 for (const field of ["dataDir", "appDataDir"] as const) {
  const inside = join(f.workspace, field);
  assert.throws(() => new AgentSession({ ...f.settings, [field]: inside }), /工作区之外/);
  assert.equal(existsSync(inside), false);
 }
 const insideLedger = new BudgetGuard({ globalLimit: 1, ledgerPath: join(f.workspace, "spend.jsonl") });
 assert.throws(() => new AgentSession({ ...f.settings, budget: insideLedger }), /工作区之外/);
 assert.equal(existsSync(insideLedger.ledgerPath), false, "no accounting entries should be created");
 const alias = join(f.root, "alias"); symlinkSync(f.workspace, alias, process.platform === "win32" ? "junction" : "dir");
 assert.throws(() => new AgentSession({ ...f.settings, dataDir: join(alias, "data") }), /工作区之外/);
});

test("outward events use the same secret redaction boundary as recordings", async t => {
 const previous = process.env.TEST_SECRET_TOKEN; const secret = "fixture-only-secret-7291283"; process.env.TEST_SECRET_TOKEN = secret;
 t.after(() => { if (previous === undefined) delete process.env.TEST_SECRET_TOKEN; else process.env.TEST_SECRET_TOKEN = previous; });
 const events: unknown[] = []; const f = fixture(t, [reply()], { onEvent: e => events.push(e) });
 await f.session.run(`Do not disclose ${secret}`);
 assert(!JSON.stringify(events).includes(secret)); assert(JSON.stringify(events).includes("[REDACTED]"));
 assert(!readFileSync(join(f.root, "data", "recording.jsonl"), "utf8").includes(secret));
});


test("Unicode tool-target labels remain indexable after command output is shaped", async t => {
 const f = fixture(t, [reply([{ id: "unicode", name: "command_run", argumentsJson: JSON.stringify({ argv: ["x".repeat(99) + "😀"] }) }]), reply()], {
  tools: [{ name: "context_expand", logicalName: "fixture", description: "fixture", parameters: { type: "object" }, readOnly: true, async execute() { return { ok: true, modelContent: "fixture", summary: "fixture", details: {} }; } },
   { name: "command_run", logicalName: "fixture.command", description: "offline stub", parameters: { type: "object" }, readOnly: false, async execute() { return { ok: true, modelContent: "fixture", summary: "fixture", details: {} }; } }] });
 const result = await f.session.run("Run the fixture."); assert.equal(result.status, "completed"); assert.equal(f.adapter.requests.length, 2);
});


test("recovered null arguments survive later program compaction", async t => {
 const rejectedSummary: RecordedResponse = { ...reply(), ok: false, rawUsage: null, httpStatus: 400, error: { message: "offline summary unavailable", retryable: false } };
 const f = fixture(t, [reply([{ id: "bad", name: "file_read", argumentsJson: "null" }]), reply(), rejectedSummary]);
 assert.equal((await f.session.run("Recover invalid arguments.")).status, "completed");
 const compacted = await f.session.compactNow(); assert(compacted.revision); assert.equal(f.adapter.requests.length, 3);
});

test("assistant index failure leaves no pending tool group in the recoverable snapshot", async t => {
 const response = reply([{ id: "not-executed", name: "file_read", argumentsJson: '{"path":"missing"}' }]); response.message.content = "assistant fixture";
 const f = fixture(t, [response], { allowSessionSnapshots: true });
 const index = (f.session as unknown as { sessionIndex: { record: (text: string, meta: { role: string }) => unknown } }).sessionIndex;
 const original = index.record.bind(index); index.record = (text, meta) => { if (meta.role === "assistant") throw new Error("SESSION_INDEX_FULL"); return original(text, meta); };
 assert.equal((await f.session.run("Keep snapshot consistent.")).status, "limit");
 assert.doesNotThrow(() => f.session.exportSnapshot());
});
