import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createCommandTool, DEFAULT_COMMAND_LIMITS } from "../src/command.ts";
import { createWriteTool } from "../src/files.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace, sha256 } from "../src/workspace.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-post-wait-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"); mkdirSync(workspace);
	const controller = new AbortController();
	const ctx: ToolContext = { workspace: new Workspace(workspace), files: new FileStateTracker(), signal: controller.signal, toolCallId: t.name, approve: async () => "allow" };
	return { root, workspace, controller, ctx };
}

for (const existing of [false, true]) {
	test(`automatic file_write preserves a ${existing ? "changed" : "concurrently created"} file after its checkpoint hook`, async t => {
		const { workspace, ctx } = fixture(t);
		const file = join(workspace, "a.txt");
		if (existing) writeFileSync(file, "original\n");
		ctx.beforeWrite = async () => { writeFileSync(file, "user edit\n"); };
		ctx.approve = async () => { assert.fail("default file_write should not add an approval request"); };
		const result = await createWriteTool().execute({ path: "a.txt", content: "agent edit\n", ...(existing ? { createOnly: false, expectedHash: sha256("original\n") } : {}) }, ctx);
		assert.equal(result.ok, false);
		assert.equal(result.writes, undefined);
		assert.equal(readFileSync(file, "utf8"), "user edit\n");
	});
}

test("automatic file_write respects cancellation during its checkpoint hook", async t => {
	const { workspace, controller, ctx } = fixture(t);
	ctx.beforeWrite = async () => { controller.abort(); };
	const result = await createWriteTool().execute({ path: "new/a.txt", content: "agent edit\n" }, ctx);
	assert.equal(result.ok, false);
	assert.equal(result.details.cancelled, true);
	assert.equal(existsSync(join(workspace, "new")), false);
});

test("automatic file_write rechecks its parent after the checkpoint hook", async t => {
	const { root, workspace, ctx } = fixture(t);
	const directory = join(workspace, "sub"); mkdirSync(directory);
	const outside = join(root, "outside"); mkdirSync(outside);
	writeFileSync(join(outside, "a.txt"), "outside bytes\n");
	ctx.beforeWrite = async () => {
		renameSync(directory, join(workspace, "saved"));
		symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
	};
	const result = await createWriteTool().execute({ path: "sub/a.txt", content: "agent edit\n" }, ctx);
	assert.equal(result.ok, false);
	assert.equal(result.writes, undefined);
	assert.equal(readFileSync(join(outside, "a.txt"), "utf8"), "outside bytes\n");
});

for (const stage of ["approval", "scope probe"] as const) {
	for (const replacement of ["symlink", "directory"] as const) {
		test(`command rejects a cwd replaced with a ${replacement} during ${stage}`, async t => {
			const { root, workspace, ctx } = fixture(t);
			const directory = join(workspace, "sub"); mkdirSync(directory);
			const outside = join(root, "outside"); mkdirSync(outside);
			const replace = () => {
				renameSync(directory, join(workspace, "saved"));
				if (replacement === "directory") mkdirSync(directory);
				else symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
			};
			ctx.approve = async () => { if (stage === "approval") replace(); return "allow"; };
			const tool = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, {
				platform: "linux", probeLinuxScope: async () => { if (stage === "scope probe") replace(); return false; },
			});
			const result = await tool.execute({ cwd: "sub", argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("sentinel.txt", "unexpected process")'], timeoutMs: 5000 }, ctx);
			assert.equal(result.ok, false, result.modelContent);
			assert.equal(result.details.exitCode, undefined, "no process should launch with the changed cwd");
			for (const parent of [directory, outside, join(workspace, "saved")]) assert.equal(existsSync(join(parent, "sentinel.txt")), false);
		});
	}
}
