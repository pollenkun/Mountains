import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { addedConfig, describeModel, fixedThinking, keyEnvFor, modelPresets, modelWire, selectableModels, setAddedModels, type AddedModel } from "../src/run-session.ts";

afterEach(() => setAddedModels([]));
const model: AddedModel = { id: "my-relay-model", displayName: "我的模型", baseUrl: "https://relay.example.com/v1", apiKeyEnv: "CUSTOMABCD1234_API_KEY", contextWindow: 64_000, thinking: "off", tiers: [] };

test("typing a catalog id offers that model's context and thinking", () => {
	const [first] = modelPresets("claude-opus-5-5");
	assert.equal(first?.id, "claude-opus-5-5");
	assert.equal(first?.displayName, "Claude Opus 5.5");
	assert.equal(first?.contextWindow, 1_000_000);
	assert.equal(first?.thinking, "tiers");
	assert.deepEqual(first?.tiers.map((tier) => tier.label), ["轻度", "均衡", "高", "超高", "Max"]);
	assert.equal(modelPresets("claude-opus-5-5").length, 1);
});

test("a name is recognized with the settings that come with it", () => {
	const [first] = modelPresets("glm 5.3");
	assert.equal(first?.id, "glm-5.3-flash");
	assert.equal(first?.platform, "zhipu");
	assert.equal(first?.contextWindow, 1_000_000);
	assert.ok(first!.tiers.length > 0);
});

test("a custom address uses the protocol it was given, not the one guessed from the name", () => {
	assert.equal(modelWire("claude-opus-5-5"), "anthropic");
	setAddedModels([{ ...model, id: "claude-opus-5-5", protocol: "openai" }]);
	assert.equal(modelWire("claude-opus-5-5"), "openai");
	setAddedModels([{ ...model, id: "gpt-4.1", protocol: "anthropic" }]);
	assert.equal(modelWire("gpt-4.1"), "anthropic");
	setAddedModels([model]);
	assert.equal(modelWire(model.id), "openai");
	setAddedModels([{ ...model, id: "claude-opus-5-5" }]);
	assert.equal(modelWire("claude-opus-5-5"), "openai");
	setAddedModels([{ ...model, id: "claude-opus-5-5", baseUrl: "https://api.anthropic.com" }]);
	assert.equal(modelWire("claude-opus-5-5"), "anthropic");
});

test("an added model is offered, reached at its own address, and thinks as the user said", () => {
	assert.equal(selectableModels().some((m) => m.id === model.id), false);
	setAddedModels([model]);
	assert.equal(selectableModels().some((m) => m.id === model.id), true);
	assert.deepEqual(addedConfig(model.id), { baseUrl: model.baseUrl, apiKeyEnv: model.apiKeyEnv, contextWindow: 64_000 });
	assert.deepEqual(fixedThinking(model.id), { thinking: { enabled: false, effort: "default" } });
	assert.equal(describeModel(model.id).displayName, "我的模型");
	assert.equal(keyEnvFor(model.id, { model: "deepseek-flash", apiKeyEnv: "DEEPSEEK_API_KEY" } as never), model.apiKeyEnv);
	assert.deepEqual(addedConfig("deepseek-flash"), {});
});
