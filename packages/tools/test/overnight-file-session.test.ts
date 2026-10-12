import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEditTool, createReadTool, createWriteTool } from "../src/files.ts";
import { createExpandTool } from "../src/recall.ts";
import { SessionArchiveIndex, type SessionSearchSuccess } from "../src/session-index.ts";
import { createSessionSearchTool } from "../src/session-search.ts";
import { createTaskNoteTool, TASK_NOTE_LIMITS } from "../src/task-note.ts";
import type { ToolContext } from "../src/types.ts";
import { BlobStore, FileStateTracker, sha256, Workspace } from "../src/workspace.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "overnight-files-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	const work = join(root, "work"); mkdirSync(work);
	const blobs = new BlobStore(join(root, "archive"), { workspaceRoot: work, sessionId: "office-work" });
	const ctx: ToolContext = { workspace: new Workspace(work), blobs, files: new FileStateTracker(),
		signal: new AbortController().signal, toolCallId: "office-file", approve: async () => "deny" };
	return { work, blobs, ctx };
}

test("O-001: an exact LF range remains editable when another paragraph uses CRLF", async t => {
	const { work, ctx } = fixture(t);
	writeFileSync(join(work, "meeting.md"), "Header\r\nAgenda\nBudget\n");
	assert.ok((await createReadTool().execute({ path: "meeting.md" }, ctx)).ok);
	const result = await createEditTool().execute({ path: "meeting.md", oldText: "Agenda\nBudget", newText: "Agenda\nFinal budget" }, ctx);
	assert.ok(result.ok, result.modelContent);
	assert.equal(readFileSync(join(work, "meeting.md"), "utf8"), "Header\r\nAgenda\nFinal budget\n");
});

test("O-001: a successful single replacement changes the exact block rather than its CRLF lookalike", async t => {
	const { work, ctx } = fixture(t);
	writeFileSync(join(work, "meeting.md"), "Budget\r\nDraft\r\n---\r\nBudget\nDraft\n");
	await createReadTool().execute({ path: "meeting.md" }, ctx);
	const result = await createEditTool().execute({ path: "meeting.md", oldText: "Budget\nDraft", newText: "Budget\nApproved" }, ctx);
	assert.ok(result.ok, result.modelContent);
	assert.equal(readFileSync(join(work, "meeting.md"), "utf8"), "Budget\r\nDraft\r\n---\r\nBudget\nApproved\n");
	assert.equal(result.details.line, 4);
});

for (const batch of [false, true]) {
	test(`O-001: ${batch ? "batch" : "scalar"} editing chooses exact LF blocks over visually equal CRLF blocks`, async t => {
		const { work, ctx } = fixture(t);
		const original = "Budget\r\nDraft\r\n---\r\nBudget\nDraft\n---\nBudget\nDraft\n";
		writeFileSync(join(work, "meeting.md"), original);
		assert.ok((await createReadTool().execute({ path: "meeting.md" }, ctx)).ok);
		const replacement = { oldText: "Budget\nDraft", newText: "Budget\nApproved", expectedMatches: 2 };
		const result = await createEditTool({ batch, feedback: true }).execute({ path: "meeting.md", ...(batch ? { edits: [replacement] } : replacement) }, ctx);
		assert.ok(result.ok, result.modelContent);
		const expected = "Budget\r\nDraft\r\n---\r\nBudget\nApproved\n---\nBudget\nApproved\n";
		assert.equal(readFileSync(join(work, "meeting.md"), "utf8"), expected);
		assert.equal(result.details.replacements, 2);
		assert.equal(result.writes?.[0]?.afterHash, sha256(expected));
		assert.equal(result.reads?.[0]?.hash, sha256(expected));
	});
}

test("O-001: exact-match ambiguity is not replaced by a unique normalized alternative", async t => {
	const { work, ctx } = fixture(t);
	const original = "Budget\r\nDraft\r\n---\nBudget\nDraft\n---\nBudget\nDraft\n";
	writeFileSync(join(work, "meeting.md"), original);
	await createReadTool().execute({ path: "meeting.md" }, ctx);
	const result = await createEditTool().execute({ path: "meeting.md", oldText: "Budget\nDraft", newText: "Approved" }, ctx);
	assert.equal(result.ok, false);
	assert.equal(result.details.matches, 2);
	assert.equal(readFileSync(join(work, "meeting.md"), "utf8"), original);
});

