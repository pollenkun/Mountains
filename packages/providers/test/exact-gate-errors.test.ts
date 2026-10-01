import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncResource } from "node:async_hooks";
import { completeWithExactInputGate, createExactChatCompletionsAdapter, preserveExactInputCapability, type ExactChatOptions, type ExactInputDispatch, type ModelAdapter, type ModelRequest } from "../src/index.ts";
const request = (): ModelRequest => ({ model: "deepseek-flash", system: "s", tools: [], messages: [{ role: "user", content: "q" }], thinking: { enabled: true, effort: "high" }, maxTokens: 64 });
const control = (): ExactInputDispatch => ({ beforeDispatch: async () => {}, dispatch: (_e, send) => send() });
function fixture(options: Partial<ExactChatOptions> = {}) {
 let fetches = 0;
 const adapter = createExactChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "offline", counterIdentity: "e".repeat(64), countInput: () => 50,
  fetch: async () => { fetches++; return Response.json({}, { status: 400 }); }, ...options });
 return { adapter, fetches: () => fetches };
}
for (const [name, options, code] of [
 ["counter exception", { countInput: () => { throw new Error("sk-fake-key PRIVATE_BODY /private/path"); } }, "INPUT_COUNTER_FAILED"],
 ["invalid count", { countInput: () => NaN }, "INPUT_COUNTER_INVALID"],
 ["frozen body mutation", { validateSerializedRequest: (_u, init) => { init.body = "changed PRIVATE_BODY"; } }, "SERIALIZED_REQUEST_REJECTED"],
 ["counter timeout", { countInput: () => new Promise<number>(() => {}), countTimeoutMs: 5 }, "INPUT_COUNTER_TIMEOUT"],
] satisfies [string, Partial<ExactChatOptions>, string][]) test(`${name} is safe and non-retryable before transport`, async () => {
 const f = fixture(options); const r = await completeWithExactInputGate(f.adapter, request(), { exactInput: control() });
 assert.equal(r.ok, false); assert.equal(r.error?.retryable, false); assert.match(r.error!.message, new RegExp(code)); assert.equal(f.fetches(), 0);
 assert.doesNotMatch(JSON.stringify(r), /sk-fake-key|PRIVATE_BODY|private\/path|Connection error/);
});
test("snapshot and pre-fetch request construction errors are not network errors", async () => {
 for (const phase of ["snapshot", "build"] as const) {
  const f = fixture(); const req = request();
  if (phase === "snapshot") (req as unknown as { extra: unknown }).extra = () => "PRIVATE_BODY";
  else req.messages = null as unknown as ModelRequest["messages"];
  const r = await completeWithExactInputGate(f.adapter, req, { exactInput: control() });
  assert.equal(f.fetches(), 0); assert.equal(r.error?.retryable, false);
  assert.match(r.error!.message, phase === "snapshot" ? /REQUEST_SNAPSHOT_FAILED/ : /REQUEST_BUILD_FAILED/);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_BODY|Connection error/);
 }
});
test("host gate errors are safe, and late timeout resolution cannot dispatch", async () => {
 const f = fixture(); const r = await completeWithExactInputGate(f.adapter, request(), { exactInput: { beforeDispatch: async () => { throw new Error("PRIVATE_BODY"); }, dispatch: (_e, send) => send() } });
 assert.match(r.error!.message, /HOST_GATE_REJECTED/); assert.equal(r.error?.retryable, false); assert.equal(f.fetches(), 0); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_BODY/);
 let release!: (n: number) => void;
 const g = fixture({ countTimeoutMs: 5, countInput: () => new Promise<number>(resolve => { release = resolve; }) });
 const timed = await completeWithExactInputGate(g.adapter, request(), { exactInput: control() });
 release(50); await new Promise(r => setTimeout(r, 10));
 assert.match(timed.error!.message, /INPUT_COUNTER_TIMEOUT/); assert.equal(g.fetches(), 0);
});
test("same counter identity cannot substitute a different terminal", async () => {
 const a = fixture(), b = fixture();
 const wrapper = preserveExactInputCapability(a.adapter, { id: "wrong-terminal", complete: (req, handlers) => b.adapter.complete(req, handlers) });
 await assert.rejects(completeWithExactInputGate(wrapper, request(), { exactInput: control() }), /EXACT_GATE_REQUIRED/);
 assert.equal(a.fetches() + b.fetches(), 0);
});
test("wrapper cannot mutate the bound gate or rebind a nested call", async () => {
 const f = fixture();
 const wrapper = preserveExactInputCapability(f.adapter, { id: "mutator", complete(req, h) {
  assert.throws(() => { h!.exactInput!.dispatch = (_e, send) => send(); }, TypeError);
  return completeWithExactInputGate(f.adapter, req, { exactInput: control() });
 } });
 await assert.rejects(completeWithExactInputGate(wrapper, request(), { exactInput: control() }), /EXACT_GATE_REQUIRED/); assert.equal(f.fetches(), 0);
});
test("detached asynchronous resources cannot silently fall back to a fresh gate", async () => {
 const outside = new AsyncResource("outside-exact-call"); const f = fixture();
 try {
  const wrapper = preserveExactInputCapability(f.adapter, { id: "detached", complete: (req, h) => outside.runInAsyncScope(() => f.adapter.complete(req, h)) });
  await assert.rejects(completeWithExactInputGate(wrapper, request(), { exactInput: control() }), /EXACT_GATE_REQUIRED/); assert.equal(f.fetches(), 0);
 } finally { outside.emitDestroy(); }
});
test("one call cannot enter two terminals and a captured send cannot run later", async () => {
 const f = fixture(); let duplicate: Promise<unknown> | undefined; let captured!: () => Promise<Response>;
 const wrapper: ModelAdapter = preserveExactInputCapability(f.adapter, { id: "duplicate", async complete(req, h) {
  const first = f.adapter.complete(req, h); duplicate = assert.rejects(f.adapter.complete(req, h), /EXACT_CALL_CLOSED/); return first;
 } });
 await completeWithExactInputGate(wrapper, request(), { exactInput: { beforeDispatch: async () => {}, dispatch: (_e, send) => { captured = send; return send(); } } });
 await duplicate; assert.equal(f.fetches(), 1); assert.throws(() => captured(), /EXACT_CALL_CLOSED/); assert.equal(f.fetches(), 1);
});
