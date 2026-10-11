import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { isolatedEnv } from "./env.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

type Chunk = Record<string, unknown>;
const sse = (chunks: Chunk[]) => chunks.map((c) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "deepseek-flash", ...c })}\n\n`).join("") + "data: [DONE]\n\n";
const usage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_cache_hit_tokens: 896, prompt_cache_miss_tokens: 104 };
const toolTurn = (id: string, name: string, args: string) =>
	sse([
		{ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "r" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
	]);
const finalTurn = (text: string) =>
	sse([
		{ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "done" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
	]);

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => (stderr += d));
		p.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

describe("mountains run（本地假 DeepSeek 服务，离线）", () => {
	let server: http.Server;
	let port = 0;
	let script: string[] = [];
	const auths: string[] = [];
	const home = mkdtempSync(join(tmpdir(), "cli-home-"));
	before(async () => {
		server = http.createServer(async (req, res) => {
			for await (const _ of req) void _;
			auths.push(String(req.headers.authorization));
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(script.shift() ?? finalTurn("脚本已用完"));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		port = (server.address() as { port: number }).port;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
		rmSync(home, { recursive: true, force: true });
	});

	const baseEnv = () => ({ ...isolatedEnv(home), MOUNTAINS_BUDGET_USD: "5" });

	test("--json：输出结构化结果，写 events/ledger/recording/summary/config，环回地址不需要 Key", async () => {
		const ws = mkdtempSync(join(tmpdir(), "cli-ws-"));
		writeFileSync(join(ws, "a.txt"), "hello\n");
		const out = mkdtempSync(join(tmpdir(), "cli-out-"));
		script = [toolTurn("c1", "file_read", '{"path":"a.txt"}'), toolTurn("c2", "file_edit", '{"path":"a.txt","oldText":"hello","newText":"world"}'), finalTurn("改好了")];
		const r = await runCli(
			["run", "--task", "把 hello 改成 world", "--workspace", ws, "--json", "--out", out, "--run-id", "t-1", "--base-url", `http://127.0.0.1:${port}`, "--spend-ledger", join(out, "spend.jsonl")],
			baseEnv(),
		);
		assert.equal(r.code, 0, r.stderr);
		const summary = JSON.parse(r.stdout);
		assert.equal(summary.status, "completed");
		assert.equal(summary.runId, "t-1");
		assert.equal(summary.finalText, "改好了");
		assert.deepEqual(summary.filesChanged, ["a.txt"]);
		assert.match(summary.configSha256, /^[0-9a-f]{64}$/);
		assert.deepEqual(summary.approvalRules, ["deny-dangerous", "allow-non-dangerous"]);
		assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "world\n");
		for (const f of ["events.jsonl", "ledger.jsonl", "recording.jsonl", "summary.json", "config.json"]) assert.ok(readFileSync(join(out, f), "utf8").length > 0, f);
		assert.equal(auths.at(-1), "Bearer proxy-injected");
		// 回放：同一录制在新工作区得到同样的文件结果
		const ws2 = mkdtempSync(join(tmpdir(), "cli-ws2-"));
		writeFileSync(join(ws2, "a.txt"), "hello\n");
		const rp = await runCli(["replay", "--recording", join(out, "recording.jsonl"), "--workspace", ws2, "--json", "--out", mkdtempSync(join(tmpdir(), "cli-rp-"))], baseEnv());
		assert.equal(rp.code, 0, rp.stderr);
		assert.equal(readFileSync(join(ws2, "a.txt"), "utf8"), "world\n");
	});

	test("MOUNTAINS_HOME relocates default runs, replay output, spend ledger and project archives", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "cli-state-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const state = join(root, "state with spaces");
		const env = { ...baseEnv(), MOUNTAINS_HOME: state, NODE_DISABLE_COMPILE_CACHE: "1" };
		script = [finalTurn("portable state")];
		const run = await runCli(["run", "--task", "x", "--workspace", root, "--json", "--run-id", "portable", "--base-url", `http://127.0.0.1:${port}`], env);
		assert.equal(run.code, 1, "state inside the workspace must still be rejected");
		assert.match(run.stderr, /任务工作区之外/);
		const workspace = mkdtempSync(join(tmpdir(), "cli-state-workspace-"));
		t.after(() => rmSync(workspace, { recursive: true, force: true }));
		const result = await runCli(["run", "--task", "x", "--workspace", workspace, "--json", "--run-id", "portable", "--base-url", `http://127.0.0.1:${port}`], env);
		assert.equal(result.code, 0, result.stderr);
		const summary = JSON.parse(result.stdout);
		assert.equal(summary.outDir, join(state, "runs", "portable"));
		assert.ok(existsSync(join(state, "spend.jsonl")));
		assert.equal(readdirSync(join(state, "projects")).length, 1);
		const replay = await runCli(["replay", "--recording", join(summary.outDir, "recording.jsonl"), "--workspace", workspace, "--json"], env);
		assert.equal(replay.code, 0, replay.stderr);
		const replaySummary = JSON.parse(replay.stdout);
		assert.equal(replaySummary.outDir, join(state, "replays", readdirSync(join(state, "replays"))[0]!));
	});

	test("an explicitly configured default ledger path wins over MOUNTAINS_HOME", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "cli-explicit-ledger-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const home = join(root, "home"), workspace = join(root, "workspace"), state = join(root, "state");
		mkdirSync(home); mkdirSync(workspace);
		const config = join(root, "config.json");
		writeFileSync(config, JSON.stringify({ spendLedger: "~/.mountains/spend.jsonl", checkpoints: false }));
		script = [finalTurn("explicit ledger")];
		const result = await runCli(["run", "--task", "x", "--workspace", workspace, "--json", "--config", config, "--base-url", `http://127.0.0.1:${port}`], {
			...isolatedEnv(home), MOUNTAINS_HOME: state, MOUNTAINS_BUDGET_USD: "5", NODE_DISABLE_COMPILE_CACHE: "1",
		});
		assert.equal(result.code, 0, result.stderr);
		assert.ok(existsSync(join(home, ".mountains", "spend.jsonl")));
		assert.equal(existsSync(join(state, "spend.jsonl")), false);
		assert.ok(existsSync(join(state, "runs")));
	});

	test("relocating a legacy default ledger requires explicit migration or selection before HTTP", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "cli-ledger-migration-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const home = join(root, "home"), workspace = join(root, "workspace"), state = join(root, "state");
		mkdirSync(join(home, ".mountains"), { recursive: true }); mkdirSync(workspace);
		const legacy = join(home, ".mountains", "spend.jsonl"), relocated = join(state, "spend.jsonl");
		const history = `${JSON.stringify({ at: "2026-01-01T00:00:00Z", runId: "previous", requestId: "previous", amount: 1, currency: "USD", partial: false })}\n`;
		writeFileSync(legacy, history);
		const env = { ...isolatedEnv(home), MOUNTAINS_HOME: state, MOUNTAINS_BUDGET_USD: "5", NODE_DISABLE_COMPILE_CACHE: "1" };
		const args = ["run", "--task", "x", "--workspace", workspace, "--json", "--base-url", `http://127.0.0.1:${port}`];
		const requestsBefore = auths.length;
		const blocked = await runCli(args, env);
		assert.equal(blocked.code, 1, blocked.stderr);
		assert.match(blocked.stderr, /旧累计花费台账/);
		assert.match(blocked.stderr, /--spend-ledger/);
		assert.ok(blocked.stderr.includes(legacy) && blocked.stderr.includes(relocated));
		assert.equal(auths.length, requestsBefore, "migration warning must precede all HTTP requests");
		assert.equal(readFileSync(legacy, "utf8"), history, "legacy history must not be modified");
		assert.equal(existsSync(state), false, "migration warning must not create replacement state");

		script = [finalTurn("keep the existing ledger")];
		const explicit = await runCli([...args, "--spend-ledger", legacy], env);
		assert.equal(explicit.code, 0, explicit.stderr);
		assert.ok(JSON.parse(explicit.stdout).budget.globalSpent > 1);
		assert.equal(existsSync(relocated), false);

		// Simulate a user-supplied ledger at the relocated destination.
		writeFileSync(relocated, history);
		script = [finalTurn("use the relocated ledger")];
		const migrated = await runCli(args, env);
		assert.equal(migrated.code, 0, migrated.stderr);
		assert.ok(JSON.parse(migrated.stdout).budget.globalSpent > 1);
	});

	test("非环回地址且没有 Key：用法错误退出 2，不发请求", async () => {
		const ws = mkdtempSync(join(tmpdir(), "cli-ws-"));
		const before = auths.length;
		const r = await runCli(["run", "--task", "x", "--workspace", ws, "--base-url", "https://example.invalid", "--out", mkdtempSync(join(tmpdir(), "o-"))], baseEnv());
		assert.equal(r.code, 2);
		assert.match(r.stderr, /DEEPSEEK_API_KEY 未设置/);
		assert.equal(auths.length, before);
	});

	test("预算不足：退出码 3", async () => {
		const ws = mkdtempSync(join(tmpdir(), "cli-ws-"));
		const out = mkdtempSync(join(tmpdir(), "cli-out-"));
		const r = await runCli(["run", "--task", "x", "--workspace", ws, "--json", "--out", out, "--base-url", `http://127.0.0.1:${port}`, "--spend-ledger", join(out, "s.jsonl")], {
			...baseEnv(),
			MOUNTAINS_BUDGET_USD: "0.0001",
		});
		assert.equal(r.code, 3, r.stderr);
		assert.equal(JSON.parse(r.stdout).status, "limit");
	});
});

