import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, type MountainsConfig } from "../src/config.ts";
import { isolatedEnv } from "./env.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TASK = "Write marker.txt containing sudo in the temporary workspace.";
const MAIN_KEY = "offline-main-key-do-not-share";
const APPROVAL_KEY = "offline-approval-key-only";
const MARKER_COMMAND = { argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("marker.txt", "sudo")'] };

interface ChatBody {
	model: string;
	stream: boolean;
	messages: { role: string; content?: string; tool_call_id?: string }[];
	tools?: unknown[];
	max_tokens?: number;
	reasoning_effort?: string;
}
interface CapturedRequest { body: ChatBody; authorization: string | undefined; url: string | undefined }
type Reply = { sse: string } | { json: unknown };

function mainResponse(tool = false): string {
	const delta = tool
		? { tool_calls: [{ index: 0, id: "marker-command", type: "function", function: { name: "command_run", arguments: JSON.stringify(MARKER_COMMAND) } }] }
		: { content: "Offline task complete." };
	const chunks = [
		{ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "local fixture" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } },
	];
	return chunks.map((chunk) => `data: ${JSON.stringify({ id: "main-fixture", object: "chat.completion.chunk", model: "deepseek-flash", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n";
}

function approvalResponse(body: ChatBody) {
	const evidenceText = body.messages.find((message) => message.role === "user")?.content;
	assert.ok(evidenceText);
	const evidence = JSON.parse(evidenceText) as { action: { tool: string; arguments: unknown }; userRequests: { id: string; text: string }[] };
	assert.equal(evidence.action.tool, "command_run");
	assert.deepEqual(evidence.action.arguments, MARKER_COMMAND);
	const user = evidence.userRequests.find((request) => request.text === TASK);
	assert.ok(user, "approval receives the authentic task text");
	return {
		id: "approval-fixture", model: body.model, object: "chat.completion",
		choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ decision: "allow", authorization: [{ requestId: user.id, quote: TASK }] }) } }],
		usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 20 } },
	};
}

async function localServer(t: TestContext, respond: (request: CapturedRequest, index: number) => Reply) {
	const requests: CapturedRequest[] = [];
	const errors: unknown[] = [];
	const server = http.createServer(async (req, res) => {
		try {
			let text = "";
			for await (const chunk of req) text += chunk;
			const request = { body: JSON.parse(text) as ChatBody, authorization: req.headers.authorization, url: req.url };
			requests.push(request);
			const reply = respond(request, requests.length - 1);
			res.writeHead(200, { "content-type": "sse" in reply ? "text/event-stream" : "application/json" });
			res.end("sse" in reply ? reply.sse : JSON.stringify(reply.json));
		} catch (error) { errors.push(error); res.writeHead(500); res.end("offline fixture failed"); }
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { url: `http://127.0.0.1:${address.port}/v1`, requests, errors };
}

function cliFixture(t: TestContext) {
	const base = mkdtempSync(join(tmpdir(), "mountains-approval-cli-"));
	const workspace = join(base, "workspace");
	const home = join(base, "home");
	const out = join(base, "out");
	const path = join(base, "config.json");
	const spend = join(home, "spend.jsonl");
	mkdirSync(workspace); mkdirSync(home);
	let pending: Promise<unknown> = Promise.resolve();
	t.after(async () => { await pending.catch(() => {}); rmSync(base, { recursive: true, force: true }); });
	return {
		workspace, out, path, spend,
		run: async (baseUrl: string, overrides: Record<string, unknown>, credentials: NodeJS.ProcessEnv = {}) => {
			writeFileSync(path, JSON.stringify({ model: "deepseek-flash", apiKeyEnv: "MAIN_FIXTURE_KEY", maxTokens: 100,
				checkpoints: false, retry: { maxAttempts: 1 }, limits: { maxCost: 1, maxRequests: 6, maxTurns: 4 }, ...overrides }));
			// Deliberately exclude inherited provider credentials, proxies and NODE_OPTIONS.
			// Test approval behavior without repopulating a cold compile cache in every fixture.
			// startup-cache.test.ts exercises that optional optimization independently.
			const env: NodeJS.ProcessEnv = { ...isolatedEnv(home), NODE_DISABLE_COMPILE_CACHE: "1", MOUNTAINS_BUDGET_USD: "5", ...credentials };
			const running = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				const child = spawn(process.execPath, [MAIN, "run", "--task", TASK, "--workspace", workspace, "--config", path,
					"--out", out, "--json", "--run-id", "approval-cli-fixture", "--base-url", baseUrl, "--spend-ledger", spend],
				{ env, signal: t.signal, timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
				let stdout = ""; let stderr = ""; let failure: Error | undefined;
				child.stdout.on("data", (data) => { stdout += data; });
				child.stderr.on("data", (data) => { stderr += data; });
				child.on("error", (error) => { failure = error; });
				child.on("close", (code) => failure ? reject(failure) : resolve({ code, stdout, stderr }));
			});
			pending = running;
			return await running;
		},
	};
}

function config(overrides: Record<string, unknown> = {}) {
	return loadConfig(null, overrides as Partial<MountainsConfig>);
}

function customApproval(overrides: Record<string, unknown> = {}) {
	return {
		model: "custom-approval-fixture",
		baseUrl: "http://127.0.0.1:43101/v1",
		profile: "deepseek",
		maxCost: 0.2,
		pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.25, version: "approval-fixture-v1" },
		...overrides,
	};
}

