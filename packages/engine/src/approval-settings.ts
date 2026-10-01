import { isAbsolute } from "node:path";
import { capabilitiesFor, pricingFor, PROVIDERS, type Currency, type Effort, type EffortSetting } from "@mountains/providers";

export interface ApprovalAllowRule {
	id: string;
	tool: string;
	arguments: Record<string, unknown>;
	cwd: string;
	/** Exact, complete latest user request; no substring or wildcard matching. */
	userRequest: string;
}

export interface ApprovalSettings {
	model: string;
	baseUrl: string;
	/** A separate credential selection; never inherits the main model's key. */
	apiKeyEnv: string;
	profile: "openai" | "deepseek" | "zhipu" | "moonshot";
	thinking: { enabled: boolean; effort: EffortSetting };
	maxTokens: number;
	maxInputChars: number;
	contextMessages: number;
	timeoutMs: number;
	maxRequests: number;
	/** Approval sub-budget, denominated in the main task's currency. */
	maxCost: number;
	maxDenials: number;
	pricing: { currency: Currency; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number; version: string };
	/** Multiplies approval-native currency into task currency. Omitted only for identity conversion. */
	conversion?: { rate: number; asOf: string };
	allowRules: ApprovalAllowRule[];
	manualTools: string[];
	supportedEfforts?: EffortSetting[];
	effortMapping?: Partial<Record<Effort, string>>;
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	disabledReasoningEffort?: string;
}

const EFFORTS = ["low", "high", "max"] as const;
const SETTINGS_KEYS = ["model", "baseUrl", "apiKeyEnv", "profile", "thinking", "maxTokens", "maxInputChars", "contextMessages", "timeoutMs", "maxRequests", "maxCost", "maxDenials", "pricing", "conversion", "allowRules", "manualTools", "supportedEfforts", "effortMapping", "maxTokensField", "disabledReasoningEffort"];

function fail(path: string, message: string): never { throw new Error(`modelApproval.${path} ${message}`); }
function record(value: unknown, path: string, allowed?: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, "必须为普通对象");
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || (allowed && !allowed.includes(key))) fail(path, "含未知字段；密钥只能从 apiKeyEnv 指定的环境变量读取");
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(path, "必须是 JSON 数据，不能含访问器");
	}
	return value as Record<string, unknown>;
}
function text(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) fail(path, "必须为非空字符串");
	return value;
}
function positive(value: unknown, path: string, zero = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || (zero ? value < 0 : value <= 0)) fail(path, zero ? "必须为有限非负数" : "必须为有限正数");
	return value;
}
function integer(value: unknown, path: string, fallback: number, zero = false): number {
	const n = value === undefined ? fallback : positive(value, path, zero);
	if (!Number.isSafeInteger(n) || n > 2_147_483_647) fail(path, "必须为有效整数");
	return n;
}
function currency(value: unknown, path: string): Currency {
	if (value !== "USD" && value !== "CNY") fail(path, "只支持 USD 或 CNY");
	return value;
}
function jsonCopy(value: unknown, path: string, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
	if (typeof value !== "object" || seen.has(value) || seen.size > 64) fail(path, "必须为无环的 JSON 数据");
	seen.add(value);
	let copy: unknown;
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) fail(path, "必须为普通 JSON 数组");
		copy = Array.from({ length: value.length }, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(path, "不能含数组空位或访问器");
			return jsonCopy(descriptor.value, path, seen);
		});
	} else copy = Object.fromEntries(Object.entries(record(value, path)).map(([key, item]) => [key, jsonCopy(item, path, seen)]));
	seen.delete(value);
	return copy;
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function date(value: unknown): string {
	const s = text(value, "conversion.asOf");
	if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s.slice(0, 10)).toISOString().slice(0, 10) !== s.slice(0, 10)) fail("conversion.asOf", "必须为有效 ISO 日期或时间");
	return s;
}

