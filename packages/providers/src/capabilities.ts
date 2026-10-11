/**
 * 供应商与模型能力表（Mountains 自己维护，不使用 Pi 的模型目录数值）。
 */
export type ProviderId = "deepseek" | "zhipu" | "moonshot" | "openai" | "gemini" | "qwen" | "siliconflow" | "openrouter";
export type Currency = "USD" | "CNY";

export interface ProviderInfo {
	id: ProviderId;
	displayName: string;
	/** 官方 OpenAI 兼容基址（请求路径 = 基址 + /chat/completions） */
	baseUrl: string;
	/** 读取 Key 的环境变量名 */
	apiKeyEnv: string;
	/** 官方价格的币种；费用一律按原币种记账，不做汇率换算 */
	currency: Currency;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = {
	deepseek: { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", currency: "USD" },
	zhipu: { id: "zhipu", displayName: "智谱 BigModel", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY", currency: "CNY" },
	moonshot: { id: "moonshot", displayName: "Moonshot（中国大陆）", baseUrl: "https://api.moonshot.cn/v1", apiKeyEnv: "MOONSHOT_API_KEY", currency: "CNY" },
	openai: { id: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", currency: "USD" },
	gemini: { id: "gemini", displayName: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY", currency: "USD" },
	qwen: { id: "qwen", displayName: "阿里云百炼（北京）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "QWEN_API_KEY", currency: "CNY" },
	siliconflow: { id: "siliconflow", displayName: "硅基流动（中国）", baseUrl: "https://api.siliconflow.cn/v1", apiKeyEnv: "SILICONFLOW_API_KEY", currency: "CNY" },
	openrouter: { id: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", currency: "USD" },
};

export type Effort = "low" | "high" | "max";

/**
 * 思考参数的线上格式：
 * - deepseek：thinking {type} + reasoning_effort
 * - zai：thinking {type:"enabled", clear_thinking:false}（保留式思考），可选 reasoning_effort
 * - always-on：模型始终思考，不发任何思考参数（传 disabled 会报错）
 * - none：首批通用工具模型仅使用非思考模式，不发送供应商专属思考字段
 */
export type ThinkingFormat = "deepseek" | "zai" | "always-on" | "none";

export interface ModelCapabilities {
	provider: ProviderId;
	id: string;
	displayName: string;
	contextWindow: number;
	maxOutputTokens: number;
	inputModalities: readonly ("text" | "image")[];
	thinkingFormat: ThinkingFormat;
	/** 支持的 reasoning_effort 取值；空表示不支持该参数 */
	effortLevels: readonly Effort[];
	/** 不发 reasoning_effort 时服务端的默认强度；不支持时为 null */
	defaultEffort: Effort | null;
	/** 带工具的多轮对话必须回传 reasoning_content */
	requiresReasoningPassback: boolean;
	/** 已核实的固定请求参数；用户和模型不能修改。 */
	requestExtras?: Readonly<Record<string, unknown>>;
	/** 输出上限字段，默认沿用现有三家的 max_tokens。 */
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	/** 服务端可返回的精确模型版本；仅用于匹配这个请求，不跨供应商匹配。 */
	responseModelAliases?: readonly string[];
	/** 与 OpenCode 1.18.32 对该模型固定发送的采样参数保持一致（provider/transform.ts 的 temperature()） */
	fixedTemperature?: number;
	/** 自动前缀缓存（三家都没有显式断点）；命中字段名 */
	cache: { kind: "implicit-prefix"; hitField: string };
	/** 函数名必须匹配（DeepSeek 实测 400 错误信息；其他两家按 OpenAI 规范取同一约束） */
	toolNamePattern: RegExp;
}

export const DEEPSEEK_FLASH: ModelCapabilities = {
	provider: "deepseek",
	id: "deepseek-flash",
	displayName: "DeepSeek-V4.1-Flash",
	contextWindow: 1048576,
	maxOutputTokens: 393216,
	inputModalities: ["text", "image"],
	thinkingFormat: "deepseek",
	effortLevels: ["low", "high", "max"],
	defaultEffort: "high",
	requiresReasoningPassback: true,
	cache: { kind: "implicit-prefix", hitField: "prompt_cache_hit_tokens" },
	toolNamePattern: /^[a-zA-Z0-9_-]+$/,
};

/** 官方同页列明 Pro 的上下文/输出/思考能力；Pro 不支持 Flash 的图片输入。 */
export const DEEPSEEK_V4_PRO: ModelCapabilities = {
	...DEEPSEEK_FLASH, id: "deepseek-v4-pro", displayName: "DeepSeek-V4-Pro-0813", inputModalities: ["text"],
};

export const GLM_53_FLASH: ModelCapabilities = {
	provider: "zhipu",
	id: "glm-5.3-flash",
	displayName: "GLM-5.3-Flash",
	contextWindow: 1_000_000,
	maxOutputTokens: 131072,
	inputModalities: ["text", "image"],
	thinkingFormat: "zai",
	effortLevels: ["low", "high", "max"],
	defaultEffort: "max",
	requiresReasoningPassback: true,
	cache: { kind: "implicit-prefix", hitField: "prompt_tokens_details.cached_tokens" },
	toolNamePattern: /^[a-zA-Z0-9_-]+$/,
};

export const KIMI_K27_CODE: ModelCapabilities = {
	provider: "moonshot",
	id: "kimi-k2.7-code",
	displayName: "Kimi K2.7 Code",
	contextWindow: 262144,
	maxOutputTokens: 262144,
	inputModalities: ["text", "image"],
	thinkingFormat: "always-on",
	effortLevels: [],
	defaultEffort: null,
	requiresReasoningPassback: true,
	fixedTemperature: 1,
	cache: { kind: "implicit-prefix", hitField: "prompt_tokens_details.cached_tokens" },
	toolNamePattern: /^[a-zA-Z0-9_-]+$/,
};

/** 通用兼容接口使用非思考模型，不能回放 DeepSeek reasoning_content。 */
function nonReasoningModel(provider: ProviderId, id: string, displayName: string, contextWindow: number, maxOutputTokens: number, extra: Partial<ModelCapabilities> = {}): ModelCapabilities {
	return {
		provider, id, displayName, contextWindow, maxOutputTokens,
		inputModalities: ["text"], thinkingFormat: "none", effortLevels: [], defaultEffort: null,
		requiresReasoningPassback: false,
		cache: { kind: "implicit-prefix", hitField: "prompt_tokens_details.cached_tokens" },
		toolNamePattern: /^[a-zA-Z0-9_-]+$/,
		...extra,
	};
}

export const OPENAI_GPT41_MINI = nonReasoningModel("openai", "gpt-4.1-mini", "GPT-4.1 mini", 1_047_576, 32_768, {
	maxTokensField: "max_completion_tokens", responseModelAliases: ["gpt-4.1-mini-2025-04-14"],
});
export const QWEN_PLUS = nonReasoningModel("qwen", "qwen-plus", "Qwen Plus（非思考）", 1_000_000, 32_768, {
	requestExtras: { enable_thinking: false }, responseModelAliases: ["qwen-plus-2025-12-01"],
});
export const SILICONFLOW_QWEN25_7B = nonReasoningModel("siliconflow", "Qwen/Qwen2.5-7B-Instruct", "Qwen 2.5 7B（硅基流动）", 32_768, 4_096);
export const OPENROUTER_GPT41_MINI = nonReasoningModel("openrouter", "openai/gpt-4.1-mini", "GPT-4.1 mini（OpenRouter）", 1_047_576, 32_768, {
	responseModelAliases: ["openai/gpt-4.1-mini-2025-04-14"],
});

export const CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
	"deepseek-flash": DEEPSEEK_FLASH,
	"deepseek-v4-pro": DEEPSEEK_V4_PRO,
	"glm-5.3-flash": GLM_53_FLASH,
	"kimi-k2.7-code": KIMI_K27_CODE,
	"gpt-4.1-mini": OPENAI_GPT41_MINI,
	"qwen-plus": QWEN_PLUS,
	"Qwen/Qwen2.5-7B-Instruct": SILICONFLOW_QWEN25_7B,
	"openai/gpt-4.1-mini": OPENROUTER_GPT41_MINI,
};

/** 旧名路由到 V4.1-Flash（DeepSeek 价格页脚注 1） */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
	"deepseek-v4-flash": "deepseek-flash",
	"deepseek-v4-flash-vision-exp": "deepseek-flash",
};

export function canonicalModel(model: string): string {
	return MODEL_ALIASES[model] ?? model;
}

export function capabilitiesFor(model: string): ModelCapabilities | undefined {
	return CAPABILITIES[canonicalModel(model)];
}

/** 精确身份核对。不能用前缀匹配，因为同系列的其它版本可能采用不同价格。 */
export function responseModelMatches(requested: string, response: string): boolean {
	if (canonicalModel(requested) === canonicalModel(response)) return true;
	return capabilitiesFor(requested)?.responseModelAliases?.includes(response) ?? false;
}

/** 由模型 ID 推断供应商；未知模型按前缀猜测，猜不出返回 undefined */
export function providerOf(model: string): ProviderId | undefined {
	const cap = capabilitiesFor(model);
	if (cap) return cap.provider;
	const m = model.toLowerCase();
	if (m.startsWith("deepseek")) return "deepseek";
	if (m.startsWith("glm")) return "zhipu";
	if (m.startsWith("kimi") || m.startsWith("moonshot")) return "moonshot";
	return undefined;
}
