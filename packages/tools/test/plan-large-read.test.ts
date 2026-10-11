import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlanTool } from "../src/plan.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";

// 2026-10-10 real run: a 100 KB file read through query_plan failed the whole query with nothing shown, three times.
function setup(t: { after(callback: () => void): void }) {
	const parent = mkdtempSync(join(tmpdir(), "mountains-plan-large-read-"));
	const root = join(parent, "workspace"); mkdirSync(root);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "large-read", approve: async () => { throw new Error("read only"); } };
	return { root, ctx };
}
const big = (name: string) => Array.from({ length: 1000 }, (_, i) => `${name} line ${i + 1}: routine inventory record for warehouse ${i % 17}, status checked, no action needed.`).join("\n") + "\n";

test("a read larger than the query output returns the lines that fit with an exact continuation", async t => {
	const { root, ctx } = setup(t);
	writeFileSync(join(root, "a.txt"), big("A")); writeFileSync(join(root, "b.txt"), big("B"));
	const result = await createPlanTool({}).execute({ steps: [
		{ id: "a", op: "read", path: "a.txt" }, { id: "b", op: "read", path: "b.txt" },
	] }, ctx);
	assert.equal(result.details.partial, true, "one step could not run, so the query is partial, not lost");
	assert.ok(Buffer.byteLength(result.modelContent) <= 64 * 1024 + 4096);
	const header = /\[a\] a\.txt \| lines 1-(\d+) of 1000 .*continue with startLine=(\d+)/.exec(result.modelContent);
	assert.ok(header, result.modelContent.slice(0, 300));
	const cut = Number(header[1]);
	assert.ok(cut > 100 && cut < 1000); assert.equal(Number(header[2]), cut + 1);
	assert.match(result.modelContent, new RegExp(`\\n${cut}\\tA line ${cut}:`));
	assert.doesNotMatch(result.modelContent, new RegExp(`\\n${cut + 1}\\tA line ${cut + 1}:`));
	assert.match(result.modelContent, /\[b\] FAILED: Query output limit reached before b\.txt; read it in a separate call/);
	assert.deepEqual(result.reads?.map(r => [r.path, r.startLine, r.endLine]), [["a.txt", 1, cut]], "only the lines shown count as delivered");
});

test("the continuation reads the rest of the file", async t => {
	const { root, ctx } = setup(t);
	writeFileSync(join(root, "a.txt"), big("A"));
	const tool = createPlanTool({});
	const first = await tool.execute({ steps: [{ id: "a", op: "read", path: "a.txt" }] }, ctx);
	const next = Number(/continue with startLine=(\d+)/.exec(first.modelContent)![1]);
	const second = await tool.execute({ steps: [{ id: "a2", op: "read", path: "a.txt", startLine: next }] }, ctx);
	assert.equal(second.ok, true, second.modelContent);
	assert.match(second.modelContent, new RegExp(`\\[a2\\] a\\.txt \\| lines ${next}-`));
});

