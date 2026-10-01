import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type ApprovalPolicy, type ApprovalSettings, BENCH_APPROVAL, BASELINE_SYSTEM_PROMPT, DEFAULT_LIMITS, DEFAULT_RETRY, type RetryPolicy, type RunLimits, validateApprovalSettings } from "@mountains/engine";
import type { MaskingConfig } from "@mountains/context";
import { currencyOf, type EffortSetting, PROVIDERS, providerOf, thinkingSettingError } from "@mountains/providers";

/**
 * 运行配置（JSON 文件）。配置全文与哈希写入每次运行的 summary，
 * 以便报告能精确还原“这次运行用的是什么”。
 */
export interface MountainsConfig {
	model: string;
	/** 空字符串：按模型的供应商取官方基址 */
	baseUrl: string;
	/** 读取 Key 的环境变量名；Key 本身永远不出现在配置里。空字符串：按供应商取默认名 */
	apiKeyEnv: string;
	/** effort 为 "default" 时不发 reasoning_effort（服务端默认）；各模型允许的取值见能力表 */
	thinking: { enabled: boolean; effort: EffortSetting };
	maxTokens: number;
	limits: RunLimits;
	retry: RetryPolicy;
	masking: MaskingConfig;
	verbatimToolArguments: boolean;
	/** none：不发 user_id；per-run：每次运行一个隔离 ID；fixed：固定值（跨运行共享缓存，比较时禁止使用） */
	userIdMode: "none" | "per-run" | "fixed";
	userIdFixed?: string;
	/** 系统提示：内置基线，或相对配置文件的路径 */
	systemPrompt: { builtin: "baseline" } | { file: string };
	approval: ApprovalPolicy;
	/** Optional independent approval model. Null preserves the existing static approval policy. */
	modelApproval: ApprovalSettings | null;
	/** Request budget protection; model approval always enables it. */
	requestGuard: boolean;
	/** Mountains 自己的累计花费台账（全局上限由 MOUNTAINS_BUDGET 决定，按模型的计价币种） */
	spendLedger: string;
	checkpoints: boolean;
	/** 修订前校验证据与调用配对。默认关闭。 */
	contextGuard: boolean;
	/** 默认工具的可选配置 */
	/** expand：提供 context_expand，按占位符里的引用取回被移出上下文的工具结果 */
	tools: { read: { defaultLines: number; maxLines: number; maxLineChars: number; dedupe: boolean; lineNumbers: "all" | "sparse"; symbols: boolean; outlineFirst?: number; classOutlineOver?: number }; outline: boolean; expand: boolean; archiveSearch: boolean; searchContextLines: number; batchEdit: boolean; queryPlans: boolean; searchPath: boolean; codeLookup: boolean; searchSymbols: boolean; leanOutput: boolean };
	/** 可验证记忆：开启时提供 memory_record，会话开始时校验证据并注入有效笔记（最近 maxNotes 条） */
	memory: { enabled: boolean; maxNotes: number; maxChars: number; verifiedFacts: boolean };
}

export const DEFAULT_CONFIG: MountainsConfig = {
	model: "deepseek-flash",
	baseUrl: "",
	apiKeyEnv: "",
	thinking: { enabled: true, effort: "high" },
	maxTokens: 32_000,
	limits: DEFAULT_LIMITS,
	retry: DEFAULT_RETRY,
	masking: { enabled: false, triggerTokens: 1e12, keepRecentToolResults: 0, minBatchTokens: 0, hardLimitTokens: 900_000 },
	verbatimToolArguments: false,
	userIdMode: "none",
	systemPrompt: { builtin: "baseline" },
	approval: BENCH_APPROVAL,
	modelApproval: null,
	requestGuard: false,
	spendLedger: "~/.mountains/spend.jsonl",
	checkpoints: true,
	contextGuard: false,
	tools: { read: { defaultLines: 120, maxLines: 400, maxLineChars: 2000, dedupe: false, lineNumbers: "all", symbols: false }, outline: false, expand: false, archiveSearch: false, searchContextLines: 0, batchEdit: false, queryPlans: false, searchPath: false, codeLookup: false, searchSymbols: false, leanOutput: false },
	memory: { enabled: false, maxNotes: 30, maxChars: 6000, verifiedFacts: false },
};

export interface LoadedConfig {
	config: MountainsConfig;
	/** 规范化后配置全文的 sha256 */
	sha256: string;
	systemPrompt: string;
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
	if (fileLimits && "maxCostUsd" in fileLimits) {
		const { maxCostUsd, ...rest } = fileLimits;
		fileConfig = { ...fileConfig, limits: { maxCost: maxCostUsd, ...rest } };
	}
	let config = merge(DEFAULT_CONFIG, fileConfig);
	// approval.rules 是数组，整体替换；overrides 只覆盖显式给出的字段
	config = merge(config, overrides);
	for (const [name, value] of Object.entries({ requestGuard: config.requestGuard, contextGuard: config.contextGuard, archiveSearch: config.tools.archiveSearch, queryPlans: config.tools.queryPlans, batchEdit: config.tools.batchEdit, searchPath: config.tools.searchPath, codeLookup: config.tools.codeLookup, searchSymbols: config.tools.searchSymbols, leanOutput: config.tools.leanOutput, verifiedFacts: config.memory.verifiedFacts })) {
		if (typeof value !== "boolean") throw new Error(`配置 ${name} 必须为布尔值`);
	}
	if (config.tools.archiveSearch && config.tools.expand !== true) throw new Error("tools.archiveSearch 需要 tools.expand=true，才能展开查到的原文");
	if (!Number.isInteger(config.tools.searchContextLines) || config.tools.searchContextLines < 0 || config.tools.searchContextLines > 10) throw new Error("searchContextLines 必须为0到10的整数");
	if (!Number.isInteger(config.memory.maxChars) || config.memory.maxChars < 256 || config.memory.maxChars > 20_000) throw new Error("memory.maxChars 必须为256到20000的整数");
	if (config.contextGuard && !config.tools.expand) throw new Error("contextGuard 需要 tools.expand，不能发布无法取回的占位符");
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
		const settings = validateApprovalSettings(config.modelApproval, currencyOf(config.model) ?? "USD");
		if (!Number.isFinite(config.limits.maxCost) || config.limits.maxCost <= 0 || settings.maxCost > config.limits.maxCost) throw new Error("modelApproval.maxCost 必须不超过主任务 limits.maxCost，且主任务预算必须为有限正数");
		if (settings.apiKeyEnv === config.apiKeyEnv && new URL(settings.baseUrl).origin !== new URL(config.baseUrl).origin) throw new Error("modelApproval.apiKeyEnv 不得把主模型密钥复用给不同地址；请使用独立环境变量");
		config = { ...config, modelApproval: settings };
	}
	config = { ...config, requestGuard: config.requestGuard === true || config.modelApproval !== null };
	let systemPrompt = BASELINE_SYSTEM_PROMPT;
	if ("file" in config.systemPrompt) {
		const p = resolve(path ? dirname(path) : process.cwd(), config.systemPrompt.file);
		systemPrompt = readFileSync(p, "utf8");
	}
	const canonical = JSON.stringify(config, Object.keys(flattenKeys(config)).sort());
	return {
		config,
		sha256: createHash("sha256").update(canonical).update("\0").update(systemPrompt).digest("hex"),
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
