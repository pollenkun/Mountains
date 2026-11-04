import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModelIds, modelIdsFrom, modelsEndpoints } from "../src/main/remote-models.ts";

test("a /v1 base lists /models, and any other base tries /v1/models first", () => {
	assert.deepEqual(modelsEndpoints("https://api.openlux.ai/v1/"), ["https://api.openlux.ai/v1/models"]);
	assert.deepEqual(modelsEndpoints("https://api.deepseek.com"), ["https://api.deepseek.com/v1/models", "https://api.deepseek.com/models"]);
});

test("model ids come out of the OpenAI list, once each, in order", () => {
	assert.deepEqual(modelIdsFrom({ data: [{ id: "claude-opus-5-5" }, { id: "claude-opus-5-5" }, { id: "glm-5.3" }, { name: "skip" }, ""] }), ["claude-opus-5-5", "glm-5.3"]);
});

test("a missing /v1/models falls through, and an error message is the one the service sent", async () => {
	const seen: string[] = [];
	const ids = await fetchModelIds("https://relay.example", "secret", async (input) => {
		seen.push(String(input));
		if (String(input).endsWith("/v1/models")) return new Response("no", { status: 404 });
		return new Response(JSON.stringify({ data: [{ id: "a" }] }), { status: 200 });
	});
	assert.deepEqual(ids, ["a"]);
	assert.deepEqual(seen, ["https://relay.example/v1/models", "https://relay.example/models"]);
	await assert.rejects(fetchModelIds("https://relay.example/v1", "", async () => new Response(JSON.stringify({ error: { message: "lab token denied" } }), { status: 401 })), /lab token denied/);
});
