import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type ApprovalPolicy, type ApprovalSettings, BENCH_APPROVAL, DEFAULT_LIMITS, DEFAULT_RETRY, type RetryPolicy, type RunLimits, validateApprovalSettings } from "@mountains/engine";
import { capabilitiesFor, currencyOf, type Currency, type EffortSetting, pricingFor, PROVIDERS, providerOf, thinkingSettingError } from "@mountains/providers";

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
	/**
	 * effort 为 "default" 时不发 reasoning_effort（服务端默认）；各模型允许的取值见能力表。
	 * "ultracode" 是最高一档：用模型最高的思考强度，并开启多 Agent 协作（见 engineThinking）。
	 */
	thinking: { enabled: boolean; effort: EffortSetting | "ultracode" };
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
	/** Request budget protection: reserve the worst case before each paid request and settle it after. On by default; model approval always enables it. */
	requestGuard: boolean;
	/** Mountains 自己的累计花费台账（全局上限由 MOUNTAINS_BUDGET 决定，按模型的计价币种） */
	spendLedger: string;
	checkpoints: boolean;
	/** Memory: the model may search earlier conversations (memory_search). Absent or false adds nothing, and leaves the default config hash as it was. */
	memory?: boolean;
	/** 读取上限、批量编辑、编辑后回显改动附近的源码 */
	tools: { read: { defaultLines: number; maxLines: number; maxLineChars: number; lineNumbers: "all" | "sparse" }; batchEdit: boolean; editFeedback: boolean };
	/**
	 * 技能：在项目的 .mountains/skills 与 .agents/skills、~/.mountains/skills、~/.agents/skills 以及 dirs 里查找；
	 * enable 打开带工具的内置技能；permissions 按名字（可用 *）设 allow / ask / deny，项目里的技能默认 ask。
	 */
	skills: { enabled: boolean; dirs: string[]; enable: string[]; permissions: Record<string, "allow" | "ask" | "deny"> };
	/**
	 * 内置技能 computer-use（要在 skills.enable 里打开）：按应用名（可用 *）预先授权 read / act / deny，未列出的应用逐个询问。
	 * screenshots 为 false 时从不把窗口截图发给模型，能看图的模型也只用无障碍树。
	 */
	computerUse: { apps: Record<string, "read" | "act" | "deny">; screenshots: boolean; cursorColor?: string; web?: { headless?: boolean; profileDir?: string; downloadDir?: string };
		/** A grounding model for finding controls in window images (UI-TARS on a local server, for example). */
		grounding?: { baseUrl: string; model: string; apiKeyEnv?: string; coordinates?: "image" | "thousandths"; maxTokens?: number; timeoutMs?: number } };
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
	requestGuard: true,
	spendLedger: "~/.mountains/spend.jsonl",
	checkpoints: true,
	tools: { read: { defaultLines: 2000, maxLines: 2000, maxLineChars: 2000, lineNumbers: "all" }, batchEdit: true, editFeedback: true },
	skills: { enabled: true, dirs: [], enable: [], permissions: {} },
	computerUse: { apps: {}, screenshots: true },
};

const KNOWN_KEYS = new Set([...Object.keys(DEFAULT_CONFIG), "billingCurrency", "contextWindow", "userIdFixed", "memory"]);