test("modelApproval configuration: omitted and null preserve the disabled baseline", () => {
	const omitted = config();
	const explicit = config({ modelApproval: null });
	assert.equal(omitted.config.modelApproval, null);
	assert.equal(explicit.config.modelApproval, null);
	assert.equal(omitted.sha256, explicit.sha256);
	assert.deepEqual(omitted.config.approval, explicit.config.approval);
});

test("requestGuard configuration: defaults off and hashes the effective value implied by model approval", () => {
	const omitted = config();
	const disabled = config({ requestGuard: false, modelApproval: null });
	const enabled = config({ requestGuard: true, modelApproval: null });
	assert.equal(omitted.config.requestGuard, false);
	assert.equal(disabled.config.requestGuard, false);
	assert.equal(enabled.config.requestGuard, true);
	assert.equal(omitted.sha256, disabled.sha256);
	assert.notEqual(disabled.sha256, enabled.sha256);
	const approval = { model: "deepseek-flash", maxCost: 0.2 };
	const implicit = config({ modelApproval: approval });
	const overridden = config({ requestGuard: false, modelApproval: approval });
	const explicit = config({ requestGuard: true, modelApproval: approval });
	assert.equal(implicit.config.requestGuard, true);
	assert.equal(overridden.config.requestGuard, true);
	assert.equal(explicit.config.requestGuard, true);
	assert.equal(implicit.sha256, explicit.sha256);
	assert.equal(overridden.sha256, explicit.sha256);
});

test("requestGuard configuration: non-boolean inputs fail even when model approval would enable the guard", () => {
	for (const requestGuard of ["true", "false", 0, 1, null, [], {}]) {
		for (const modelApproval of [null, { model: "deepseek-flash", maxCost: 0.2 }]) {
			assert.throws(() => config({ requestGuard, modelApproval }), /requestGuard/, `invalid requestGuard ${JSON.stringify(requestGuard)}`);
		}
	}
});

test("modelApproval configuration: registered models resolve an independent key and bounded defaults", () => {
	const approval = config({ modelApproval: { model: "deepseek-flash", maxCost: 0.2 } }).config.modelApproval;
	assert.ok(approval);
	assert.equal(approval.profile, "deepseek");
	assert.equal(approval.baseUrl, "https://api.deepseek.com");
	assert.equal(approval.apiKeyEnv, "MOUNTAINS_APPROVAL_API_KEY");
	assert.equal(approval.maxTokens, 512);
	assert.equal(approval.maxInputChars, 20_000);
	assert.equal(approval.contextMessages, 6);
	assert.equal(approval.timeoutMs, 15_000);
	assert.equal(approval.maxRequests, 12);
	assert.equal(approval.maxDenials, 2);
	assert.deepEqual(approval.thinking, { enabled: false, effort: "default" });
	assert.equal(approval.pricing.currency, "USD");
	assert.ok(approval.pricing.inputPerMillion > 0 && approval.pricing.outputPerMillion > 0);
	assert.ok(approval.pricing.version.length > 0);
	const moonshot = config({
		model: "kimi-k2.7-code", thinking: { enabled: true, effort: "default" },
		modelApproval: { model: "kimi-k2.7-code", maxCost: 0.2 },
	}).config.modelApproval;
	assert.ok(moonshot);
	assert.deepEqual(moonshot.thinking, { enabled: true, effort: "default" });
});

