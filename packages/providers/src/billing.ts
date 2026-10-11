import type { ModelBillingReceipt, Usage } from "@mountains/protocol";
import { capabilitiesFor, type Currency, PROVIDERS, responseModelMatches } from "./capabilities.ts";
import { pricingFor } from "./pricing.ts";
import { normalizeUsage, type RawUsage } from "./usage.ts";

const FREE_MODEL = "Qwen/Qwen2.5-7B-Instruct";
const ROUTER_MODEL = "openai/gpt-4.1-mini";
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function exactEndpoint(endpoint: unknown, expected: string): boolean {
	// 仅允许同一基址或其尾斜杠；查询、认证信息、额外路径和其它主机均不是官方预设。
	return typeof endpoint === "string" && (endpoint === expected || endpoint === `${expected}/`);
}

function validAggregate(raw: RawUsage | null | undefined): raw is RawUsage & { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
	if (!raw || !count(raw.prompt_tokens) || !count(raw.completion_tokens) || !count(raw.total_tokens)) return false;
	if (raw.prompt_tokens + raw.completion_tokens !== raw.total_tokens) return false;
	const prompt = raw.prompt_tokens;
	if (raw.prompt_tokens_details !== undefined && raw.prompt_tokens_details !== null && (typeof raw.prompt_tokens_details !== "object" || Array.isArray(raw.prompt_tokens_details))) return false;
	if (raw.completion_tokens_details !== undefined && raw.completion_tokens_details !== null && (typeof raw.completion_tokens_details !== "object" || Array.isArray(raw.completion_tokens_details))) return false;
	const detail = raw.prompt_tokens_details;
	const caches = [raw.prompt_cache_hit_tokens, raw.prompt_cache_miss_tokens, raw.cached_tokens, detail?.cached_tokens, detail?.cache_write_tokens];
	// 省略/空缓存统计是未知；显式给出不合法数字不能凭总账单绕过。
	if (caches.some(value => value !== undefined && value !== null && (!count(value) || value > prompt))) return false;
	if (count(raw.prompt_cache_hit_tokens) && count(raw.prompt_cache_miss_tokens) && raw.prompt_cache_hit_tokens + raw.prompt_cache_miss_tokens !== raw.prompt_tokens) return false;
	const knownHit = raw.prompt_cache_hit_tokens ?? detail?.cached_tokens ?? raw.cached_tokens;
	if (count(knownHit) && count(raw.prompt_cache_miss_tokens) && knownHit + raw.prompt_cache_miss_tokens !== prompt) return false;
	const reportedHits = [raw.prompt_cache_hit_tokens, raw.cached_tokens, detail?.cached_tokens].filter(count);
	if (reportedHits.some(hit => hit !== reportedHits[0])) return false;
	if (count(detail?.cached_tokens) && count(detail?.cache_write_tokens) && detail.cached_tokens + detail.cache_write_tokens > raw.prompt_tokens) return false;
	const reasoning = raw.completion_tokens_details?.reasoning_tokens;
	if (reasoning !== undefined && reasoning !== null && (!count(reasoning) || reasoning > raw.completion_tokens)) return false;
	return true;
}

function usageMatches(model: string, raw: RawUsage, usage: Usage): boolean {
	const provider = capabilitiesFor(model)?.provider;
	if (!provider) return false;
	const expected = normalizeUsage(provider, raw);
	if (expected.input !== null && expected.cacheRead !== null && expected.input + expected.cacheRead + (expected.cacheWrite ?? 0) !== raw.prompt_tokens) return false;
	return (["input", "cacheRead", "cacheWrite", "output", "reasoning", "total", "partial"] as const).every(key => usage[key] === expected[key]);
}

function freeRates(model: string): boolean {
	const pricing = pricingFor(model, "CNY");
	return !!pricing && pricing.provider === "siliconflow" && [pricing.peak, pricing.offPeak].every(rates => rates.cacheHit === 0 && rates.cacheMiss === 0 && rates.output === 0 && (rates.cacheWrite === undefined || rates.cacheWrite === 0));
}

