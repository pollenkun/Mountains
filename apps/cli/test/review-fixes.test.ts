import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./env.ts";
import { loadConfig } from "../src/config.ts";

// Regression checks for the 2026-10-22 code review (B01, B05, B16, B17), with a real CLI process.
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const usage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_cache_hit_tokens: 896, prompt_cache_miss_tokens: 104 };

async function provider(t: TestContext, content: string, reported: Record<string, number> = usage) {
	const server = http.createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const model = (JSON.parse(body) as { model: string }).model;
		const chunks = [{ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: reported }];
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(chunks.map((chunk) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n");
	});
	t.after(() => { server.closeAllConnections(); server.close(); });
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
	return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

function setup(t: TestContext, baseUrl: string, model = "deepseek-flash") {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-cli-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"), home = join(root, "home"), config = join(root, "config.json"), ledger = join(root, "spend.jsonl");
	mkdirSync(workspace); mkdirSync(home);
	writeFileSync(config, JSON.stringify({ model, baseUrl, apiKeyEnv: "MOUNTAINS_REVIEW_FIXTURE_KEY", thinking: { enabled: false, effort: "default" },
		maxTokens: 128, retry: { maxAttempts: 1, baseDelayMs: 0 }, checkpoints: false, spendLedger: ledger }));
	const env = { ...isolatedEnv(home), NODE_DISABLE_COMPILE_CACHE: "1", MOUNTAINS_BUDGET: "7", MOUNTAINS_REVIEW_FIXTURE_KEY: "offline-fixture-not-a-real-key" };
	/** Runs the CLI; slow=true reads stdout in small, delayed steps like a busy pipe. */
	const run = (out: string, runId: string, slow = false) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [MAIN, "run", "--task", "answer", "--workspace", workspace, "--config", config, "--out", out, "--json", "--run-id", runId, "--spend-ledger", ledger],
			{ cwd: workspace, env, signal: t.signal, timeout: 30_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk;
			if (slow) { child.stdout.pause(); setTimeout(() => child.stdout.resume(), 2); }
		});
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { root, run };
}

test("B01: the request guard is on by default and can still be turned off explicitly", () => {
	assert.equal(loadConfig(null).config.requestGuard, true);
	assert.equal(loadConfig(null, { requestGuard: false }).config.requestGuard, false);
});

test("B05: a slow pipe receives the whole JSON result before the CLI exits", async (t) => {
	const answer = "x".repeat(1024 * 1024);
	const { root, run } = setup(t, await provider(t, answer));
	const result = await run(join(root, "out"), "review-slow", true);
	assert.equal(result.code, 0, result.stderr);
	const summary = JSON.parse(result.stdout) as { finalText: string };
	assert.equal(summary.finalText.length, answer.length);
});

test("a model served on this computer finishes under the default request guard without cache usage fields", async (t) => {
	// LM Studio reports only prompt/completion totals; the guard is on by default since B01.
	const { root, run } = setup(t, await provider(t, "LOCAL DONE", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }), "qwythos-9b");
	const result = await run(join(root, "out"), "review-local");
	assert.equal(result.code, 0, result.stderr);
	const summary = JSON.parse(result.stdout) as { status: string; finalText: string; totals: { cost: number } };
	assert.equal(summary.status, "completed");
	assert.equal(summary.finalText, "LOCAL DONE");
	assert.equal(summary.totals.cost, 0);
});

test("B16: a second run refuses an output directory that already holds a run", async (t) => {
	const { root, run } = setup(t, await provider(t, "FIRST RESULT"));
	const out = join(root, "shared-out");
	const first = await run(out, "review-first");
	assert.equal(first.code, 0, first.stderr);
	const recording = readFileSync(join(out, "recording.jsonl"), "utf8");
	const second = await run(out, "review-second");
	assert.notEqual(second.code, 0);
	assert.match(second.stderr, /已有上一次运行的记录/);
	assert.equal(readFileSync(join(out, "recording.jsonl"), "utf8"), recording, "the first recording is untouched");
});

test("B17: misspelt nested keys and wrongly typed values stop the configuration from loading", (t) => {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ limits: { maxCosts: 0.001 } }, /limits\.maxCosts/],
		[{ checkpoints: "false" }, /checkpoints/],
		[{ tools: { read: { maxLines: -1, maxLineChars: -1 } } }, /tools\.read\.max/],
		[{ tools: { reed: {} } }, /tools\.reed/],
		[{ retry: { maxAttempt: 2 } }, /retry\.maxAttempt/],
		[{ approval: { fallback: "maybe" } }, /approval\.fallback/],
		[{ thinking: { enabled: "yes" } }, /thinking\.enabled/],
	];
	for (const [config, error] of cases) {
		const path = join(root, "config.json");
		writeFileSync(path, JSON.stringify(config));
		assert.throws(() => loadConfig(path), error, JSON.stringify(config));
	}
	writeFileSync(join(root, "legacy.json"), JSON.stringify({ limits: { maxCostUsd: 2 } }));
	assert.equal(loadConfig(join(root, "legacy.json")).config.limits.maxCost, 2, "the legacy alias still loads");
});

test("approval rules and systemPrompt reject misspelt keys instead of widening or dropping them", (t) => {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const rule = (extra: Record<string, unknown>) => ({ approval: { fallback: "deny", rules: [{ id: "ro", decision: "allow", ...extra }] } });
	const cases: [Record<string, unknown>, RegExp][] = [
		// "risk" instead of "risks" would leave a rule that allows every operation, dangerous ones included.
		[rule({ risk: ["read-only"] }), /approval\.rules\[0\]\.risk/],
		[rule({ risks: ["readonly"] }), /approval\.rules\[0\]\.risks/],
		[rule({ risks: [] }), /approval\.rules\[0\]\.risks/],
		[rule({ pattern: "(" }), /approval\.rules\[0\]\.pattern/],
		[{ approval: { fallback: "deny", rules: [{ id: "x", decision: "allows" }] } }, /approval\.rules\[0\]\.decision/],
		[{ approval: { fallback: "deny", rules: ["allow"] } }, /approval\.rules\[0\]/],
		[{ systemPrompt: { files: "custom.md" } }, /systemPrompt\.files/],
	];
	for (const [config, error] of cases) {
		const path = join(root, "config.json");
		writeFileSync(path, JSON.stringify(config));
		assert.throws(() => loadConfig(path), error, JSON.stringify(config));
	}
	writeFileSync(join(root, "ok.json"), JSON.stringify(rule({ risks: ["read-only"], pattern: "^git status$" })));
	assert.equal(loadConfig(join(root, "ok.json")).config.approval.rules[0]?.id, "ro", "a correct rule still loads");
	writeFileSync(join(root, "prompt.md"), "custom");
	writeFileSync(join(root, "prompt.json"), JSON.stringify({ systemPrompt: { file: "prompt.md" } }));
	assert.equal(loadConfig(join(root, "prompt.json")).systemPrompt, "custom", "a correct prompt file still loads");
});
