import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

test("defaults: high thinking, built-in prompt, whole-file reads, batch edits and edit feedback", () => {
	const { config, systemPrompt } = loadConfig(null);
	assert.deepEqual(config.thinking, { enabled: true, effort: "high" });
	assert.equal(systemPrompt, null, "null means the built-in prompt");
	assert.deepEqual(config.tools, { read: { defaultLines: 2000, maxLines: 2000, maxLineChars: 2000, lineNumbers: "all" }, batchEdit: true, editFeedback: true });
	assert.equal(config.contextWindow, undefined, "the model's own window applies");
});

test("unknown settings are rejected instead of ignored", () => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-config-"));
	try {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ masking: { enabled: true } }));
		assert.throws(() => loadConfig(path), /未知配置项：masking/);
		writeFileSync(path, JSON.stringify({ apiKey: "sk-test" }));
		assert.throws(() => loadConfig(path), /apiKey/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an assumed context window passes through and must be at least 32768", () => {
	assert.equal(loadConfig(null, { contextWindow: 131_072 }).config.contextWindow, 131_072);
	assert.throws(() => loadConfig(null, { contextWindow: 1000 }), /32768/);
});

test("a system prompt file is read relative to the config file and changes the config hash", () => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-config-"));
	try {
		writeFileSync(join(dir, "prompt.md"), "Custom prompt.");
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ systemPrompt: { file: "prompt.md" } }));
		const custom = loadConfig(path);
		assert.equal(custom.systemPrompt, "Custom prompt.");
		assert.notEqual(custom.sha256, loadConfig(null).sha256);
		assert.throws(() => loadConfig(null, { systemPrompt: { builtin: "other" } as never }), /systemPrompt/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool switches must be booleans", () => {
	assert.equal(loadConfig(null, { tools: { editFeedback: false } as never }).config.tools.editFeedback, false);
	assert.throws(() => loadConfig(null, { tools: { batchEdit: "yes" } as never }), /batchEdit/);
});


test("explicit ledger configuration is recorded without changing default config or hash", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({ spendLedger: DEFAULT_CONFIG.spendLedger }));
	const implicit = loadConfig(null);
	assert.equal(implicit.spendLedgerExplicit, false);
	for (const explicit of [loadConfig(path), loadConfig(null, { spendLedger: DEFAULT_CONFIG.spendLedger })]) {
		assert.equal(explicit.spendLedgerExplicit, true);
		assert.deepEqual(explicit.config, implicit.config);
		assert.equal(explicit.sha256, implicit.sha256);
	}
});


test("malformed numeric limits and retry settings cannot silently disable protections", () => {
	for (const section of ["limits", "retry"] as const) {
		const keys = section === "limits" ? ["maxTurns", "maxInputTokens", "maxOutputTokens"] : ["maxAttempts"];
		for (const key of keys) for (const value of ["disabled", null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => loadConfig(null, { [section]: { [key]: value } } as never), new RegExp(`${section}\\.${key}`));
		}
	}
	for (const value of ["disabled", null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => loadConfig(null, { maxTokens: value } as never), /maxTokens/);
	for (const [section, key] of [["limits", "maxCost"], ["retry", "baseDelayMs"], ["retry", "maxDelayMs"]]) {
		for (const value of ["disabled", null, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => loadConfig(null, { [section!]: { [key!]: value } } as never), new RegExp(`${section}\\.${key}`));
	}
	assert.equal(loadConfig(null, { limits: { maxCost: 0 } as never }).config.limits.maxCost, 0);
	assert.equal(loadConfig(null, { retry: { baseDelayMs: 0, maxDelayMs: 0 } as never }).config.retry.baseDelayMs, 0);
});

test("skills: on by default with no extra directories; bad settings are rejected", () => {
	assert.deepEqual(loadConfig(null).config.skills, { enabled: true, dirs: [], enable: [], permissions: {} });
	assert.deepEqual(loadConfig(null, { skills: { enabled: true, dirs: ["~/team-skills"], enable: ["computer-use"], permissions: { "deploy-*": "ask" } } }).config.skills.permissions, { "deploy-*": "ask" });
	assert.throws(() => loadConfig(null, { skills: { permissions: { x: "maybe" } } as never }), /allow、ask 或 deny/);
	assert.throws(() => loadConfig(null, { skills: { dirs: [""] } as never }), /skills\.dirs/);
	assert.throws(() => loadConfig(null, { skills: { enabled: "yes" } as never }), /skills\.enabled/);
	assert.throws(() => loadConfig(null, { skills: { extra: true } as never }), /未知配置项：skills\.extra/);
});
