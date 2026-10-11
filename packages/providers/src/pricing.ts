/**
 * 官方价格表与费用估算。
 * 不指定币种时保留历史价格表；明确选择 CNY 时使用 2026-10-01 官方人民币表。
 * 两张表各按官方直接报价，不做汇率换算，也不重写历史账本。
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
	/** 新快照的官方出处；历史表保留原版本。 */
	checkedAt?: string;
	sources?: readonly string[];
	/** 请求跨时段、调休计费未经实际账单验证，当前人民币预算保守使用峰价。 */
	budgetTimePolicy?: "always-peak";
	holidayCalendar?: "cn-2026-announced";
	holidayCalendarSource?: { url: string; checkedAt: string; verification: "official-search-index" };
	discountPolicy?: "standard-price-unconfirmed-discount-excluded";
	taxNote?: string;
}

/** 新增预设的独立价格，不追溯改写既有三家快照。 */
export const ADDITIONAL_PRICING: Readonly<Record<string, ModelPricing>> = {
	"gpt-4.1-mini": {
		provider: "openai", currency: "USD", version: "openai-gpt41-mini@2026-10-03",
		peak: { cacheHit: 0.10, cacheMiss: 0.40, output: 1.60 },
		offPeak: { cacheHit: 0.10, cacheMiss: 0.40, output: 1.60 }, timeOfDay: false,
		checkedAt: "2026-10-03", sources: ["https://developers.openai.com/api/docs/models/gpt-4.1-mini"],
	},
	"qwen-plus": {
		provider: "qwen", currency: "CNY", version: "qwen-plus-beijing-highest-tier-nonthinking@2026-10-03",
		// 输入长度分档：使用最高档保守上限，不依赖估算 token 数选择便宜档。
		peak: { cacheHit: 0.96, cacheMiss: 4.80, output: 48 },
		offPeak: { cacheHit: 0.96, cacheMiss: 4.80, output: 48 }, timeOfDay: false,
		checkedAt: "2026-10-03", sources: ["https://help.aliyun.com/zh/model-studio/qwen-plus"],
	},
	"Qwen/Qwen2.5-7B-Instruct": {
		provider: "siliconflow", currency: "CNY", version: "siliconflow-cn-qwen25-7b-free@2026-10-03",
		// 官网明确该非 Pro 模型输入、输出免费；不得套用付费 Pro/ 型号。
		peak: { cacheHit: 0, cacheMiss: 0, output: 0 },
		offPeak: { cacheHit: 0, cacheMiss: 0, output: 0 }, timeOfDay: false,
		checkedAt: "2026-10-03", sources: ["https://www.siliconflow.cn/pricing"],
	},
	"openai/gpt-4.1-mini": {
		provider: "openrouter", currency: "USD", version: "openrouter-gpt41-mini-highest-route@2026-10-03",
		// 未固定上游：使用官方公开路由列表中各项最高价，不能套用原厂最低价。
		peak: { cacheHit: 0.11, cacheMiss: 0.44, output: 1.76 },
		offPeak: { cacheHit: 0.11, cacheMiss: 0.44, output: 1.76 }, timeOfDay: false,
		checkedAt: "2026-10-03", sources: ["https://openrouter.ai/api/v1/models/openai/gpt-4.1-mini/endpoints", "https://openrouter.ai/openai/gpt-4.1-mini"],
	},
};

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

/** 显式选择 CNY 的调用共用直接人民币表；不改历史默认值。 */
export const CURRENT_CNY_PRICING: Readonly<Record<string, ModelPricing>> = {
	"deepseek-flash": {
		provider: "deepseek", currency: "CNY", version: "deepseek-cny-pricing@2026-10-01",
		peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
		offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }, timeOfDay: true,
		checkedAt: "2026-10-01", sources: ["https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"],
		budgetTimePolicy: "always-peak", holidayCalendar: "cn-2026-announced",
		holidayCalendarSource: { url: "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm", checkedAt: "2026-10-01", verification: "official-search-index" },
	},
	"deepseek-v4-pro": {
		provider: "deepseek", currency: "CNY", version: "deepseek-cny-pricing@2026-10-01",
		peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
		offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, timeOfDay: true,
		checkedAt: "2026-10-01", sources: ["https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"],
		budgetTimePolicy: "always-peak", holidayCalendar: "cn-2026-announced",
		holidayCalendarSource: { url: "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm", checkedAt: "2026-10-01", verification: "official-search-index" },
	},
	"glm-5.3-flash": {
		provider: "zhipu", currency: "CNY", version: "bigmodel-cny-standard-pricing@2026-10-01",
		peak: { cacheHit: 0.23, cacheMiss: 0.8, output: 2.8 },
		offPeak: { cacheHit: 0.23, cacheMiss: 0.8, output: 2.8 }, timeOfDay: false,
		checkedAt: "2026-10-01", sources: ["https://bigmodel.cn/pricing"],
		discountPolicy: "standard-price-unconfirmed-discount-excluded",
	},
	"kimi-k2.7-code": {
		provider: "moonshot", currency: "CNY", version: "moonshot-cny-pricing@2026-10-01",
		peak: { cacheHit: 1.3, cacheMiss: 6.5, output: 27 },
		offPeak: { cacheHit: 1.3, cacheMiss: 6.5, output: 27 }, timeOfDay: false,
		checkedAt: "2026-10-01", sources: ["https://www.kimi.com/resources/kimi-k2-7-code", "https://platform.kimi.com/docs/pricing/chat"],
		taxNote: "官方表价不含适用税费；金额是 token 费用估值，实际扣费仍须核对账单。",
	},
};

