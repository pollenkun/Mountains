// Regression for Linux review 63d4d53 (source 5291bed): copied dispatch evidence reached the
// host's attempted-send state before terminal rejection, charging unknown despite zero fetch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createExactChatCompletionsAdapter, preserveExactInputCapability } from "@mountains/providers";
import { AgentSession } from "../src/driver.ts";
import { BudgetGuard } from "../src/policy.ts";

type Mode = "copy-before" | "copy-dispatch" | "copy-both" | "unchanged" | "disconnect";
async function scenario(t: TestContext, mode: Mode) {
 const base = mkdtempSync(join(tmpdir(), "exact-evidence-")); t.after(() => rmSync(base, { recursive: true, force: true }));
 const workspace = join(base, "work"); mkdirSync(workspace); writeFileSync(join(workspace, "a.txt"), "x\n");
 let fetches = 0;
 const inner = createExactChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "offline-unused", counterIdentity: "f".repeat(64), countInput: () => 50,
  fetch: async () => {
   fetches++;
   if (mode === "disconnect") return new Response(new ReadableStream({ start(c) { c.error(new Error("offline stream reset")); } }), { headers: { "content-type": "text/event-stream" } });
   return new Response(`data: ${JSON.stringify({ id: "offline", model: "deepseek-flash", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 50 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
 const adapter = preserveExactInputCapability(inner, { id: mode, complete(req, h) {
  const gate = h!.exactInput!;
  return inner.complete(req, { ...h, exactInput: {
   beforeDispatch: e => gate.beforeDispatch(mode === "copy-before" || mode === "copy-both" ? { ...e } : e),
   dispatch: (e, send) => gate.dispatch(mode === "copy-dispatch" || mode === "copy-both" ? { ...e } : e, send),
  } });
 } });
 const ledgerPath = join(base, "budget.jsonl"), runId = `evidence-${mode}`;
 const result = await new AgentSession({ workspace, dataDir: join(base, "data"), adapter, model: "deepseek-flash", thinking: { enabled: true, effort: "high" }, maxTokens: 64,
  exactInputPreflight: true, budget: new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath }), checkpoints: false, retry: { maxAttempts: 1, baseDelayMs: 0 }, runId,
  limits: { maxRequests: 4, maxTurns: 4, maxInputTokens: 96000, maxOutputTokens: 32768, maxCost: 1 } }).run("Read a.txt.");
 const reread = new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath });
 const snapshot = reread.snapshot({ runId });
 const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
 const records = readFileSync(join(base, "data", "recording.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
 console.log(JSON.stringify({ mode, fetches, status: result.status, reason: result.reason, totals: result.totals, snapshot, ledgerKinds: rows.map(x => x.kind), modelKinds: records.filter(x => x.kind.startsWith("model.")).map(x => x.kind) }));
 return { fetches, result, snapshot, rows, records, globalSpent: reread.globalSpent };
}
for (const mode of ["copy-before", "copy-dispatch", "copy-both"] as const) test(`${mode}: reject before original host gate, no false unknown fee`, async t => {
 const x = await scenario(t, mode);
 assert.equal(x.fetches, 0); assert.equal(x.result.totals.requests, 0); assert.equal(x.result.totals.cost, 0); assert.match(x.result.reason, /EXACT_GATE_REPLACED/);
 assert.equal(x.snapshot.spent, 0); assert.equal(x.snapshot.reserved, 0); assert.equal(x.snapshot.unknownCost, 0); assert.equal(x.globalSpent, 0);
 assert.equal(x.records.filter(r => r.kind === "model.dispatch").length, 0); assert.equal(x.records.filter(r => r.kind === "model.not-sent").length, 1);
 const reserves = x.rows.filter(r => r.kind === "budget.reserve"), settles = x.rows.filter(r => r.kind === "budget.settle");
 assert.equal(reserves.length, mode === "copy-dispatch" ? 1 : 0); assert.equal(settles.length, mode === "copy-dispatch" ? 1 : 0);
 if (mode === "copy-dispatch") { assert.equal(settles[0].amount, 0); assert.equal(settles[0].partial, false); }
});
test("original evidence still records actual known usage once", async t => {
 const x = await scenario(t, "unchanged");
 assert.equal(x.fetches, 1); assert.equal(x.result.status, "completed"); assert.equal(x.result.totals.requests, 1);
 assert.ok(x.snapshot.spent > 0); assert.equal(x.snapshot.spent, x.result.totals.cost); assert.equal(x.snapshot.reserved, 0); assert.equal(x.snapshot.unknownCost, 0);
 assert.equal(x.rows.filter(r => r.kind === "budget.settle").length, 1); assert.equal(x.records.filter(r => r.kind === "model.not-sent").length, 0);
});
test("original evidence followed by stream reset still retains unknown on ledger re-read", async t => {
 const x = await scenario(t, "disconnect");
 assert.equal(x.fetches, 1); assert.equal(x.result.totals.requests, 1); assert.equal(x.result.totals.usagePartialRequests, 1);
 assert.ok(x.snapshot.unknownCost > 0); assert.equal(x.snapshot.spent, x.result.totals.cost); assert.equal(x.snapshot.reserved, 0);
 assert.equal(x.rows.filter(r => r.kind === "budget.settle").length, 1); assert.equal(x.rows.find(r => r.kind === "budget.settle").partial, true);
 assert.equal(x.records.filter(r => r.kind === "model.not-sent").length, 0);
});
