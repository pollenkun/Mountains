import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ShadowCheckpoints } from "@mountains/checkpoints";
import type { EngineEvent } from "@mountains/protocol";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type RecordedResponse } from "../src/index.ts";

function response(write: boolean): RecordedResponse {
	return {
		ok: true, message: { role: "assistant", content: write ? "" : "Done.", reasoning: "",
			toolCalls: write ? ["first", "second"].map(id => ({ id, name: "file_write", argumentsJson: JSON.stringify({ path: `${id}.txt`, content: `${id}\n` }) })) : [] },
		finishReason: write ? "tool_calls" : "stop", responseModel: "deepseek-flash",
		rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
		httpStatus: 200, error: null, aborted: false,
	};
}

function fixture(t: TestContext, checkpoints = true) {
	const root = mkdtempSync(join(tmpdir(), "mountains-checkpoint-warning-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"), dataDir = join(root, "data");
	mkdirSync(workspace);
	const events: EngineEvent[] = [];
	const agent = new AgentSession({ workspace, dataDir, appDataDir: join(root, "appdata"), checkpoints,
		adapter: new ScriptedModelAdapter([response(true), response(false)]), model: "deepseek-flash",
		thinking: { enabled: false, effort: "default" }, maxTokens: 128,
		budget: new BudgetGuard({ globalLimit: 1, ledgerPath: join(root, "spend.jsonl") }),
		retry: { maxAttempts: 1, baseDelayMs: 0 }, onEvent: event => events.push(event),
	});
	const warnings = () => events.filter(event => event.type === "error").filter(event => event.message.includes("文件撤回保存点"));
	const verifyWrites = () => {
		for (const name of ["first", "second"]) assert.equal(readFileSync(join(workspace, `${name}.txt`), "utf8"), `${name}\n`);
	};
	return { agent, dataDir, events, warnings, verifyWrites };
}

test("missing Git keeps file writes usable without a user-facing checkpoint warning", async t => {
	const f = fixture(t), originalPath = process.env.PATH;
	process.env.PATH = "";
	try {
		const summary = await f.agent.run("Create first.txt and second.txt.");
		assert.equal(summary.status, "completed", summary.reason);
		assert.equal(summary.checkpoint, null);
		assert.deepEqual(summary.filesChanged, ["first.txt", "second.txt"]);
		f.verifyWrites();
		assert.equal(f.warnings().length, 0);
		assert.equal(f.events[0]?.type, "session.started");
		const recorded = readFileSync(join(f.dataDir, "recording.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(recorded.filter(line => line.kind === "engine.event" && line.data.type === "error" && line.data.message.includes("文件撤回保存点")).length, 0);
	} finally {
		if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
	}
});

test("explicitly disabled checkpoints do not warn even when Git is absent", async t => {
	const f = fixture(t, false), originalPath = process.env.PATH;
	process.env.PATH = "";
	try {
		const summary = await f.agent.run("Create the two files without checkpoints.");
		assert.equal(summary.status, "completed", summary.reason);
		assert.equal(summary.checkpoint, null);
		f.verifyWrites();
		assert.equal(f.warnings().length, 0);
	} finally {
		if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
	}
});

for (const failure of ["snapshot", "changedPaths"] as const) test(`a final ${failure} failure keeps completed writes without a user-facing warning`, async t => {
	const f = fixture(t);
	if (failure === "snapshot") {
		const original = ShadowCheckpoints.prototype.snapshot;
		let calls = 0;
		t.mock.method(ShadowCheckpoints.prototype, "snapshot", function (this: ShadowCheckpoints, forced?: string[]) {
			if (++calls === 2) throw new Error("private synthetic snapshot error");
			return original.call(this, forced);
		});
	} else {
		t.mock.method(ShadowCheckpoints.prototype, "changedPaths", () => { throw new Error("private synthetic changedPaths error"); });
	}
	const summary = await f.agent.run("Create the two files before the final checkpoint failure.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(summary.checkpoint, null);
	f.verifyWrites();
	assert.equal(f.warnings().length, 0);
});

test("working checkpoints stay available without a warning in a non-Git workspace", async t => {
	const f = fixture(t);
	const summary = await f.agent.run("Create the two files with checkpoints.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.deepEqual(summary.checkpoint?.changed, [{ status: "A", path: "first.txt" }, { status: "A", path: "second.txt" }]);
	f.verifyWrites();
	assert.equal(f.warnings().length, 0);
});
