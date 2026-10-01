import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createEditTool, createReadTool, DEFAULT_READ_LIMITS } from "../src/files.ts";
import { createSearchTool } from "../src/search.ts";
import type { ToolContext } from "../src/types.ts";
import { BlobStore, FileStateTracker, sha256, Workspace } from "../src/workspace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "reading-v4-"));
	roots.push(root);
	const ac = new AbortController();
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), blobs: new BlobStore(join(root, ".archive")), signal: ac.signal, toolCallId: "reading-v4", approve: async () => "deny" };
	return { root, ctx, ac };
}
const batch = createEditTool({ batch: true });

test("search retains baseline text and exposes context only when enabled", async () => {
	const { root, ctx } = fixture();
	writeFileSync(join(root, "a.txt"), "before\n  needle\nafter\n");
	const base = createSearchTool();
	const result = await base.execute({ pattern: "needle" }, ctx);
	assert.equal(result.modelContent, "1 matches in 1 files (showing 1-1)\na.txt:2:3: needle");
	assert.equal(result.details.complete, true);
	assert.equal("contextLines" in (base.parameters.properties as object), false);
	assert.equal("edits" in (createEditTool().parameters.properties as object), false);
});

test("context merges neighboring hits and preserves CRLF source hash, Chinese and indentation", async () => {
	const { root, ctx } = fixture();
	const text = "needle 头\r\n  中文\r\n  needle 中\r\n    余行\r\nneedle 尾\r\n";
	writeFileSync(join(root, "中文.txt"), text);
	const result = await createSearchTool({ contextLines: 1 }).execute({ pattern: "needle" }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.match(result.modelContent, /lines 1-5 of 5/);
	assert.match(result.modelContent, /2-\t  中文\n3:\t  needle 中\n4-\t    余行/);
	assert.deepEqual(result.details.ranges, [{ path: "中文.txt", startLine: 1, endLine: 5, totalLines: 5, hash: sha256(text) }]);
	assert.equal(ctx.files.get("中文.txt"), sha256(text));
	const edit = await batch.execute({ path: "中文.txt", edits: [{ oldText: "needle 头", newText: "first" }, { oldText: "needle 尾", newText: "last" }] }, ctx);
	assert.equal(edit.ok, true, edit.modelContent);
});

test("search has deterministic pagination within the output budget", async () => {
	const { root, ctx } = fixture();
	writeFileSync(join(root, "a.txt"), Array.from({ length: 30 }, (_, i) => `needle ${i} ${"文".repeat(100)}`).join("\n"));
	const tool = createSearchTool({ contextLines: 1, maxOutputChars: 1500 });
	const seen: number[] = [];
	let cursor = 0;
	do {
		const result = await tool.execute({ pattern: "needle", cursor }, ctx);
		assert.equal(result.ok, true, result.modelContent);
		assert.ok(result.modelContent.length <= 1500);
		seen.push(...(result.details.matches as { line: number }[]).map((m) => m.line));
		if (result.details.next === null) break;
		assert.ok((result.details.next as number) > cursor);
		cursor = result.details.next as number;
	} while (cursor < 30);
	assert.deepEqual(seen, Array.from({ length: 30 }, (_, i) => i + 1));
});

test("search obeys ignore rules and does not follow outside symlinks", async () => {
	const { root, ctx } = fixture();
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), "ignored/\n");
	mkdirSync(join(root, "ignored"));
	writeFileSync(join(root, "ignored", "private.txt"), "needle");
	const outside = fixture().root;
	writeFileSync(join(outside, "private.txt"), "needle");
	symlinkSync(outside, join(root, "external"));
	writeFileSync(join(root, "a.txt"), "needle");
	const result = await createSearchTool({ contextLines: 1 }).execute({ pattern: "needle" }, ctx);
	assert.deepEqual((result.details.matches as { path: string }[]).map((m) => m.path), ["a.txt"]);
});

test("scan, file count and individual file limits never claim complete absence", async () => {
	for (const limits of [{ maxScanBytes: 10 }, { maxFileBytes: 10 }, { maxFiles: 1 }]) {
		const { root, ctx } = fixture();
		writeFileSync(join(root, "a.txt"), "x".repeat(15));
		writeFileSync(join(root, "b.txt"), "needle");
		const result = await createSearchTool(limits).execute({ pattern: "needle" }, ctx);
		assert.equal(result.details.complete, false);
		assert.match(result.modelContent, /incomplete/);
		assert.doesNotMatch(result.modelContent, /No matches/);
	}
});

test("invalid regex, invalid paging and cancellation return explicit failure", async () => {
	const { ctx, ac } = fixture();
	assert.equal((await createSearchTool().execute({ pattern: "[" }, ctx)).ok, false);
	assert.equal((await createSearchTool().execute({ pattern: "x", maxResults: -1 }, ctx)).ok, false);
	ac.abort();
	const canceled = await createSearchTool().execute({ pattern: "x" }, ctx);
	assert.equal(canceled.ok, false);
	assert.equal(canceled.details.complete, false);
});

test("large single-line rg output is bounded and cannot become a false negative", async () => {
	const { root, ctx } = fixture();
	writeFileSync(join(root, "long.txt"), "needle ".repeat(60000));
	const result = await createSearchTool({ contextLines: 1 }).execute({ pattern: "needle" }, ctx);
	assert.equal(result.details.complete, false);
	assert.ok(result.modelContent.length <= 30000);
	assert.doesNotMatch(result.modelContent, /^No matches/);
});

