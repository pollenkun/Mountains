import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { estimateCost } from "../src/pricing.ts";
import { ApprovalChatAdapter } from "../src/approval-chat.ts";

for (const [profile, model] of [["deepseek", "deepseek-flash"]] as const) {
 test(`${profile} approval preserves contradictory raw prompt partial status`, async () => {
  const adapter = new ApprovalChatAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", profile,
   fetch: async () => new Response(JSON.stringify({ model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"decision":"allow"}' } }], usage: { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 10, total_tokens: 110 } }), { headers: { "content-type": "application/json" } }) });
  const response = await adapter.complete({ model, system: "fixture", tools: [], messages: [{ role: "user", content: "fixture" }], thinking: { enabled: true, effort: "default" }, maxTokens: 16 });
  assert.equal(response.ok, true); assert.equal(response.usage.partial, true);
 });
}

test("completed SSE capture clears its fallback timer and lets the embedding process exit", async () => {
 const source = new URL("../src/chat-completions.ts", import.meta.url).href;
 const script = `import{ChatCompletionsAdapter}from ${JSON.stringify(source)};let completedAt=0;process.on('exit',()=>console.log(JSON.stringify({exitDelay:Date.now()-completedAt})));const chunk={id:'fixture',model:'deepseek-flash',choices:[{index:0,delta:{role:'assistant',content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:1,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:1,completion_tokens:1,total_tokens:2}};const a=new ChatCompletionsAdapter({baseUrl:'http://127.0.0.1:1',apiKey:'fixture-only',fetch:async()=>new Response('data: '+JSON.stringify(chunk)+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}})});const r=await a.complete({model:'deepseek-flash',system:'fixture',tools:[],messages:[{role:'user',content:'fixture'}],thinking:{enabled:false,effort:'default'},maxTokens:16});if(!r.ok)throw Error('fixture failed');completedAt=Date.now();`;
 const result = await new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }); let output = "", error = "";
  const timer = setTimeout(() => { child.kill(); reject(new Error("child did not exit")); }, 10_000);
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; }); child.on("error", reject);
  child.on("close", code => { clearTimeout(timer); resolve({ code, output, error }); });
 });
 assert.equal(result.code, 0, result.error); assert(JSON.parse(result.output).exitDelay < 1000, result.output);
});


test("pricing cannot relabel contradictory native usage as a complete cheap estimate", () => {
 const estimate = estimateCost("deepseek-flash", { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 10, total_tokens: 110 }, new Date("2026-10-11T12:00:00Z"));
 assert.equal(estimate?.partial, true); assert(estimate!.amount > 0.1);
});