/** Normalize once before hashing or execution; the returned tree is detached and frozen. */
export function validateApprovalSettings(raw: unknown, taskCurrency: Currency): ApprovalSettings {
	currency(taskCurrency, "taskCurrency");
	const r = record(jsonCopy(raw, "settings"), "settings", SETTINGS_KEYS);
	const model = text(r.model, "model");
	const capabilities = capabilitiesFor(model);
	const knownPricing = pricingFor(model);
	const profile = r.profile === undefined ? capabilities?.provider : r.profile;
	if (profile !== "openai" && profile !== "deepseek" && profile !== "zhipu" && profile !== "moonshot") fail("profile", "未知模型必须显式指定协议 openai/deepseek/zhipu/moonshot");
	if (capabilities && capabilities.provider !== profile) fail("profile", "必须与已登记模型的协议一致");
	const baseUrl = text(r.baseUrl === undefined ? (capabilities ? PROVIDERS[capabilities.provider].baseUrl : undefined) : r.baseUrl, "baseUrl");
	let url: URL;
	try { url = new URL(baseUrl); } catch { fail("baseUrl", "必须为有效 HTTP(S) 地址"); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail("baseUrl", "必须为不含凭据、查询或片段的 HTTP(S) 地址");
	const apiKeyEnv = r.apiKeyEnv === undefined ? "MOUNTAINS_APPROVAL_API_KEY" : text(r.apiKeyEnv, "apiKeyEnv");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) fail("apiKeyEnv", "必须为环境变量名，不能填写密钥");
	const thinkingRaw = r.thinking === undefined ? {} : record(r.thinking, "thinking", ["enabled", "effort"]);
	const enabled = thinkingRaw.enabled === undefined ? (profile !== "deepseek") : thinkingRaw.enabled;
	const effort = thinkingRaw.effort === undefined ? "default" : thinkingRaw.effort;
	if (typeof enabled !== "boolean") fail("thinking.enabled", "必须为布尔值");
	if (effort !== "default" && !EFFORTS.includes(effort as Effort)) fail("thinking.effort", "只支持 default/low/high/max");
	if (!enabled && effort !== "default") fail("thinking.effort", "关闭思考时必须为 default");
	if (profile === "zhipu" && !enabled) fail("thinking", "zhipu 协议要求开启思考");
	if (profile === "moonshot" && (!enabled || effort !== "default")) fail("thinking", "moonshot 协议只支持始终开启思考且 effort=default");
	const pricingRaw = r.pricing === undefined ? undefined : record(r.pricing, "pricing", ["currency", "inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "version"]);
	if (!pricingRaw && !knownPricing) fail("pricing", "未知价格必须显式配置，不能按零费用处理");
	const pricing: ApprovalSettings["pricing"] = pricingRaw ? {
		currency: currency(pricingRaw.currency, "pricing.currency"),
		inputPerMillion: positive(pricingRaw.inputPerMillion, "pricing.inputPerMillion"),
		outputPerMillion: positive(pricingRaw.outputPerMillion, "pricing.outputPerMillion"),
		...(pricingRaw.cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion: positive(pricingRaw.cacheReadPerMillion, "pricing.cacheReadPerMillion", true) }),
		version: text(pricingRaw.version, "pricing.version"),
	} : {
		currency: knownPricing!.currency,
		inputPerMillion: Math.max(knownPricing!.peak.cacheMiss, knownPricing!.peak.cacheWrite ?? 0),
		outputPerMillion: knownPricing!.peak.output,
		cacheReadPerMillion: knownPricing!.peak.cacheHit,
		version: `${knownPricing!.version}/peak-upper-bound`,
	};
	let conversion: ApprovalSettings["conversion"];
	if (r.conversion !== undefined) {
		const c = record(r.conversion, "conversion", ["rate", "asOf"]);
		conversion = { rate: positive(c.rate, "conversion.rate"), asOf: date(c.asOf) };
		if (pricing.currency === taskCurrency && conversion.rate !== 1) fail("conversion.rate", "同币种必须为 1");
	} else if (pricing.currency !== taskCurrency) fail("conversion", "跨币种必须显式给出 rate 与 asOf；rate 把审批原币换成主任务币");
	const allowRulesRaw = r.allowRules === undefined ? [] : r.allowRules;
	if (!Array.isArray(allowRulesRaw)) fail("allowRules", "必须为数组");
	const ids = new Set<string>();
	const allowRules = allowRulesRaw.map((rawRule, index): ApprovalAllowRule => {
		const path = `allowRules[${index}]`;
		const rule = record(rawRule, path, ["id", "tool", "arguments", "cwd", "userRequest"]);
		const id = text(rule.id, `${path}.id`);
		if (ids.has(id)) fail(path, "规则 id 不得重复");
		ids.add(id);
		const tool = text(rule.tool, `${path}.tool`);
		if (!/^[A-Za-z0-9_-]+$/.test(tool)) fail(`${path}.tool`, "必须为精确工具名，不能使用通配符");
		const cwd = text(rule.cwd, `${path}.cwd`);
		if (!isAbsolute(cwd)) fail(`${path}.cwd`, "必须为绝对路径");
		return { id, tool, arguments: jsonCopy(record(rule.arguments, `${path}.arguments`), `${path}.arguments`) as Record<string, unknown>, cwd, userRequest: text(rule.userRequest, `${path}.userRequest`) };
	});
	const manualToolsRaw = r.manualTools === undefined ? [] : r.manualTools;
	if (!Array.isArray(manualToolsRaw)) fail("manualTools", "必须为数组");
	const manualTools = manualToolsRaw.map((value) => {
		const tool = text(value, "manualTools");
		if (!/^[A-Za-z0-9_-]+$/.test(tool)) fail("manualTools", "必须为精确工具名");
		return tool;
	});
	if (new Set(manualTools).size !== manualTools.length) fail("manualTools", "不得重复");
	let supportedEfforts: EffortSetting[] = [...(capabilities?.effortLevels ?? [])];
	if (r.supportedEfforts !== undefined) {
		if (!Array.isArray(r.supportedEfforts) || r.supportedEfforts.some(e => e !== "default" && !EFFORTS.includes(e as Effort)) || new Set(r.supportedEfforts).size !== r.supportedEfforts.length) fail("supportedEfforts", "必须为不重复的 default/low/high/max 数组");
		supportedEfforts = [...r.supportedEfforts] as EffortSetting[];
	}
	let effortMapping: ApprovalSettings["effortMapping"];
	if (r.effortMapping !== undefined) {
		const mapping = record(r.effortMapping, "effortMapping", EFFORTS);
		effortMapping = Object.fromEntries(Object.entries(mapping).map(([key, value]) => {
			if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) fail("effortMapping", "必须为有效协议字段值");
			return [key, value];
		}));
	}
	if (effort !== "default" && (!supportedEfforts.includes(effort as Effort) || (capabilities && !capabilities.effortLevels.includes(effort as Effort)))) fail("thinking.effort", "必须是模型明确支持的强度；未知模型请给 supportedEfforts");
	if (profile === "openai" && effort === "max" && !effortMapping?.max) fail("effortMapping.max", "OpenAI max 必须显式映射为供应商支持的值");
	if (capabilities && effort !== "default" && effortMapping?.[effort as Effort] && !capabilities.effortLevels.includes(effortMapping[effort as Effort] as Effort)) fail("effortMapping", "映射不受已登记模型支持");
	let disabledReasoningEffort: string | undefined;
	if (r.disabledReasoningEffort !== undefined) {
		if (typeof r.disabledReasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(r.disabledReasoningEffort)) fail("disabledReasoningEffort", "必须为有效协议字段值");
		disabledReasoningEffort = r.disabledReasoningEffort;
	}
	if (profile === "openai" && !enabled && !disabledReasoningEffort) fail("disabledReasoningEffort", "OpenAI 关闭思考必须显式指定供应商字段值");
	if (r.maxTokensField !== undefined && r.maxTokensField !== "max_tokens" && r.maxTokensField !== "max_completion_tokens") fail("maxTokensField", "只支持 max_tokens/max_completion_tokens");
	const maxTokens = integer(r.maxTokens, "maxTokens", 512);
	if (maxTokens > Math.min(1_000_000, capabilities?.maxOutputTokens ?? 1_000_000)) fail("maxTokens", "超过审批接口或已登记模型的输出上限");
	const timeoutMs = integer(r.timeoutMs, "timeoutMs", 15_000);
	if (timeoutMs > 600_000) fail("timeoutMs", "超过审批接口的 600000 毫秒上限");
	return freeze({ model, baseUrl, apiKeyEnv, profile, thinking: { enabled, effort: effort as EffortSetting },
		maxTokens, maxInputChars: integer(r.maxInputChars, "maxInputChars", 20_000),
		contextMessages: integer(r.contextMessages, "contextMessages", 6, true), timeoutMs,
		maxRequests: integer(r.maxRequests, "maxRequests", 12), maxCost: positive(r.maxCost, "maxCost"), maxDenials: integer(r.maxDenials, "maxDenials", 2),
		pricing, ...(conversion ? { conversion } : {}), allowRules, manualTools,
		supportedEfforts, ...(effortMapping ? { effortMapping } : {}), maxTokensField: r.maxTokensField ?? "max_tokens",
		...(disabledReasoningEffort === undefined ? {} : { disabledReasoningEffort }),
	});
}
