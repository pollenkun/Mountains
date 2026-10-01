/**
 * 官方价格表与费用估算。当前计价快照与限制见 docs/budgets-and-costs.md。
 * 费用一律是"估算"，按原币种记账（DeepSeek 美元，智谱与 Moonshot 人民币），不做汇率换算。
 * DeepSeek：中国法定节假日（全天非峰时）未建模，节假日按工作日规则计价，只会高估。
 * 智谱：GLM-5.3-Flash 的"限时折扣"没有公布截止时间，这里按价格页列价计（只会高估）；缓存存储费当前"限时免费"，计 0。
 */
import type { Usage } from "@mountains/protocol";
import { canonicalModel, type Currency, type ProviderId, providerOf } from "./capabilities.ts";
import { normalizeUsage, type RawUsage } from "./usage.ts";

/** 每百万 token 的单价（原币种） */
export interface Rates {
	cacheHit: number;
	cacheMiss: number;
	output: number;
	/** 缓存写入单价；未给出时按未命中价计（Moonshot 说明写入成本原本就含在输入价里） */
	cacheWrite?: number;
}

export interface ModelPricing {
	provider: ProviderId;
	currency: Currency;
	version: string;
	/** 有峰谷价时两者不同；没有时相同 */
	peak: Rates;
	offPeak: Rates;
	/** 是否有峰谷时段 */
	timeOfDay: boolean;
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
	"deepseek-flash": {
		provider: "deepseek",
		currency: "USD",
		version: "deepseek-pricing@2026-09-10T04:00Z",
		peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
		offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
		timeOfDay: true,
	},
	"deepseek-v4-pro": {
		provider: "deepseek",
		currency: "USD",
		version: "deepseek-pricing@2026-09-10T04:00Z",
		peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
		offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
		timeOfDay: true,
	},
	"glm-5.3-flash": {
		provider: "zhipu",
		currency: "CNY",
		version: "bigmodel-pricing@2026-09-25",
		peak: { cacheHit: 0.23, cacheMiss: 0.8, output: 2.8 },
		offPeak: { cacheHit: 0.23, cacheMiss: 0.8, output: 2.8 },
		timeOfDay: false,
	},
	"kimi-k2.7-code": {
		provider: "moonshot",
		currency: "CNY",
		version: "moonshot-pricing@2026-09-25",
		peak: { cacheHit: 1.3, cacheMiss: 6.5, output: 27 },
		offPeak: { cacheHit: 1.3, cacheMiss: 6.5, output: 27 },
		timeOfDay: false,
	},
};

/** 兼容旧代码：DeepSeek 价格版本 */
export const PRICE_VERSION = PRICING["deepseek-flash"]?.version ?? "";

export function pricingFor(model: string): ModelPricing | undefined {
	return PRICING[canonicalModel(model)];
}

/**
 * 中国法定节假日（北京时间日期）。DeepSeek 官方：周末及中国法定节假日全天为空闲时段。
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-10-01 查阅）
 * 只收录已确认的日期；没收录的日子按工作日处理（预算偏保守）。
 * 2026 国庆按惯例 10 月 1–7 日（用户 2026-10-01 确认当日为假期；结束日以国务院通知为准，待核）。
 */
export const CN_PUBLIC_HOLIDAYS = new Set(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);

/** DeepSeek 峰时：周一至周五 UTC 01:00–04:00、06:00–10:00（北京 9–12 点、14–18 点），法定节假日除外。 */
export function isPeak(at: Date): boolean {
	const day = at.getUTCDay();
	if (day === 0 || day === 6) return false;
	const beijingDate = new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
	if (CN_PUBLIC_HOLIDAYS.has(beijingDate)) return false;
	const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
	return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
}

export type PricePeriod = "peak" | "off-peak" | "flat";

export function pricePeriod(at: Date, model = "deepseek-flash"): PricePeriod {
	const p = pricingFor(model);
	if (p && !p.timeOfDay) return "flat";
	return isPeak(at) ? "peak" : "off-peak";
}

export interface CostEstimate {
	/** 金额（原币种） */
	amount: number;
	currency: Currency;
	period: PricePeriod;
	priceVersion: string;
	/** 所有字段都齐时为 false；缺字段时为 true，此时 amount 用保守值补齐。 */
	partial: boolean;
}

/** 按归一化用量计价。缺少命中/未命中拆分时，全部输入按未命中价计（保守高估），并标记 partial。 */
export function costOfUsage(pricing: ModelPricing, u: Usage, promptTokens: number | null, at: Date): CostEstimate {
	const period: PricePeriod = pricing.timeOfDay ? (isPeak(at) ? "peak" : "off-peak") : "flat";
	const r = period === "off-peak" ? pricing.offPeak : pricing.peak;
	let partial = false;
	let input: number;
	if (u.input !== null && u.cacheRead !== null) {
		input = u.input * r.cacheMiss + u.cacheRead * r.cacheHit + (u.cacheWrite ?? 0) * (r.cacheWrite ?? r.cacheMiss);
	} else {
		partial = true;
		input = (promptTokens ?? 0) * Math.max(r.cacheMiss, r.cacheWrite ?? 0);
	}
	if (u.output === null) partial = true;
	const amount = (input + (u.output ?? 0) * r.output) / 1e6;
	return { amount, currency: pricing.currency, period, priceVersion: pricing.version, partial };
}

/** 按原始 usage 计算费用；模型未知或没有 usage 时返回 undefined。 */
export function estimateCost(model: string, raw: RawUsage | null | undefined, at: Date): CostEstimate | undefined {
	const pricing = pricingFor(model);
	const provider = providerOf(model);
	if (!pricing || !provider || !raw) return undefined;
	return costOfUsage(pricing, normalizeUsage(provider, raw), typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : null, at);
}

/** 预算预检用的最坏情况（原币种）：全部输入按峰时未命中（或写入）价，输出按上限。未知模型返回 +∞。 */
export function worstCaseCost(model: string, estInputTokens: number, maxOutputTokens: number): number {
	const pricing = pricingFor(model);
	if (!pricing) return Number.POSITIVE_INFINITY;
	const r = pricing.peak;
	return (estInputTokens * Math.max(r.cacheMiss, r.cacheWrite ?? 0) + maxOutputTokens * r.output) / 1e6;
}

export function currencyOf(model: string): Currency | undefined {
	return pricingFor(model)?.currency;
}
