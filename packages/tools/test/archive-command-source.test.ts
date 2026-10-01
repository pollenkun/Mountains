import assert from "node:assert/strict";
import fs, { appendFileSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { BlobStore, MAX_ARCHIVE_BYTES, sha256, type CommandArchiveState } from "../src/workspace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
	const root = mkdtempSync(join(tmpdir(), "archive-command-source-"));
	roots.push(root);
	const workspaceRoot = join(root, "work");
	mkdirSync(workspaceRoot);
	const dir = join(root, "archive");
	const store = new BlobStore(dir, { workspaceRoot, sessionId: "session-a" });
	return { root, workspaceRoot, dir, store };
}
const cap = { maxArchiveBytes: 8 * 1024 * 1024 };
function raw(store: BlobStore, text = "same output\n", source: Record<string, unknown> = {}) {
	return store.put(text, { kind: "raw", source: { tool: "command_run", toolCallId: "call-a", ...source } });
}
function payloadPath(dir: string, ref: string) {
	const m = /^blob_v2_([0-9a-f]{64})_([0-9a-f]{32})_(raw|shown)_([0-9a-f]{64})$/.exec(ref);
	assert.ok(m);
	return join(dir, m[1]!, m[2]!, m[3]!, m[4]!.slice(0, 2), m[4]!);
}
function sources(dir: string, ref: string, id = "call-a") { return `${payloadPath(dir, ref)}.sources/${sha256(id)}`; }
function firstSource(dir: string, ref: string) {
	const folder = sources(dir, ref);
	return { folder, path: join(folder, readdirSync(folder)[0]!) };
}
function addRecord(folder: string, value: unknown) {
	const json = JSON.stringify(value);
	writeFileSync(join(folder, `${sha256(json)}.json`), json);
}

/** Count real readSync bytes on the payload inode, including a second whole-file pass. */
function observeReads(t: TestContext, payload: string, action: () => void) {
	const identity = statSync(payload);
	const original = fs.readSync;
	const reads = { calls: 0, payloadCalls: 0, payloadBytes: 0 };
	const mocked = t.mock.method(fs, "readSync", (fd: number, ...args: unknown[]) => {
		const file = fstatSync(fd);
		const n = Reflect.apply(original, fs, [fd, ...args]) as number;
		reads.calls++;
		if (file.dev === identity.dev && file.ino === identity.ino) { reads.payloadCalls++; reads.payloadBytes += n; }
		return n;
	});
	syncBuiltinESMExports();
	try { action(); }
	finally { mocked.mock.restore(); syncBuiltinESMExports(); }
	return reads;
}

test("command inspection returns only this invocation's facts and reads payload once", (t) => {
	const { store, dir } = setup();
	const bytes = Buffer.from("\ufeff中文\r\n".repeat(20_000));
	const state: CommandArchiveState = { toolCallId: "call-a", exitCode: 0, timedOut: false, cancelled: false, signal: null };
	const ref = raw(store, bytes.toString("utf8"), { ...state, cwd: ".", commandPreview: "do not expose source", commandSha256: "a".repeat(64) });
	const reads = observeReads(t, payloadPath(dir, ref), () => {
		const found = store.inspectCommand(ref, "call-a", cap);
		assert.ok(found);
		assert.deepEqual(found.bytes, bytes);
		assert.equal(found.hash, sha256(bytes));
		assert.equal(found.totalBytes, bytes.length);
		assert.equal(found.kind, "raw");
		assert.equal(found.invalidUtf8, false);
		assert.deepEqual(found.commandState, state);
		assert.equal(Object.hasOwn(found.commandState, "captureComplete"), false);
	});
	assert.equal(reads.payloadBytes, bytes.length, "no second has/inspect payload pass");
	assert.ok(reads.payloadCalls > 1, "real chunked reads, not a mocked store response");
});

test("identical content binds independently to two calls with different exits", () => {
	const { store } = setup();
	const ref = raw(store, "same", { exitCode: 0, timedOut: false, cancelled: false, signal: null });
	assert.equal(raw(store, "same", { toolCallId: "call-b", exitCode: 9, timedOut: false, cancelled: false, signal: "SIGTERM" }), ref);
	assert.equal(store.inspectCommand(ref, "call-a", cap)?.commandState.exitCode, 0);
	assert.equal(store.inspectCommand(ref, "call-b", cap)?.commandState.exitCode, 9);
	assert.equal(store.inspectCommand(ref, "call-b", cap)?.commandState.signal, "SIGTERM");
	assert.equal(store.inspectCommand(ref, "missing-call", cap), null);
});

