import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SessionArchiveIndex, SESSION_SEARCH_LIMITS, type SessionRecordMetadata, type SessionSearchSuccess } from "../src/session-index.ts";
import { createSessionSearchTool } from "../src/session-search.ts";
import { createExpandTool } from "../src/recall.ts";
import { BlobStore, FileStateTracker, Workspace } from "../src/workspace.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "session-search-")); roots.push(root);
	const work = join(root, "work"); mkdirSync(work);
	const blobs = new BlobStore(join(root, "archive"), { workspaceRoot: work, sessionId: "current", allowWorkspaceHistory: true });
	const index = new SessionArchiveIndex(blobs), abort = new AbortController();
	const ctx: ToolContext = { workspace: new Workspace(work), blobs, files: new FileStateTracker(), signal: abort.signal, toolCallId: "search", approve: async () => { throw new Error("must not approve"); } };
	return { root, work, blobs, index, abort, ctx, tool: createSessionSearchTool(index) };
}
function success(result: ToolResult, cap: number = SESSION_SEARCH_LIMITS.defaultOutputBytes): SessionSearchSuccess {
	assert.ok(result.ok, result.modelContent);
	assert.ok(Buffer.byteLength(result.modelContent) <= cap);
	assert.equal(result.details.outputBytes, Buffer.byteLength(result.modelContent));
	return JSON.parse(result.modelContent);
}
function error(result: ToolResult, code: string) { assert.equal(result.ok, false); assert.deepEqual(JSON.parse(result.modelContent), { ok: false, error: code }); }
function archivePath(root: string, ref: string): string {
	const [, , workspace, session, kind, hash] = ref.split("_");
	return join(root, workspace!, session!, kind!, hash!.slice(0, 2), hash!);
}

test("user correction, source code and tool results are recoverable with separate message identities", async () => {
	const f = fixture();
	const correction = "我纠正一下：不要上传，结果只留在本机。";
	const correctionRef = f.index.record(correction, { role: "user" });
	f.index.record("export function save() { return '本机'; }", { role: "tool", toolCallId: "read-1", name: "file_read", target: "src/save.ts" });
	const duplicate = f.index.record(correction, { role: "assistant" });
	assert.equal(correctionRef, duplicate);
	const found = success(await f.tool.execute({ needle: "本机" }, f.ctx));
	assert.equal(found.complete, true);
	assert.deepEqual(found.matches.map((m) => [m.ordinal, m.role]), [[1, "user"], [2, "tool"], [3, "assistant"]]);
	assert.equal(found.matches[1]!.toolCallId, "read-1");
	assert.equal(found.matches[1]!.target, "src/save.ts");
	for (const hit of found.matches) {
		assert.equal(hit.text.includes("\ufffd"), false);
		const expanded = await createExpandTool().execute({ ref: hit.ref, offsetBytes: hit.byteStart, maxBytes: hit.byteEnd - hit.byteStart }, f.ctx);
		assert.ok(expanded.ok);
		assert.equal(expanded.modelContent.slice(expanded.modelContent.indexOf("\n") + 1), hit.text);
	}
});

test("search does not discover workspace secrets, unregistered archives or old session content", async () => {
	const f = fixture();
	writeFileSync(join(f.work, "credentials.txt"), "secret-needle should never appear");
	const hiddenRef = f.blobs.put("secret-needle unregistered");
	const old = new BlobStore(f.blobs.dir, { workspaceRoot: f.work, sessionId: "old" });
	const oldRef = old.put("secret-needle old session");
	f.index.record("visible hello", { role: "user" });
	const original = f.blobs.inspect.bind(f.blobs), calls: string[] = [];
	f.blobs.inspect = (ref) => { calls.push(ref); return original(ref); };
	const result = success(await f.tool.execute({ needle: "secret-needle" }, f.ctx));
	assert.deepEqual(result.matches, []);
	assert.deepEqual(calls, []);
	for (const ref of [hiddenRef, oldRef]) error(await f.tool.execute({ ref }, f.ctx), "REF_NOT_IN_SESSION");
	assert.deepEqual(calls, []);
	assert.equal(readFileSync(join(f.work, "credentials.txt"), "utf8"), "secret-needle should never appear");
	assert.deepEqual(readdirSync(f.work), ["credentials.txt"]);
	const empty = createSessionSearchTool(new SessionArchiveIndex(f.blobs));
	assert.deepEqual(success(await empty.execute({ needle: "visible" }, f.ctx)).matches, []);
});

