import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileSha256, ShadowCheckpoints } from "@mountains/checkpoints";
import type { EngineEvent } from "@mountains/protocol";
import { sha256 } from "@mountains/tools";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse, type RunSummary } from "../src/index.ts";

type Call = { id: string; name: string; args: Record<string, unknown> };
function reply(calls: Call[] = []): RecordedResponse {
	return {
		ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "", toolCalls: calls.map(({ id, name, args }) => ({ id, name, argumentsJson: JSON.stringify(args) })) },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash",
		rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
		httpStatus: 200, error: null, aborted: false,
	};
}

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-checkpoint-rollback-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"); mkdirSync(workspace);
	execFileSync("git", ["init", "-q"], { cwd: workspace });
	writeFileSync(join(workspace, ".gitignore"), "*.local\n");
	const appDataDir = join(root, "appdata");
	const checkpoints = new ShadowCheckpoints(workspace, appDataDir);
	const events: EngineEvent[] = [];
	function session(responses: RecordedResponse[], extra: Partial<EngineOptions> = {}) {
		return new AgentSession({
			workspace, dataDir: join(root, "session"), appDataDir, adapter: new ScriptedModelAdapter(responses),
			model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 128,
			budget: new BudgetGuard({ globalLimit: 1, ledgerPath: join(root, "spend.jsonl") }),
			retry: { maxAttempts: 1, baseDelayMs: 0 }, onEvent: (event) => events.push(event), ...extra,
		});
	}
	function restore(summary: RunSummary) {
		assert.ok(summary.checkpoint, "the real engine must return a usable rollback checkpoint");
		const paths = summary.checkpoint.changed.map(({ path }) => path);
		const expected = Object.fromEntries(paths.map((path) => [path, fileSha256(join(workspace, path))]));
		const result = checkpoints.restore(summary.checkpoint.tree, paths, expected);
		assert.deepEqual(result.conflicts, []);
		return result;
	}
	return { workspace, checkpoints, events, session, restore };
}

test("the real engine restores an existing ignored file edited after file_read", async (t) => {
	const f = fixture(t);
	const original = Buffer.from("ORIGINAL=1\r\n注释=保留\r\n");
	const path = join(f.workspace, "config.local");
	writeFileSync(path, original);
	if (process.platform !== "win32") chmodSync(path, 0o700);
	assert.ok(!f.checkpoints.listFiles().includes("config.local"));
	const agent = f.session([
		reply([{ id: "read", name: "file_read", args: { path: "config.local" } }]),
		reply([{ id: "edit", name: "file_edit", args: { path: "config.local", oldText: "ORIGINAL=1", newText: "ORIGINAL=2" } }]),
		reply(),
	]);
	const summary = await agent.run("Change ORIGINAL from 1 to 2 in config.local.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.deepEqual(summary.checkpoint?.changed, [{ status: "M", path: "config.local" }]);
	assert.equal(readFileSync(path, "utf8"), "ORIGINAL=2\r\n注释=保留\r\n");
	assert.deepEqual(f.restore(summary), { restored: ["config.local"], deleted: [], conflicts: [] });
	assert.deepEqual(readFileSync(path), original, "rollback must restore the original bytes, not delete the file");
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o700);
});