test("scope denies other sessions, workspaces and roots before reading the payload", (t) => {
	const { store, dir, workspaceRoot, root } = setup();
	const ref = raw(store);
	const next = new BlobStore(dir, { workspaceRoot, sessionId: "session-b" });
	const historical = new BlobStore(dir, { workspaceRoot, sessionId: "session-c", allowWorkspaceHistory: true });
	const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
	const otherWorkspace = new BlobStore(dir, { workspaceRoot: elsewhere, sessionId: "session-a", allowWorkspaceHistory: true });
	const otherRoot = new BlobStore(join(root, "another-archive"), { workspaceRoot, sessionId: "session-a", allowWorkspaceHistory: true });
	const reads = observeReads(t, payloadPath(dir, ref), () => {
		for (const denied of [next, otherWorkspace, otherRoot]) assert.equal(denied.inspectCommand(ref, "call-a", cap), null);
	});
	assert.equal(reads.calls, 0);
	assert.ok(historical.inspectCommand(ref, "call-a", cap));
});

test("shown, file-read and unbound sources cannot supply command state", (t) => {
	const { store, dir } = setup();
	const shown = store.put("shown", { kind: "shown", source: { tool: "command_run", toolCallId: "call-a" } });
	const file = raw(store, "file data", { tool: "file_read" });
	const unbound = store.put("unbound", { kind: "raw" });
	for (const ref of [shown, file, unbound]) {
		const reads = observeReads(t, payloadPath(dir, ref), () => assert.equal(store.inspectCommand(ref, "call-a", cap), null));
		assert.equal(reads.payloadBytes, 0);
	}
});

test("missing fields stay missing while explicit null and false are preserved", () => {
	const { store } = setup();
	const missing = raw(store, "old record", { exitCode: 0, signal: undefined });
	assert.deepEqual(store.inspectCommand(missing, "call-a", cap)?.commandState, { toolCallId: "call-a", exitCode: 0 });
	const explicit = raw(store, "new record", { exitCode: null, signal: null, timedOut: false, cancelled: null, captureComplete: null });
	assert.deepEqual(store.inspectCommand(explicit, "call-a", cap)?.commandState, { toolCallId: "call-a", exitCode: null, signal: null, timedOut: false, cancelled: null, captureComplete: null });
});

test("invalid state types fail closed before payload reads", (t) => {
	const { store, dir } = setup();
	const badStates = [
		{ exitCode: "0" }, { exitCode: -1 }, { exitCode: 0.5 }, { exitCode: 0x80000000 },
		{ timedOut: 0 }, { cancelled: "false" }, { captureComplete: {} },
		{ signal: false }, { signal: "" }, { signal: "x".repeat(65) },
	];
	for (const [index, state] of badStates.entries()) {
		const ref = raw(store, `invalid-${index}`, state);
		const reads = observeReads(t, payloadPath(dir, ref), () => assert.equal(store.inspectCommand(ref, "call-a", cap), null));
		assert.equal(reads.payloadBytes, 0);
	}
});

test("contradictory qualified sources cannot choose the first successful record", (t) => {
	const { store, dir } = setup();
	const ref = raw(store, "same", { exitCode: 0, signal: null });
	raw(store, "same", { exitCode: 7, signal: null });
	const reads = observeReads(t, payloadPath(dir, ref), () => assert.equal(store.inspectCommand(ref, "call-a", cap), null));
	assert.equal(reads.payloadBytes, 0);
	assert.ok(store.inspect(ref), "legacy byte recovery is independent of ambiguous execution facts");
});

test("conflicting provenance and missing versus known states also fail closed", () => {
	const { store } = setup();
	const ref = raw(store, "same", { commandSha256: "a".repeat(64) });
	raw(store, "same", { commandSha256: "b".repeat(64) });
	assert.equal(store.inspectCommand(ref, "call-a", cap), null);
	const old = raw(store, "old and new", {});
	raw(store, "old and new", { signal: null });
	assert.equal(store.inspectCommand(old, "call-a", cap), null);
});

test("256 equivalent sources are accepted but a 257th cannot hide beyond the cap", (t) => {
	const { store, dir } = setup();
	const ref = raw(store);
	const { folder, path } = firstSource(dir, ref);
	const value = JSON.parse(readFileSync(path, "utf8"));
	// Different outer whitespace yields distinct hash-named records with equal source facts.
	for (let i = 1; i < 256; i++) {
		const json = JSON.stringify(value) + " ".repeat(i);
		writeFileSync(join(folder, `${sha256(json)}.json`), json);
	}
	assert.equal(readdirSync(folder).length, 256);
	assert.ok(store.inspectCommand(ref, "call-a", cap));
	const extra = JSON.stringify(value) + " ".repeat(256);
	writeFileSync(join(folder, `${sha256(extra)}.json`), extra);
	const reads = observeReads(t, payloadPath(dir, ref), () => assert.equal(store.inspectCommand(ref, "call-a", cap), null));
	assert.equal(reads.payloadBytes, 0);
});

