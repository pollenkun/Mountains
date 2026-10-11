import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { BlobStore, createCommandTool, createExpandTool, EXPAND_MAX_BYTES, FileStateTracker, MAX_ARCHIVE_BYTES, sha256, type ToolContext, Workspace } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
	const root = mkdtempSync(join(tmpdir(), "evidence-"));
	roots.push(root);
	const workspaceRoot = join(root, "work");
	mkdirSync(workspaceRoot);
	const dir = join(root, "archive");
	const blobs = new BlobStore(dir, { workspaceRoot, sessionId: "session-a" });
	const ctx: ToolContext = { workspace: new Workspace(workspaceRoot), blobs, files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "call_1", approve: async () => "allow" };
	return { root, dir, workspaceRoot, blobs, ctx };
}
function archivePath(dir: string, ref: string) {
	const match = /^blob_v2_([0-9a-f]{64})_([0-9a-f]{32})_(raw|shown)_([0-9a-f]{64})$/.exec(ref);
	assert.ok(match);
	return join(dir, match[1]!, match[2]!, match[3]!, match[4]!.slice(0, 2), match[4]!);
}
function body(text: string): string { return text.slice(text.indexOf("\n") + 1); }
const expand = createExpandTool();

describe("immutable evidence", () => {
	test("first truncated command response exposes its complete original output including middle error", async () => {
		const { blobs, ctx } = setup();
		const text = Array.from({ length: 500 }, (_, i) => i === 250 ? "ERROR_ONLY_IN_MIDDLE" : `row ${i}`).join("\r\n");
		const tool = createCommandTool({ defaultTimeoutMs: process.platform === "win32" ? 15_000 : 5000, maxTimeoutMs: process.platform === "win32" ? 15_000 : 5000, headLines: 3, tailLines: 3, maxChars: 200 });
		const result = await tool.execute({ argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)})`] }, ctx);
		assert.equal(result.ok, true);
		assert.equal(result.details.truncated, true);
		assert.ok(result.fullOutputRef);
		assert.ok(result.modelContent.includes(`fullOutputRef=${result.fullOutputRef}`));
		assert.equal(blobs.get(result.fullOutputRef), text);
		const page = await expand.execute({ ref: result.fullOutputRef, offset: 251, limit: 1 }, ctx);
		assert.equal(page.ok, true, page.modelContent);
		assert.equal(body(page.modelContent), "ERROR_ONLY_IN_MIDDLE\r\n");
	});

	test("raw 81 40 0d 0a survives command capture and recovers as base64", async () => {
		const { blobs, ctx } = setup();
		const original = Buffer.from([0x81, 0x40, 0x0d, 0x0a]);
		const result = await createCommandTool().execute({ argv: [process.execPath, "-e", "process.stdout.write(Buffer.from([0x81,0x40,0x0d,0x0a]))"] }, ctx);
		assert.equal(result.ok, true);
		assert.equal(result.details.invalidUtf8, true);
		assert.ok(result.fullOutputRef);
		assert.deepEqual(blobs.getBytes(result.fullOutputRef), original);
		assert.equal(blobs.get(result.fullOutputRef), null);
		assert.match(result.modelContent, /invalid UTF-8/);
		const recovered = await expand.execute({ ref: result.fullOutputRef }, ctx);
		assert.equal(recovered.ok, true, recovered.modelContent);
		assert.equal(recovered.details.encoding, "base64");
		assert.deepEqual(Buffer.from(body(recovered.modelContent), "base64"), original);
		assert.equal((await expand.execute({ ref: result.fullOutputRef, encoding: "utf8" }, ctx)).ok, false);
		assert.equal((await expand.execute({ ref: result.fullOutputRef, offset: 1 }, ctx)).ok, false);
	});

	test("UTF-16 is retained without being guessed as another text encoding", async () => {
		const { blobs, ctx } = setup();
		const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文\r\n", "utf16le")]);
		const ref = blobs.put(raw, { kind: "raw" });
		const result = await expand.execute({ ref }, ctx);
		assert.equal(result.details.invalidUtf8, true);
		assert.deepEqual(Buffer.from(body(result.modelContent), "base64"), raw);
	});

	test("BOM, CRLF, Chinese and emoji round-trip through bounded byte pages", async () => {
		const { blobs, ctx } = setup();
		const raw = Buffer.from("\ufeff" + "中文😀\r\n".repeat(160));
		const ref = blobs.put(raw, { kind: "raw" });
		const pages: Buffer[] = [];
		let offsetBytes = 0;
		for (let guard = 0; guard < 500; guard++) {
			const page = await expand.execute({ ref, offsetBytes, maxBytes: 19 }, ctx);
			assert.equal(page.ok, true, page.modelContent);
			assert.equal(page.details.invalidUtf8, false);
			const bytes = Buffer.from(body(page.modelContent));
			assert.ok(bytes.length <= 19);
			pages.push(bytes);
			if (!page.details.more) break;
			assert.ok(Number(page.details.nextOffsetBytes) > offsetBytes);
			offsetBytes = Number(page.details.nextOffsetBytes);
		}
		assert.deepEqual(Buffer.concat(pages), raw);
		assert.equal(sha256(Buffer.concat(pages)), ref.slice(-64));
	});

	test("long single-line pages stay bounded and reach the middle without rerunning anything", async () => {
		const { blobs, ctx } = setup();
		const raw = Buffer.from("x".repeat(30_000) + "MIDDLE" + "中".repeat(12_000));
		const ref = blobs.put(raw, { kind: "raw" });
		const first = await expand.execute({ ref, maxBytes: Number.MAX_SAFE_INTEGER }, ctx);
		assert.equal(Buffer.byteLength(body(first.modelContent)), EXPAND_MAX_BYTES);
		assert.equal(first.details.nextOffsetBytes, EXPAND_MAX_BYTES);
		const middle = await expand.execute({ ref, offsetBytes: 30_000, maxBytes: 6 }, ctx);
		assert.equal(body(middle.modelContent), "MIDDLE");
		assert.equal((await expand.execute({ ref, offsetBytes: 30_007 }, ctx)).ok, false);
		assert.equal((await expand.execute({ ref, offsetBytes: 30_006, maxBytes: 1 }, ctx)).ok, false);
	});

	test("history survives file replacement, archive restart, and original source removal", async () => {
		const { dir, workspaceRoot, blobs, ctx } = setup();
		const path = join(workspaceRoot, "source.txt");
		writeFileSync(path, "old evidence\r\n");
		const ref = blobs.put(readFileSync(path), { kind: "raw", source: { path: "source.txt" } });
		writeFileSync(path, "new evidence\n");
		const latest = blobs.put(readFileSync(path), { kind: "raw" });
		rmSync(path);
		ctx.blobs = new BlobStore(dir, { workspaceRoot, sessionId: "session-a" });
		assert.notEqual(ref, latest);
		assert.equal(body((await expand.execute({ ref }, ctx)).modelContent), "old evidence\r\n");
		assert.equal(body((await expand.execute({ ref: latest }, ctx)).modelContent), "new evidence\n");
	});

	test("scope rejects other sessions unless host explicitly grants workspace history", () => {
		const { root, dir, workspaceRoot, blobs } = setup();
		const ref = blobs.put("old session", { kind: "raw" });
		const next = new BlobStore(dir, { workspaceRoot, sessionId: "session-b" });
		assert.equal(next.getBytes(ref), null);
		const historical = new BlobStore(dir, { workspaceRoot, sessionId: "session-c", allowWorkspaceHistory: true });
		assert.equal(historical.get(ref), "old session");
		const elsewhere = join(root, "other-workspace");
		mkdirSync(elsewhere);
		const other = new BlobStore(dir, { workspaceRoot: elsewhere, sessionId: "session-a", allowWorkspaceHistory: true });
		assert.equal(other.getBytes(ref), null);
		assert.equal(new BlobStore(join(root, "other-archive"), { workspaceRoot, sessionId: "session-a", allowWorkspaceHistory: true }).getBytes(ref), null);
	});

	test("tool refuses a BlobStore attached to a different workspace", async () => {
		const { root, blobs, ctx } = setup();
		const ref = blobs.put("secret", { kind: "raw" });
		const other = join(root, "elsewhere");
		mkdirSync(other);
		ctx.workspace = new Workspace(other);
		assert.equal((await expand.execute({ ref }, ctx)).ok, false);
	});

	test("native Windows short-name workspace scopes and canonical tool roots share only their own archives", { skip: process.platform !== "win32" }, async t => {
		const { root, dir, workspaceRoot, blobs, ctx } = setup();
		if (!/~\d/i.test(workspaceRoot) || workspaceRoot === ctx.workspace.root) { t.skip("the native TEMP path exposes no distinct 8.3 alias"); return; }
		const ref = blobs.put("scoped original bytes\r\n", { kind: "raw" });
		assert.equal(blobs.matchesWorkspace(workspaceRoot), true);
		assert.equal(blobs.matchesWorkspace(ctx.workspace.root), true);
		assert.equal(body((await expand.execute({ ref }, ctx)).modelContent), "scoped original bytes\r\n");
		const restarted = new BlobStore(blobs.dir, { workspaceRoot: ctx.workspace.root, sessionId: "session-a" });
		assert.equal(restarted.get(ref), "scoped original bytes\r\n");
		assert.equal(restarted.put("scoped original bytes\r\n", { kind: "raw" }), ref, "alias spelling cannot change archive identity");
		assert.equal(new BlobStore(dir, { workspaceRoot, sessionId: "session-b" }).get(ref), null);
		const elsewhere = join(root, "different-workspace"); mkdirSync(elsewhere);
		assert.equal(restarted.matchesWorkspace(elsewhere), false);
		assert.equal(new BlobStore(dir, { workspaceRoot: elsewhere, sessionId: "session-a" }).get(ref), null);
	});

	test("corruption and oversized archives cannot publish or recover references", async () => {
		const { dir, blobs, ctx } = setup();
		const ref = blobs.put("untampered", { kind: "raw" });
		const file = archivePath(dir, ref);
		writeFileSync(file, "tampered");
		assert.equal(blobs.has(ref), false);
		assert.equal((await expand.execute({ ref }, ctx)).ok, false);
		assert.throws(() => blobs.put("untampered", { kind: "raw" }), /校验失败/);
		truncateSync(file, MAX_ARCHIVE_BYTES + 1);
		assert.equal(blobs.getBytes(ref), null);
	});

	test("archive-file and archive-directory symlinks cannot cross the archive boundary", () => {
		const { root, dir, blobs } = setup();
		const ref = blobs.put("original", { kind: "raw" });
		const file = archivePath(dir, ref);
		const outside = join(root, "outside");
		writeFileSync(outside, "original");
		rmSync(file);
		symlinkSync(outside, file);
		assert.equal(blobs.getBytes(ref), null);
		assert.throws(() => blobs.put("original", { kind: "raw" }));
		rmSync(file);
		const parent = dirname(file);
		rmSync(parent, { recursive: true });
		symlinkSync(root, parent, process.platform === "win32" ? "junction" : "dir");
		assert.equal(blobs.getBytes(ref), null);
	});

	test("invalid references and invalid range values fail without source-path fallback", async () => {
		const { blobs, ctx } = setup();
		const ref = blobs.put("a\nb\nc", { kind: "raw" });
		for (const args of [{ ref: "../../secret" }, { ref: "blob_0000000000000000" }, { ref, offset: 0 }, { ref, offset: "1" }, { ref, offsetBytes: -1 }, { ref, offsetBytes: 99 }, { ref, offset: 5 }, { ref, offsetBytes: 0, offset: 1 }, { ref, maxBytes: NaN }, { ref, maxBytes: 0 }, { ref, offset: Number.MAX_SAFE_INTEGER + 1 }, { ref, extra: true }]) {
			assert.equal((await expand.execute(args, ctx)).ok, false, JSON.stringify(args));
		}
		assert.equal((await expand.execute({ ref, offsetBytes: 5 }, ctx)).ok, true);
	});

	test("legacy short references require one full-name match and verified bytes", () => {
		const { root } = setup();
		const store = new BlobStore(join(root, "legacy"));
		const text = "legacy content";
		const hash = sha256(text);
		const folder = join(store.dir, hash.slice(0, 2));
		mkdirSync(folder);
		const file = join(folder, hash);
		writeFileSync(file, text);
		const ref = `blob_${hash.slice(0, 16)}`;
		assert.equal(store.get(ref), text);
		writeFileSync(join(folder, hash.slice(0, 16) + "0".repeat(48)), "ambiguous");
		assert.equal(store.get(ref), null);
		rmSync(join(folder, hash.slice(0, 16) + "0".repeat(48)));
		writeFileSync(file, "changed");
		assert.equal(store.get(ref), null);
	});

	test("raw and shown references cannot be substituted for each other", () => {
		const { blobs } = setup();
		const shown = blobs.put("identical", { kind: "shown" });
		const raw = blobs.put("identical", { kind: "raw" });
		assert.notEqual(raw, shown);
		assert.equal(blobs.has(shown, "shown"), true);
		assert.equal(blobs.has(shown, "raw"), false);
		assert.equal(blobs.has(raw, "shown"), false);
	});

	test("publication verification rejects valid refs bound to the wrong text or tool call", () => {
		const { blobs } = setup();
		const shown = blobs.put("display A");
		assert.equal(blobs.has(shown, "shown", { sha256: sha256("display A") }), true);
		assert.equal(blobs.has(shown, "shown", { sha256: sha256("display B") }), false);
		const raw = blobs.put("raw A", { kind: "raw", source: { toolCallId: "call-a" } });
		assert.equal(blobs.has(raw, "raw", { toolCallId: "call-a" }), true);
		assert.equal(blobs.has(raw, "raw", { toolCallId: "call-b" }), false);
		const unbound = blobs.put("unbound", { kind: "raw" });
		assert.equal(blobs.has(unbound, "raw", { toolCallId: "call-a" }), false);
		// Identical output can legitimately be produced by two distinct calls.
		assert.equal(blobs.put("raw A", { kind: "raw", source: { toolCallId: "call-b" } }), raw);
		assert.equal(blobs.has(raw, "raw", { toolCallId: "call-b" }), true);
	});

	test("source registration must match its filename hash and immutable content ref", () => {
		const { dir, blobs } = setup();
		const ref = blobs.put("raw", { kind: "raw", source: { toolCallId: "call-a" } });
		const sourceDir = `${archivePath(dir, ref)}.sources/${sha256("call-a")}`;
		const sourceFile = join(sourceDir, readdirSync(sourceDir)[0]!);
		const metadata = JSON.parse(readFileSync(sourceFile, "utf8"));
		writeFileSync(sourceFile, JSON.stringify({ ...metadata, source: { toolCallId: "call-b" } }));
		assert.equal(blobs.has(ref, "raw"), true);
		assert.equal(blobs.has(ref, "raw", { toolCallId: "call-a" }), false);
		// Even a self-consistent new metadata filename cannot bind another content ref.
		rmSync(sourceFile);
		const wrong = JSON.stringify({ ...metadata, ref: "other" });
		writeFileSync(join(sourceDir, `${sha256(wrong)}.json`), wrong);
		assert.equal(blobs.has(ref, "raw", { toolCallId: "call-a" }), false);
	});

	test("archive failure preserves command success but never invents a recovery ref", async () => {
		const { ctx } = setup();
		ctx.blobs!.put = () => { throw new Error("simulated disk failure"); };
		const tool = createCommandTool({ defaultTimeoutMs: process.platform === "win32" ? 15_000 : 5000, maxTimeoutMs: process.platform === "win32" ? 15_000 : 5000, headLines: 1, tailLines: 1, maxChars: 40 });
		const result = await tool.execute({ argv: [process.execPath, "-e", 'process.stdout.write("abcdef\\n".repeat(100))'] }, ctx);
		assert.equal(result.ok, true);
		assert.equal(result.fullOutputRef, undefined);
		assert.match(result.modelContent, /full output unavailable/);
		assert.doesNotMatch(result.modelContent, /fullOutputRef=/);
	});

	test("small valid command display stays compatible and multi-chunk UTF-8 decodes once", async () => {
		const { blobs, ctx } = setup();
		const result = await createCommandTool().execute({ argv: [process.execPath, "-e", 'const b=Buffer.from("中文\\r\\n");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),5)'] }, ctx);
		assert.equal(result.ok, true);
		assert.equal(result.details.invalidUtf8, false);
		assert.doesNotMatch(result.modelContent, /fullOutputRef=|original bytes|replacement/);
		assert.ok(result.modelContent.endsWith("中文\r\n"));
		assert.deepEqual(blobs.getBytes(result.fullOutputRef!), Buffer.from("中文\r\n"));
	});
});