describe("配置", () => {
	test("深合并、数组整体替换、拒绝 apiKey、哈希随内容变化", () => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-"));
		const p = join(dir, "c.json");
		writeFileSync(p, JSON.stringify({ thinking: { effort: "max" }, approval: { rules: [{ id: "only", decision: "deny" }] } }));
		const a = loadConfig(p);
		assert.deepEqual(a.config.thinking, { enabled: true, effort: "max" });
		assert.deepEqual(a.config.approval.rules.map((r) => r.id), ["only"]);
		assert.equal(a.config.approval.fallback, "deny");
		writeFileSync(p, JSON.stringify({ thinking: { effort: "low" } }));
		assert.notEqual(loadConfig(p).sha256, a.sha256);
		writeFileSync(p, JSON.stringify({ apiKey: "x" }));
		assert.throws(() => loadConfig(p), /不允许包含 apiKey/);
		writeFileSync(join(dir, "prompt.md"), "自定义提示");
		writeFileSync(p, JSON.stringify({ systemPrompt: { file: "prompt.md" } }));
		assert.equal(loadConfig(p).systemPrompt, "自定义提示");
	});

	test("按模型推断供应商的基址与 Key 变量；思考设置按能力表校验；旧字段 maxCostUsd 换成 maxCost", () => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-"));
		const p = join(dir, "c.json");
		assert.equal(loadConfig(null).config.baseUrl, "https://api.deepseek.com");
		assert.equal(loadConfig(null).config.apiKeyEnv, "DEEPSEEK_API_KEY");
		writeFileSync(p, JSON.stringify({ model: "glm-5.3-flash", thinking: { effort: "default" }, limits: { maxCostUsd: 2 } }));
		const g = loadConfig(p).config;
		assert.equal(g.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
		assert.equal(g.apiKeyEnv, "ZHIPU_API_KEY");
		assert.equal(g.limits.maxCost, 2);
		assert.equal((g.limits as unknown as Record<string, unknown>).maxCostUsd, undefined);
		writeFileSync(p, JSON.stringify({ model: "kimi-k2.7-code", thinking: { effort: "default" } }));
		assert.equal(loadConfig(p).config.apiKeyEnv, "MOONSHOT_API_KEY");
		writeFileSync(p, JSON.stringify({ model: "kimi-k2.7-code", thinking: { effort: "high" } }));
		assert.throws(() => loadConfig(p), /不支持 reasoning_effort/);
		writeFileSync(p, JSON.stringify({ model: "some-unknown-model" }));
		assert.throws(() => loadConfig(p), /无法由模型/);
	});
});