/** 兼容旧代码：DeepSeek 价格版本 */
export const PRICE_VERSION = PRICING["deepseek-flash"]?.version ?? "";

export function pricingFor(model: string, currency?: Currency): ModelPricing | undefined {
	const name = canonicalModel(model);
	const additional = ADDITIONAL_PRICING[name];
	if (additional) return currency === undefined || additional.currency === currency ? additional : undefined;
	if (currency === "CNY") return CURRENT_CNY_PRICING[name];
	const legacy = PRICING[name];
	return currency === undefined || legacy?.currency === currency ? legacy : undefined;
}

/**
 * 中国法定节假日（北京时间日期）。DeepSeek 官方：周末及中国法定节假日全天为空闲时段。
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-10-01 查阅）
 * 国务院 2026 放假安排：https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 * 此处把公布的放假区间用于费用显示估值；DeepSeek 没解释调休与法定假日的区别。
 * 因此新 CNY 表不以这些日期释放峰谷预算差价。未收录的日期按普通周规则处理。
 */
export const CN_2026_ANNOUNCED_HOLIDAYS = new Set([
	"2026-01-01", "2026-01-02", "2026-01-03",
	"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
	"2026-04-04", "2026-04-05", "2026-04-06",
	"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
	"2026-06-19", "2026-06-20", "2026-06-21",
	"2026-09-25", "2026-09-26", "2026-09-27",
	"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
]);

// 不追溯改变旧 USD 运行当时的日历；新日历只由显式 CNY 快照选中。
export const CN_PUBLIC_HOLIDAYS = new Set(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);

/** DeepSeek 峰时：周一至周五 UTC 01:00–04:00、06:00–10:00（北京 9–12 点、14–18 点），法定节假日除外。 */
export function isPeak(at: Date, calendar: "legacy" | "cn-2026-announced" = "legacy"): boolean {
	if (calendar === "cn-2026-announced") {
		const beijing = new Date(at.getTime() + 8 * 3600_000);
		// Unknown time cannot justify the cheaper period for the optional CNY snapshot.
		if (!Number.isFinite(beijing.getTime())) return true;
		const day = beijing.getUTCDay();
		if (day === 0 || day === 6) return false;
		if (CN_2026_ANNOUNCED_HOLIDAYS.has(beijing.toISOString().slice(0, 10))) return false;
		const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
		return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
	}
	// Preserve the legacy public holiday set and date behavior for existing callers.
	const day = at.getUTCDay();
	if (day === 0 || day === 6) return false;
	const beijingDate = new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
	if (CN_PUBLIC_HOLIDAYS.has(beijingDate)) return false;
	const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
	return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
}

export type PricePeriod = "peak" | "off-peak" | "flat";

export function pricePeriod(at: Date, model = "deepseek-flash", currency?: Currency): PricePeriod {
	const p = pricingFor(model, currency);
	if (p && !p.timeOfDay) return "flat";
	return isPeak(at, p?.holidayCalendar) ? "peak" : "off-peak";
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
	const period: PricePeriod = pricing.timeOfDay ? (isPeak(at, pricing.holidayCalendar) ? "peak" : "off-peak") : "flat";
	const r = period === "off-peak" ? pricing.offPeak : pricing.peak;
	let partial = u.partial;
	let input: number;
	if (!u.partial && u.input !== null && u.cacheRead !== null) {
		input = u.input * r.cacheMiss + u.cacheRead * r.cacheHit + (u.cacheWrite ?? 0) * (r.cacheWrite ?? r.cacheMiss);
	} else {
		partial = true;
		input = Math.max(promptTokens ?? 0, (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)) * Math.max(r.cacheMiss, r.cacheWrite ?? 0);
	}
	if (u.output === null) partial = true;
	const amount = (input + (u.output ?? 0) * r.output) / 1e6;
	return { amount, currency: pricing.currency, period, priceVersion: pricing.version, partial };
}

/** 按原始 usage 计算费用；模型未知或没有 usage 时返回 undefined。 */
export function estimateCost(model: string, raw: RawUsage | null | undefined, at: Date, currency?: Currency): CostEstimate | undefined {
	const pricing = pricingFor(model, currency);
	const provider = providerOf(model);
	if (!pricing || !provider || !raw) return undefined;
	return costOfUsage(pricing, normalizeUsage(provider, raw), typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : null, at);
}

/** 预算预检用的最坏情况（原币种）：全部输入按峰时未命中（或写入）价，输出按上限。未知模型返回 +∞。 */
export function worstCaseCost(model: string, estInputTokens: number, maxOutputTokens: number, currency?: Currency): number {
	const pricing = pricingFor(model, currency);
	if (!pricing) return Number.POSITIVE_INFINITY;
	const r = pricing.peak;
	return (estInputTokens * Math.max(r.cacheMiss, r.cacheWrite ?? 0) + maxOutputTokens * r.output) / 1e6;
}

export function currencyOf(model: string, currency?: Currency): Currency | undefined {
	return pricingFor(model, currency)?.currency;
}