test("O-001: an exact mixed-ending range retains the replacement's literal line endings", async t => {
	const { work, ctx } = fixture(t);
	const original = "Header\r\nAgenda\nBudget\r\n";
	writeFileSync(join(work, "meeting.md"), original);
	await createReadTool().execute({ path: "meeting.md" }, ctx);
	const result = await createEditTool().execute({ path: "meeting.md", oldText: "Header\r\nAgenda\nBudget", newText: "Header\r\nAgenda\nFinal budget" }, ctx);
	assert.ok(result.ok, result.modelContent);
	assert.equal(readFileSync(join(work, "meeting.md"), "utf8"), "Header\r\nAgenda\nFinal budget\r\n");
});

test("O-001: a batch can independently change LF and CRLF paragraphs without reinterpreting either", async t => {
	const { work, ctx } = fixture(t);
	writeFileSync(join(work, "meeting.md"), "Legacy\r\nDraft\r\nCurrent\nDraft\n");
	await createReadTool().execute({ path: "meeting.md" }, ctx);
	const result = await createEditTool({ batch: true }).execute({ path: "meeting.md", edits: [
		{ oldText: "Legacy\r\nDraft", newText: "Legacy\r\nArchived" },
		{ oldText: "Current\nDraft", newText: "Current\nApproved" },
	] }, ctx);
	assert.ok(result.ok, result.modelContent);
	assert.equal(readFileSync(join(work, "meeting.md"), "utf8"), "Legacy\r\nArchived\r\nCurrent\nApproved\n");
});

test("O-001 control: uniform CRLF files still adapt single-line replacements with inserted LF lines", async t => {
	const { work, ctx } = fixture(t);
	writeFileSync(join(work, "meeting.md"), "Header\r\nDraft\r\n");
	await createReadTool().execute({ path: "meeting.md" }, ctx);
	const result = await createEditTool().execute({ path: "meeting.md", oldText: "Draft", newText: "Approved\nOwner: Mei" }, ctx);
	assert.ok(result.ok, result.modelContent);
	assert.equal(readFileSync(join(work, "meeting.md"), "utf8"), "Header\r\nApproved\r\nOwner: Mei\r\n");
});

test("O-001 control: LF readback can still locate a CRLF paragraph when no exact range exists", async t => {
	const { work, ctx } = fixture(t);
	writeFileSync(join(work, "meeting.md"), "Imported\nBudget\r\nDraft\r\n");
	await createReadTool().execute({ path: "meeting.md" }, ctx);
	const result = await createEditTool().execute({ path: "meeting.md", oldText: "Budget\nDraft", newText: "Budget\nApproved" }, ctx);
	assert.ok(result.ok, result.modelContent);
	assert.equal(readFileSync(join(work, "meeting.md"), "utf8"), "Imported\nBudget\r\nApproved\r\n");
});

for (const name of ["quarterly-review-".repeat(12) + ".md", "季度会议纪要".repeat(12) + ".md"]) {
	test(`O-002: valid ${/^[\x00-\x7F]*$/.test(name) ? "ASCII" : "Unicode"} long basenames support create, edit and overwrite`, async t => {
		const { work, ctx } = fixture(t);
		// A native write is the portability control: these names must be valid on the test filesystem.
		writeFileSync(join(work, name), "Draft");
		assert.ok((await createReadTool().execute({ path: name }, ctx)).ok);
		const edited = await createEditTool().execute({ path: name, oldText: "Draft", newText: "Reviewed" }, ctx);
		assert.ok(edited.ok, edited.modelContent);
		assert.equal(readFileSync(join(work, name), "utf8"), "Reviewed");
		const copy = name.replace(/\.md$/, ".txt");
		const created = await createWriteTool().execute({ path: copy, content: "Agenda\n" }, ctx);
		assert.ok(created.ok, created.modelContent);
		const overwritten = await createWriteTool().execute({ path: name, content: "Final\n", createOnly: false, expectedHash: sha256("Reviewed") }, ctx);
		assert.ok(overwritten.ok, overwritten.modelContent);
		assert.equal(readFileSync(join(work, name), "utf8"), "Final\n");
		assert.equal(readFileSync(join(work, copy), "utf8"), "Agenda\n");
		assert.deepEqual(readdirSync(work).sort(), [name, copy].sort(), "temporary siblings are removed after each commit");
	});
}

