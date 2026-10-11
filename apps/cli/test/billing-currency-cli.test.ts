import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolatedEnv } from "./env.ts";
import { describe, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunSummary } from "@mountains/engine";
import { estimateCost, normalizeUsage, pricingFor, providerOf, type Currency, type RawUsage } from "@mountains/providers";
import type { LedgerRecord } from "@mountains/telemetry";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
// The default configuration's hash: a change here means the default configuration changed.
const DEFAULT_SHA = "967d3db22c6a4962712b9b6d65dee8dfe7bfb46971fc262564259f03acab7bbf";
const OPTIONAL_FIELDS = ["billingCurrency"] as const;
const DEEPSEEK_USAGE: RawUsage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020,
	prompt_cache_hit_tokens: 896, prompt_cache_miss_tokens: 104, completion_tokens_details: { reasoning_tokens: 5 } };
const GLM_USAGE: RawUsage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020,
	prompt_tokens_details: { cached_tokens: 896 }, completion_tokens_details: { reasoning_tokens: 5 } };
const KIMI_USAGE: RawUsage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020,
	prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 96 }, completion_tokens_details: { reasoning_tokens: 5 } };

interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface RecordedRow { kind: string; data: Record<string, unknown> }
type CliSummary = RunSummary & { configSha256?: string; outDir: string; budget?: { globalLimit: number; globalSpent: number; currency: string } };

function temporaryRoot(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-billing-currency-cli-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function runCli(t: TestContext, args: string[], workspace: string, envName: string, globalBudget = true): Promise<CommandResult> {
	// Pass only process essentials and fixture settings. Never inherit model Keys or proxy settings.
	const home = join(dirname(workspace), "home");
	mkdirSync(home, { recursive: true });
	const env: NodeJS.ProcessEnv = { ...isolatedEnv(home),
		...(globalBudget ? { MOUNTAINS_BUDGET: "7" } : {}), MOUNTAINS_BUDGET_USD: "7", [envName]: "offline-billing-fixture-not-a-real-key" };
	assert.equal(env.HOME, home);
	assert.equal(env.USERPROFILE, home);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [MAIN, ...args], { cwd: workspace, env, signal: t.signal,
			timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		let failure: Error | undefined;
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => { failure = error; });
		child.on("close", (code, signal) => failure ? reject(failure) : resolve({ code, signal, stdout, stderr }));
	});
}