export interface LoadedConfig {
	config: MountainsConfig;
	/** 规范化后配置全文的 sha256 */
	sha256: string;
	/** A custom system prompt from a file; null uses the built-in one. */
	systemPrompt: string | null;
	source: string | null;
	/** An explicit ledger path takes precedence over MOUNTAINS_HOME, even if it matches the default. */
	spendLedgerExplicit: boolean;
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
	validateNested(config);
	const skills = config.skills as unknown as Record<string, unknown>;
	const unknownSkillKey = Object.keys(skills).find(key => !["enabled", "dirs", "enable", "permissions"].includes(key));
	if (unknownSkillKey) throw new Error(`未知配置项：skills.${unknownSkillKey}`);
	for (const key of ["dirs", "enable"] as const) {
		if (!Array.isArray(skills[key]) || (skills[key] as unknown[]).some(v => typeof v !== "string" || !v)) throw new Error(`skills.${key} 必须是非空字符串数组`);
	}
	if (!skills.permissions || typeof skills.permissions !== "object" || Array.isArray(skills.permissions) ||
		Object.values(skills.permissions).some(v => v !== "allow" && v !== "ask" && v !== "deny")) throw new Error("skills.permissions 的值只能是 allow、ask 或 deny");
	const cu = config.computerUse as unknown as Record<string, unknown>;
	const unknownComputerKey = Object.keys(cu).find(key => key !== "apps" && key !== "screenshots" && key !== "web" && key !== "grounding" && key !== "cursorColor");
	if (unknownComputerKey) throw new Error(`未知配置项：computerUse.${unknownComputerKey}`);
	if (cu.cursorColor !== undefined && (typeof cu.cursorColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(cu.cursorColor))) throw new Error("computerUse.cursorColor 必须是 #RRGGBB 格式的颜色");
    if(cu.web!==undefined){
        if(!cu.web||typeof cu.web!=="object"||Array.isArray(cu.web))throw new Error("computerUse.web 必须是对象");
        const web=cu.web as Record<string,unknown>;
        for(const [key,value] of Object.entries(web)){
            if(!["headless","profileDir","downloadDir"].includes(key))throw new Error(`未知配置项：computerUse.web.${key}`);
            if(key==="headless"?typeof value!=="boolean":typeof value!=="string"||!value)throw new Error(`computerUse.web.${key} 格式错误`);
        }
    }
	if (cu.grounding !== undefined) {
		const g = cu.grounding as Record<string, unknown>;
		if (!g || typeof g !== "object" || Array.isArray(g)) throw new Error("computerUse.grounding 必须是对象");
		for (const key of Object.keys(g)) if (!["baseUrl", "model", "apiKeyEnv", "coordinates", "maxTokens", "timeoutMs"].includes(key)) throw new Error(`未知配置项：computerUse.grounding.${key}`);
		if (typeof g.baseUrl !== "string" || !/^https?:\/\//.test(g.baseUrl)) throw new Error("computerUse.grounding.baseUrl 必须是 http(s) 地址");
		if (typeof g.model !== "string" || !g.model) throw new Error("computerUse.grounding.model 必须是非空字符串");
		if (g.apiKeyEnv !== undefined && (typeof g.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(g.apiKeyEnv))) throw new Error("computerUse.grounding.apiKeyEnv 必须是环境变量名");
		if (g.coordinates !== undefined && g.coordinates !== "image" && g.coordinates !== "thousandths") throw new Error("computerUse.grounding.coordinates 只能是 image 或 thousandths");
		for (const [key, limit] of [["maxTokens", 4096], ["timeoutMs", 120_000]] as const) {
			const value = g[key];
			if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > limit)) throw new Error(`computerUse.grounding.${key} 必须是 1 到 ${limit} 的整数`);
		}
	}
	if (!cu.apps || typeof cu.apps !== "object" || Array.isArray(cu.apps) || Object.values(cu.apps).some(v => v !== "read" && v !== "act" && v !== "deny")) throw new Error("computerUse.apps 的值只能是 read、act 或 deny");
	for (const [name, value] of Object.entries({ requestGuard: config.requestGuard, batchEdit: config.tools.batchEdit, editFeedback: config.tools.editFeedback, "skills.enabled": skills.enabled, "computerUse.screenshots": cu.screenshots })) {
		if (typeof value !== "boolean") throw new Error(`配置 ${name} 必须为布尔值`);
	}
	if (config.contextWindow !== undefined && (!Number.isSafeInteger(config.contextWindow) || config.contextWindow < 32_768)) throw new Error("contextWindow 必须是不小于 32768 的整数");
	for (const [name, value] of Object.entries({ maxTokens: config.maxTokens, "limits.maxTurns": config.limits.maxTurns, "limits.maxInputTokens": config.limits.maxInputTokens, "limits.maxOutputTokens": config.limits.maxOutputTokens, "retry.maxAttempts": config.retry.maxAttempts })) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为有效的正整数`);
	}
	for (const [name, value] of Object.entries({ "limits.maxCost": config.limits.maxCost, "retry.baseDelayMs": config.retry.baseDelayMs, ...(config.retry.maxDelayMs !== undefined ? { "retry.maxDelayMs": config.retry.maxDelayMs } : {}) })) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} 必须为有限非负数`);
	}
	for (const [name, value] of Object.entries({ maxRequests: config.limits.maxRequests, maxDurationMs: config.limits.maxDurationMs })) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) throw new Error(`limits.${name} 必须为有效的正整数`);
	}
	if ((config as unknown as Record<string, unknown>).apiKey !== undefined) throw new Error("配置文件不允许包含 apiKey；Key 只从环境变量读取");
	const provider = providerOf(config.model);
	if (!config.baseUrl || !config.apiKeyEnv) {
		if (!provider) throw new Error(`无法由模型 ${config.model} 推断供应商：请在配置中给出 baseUrl 与 apiKeyEnv`);
		config = { ...config, baseUrl: config.baseUrl || PROVIDERS[provider].baseUrl, apiKeyEnv: config.apiKeyEnv || PROVIDERS[provider].apiKeyEnv };
	}
	if (config.thinking.effort === "ultracode" && !config.thinking.enabled) throw new Error("思考设置无效：UltraCode 需要开启思考");
	const thinkingError = thinkingSettingError(config.model, engineThinking(config));
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
		spendLedgerExplicit: Object.hasOwn(fileConfig, "spendLedger") || overrides.spendLedger !== undefined,
	};
}