test("damaged, misbound and overlarge source records are rejected", () => {
	const { store, dir } = setup();
	for (const mode of ["filename-hash", "wrong-ref", "wrong-bytes", "wrong-call", "oversized"]) {
		const ref = raw(store, mode);
		const { folder, path } = firstSource(dir, ref);
		const record = JSON.parse(readFileSync(path, "utf8"));
		if (mode === "filename-hash") writeFileSync(path, "{}");
		else {
			rmSync(path);
			if (mode === "wrong-ref") record.ref = "other";
			if (mode === "wrong-bytes") record.bytes++;
			if (mode === "wrong-call") record.source.toolCallId = "call-b";
			if (mode === "oversized") record.source.padding = "x".repeat(8193);
			addRecord(folder, record);
		}
		assert.equal(store.inspectCommand(ref, "call-a", cap), null, mode);
	}
});

test("host lower limit and invalid limits reject before any read; old APIs still recover", (t) => {
	const { store, dir } = setup();
	const ref = raw(store, "bounded content");
	const payload = payloadPath(dir, ref);
	const reads = observeReads(t, payload, () => {
		for (const limit of [0, 1, 14, -1, 1.5, Number.NaN, Infinity, MAX_ARCHIVE_BYTES + 1]) {
			assert.equal(store.inspectCommand(ref, "call-a", { maxArchiveBytes: limit }), null);
		}
	});
	assert.equal(reads.calls, 0, "size/limits checked before metadata or payload reads");
	assert.ok(store.inspectCommand(ref, "call-a", { maxArchiveBytes: 15 }));
	assert.equal(store.inspect(ref)?.bytes.toString(), "bounded content");
	assert.equal(store.get(ref), "bounded content");
	assert.equal(store.has(ref, "raw", { toolCallId: "call-a" }), true);
	const empty = raw(store, "");
	assert.equal(store.inspectCommand(empty, "call-a", { maxArchiveBytes: 0 })?.totalBytes, 0);
});

test("payload corruption and payload/source symlinks fail closed", () => {
	const { store, dir, root } = setup();
	const corrupt = raw(store, "original");
	writeFileSync(payloadPath(dir, corrupt), "tampered");
	assert.equal(store.inspectCommand(corrupt, "call-a", cap), null);
	const outside = join(root, "outside"); writeFileSync(outside, "outside");
	const linked = raw(store, "outside");
	rmSync(payloadPath(dir, linked)); symlinkSync(outside, payloadPath(dir, linked));
	assert.equal(store.inspectCommand(linked, "call-a", cap), null);
	const sourceLinked = raw(store, "source-link");
	const { path } = firstSource(dir, sourceLinked);
	const copied = join(root, "copied-source.json"); writeFileSync(copied, readFileSync(path));
	rmSync(path); symlinkSync(copied, path);
	assert.equal(store.inspectCommand(sourceLinked, "call-a", cap), null);
	const folderLinked = raw(store, "folder-link");
	const folder = sources(dir, folderLinked);
	rmSync(folder, { recursive: true }); symlinkSync(root, folder);
	assert.equal(store.inspectCommand(folderLinked, "call-a", cap), null);
});

test("a payload growing after preflight cannot make reads exceed the host limit", (t) => {
	const { store, dir } = setup();
	const ref = raw(store, "small");
	const path = payloadPath(dir, ref);
	const identity = statSync(path);
	const original = fs.readSync;
	let actualBytes = 0;
	let grew = false;
	const mocked = t.mock.method(fs, "readSync", (fd: number, ...args: unknown[]) => {
		const stat = fstatSync(fd);
		const payload = stat.dev === identity.dev && stat.ino === identity.ino;
		if (payload && !grew) { appendFileSync(path, Buffer.alloc(64 * 1024)); grew = true; }
		const n = Reflect.apply(original, fs, [fd, ...args]) as number;
		if (payload) actualBytes += n;
		return n;
	});
	syncBuiltinESMExports();
	try { assert.equal(store.inspectCommand(ref, "call-a", { maxArchiveBytes: 5 }), null); }
	finally { mocked.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(grew, true);
	assert.equal(actualBytes, 5);
});

test("binary command archives retain original bytes and legacy missing facts", () => {
	const { store } = setup();
	const bytes = Buffer.from([0x81, 0x40, 0x0d, 0x0a]);
	const ref = store.put(bytes, { kind: "raw", source: { tool: "command_run", toolCallId: "call-a" } });
	const found = store.inspectCommand(ref, "call-a", cap);
	assert.ok(found);
	assert.equal(found.invalidUtf8, true);
	assert.deepEqual(found.bytes, bytes);
	assert.deepEqual(found.commandState, { toolCallId: "call-a" });
});
