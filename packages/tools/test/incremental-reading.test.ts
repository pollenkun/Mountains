import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createReadTool, DEFAULT_READ_LIMITS } from "../src/files.ts";
import { generalTools, normalizeToolOptions } from "../src/index.ts";
import { createPlanTool, validateQueryPlan } from "../src/plan.ts";
import type { ReadRecord, ToolContext, ToolResult } from "../src/types.ts";
import { BlobStore, FileStateTracker, Workspace } from "../src/workspace.ts";

function setup(t: TestContext, text?: string) {
	const root = mkdtempSync(join(tmpdir(), "incremental-read-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), blobs: new BlobStore(join(root, ".archive")),
		signal: new AbortController().signal, toolCallId: "incremental-test", approve: async () => "deny" };
	writeFileSync(join(root, "a.txt"), text ?? Array.from({ length: 200 }, (_, i) => `source_${i + 1} = "${"text".repeat(8)}";`).join("\n"));
	return { root, ctx };
}

function ranges(reads: ReadRecord[] | undefined) { return (reads ?? []).map(read => [read.startLine, read.endLine]); }
function publish(result: ToolResult, ctx: ToolContext) {
	for (const read of result.reads ?? []) ctx.files.markDelivered(read.path, read.hash, read.startLine, read.endLine);
}
const readLimits = { ...DEFAULT_READ_LIMITS, dedupe: true, dedupeRanges: true };

test("the tool set is fixed: six tools, read deduplication always on", () => {
	assert.deepEqual(generalTools().map(tool => tool.name), ["query_plan", "file_read", "file_edit", "file_write", "command_run", "context_expand"]);
	assert.ok((generalTools()[1]!.parameters.properties as Record<string, unknown>).force);
	const normalized = normalizeToolOptions({ read: { maxLines: 120 }, batchEdit: true });
	assert.deepEqual(normalizeToolOptions(normalized), normalized);
	assert.equal(normalized.read?.dedupeRanges, true);
	assert.equal(normalized.read?.maxLines, 120);
	assert.equal(normalized.batchEdit, true);
	assert.throws(() => createReadTool({ ...DEFAULT_READ_LIMITS, dedupeRanges: true }), /requires dedupe/);
	assert.doesNotMatch(JSON.stringify(generalTools().map(tool => ({ description: tool.description, parameters: tool.parameters }))), /content_search|file_glob|last file_read header/);
});
test("directory recovery points to a provided query tool", async t => {
	const { ctx } = setup(t);
	const read = generalTools().find(tool => tool.name === "file_read")!;
	const result = await read.execute({ path: "." }, ctx);
	assert.equal(result.ok, false);
	assert.match(result.modelContent, /query_plan/);
	assert.doesNotMatch(result.modelContent, /file_glob/);
});

test("same-version partial reads publish only unseen ranges and force restores every requested line", async t => {
	const { ctx } = setup(t);
	const tool = createReadTool(readLimits, { lean: true });
	await tool.execute({ path: "a.txt", startLine: 20, endLine: 120 }, ctx);
	const partial = await tool.execute({ path: "a.txt", startLine: 1, endLine: 160 }, ctx);
	assert.equal(partial.ok, true, partial.modelContent);
	assert.equal(partial.details.partialDedupe, true);
	assert.deepEqual(ranges(partial.reads), [[1, 19], [121, 160]]);
	assert.equal(partial.details.startLine, undefined);
	assert.equal(partial.details.endLine, undefined);
	assert.equal(partial.details.requestedStartLine, 1);
	assert.equal(partial.details.requestedEndLine, 160);
	assert.match(partial.modelContent, /unchanged lines already shown are omitted/);
	assert.match(partial.modelContent, /1\tsource_1 =/);
	assert.match(partial.modelContent, /121\tsource_121 =/);
	assert.doesNotMatch(partial.modelContent, /20\tsource_20 =/);
	const forced = await tool.execute({ path: "a.txt", startLine: 1, endLine: 160, force: true }, ctx);
	assert.deepEqual(ranges(forced.reads), [[1, 160]]);
	assert.match(forced.modelContent, /20\tsource_20 =/);
	assert.ok(Buffer.byteLength(partial.modelContent) < Buffer.byteLength(forced.modelContent));
});

test("any external byte change invalidates the old version even when earlier line positions remain", async t => {
	const { root, ctx } = setup(t);
	const tool = createReadTool(readLimits);
	const initial = await tool.execute({ path: "a.txt", startLine: 1, endLine: 100 }, ctx);
	writeFileSync(join(root, "a.txt"), Array.from({ length: 200 }, (_, i) => `changed_${i + 1} = 1;`).join("\n"));
	const changed = await tool.execute({ path: "a.txt", startLine: 1, endLine: 100 }, ctx);
	assert.notEqual(changed.details.hash, initial.details.hash);
	assert.equal(changed.details.deduped, undefined);
	assert.deepEqual(ranges(changed.reads), [[1, 100]]);
	assert.match(changed.modelContent, /changed_1 = 1/);
});

test("deferred publication never treats an unreturned read as context", async t => {
	const { ctx } = setup(t); ctx.deferReadPublication = true;
	const tool = createReadTool(readLimits);
	const first = await tool.execute({ path: "a.txt", startLine: 1, endLine: 100 }, ctx);
	const beforePublication = await tool.execute({ path: "a.txt", startLine: 1, endLine: 100 }, ctx);
	assert.equal(beforePublication.details.deduped, undefined);
	assert.deepEqual(ranges(beforePublication.reads), [[1, 100]]);
	publish(first, ctx);
	const afterPublication = await tool.execute({ path: "a.txt", startLine: 1, endLine: 100 }, ctx);
	assert.equal(afterPublication.details.deduped, true);
	assert.deepEqual(ranges(afterPublication.reads), []);
	ctx.files.forgetDelivered();
	assert.deepEqual(ranges((await tool.execute({ path: "a.txt", startLine: 1, endLine: 100 }, ctx)).reads), [[1, 100]]);
});

test("wide requests register only their actual capped range, including sparse disjoint ranges", async t => {
	const { ctx } = setup(t);
	const tool = createReadTool({ ...readLimits, maxLines: 100, lineNumbers: "sparse" });
	await tool.execute({ path: "a.txt", startLine: 30, endLine: 90 }, ctx);
	const partial = await tool.execute({ path: "a.txt", startLine: 21, endLine: 200 }, ctx);
	assert.equal(partial.details.requestedEndLine, 120);
	assert.deepEqual(ranges(partial.reads), [[21, 29], [91, 120]]);
	assert.match(partial.modelContent, /21\tsource_21 =/);
	assert.match(partial.modelContent, /91\tsource_91 =/);
	assert.doesNotMatch(partial.modelContent, /source_121 =/);
	assert.equal(ctx.files.isDelivered("a.txt", String(partial.details.hash), 21, 120), true);
	assert.equal(ctx.files.isDelivered("a.txt", String(partial.details.hash), 21, 121), false);
});

test("clipped lines, invalid UTF-8, empty files and outlines are not complete published ranges", async t => {
	const { root, ctx } = setup(t, "short\n" + "long".repeat(20));
	const clipped = await createReadTool({ ...readLimits, maxLineChars: 10 }).execute({ path: "a.txt" }, ctx);
	assert.equal(clipped.details.longLines, 1);
	assert.deepEqual(ranges(clipped.reads), []);
	assert.equal(ctx.files.isDelivered("a.txt", String(clipped.details.hash), 1, 2), false);
	writeFileSync(join(root, "a.txt"), Buffer.from([0xff, 0x61, 0x0a]));
	assert.deepEqual(ranges((await createReadTool(readLimits).execute({ path: "a.txt" }, ctx)).reads), []);
	writeFileSync(join(root, "a.txt"), "");
	assert.deepEqual(ranges((await createReadTool(readLimits).execute({ path: "a.txt" }, ctx)).reads), []);
	writeFileSync(join(root, "source.py"), "def one():\n    return 1\ndef two():\n    return 2\n");
	const outline = await createReadTool({ ...readLimits, outlineFirst: 2 }).execute({ path: "source.py" }, ctx);
	assert.equal(outline.details.outline, true);
	assert.deepEqual(ranges(outline.reads), []);
});

test("very small overlaps keep full output when the omission notice would be longer", async t => {
	const { ctx } = setup(t, "a\nb\nc\n");
	const tool = createReadTool(readLimits);
	await tool.execute({ path: "a.txt", startLine: 1, endLine: 1 }, ctx);
	const result = await tool.execute({ path: "a.txt", startLine: 1, endLine: 3 }, ctx);
	assert.equal(result.details.partialDedupe, undefined);
	assert.deepEqual(ranges(result.reads), [[1, 3]]);
});

test("partial read headers retain exact-version archive recovery and archive failures", async t => {
	const { ctx } = setup(t);
	const tool = createReadTool(readLimits, { contextExpand: true, lean: true });
	await tool.execute({ path: "a.txt", startLine: 20, endLine: 120 }, ctx);
	const partial = await tool.execute({ path: "a.txt", startLine: 1, endLine: 160 }, ctx);
	assert.equal(partial.details.partialDedupe, true);
	assert.ok(partial.fullOutputRef);
	assert.ok(partial.modelContent.includes(`fullOutputRef=${partial.fullOutputRef}`));
	assert.match(partial.modelContent, /more: startLine=161/);
	ctx.files.forgetDelivered();
	delete ctx.blobs;
	await tool.execute({ path: "a.txt", startLine: 20, endLine: 120 }, ctx);
	const unavailable = await tool.execute({ path: "a.txt", startLine: 1, endLine: 160 }, ctx);
	assert.equal(unavailable.details.partialDedupe, true);
	assert.match(unavailable.modelContent, /archive unavailable/);
});

test("query reads share published range memory and expose force without leaking hash receipts", async t => {
	const { ctx } = setup(t); ctx.deferReadPublication = true;
	const file = createReadTool(readLimits);
	const first = await file.execute({ path: "a.txt", startLine: 20, endLine: 120 }, ctx); publish(first, ctx);
	const tool = createPlanTool({ read: readLimits, lean: true });
	const plan = { steps: [{ id: "read", op: "read", path: "a.txt", startLine: 1, endLine: 160 }] };
	const partial = await tool.execute(plan, ctx);
	assert.equal(partial.ok, true, partial.modelContent);
	assert.deepEqual(ranges(partial.reads), [[1, 19], [121, 160]]);
	assert.doesNotMatch(partial.modelContent, /sha256:/);
	assert.ok(partial.reads?.every(read => /^[a-f0-9]{64}$/.test(read.hash)));
	assert.equal(ctx.files.isDelivered("a.txt", first.reads![0]!.hash, 1, 160), false);
	publish(partial, ctx);
	const duplicate = await tool.execute(plan, ctx);
	assert.deepEqual(ranges(duplicate.reads), []);
	assert.match(duplicate.modelContent, /already shown/);
	const forced = await tool.execute({ steps: [{ ...plan.steps[0], force: true }] }, ctx);
	assert.deepEqual(ranges(forced.reads), [[1, 160]]);
	assert.match(forced.modelContent, /20\tsource_20 =/);
	assert.throws(() => validateQueryPlan({ steps: [{ ...plan.steps[0], force: "true" }] }), /force/);
});

test("repeated read steps within one successful query reuse only earlier complete source ranges", async t => {
	const { ctx } = setup(t); ctx.deferReadPublication = true;
	const tool = createPlanTool({ read: readLimits, lean: true });
	const result = await tool.execute({ steps: [
		{ id: "first", op: "read", path: "a.txt", startLine: 1, endLine: 100 },
		{ id: "second", op: "read", path: "a.txt", startLine: 1, endLine: 100 },
	] }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.deepEqual(ranges(result.reads), [[1, 100]]);
	assert.equal(result.modelContent.match(/1\tsource_1 =/g)?.length, 1);
	assert.match(result.modelContent, /\[second\].*already shown earlier or in this query/);
	assert.equal(ctx.files.isDelivered("a.txt", result.reads![0]!.hash, 1, 100), false);
});

test("range subtraction merges overlapping observations without crossing file versions", () => {
	const files = new FileStateTracker();
	files.markDelivered("a", "v1", 10, 20); files.markDelivered("a", "v1", 15, 30); files.markDelivered("a", "v1", 40, 50);
	assert.deepEqual(files.undeliveredRanges("a", "v1", 1, 60), [{ start: 1, end: 9 }, { start: 31, end: 39 }, { start: 51, end: 60 }]);
	assert.deepEqual(files.undeliveredRanges("a", "v2", 1, 60), [{ start: 1, end: 60 }]);
	assert.deepEqual(files.undeliveredRanges("a", "v1", 12, 18), []);
});
