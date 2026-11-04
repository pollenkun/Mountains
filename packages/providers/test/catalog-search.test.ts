import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestModels } from "../src/catalog.ts";

test("DeepSeek V4.1 Flash is the first hit for the English and Chinese queries", () => {
	for (const query of ["Deepseek4.1 flash", "深度求索 flash"]) {
		const hits = suggestModels(query);
		assert.equal(hits.length, 3, query);
		assert.equal(hits[0]?.id, "deepseek-flash", query);
		assert.equal(hits[0]?.keywordOnly, false);
	}
});

test("the model id as typed outranks the other loose Opus matches", () => {
	const hits = suggestModels("claude-opus-5-5");
	assert.equal(hits[0]?.id, "claude-opus-5-5");
	assert.equal(hits[0]?.keywordOnly, false);
});

test("rejected ids stay out, and Wenxin or Spark are keyword matches only", () => {
	const rejected = suggestModels("grok 4", [
		{ provider: "xai", id: "grok-4", displayName: "Grok 4", contextWindow: 1, maxOutputTokens: 1, inputModalities: ["text"], requiresReasoningPassback: false, canThink: true, priced: false, handwritten: false },
		{ provider: "xai", id: "grok-4.7", displayName: "Grok 4.7", contextWindow: 1, maxOutputTokens: 1, inputModalities: ["text"], requiresReasoningPassback: false, canThink: true, priced: true, handwritten: false },
	]);
	assert.equal(rejected.some(hit => hit.id === "grok-4"), false);
	assert.equal(rejected[0]?.id, "grok-4.7");
	const wenxin = suggestModels("文心");
	assert.equal(wenxin[0]?.id, "ernie-5.1");
	assert.equal(wenxin[0]?.keywordOnly, true);
	assert.equal(suggestModels("讯飞").some(hit => hit.keywordOnly && hit.id === "spark-x2"), true);
});
