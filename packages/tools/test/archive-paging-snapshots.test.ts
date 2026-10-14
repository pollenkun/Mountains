import assert from "node:assert/strict";
import fs, { fstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { createExpandTool } from "../src/recall.ts";
import type { ToolContext } from "../src/types.ts";
import { ARCHIVE_SNAPSHOT_LIMITS, BlobStore, FileStateTracker, VerifiedBlobSnapshot, Workspace, sha256 } from "../src/workspace.ts";

function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "archive-snapshots-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const work = join(root, "work"); mkdirSync(work);
	const dir = join(root, "archive");
	const blobs = new BlobStore(dir, { workspaceRoot: work, sessionId: "a" });
	const ctx: ToolContext = { workspace: new Workspace(work), blobs, files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: t.name, approve: async () => "allow" };
	return { root, work, dir, blobs, ctx, expand: createExpandTool() };
}
function path(dir: string, ref: string) {
	const [, , work, session, kind, hash] = ref.split("_");
	return join(dir, work!, session!, kind!, hash!.slice(0, 2), hash!);
}
const body = (message: string) => message.slice(message.indexOf("\n") + 1);

test("explicit paging snapshots read each payload once and never expose mutable backing bytes", async t => {
	const { dir, blobs, ctx, expand } = setup(t);
	const bytes = Buffer.from("\ufeffabc😀中文\r\n".repeat(10_000));
	const ref = blobs.put(bytes, { kind: "raw" });
	const identity = statSync(path(dir, ref));
	let payloadReads = 0;
	const original = fs.readSync;
	const mock = t.mock.method(fs, "readSync", (fd: number, ...args: unknown[]) => {
		const current = fstatSync(fd);
		const result = Reflect.apply(original, fs, [fd, ...args]) as number;
		if (current.dev === identity.dev && current.ino === identity.ino) payloadReads += result;
		return result;
	});
	syncBuiltinESMExports();
	try {
		const first = await expand.execute({ ref, offsetBytes: 0, maxBytes: 4096 }, ctx);
		assert.equal(first.ok, true);
		assert.equal(payloadReads, bytes.length);
		const snapshot = first.details.snapshot;
		assert.equal(typeof snapshot, "string");
		const results = [Buffer.from(body(first.modelContent))];
		let offset = first.details.nextOffsetBytes;
		while (offset !== undefined) {
			const next = await expand.execute({ ref, snapshot, offsetBytes: offset, maxBytes: 4096 }, ctx);
			assert.equal(next.ok, true, next.modelContent);
			results.push(Buffer.from(body(next.modelContent)));
			offset = next.details.nextOffsetBytes;
		}
		assert.deepEqual(Buffer.concat(results), bytes);
		assert.equal(payloadReads, bytes.length, "all continuation pages use the verified immutable view");
		const direct = blobs.pagingSnapshot(ref, snapshot as string)!;
		direct.view.read(0, 100).fill(0);
		assert.deepEqual(direct.view.read(0, 100), bytes.subarray(0, 100));
	} finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("snapshot semantics preserve verified bytes while no-handle calls still reject later disk corruption", async t => {
	const { dir, blobs, ctx, expand } = setup(t);
	const ref = blobs.put("original bytes", { kind: "raw" });
	const first = await expand.execute({ ref, maxBytes: 4 }, ctx);
	writeFileSync(path(dir, ref), "tampered bytes");
	const next = await expand.execute({ ref, snapshot: first.details.snapshot, offsetBytes: 4 }, ctx);
	assert.equal(next.ok, true);
	assert.equal(body(next.modelContent), "inal bytes");
	assert.equal(next.details.snapshotSemantics, "verified-immutable-view");
	assert.equal(blobs.has(ref), false);
	assert.equal(blobs.inspect(ref), null);
	assert.equal((await expand.execute({ ref }, ctx)).ok, false);
	assert.throws(() => blobs.put("original bytes", { kind: "raw" }), /校验失败/);
});

test("handles cannot cross refs, raw/shown views, sessions, stores, workspaces or restart", async t => {
	const { root, work, dir, blobs, ctx, expand } = setup(t);
	const ref = blobs.put("same bytes", { kind: "raw" });
	const snapshot = (await expand.execute({ ref }, ctx)).details.snapshot as string;
	const otherRef = blobs.put("other bytes", { kind: "raw" });
	const shown = blobs.put("same bytes", { kind: "shown" });
	for (const different of [otherRef, shown]) assert.equal((await expand.execute({ ref: different, snapshot }, ctx)).ok, false);
	for (const store of [new BlobStore(dir, { workspaceRoot: work, sessionId: "a" }), new BlobStore(dir, { workspaceRoot: work, sessionId: "b", allowWorkspaceHistory: true }), new BlobStore(join(root, "other-archive"), { workspaceRoot: work, sessionId: "a" })]) {
		assert.equal(store.pagingSnapshot(ref, snapshot), null);
	}
	const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
	assert.equal((await expand.execute({ ref, snapshot }, { ...ctx, workspace: new Workspace(elsewhere) })).ok, false);
	for (const invalid of [snapshot + "x", "page_v1_" + "0".repeat(32), "", 5, {}]) assert.equal((await expand.execute({ ref, snapshot: invalid }, ctx)).ok, false);
});

test("fixed lifetime and LRU entry eviction fail explicitly and can reopen only by revalidating", t => {
	const { dir, blobs } = setup(t);
	const now = performance.now();
	let clock = now;
	t.mock.method(performance, "now", () => clock);
	const refs = Array.from({ length: ARCHIVE_SNAPSHOT_LIMITS.maxEntries + 1 }, (_, i) => blobs.put(`view-${i}`, { kind: "raw" }));
	const first = blobs.pagingSnapshot(refs[0]!)!;
	const second = blobs.pagingSnapshot(refs[1]!)!;
	for (const ref of refs.slice(2, -1)) assert.ok(blobs.pagingSnapshot(ref));
	assert.ok(blobs.pagingSnapshot(refs[0]!, first.handle), "access makes the first entry recent");
	assert.ok(blobs.pagingSnapshot(refs.at(-1)!));
	assert.equal(blobs.pagingSnapshot(refs[1]!, second.handle), null, "least recently used view was evicted");
	clock += ARCHIVE_SNAPSHOT_LIMITS.ttlMs - 1;
	assert.ok(blobs.pagingSnapshot(refs[0]!, first.handle));
	clock++;
	assert.equal(blobs.pagingSnapshot(refs[0]!, first.handle), null, "reads never extend lifetime");
	writeFileSync(path(dir, refs[0]!), "broken");
	assert.equal(blobs.pagingSnapshot(refs[0]!), null, "expiry cannot bypass current corruption");
	assert.ok(blobs.pagingSnapshot(refs[1]!), "an intact evicted archive can be reverified");
});

test("sparse line index matches a byte-scan oracle across chunk boundaries and newline densities", () => {
	const variants = [Buffer.alloc(0), Buffer.alloc(131073, 97), Buffer.alloc(131073, 10), Buffer.from(("😀\r\na\n中文b" + "x".repeat(83)).repeat(2200))];
	for (const bytes of variants) {
		const view = new VerifiedBlobSnapshot({ kind: "raw", hash: sha256(bytes), bytes, totalBytes: bytes.length, invalidUtf8: false });
		const starts = [0];
		for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
		assert.equal(view.totalLines, starts.length);
		for (const offset of [0, 1, 65535, 65536, 65537, 131071, 131072, bytes.length].filter(v => v <= bytes.length)) {
			assert.equal(view.lineAt(offset), starts.filter(start => start <= offset).length);
		}
		for (let line = 1; line <= starts.length; line += Math.max(1, Math.floor(starts.length / 37))) assert.equal(view.lineStart(line), starts[line - 1]);
		assert.equal(view.lineStart(starts.length), starts.at(-1));
		assert.equal(view.lineStart(starts.length + 1), undefined);
		bytes.fill(0);
		assert.notDeepEqual(view.read(0, view.totalBytes), bytes.length ? bytes : Buffer.from([0]), "constructor takes an owned copy");
	}
});

test("line paging, UTF-8 boundaries and binary base64 are identical with explicit views", async t => {
	const { blobs, ctx, expand } = setup(t);
	for (const bytes of [Buffer.from("\ufeff😀\r\n中文\n".repeat(2000)), Buffer.from([0x81, 0x40, 0x0d, 0x0a])]) {
		const ref = blobs.put(bytes, { kind: "raw" });
		const first = await expand.execute({ ref, offsetBytes: 0, maxBytes: 7 }, ctx);
		assert.equal(first.ok, true);
		const args = bytes[0] === 0x81 ? { offsetBytes: 1, maxBytes: 3 } : { offset: 1800, limit: 20 };
		const legacy = await expand.execute({ ref, ...args }, ctx);
		const snap = await expand.execute({ ref, snapshot: first.details.snapshot, ...args }, ctx);
		assert.equal(snap.ok, legacy.ok);
		assert.equal(body(snap.modelContent), body(legacy.modelContent));
		for (const key of ["offsetBytes", "endBytes", "totalBytes", "totalLines", "offset", "end", "encoding"]) assert.equal(snap.details[key], legacy.details[key], key);
	}
});

test("retained byte budget evicts large snapshots before the entry-count ceiling", t => {
	const { blobs } = setup(t);
	const refA = blobs.put(Buffer.alloc(48 * 1024 * 1024, 97), { kind: "raw" });
	const refB = blobs.put(Buffer.alloc(48 * 1024 * 1024, 98), { kind: "raw" });
	const refC = blobs.put(Buffer.alloc(48 * 1024 * 1024, 99), { kind: "raw" });
	const a = blobs.pagingSnapshot(refA)!;
	const b = blobs.pagingSnapshot(refB)!;
	const c = blobs.pagingSnapshot(refC)!;
	assert.equal(blobs.pagingSnapshot(refA, a.handle), null);
	assert.ok(blobs.pagingSnapshot(refB, b.handle));
	assert.ok(blobs.pagingSnapshot(refC, c.handle));
	assert.ok(b.view.retainedBytes + c.view.retainedBytes <= ARCHIVE_SNAPSHOT_LIMITS.maxBytes);
});

test("pages requested without a snapshot handle reuse the verified view, so a long archive is read once", async t => {
	const { dir, blobs, ctx, expand } = setup(t);
	const bytes = Buffer.from("line of archived output\n".repeat(180_000));
	const ref = blobs.put(bytes, { kind: "raw" });
	const identity = statSync(path(dir, ref));
	let payloadReads = 0;
	const original = fs.readSync;
	const mock = t.mock.method(fs, "readSync", (fd: number, ...args: unknown[]) => {
		const current = fstatSync(fd);
		const result = Reflect.apply(original, fs, [fd, ...args]) as number;
		if (current.dev === identity.dev && current.ino === identity.ino) payloadReads += result;
		return result;
	});
	syncBuiltinESMExports();
	try {
		const pages: Buffer[] = [];
		let offset: unknown = 0;
		while (offset !== undefined) {
			const page = await expand.execute({ ref, offsetBytes: offset, maxBytes: 12_000 }, ctx);
			assert.equal(page.ok, true, page.modelContent);
			pages.push(Buffer.from(body(page.modelContent)));
			offset = page.details.nextOffsetBytes;
		}
		assert.ok(pages.length > 300);
		assert.deepEqual(Buffer.concat(pages), bytes);
		assert.equal(payloadReads, bytes.length, "the archive is verified once, not once per page");
	} finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