test("modelApproval configuration: approval cost is explicit, finite, positive and within the task budget", () => {
	for (const maxCost of [undefined, null, 0, -0.1, "0.1", NaN, Infinity, 0.200001]) {
		assert.throws(() => config({ limits: { maxCost: 0.2 }, modelApproval: { model: "deepseek-flash", maxCost } }),
			/modelApproval|maxCost|审批/, `invalid approval maxCost ${String(maxCost)}`);
	}
	const approval = config({ limits: { maxCost: 0.2 }, modelApproval: { model: "deepseek-flash", maxCost: 0.2 } }).config.modelApproval;
	assert.equal(approval?.maxCost, 0.2);
	for (const modelApproval of [false, true, "deepseek-flash", [], {}]) {
		assert.throws(() => config({ modelApproval }), /modelApproval|审批/);
	}
	assert.throws(() => config({ modelApproval: { model: "deepseek-flash", maxCost: 0.2, apiKey: "not-a-real-key" } }), /apiKey|Key|密钥/);
});

test("modelApproval configuration: unknown models need an explicit protocol, endpoint and price", () => {
	for (const field of ["profile", "baseUrl", "pricing"] as const) {
		const candidate: Record<string, unknown> = customApproval();
		delete candidate[field];
		assert.throws(() => config({ modelApproval: candidate }), /profile|baseUrl|pricing|模型|供应商|协议|价格/, `missing ${field}`);
	}
	assert.throws(() => config({ modelApproval: { model: "deepseek-not-registered", maxCost: 0.2 } }), /profile|模型|协议/);
	const registeredPro = config({ modelApproval: { model: "deepseek-v4-pro", maxCost: 0.2 } }).config.modelApproval;
	assert.equal(registeredPro?.profile, "deepseek");
	assert.equal(registeredPro?.pricing.inputPerMillion, 1.32);
	const approval = config({ modelApproval: customApproval() }).config.modelApproval;
	assert.equal(approval?.profile, "deepseek");
	assert.equal(approval?.pricing.version, "approval-fixture-v1");
	for (const [field, value] of [["inputPerMillion", 0], ["outputPerMillion", -1], ["cacheReadPerMillion", -1], ["inputPerMillion", Infinity], ["version", ""]] as const) {
		const candidate = customApproval();
		assert.throws(() => config({ modelApproval: { ...candidate, pricing: { ...candidate.pricing, [field]: value } } }), /modelApproval/, `invalid ${field}: ${String(value)}`);
	}
});

test("modelApproval configuration: currency conversion is explicit and cannot discount the same currency", () => {
	const candidate = customApproval();
	const foreign = { ...candidate, pricing: { ...candidate.pricing, currency: "CNY" } };
	assert.throws(() => config({ modelApproval: foreign }), /conversion|币种|汇率/);
	for (const conversion of [{ rate: 0, asOf: "2026-09-27" }, { rate: -1, asOf: "2026-09-27" }, { rate: 0.14, asOf: "not-a-date" }, { rate: 0.14 }]) {
		assert.throws(() => config({ modelApproval: { ...foreign, conversion } }), /conversion|汇率|日期|asOf|rate/);
	}
	const converted = config({ modelApproval: { ...foreign, conversion: { rate: 0.14, asOf: "2026-09-27" } } }).config.modelApproval;
	assert.equal(converted?.conversion?.rate, 0.14);
	assert.throws(() => config({ modelApproval: { ...candidate, conversion: { rate: 0.5, asOf: "2026-09-27" } } }), /conversion|币种|汇率|rate/);
});