test("workspace and BlobStore identity must match before any archive read", async () => {
	const f = fixture(); f.index.record("needle", { role: "user" });
	f.blobs.inspect = () => { throw new Error("must not read"); };
	const elsewhere = join(f.root, "elsewhere"); mkdirSync(elsewhere);
	error(await f.tool.execute({ needle: "needle" }, { ...f.ctx, workspace: new Workspace(elsewhere) }), "SESSION_UNAVAILABLE");
	const otherStore = new BlobStore(f.blobs.dir, { workspaceRoot: f.work, sessionId: "current" });
	error(await f.tool.execute({ needle: "needle" }, { ...f.ctx, blobs: otherStore }), "SESSION_UNAVAILABLE");
});

test("record rejects hidden fields, invalid UTF-8, raw refs, wrong contents and foreign session refs", () => {
	const f = fixture();
	assert.throws(() => f.index.record("thought", { role: "analysis" } as unknown as SessionRecordMetadata), /INVALID_SESSION_RECORD/);
	assert.throws(() => f.index.record("thought", { role: "assistant", reasoning: "hidden" } as unknown as SessionRecordMetadata), /INVALID_SESSION_RECORD/);
	assert.throws(() => f.index.record("\ud800", { role: "user" }), /INVALID_SESSION_RECORD/);
	const raw = f.blobs.put("visible", { kind: "raw" });
	assert.throws(() => f.index.record("visible", { role: "tool", ref: raw }), /INVALID_SESSION_REF/);
	const shown = f.blobs.put("visible");
	assert.throws(() => f.index.record("different", { role: "user", ref: shown }), /SESSION_REF_MISMATCH/);
	const old = new BlobStore(f.blobs.dir, { workspaceRoot: f.work, sessionId: "old" });
	assert.throws(() => f.index.record("visible", { role: "user", ref: old.put("visible") }), /SESSION_REF_MISMATCH/);
	assert.equal(f.index.record("visible", { role: "user", ref: shown }), shown);
});

test("failed readback is never indexed and tampered archives never publish cached matches", async () => {
	const f = fixture(); const inspect = f.blobs.inspect.bind(f.blobs);
	f.blobs.inspect = () => null;
	assert.throws(() => f.index.record("needle failed readback", { role: "tool" }), /SESSION_ARCHIVE_UNAVAILABLE/);
	f.blobs.inspect = inspect;
	assert.deepEqual(success(await f.tool.execute({ needle: "needle" }, f.ctx)).matches, []);
	const ref = f.index.record("needle original", { role: "tool" });
	writeFileSync(archivePath(f.blobs.dir, ref), "needle malicious edit");
	const result = success(await f.tool.execute({ needle: "needle" }, f.ctx));
	assert.deepEqual(result.matches, []);
	assert.equal(result.unavailableRecords, 1);
	assert.equal(result.complete, false);
	assert.ok(result.limits.includes("archive-unavailable"));
});

test("cursor binds query, snapshot and index; pages neither repeat nor miss messages", async () => {
	const f = fixture();
	for (let i = 0; i < 6; i++) f.index.record(`needle ${i}`, { role: "user" });
	const first = success(await f.tool.execute({ needle: "needle", maxMatches: 2 }, f.ctx));
	assert.ok(first.nextCursor); assert.deepEqual(first.matches.map((m) => m.ordinal), [1, 2]);
	f.index.record("needle added later", { role: "user" });
	const second = success(await f.tool.execute({ needle: "needle", maxMatches: 2, cursor: first.nextCursor }, f.ctx));
	const last = success(await f.tool.execute({ needle: "needle", cursor: second.nextCursor }, f.ctx));
	assert.deepEqual([...second.matches, ...last.matches].map((m) => m.ordinal), [3, 4, 5, 6]);
	assert.equal(last.complete, true);
	assert.equal(success(await f.tool.execute({ needle: "needle" }, f.ctx)).matches.length, 7);
	error(await f.tool.execute({ needle: "different", cursor: first.nextCursor }, f.ctx), "INVALID_CURSOR");
	error(await f.tool.execute({ needle: "needle", cursor: `${first.nextCursor}x` }, f.ctx), "INVALID_CURSOR");
	error(await createSessionSearchTool(new SessionArchiveIndex(f.blobs)).execute({ needle: "needle", cursor: first.nextCursor }, f.ctx), "INVALID_CURSOR");
});

