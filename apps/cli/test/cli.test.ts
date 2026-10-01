import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";

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
	});

	const baseEnv = () => {
		const env: NodeJS.ProcessEnv = { ...process.env, MOUNTAINS_BUDGET_USD: "5" };
		delete env.DEEPSEEK_API_KEY;
		return env;
	};

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