async function localProvider(t: TestContext, model: string, usage: RawUsage) {
	const requests: { path: string | undefined; body: Record<string, unknown>; authorization: string | undefined }[] = [];
	const errors: unknown[] = [];
	const server = http.createServer(async (request, response) => {
		try {
			let body = "";
			for await (const chunk of request) body += chunk;
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/v1/chat/completions");
			const parsed = JSON.parse(body) as Record<string, unknown>;
			requests.push({ path: request.url, body: parsed, authorization: request.headers.authorization });
			assert.equal(parsed.model, model);
			const chunks = [
				{ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "[本地接口测试]" }, finish_reason: null }] },
				{ choices: [{ index: 0, delta: { content: "offline billing response" }, finish_reason: null }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
			];
			const sse = chunks.map((chunk) => `data: ${JSON.stringify({ id: "offline-billing", object: "chat.completion.chunk", model, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n";
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(sse);
		} catch (error) {
			errors.push(error);
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "local fixture rejected the request" } }));
		}
	});
	t.after(async () => {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address === "object");
	assert.equal(address.address, "127.0.0.1");
	return { url: `http://127.0.0.1:${address.port}/v1`, requests, errors };
}

function fixture(t: TestContext, root: string, baseUrl: string, model = "deepseek-flash") {
	const workspace = join(root, "workspace");
	const configPath = join(root, "config.json");
	const spendPath = join(root, "spend.jsonl");
	const envName = `MOUNTAINS_BILLING_FIXTURE_${randomUUID().replaceAll("-", "_")}`;
	mkdirSync(workspace);
	writeFileSync(join(workspace, "README.md"), "Local billing fixture; no tool changes are required.\n");
	let pending: Promise<unknown> = Promise.resolve();
	t.after(async () => { await pending.catch(() => {}); });
	return {
		workspace, configPath, spendPath,
		async run(overrides: Record<string, unknown> = {}, name = "run", globalBudget = true) {
			const out = join(root, name);
			writeFileSync(configPath, JSON.stringify({ model, baseUrl, apiKeyEnv: envName,
				thinking: { enabled: true, effort: "default" }, maxTokens: 128, limits: { maxCost: 1 },
				requestGuard: true, retry: { maxAttempts: 1, baseDelayMs: 0 }, checkpoints: false, spendLedger: spendPath, ...overrides }));
			const running = runCli(t, ["run", "--task", "Return the local billing fixture response.", "--workspace", workspace,
				"--config", configPath, "--out", out, "--json", "--run-id", `billing-${name}`, "--spend-ledger", spendPath], workspace, envName, globalBudget);
			pending = running;
			return { ...await running, out };
		},
		async replay(recording: string, name = "replay") {
			const out = join(root, name);
			const replayWorkspace = join(root, `${name}-workspace`);
			mkdirSync(replayWorkspace);
			writeFileSync(join(replayWorkspace, "README.md"), "Fresh offline replay workspace.\n");
			const running = runCli(t, ["replay", "--recording", recording, "--workspace", replayWorkspace, "--out", out, "--json"], replayWorkspace, envName);
			pending = running;
			return { ...await running, out };
		},
	};
}

function jsonLines<T>(path: string): T[] {
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function assertAccounting(out: string, summary: CliSummary, model: string, usage: RawUsage, billingCurrency?: Currency) {
	const price = pricingFor(model, billingCurrency);
	assert.ok(price);
	const ledger = jsonLines<LedgerRecord>(join(out, "ledger.jsonl"));
	assert.equal(ledger.length, 1);
	const entry = ledger[0]!;
	const expected = estimateCost(model, usage, new Date(entry.startedAt), billingCurrency);
	assert.ok(expected && !expected.partial);
	assert.equal(entry.currency, price.currency);
	assert.deepEqual(entry.rawUsage, usage);
	assert.deepEqual(entry.usage, normalizeUsage(providerOf(model)!, usage));
	assert.equal(entry.costPartial, false);
	assert.equal(entry.priceVersion, expected.priceVersion);
	assert.equal(entry.pricePeriod, expected.period);
	assert.ok(Math.abs(entry.cost - expected.amount) < 1e-12);
	assert.equal(summary.status, "completed");
	assert.equal(summary.totals.requests, 1);
	assert.equal(summary.totals.currency, price.currency);
	assert.equal(summary.totals.reasoning, 5);
	assert.ok(Math.abs(summary.totals.cost - expected.amount) < 1e-12);
	assert.deepEqual(JSON.parse(readFileSync(join(out, "summary.json"), "utf8")), summary);
	const events = jsonLines<Record<string, unknown>>(join(out, "events.jsonl"));
	const event = events.find((row) => row.type === "usage")!;
	assert.equal(event.currency, price.currency);
	assert.equal(event.cost, entry.cost);
	assert.deepEqual(event.usage, entry.usage);
	const recording = jsonLines<RecordedRow>(join(out, "recording.jsonl"));
	const meta = recording.find((row) => row.kind === "meta")!.data;
	assert.equal(meta.model, model);
	assert.equal(Object.hasOwn(meta, "billingCurrency"), billingCurrency !== undefined);
	assert.equal(meta.billingCurrency, billingCurrency);
	const response = recording.find((row) => row.kind === "model.response")!.data;
	assert.deepEqual(response.rawUsage, usage);
	const recordedUsage = recording.find((row) => row.kind === "engine.event" && row.data.type === "usage")!.data;
	assert.equal(recordedUsage.currency, price.currency);
	assert.equal(recordedUsage.cost, entry.cost);
	return { entry, expected };
}

function assertBudget(path: string, currency: Currency, amount: number) {
	const rows = jsonLines<Record<string, unknown>>(path);
	assert.ok(rows.length > 0);
	assert.ok(rows.every((row) => row.currency === currency));
	const charges = rows.filter((row) => typeof row.amount === "number");
	assert.equal(charges.length, 1);
	assert.equal(charges[0]!.partial, false);
	assert.ok(Math.abs((charges[0]!.amount as number) - amount) < 1e-12);
}

describe("CLI billing currency（真实子进程与本地环回 HTTP）", { concurrency: false, timeout: 120_000 }, () => {
	test("省略新字段时默认配置和固定哈希完全保留", () => {
		const loaded = loadConfig(null);
		assert.equal(loaded.sha256, DEFAULT_SHA);
		for (const key of OPTIONAL_FIELDS) {
			assert.equal(Object.hasOwn(DEFAULT_CONFIG, key), false);
			assert.equal(Object.hasOwn(loaded.config, key), false);
		}
	});

	test("旧 USD 预算别名与 maxCost 的配置及哈希一致", (t) => {
		const root = temporaryRoot(t);
		const path = join(root, "config.json");
		writeFileSync(path, JSON.stringify({ limits: { maxCostUsd: 2 } }));
		const legacy = loadConfig(path);
		writeFileSync(path, JSON.stringify({ limits: { maxCost: 2 } }));
		const current = loadConfig(path);
		assert.deepEqual(legacy.config, current.config);
		assert.equal(legacy.sha256, current.sha256);
		assert.equal(legacy.config.limits.maxCost, 2);
		assert.equal(Object.hasOwn(legacy.config.limits, "maxCostUsd"), false);
		writeFileSync(path, JSON.stringify({ billingCurrency: "USD", limits: { maxCostUsd: 2 } }));
		const disabled = loadConfig(path).config;
		assert.equal(disabled.billingCurrency, "USD");
	});

	for (const [model, usage] of [["deepseek-flash", DEEPSEEK_USAGE], ["deepseek-v4-pro", DEEPSEEK_USAGE], ["glm-5.3-flash", GLM_USAGE], ["kimi-k2.7-code", KIMI_USAGE]] as const) {
		test(`${model}: CNY run prices the actual response consistently and replay sends no HTTP`, async (t) => {
			const root = temporaryRoot(t);
			const upstream = await localProvider(t, model, usage);
			const cli = fixture(t, root, upstream.url, model);
			const result = await cli.run({ billingCurrency: "CNY" });
			assert.equal(result.code, 0, result.stderr);
			assert.equal(result.signal, null);
			assert.equal(upstream.requests.length, 1);
			assert.deepEqual(upstream.errors, []);
			assert.equal(upstream.requests[0]!.authorization, "Bearer offline-billing-fixture-not-a-real-key");
			const summary = JSON.parse(result.stdout) as CliSummary;
			const { expected } = assertAccounting(result.out, summary, model, usage, "CNY");
			assert.ok(summary.budget);
			assert.equal(summary.budget.currency, "CNY");
			assert.equal(summary.budget.globalLimit, 7);
			assert.ok(Math.abs(summary.budget.globalSpent - expected.amount) < 1e-12);
			assertBudget(cli.spendPath, "CNY", expected.amount);
			const saved = JSON.parse(readFileSync(join(result.out, "config.json"), "utf8")) as { config: Record<string, unknown>; sha256: string };
			assert.equal(saved.config.billingCurrency, "CNY");
			assert.equal(saved.sha256, summary.configSha256);
			assert.equal(saved.sha256, loadConfig(cli.configPath).sha256);
			const replay = await cli.replay(join(result.out, "recording.jsonl"));
			assert.equal(replay.code, 0, replay.stderr);
			assert.equal(upstream.requests.length, 1, "Offline replay must not make an additional HTTP request");
			const replaySummary = JSON.parse(replay.stdout) as CliSummary;
			const replayAccounting = assertAccounting(replay.out, replaySummary, model, usage, "CNY");
			assert.equal(replaySummary.finalText, summary.finalText);
			assert.ok(Math.abs(replayAccounting.expected.amount - expected.amount) < 1e-12);
			assertBudget(join(replay.out, "replay-spend.jsonl"), "CNY", replayAccounting.expected.amount);
			assertBudget(cli.spendPath, "CNY", expected.amount);
		});
	}

	for (const billingCurrency of [undefined, "USD"] as const) {
		test(`DeepSeek ${billingCurrency ?? "omitted currency"} preserves the legacy USD price and budget alias`, async (t) => {
			const root = temporaryRoot(t);
			const upstream = await localProvider(t, "deepseek-flash", DEEPSEEK_USAGE);
			const cli = fixture(t, root, upstream.url);
			const result = await cli.run({ ...(billingCurrency ? { billingCurrency } : {}), limits: { maxCostUsd: 2 } });
			assert.equal(result.code, 0, result.stderr);
			assert.equal(upstream.requests.length, 1);
			const summary = JSON.parse(result.stdout) as CliSummary;
			const { expected } = assertAccounting(result.out, summary, "deepseek-flash", DEEPSEEK_USAGE, billingCurrency);
			assert.equal(expected.currency, "USD");
			assert.equal(expected.priceVersion, pricingFor("deepseek-flash")!.version);
			assert.equal(summary.budget?.currency, "USD");
			assertBudget(cli.spendPath, "USD", expected.amount);
			const replay = await cli.replay(join(result.out, "recording.jsonl"));
			assert.equal(replay.code, 0, replay.stderr);
			assert.equal(upstream.requests.length, 1);
			const replayAccounting = assertAccounting(replay.out, JSON.parse(replay.stdout) as CliSummary, "deepseek-flash", DEEPSEEK_USAGE, billingCurrency);
			assertBudget(join(replay.out, "replay-spend.jsonl"), "USD", replayAccounting.expected.amount);
		});
	}

	test("GLM 省略币种时继续使用历史人民币表和旧默认预算", async (t) => {
		const root = temporaryRoot(t);
		const upstream = await localProvider(t, "glm-5.3-flash", GLM_USAGE);
		const cli = fixture(t, root, upstream.url, "glm-5.3-flash");
		const result = await cli.run({ limits: {} });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(upstream.requests.length, 1);
		const summary = JSON.parse(result.stdout) as CliSummary;
		const { expected } = assertAccounting(result.out, summary, "glm-5.3-flash", GLM_USAGE);
		assert.equal(expected.currency, "CNY");
		assert.equal(expected.priceVersion, pricingFor("glm-5.3-flash")!.version);
		assert.notEqual(expected.priceVersion, pricingFor("glm-5.3-flash", "CNY")!.version);
		assert.equal(summary.budget?.currency, "CNY");
		assertBudget(cli.spendPath, "CNY", expected.amount);
	});

	test("人民币任务预算太低时在发送 HTTP 前停止", async (t) => {
		const root = temporaryRoot(t);
		const upstream = await localProvider(t, "deepseek-flash", DEEPSEEK_USAGE);
		const cli = fixture(t, root, upstream.url);
		const result = await cli.run({ billingCurrency: "CNY", limits: { maxCost: 1e-12 } });
		assert.equal(result.code, 3, result.stderr);
		assert.equal(upstream.requests.length, 0);
		assert.deepEqual(upstream.errors, []);
		const summary = JSON.parse(result.stdout) as CliSummary;
		assert.equal(summary.status, "limit");
		assert.equal(summary.totals.requests, 0);
		assert.equal(summary.totals.cost, 0);
		assert.equal(summary.totals.currency, "CNY");
		assert.equal(summary.budget?.currency, "CNY");
		assert.equal(summary.budget?.globalSpent, 0);
		assert.equal(existsSync(join(result.out, "ledger.jsonl")), false);
	});

	test("只有美元环境预算时，人民币任务不能借用这个上限", async (t) => {
		const root = temporaryRoot(t);
		const upstream = await localProvider(t, "deepseek-flash", DEEPSEEK_USAGE);
		const cli = fixture(t, root, upstream.url);
		const result = await cli.run({ billingCurrency: "CNY" }, "usd-env-only", false);
		assert.equal(result.code, 1, result.stderr);
		assert.match(result.stderr, /CNY.*MOUNTAINS_BUDGET|MOUNTAINS_BUDGET.*CNY/);
		assert.equal(upstream.requests.length, 0);
		assert.deepEqual(upstream.errors, []);
		assert.equal(existsSync(cli.spendPath), false);
		assert.equal(existsSync(join(result.out, "ledger.jsonl")), false);
	});

	const invalidConfigs: { name: string; values: Record<string, unknown>; error: RegExp }[] = [
		{ name: "unknown currency", values: { billingCurrency: "EUR" }, error: /billingCurrency|币种/ },
		{ name: "lowercase currency", values: { billingCurrency: "cny" }, error: /billingCurrency|币种/ },
		{ name: "null currency", values: { billingCurrency: null }, error: /billingCurrency|币种/ },
		{ name: "GLM has no USD quotation", values: { model: "glm-5.3-flash", billingCurrency: "USD" }, error: /报价|价格/ },
		{ name: "CNY cannot inherit a default cap", values: { billingCurrency: "CNY", limits: {} }, error: /maxCost|预算/ },
		{ name: "CNY cannot use the USD cap alias", values: { billingCurrency: "CNY", limits: { maxCostUsd: 2 } }, error: /maxCostUsd/ },
		{ name: "CNY cannot carry the USD alias even beside maxCost", values: { billingCurrency: "CNY", limits: { maxCost: 2, maxCostUsd: 2 } }, error: /maxCostUsd/ },
		...[0, -1, "2", null].map((maxCost) => ({ name: `CNY rejects cap ${JSON.stringify(maxCost)}`, values: { billingCurrency: "CNY", limits: { maxCost } }, error: /maxCost|预算/ })),
		{ name: "unknown setting", values: { allowInterjection: true }, error: /未知配置项：allowInterjection/ },
	];
	for (const value of invalidConfigs) {
		test(`invalid run configuration is rejected before HTTP: ${value.name}`, async (t) => {
			const root = temporaryRoot(t);
			const upstream = await localProvider(t, "deepseek-flash", DEEPSEEK_USAGE);
			const cli = fixture(t, root, upstream.url);
			const result = await cli.run(value.values);
			assert.equal(result.code, 1, result.stderr);
			assert.match(result.stderr, value.error);
			assert.equal(upstream.requests.length, 0);
			assert.deepEqual(upstream.errors, []);
			assert.equal(existsSync(result.out), false, "Configuration validation must happen before creating the run directory");
			assert.equal(existsSync(cli.spendPath), false);
			assert.deepEqual(readdirSync(cli.workspace), ["README.md"]);
		});
	}

	for (const value of [
		{ model: "deepseek-flash", currency: "EUR", error: /billingCurrency|币种/ },
		{ model: "deepseek-flash", currency: "cny", error: /billingCurrency|币种/ },
		{ model: "deepseek-flash", currency: null, error: /billingCurrency|币种/ },
		{ model: "glm-5.3-flash", currency: "USD", error: /报价|价格/ },
	]) {
		test(`invalid replay metadata is rejected before initializing an engine: ${value.model}/${value.currency}`, async (t) => {
			const root = temporaryRoot(t);
			const upstream = await localProvider(t, "deepseek-flash", DEEPSEEK_USAGE);
			const cli = fixture(t, root, upstream.url);
			const recording = join(root, "invalid-recording.jsonl");
			writeFileSync(recording, [{ kind: "meta", data: { model: value.model, billingCurrency: value.currency, maxTokens: 128,
				thinking: { enabled: true, effort: "default" } } }, { kind: "user.input", data: { task: "offline replay" } }]
				.map((row) => JSON.stringify(row)).join("\n") + "\n");
			const result = await cli.replay(recording);
			assert.equal(result.code, 1, result.stderr);
			assert.match(result.stderr, value.error);
			assert.equal(existsSync(result.out), false, "Reject malformed billing metadata before creating replay files");
			assert.equal(upstream.requests.length, 0);
			assert.deepEqual(upstream.errors, []);
		});
	}
});