test("repeated edits and overwrites retain each first preimage while a new ignored file is removed", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "visible.txt"), "visible=1\n");
	writeFileSync(join(f.workspace, "edit.local"), "edit=1\n");
	writeFileSync(join(f.workspace, "write.local"), "write=1\n");
	writeFileSync(join(f.workspace, "read-only.local"), "untouched\n");
	const originalTree = f.checkpoints.snapshot().tree;
	const agent = f.session([
		reply([
			{ id: "read-visible", name: "file_read", args: { path: "visible.txt" } },
			{ id: "read-ignored", name: "file_read", args: { path: "edit.local" } },
			{ id: "read-only", name: "file_read", args: { path: "read-only.local" } },
		]),
		reply([
			{ id: "visible-edit", name: "file_edit", args: { path: "visible.txt", oldText: "visible=1", newText: "visible=2" } },
			{ id: "first-edit", name: "file_edit", args: { path: "edit.local", oldText: "edit=1", newText: "edit=2" } },
			{ id: "first-write", name: "file_write", args: { path: "write.local", content: "write=2\n", createOnly: false, expectedHash: sha256("write=1\n") } },
			{ id: "new-write", name: "file_write", args: { path: "new.local", content: "new=1\n" } },
		]),
		reply([
			{ id: "second-edit", name: "file_edit", args: { path: "./edit.local", oldText: "edit=2", newText: "edit=3" } },
			{ id: "second-write", name: "file_write", args: { path: "write.local", content: "write=3\n", createOnly: false, expectedHash: sha256("write=2\n") } },
			{ id: "new-edit", name: "file_edit", args: { path: "new.local", oldText: "new=1", newText: "new=2" } },
			{ id: "new-overwrite", name: "file_write", args: { path: "./new.local", content: "new=3\n", createOnly: false, expectedHash: sha256("new=2\n") } },
		]),
		reply(),
	], { toolOptions: { approveFileWrites: true }, approval: { rules: [], fallback: "ask" }, askApproval: async () => "allow" });
	const summary = await agent.run("Apply the scripted file edits and writes.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.ok(f.events.filter((event) => event.type === "tool.completed").every((event) => event.type === "tool.completed" && event.ok));
	assert.deepEqual(summary.checkpoint?.changed, [
		{ status: "M", path: "edit.local" }, { status: "A", path: "new.local" },
		{ status: "M", path: "visible.txt" }, { status: "M", path: "write.local" },
	]);
	assert.equal(readFileSync(join(f.workspace, "edit.local"), "utf8"), "edit=3\n");
	assert.equal(readFileSync(join(f.workspace, "write.local"), "utf8"), "write=3\n");
	assert.equal(readFileSync(join(f.workspace, "new.local"), "utf8"), "new=3\n");
	assert.deepEqual(f.restore(summary).deleted, ["new.local"]);
	assert.equal(readFileSync(join(f.workspace, "edit.local"), "utf8"), "edit=1\n");
	assert.equal(readFileSync(join(f.workspace, "write.local"), "utf8"), "write=1\n");
	assert.equal(readFileSync(join(f.workspace, "visible.txt"), "utf8"), "visible=1\n", "later preimages must not replace the original workspace snapshot");
	assert.equal(readFileSync(join(f.workspace, "read-only.local"), "utf8"), "untouched\n");
	assert.equal(existsSync(join(f.workspace, "new.local")), false);
	assert.equal(f.checkpoints.snapshot().tree, originalTree);
});

test("case-insensitive mixed-case ignored-file aliases keep one preimage and a new file stays absent from the baseline", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "config.local"), "ORIGINAL=1\n");
	if (!existsSync(join(f.workspace, "CONFIG.LOCAL"))) { t.skip("filesystem probe shows case-sensitive entries"); return; }
	const agent = f.session([
		reply([{ id: "read", name: "file_read", args: { path: "CONFIG.LOCAL" } }]),
		reply([
			{ id: "edit", name: "file_edit", args: { path: "config.local", oldText: "ORIGINAL=1", newText: "ORIGINAL=2" } },
			{ id: "create", name: "file_write", args: { path: "new.local", content: "new=1\n" } },
		]),
		reply([
			{ id: "overwrite-existing", name: "file_write", args: { path: "CoNfIg.LoCaL", content: "ORIGINAL=3\n", createOnly: false, expectedHash: sha256("ORIGINAL=2\n") } },
			{ id: "overwrite-new", name: "file_write", args: { path: "NEW.LOCAL", content: "new=2\n", createOnly: false, expectedHash: sha256("new=1\n") } },
		]),
		reply([{ id: "edit-new", name: "file_edit", args: { path: "NeW.lOcAl", oldText: "new=2", newText: "new=3" } }]),
		reply(),
	]);
	const summary = await agent.run("Apply repeated edits through mixed-case aliases.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.ok(f.events.filter((event) => event.type === "tool.completed").every((event) => event.type === "tool.completed" && event.ok));
	assert.deepEqual(summary.filesChanged, ["config.local", "new.local"]);
	assert.deepEqual(summary.checkpoint?.changed, [{ status: "M", path: "config.local" }, { status: "A", path: "new.local" }]);
	assert.deepEqual(f.checkpoints.listFiles(["CONFIG.LOCAL", "config.local", "NEW.LOCAL", "new.local"]), [".gitignore", "config.local", "new.local"]);
	assert.ok(summary.checkpoint);
	assert.equal(f.checkpoints.capturePreimage(summary.checkpoint.tree, "CONFIG.LOCAL"), summary.checkpoint.tree, "an alias cannot create a second baseline entry");
	assert.deepEqual(f.restore(summary), { restored: ["config.local"], deleted: ["new.local"], conflicts: [] });
	assert.equal(readFileSync(join(f.workspace, "config.local"), "utf8"), "ORIGINAL=1\n");
	assert.equal(existsSync(join(f.workspace, "new.local")), false);
});