test("bounded scanning finds a UTF-8 literal spanning pages and preserves UTF-8 snippet bytes", async () => {
	const f = fixture();
	const text = "🙂".repeat(9) + "中文needle中文" + "🙂".repeat(50);
	const ref = f.index.record(text, { role: "tool" });
	let cursor: string | undefined, found: SessionSearchSuccess | undefined;
	for (let i = 0; i < 20; i++) {
		const page = success(await f.tool.execute({ needle: "中文needle", maxScanBytes: 15, maxSnippetBytes: 21, ...(cursor ? { cursor } : {}) }, f.ctx));
		assert.ok(page.scannedBytes <= 15);
		if (page.matches.length) { found = page; break; }
		assert.ok(page.nextCursor); cursor = page.nextCursor;
	}
	assert.ok(found); const hit = found.matches[0]!;
	assert.equal(hit.ref, ref); assert.ok(hit.text.includes("中文needle")); assert.ok(hit.truncated);
	assert.equal(hit.text.includes("\ufffd"), false);
	assert.deepEqual(Buffer.from(hit.text), Buffer.from(text).subarray(hit.byteStart, hit.byteEnd));
});

test("output accounting includes JSON escaping, metadata and nextCursor; output pages make progress", async () => {
	const f = fixture();
	for (let i = 0; i < 10; i++) f.index.record(`needle ${i} ` + "\"\\\n中".repeat(100), { role: "tool", toolCallId: `call-${i}` });
	let cursor: string | undefined; const ordinals: number[] = [];
	for (let i = 0; i < 20; i++) {
		const page = success(await f.tool.execute({ needle: "needle", maxSnippetBytes: 100, maxOutputBytes: 1024, ...(cursor ? { cursor } : {}) }, f.ctx), 1024);
		assert.ok(page.matches.length);
		ordinals.push(...page.matches.map((m) => m.ordinal));
		if (!page.nextCursor) break;
		assert.ok(page.limits.length); cursor = page.nextCursor;
	}
	assert.deepEqual(ordinals, Array.from({ length: 10 }, (_, i) => i + 1));
});

test("ref-only paging recovers long UTF-8 bodies without gaps", async () => {
	const f = fixture(); const text = "🙂中文abc".repeat(30), ref = f.index.record(text, { role: "assistant" });
	let cursor: string | undefined, recovered = "";
	for (let i = 0; i < 30; i++) {
		const page = success(await f.tool.execute({ ref, maxMatches: 2, maxSnippetBytes: 23, ...(cursor ? { cursor } : {}) }, f.ctx));
		recovered += page.matches.map((m) => m.text).join("");
		if (!page.nextCursor) break; cursor = page.nextCursor;
	}
	assert.equal(recovered, text);
});

test("invalid arguments and cancellation never leak paths or read archives", async () => {
	const f = fixture(); const ref = f.index.record("needle", { role: "tool" });
	let reads = 0; const inspect = f.blobs.inspect.bind(f.blobs);
	f.blobs.inspect = (ref) => { reads++; return inspect(ref); };
	for (const args of [{}, { needle: "" }, { needle: "\ud800" }, { ref, maxScanBytes: 1 }, { needle: "x", path: "/private/secret" }, { needle: "x", maxMatches: 0 }, { needle: "x", maxScanBytes: Infinity }, { needle: "x", maxOutputBytes: 1023 }]) assert.equal((await f.tool.execute(args, f.ctx)).ok, false);
	assert.equal(reads, 0);
	f.abort.abort(); error(await f.tool.execute({ needle: "needle" }, f.ctx), "CANCELLED"); assert.equal(reads, 0);
	const other = fixture(); other.index.record("needle", { role: "user" }); const original = other.blobs.inspect.bind(other.blobs);
	other.blobs.inspect = (ref) => { const result = original(ref); other.abort.abort(); return result; };
	error(await other.tool.execute({ needle: "needle" }, other.ctx), "CANCELLED");
});
