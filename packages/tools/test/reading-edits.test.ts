import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createEditTool, createReadTool, DEFAULT_READ_LIMITS } from "../src/files.ts";
import type { ToolContext } from "../src/types.ts";
import { BlobStore, FileStateTracker, sha256, Workspace } from "../src/workspace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "reading-edits-"));
	roots.push(root);
	const ac = new AbortController();
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), blobs: new BlobStore(join(root, ".archive")), signal: ac.signal, toolCallId: "reading-edits", approve: async () => "deny" };
	return { root, ctx, ac };
}
const batch = createEditTool({ batch: true });

test("batch validates every edit against original content and commits once with mode and CRLF intact", async () => {
	const { root, ctx } = fixture();
	const path = join(root, "a.txt");
	writeFileSync(path, "alpha\r\nbeta\r\ngamma\r\n");
	chmodSync(path, 0o750);
	const originalMode = statSync(path).mode & 0o777;
	await createReadTool().execute({ path: "a.txt" }, ctx);
	let hooks = 0;
	ctx.beforeWrite = async () => { hooks++; };
	const result = await batch.execute({ path: "a.txt", edits: [{ oldText: "alpha\nbeta", newText: "beta\nB" }, { oldText: "gamma", newText: "G" }] }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(hooks, 1);
	assert.equal(result.writes?.length, 1);
	assert.equal(readFileSync(path, "utf8"), "beta\r\nB\r\nG\r\n");
	assert.equal(statSync(path).mode & 0o777, originalMode);
	assert.ok(!readdirSync(root).some((p) => p.endsWith(".tmp")));
});

test("batch missing, overlapping, duplicate, empty and dependent edits leave all original bytes", async () => {
	const attempts = [
		[{ oldText: "alpha", newText: "A" }, { oldText: "absent", newText: "B" }],
		[{ oldText: "alpha beta", newText: "A" }, { oldText: "beta", newText: "B" }],
		[{ oldText: "alpha", newText: "A" }, { oldText: "alpha", newText: "B" }],
		[{ oldText: "", newText: "A" }],
		[{ oldText: "alpha", newText: "new" }, { oldText: "new", newText: "B" }],
		[{ oldText: "aa", newText: "x", expectedMatches: 2 }],
	];
	for (const edits of attempts) {
		const { root, ctx } = fixture();
		const original = Buffer.from("alpha beta\n\uFEFF中文\naaa\n");
		writeFileSync(join(root, "a.txt"), original);
		await createReadTool().execute({ path: "a.txt" }, ctx);
		ctx.beforeWrite = async () => { assert.fail("failed validation must not enter commit"); };
		const result = await batch.execute({ path: "a.txt", edits }, ctx);
		assert.equal(result.ok, false, JSON.stringify(edits));
		assert.deepEqual(readFileSync(join(root, "a.txt")), original);
	}
});

test("batch shape, match counts and stale version are rejected without writes", async () => {
	const { root, ctx } = fixture();
	writeFileSync(join(root, "a.txt"), "x x");
	await createReadTool().execute({ path: "a.txt" }, ctx);
	for (const args of [
		{ edits: [{ oldText: "x", newText: "y" }] },
		{ edits: [{ oldText: "x", newText: "y", expectedMatches: 2 }], oldText: "x", newText: "y" },
		{ edits: [] },
		{ edits: [{ oldText: "x", newText: "y", expectedMatches: 2 }], expectedHash: "00000000" },
	]) assert.equal((await batch.execute({ path: "a.txt", ...args }, ctx)).ok, false);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "x x");
	assert.equal((await batch.execute({ path: "a.txt", edits: [{ oldText: "x", newText: "y", expectedMatches: 2 }] }, ctx)).ok, true);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "y y");
});

test("external change during checkpoint is detected and temporary output is cleaned", async () => {
	const { root, ctx } = fixture();
	const path = join(root, "a.txt");
	writeFileSync(path, "alpha beta");
	await createReadTool().execute({ path: "a.txt" }, ctx);
	ctx.beforeWrite = async () => { writeFileSync(path, "external writer"); };
	const result = await batch.execute({ path: "a.txt", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "beta", newText: "B" }] }, ctx);
	assert.equal(result.ok, false);
	assert.match(result.modelContent, /提交前已改变/);
	assert.equal(readFileSync(path, "utf8"), "external writer");
	assert.ok(!readdirSync(root).some((p) => p.endsWith(".tmp")));
});

