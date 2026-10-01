/**
 * 供应商与模型能力表（Mountains 自己维护，不使用 Pi 的模型目录数值）。
 * 当前快照的配置与限制见 docs/models.md。
 */
export type ProviderId = "deepseek" | "zhipu" | "moonshot";
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
};

export type Effort = "low" | "high" | "max";

/**
 * 思考参数的线上格式：
 * - deepseek：thinking {type} + reasoning_effort
 * - zai：thinking {type:"enabled", clear_thinking:false}（保留式思考），可选 reasoning_effort
 * - always-on：模型始终思考，不发任何思考参数（传 disabled 会报错）
 */
export type ThinkingFormat = "deepseek" | "zai" | "always-on";

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
	requiresReasoningPassback: true;
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

export const CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
	"deepseek-flash": DEEPSEEK_FLASH,
	"glm-5.3-flash": GLM_53_FLASH,
	"kimi-k2.7-code": KIMI_K27_CODE,
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