test("modelApproval configuration: a shared key variable cannot cross endpoint origins", () => {
	const main = { baseUrl: "http://127.0.0.1:43100/v1", apiKeyEnv: "SHARED_FIXTURE_KEY" };
	assert.throws(() => config({ ...main, modelApproval: customApproval({ apiKeyEnv: "SHARED_FIXTURE_KEY" }) }), /origin|apiKeyEnv|Key|密钥|地址/);
	assert.doesNotThrow(() => config({ ...main, modelApproval: customApproval({ apiKeyEnv: "APPROVAL_FIXTURE_KEY" }) }));
	assert.doesNotThrow(() => config({ ...main, modelApproval: customApproval({ baseUrl: "http://127.0.0.1:43100/approval", apiKeyEnv: "SHARED_FIXTURE_KEY" }) }));
});

test("modelApproval configuration: effective settings are hashed, cloned and deeply frozen", () => {
	const source = customApproval({ thinking: { enabled: false, effort: "default" }, conversion: { rate: 1, asOf: "2026-09-27" } });
	const first = config({ modelApproval: source });
	const frozen = first.config.modelApproval;
	assert.ok(frozen);
	const snapshot = structuredClone(frozen);
	assert.ok(Object.isFrozen(frozen));
	assert.ok(Object.isFrozen(frozen.pricing));
	assert.ok(Object.isFrozen(frozen.thinking));
	assert.ok(Object.isFrozen(frozen.conversion));
	assert.notStrictEqual(frozen, source);
	assert.notStrictEqual(frozen.pricing, source.pricing);
	source.pricing.inputPerMillion = 7;
	assert.deepEqual(frozen, snapshot);
	assert.throws(() => { (frozen.pricing as { inputPerMillion: number }).inputPerMillion = 9; }, TypeError);
	const reordered = Object.fromEntries(Object.entries(customApproval({ thinking: { effort: "default", enabled: false }, conversion: { asOf: "2026-09-27", rate: 1 } })).reverse());
	assert.equal(config({ modelApproval: reordered }).sha256, first.sha256);
	assert.notEqual(config({ modelApproval: { ...customApproval(), pricing: { ...customApproval().pricing, version: "approval-fixture-v2" }, conversion: { rate: 1, asOf: "2026-09-27" } } }).sha256, first.sha256);
	assert.notEqual(config({ modelApproval: source }).sha256, first.sha256);
	assert.equal(config({ modelApproval: customApproval() }).config.modelApproval?.pricing.inputPerMillion, 1);
	assert.equal(config().config.modelApproval, null);
});

