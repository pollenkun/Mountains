import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { completeWithExactInputGate, createExactChatCompletionsAdapter, exactInputIdentity, type ModelRequest } from "../src/index.ts";
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const request = (): ModelRequest => ({ model: "deepseek-flash", system: "original", tools: [], messages: [{ role: "user", content: "original question" }], maxTokens: 4096, thinking: { enabled: true, effort: "high" } });
test("input mutation during count cannot change the frozen counted HTTP string", async () => {
 const req = request(); let countedBody = ""; let countCalls = 0; let sentBody = "";
 const adapter = createExactChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "offline", counterIdentity: "a".repeat(64), countInput: async (bytes, parsed) => {
  countCalls++; countedBody = bytes.toString(); bytes.fill(0); parsed.model = "wrong-model"; req.system = "changed"; req.messages[0]!.content = "changed";
  await Promise.resolve(); return 42;
 }, fetch: async (_url, init) => { sentBody = String(init?.body); return Response.json({}, { status: 400 }); } });
 await completeWithExactInputGate(adapter, req, { exactInput: { beforeDispatch: async info => { assert.equal(info.bodySha256, sha(countedBody)); }, dispatch: (_info, send) => send() } });
 assert.equal(sentBody, countedBody); assert.match(sentBody, /original question/); assert.equal(countCalls, 1); assert.equal(exactInputIdentity(adapter), "a".repeat(64));
});
test("missing counter identity and missing final gate are rejected", async () => {
 assert.throws(() => createExactChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "offline", counterIdentity: "", countInput: () => 42 }), /identity/);
 let fetches = 0; const adapter = createExactChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "offline", counterIdentity: "b".repeat(64), countInput: () => 42, fetch: async () => { fetches++; return Response.json({}); } });
 await assert.rejects(adapter.complete(request()), /gate/); assert.equal(fetches, 0);
});
test("a repeated send thunk is refused before a second fetch", async () => {
 let fetches = 0; const adapter = createExactChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "offline", counterIdentity: "b".repeat(64), countInput: () => 42, fetch: async () => { fetches++; return Response.json({}, { status: 400 }); } });
 await completeWithExactInputGate(adapter, request(), { exactInput: { beforeDispatch: async () => {}, dispatch: async (_info, send) => { const response = await send(); assert.throws(() => send(), /already used/); return response; } } });
 assert.equal(fetches, 1);
});

test("serialized validator cannot replace the body being counted", async () => {
 let fetches = 0; let counts = 0;
 const adapter = createExactChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "offline", counterIdentity: "c".repeat(64),
  validateSerializedRequest: (_url, init) => { init.body = "changed after snapshot"; }, countInput: () => { counts++; return 42; },
  fetch: async () => { fetches++; return Response.json({}); } });
 const response = await completeWithExactInputGate(adapter, request(), { exactInput: { beforeDispatch: async () => {}, dispatch: (_info, send) => send() } });
 assert.equal(response.ok, false); assert.equal(fetches, 0); assert.equal(counts, 0);
});