/** 再次核对适配器附加的官方账单；缓存统计未知仍保持未知。 */
export function verifiedBillingReceipt(model: string, raw: RawUsage | null | undefined, usage: Usage, receipt: ModelBillingReceipt | null | undefined, currency: Currency): ModelBillingReceipt | null {
	if (!receipt || !validAggregate(raw) || !usageMatches(model, raw, usage) || receipt.model !== model || receipt.currency !== currency || !amount(receipt.amount)) return null;
	if (receipt.inputTokens !== raw.prompt_tokens || receipt.outputTokens !== raw.completion_tokens || receipt.totalTokens !== raw.total_tokens) return null;
	if (receipt.kind === "openrouter-usage-cost") {
		if (model !== ROUTER_MODEL || currency !== "USD" || !exactEndpoint(receipt.endpoint, PROVIDERS.openrouter.baseUrl) || !amount(raw.cost) || receipt.amount !== raw.cost) return null;
	} else if (receipt.kind === "siliconflow-free") {
		if (model !== FREE_MODEL || currency !== "CNY" || !exactEndpoint(receipt.endpoint, PROVIDERS.siliconflow.baseUrl) || receipt.amount !== 0 || !freeRates(model)) return null;
		// 官方免费模型的可选 cost 不能与零费用声明矛盾。
		if (raw.cost !== undefined && (!amount(raw.cost) || raw.cost !== 0)) return null;
	} else return null;
	return Object.freeze({ kind: receipt.kind, endpoint: receipt.endpoint, model: receipt.model, currency: receipt.currency, amount: receipt.amount,
		inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, totalTokens: receipt.totalTokens });
}

/** 官方协议已经给出矛盾数据；不能隐藏矛盾，再按目录价伪称费用已知。 */
export function officialBillingReceiptRejected(model: string, endpoint: string, raw: RawUsage | null | undefined, usage: Usage, responseModel: string | null): boolean {
	const router = model === ROUTER_MODEL && exactEndpoint(endpoint, PROVIDERS.openrouter.baseUrl);
	const free = model === FREE_MODEL && exactEndpoint(endpoint, PROVIDERS.siliconflow.baseUrl);
	if (!router && !free) return false;
	if (!validAggregate(raw) || !usageMatches(model, raw, usage) || responseModel !== null && !responseModelMatches(model, responseModel)) return true;
	if (raw.cost !== undefined && !amount(raw.cost)) return true;
	if (free) return responseModel === null || !freeRates(model) || raw.cost !== undefined && raw.cost !== 0;
	// OR 未给实际费用时，完整标准 usage 仍能使用原有的保守目录估算。
	return raw.cost !== undefined && responseModel === null;
}

/** 仅供 ChatCompletionsAdapter 在匹配真实请求/响应身份之后建立证据。 */
export function officialBillingReceipt(model: string, endpoint: string, raw: RawUsage | null | undefined, usage: Usage): ModelBillingReceipt | undefined {
	if (!validAggregate(raw)) return undefined;
	let receipt: ModelBillingReceipt;
	if (model === ROUTER_MODEL && exactEndpoint(endpoint, PROVIDERS.openrouter.baseUrl) && amount(raw.cost)) {
		receipt = { kind: "openrouter-usage-cost", endpoint, model, currency: "USD", amount: raw.cost, inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens, totalTokens: raw.total_tokens };
	} else if (model === FREE_MODEL && exactEndpoint(endpoint, PROVIDERS.siliconflow.baseUrl) && freeRates(model)) {
		receipt = { kind: "siliconflow-free", endpoint, model, currency: "CNY", amount: 0, inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens, totalTokens: raw.total_tokens };
	} else return undefined;
	return verifiedBillingReceipt(model, raw, usage, receipt, receipt.currency) ?? undefined;
}
