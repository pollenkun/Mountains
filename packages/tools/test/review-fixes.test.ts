import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEditTool, createReadTool } from "../src/files.ts";
import { generalTools, normalizeToolOptions } from "../src/index.ts";
import { createPlanTool } from "../src/plan.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, MAX_ARCHIVE_BYTES, Workspace } from "../src/workspace.ts";

// Regression checks for the 2026-10-22 code review (B04, B18, P02).
function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mountains-review-tools-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "review",
		approve: async () => "allow" };
	return { root, ctx };
}

test("B04: the general tools cap command output capture by default, and the cap is configurable", async (t) => {
	assert.equal(normalizeToolOptions().captureMaxBytes, MAX_ARCHIVE_BYTES);
	const { ctx } = fixture(t);
	const command = generalTools({ captureMaxBytes: 4096 }).find((tool) => tool.name === "command_run")!;
	const result = await command.execute({ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"] }, ctx);
	assert.equal(result.details.outputLimited, true, result.modelContent);
	assert.equal(result.details.captureMaxBytes, 4096);
	assert.equal(result.details.captureComplete, false, "the result says the capture was cut at the cap");
});

test("B18: query_plan and file_read show the same first line of a file with a BOM", async (t) => {
	const { root, ctx } = fixture(t);
	writeFileSync(join(root, "bom.txt"), "﻿line1\nline2\n");
	const plan = await createPlanTool({ lean: true }).execute({ steps: [{ id: "r1", op: "read", path: "bom.txt", startLine: 1, endLine: 2 }] }, ctx);
	assert.equal(plan.ok, true, plan.modelContent);
	assert.ok(plan.modelContent.includes("﻿line1"), "the plan shows the BOM it recorded as delivered");
	const read = await createReadTool().execute({ path: "bom.txt", startLine: 1, endLine: 1, force: true }, ctx);
	assert.ok(read.modelContent.includes("﻿line1"));
});

test("P02: an edit with too many matches fails with the exact count, without changing the file", async (t) => {
	const { root, ctx } = fixture(t);
	const original = "a".repeat(200_000);
	writeFileSync(join(root, "many.txt"), original);
	assert.equal((await createReadTool().execute({ path: "many.txt" }, ctx)).ok, true);
	const result = await createEditTool().execute({ path: "many.txt", oldText: "a", newText: "b", expectedMatches: 1 }, ctx);
	assert.equal(result.ok, false);
	assert.match(result.modelContent, /200000 次/);
	assert.equal(readFileSync(join(root, "many.txt"), "utf8"), original);
});