const RISKS: readonly unknown[] = ["read-only", "workspace-write", "network", "dangerous"];

function objectAt(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`配置 ${path} 必须是对象`);
	const extra = Object.keys(value).find(key => !keys.includes(key));
	if (extra) throw new Error(`未知配置项：${path}.${extra}`);
	return value as Record<string, unknown>;
}

/** Nested sections are checked as strictly as the top level: a misspelt key or a wrong type stops the run before any request. */
function validateNested(config: MountainsConfig): void {
	objectAt(config.limits, "limits", ["maxTurns", "maxInputTokens", "maxOutputTokens", "maxCost", "maxRequests", "maxDurationMs"]);
	objectAt(config.retry, "retry", ["maxAttempts", "baseDelayMs", "maxDelayMs"]);
	const thinking = objectAt(config.thinking, "thinking", ["enabled", "effort"]);
	const tools = objectAt(config.tools, "tools", ["read", "batchEdit", "editFeedback"]);
	const read = objectAt(tools.read, "tools.read", ["defaultLines", "maxLines", "maxLineChars", "lineNumbers"]);
	for (const key of ["defaultLines", "maxLines", "maxLineChars"]) {
		if (!Number.isSafeInteger(read[key]) || (read[key] as number) <= 0) throw new Error(`tools.read.${key} 必须为有效的正整数`);
	}
	if (read.lineNumbers !== "all" && read.lineNumbers !== "sparse") throw new Error("tools.read.lineNumbers 只能是 all 或 sparse");
	const approval = objectAt(config.approval, "approval", ["rules", "fallback"]);
	if (!Array.isArray(approval.rules)) throw new Error("approval.rules 必须是数组");
	// A rule without risks or pattern matches every operation, so a misspelt key would quietly widen it.
	approval.rules.forEach((value: unknown, i: number) => {
		const at = `approval.rules[${i}]`;
		const rule = objectAt(value, at, ["id", "decision", "risks", "pattern"]);
		if (typeof rule.id !== "string" || !rule.id) throw new Error(`${at}.id 必须是非空字符串`);
		if (rule.decision !== "allow" && rule.decision !== "deny") throw new Error(`${at}.decision 只能是 allow 或 deny`);
		if (rule.risks !== undefined && (!Array.isArray(rule.risks) || !rule.risks.length || rule.risks.some(r => !RISKS.includes(r)))) throw new Error(`${at}.risks 必须是非空数组，取值为 ${RISKS.join("、")}`);
		if (rule.pattern !== undefined) {
			if (typeof rule.pattern !== "string" || !rule.pattern) throw new Error(`${at}.pattern 必须是非空字符串`);
			try { new RegExp(rule.pattern); } catch { throw new Error(`${at}.pattern 不是有效的正则表达式`); }
		}
	});
	if (approval.fallback !== "deny" && approval.fallback !== "ask") throw new Error("approval.fallback 只能是 deny 或 ask");
	objectAt(config.systemPrompt, "systemPrompt", ["builtin", "file"]);
	for (const [name, value] of Object.entries({ checkpoints: config.checkpoints, ...(config.memory !== undefined ? { memory: config.memory } : {}), verbatimToolArguments: config.verbatimToolArguments, "thinking.enabled": thinking.enabled })) {
		if (typeof value !== "boolean") throw new Error(`配置 ${name} 必须为布尔值`);
	}
	if (!["none", "per-run", "fixed"].includes(config.userIdMode)) throw new Error("userIdMode 只能是 none、per-run 或 fixed");
	if (typeof config.spendLedger !== "string" || !config.spendLedger) throw new Error("spendLedger 必须是非空字符串");
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

/** The thinking setting sent to the model: UltraCode uses the model's highest effort. */
export function engineThinking(config: MountainsConfig): { enabled: boolean; effort: EffortSetting } {
	if (config.thinking.effort !== "ultracode") return { enabled: config.thinking.enabled, effort: config.thinking.effort };
	return { enabled: true, effort: capabilitiesFor(config.model)?.effortLevels.at(-1) ?? "default" };
}
