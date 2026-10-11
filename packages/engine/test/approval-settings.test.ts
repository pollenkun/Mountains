import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { PRICING, CAPABILITIES } from "@mountains/providers";
import { validateApprovalSettings } from "../src/approval-settings.ts";

const known = () => ({ model: "deepseek-flash", maxCost: 0.05 });
const custom = () => ({ model: "approval-custom", profile: "openai", baseUrl: "http://127.0.0.1:8788/v1", maxCost: 0.05,
	pricing: { currency: "USD", inputPerMillion: 0.2, outputPerMillion: 0.7, version: "user-estimate@2026-09-27" } });

test("审批设置冻结本次采用的默认值、峰价与版本，不改变供应商共享表", () => {
	const pricingBefore = JSON.stringify(PRICING);
	const capBefore = JSON.stringify(CAPABILITIES);
	const s = validateApprovalSettings(known(), "USD");
	assert.equal(s.baseUrl, "https://api.deepseek.com");
	assert.equal(s.apiKeyEnv, "MOUNTAINS_APPROVAL_API_KEY");
	assert.equal(s.profile, "deepseek");
	assert.deepEqual(s.thinking, { enabled: false, effort: "default" });
	assert.deepEqual([s.maxTokens, s.maxInputChars, s.contextMessages, s.timeoutMs, s.maxRequests, s.maxDenials], [512, 20_000, 6, 15_000, 12, 2]);
	assert.deepEqual(s.allowRules, []);
	assert.deepEqual(s.manualTools, []);
	assert.equal(s.pricing.inputPerMillion, 0.3);
	assert.equal(s.pricing.outputPerMillion, 1.2);
	assert.equal(s.pricing.cacheReadPerMillion, 0.006);
	assert.match(s.pricing.version, /deepseek-pricing@.*\/peak-upper-bound$/);
	assert.equal(s.conversion, undefined);
	assert.ok(Object.isFrozen(s) && Object.isFrozen(s.pricing) && Object.isFrozen(s.thinking));
	assert.throws(() => { s.pricing.outputPerMillion = 0; }, TypeError);
	assert.equal(JSON.stringify(PRICING), pricingBefore);
	assert.equal(JSON.stringify(CAPABILITIES), capBefore);
	assert.equal(Object.isFrozen(PRICING["deepseek-flash"]!), false);
});

test("任意模型显式选协议和费率；不能按名字前缀猜测未知费率", () => {
	assert.equal(validateApprovalSettings(custom(), "USD").model, "approval-custom");
	const { profile: _profile, ...noProfile } = custom();
	const { pricing: _pricing, ...noPricing } = custom();
	assert.throws(() => validateApprovalSettings(noProfile, "USD"), /profile/);
	assert.throws(() => validateApprovalSettings(noPricing, "USD"), /pricing/);
	assert.throws(() => validateApprovalSettings({ model: "deepseek-not-registered", maxCost: 1 }, "USD"), /profile/);
	const pro = validateApprovalSettings({ model: "deepseek-v4-pro", maxCost: 1 }, "USD");
	assert.equal(pro.profile, "deepseek");
	assert.equal(pro.baseUrl, "https://api.deepseek.com");
	assert.equal(pro.pricing.inputPerMillion, 1.32);
	assert.equal(validateApprovalSettings({ model: "deepseek-v4-pro", profile: "deepseek", baseUrl: "https://api.deepseek.com", maxCost: 1 }, "USD").pricing.inputPerMillion, 1.32);
});

test("预算和计价不能缺失、为零或使用非数值；缓存零价必须显式配置", () => {
	assert.throws(() => validateApprovalSettings({ model: "deepseek-flash" }, "USD"), /maxCost/);
	for (const n of [0, -1, NaN, Infinity, "0.01", null]) assert.throws(() => validateApprovalSettings({ ...known(), maxCost: n }, "USD"));
	for (const field of ["inputPerMillion", "outputPerMillion"] as const) {
		for (const n of [0, -1, Infinity, "1", null]) assert.throws(() => validateApprovalSettings({ ...custom(), pricing: { ...custom().pricing, [field]: n } }, "USD"));
	}
	const s = validateApprovalSettings({ ...custom(), pricing: { ...custom().pricing, cacheReadPerMillion: 0 } }, "USD");
	assert.equal(s.pricing.cacheReadPerMillion, 0);
	assert.throws(() => validateApprovalSettings({ ...custom(), pricing: { ...custom().pricing, version: "" } }, "USD"), /version/);
});

