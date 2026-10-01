import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createExactChatCompletionsAdapter, preserveExactInputCapability, type ExactChatOptions, type ModelAdapter } from "@mountains/providers";
import { AgentSession, type EngineOptions } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";
import { Recorder } from "@mountains/telemetry";

function sse(input = 100, page?: number): Response {
 const delta = page === undefined ? { content: "done" } : { tool_calls: [{ index: 0, id: `page-${page}`, type: "function", function: { name: "file_read", arguments: '{"path":"notes.txt"}' } }] };
 return new Response(`data: ${JSON.stringify({ id: "local-only", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: page === undefined ? "stop" : "tool_calls" }], usage: { prompt_tokens: input, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: input } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function fixture(t: TestContext, changes: Partial<ExactChatOptions> = {}, options: Partial<EngineOptions> = {}, wrap?: (a: ModelAdapter) => ModelAdapter) {
 const base = mkdtempSync(join(tmpdir(), "exact-preflight-")); t.after(() => rmSync(base, { recursive: true, force: true }));
 const workspace = join(base, "work"); mkdirSync(workspace); writeFileSync(join(workspace, "notes.txt"), "Some evidence.\n");
 let fetches = 0; let counts = 0;
 const adapter = createExactChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "offline-unused", counterIdentity: "a".repeat(64),
  countInput: () => { counts++; return 100; }, fetch: async () => { fetches++; return sse(); }, ...changes });
 const ledgerPath = join(base, "budget.jsonl"); const budget = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath });
 const agent = new AgentSession({ workspace, dataDir: join(base, "data"), adapter: wrap ? wrap(adapter) : adapter,
  model: "deepseek-flash", thinking: { enabled: true, effort: "high" }, maxTokens: 64, exactInputPreflight: true,
  budget, checkpoints: false, retry: { maxAttempts: 1, baseDelayMs: 0 }, runId: "fixed-offline-run",
  limits: { maxRequests: 8, maxTurns: 8, maxInputTokens: 96000, maxOutputTokens: 32768, maxCost: 1 }, ...options });
 return { agent, budget, base, ledgerPath, fetches: () => fetches, counts: () => counts,
  rows: () => existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : [] };
}

test("exact count removes byte rejection and uses the counted request reservation", async t => {
 const f = fixture(t, {}, { systemPrompt: "中文".repeat(30000), limits: { maxInputTokens: 100, maxOutputTokens: 1000, maxCost: 1 } });
 const r = await f.agent.run("Read the evidence.");
 assert.equal(r.status, "completed", r.reason); assert.equal(r.totals.requests, 1); assert.equal(r.totals.input, 100);
 assert.equal(f.fetches(), 1); assert.equal(f.counts(), 1); assert.equal(f.budget.snapshot({ runId: r.runId }).reserved, 0);
});
for (const input of [100, 101]) test(`exact input cap 100 with count ${input}`, async t => {
 const f = fixture(t, { countInput: () => input, fetch: async () => sse(input) }, { limits: { maxInputTokens: 100, maxOutputTokens: 1000, maxCost: 1 } });
 const r = await f.agent.run("Read."); assert.equal(r.status, input === 100 ? "completed" : "limit");
 assert.equal(r.totals.requests, input === 100 ? 1 : 0); assert.equal(f.rows().filter(x => x.kind === "budget.reserve").length, input === 100 ? 1 : 0);
});
for (const rounds of [3, 4, 6]) test(`real engine takes ${rounds} sequential requests and counts cumulative input`, async t => {
 let calls = 0; let counted = 0;
 const f = fixture(t, { countInput: () => { counted++; return 100; }, fetch: async () => { calls++; return sse(100, calls < rounds ? calls : undefined); } },
  { limits: { maxInputTokens: rounds * 100, maxOutputTokens: 32768, maxCost: 1 } });
 const r = await f.agent.run("Read notes.txt, then read again as requested.");
 assert.equal(r.status, "completed", r.reason); assert.equal(calls, rounds); assert.equal(counted, rounds); assert.equal(r.totals.input, rounds * 100);
});
test("one token over cumulative cap stops after the preceding page", async t => {
 let calls = 0;
 const f = fixture(t, { fetch: async () => { calls++; return sse(100, calls); } }, { limits: { maxInputTokens: 399, maxOutputTokens: 32768, maxCost: 1 } });
 const r = await f.agent.run("Read pages."); assert.equal(r.status, "limit"); assert.equal(calls, 3); assert.equal(r.totals.input, 300);
 assert.equal(f.rows().filter(x => x.kind === "budget.reserve").length, 3);
});
for (const value of [NaN, -1, 0.5, Infinity]) test(`invalid counter ${value} is never sent or charged`, async t => {
 const f = fixture(t, { countInput: () => value }); const r = await f.agent.run("Read.");
 assert.equal(f.fetches(), 0); assert.equal(r.totals.cost, 0); assert.equal(r.totals.requests, 0); assert.equal(f.rows().filter(x => x.kind === "budget.reserve").length, 0);
});
test("counter timeout closes the gate, and a late counter result cannot send", async t => {
 let finish!: (v: number) => void;
 const f = fixture(t, { countTimeoutMs: 15, countInput: () => new Promise<number>(r => { finish = r; }) });
 const r = await f.agent.run("Read."); finish(100); await new Promise(r => setTimeout(r, 20));
 assert.equal(r.status, "limit"); assert.equal(f.fetches(), 0); assert.equal(r.totals.cost, 0);
});
for (const action of ["cancel", "new-input"] as const) test(`${action} while counting prevents late dispatch`, async t => {
 let entered!: () => void; let release!: (v: number) => void; const arrival = new Promise<void>(r => { entered = r; }); const ctrl = new AbortController();
 const f = fixture(t, { countInput: () => { entered(); return new Promise<number>(r => { release = r; }); } });
 const pending = f.agent.run("Read.", ctrl.signal); await arrival;
 if (action === "cancel") ctrl.abort(); else await assert.rejects(f.agent.run("Stop. Do not continue."), /旧审批已失效/);
 const r = await pending; release(100); await new Promise(r => setTimeout(r, 10));
 assert.equal(f.fetches(), 0); assert.equal(r.totals.requests, 0); assert.equal(f.rows().filter(x => x.kind === "budget.reserve").length, 0);
});
for (const action of ["cancel", "new-input"] as const) test(`${action} after reservation from request event creates zero settlement`, async t => {
 const ctrl = new AbortController(); let f!: ReturnType<typeof fixture>;
 f = fixture(t, {}, { onEvent: e => { if (e.type === "model.request") { if (action === "cancel") ctrl.abort(); else void f.agent.run("Stop.").catch(() => {}); } } });
 const r = await f.agent.run("Read.", ctrl.signal); assert.equal(f.fetches(), 0); assert.equal(r.totals.requests, 0);
 const rows = f.rows(); assert.equal(rows.filter(x => x.kind === "budget.reserve").length, 1);
 const settlement = rows.find(x => x.kind === "budget.settle"); assert.equal(settlement.amount, 0); assert.equal(settlement.partial, false);
 assert.equal(f.budget.snapshot({ runId: r.runId }).reserved, 0);
});
test("sent disconnect retains unknown cost rather than zero settlement", async t => {
 const f = fixture(t, { fetch: async () => { throw new Error("disconnect after dispatch"); } });
 const r = await f.agent.run("Read."); assert.equal(r.totals.requests, 1); assert.equal(r.totals.usagePartialRequests, 1);
 assert.ok(f.budget.snapshot({ runId: r.runId }).unknownCost > 0); assert.equal(f.rows().find(x => x.kind === "budget.settle").partial, true);
});
test("request recording failure after reserve sends nothing and appends zero cost", async t => {
 const original = Recorder.prototype.write; t.after(() => { Recorder.prototype.write = original; });
 Recorder.prototype.write = function(kind, value) { if (kind === "model.preflight") throw new Error("injected disk error"); return original.call(this, kind, value); };
 const f = fixture(t); const r = await f.agent.run("Read."); assert.equal(f.fetches(), 0); assert.equal(r.totals.cost, 0);
 assert.equal(f.rows().find(x => x.kind === "budget.settle").amount, 0);
});
test("missing wrapper callback is refused by terminal adapter without fetching", async t => {
 const f = fixture(t, {}, {}, delegate => preserveExactInputCapability(delegate, { id: "broken-wrapper", complete: req => delegate.complete(req) }));
 const r = await f.agent.run("Read."); assert.equal(r.totals.requests, 0); assert.equal(f.fetches(), 0); assert.match(r.reason, /gate/);
});
test("unknown adapter cannot claim exact counting using a property", t => {
 assert.throws(() => fixture(t, {}, { adapter: { id: "liar", exactInputPreflight: true, complete: async () => { throw new Error("must not call"); } } as ModelAdapter }), /受信工厂/);
});
test("repeated beforeDispatch callback closes the gate without fetching", async t => {
 const f = fixture(t, {}, {}, delegate => preserveExactInputCapability(delegate, { id: "duplicate-wrapper", complete(req, h) {
  return delegate.complete(req, { ...h, exactInput: { beforeDispatch: async e => { await h!.exactInput!.beforeDispatch(e); await h!.exactInput!.beforeDispatch(e); }, dispatch: (e, send) => h!.exactInput!.dispatch(e, send) } });
 } }));
 const r = await f.agent.run("Read."); assert.equal(f.fetches(), 0); assert.equal(r.totals.requests, 0); assert.equal(f.rows().find(x => x.kind === "budget.settle").amount, 0);
});

test("reservation write failure cannot send", async t => {
 const f = fixture(t); f.budget.reserve = () => { throw new Error("injected reserve disk failure"); };
 const r = await f.agent.run("Read."); assert.equal(f.fetches(), 0); assert.equal(r.totals.requests, 0); assert.equal(r.totals.cost, 0);
});
test("zero settlement failure keeps the persisted reservation", async t => {
 const ctrl = new AbortController(); const f = fixture(t, {}, { onEvent: e => { if (e.type === "model.request") ctrl.abort(); } });
 f.budget.settleReservation = () => { throw new Error("injected settlement disk failure"); };
 const r = await f.agent.run("Read.", ctrl.signal); assert.equal(f.fetches(), 0); assert.match(r.reason, /零结算失败/);
 assert.ok(f.budget.snapshot({ runId: r.runId }).reserved > 0); assert.equal(f.rows().filter(x => x.kind === "budget.settle").length, 0);
});
test("late wrapper completion cannot reopen the engine gate", async t => {
 let release!: () => void; let entered!: () => void;
 const waiting = new Promise<void>(resolve => { entered = resolve; }); let late: Promise<unknown> | undefined;
 const f = fixture(t, {}, {}, delegate => preserveExactInputCapability(delegate, { id: "early-return-wrapper", async complete(req, h) {
  late = delegate.complete(req, { ...h, exactInput: { beforeDispatch: async evidence => { entered(); await new Promise<void>(r => { release = r; }); await h!.exactInput!.beforeDispatch(evidence); }, dispatch: (e, send) => h!.exactInput!.dispatch(e, send) } });
  await waiting; throw new Error("outer wait ended");
 } }));
 const r = await f.agent.run("Read."); release(); await late;
 assert.equal(r.totals.requests, 0); assert.equal(f.fetches(), 0); assert.equal(f.rows().filter(x => x.kind === "budget.reserve").length, 0);
});
test("known response still settles when telemetry response write fails", async t => {
 const original = Recorder.prototype.write; t.after(() => { Recorder.prototype.write = original; });
 Recorder.prototype.write = function(kind, value) { if (kind === "model.response") throw new Error("injected response disk failure"); return original.call(this, kind, value); };
 const f = fixture(t); const r = await f.agent.run("Read."); assert.equal(f.fetches(), 1); assert.equal(r.status, "limit");
 const state = f.budget.snapshot({ runId: r.runId }); assert.ok(state.spent > 0); assert.equal(state.unknownCost, 0); assert.equal(state.reserved, 0);
});

test("cancellation during a wrapper wait after a successful check releases only the unused reservation", async t => {
 let arrived!: () => void; let resume!: () => void; const waiting = new Promise<void>(r => { arrived = r; }); const ctrl = new AbortController();
 const f = fixture(t, {}, {}, delegate => preserveExactInputCapability(delegate, { id: "wait-after-check", complete(req, h) {
  return delegate.complete(req, { ...h, exactInput: { beforeDispatch: async evidence => { await h!.exactInput!.beforeDispatch(evidence); arrived(); await new Promise<void>(r => { resume = r; }); }, dispatch: (e, send) => h!.exactInput!.dispatch(e, send) } });
 } }));
 const pending = f.agent.run("Read.", ctrl.signal); await waiting; ctrl.abort(); resume(); const r = await pending;
 assert.equal(f.fetches(), 0); assert.equal(r.totals.requests, 0); assert.equal(f.rows().filter(x => x.kind === "budget.reserve").length, 1);
 assert.equal(f.rows().find(x => x.kind === "budget.settle").amount, 0);
});

test("provider usage mismatch settles known cost then stops before a tool or second request", async t => {
 let calls = 0; let tools = 0;
 const f = fixture(t, { fetch: async () => { calls++; return sse(101, calls); } }, { onEvent: event => { if (event.type === "tool.requested") tools++; } });
 const r = await f.agent.run("Read notes.txt.");
 assert.equal(calls, 1); assert.equal(tools, 0); assert.equal(r.status, "limit"); assert.match(r.reason, /计数与模型报告不一致/);
 const snapshot = f.budget.snapshot({ runId: r.runId }); assert.ok(snapshot.spent > 0); assert.equal(snapshot.unknownCost, 0); assert.equal(snapshot.reserved, 0);
});

for (const mode of ["replace-both", "replace-before", "replace-dispatch"] as const) {
 test(`wrapper ${mode} cannot bypass the original engine send gate`, async t => {
  const f = fixture(t, {}, {}, inner => preserveExactInputCapability(inner, { id: mode, complete(req, handlers) {
   const host = handlers!.exactInput!;
   return inner.complete(req, { ...handlers, exactInput: {
    beforeDispatch: mode === "replace-dispatch" ? e => host.beforeDispatch(e) : async () => {},
    dispatch: mode === "replace-before" ? (e, send) => host.dispatch(e, send) : (_e, send) => send(),
   } });
  } }));
  const r = await f.agent.run("Read.");
  assert.equal(f.fetches(), 0); assert.equal(r.totals.requests, 0); assert.equal(r.totals.cost, 0);
  assert.equal(f.budget.snapshot({ runId: r.runId }).reserved, 0);
  assert.equal(f.rows().filter(x => x.kind === "budget.settle" && x.partial).length, 0);
  assert.match(r.reason, mode === "replace-before" ? /请求未通过检查/ : /EXACT_GATE_REPLACED/);
 });
}

test("two concurrent sessions do not share their dispatch permission or charge", async t => {
 let arriveA!: () => void, releaseA!: (n: number) => void;
 const waiting = new Promise<void>(r => { arriveA = r; });
 const a = fixture(t, { countInput: () => { arriveA(); return new Promise<number>(r => { releaseA = r; }); } });
 const b = fixture(t, {}, {}, inner => preserveExactInputCapability(inner, { id: "other-session-pass-through", complete(req, handlers) {
  return inner.complete(req, { ...handlers, exactInput: { beforeDispatch: async () => {}, dispatch: (_e, send) => send() } });
 } }));
 const pending = a.agent.run("Read A."); await waiting;
 const rb = await b.agent.run("Read B."); releaseA(100); const ra = await pending;
 assert.equal(a.fetches(), 1); assert.equal(ra.status, "completed"); assert.ok(a.budget.snapshot({ runId: ra.runId }).spent > 0);
 assert.equal(b.fetches(), 0); assert.equal(rb.totals.cost, 0); assert.equal(b.budget.snapshot({ runId: rb.runId }).spent, 0);
});

test("local counter failure keeps a safe reason in summary and not-sent record", async t => {
 const secret = "sk-not-a-real-key-PRIVATE_BODY_MARKER";
 const f = fixture(t, { countInput: () => { throw new Error(`failed ${secret} /private/sensitive-path`); } });
 const r = await f.agent.run("Read.");
 assert.match(r.reason, /INPUT_COUNTER_FAILED/); assert.equal(f.fetches(), 0); assert.equal(r.totals.cost, 0);
 const record = readFileSync(join(f.base, "data", "recording.jsonl"), "utf8");
 assert.match(record, /INPUT_COUNTER_FAILED/); assert.doesNotMatch(JSON.stringify(r) + record, /PRIVATE_BODY_MARKER|sensitive-path|Connection error/);
});

for (const mode of ["sync-throw", "stream-error"] as const) test(`${mode} after dispatch still retains unknown cost`, async t => {
 const f = fixture(t, { fetch: mode === "sync-throw" ? () => { throw new Error("synchronous transport failure"); } : async () => new Response(new ReadableStream({ start(c) { c.error(new Error("stream interrupted")); } }), { headers: { "content-type": "text/event-stream" } }) });
 const r = await f.agent.run("Read.");
 assert.equal(r.totals.requests, 1); assert.equal(r.totals.usagePartialRequests, 1);
 assert.ok(f.budget.snapshot({ runId: r.runId }).unknownCost > 0);
 assert.equal(f.rows().find(x => x.kind === "budget.settle").partial, true);
 assert.doesNotMatch(readFileSync(join(f.base, "data", "recording.jsonl"), "utf8"), /model\.not-sent/);
});
