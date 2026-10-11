import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

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