test("checkpoint failure and cancellation preserve original file", async () => {
	const { root, ctx, ac } = fixture();
	writeFileSync(join(root, "a.txt"), "alpha");
	await createReadTool().execute({ path: "a.txt" }, ctx);
	ctx.beforeWrite = async () => { throw new Error("checkpoint failed"); };
	assert.equal((await batch.execute({ path: "a.txt", edits: [{ oldText: "alpha", newText: "A" }] }, ctx)).ok, false);
	ctx.beforeWrite = async () => { ac.abort(); };
	assert.equal((await batch.execute({ path: "a.txt", edits: [{ oldText: "alpha", newText: "A" }] }, ctx)).ok, false);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "alpha");
});

test("parent path changed to an outside symlink during checkpoint cannot redirect the commit", async () => {
	const { root, ctx } = fixture();
	const outside = fixture().root;
	mkdirSync(join(root, "dir"));
	writeFileSync(join(root, "dir", "a.txt"), "alpha");
	writeFileSync(join(outside, "a.txt"), "alpha");
	await createReadTool().execute({ path: "dir/a.txt" }, ctx);
	ctx.beforeWrite = async () => {
		renameSync(join(root, "dir"), join(root, "saved"));
		symlinkSync(outside, join(root, "dir"), process.platform === "win32" ? "junction" : "dir");
	};
	const result = await batch.execute({ path: "dir/a.txt", edits: [{ oldText: "alpha", newText: "A" }] }, ctx);
	assert.equal(result.ok, false);
	assert.equal(readFileSync(join(outside, "a.txt"), "utf8"), "alpha");
	assert.equal(readFileSync(join(root, "saved", "a.txt"), "utf8"), "alpha");
});

test("first truncated read exposes exact byte archive and truncated long lines are never deduped", async () => {
	const { root, ctx } = fixture();
	const text = "\uFEFF中文\r\n" + "x".repeat(5000) + "\r\nlast\r\n";
	writeFileSync(join(root, "a.txt"), text);
	const read = createReadTool({ ...DEFAULT_READ_LIMITS, dedupe: true, maxLineChars: 100 });
	const first = await read.execute({ path: "a.txt", startLine: 2, endLine: 2 }, ctx);
	assert.ok(first.fullOutputRef);
	assert.ok(first.modelContent.includes(`fullOutputRef=${first.fullOutputRef}`));
	assert.deepEqual(ctx.blobs!.getBytes(first.fullOutputRef), Buffer.from(text));
	const second = await read.execute({ path: "a.txt", startLine: 2, endLine: 2 }, ctx);
	assert.notEqual(second.details.deduped, true);
	writeFileSync(join(root, "a.txt"), "changed");
	assert.deepEqual(ctx.blobs!.getBytes(first.fullOutputRef), Buffer.from(text));
});

test("archive failure is explicit and never publishes a fake reference", async () => {
	const { root, ctx } = fixture();
	writeFileSync(join(root, "a.txt"), "one\ntwo\n");
	ctx.blobs!.put = () => { throw new Error("disk unavailable"); };
	const result = await createReadTool().execute({ path: "a.txt", endLine: 1 }, ctx);
	assert.equal(result.fullOutputRef, undefined);
	assert.match(result.modelContent, /archive unavailable: Error: disk unavailable/);
	assert.ok(result.details.archiveError);
});

test("Python symbol reads retain decorated and multiline definition boundaries", async () => {
	const { root, ctx } = fixture();
	const source = "@decorate(\n    flag=True,\n)\ndef target(\n    value,\n):\n    return value\n\ndef other():\n    return 0\n";
	writeFileSync(join(root, "a.py"), source);
	const result = await createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true }).execute({ path: "a.py", symbol: "target" }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(result.details.startLine, 1);
	assert.equal(result.details.endLine, 7);
	assert.doesNotMatch(result.modelContent, /def other/);
});

test("non-UTF8 reads preserve bytes in archive and edits refuse lossy conversion", async () => {
	const { root, ctx } = fixture();
	const original = Buffer.from([0x61, 0xff, 0x62]);
	writeFileSync(join(root, "a.txt"), original);
	const result = await createReadTool().execute({ path: "a.txt" }, ctx);
	assert.ok(result.fullOutputRef);
	assert.deepEqual(ctx.blobs!.getBytes(result.fullOutputRef), original);
	assert.match(result.modelContent, /invalid UTF-8/);
	assert.equal((await batch.execute({ path: "a.txt", edits: [{ oldText: "a", newText: "A" }] }, ctx)).ok, false);
	assert.deepEqual(readFileSync(join(root, "a.txt")), original);
});
