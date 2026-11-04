import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatCompletionsAdapter, REASONING_TIERS, type EffortSetting } from "../src/index.ts";

const model = "my-own-model";

async function sent(thinking: { enabled: boolean; effort: EffortSetting }, namedEffort: boolean): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	const adapter = new ChatCompletionsAdapter({
		baseUrl: "https://relay.example/v1", apiKey: "fake-key", ...(namedEffort ? { namedEffort } : {}),
		fetch: async (_url, init) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response([
				{ id: "fake", model, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
				{ id: "fake", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				{ id: "fake", model, choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } },
			].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	await adapter.complete({ model, system: "sys", tools: [], messages: [{ role: "user", content: "hi" }], thinking, maxTokens: 64 });
	return body;
}

test("the five tiers run from 轻度 to Max", () => {
	assert.deepEqual(REASONING_TIERS.map((tier) => tier.label), ["轻度", "均衡", "高", "超高", "Max"]);
});

test("every tier of a model the user said can think reaches the request", async () => {
	for (const tier of REASONING_TIERS) {
		assert.equal((await sent({ enabled: true, effort: tier.id as EffortSetting }, true)).reasoning_effort, tier.id);
	}
});

test("an unknown model gets no effort unless the user said it can think", async () => {
	assert.equal("reasoning_effort" in await sent({ enabled: true, effort: "high" }, false), false);
	assert.equal("reasoning_effort" in await sent({ enabled: false, effort: "high" }, true), false);
	assert.equal("reasoning_effort" in await sent({ enabled: true, effort: "default" }, true), false);
});
