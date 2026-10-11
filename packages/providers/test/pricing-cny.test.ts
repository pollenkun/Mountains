import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CN_PUBLIC_HOLIDAYS, CURRENT_CNY_PRICING, PRICE_VERSION, PRICING,
	currencyOf, estimateCost, isPeak, pricePeriod, pricingFor, worstCaseCost,
} from "../src/pricing.ts";

const peak = new Date("2026-09-30T02:00:00Z");
const offPeak = new Date("2026-09-30T05:00:00Z");
const completeDeepSeek = { prompt_tokens: 2e6, prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 };
const close = (actual: number | undefined, expected: number) => {
	assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
};

test("不传币种保留四个模型的原始价格、版本与币种", () => {
	assert.deepEqual(PRICING, {
		"deepseek-flash": {
			provider: "deepseek", currency: "USD", version: "deepseek-pricing@2026-09-10T04:00Z",
			peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
			offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }, timeOfDay: true,
		},
		"deepseek-v4-pro": {
			provider: "deepseek", currency: "USD", version: "deepseek-pricing@2026-09-10T04:00Z",
			peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
			offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }, timeOfDay: true,
		},
		"glm-5.3-flash": {
			provider: "zhipu", currency: "CNY", version: "bigmodel-pricing@2026-09-25",
			peak: { cacheHit: 0.23, cacheMiss: 0.8, output: 2.8 },
			offPeak: { cacheHit: 0.23, cacheMiss: 0.8, output: 2.8 }, timeOfDay: false,
		},
		"kimi-k2.7-code": {
			provider: "moonshot", currency: "CNY", version: "moonshot-pricing@2026-09-25",
			peak: { cacheHit: 1.3, cacheMiss: 6.5, output: 27 },
			offPeak: { cacheHit: 1.3, cacheMiss: 6.5, output: 27 }, timeOfDay: false,
		},
	});
	assert.equal(PRICE_VERSION, "deepseek-pricing@2026-09-10T04:00Z");
	for (const [model, pricing] of Object.entries(PRICING)) {
		assert.equal(pricingFor(model), pricing);
		assert.equal(currencyOf(model), pricing.currency);
	}
	close(estimateCost("deepseek-flash", completeDeepSeek, peak)?.amount, 1.506);
	close(estimateCost("deepseek-flash", completeDeepSeek, offPeak)?.amount, 0.753);
	close(estimateCost("deepseek-v4-pro", completeDeepSeek, peak)?.amount, 5.324);
	close(worstCaseCost("deepseek-flash", 1e6, 1e6), 1.5);
	close(worstCaseCost("deepseek-v4-pro", 1e6, 1e6), 5.28);
});

test("显式人民币读取直接人民币表，不把美元金额改标签", () => {
	for (const [model, pricing] of Object.entries(CURRENT_CNY_PRICING)) {
		assert.equal(pricingFor(model, "CNY"), pricing);
		assert.equal(currencyOf(model, "CNY"), "CNY");
		assert.equal(pricing.checkedAt, "2026-10-01");
		assert.ok(pricing.sources?.every(source => source.startsWith("https://")));
	}
	const flashPeak = estimateCost("deepseek-flash", completeDeepSeek, peak, "CNY");
	const flashOffPeak = estimateCost("deepseek-flash", completeDeepSeek, offPeak, "CNY");
	close(flashPeak?.amount, 10.04);
	close(flashOffPeak?.amount, 5.02);
	assert.equal(flashPeak?.currency, "CNY");
	assert.equal(flashPeak?.priceVersion, "deepseek-cny-pricing@2026-10-01");
	assert.equal(flashPeak?.partial, false);
	close(estimateCost("deepseek-v4-pro", completeDeepSeek, peak, "CNY")?.amount, 36.3);
	close(estimateCost("deepseek-v4-pro", completeDeepSeek, offPeak, "CNY")?.amount, 18.15);
	assert.deepEqual(estimateCost("deepseek-v4-flash", completeDeepSeek, peak, "CNY"), flashPeak);
});

