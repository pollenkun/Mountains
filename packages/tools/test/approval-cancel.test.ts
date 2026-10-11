import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createCommandTool } from "../src/command.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";

function setup(t: TestContext, approve: ToolContext["approve"]) {
	const root = mkdtempSync(join(tmpdir(), "mountains-approval-cancel-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ac = new AbortController();
	const ctx: ToolContext = {
		workspace: new Workspace(root), files: new FileStateTracker(),
		signal: ac.signal, toolCallId: t.name, approve,
	};
	const args = {
		argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("sentinel.txt", "child-started\\n")'],
		timeoutMs: process.platform === "win32" ? 15_000 : 5000,
	};
	return { ac, ctx, args, sentinel: join(root, "sentinel.txt"), tool: createCommandTool() };
}

test("command does not start when cancellation happens while approval is pending", async (t) => {
	let entered!: () => void;
	let release!: (value: "allow") => void;
	const approvalEntered = new Promise<void>((resolve) => { entered = resolve; });
	const decision = new Promise<"allow">((resolve) => { release = resolve; });
	const { ac, ctx, args, sentinel, tool } = setup(t, async () => {
		entered();
		return decision;
	});
	const running = tool.execute(args, ctx);
	await approvalEntered;
	assert.equal(existsSync(sentinel), false, "approval must finish before starting the command");
	ac.abort();
	release("allow");
	const result = await running;
	assert.equal(existsSync(sentinel), false, "an approval arriving after cancellation cannot start the command");
	assert.equal(result.ok, false);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.exitCode, undefined);
});

test("already-cancelled command does not request approval or start a process", async (t) => {
	let approvals = 0;
	const { ac, ctx, args, sentinel, tool } = setup(t, async () => { approvals++; return "allow"; });
	ac.abort();
	const result = await tool.execute(args, ctx);
	assert.equal(approvals, 0, "a cancelled command must not spend time or money on approval");
	assert.equal(existsSync(sentinel), false);
	assert.equal(result.ok, false);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.exitCode, undefined);
});

test("ordinary approval still starts the real harmless command", async (t) => {
	let approvals = 0;
	const { ctx, args, sentinel, tool } = setup(t, async () => { approvals++; return "allow"; });
	const result = await tool.execute(args, ctx);
	assert.equal(approvals, 1);
	assert.equal(readFileSync(sentinel, "utf8"), "child-started\n");
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(result.details.exitCode, 0);
	assert.equal(result.details.cancelled, false);
});

test("ordinary denial still prevents the real harmless command from starting", async (t) => {
	let approvals = 0;
	const { ctx, args, sentinel, tool } = setup(t, async () => { approvals++; return "deny"; });
	const result = await tool.execute(args, ctx);
	assert.equal(approvals, 1);
	assert.equal(existsSync(sentinel), false);
	assert.equal(result.ok, false);
	assert.equal(result.details.approved, false);
	assert.equal(result.details.exitCode, undefined);
});
