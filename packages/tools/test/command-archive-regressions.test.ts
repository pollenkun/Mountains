import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { classifyRisk, createCommandTool, DEFAULT_COMMAND_LIMITS } from "../src/command.ts";
import { SessionArchiveIndex } from "../src/session-index.ts";
import type { ToolContext } from "../src/types.ts";
import { BlobStore, FileStateTracker, Workspace } from "../src/workspace.ts";
import { AgentSession } from "../../engine/src/driver.ts";
import { BudgetGuard } from "../../engine/src/policy.ts";
import { ScriptedModelAdapter, type RecordedResponse } from "../../engine/src/replay.ts";

function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "command-archive-regression-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const work = join(root, "work"); mkdirSync(work);
	const blobs = new BlobStore(join(root, "blobs"), { workspaceRoot: work, sessionId: t.name });
	const ctx: ToolContext = { workspace: new Workspace(work), blobs, files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "fixture", approve: async () => "allow" };
	return { root, work, blobs, ctx };
}

test("read-only risk is argv-aware and unknown options and shell syntax stay conservative", () => {
	for (const input of ["find . -delete", "find . -exec touch marker +", "find -- . -delete", "git branch -D feature", "git diff --output=marker", "git diff", "rg needle", "rg -- --no-config", "rg -e --no-config needle", "rg --no-config --pre=touch needle", "rg --no-config -z needle", "file -C -m magic", "file --preserve-date sample", "tree -o marker", "echo $(touch marker)", "echo `touch marker`", "echo ok\ntouch marker", "echo ${value:=x}", "ls >/tmp/marker", "ls; touch marker", "ls && touch marker", "ls $(echo x)", "./ls", "__proto__"]) {
		assert.notEqual(classifyRisk(input), "read-only", input);
	}
	for (const input of ["ls -la", "cat -- -strange.txt", "head -n 5 file", "tail --lines=5 file", "grep -n needle file", "rg --no-config --fixed-strings needle file", "find . -type f -name sample -print", "pwd -P", "echo literal"]) assert.equal(classifyRisk(input), "read-only", input);
	assert.equal(classifyRisk(["echo", "$(touch marker)", ";", "literal\ntext"]), "read-only", "literal argv does not undergo shell expansion");
	assert.equal(classifyRisk(["find", ".", "-name", "-delete"]), "read-only", "a value is not an option");
	for (const program of ["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "file", "tree", "diff"]) {
		assert.notEqual(classifyRisk([program, "--unrecognized-option"]), "read-only", program);
		assert.notEqual(classifyRisk([program, "--output", "marker"]), "read-only", program);
	}
	assert.equal(classifyRisk("pip install requests"), "network");
	assert.equal(classifyRisk("sudo rm -rf /"), "dangerous");
});

test("a read-only-only approval denies mutating find before executing it", async t => {
	const { work, ctx } = setup(t);
	writeFileSync(join(work, "victim.txt"), "disposable fixture");
	ctx.approve = async request => request.risk === "read-only" ? "allow" : "deny";
	const result = await createCommandTool().execute({ argv: ["find", "victim.txt", "-delete"] }, ctx);
	assert.equal(result.ok, false);
	assert.equal(result.details.approved, false);
	assert.equal(existsSync(join(work, "victim.txt")), true);
});

test("command head/tail shaping retains valid Unicode at every small boundary", async t => {
	const { blobs, ctx } = setup(t);
	const text = "a😀中𐐀b\n".repeat(4);
	const index = new SessionArchiveIndex(blobs);
	for (const maxChars of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
		const tool = createCommandTool({ ...DEFAULT_COMMAND_LIMITS, maxChars, headLines: 1, tailLines: 1 });
		const result = await tool.execute({ argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)})`] }, ctx);
		assert.equal(result.ok, true, result.modelContent);
		assert.equal(Buffer.from(result.modelContent).toString(), result.modelContent, `boundary ${maxChars}`);
		assert.doesNotThrow(() => index.record(result.modelContent, { role: "tool", toolCallId: `shape-${maxChars}`, name: "command_run" }));
		assert.equal(blobs.get(result.fullOutputRef!), text, "raw archive is never clipped");
	}
});

test("default emoji truncation proceeds to the next real AgentSession model response", async t => {
	const { root, work } = setup(t);
	const argv = [process.execPath, "-e", "process.stdout.write('x'.repeat(5999)+String.fromCodePoint(0x1f600)+'y'.repeat(6500))"];
	const reply = (calls: RecordedResponse["message"]["toolCalls"]): RecordedResponse => ({ ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "", toolCalls: calls }, finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 }, httpStatus: 200, error: null, aborted: false });
	const adapter = new ScriptedModelAdapter([reply([{ id: "unicode", name: "command_run", argumentsJson: JSON.stringify({ argv }) }]), reply([])]);
	const session = new AgentSession({ workspace: work, dataDir: join(root, "data"), adapter, model: "deepseek-flash", thinking: { enabled: true, effort: "high" }, maxTokens: 64, checkpoints: false, budget: new BudgetGuard({ globalLimit: 1, currency: "USD", ledgerPath: join(root, "ledger.jsonl") }), limits: { maxTurns: 2, maxRequests: 2, maxCost: 1 }, retry: { maxAttempts: 1, baseDelayMs: 0 } });
	const summary = await session.run("Run the harmless Unicode output fixture.");
	assert.equal(summary.status, "completed", summary.reason);
	assert.equal(adapter.requests.length, 2);
	assert.equal(adapter.remaining, 0);
});

test("command archive exit codes preserve the whole uint32 range and reject invalid values", t => {
	const { blobs } = setup(t);
	for (const code of [0, 7, 0x7fffffff, 0x80000000, 0xc0000005, 0xffffffff]) {
		const ref = blobs.put(`exit ${code}`, { kind: "raw", source: { tool: "command_run", toolCallId: "exit", exitCode: code } });
		assert.equal(blobs.inspectCommand(ref, "exit", { maxArchiveBytes: 1024 })?.commandState.exitCode, code);
	}
	for (const code of [-1073741819, -1, 0.5, 0x100000000, Number.MAX_SAFE_INTEGER, "0", true, {}]) {
		const ref = blobs.put(`invalid ${JSON.stringify(code)}`, { kind: "raw", source: { tool: "command_run", toolCallId: "exit", exitCode: code } });
		assert.equal(blobs.inspectCommand(ref, "exit", { maxArchiveBytes: 1024 }), null);
	}
});

test("pending direct command approval settles on abort, cleans listeners, and ignores late decisions", async t => {
	for (const late of ["allow", "reject"] as const) {
		const { work, ctx } = setup(t);
		const controller = new AbortController(); ctx.signal = controller.signal;
		let resolve!: (decision: "allow") => void;
		let reject!: (error: Error) => void;
		let entered!: () => void;
		const began = new Promise<void>(done => { entered = done; });
		ctx.approve = async () => { entered(); return new Promise<"allow">((yes, no) => { resolve = yes; reject = no; }); };
		const running = createCommandTool().execute({ argv: [process.execPath, "-e", "require('node:fs').writeFileSync('sentinel','started')"] }, ctx);
		await began; controller.abort();
		let timeout: NodeJS.Timeout | undefined;
		const result = await Promise.race([running, new Promise<never>((_, fail) => { timeout = setTimeout(() => fail(new Error("approval cancellation stayed pending")), 500); })]).finally(() => clearTimeout(timeout));
		assert.equal(result.ok, false);
		assert.equal(result.details.cancelled, true);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		if (late === "allow") resolve("allow"); else reject(new Error("late rejection"));
		await new Promise<void>(done => setImmediate(done));
		assert.equal(existsSync(join(work, "sentinel")), false);
	}
});
