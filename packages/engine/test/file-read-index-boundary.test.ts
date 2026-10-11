import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type RecordedResponse } from "../src/index.ts";
import type { ToolCall } from "@mountains/protocol";

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 };
function reply(toolCalls: ToolCall[]): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: toolCalls.length ? "" : "Finished", reasoning: "", toolCalls },
		finishReason: toolCalls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage: usage, httpStatus: 200, error: null, aborted: false };
}

for (const [name, source] of [
	["Unicode clipping", "a".repeat(1999) + "😀\n"],
	["UTF-8 byte ceiling", ("界".repeat(2000) + "\n").repeat(2000)],
] as const) test(`file_read ${name} does not terminate a fresh session at archive publication`, async t => {
	const parent = mkdtempSync(join(tmpdir(), "mountains-engine-read-boundary-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "workspace"), data = join(parent, "data"); mkdirSync(root); mkdirSync(data);
	writeFileSync(join(root, "source.txt"), source);
	const adapter = new ScriptedModelAdapter([reply([{ id: "read", name: "file_read", argumentsJson: '{"path":"source.txt"}' }]), reply([])]);
	const session = new AgentSession({ workspace: root, dataDir: data, adapter, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 1000,
		budget: new BudgetGuard({ globalLimit: 5, ledgerPath: join(data, "spend.jsonl") }) });
	const result = await session.run("Read source.txt and summarize it.");
	assert.equal(result.status, "completed", JSON.stringify(result)); assert.equal(adapter.requests.length, 2);
});
