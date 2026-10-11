import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildEditFeedback, EDIT_FEEDBACK_LIMITS } from "../src/edit-feedback.ts";
import { createEditTool, createReadTool, DEFAULT_READ_LIMITS } from "../src/files.ts";
import { generalTools, normalizeToolOptions } from "../src/index.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, sha256, Workspace } from "../src/workspace.ts";

function setup(t: TestContext, original = Array.from({ length: 120 }, (_, i) => `row_${i + 1}`).join("\n")) {
	const root = mkdtempSync(join(tmpdir(), "edit-feedback-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "a.txt"), original);
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal,
		toolCallId: "feedback-test", approve: async () => "deny", deferReadPublication: true };
	ctx.files.record("a.txt", sha256(original));
	return { root, original, ctx };
}

test("edit feedback is switchable and off unless asked for", () => {
	assert.equal(normalizeToolOptions().editFeedback, false);
	assert.equal(normalizeToolOptions().batchEdit, true);
	assert.equal(normalizeToolOptions({ editFeedback: false, batchEdit: false }).batchEdit, false);
	assert.match(generalTools({ editFeedback: true }).find(tool => tool.name === "file_edit")!.description, /source preview/);
	assert.doesNotMatch(generalTools({ editFeedback: false }).find(tool => tool.name === "file_edit")!.description, /source preview/);
});
test("successful edit publishes the exact written version around changed lines after line insertion", async t => {
	const { root, ctx } = setup(t);
	const result = await createEditTool({ feedback: true, lean: true }).execute({ path: "a.txt", oldText: "row_50\n", newText: "first\nsecond\n" }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	const updated = readFileSync(join(root, "a.txt"), "utf8");
	assert.equal(result.reads?.[0]?.hash, sha256(updated));
	assert.deepEqual(result.reads?.map(read => [read.startLine, read.endLine]), [[38, 63]]);
	assert.match(result.modelContent, /50\tfirst\n51\tsecond\n52\trow_51/);
	assert.match(result.modelContent, /Source snapshot written by this edit/);
	assert.ok(result.modelContent.includes(sha256(updated)));
	assert.equal(ctx.files.isDelivered("a.txt", sha256(updated), 38, 63), false, "deferred read publication belongs to the engine");
});

test("batch source previews use final line positions and merge nearby contexts without duplicate rows", async t => {
	const { root, ctx } = setup(t);
	const result = await createEditTool({ batch: true, feedback: true, lean: true }).execute({ path: "a.txt", edits: [
		{ oldText: "row_20\n", newText: "first\nsecond\nthird\n" },
		{ oldText: "row_100\n", newText: "late\n" },
	] }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.deepEqual(result.reads?.map(read => [read.startLine, read.endLine]), [[8, 34], [90, 114]]);
	assert.match(result.modelContent, /102\tlate/);
	assert.equal(result.reads?.[0]?.hash, sha256(readFileSync(join(root, "a.txt"))));
	const updated = "a\nb\nc\nd\ne\n";
	const nearby = buildEditFeedback({ path: "a", original: updated, updated, spans: [{ start: 0, end: 1, text: "a" }, { start: 4, end: 5, text: "c" }], receipt: "edited a" });
	assert.deepEqual(nearby.reads.map(read => [read.startLine, read.endLine]), [[1, 5]]);
	assert.equal(nearby.modelContent.match(/3\tc/g)?.length, 1);
});

test("byte ceiling includes receipt and hash; oversized source lines are omitted whole", async t => {
	const { root, ctx } = setup(t, "first\nreplace\nlast\n");
	const result = await createEditTool({ feedback: true, lean: true }).execute({ path: "a.txt", oldText: "replace", newText: "界".repeat(4000) }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.ok(Buffer.byteLength(result.modelContent) <= EDIT_FEEDBACK_LIMITS.maxOutputBytes);
	assert.deepEqual(result.reads?.map(read => [read.startLine, read.endLine]), [[1, 1]]);
	assert.doesNotMatch(result.modelContent, /界/);
	assert.match(result.modelContent, /Preview incomplete/);
	const feedback = result.details.feedback as { truncated: boolean; omittedRanges: unknown[]; outputBytes: number };
	assert.equal(feedback.truncated, true);
	assert.equal(feedback.outputBytes, Buffer.byteLength(result.modelContent));
	assert.deepEqual(feedback.omittedRanges, [{ startLine: 2, endLine: 3 }]);
	assert.match(readFileSync(join(root, "a.txt"), "utf8"), /界/);
});

test("empty results and CRLF edits retain correct bytes, hashes and actual line ranges", async t => {
	const { ctx } = setup(t, "one\r\ntwo\r\nthree\r\n");
	const result = await createEditTool({ feedback: true }).execute({ path: "a.txt", oldText: "two\n", newText: "second\nnew\n" }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(result.reads?.[0]?.hash, sha256("one\r\nsecond\r\nnew\r\nthree\r\n"));
	assert.deepEqual(result.reads?.map(read => [read.startLine, read.endLine]), [[1, 4]]);
	assert.match(result.modelContent, /2\tsecond\n3\tnew\n4\tthree/);
	const empty = buildEditFeedback({ path: "a", original: "text", updated: "", spans: [{ start: 0, end: 4, text: "" }], receipt: "edited a" });
	assert.deepEqual(empty.reads, []);
	assert.match(empty.modelContent, /file is empty/);
});

test("denied or failed edits publish neither source snapshots nor new read permissions", async t => {
	const { root, original, ctx } = setup(t);
	for (const [tool, oldText] of [[createEditTool({ feedback: true, approveFileWrites: true }), "row_50"], [createEditTool({ feedback: true }), "not-in-the-file"]] as const) {
		const result = await tool.execute({ path: "a.txt", oldText, newText: "changed" }, ctx);
		assert.equal(result.ok, false);
		assert.equal(result.reads, undefined);
		assert.doesNotMatch(result.modelContent, /Source snapshot written/);
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), original);
	}
});

test("a published edit preview can satisfy the next read while force re-sends the current source", async t => {
	const { ctx } = setup(t);
	const edited = await createEditTool({ feedback: true }).execute({ path: "a.txt", oldText: "row_50\n", newText: "changed\n" }, ctx);
	for (const read of edited.reads ?? []) ctx.files.markDelivered(read.path, read.hash, read.startLine, read.endLine);
	const readTool = createReadTool({ ...DEFAULT_READ_LIMITS, dedupe: true, dedupeRanges: true });
	const known = await readTool.execute({ path: "a.txt", startLine: 45, endLine: 55 }, ctx);
	assert.equal(known.details.deduped, true);
	assert.equal(known.reads, undefined);
	const forced = await readTool.execute({ path: "a.txt", startLine: 45, endLine: 55, force: true }, ctx);
	assert.match(forced.modelContent, /50\tchanged/);
	assert.deepEqual(forced.reads?.map(read => [read.startLine, read.endLine]), [[45, 55]]);
});
