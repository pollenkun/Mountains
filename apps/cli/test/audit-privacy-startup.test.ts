import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnv } from "./env.ts";
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
test("help/version do not import engine/providers even when run options request help", t => {
 const root = mkdtempSync(join(tmpdir(), "mountains-help-lazy-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const preload = join(root, "block-runtime.mjs");
 writeFileSync(preload, `import{registerHooks}from'node:module';registerHooks({resolve(spec,ctx,next){if(spec.includes('cli-main')||spec.includes('@mountains/engine')||spec.includes('@mountains/providers'))throw Error('help imported runtime');return next(spec,ctx)}});`);
 for (const args of [["--help"], ["--version"], ["run", "--help", "--config", "missing"], ["replay", "-h", "--recording", "missing"]]) {
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, MAIN, ...args], { encoding: "utf8", env: isolatedEnv(root), timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert(result.stdout.length > 0);
 }
});
test("CLI events and recording both redact known secrets from offline replay", t => {
 const root = mkdtempSync(join(tmpdir(), "mountains-cli-private-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const workspace = join(root, "workspace"), out = join(root, "out"); mkdirSync(workspace);
 const secret = "fixture-only-secret-0123456789", recording = join(root, "input.jsonl");
 writeFileSync(recording, [{ kind: "meta", data: { model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 16 } }, { kind: "user.input", data: { task: `Keep ${secret} private` } }, { kind: "model.response", data: { ok: true, message: { role: "assistant", content: "done", reasoning: "", toolCalls: [] }, finishReason: "stop", responseModel: "deepseek-flash", rawUsage: { prompt_tokens: 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1, completion_tokens: 1, total_tokens: 2 }, httpStatus: 200, error: null, aborted: false } }].map(value => JSON.stringify(value)).join("\n") + "\n");
 // This is a privacy assertion, not a cold-start latency threshold. Native Windows
 // checkpoint startup can exceed ten seconds under the parallel test runner.
 const result = spawnSync(process.execPath, [MAIN, "replay", "--recording", recording, "--workspace", workspace, "--out", out, "--json"], { encoding: "utf8", env: { ...isolatedEnv(join(root, "home")), TEST_SECRET_TOKEN: secret }, timeout: 30_000 });
 assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
 for (const name of ["events.jsonl", "recording.jsonl"]) { const text = readFileSync(join(out, name), "utf8"); assert(!text.includes(secret), name); assert(text.includes("[REDACTED]"), name); }
});
