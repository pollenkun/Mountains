import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type ApprovalPolicy, type ApprovalSettings, BENCH_APPROVAL, DEFAULT_LIMITS, DEFAULT_RETRY, type RetryPolicy, type RunLimits, validateApprovalSettings } from "@mountains/engine";
import { currencyOf, type Currency, type EffortSetting, pricingFor, PROVIDERS, providerOf, thinkingSettingError } from "@mountains/providers";

/**
 * 运行配置（JSON 文件）。配置全文与哈希写入每次运行的 summary，
 * 以便报告能精确还原“这次运行用的是什么”。
 */
export interface MountainsConfig {
	model: string;
	/** 显式计价币种；省略时保留模型原有的计价与预算行为。 */
	billingCurrency?: Currency;
	/** 空字符串：按模型的供应商取官方基址 */
	baseUrl: string;
	/** 读取 Key 的环境变量名；Key 本身永远不出现在配置里。空字符串：按供应商取默认名 */
	apiKeyEnv: string;
	/** effort 为 "default" 时不发 reasoning_effort（服务端默认）；各模型允许的取值见能力表 */
	thinking: { enabled: boolean; effort: EffortSetting };
	maxTokens: number;
	limits: RunLimits;
	retry: RetryPolicy;
	/** 按这个窗口（token 数，至少 32768）计算上下文的折叠线和压缩线，例如 131072 表示按 128k 模型计算；省略时用模型自己的窗口。 */
	contextWindow?: number;
	verbatimToolArguments: boolean;
	/** none：不发 user_id；per-run：每次运行一个隔离 ID；fixed：固定值（跨运行共享缓存，比较时禁止使用） */
	userIdMode: "none" | "per-run" | "fixed";
	userIdFixed?: string;
	/** 系统提示：内置提示，或使用相对配置文件的路径（工具说明仍会附在后面） */
	systemPrompt: { builtin: "default" } | { file: string };
	approval: ApprovalPolicy;
	/** Optional independent approval model. Null preserves the existing static approval policy. */
	modelApproval: ApprovalSettings | null;
	/** Request budget protection; model approval always enables it. */
	requestGuard: boolean;
	/** Mountains 自己的累计花费台账（全局上限由 MOUNTAINS_BUDGET 决定，按模型的计价币种） */
	spendLedger: string;
	checkpoints: boolean;
	/** 读取上限、批量编辑、编辑后回显改动附近的源码 */
	tools: { read: { defaultLines: number; maxLines: number; maxLineChars: number; lineNumbers: "all" | "sparse" }; batchEdit: boolean; editFeedback: boolean };
}

export const DEFAULT_CONFIG: MountainsConfig = {
	model: "deepseek-flash",
	baseUrl: "",
	apiKeyEnv: "",
	thinking: { enabled: true, effort: "high" },
	maxTokens: 32_000,
	limits: DEFAULT_LIMITS,
	retry: DEFAULT_RETRY,
	verbatimToolArguments: false,
	userIdMode: "none",
	systemPrompt: { builtin: "default" },
	approval: BENCH_APPROVAL,
	modelApproval: null,
	requestGuard: false,
	spendLedger: "~/.mountains/spend.jsonl",
	checkpoints: true,
	tools: { read: { defaultLines: 2000, maxLines: 2000, maxLineChars: 2000, lineNumbers: "all" }, batchEdit: true, editFeedback: true },
};

const KNOWN_KEYS = new Set([...Object.keys(DEFAULT_CONFIG), "billingCurrency", "contextWindow", "userIdFixed"]);

export interface LoadedConfig {
	config: MountainsConfig;
	/** 规范化后配置全文的 sha256 */
	sha256: string;
	/** A custom system prompt from a file; null uses the built-in one. */
	systemPrompt: string | null;
	source: string | null;
}

function merge<T>(base: T, over: unknown): T {
	if (over === undefined) return base;
	if (over === null || typeof over !== "object" || Array.isArray(over) || base === null || typeof base !== "object" || Array.isArray(base)) return over as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = merge(out[k], v);
	return out as T;
}

