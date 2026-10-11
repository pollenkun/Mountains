import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createCommandTool } from "../src/command.ts";
import { BlobStore, FileStateTracker, Workspace } from "../src/workspace.ts";
import type { ToolContext } from "../src/types.ts";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "command-portability-")));
	const controller = new AbortController();
	t.after(() => { controller.abort(); rmSync(root, { recursive: true, force: true }); });
	const cwd = join(root, "中文 directory 'quoted'"); mkdirSync(cwd);
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(),
		blobs: new BlobStore(join(root, "blobs")), signal: controller.signal,
		toolCallId: t.name, approve: async () => "allow" };
	return { root, cwd, ctx };
}

test("native command execution preserves argument boundaries, Unicode, cwd and literal shell metacharacters", { timeout: 30_000 }, async t => {
	const { cwd, ctx } = fixture(t);
	const values = ["", "two words", "日本語😀", "a\"quote", "trailing \\", "'single'", "$() & | > ;"];
	const script = "require('node:fs').writeFileSync('observed.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}));console.log('native stdout');console.error('native stderr');";
	const result = await createCommandTool().execute({ argv: [process.execPath, "-e", script, ...values], cwd: ctx.workspace.rel(cwd), timeoutMs: 20_000 }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	const observed = JSON.parse(readFileSync(join(cwd, "observed.json"), "utf8")) as { cwd: string; args: string[] };
	assert.equal(ctx.workspace.resolve(observed.cwd).abs, ctx.workspace.resolve(cwd).abs);
	assert.deepEqual(observed.args, values);
	assert.match(result.modelContent, /native stdout/);
	assert.match(result.modelContent, /native stderr/);
	assert.equal(result.details.exitCode, 0);
});

test("native Bash shellScript supports pipelines and redirection in a Unicode/space working directory", { timeout: 30_000 }, async t => {
	const { cwd, ctx } = fixture(t);
	const result = await createCommandTool().execute({
		shellScript: "printf '%s\\n' '中文 shell output' | { IFS= read -r line; printf '%s\\n' \"$line\"; } > 'result file.txt'",
		cwd: ctx.workspace.rel(cwd), timeoutMs: 20_000,
	}, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(readFileSync(join(cwd, "result file.txt"), "utf8"), "中文 shell output\n");
});