test("task notes preserve multiline requirements and default absent optional lists without changing input", async t => {
	const { ctx } = fixture(t);
	const args = { requirements: ["Keep the appendix\nInclude Mei's correction", "保留原始金额 €120"], next: "Review meeting.md before the final edit" };
	const before = structuredClone(args);
	const result = await createTaskNoteTool().execute(args, ctx);
	assert.ok(result.ok, result.modelContent);
	assert.deepEqual(result.details.note, { ...args, facts: [], ruledOut: [] });
	assert.deepEqual(args, before);
	assert.equal(result.writes, undefined);
});

test("task notes accept exact field limits and reject a one-character or one-item overflow", async t => {
	const { ctx } = fixture(t), tool = createTaskNoteTool();
	const requirements = Array.from({ length: TASK_NOTE_LIMITS.items }, () => "文".repeat(TASK_NOTE_LIMITS.itemChars));
	const next = "n".repeat(TASK_NOTE_LIMITS.nextChars);
	assert.ok((await tool.execute({ requirements, next }, ctx)).ok);
	for (const args of [
		{ requirements: [...requirements, "one extra"], next },
		{ requirements: ["x".repeat(TASK_NOTE_LIMITS.itemChars + 1)], next },
		{ requirements, next: next + "x" },
		{ requirements, facts: [""], next },
		{ requirements, ruledOut: "not a list", next },
	]) {
		const result = await tool.execute(args, ctx);
		assert.equal(result.ok, false);
		assert.equal(result.details.note, undefined);
	}
});

test("session search crosses the archive-check page limit without dropping later office records", async t => {
	const { blobs, ctx } = fixture(t), index = new SessionArchiveIndex(blobs), tool = createSessionSearchTool(index);
	for (let i = 1; i <= 18; i++) index.record(`Action item ${i}: prepare the agenda.`, { role: "tool", name: "file_read", target: `meetings/week-${i}.md`, toolCallId: `read-${i}` });
	let cursor: string | undefined;
	const ordinals: number[] = [], limits: string[] = [];
	for (let i = 0; i < 4; i++) {
		const result = await tool.execute({ needle: "Action item", maxMatches: 20, maxSnippetBytes: 40, maxOutputBytes: 12_000, ...(cursor ? { cursor } : {}) }, ctx);
		assert.ok(result.ok, result.modelContent);
		const page = JSON.parse(result.modelContent) as SessionSearchSuccess;
		assert.ok(page.checkedRecords <= 8);
		ordinals.push(...page.matches.map(match => match.ordinal)); limits.push(...page.limits);
		if (!page.nextCursor) { assert.equal(page.complete, true); break; }
		assert.notEqual(page.nextCursor, cursor); cursor = page.nextCursor;
	}
	assert.deepEqual(ordinals, Array.from({ length: 18 }, (_, i) => i + 1));
	assert.ok(limits.includes("archive-checks"));
});

test("session search truncates a long source label while retaining the full recoverable meeting body", async t => {
	const { blobs, ctx } = fixture(t), index = new SessionArchiveIndex(blobs);
	const body = "Decision: retain the original deadline.\nFollow-up: review the appendix.";
	const label = "部门会议/".repeat(50) + "notes.md";
	const ref = index.record(body, { role: "tool", target: label, name: "file_read", toolCallId: "long-label" });
	const result = await createSessionSearchTool(index).execute({ needle: "deadline" }, ctx);
	assert.ok(result.ok, result.modelContent);
	const page = JSON.parse(result.modelContent) as SessionSearchSuccess;
	assert.equal(page.matches.length, 1);
	const hit = page.matches[0]!;
	assert.equal(hit.targetTruncated, true);
	assert.ok(Buffer.byteLength(hit.target!) <= 512);
	assert.equal(hit.target!.includes("\ufffd"), false);
	assert.equal(hit.text, body);
	const expanded = await createExpandTool().execute({ ref, offsetBytes: 0, maxBytes: Buffer.byteLength(body) }, ctx);
	assert.ok(expanded.ok, expanded.modelContent);
	assert.equal(expanded.modelContent.slice(expanded.modelContent.indexOf("\n") + 1), body);
});
