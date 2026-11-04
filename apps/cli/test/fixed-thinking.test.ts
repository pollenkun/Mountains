import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedThinking } from "../src/run-session.ts";

test("a model with no thinking tiers does not inherit the config's tier", () => {
	assert.deepEqual(fixedThinking("kimi-k2.7-code"), { thinking: { enabled: true, effort: "default" } });
	assert.deepEqual(fixedThinking("deepseek-flash"), {});
	assert.deepEqual(fixedThinking(undefined), {});
});