test("late binary NUL cannot change rg line numbering or produce a phantom text match", async () => {
	const { root, ctx } = fixture();
	writeFileSync(join(root, "late-nul.txt"), "a".repeat(9000) + "\0needle\n");
	const result = await createSearchTool({ contextLines: 1 }).execute({ pattern: "needle" }, ctx);
	assert.deepEqual(result.details.matches, []);
	assert.equal(result.details.skippedBinaryFiles, 1);
	assert.match(result.modelContent, /skipped 1 binary files/);
	assert.equal((await createReadTool().execute({ path: "late-nul.txt" }, ctx)).ok, false);
});

test("baseline marks clipped text and BOM column addresses original bytes", async () => {
	const { root, ctx } = fixture();
	writeFileSync(join(root, "long.txt"), "a".repeat(400) + "needle\n");
	const result = await createSearchTool().execute({ pattern: "needle" }, ctx);
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.longLines, 1);
	writeFileSync(join(root, "bom.txt"), "\uFEFFneedle\n");
	const bom = await createSearchTool({ contextLines: 1 }).execute({ pattern: "needle", glob: "bom.txt" }, ctx);
	assert.equal((bom.details.matches as { col: number }[])[0]?.col, 2);
	assert.equal((bom.details.ranges as { hash: string }[])[0]?.hash, sha256("\uFEFFneedle\n"));
});

test("permission errors, invalid text and time limits cannot prove absence", async (t) => {
	const { root, ctx } = fixture();
	writeFileSync(join(root, "invalid.txt"), Buffer.from([0xff, 0x61]));
	const invalid = await createSearchTool().execute({ pattern: "needle" }, ctx);
	assert.equal(invalid.details.complete, false);
	assert.doesNotMatch(invalid.modelContent, /^No matches/);
	rmSync(join(root, "invalid.txt"));
	writeFileSync(join(root, "private.txt"), "needle");
	if (process.getuid?.() !== 0) {
		chmodSync(join(root, "private.txt"), 0o000);
		try {
			const denied = await createSearchTool().execute({ pattern: "needle" }, ctx);
			assert.equal(denied.details.complete, false);
			assert.doesNotMatch(denied.modelContent, /^No matches/);
		} finally { chmodSync(join(root, "private.txt"), 0o600); }
	} else t.diagnostic("read-permission denial cannot be exercised as root");
	for (let i = 0; i < 100; i++) writeFileSync(join(root, `f${i}.txt`), "x");
	const timed = await createSearchTool({ timeoutMs: 1 }).execute({ pattern: "absent" }, ctx);
	assert.equal(timed.details.complete, false);
	assert.doesNotMatch(timed.modelContent, /^No matches/);
});

test("search text and hash use the captured stdin version even if the live file changes", () => {
	const { root } = fixture();
	const original = "before\n  needle 原文\nafter\n";
	writeFileSync(join(root, "a.txt"), original);
	const rg = join(root, "rg-fixture");
	writeFileSync(rg, `#!/usr/bin/env node\nconst fs=require('node:fs');\nif(process.argv.includes('--files')){process.stdout.write('a.txt\\0');}else{const bytes=fs.readFileSync(0);if(bytes.length){fs.writeFileSync('a.txt','changed after snapshot');process.stdout.write(JSON.stringify({type:'match',data:{line_number:2,submatches:[{start:2}]}})+'\\n');}else process.exitCode=1;}\n`);
	chmodSync(rg, 0o700);
	const source = new URL("../src/search.ts", import.meta.url).href;
	const workspace = new URL("../src/workspace.ts", import.meta.url).href;
	const script = `import {createSearchTool} from ${JSON.stringify(source)}; import {Workspace, FileStateTracker} from ${JSON.stringify(workspace)}; const r=await createSearchTool({contextLines:1}).execute({pattern:'needle'}, {workspace:new Workspace(${JSON.stringify(root)}),files:new FileStateTracker(),signal:new AbortController().signal,toolCallId:'fake-rg',approve:async()=> 'deny'}); console.log(JSON.stringify(r));`;
	const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, MOUNTAINS_RG: rg }, encoding: "utf8" }));
	assert.equal(result.ok, true);
	assert.equal(result.details.matches[0].hash, sha256(original));
	assert.match(result.modelContent, /needle 原文/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "changed after snapshot");
});

test("batch validates every edit against original content and commits once with mode and CRLF intact", async () => {
	const { root, ctx } = fixture();
	const path = join(root, "a.txt");
	writeFileSync(path, "alpha\r\nbeta\r\ngamma\r\n");
	chmodSync(path, 0o750);
	await createReadTool().execute({ path: "a.txt" }, ctx);
	let hooks = 0;
	ctx.beforeWrite = async () => { hooks++; };
	const result = await batch.execute({ path: "a.txt", edits: [{ oldText: "alpha\nbeta", newText: "beta\nB" }, { oldText: "gamma", newText: "G" }] }, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(hooks, 1);
	assert.equal(result.writes?.length, 1);
	assert.equal(readFileSync(path, "utf8"), "beta\r\nB\r\nG\r\n");
	assert.equal(statSync(path).mode & 0o777, 0o750);
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
		symlinkSync(outside, join(root, "dir"));
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