export function loadConfig(path: string | null, overrides: Partial<MountainsConfig> = {}): LoadedConfig {
	let fileConfig: Record<string, unknown> = {};
	if (path) fileConfig = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	if (fileConfig.apiKey !== undefined) throw new Error("配置文件不允许包含 apiKey；Key 只从环境变量读取");
	if (fileConfig.modelApproval && typeof fileConfig.modelApproval === "object" && ["apiKey", "secret", "token"].some(key => Object.hasOwn(fileConfig.modelApproval as object, key))) throw new Error("modelApproval 不允许明文密钥；Key 只从 apiKeyEnv 指定的环境变量读取");
	// 旧字段 limits.maxCostUsd：只对美元计价的模型有意义，换成 maxCost
	const fileLimits = fileConfig.limits as Record<string, unknown> | undefined;
	const overrideLimits = overrides.limits as unknown as Record<string, unknown> | undefined;
	const requestedCurrency = overrides.billingCurrency !== undefined ? overrides.billingCurrency : fileConfig.billingCurrency;
	if (requestedCurrency === "CNY" && ((fileLimits && "maxCostUsd" in fileLimits) || (overrideLimits && "maxCostUsd" in overrideLimits))) {
		throw new Error("billingCurrency=CNY 不接受 limits.maxCostUsd；请用 limits.maxCost 明确人民币金额");
	}
	const hasExplicitMaxCost = (fileLimits && Object.hasOwn(fileLimits, "maxCost") && fileLimits.maxCost !== undefined) ||
		(overrideLimits && Object.hasOwn(overrideLimits, "maxCost") && overrideLimits.maxCost !== undefined);
	if (fileLimits && "maxCostUsd" in fileLimits) {
		const { maxCostUsd, ...rest } = fileLimits;
		fileConfig = { ...fileConfig, limits: { maxCost: maxCostUsd, ...rest } };
	}
	const unknown = Object.keys(fileConfig).filter(key => !KNOWN_KEYS.has(key));
	if (unknown.length) throw new Error(`未知配置项：${unknown.join("、")}`);
	let config = merge(DEFAULT_CONFIG, fileConfig);
	// approval.rules 是数组，整体替换；overrides 只覆盖显式给出的字段
	config = merge(config, overrides);
	if (config.billingCurrency !== undefined) {
		if (config.billingCurrency !== "USD" && config.billingCurrency !== "CNY") throw new Error("billingCurrency 必须为 USD 或 CNY");
		if (!pricingFor(config.model, config.billingCurrency)) throw new Error(`模型 ${config.model} 没有 ${config.billingCurrency} 官方价格`);
		if (config.billingCurrency === "CNY" && (!hasExplicitMaxCost || !Number.isFinite(config.limits.maxCost) || config.limits.maxCost <= 0)) {
			throw new Error("billingCurrency=CNY 必须显式提供有限正数 limits.maxCost（人民币金额），不能沿用默认美元预算");
		}
	}
	for (const [name, value] of Object.entries({ requestGuard: config.requestGuard, batchEdit: config.tools.batchEdit, editFeedback: config.tools.editFeedback })) {
		if (typeof value !== "boolean") throw new Error(`配置 ${name} 必须为布尔值`);
	}
	if (config.contextWindow !== undefined && (!Number.isSafeInteger(config.contextWindow) || config.contextWindow < 32_768)) throw new Error("contextWindow 必须是不小于 32768 的整数");
	for (const [name, value] of Object.entries({ maxRequests: config.limits.maxRequests, maxDurationMs: config.limits.maxDurationMs })) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) throw new Error(`limits.${name} 必须为有效的正整数`);
	}
	if ((config as unknown as Record<string, unknown>).apiKey !== undefined) throw new Error("配置文件不允许包含 apiKey；Key 只从环境变量读取");
	const provider = providerOf(config.model);
	if (!config.baseUrl || !config.apiKeyEnv) {
		if (!provider) throw new Error(`无法由模型 ${config.model} 推断供应商：请在配置中给出 baseUrl 与 apiKeyEnv`);
		config = { ...config, baseUrl: config.baseUrl || PROVIDERS[provider].baseUrl, apiKeyEnv: config.apiKeyEnv || PROVIDERS[provider].apiKeyEnv };
	}
	const thinkingError = thinkingSettingError(config.model, config.thinking);
	if (thinkingError) throw new Error(`思考设置无效：${thinkingError}`);
	if (config.modelApproval !== null) {
		const settings = validateApprovalSettings(config.modelApproval, currencyOf(config.model, config.billingCurrency) ?? "USD");
		if (!Number.isFinite(config.limits.maxCost) || config.limits.maxCost <= 0 || settings.maxCost > config.limits.maxCost) throw new Error("modelApproval.maxCost 必须不超过主任务 limits.maxCost，且主任务预算必须为有限正数");
		if (settings.apiKeyEnv === config.apiKeyEnv && new URL(settings.baseUrl).origin !== new URL(config.baseUrl).origin) throw new Error("modelApproval.apiKeyEnv 不得把主模型密钥复用给不同地址；请使用独立环境变量");
		config = { ...config, modelApproval: settings };
	}
	config = { ...config, requestGuard: config.requestGuard === true || config.modelApproval !== null };
	// null: the built-in prompt. The engine appends the tool notes either way.
	let systemPrompt: string | null = null;
	if ("file" in config.systemPrompt) {
		const p = resolve(path ? dirname(path) : process.cwd(), config.systemPrompt.file);
		systemPrompt = readFileSync(p, "utf8");
	} else if (config.systemPrompt.builtin !== "default") throw new Error('systemPrompt 只能是 { "builtin": "default" } 或 { "file": "路径" }');
	const canonical = JSON.stringify(config, Object.keys(flattenKeys(config)).sort());
	return {
		config,
		sha256: createHash("sha256").update(canonical).update("\0").update(systemPrompt ?? "").digest("hex"),
		systemPrompt,
		source: path,
	};
}

function flattenKeys(v: unknown, acc: Record<string, true> = {}): Record<string, true> {
	if (v && typeof v === "object") {
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
			acc[k] = true;
			flattenKeys(x, acc);
		}
	}
	return acc;
}