test("跨币种须给明确转换率与日期，同币种只能按1换算", () => {
	assert.throws(() => validateApprovalSettings(known(), "CNY"), /conversion/);
	assert.deepEqual(validateApprovalSettings({ ...known(), conversion: { rate: 7, asOf: "2026-09-27" } }, "CNY").conversion, { rate: 7, asOf: "2026-09-27" });
	assert.equal(validateApprovalSettings({ ...known(), conversion: { rate: 1, asOf: "2026-09-27T00:00:00Z" } }, "USD").conversion?.rate, 1);
	assert.throws(() => validateApprovalSettings({ ...known(), conversion: { rate: 7, asOf: "2026-09-27" } }, "USD"), /同币种/);
	for (const asOf of ["yesterday", "", "2026-02-30", "2026-02-30T10:00:00Z", "2026", null]) assert.throws(() => validateApprovalSettings({ ...known(), conversion: { rate: 7, asOf } }, "CNY"), /asOf/);
	for (const rate of [0, -1, "7"]) assert.throws(() => validateApprovalSettings({ ...known(), conversion: { rate, asOf: "2026-09-27" } }, "CNY"), /rate/);
});

test("所有配置层拒绝未知字段和明文密钥，不在错误消息里泄露其值", () => {
	for (const field of ["apiKey", "secret", "token", "extra"]) {
		assert.throws(() => validateApprovalSettings({ ...known(), [field]: "private-sentinel" }, "USD"), (e: unknown) => e instanceof Error && !e.message.includes("private-sentinel"));
	}
	assert.throws(() => validateApprovalSettings({ ...custom(), pricing: { ...custom().pricing, apiKey: "x" } }, "USD"), /未知字段/);
	assert.throws(() => validateApprovalSettings({ ...known(), thinking: { enabled: false, effort: "default", secret: "x" } }, "USD"), /未知字段/);
	assert.throws(() => validateApprovalSettings({ ...known(), conversion: { rate: 1, asOf: "2026-09-27", token: "x" } }, "USD"), /未知字段/);
	assert.throws(() => validateApprovalSettings({ ...known(), apiKeyEnv: "not a name" }, "USD"), /环境变量名/);
	for (const baseUrl of ["ftp://example.invalid", "https://user:password@example.invalid", "https://example.invalid?api_key=secret", "https://example.invalid#secret"]) assert.throws(() => validateApprovalSettings({ ...known(), baseUrl }, "USD"), /baseUrl/);
});

test("准确授权规则保留完整原话并深复制，外部修改不能改变已加载的授权", () => {
	const rule = { id: "one", tool: "command", arguments: { argv: ["node", "-v"] }, cwd: join(tmpdir(), "approval"), userRequest: "  请运行 node -v。\n" };
	const raw = { ...known(), allowRules: [rule], manualTools: ["file_write"] };
	const s = validateApprovalSettings(raw, "USD");
	rule.arguments.argv[0] = "different";
	rule.userRequest = "different";
	raw.manualTools.push("command");
	assert.deepEqual(s.allowRules[0]?.arguments, { argv: ["node", "-v"] });
	assert.equal(s.allowRules[0]?.userRequest, "  请运行 node -v。\n");
	assert.deepEqual(s.manualTools, ["file_write"]);
	assert.ok(Object.isFrozen(s.allowRules[0]?.arguments.argv));
	assert.throws(() => validateApprovalSettings({ ...known(), allowRules: [rule, rule] }, "USD"), /重复/);
	assert.throws(() => validateApprovalSettings({ ...known(), allowRules: [{ ...rule, tool: "*" }] }, "USD"), /精确工具名/);
	assert.throws(() => validateApprovalSettings({ ...known(), allowRules: [{ ...rule, cwd: "relative" }] }, "USD"), /绝对路径/);
	assert.throws(() => validateApprovalSettings({ ...known(), allowRules: [{ ...rule, extra: true }] }, "USD"), /未知字段/);
	assert.throws(() => validateApprovalSettings({ ...known(), manualTools: ["command", "command"] }, "USD"), /重复/);
});