test("distinct case-sensitive ignored files retain independent preimages and new-file absence", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "config.local"), "lower=1\n");
	if (existsSync(join(f.workspace, "CONFIG.LOCAL"))) { t.skip("filesystem probe shows case-insensitive entries"); return; }
	writeFileSync(join(f.workspace, "CONFIG.LOCAL"), "UPPER=1\n");
	writeFileSync(join(f.workspace, ".gitignore"), "*.local\n*.LOCAL\n");
	const agent = f.session([
		reply([
			{ id: "read-lower", name: "file_read", args: { path: "config.local" } },
			{ id: "read-upper", name: "file_read", args: { path: "CONFIG.LOCAL" } },
		]),
		reply([
			{ id: "edit-lower", name: "file_edit", args: { path: "config.local", oldText: "lower=1", newText: "lower=2" } },
			{ id: "edit-upper", name: "file_edit", args: { path: "CONFIG.LOCAL", oldText: "UPPER=1", newText: "UPPER=2" } },
			{ id: "new-lower", name: "file_write", args: { path: "new.local", content: "lower new\n" } },
			{ id: "new-upper", name: "file_write", args: { path: "NEW.LOCAL", content: "UPPER new\n" } },
		]),
		reply(),
	]);
	const summary = await agent.run("Edit both distinct case-sensitive files and create two more.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.deepEqual(summary.checkpoint?.changed, [
		{ status: "M", path: "CONFIG.LOCAL" }, { status: "A", path: "NEW.LOCAL" },
		{ status: "M", path: "config.local" }, { status: "A", path: "new.local" },
	]);
	assert.deepEqual(f.restore(summary).deleted, ["NEW.LOCAL", "new.local"]);
	assert.equal(readFileSync(join(f.workspace, "config.local"), "utf8"), "lower=1\n");
	assert.equal(readFileSync(join(f.workspace, "CONFIG.LOCAL"), "utf8"), "UPPER=1\n");
	assert.equal(existsSync(join(f.workspace, "new.local")), false);
	assert.equal(existsSync(join(f.workspace, "NEW.LOCAL")), false);
});

test("read-only, rejected and invalid writes do not force ignored files into the baseline", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "config.local"), "ORIGINAL=1\n");
	const originalTree = f.checkpoints.snapshot().tree;
	const agent = f.session([
		reply([{ id: "read", name: "file_read", args: { path: "config.local" } }]),
		reply([
			{ id: "denied", name: "file_edit", args: { path: "config.local", oldText: "ORIGINAL=1", newText: "ORIGINAL=2" } },
			{ id: "invalid", name: "file_write", args: { path: "config.local", content: "invalid\n" } },
		]),
		reply(),
	], { toolOptions: { approveFileWrites: true }, approval: { rules: [], fallback: "ask" }, askApproval: async () => "deny" });
	const summary = await agent.run("Try the scripted changes.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.deepEqual(summary.filesChanged, []);
	assert.deepEqual(summary.checkpoint, { tree: originalTree, changed: [] });
	assert.equal(readFileSync(join(f.workspace, "config.local"), "utf8"), "ORIGINAL=1\n");
});

test("a checkpoint preimage failure blocks the write rather than exposing a destructive rollback", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "config.local"), "ORIGINAL=1\n");
	const agent = f.session([
		reply([{ id: "write", name: "file_write", args: { path: "config.local", content: "ORIGINAL=2\n", createOnly: false, expectedHash: sha256("ORIGINAL=1\n") } }]),
		reply(),
	], {
		toolOptions: { approveFileWrites: true }, approval: { rules: [], fallback: "ask" },
		askApproval: async () => {
			rmSync(join(f.checkpoints.gitDir, "objects"), { recursive: true, force: true });
			return "allow";
		},
	});
	const summary = await agent.run("Overwrite config.local.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(f.events.find((event) => event.type === "tool.completed")?.ok, false);
	assert.deepEqual(summary.filesChanged, []);
	assert.equal(readFileSync(join(f.workspace, "config.local"), "utf8"), "ORIGINAL=1\n");
});

test("a directory retargeted during approval is rejected before capturing a preimage outside the workspace", async (t) => {
	const f = fixture(t);
	const directory = join(f.workspace, "sub"); mkdirSync(directory);
	const outside = join(f.workspace, "..", "outside"); mkdirSync(outside);
	writeFileSync(join(directory, "config.local"), "ORIGINAL=1\n");
	writeFileSync(join(outside, "config.local"), "private outside bytes\n");
	const agent = f.session([
		reply([{ id: "write", name: "file_write", args: { path: "sub/config.local", content: "ORIGINAL=2\n", createOnly: false, expectedHash: sha256("ORIGINAL=1\n") } }]),
		reply(),
	], {
		toolOptions: { approveFileWrites: true }, approval: { rules: [], fallback: "ask" },
		askApproval: async () => {
			rmSync(directory, { recursive: true });
			symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
			return "allow";
		},
	});
	const summary = await agent.run("Overwrite sub/config.local.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(f.events.find((event) => event.type === "tool.completed")?.ok, false);
	assert.deepEqual(summary.filesChanged, []);
	assert.equal(readFileSync(join(outside, "config.local"), "utf8"), "private outside bytes\n");
	const outsideHash = execFileSync("git", ["hash-object", "--stdin", "--no-filters"], { input: "private outside bytes\n", encoding: "utf8" }).trim();
	assert.throws(() => execFileSync("git", ["--git-dir", f.checkpoints.gitDir, "cat-file", "-e", outsideHash], { stdio: "pipe" }), "outside bytes must not be archived in the checkpoint");
});
