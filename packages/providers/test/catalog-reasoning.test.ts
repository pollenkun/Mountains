import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCatalog, reasoningProfile } from "../src/catalog.ts";

const entry = (id: string) => {
	const found = loadCatalog().find(item => item.id === id);
	assert.ok(found, id);
	return found;
};

test("DeepSeek V4.1 Flash keeps low, high and max", () => {
	const profile = reasoningProfile(entry("deepseek-flash"));
	assert.deepEqual(profile.tiers.map(tier => tier.label), ["轻度", "高", "Max"]);
	assert.equal(profile.ultraCode, true);
});

test("Kimi K3 and K3.1 Pro use the same three efforts; K2.6 is only a switch; K2.7 Code always thinks", () => {
	assert.deepEqual(reasoningProfile(entry("kimi-k3")).tiers.map(tier => tier.id), ["low", "high", "max"]);
	assert.deepEqual(reasoningProfile(entry("kimi-k3.1-pro")).tiers.map(tier => tier.id), ["low", "high", "max"]);
	assert.equal(reasoningProfile(entry("kimi-k2.6")).mode, "toggle");
	assert.deepEqual(reasoningProfile(entry("kimi-k2.6")).tiers.map(tier => tier.label), ["关闭", "开启"]);
	const code = reasoningProfile(entry("kimi-k2.7-code"));
	assert.equal(code.mode, "always");
	assert.deepEqual(code.tiers, []);
	assert.equal(code.ultraCode, true);
});

test("Anthropic budget_tokens becomes five named tiers", () => {
	const profile = reasoningProfile(entry("claude-sonnet-5-5"));
	assert.equal(profile.mode, "budget");
	assert.deepEqual(profile.tiers.map(tier => tier.label), ["轻度", "均衡", "高", "超高", "Max"]);
});

test("a model that cannot think is not offered UltraCode", () => {
	const profile = reasoningProfile(entry("grok-4.20-0309-non-reasoning"));
	assert.equal(profile.canThink, false);
	assert.equal(profile.ultraCode, false);
	assert.deepEqual(profile.tiers, []);
});