test("JSON设置拒绝执行访问器、循环与不支持的值", () => {
	let read = false;
	const getter = Object.defineProperty(known(), "pricing", { enumerable: true, get() { read = true; return {}; } });
	assert.throws(() => validateApprovalSettings(getter, "USD"));
	assert.equal(read, false);
	const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
	const rule = { id: "r", tool: "command", cwd: tmpdir(), userRequest: "run", arguments: cyclic };
	assert.throws(() => validateApprovalSettings({ ...known(), allowRules: [rule] }, "USD"), /无环/);
	for (const value of [() => {}, undefined, 1n, new Date()]) assert.throws(() => validateApprovalSettings({ ...known(), allowRules: [{ ...rule, arguments: { value } }] }, "USD"));
	const args = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
	const safe = validateApprovalSettings({ ...known(), allowRules: [{ ...rule, arguments: args }] }, "USD");
	assert.ok(Object.hasOwn(safe.allowRules[0]!.arguments, "__proto__"));
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("次数、时间与大小限额不接收小数和异常值；上下文消息数可为0", () => {
	for (const field of ["maxTokens", "maxInputChars", "timeoutMs", "maxRequests", "maxDenials"]) {
		for (const value of [0, -1, 1.5, 2_147_483_648, "2", null]) assert.throws(() => validateApprovalSettings({ ...known(), [field]: value }, "USD"));
	}
	assert.equal(validateApprovalSettings({ ...known(), contextMessages: 0 }, "USD").contextMessages, 0);
	for (const value of [-1, 1.5, "2", null]) assert.throws(() => validateApprovalSettings({ ...known(), contextMessages: value }, "USD"));
	assert.throws(() => validateApprovalSettings({ ...known(), profile: null }, "USD"), /profile/);
	assert.throws(() => validateApprovalSettings({ ...known(), thinking: { enabled: null } }, "USD"), /enabled/);
});

test("审批协议和思考设置在请求前校验，与传输层接受的能力相同", () => {
	assert.throws(() => validateApprovalSettings({ ...known(), profile: "openai" }, "USD"), /profile/);
	assert.equal(validateApprovalSettings(custom(), "USD").thinking.enabled, true);
	assert.throws(() => validateApprovalSettings({ ...custom(), thinking: { enabled: false, effort: "default" } }, "USD"), /disabledReasoningEffort/);
	assert.equal(validateApprovalSettings({ ...custom(), thinking: { enabled: false, effort: "default" }, disabledReasoningEffort: "none" }, "USD").thinking.enabled, false);
	assert.throws(() => validateApprovalSettings({ ...custom(), thinking: { enabled: true, effort: "high" } }, "USD"), /supportedEfforts/);
	assert.throws(() => validateApprovalSettings({ ...custom(), thinking: { enabled: true, effort: "max" }, supportedEfforts: ["max"] }, "USD"), /effortMapping.max/);
	const explicit = validateApprovalSettings({ ...custom(), thinking: { enabled: true, effort: "max" }, supportedEfforts: ["default", "max"], effortMapping: { max: "xhigh" }, maxTokensField: "max_completion_tokens" }, "USD");
	assert.equal(explicit.effortMapping?.max, "xhigh");
	assert.equal(explicit.maxTokensField, "max_completion_tokens");
	assert.throws(() => validateApprovalSettings({ ...known(), thinking: { enabled: true, effort: "max" }, effortMapping: { max: "xhigh" } }, "USD"), /effortMapping/);
	assert.throws(() => validateApprovalSettings({ model: "glm-5.3-flash", maxCost: 1, thinking: { enabled: false, effort: "default" } }, "CNY"), /thinking/);
	assert.throws(() => validateApprovalSettings({ model: "kimi-k2.7-code", maxCost: 1, thinking: { enabled: false, effort: "default" } }, "CNY"), /thinking/);
	for (const field of ["disabledReasoningEffort", "maxTokensField"]) assert.throws(() => validateApprovalSettings({ ...custom(), [field]: "arbitrary value" }, "USD"));
	assert.throws(() => validateApprovalSettings({ ...known(), timeoutMs: 600_001 }, "USD"), /timeoutMs/);
	assert.throws(() => validateApprovalSettings({ ...known(), maxTokens: 393_217 }, "USD"), /maxTokens/);
});