test("人民币峰谷在北京时间边界切换；周末与公告放假日期只影响新快照", () => {
	for (const [time, expected] of [
		["00:59:59", "off-peak"], ["01:00:00", "peak"], ["03:59:59", "peak"], ["04:00:00", "off-peak"],
		["05:59:59", "off-peak"], ["06:00:00", "peak"], ["09:59:59", "peak"], ["10:00:00", "off-peak"],
	] as const) {
		assert.equal(pricePeriod(new Date(`2026-09-30T${time}Z`), "deepseek-flash", "CNY"), expected);
	}
	assert.equal(pricePeriod(new Date("2026-10-10T02:00:00Z"), "deepseek-flash", "CNY"), "off-peak", "周末不推定调休计费");
	for (const date of ["2026-01-02", "2026-02-16", "2026-05-04", "2026-09-25"]) {
		const at = new Date(`${date}T02:00:00Z`);
		assert.equal(pricePeriod(at, "deepseek-flash", "CNY"), "off-peak");
		assert.equal(pricePeriod(at), "peak", "不扩充历史美元日期表");
	}
	assert.deepEqual([...CN_PUBLIC_HOLIDAYS], ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
	assert.equal(isPeak(new Date("2026-10-01T02:00:00Z")), false);
	assert.equal(pricePeriod(new Date("2026-10-01T02:00:00Z"), "deepseek-flash", "CNY"), "off-peak");
});

test("人民币预算始终预留峰价，不能因谷时或假期释放差价", () => {
	close(worstCaseCost("deepseek-flash", 1e6, 1e6, "CNY"), 10);
	close(worstCaseCost("deepseek-v4-pro", 1e6, 1e6, "CNY"), 36);
	const usage = { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 };
	close(estimateCost("deepseek-flash", usage, offPeak, "CNY")?.amount, 5);
	close(estimateCost("deepseek-flash", usage, new Date("2026-10-01T02:00:00Z"), "CNY")?.amount, 5);
	assert.equal(pricingFor("deepseek-flash", "CNY")?.budgetTimePolicy, "always-peak");
	assert.equal(pricingFor("deepseek-v4-pro", "CNY")?.budgetTimePolicy, "always-peak");
});

test("GLM标准列价不减未证实折扣；Kimi含缓存写入而不添加虚构税费", () => {
	const glmUsage = { prompt_tokens: 2e6, completion_tokens: 1e6, prompt_tokens_details: { cached_tokens: 1e6 } };
	const glm = estimateCost("glm-5.3-flash", glmUsage, peak, "CNY");
	close(glm?.amount, 3.83);
	assert.equal(glm?.period, "flat");
	assert.equal(glm?.priceVersion, "bigmodel-cny-standard-pricing@2026-10-01");
	assert.equal(pricingFor("glm-5.3-flash", "CNY")?.discountPolicy, "standard-price-unconfirmed-discount-excluded");
	close(estimateCost("glm-5.3-flash", glmUsage, peak)?.amount, 3.83);
	assert.equal(estimateCost("glm-5.3-flash", glmUsage, peak)?.priceVersion, "bigmodel-pricing@2026-09-25");
	const kimiUsage = { prompt_tokens: 3e6, completion_tokens: 1e6, prompt_tokens_details: { cached_tokens: 1e6, cache_write_tokens: 1e6 } };
	const kimi = estimateCost("kimi-k2.7-code", kimiUsage, peak, "CNY");
	close(kimi?.amount, 41.3);
	assert.equal(kimi?.period, "flat");
	assert.equal(kimi?.partial, false);
	assert.equal(kimi?.priceVersion, "moonshot-cny-pricing@2026-10-01");
	assert.match(pricingFor("kimi-k2.7-code", "CNY")?.taxNote ?? "", /不含.*税费/);
	close(estimateCost("kimi-k2.7-code", kimiUsage, peak)?.amount, 41.3);
	assert.equal(estimateCost("kimi-k2.7-code", kimiUsage, peak)?.priceVersion, "moonshot-pricing@2026-09-25");
});

test("没有对应币种的价格不换汇；费用未知，预留为无穷大", () => {
	for (const [model, currency] of [["unknown-model", "CNY"], ["glm-5.3-flash", "USD"], ["kimi-k2.7-code", "USD"]] as const) {
		assert.equal(pricingFor(model, currency), undefined);
		assert.equal(currencyOf(model, currency), undefined);
		assert.equal(estimateCost(model, completeDeepSeek, peak, currency), undefined);
		assert.equal(worstCaseCost(model, 1, 1, currency), Number.POSITIVE_INFINITY);
	}
	assert.equal(pricingFor("deepseek-flash", "USD"), PRICING["deepseek-flash"]);
	assert.deepEqual(estimateCost("deepseek-flash", completeDeepSeek, peak, "USD"), estimateCost("deepseek-flash", completeDeepSeek, peak));
});

test("缺少raw用量返回未知；字段不完整只能返回带partial标记的估算", () => {
	assert.equal(estimateCost("deepseek-flash", null, peak, "CNY"), undefined);
	assert.equal(estimateCost("deepseek-flash", undefined, peak, "CNY"), undefined);
	const noCacheSplit = estimateCost("deepseek-flash", { prompt_tokens: 1e6, completion_tokens: 1e6 }, peak, "CNY");
	close(noCacheSplit?.amount, 10);
	assert.equal(noCacheSplit?.partial, true);
	const noOutput = estimateCost("deepseek-flash", { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1e6 }, peak, "CNY");
	close(noOutput?.amount, 2);
	assert.equal(noOutput?.partial, true, "缺少输出不能宣称完整费用");
	assert.equal(estimateCost("deepseek-flash", {}, peak, "CNY")?.partial, true, "空对象不是零费用证据");
});

test("无效日期仅在显式人民币快照保守按峰时估算；旧默认仍保持原异常", () => {
	const invalid = new Date(Number.NaN);
	assert.throws(() => isPeak(invalid), RangeError);
	assert.throws(() => pricePeriod(invalid), RangeError);
	assert.equal(pricePeriod(invalid, "deepseek-flash", "CNY"), "peak");
	close(estimateCost("deepseek-flash", completeDeepSeek, invalid, "CNY")?.amount, 10.04);
});