for (const [label, overrides] of [["omitted", {}], ["explicit null", { modelApproval: null }]] as const) {
	test(`modelApproval CLI: ${label} keeps dangerous commands denied without an approval request`, { timeout: 20_000 }, async (t) => {
		const fixture = cliFixture(t);
		const main = await localServer(t, (_request, index) => {
			assert.ok(index < 2, "unexpected main-model retry");
			return { sse: mainResponse(index === 0) };
		});
		const judge = await localServer(t, () => { throw new Error("disabled approval must not make a request"); });
		const result = await fixture.run(main.url, overrides, { MAIN_FIXTURE_KEY: MAIN_KEY, MOUNTAINS_APPROVAL_API_KEY: APPROVAL_KEY });
		assert.equal(result.code, 0, result.stderr || result.stdout);
		assert.equal(existsSync(join(fixture.workspace, "marker.txt")), false);
		assert.equal(main.requests.length, 2);
		assert.equal(judge.requests.length, 0);
		assert.deepEqual(main.errors, []); assert.deepEqual(judge.errors, []);
		const summary = JSON.parse(result.stdout);
		assert.equal(summary.totals.requests, 2);
		assert.equal(summary.totals.approvalRequests ?? 0, 0);
		const events = readFileSync(join(fixture.out, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(events.some((event) => event.type === "approval.resolved" && event.decision === "deny" && event.rule === "deny-dangerous"));
		assert.equal(JSON.parse(readFileSync(join(fixture.out, "config.json"), "utf8")).config.modelApproval, null);
	});
}

test("requestGuard CLI: guarded main requests need no approval key and preserve static dangerous-command denial", { timeout: 20_000 }, async (t) => {
	const fixture = cliFixture(t);
	const main = await localServer(t, (request, index) => {
		assert.equal(request.authorization, `Bearer ${MAIN_KEY}`);
		assert.equal(request.body.model, "deepseek-flash");
		assert.ok(index < 2, "unexpected main-model retry");
		return { sse: mainResponse(index === 0) };
	});
	const judge = await localServer(t, () => { throw new Error("request protection must not invoke a model judge"); });
	const result = await fixture.run(main.url, { requestGuard: true, modelApproval: null }, { MAIN_FIXTURE_KEY: MAIN_KEY });
	assert.equal(result.code, 0, result.stderr || result.stdout);
	assert.deepEqual(main.errors, []); assert.deepEqual(judge.errors, []);
	assert.equal(main.requests.length, 2); assert.equal(judge.requests.length, 0);
	assert.equal(existsSync(join(fixture.workspace, "marker.txt")), false);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.status, "completed");
	assert.equal(summary.totals.requests, 2);
	assert.equal(summary.totals.approvalRequests ?? 0, 0);
	assert.equal(summary.totals.approvalCost ?? 0, 0);
	const events = readFileSync(join(fixture.out, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(events.some((event) => event.type === "approval.resolved" && event.decision === "deny" && event.rule === "deny-dangerous"));
	const frozen = JSON.parse(readFileSync(join(fixture.out, "config.json"), "utf8"));
	assert.equal(frozen.config.requestGuard, true);
	assert.equal(frozen.config.modelApproval, null);
	assert.equal(frozen.sha256, summary.configSha256);
	const ledger = readFileSync(join(fixture.out, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(ledger.length, 2);
	assert.ok(ledger.every((entry) => entry.purpose !== "approval"));
	const spend = readFileSync(fixture.spend, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(spend.filter((entry) => entry.kind === "budget.reserve").length, 2, "both main requests use the guarded reservation path");
	assert.equal(spend.filter((entry) => entry.kind === "budget.settle").length, 2);
	assert.ok(Math.abs(summary.budget.globalSpent - summary.totals.cost) < 1e-12);
});

for (const useApprovalKey of [true, false]) {
	test(`modelApproval CLI: ${useApprovalKey ? "separate credentials" : "loopback without an approval key"} authorize only through the independent endpoint`, { timeout: 20_000 }, async (t) => {
		const fixture = cliFixture(t);
		const main = await localServer(t, (request, index) => {
			assert.equal(request.authorization, `Bearer ${MAIN_KEY}`);
			assert.equal(request.body.model, "deepseek-flash");
			assert.equal(request.body.stream, true);
			assert.ok(index < 2, "unexpected main-model retry");
			return { sse: mainResponse(index === 0) };
		});
		const judge = await localServer(t, (request, index) => {
			assert.equal(index, 0, "approval must not retry");
			assert.equal(request.authorization, `Bearer ${useApprovalKey ? APPROVAL_KEY : "proxy-injected"}`);
			assert.notEqual(request.authorization, `Bearer ${MAIN_KEY}`);
			assert.equal(request.url, "/v1/chat/completions");
			assert.equal(request.body.model, "custom-approval-fixture");
			assert.equal(request.body.stream, false);
			assert.equal(request.body.tools, undefined);
			assert.equal(request.body.max_tokens, 512);
			assert.equal(request.body.reasoning_effort, "none");
			return { json: approvalResponse(request.body) };
		});
		const modelApproval = customApproval({ baseUrl: judge.url, profile: "openai", thinking: { enabled: false, effort: "default" }, disabledReasoningEffort: "none" });
		const result = await fixture.run(main.url, { modelApproval }, { MAIN_FIXTURE_KEY: MAIN_KEY,
			...(useApprovalKey ? { MOUNTAINS_APPROVAL_API_KEY: APPROVAL_KEY } : {}) });
		assert.equal(result.code, 0, result.stderr || result.stdout);
		assert.deepEqual(main.errors, []); assert.deepEqual(judge.errors, []);
		assert.equal(readFileSync(join(fixture.workspace, "marker.txt"), "utf8"), "sudo");
		assert.equal(main.requests.length, 2); assert.equal(judge.requests.length, 1);
		const summary = JSON.parse(result.stdout);
		assert.equal(summary.status, "completed");
		assert.equal(summary.totals.approvalRequests, 1);
		// 80 uncached input + 20 cached input + 10 output, charged using the custom price.
		assert.ok(Math.abs(summary.totals.approvalCost - 0.000105) < 1e-12);
		const ledger = readFileSync(join(fixture.out, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const approvalEntries = ledger.filter((entry) => entry.purpose === "approval");
		assert.equal(approvalEntries.length, 1);
		const charged = approvalEntries[0]!;
		assert.ok(Math.abs(charged.cost - 0.000105) < 1e-12);
		assert.equal(charged.currency, "USD");
		assert.equal(charged.priceVersion, "approval-fixture-v1");
		const spend = readFileSync(fixture.spend, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const settlements = spend.filter((entry) => entry.kind === "budget.settle" && entry.requestId === charged.requestId);
		assert.equal(settlements.length, 1, "approval charge must reach the persistent shared budget exactly once");
		assert.equal(settlements[0]!.amount, charged.cost);
		assert.equal(settlements[0]!.partial, false);
		assert.ok(Math.abs(summary.budget.globalSpent - summary.totals.cost) < 1e-12);
		const frozen = JSON.parse(readFileSync(join(fixture.out, "config.json"), "utf8"));
		assert.equal(frozen.sha256, summary.configSha256);
		assert.equal(frozen.sha256, loadConfig(fixture.path, { baseUrl: main.url }).sha256);
		assert.equal(frozen.config.modelApproval.baseUrl, judge.url);
		assert.equal(frozen.config.modelApproval.profile, "openai");
		assert.equal(frozen.config.modelApproval.pricing.version, "approval-fixture-v1");
		for (const file of ["config.json", "summary.json", "events.jsonl", "recording.jsonl", "ledger.jsonl"]) {
			const saved = readFileSync(join(fixture.out, file), "utf8");
			assert.ok(!saved.includes(MAIN_KEY), `${file} must not contain the main key`);
			assert.ok(!saved.includes(APPROVAL_KEY), `${file} must not contain the approval key`);
		}
	});
}

test("modelApproval CLI: an invalid approval budget fails before either endpoint receives a request", { timeout: 20_000 }, async (t) => {
	const fixture = cliFixture(t);
	const main = await localServer(t, () => { throw new Error("invalid configuration reached the main endpoint"); });
	const judge = await localServer(t, () => { throw new Error("invalid configuration reached the approval endpoint"); });
	const result = await fixture.run(main.url, { modelApproval: customApproval({ baseUrl: judge.url, maxCost: 1.01 }) },
		{ MAIN_FIXTURE_KEY: MAIN_KEY, MOUNTAINS_APPROVAL_API_KEY: APPROVAL_KEY });
	assert.equal(result.code, 1, result.stderr || result.stdout);
	assert.match(result.stderr, /modelApproval|maxCost|审批/);
	assert.equal(main.requests.length, 0); assert.equal(judge.requests.length, 0);
	assert.deepEqual(main.errors, []); assert.deepEqual(judge.errors, []);
	assert.equal(existsSync(join(fixture.workspace, "marker.txt")), false);
});

test("modelApproval CLI: a remote approval endpoint without its own key fails before the main request", { timeout: 20_000 }, async (t) => {
	const fixture = cliFixture(t);
	const main = await localServer(t, () => { throw new Error("missing approval credentials reached the main endpoint"); });
	const result = await fixture.run(main.url, { modelApproval: customApproval({ baseUrl: "https://approval.example.invalid/v1" }) },
		{ MAIN_FIXTURE_KEY: MAIN_KEY });
	assert.equal(result.code, 2, result.stderr || result.stdout);
	assert.match(result.stderr, /MOUNTAINS_APPROVAL_API_KEY/);
	assert.ok(!result.stderr.includes(MAIN_KEY));
	assert.equal(main.requests.length, 0);
	assert.deepEqual(main.errors, []);
});
