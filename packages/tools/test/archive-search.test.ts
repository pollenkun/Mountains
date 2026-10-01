import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	ARCHIVE_SEARCH_DEFAULT_OUTPUT_BYTES, ARCHIVE_SEARCH_DEFAULT_SCAN_BYTES,
	ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES, ARCHIVE_SEARCH_MAX_OUTPUT_BYTES,
	createArchiveSearchTool,
} from "../src/archive-search.ts";
import type { BoundedSearchResult, BoundedSearchSuccess } from "../src/bounded-log-search.ts";
import { createExpandTool } from "../src/recall.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";
import { BlobStore, FileStateTracker, Workspace } from "../src/workspace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
	const root = mkdtempSync(join(tmpdir(), "archive-search-"));
	roots.push(root);
	const workspaceRoot = join(root, "work");
	mkdirSync(workspaceRoot);
	const dir = join(root, "archives");
	const blobs = new BlobStore(dir, { workspaceRoot, sessionId: "session-a" });
	const abort = new AbortController();
	const ctx: ToolContext = {
		workspace: new Workspace(workspaceRoot), blobs, files: new FileStateTracker(), signal: abort.signal,
		toolCallId: "search-call", approve: async () => { throw new Error("Read-only search must not request approval"); },
	};
	return { root, dir, workspaceRoot, blobs, abort, ctx };
}

function source(toolCallId = "command-a", patch: Record<string, unknown> = {}) {
	return { tool: "command_run", toolCallId, exitCode: 0, timedOut: false, cancelled: false, signal: null, ...patch };
}

function put(blobs: BlobStore, bytes: string | Buffer, toolCallId = "command-a", patch: Record<string, unknown> = {}) {
	return blobs.put(bytes, { kind: "raw", source: source(toolCallId, patch) });
}

function countReads(blobs: BlobStore) {
	const original = blobs.inspectCommand.bind(blobs);
	const calls: { ref: string; toolCallId: string; maxArchiveBytes: number }[] = [];
	blobs.inspectCommand = (ref, toolCallId, options) => {
		calls.push({ ref, toolCallId, maxArchiveBytes: options.maxArchiveBytes });
		return original(ref, toolCallId, options);
	};
	return calls;
}

function parsed(result: ToolResult, limit = ARCHIVE_SEARCH_DEFAULT_OUTPUT_BYTES): BoundedSearchResult {
	assert.ok(Buffer.byteLength(result.modelContent, "utf8") <= limit);
	const value = JSON.parse(result.modelContent) as BoundedSearchResult;
	assert.equal(result.ok, value.ok);
	assert.equal(result.details.outputBytes, Buffer.byteLength(result.modelContent, "utf8"));
	return value;
}

function success(result: ToolResult, limit = ARCHIVE_SEARCH_DEFAULT_OUTPUT_BYTES): BoundedSearchSuccess {
	const value = parsed(result, limit);
	assert.ok(value.ok, result.modelContent);
	return value;
}

const tool = createArchiveSearchTool();

test("read-only tool accepts only archive lookup/query fields", () => {
	assert.equal(tool.name, "context_search");
	assert.equal(tool.logicalName, "context.search");
	assert.equal(tool.readOnly, true);
	assert.deepEqual(Object.keys(tool.parameters.properties as object), ["ref", "toolCallId", "needle", "caseMode", "maxScanBytes", "maxMatches", "maxLineBytes", "maxOutputBytes"]);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(tool.parameters.required, ["ref", "toolCallId", "needle"]);
});

test("real archive lookup binds a command and matches byte-for-byte context_expand recovery", async () => {
	const { blobs, ctx } = setup();
	const bytes = Buffer.from("\ufeff准备\r\n前缀🙂target 中文\r\n后续\n");
	const ref = put(blobs, bytes);
	const calls = countReads(blobs);
	const result = success(await tool.execute({ ref, toolCallId: "command-a", needle: "target" }, ctx));
	assert.deepEqual(calls, [{ ref, toolCallId: "command-a", maxArchiveBytes: ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES }]);
	assert.equal(result.source.verifiedBytes, bytes.length);
	assert.equal(result.search.scannedBytes, bytes.length);
	assert.equal(result.command.toolCallId, "command-a");
	assert.equal(result.command.processStatus, "exited-zero");
	assert.equal(result.command.captureComplete, null);
	assert.equal(result.command.suiteStatus, "not_evaluated");
	const hit = result.matches[0]!;
	assert.equal(hit.line, 2);
	const page = await createExpandTool().execute({ ref, offsetBytes: hit.snippet.byteStart, maxBytes: hit.snippet.byteEnd - hit.snippet.byteStart }, ctx);
	assert.ok(page.ok, page.modelContent);
	const body = page.modelContent.slice(page.modelContent.indexOf("\n") + 1);
	assert.deepEqual(Buffer.from(body), Buffer.from(hit.snippet.text, hit.snippet.encoding));
	assert.deepEqual(Buffer.from(hit.snippet.text, hit.snippet.encoding), bytes.subarray(hit.snippet.byteStart, hit.snippet.byteEnd));
});

test("same content/ref returns only the requested invocation state and refuses a wrong call", async () => {
	const { blobs, ctx } = setup();
	const text = "target passed\nother suite FAILED\n";
	const ref = put(blobs, text, "command-zero");
	assert.equal(put(blobs, text, "command-failed", { exitCode: 7 }), ref);
	const zero = success(await tool.execute({ ref, toolCallId: "command-zero", needle: "target" }, ctx));
	const failed = success(await tool.execute({ ref, toolCallId: "command-failed", needle: "target" }, ctx));
	assert.equal(zero.command.processStatus, "exited-zero");
	assert.equal(failed.command.processStatus, "exited-nonzero");
	assert.equal(failed.command.exitCode, 7);
	assert.equal(failed.command.suiteStatus, "not_evaluated");
	assert.deepEqual(parsed(await tool.execute({ ref, toolCallId: "wrong-call", needle: "target" }, ctx)), { ok: false, error: "ARCHIVE_UNAVAILABLE" });
});

test("invalid model arguments and forbidden host metadata are rejected before inspectCommand", async () => {
	const { blobs, ctx } = setup();
	const ref = put(blobs, "target\n");
	const calls = countReads(blobs);
	const valid = { ref, toolCallId: "command-a", needle: "target" };
	const patches: Record<string, unknown>[] = [
		{ needle: "" }, { needle: /target/ }, { needle: "a\nb" }, { needle: "a\rb" }, { needle: "\ud800" },
		{ needle: "中".repeat(1366) }, { needle: "x".repeat(4097) }, { needle: "x".repeat(1025) },
		{ ref: "" }, { ref: " leading" }, { ref: 3 }, { toolCallId: "" }, { toolCallId: false },
		{ caseMode: "regex" }, { caseMode: null }, { maxScanBytes: -1 }, { maxScanBytes: Infinity }, { maxScanBytes: ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES + 1 },
		{ maxMatches: 0 }, { maxMatches: 101 }, { maxMatches: 1.5 }, { maxLineBytes: 4097 }, { maxLineBytes: 5 },
		{ maxOutputBytes: 63 }, { maxOutputBytes: 12001 }, { maxOutputBytes: NaN }, { maxOutputBytes: "8192" },
		{ path: "secret.txt" }, { commandState: source() }, { authorized: true }, { expectedSha256: "x" }, { maxArchiveBytes: Infinity },
	];
	for (const patch of patches) {
		const result = parsed(await tool.execute({ ...valid, ...patch }, ctx));
		assert.equal(result.ok, false, JSON.stringify(patch));
	}
	assert.equal(calls.length, 0);
	assert.ok((await tool.execute({ ...valid, needle: "x".repeat(4096), maxLineBytes: 4096 }, ctx)).ok);
	assert.equal(calls.length, 1);
});

test("abort before or during archive inspection never publishes matches", async () => {
	const first = setup();
	const ref = put(first.blobs, "target\n");
	const calls = countReads(first.blobs);
	first.abort.abort();
	assert.deepEqual(parsed(await tool.execute({ ref, toolCallId: "command-a", needle: "target" }, first.ctx)), { ok: false, error: "CANCELLED" });
	assert.equal(calls.length, 0);
	const second = setup();
	const otherRef = put(second.blobs, "target\n");
	const original = second.blobs.inspectCommand.bind(second.blobs);
	second.blobs.inspectCommand = (...args) => { const result = original(...args); second.abort.abort(); return result; };
	assert.deepEqual(parsed(await tool.execute({ ref: otherRef, toolCallId: "command-a", needle: "target" }, second.ctx)), { ok: false, error: "CANCELLED" });
});

test("workspace mismatch is refused before inspect and history stays host-controlled", async () => {
	const { root, dir, workspaceRoot, blobs, ctx } = setup();
	const ref = put(blobs, "target\n");
	const calls = countReads(blobs);
	const otherWorkspace = join(root, "elsewhere");
	mkdirSync(otherWorkspace);
	const args = { ref, toolCallId: "command-a", needle: "target" };
	assert.equal((await tool.execute(args, { ...ctx, workspace: new Workspace(otherWorkspace) })).ok, false);
	assert.equal(calls.length, 0);
	const next = new BlobStore(dir, { workspaceRoot, sessionId: "session-b" });
	assert.equal((await tool.execute(args, { ...ctx, blobs: next })).ok, false);
	const history = new BlobStore(dir, { workspaceRoot, sessionId: "session-c", allowWorkspaceHistory: true });
	assert.ok((await tool.execute(args, { ...ctx, blobs: history })).ok);
	const elsewhere = new BlobStore(dir, { workspaceRoot: otherWorkspace, sessionId: "session-a", allowWorkspaceHistory: true });
	assert.equal((await tool.execute(args, { ...ctx, workspace: new Workspace(otherWorkspace), blobs: elsewhere })).ok, false);
	const differentRoot = new BlobStore(join(root, "different-archive"), { workspaceRoot, sessionId: "session-a", allowWorkspaceHistory: true });
	assert.equal((await tool.execute(args, { ...ctx, blobs: differentRoot })).ok, false);
});

test("shown/file archives and unavailable/corrupt host responses share a short non-disclosing error", async () => {
	const { blobs, ctx } = setup();
	const shown = blobs.put("target", { kind: "shown", source: source() });
	const file = blobs.put("target", { kind: "raw", source: { tool: "file_read", toolCallId: "file-call" } });
	for (const [ref, toolCallId] of [[shown, "command-a"], [file, "file-call"], ["../../private/secret.txt", "command-a"]]) {
		assert.deepEqual(parsed(await tool.execute({ ref, toolCallId, needle: "target", maxOutputBytes: 64 }, ctx), 64), { ok: false, error: "ARCHIVE_UNAVAILABLE" });
	}
	blobs.inspectCommand = () => { throw new Error("/private/secret.txt must never leak"); };
	const failed = await tool.execute({ ref: shown, toolCallId: "command-a", needle: "target", maxOutputBytes: 64 }, ctx);
	assert.deepEqual(parsed(failed, 64), { ok: false, error: "ARCHIVE_UNAVAILABLE" });
	assert.ok(!JSON.stringify(failed).includes("/private"));
});

test("prefix scan and full archive validation remain distinct, with fixed host read ceiling", async () => {
	const { blobs, ctx } = setup();
	const text = "x".repeat(ARCHIVE_SEARCH_DEFAULT_SCAN_BYTES + 2) + "\ntarget\n";
	const ref = put(blobs, text);
	const limited = success(await tool.execute({ ref, toolCallId: "command-a", needle: "target" }, ctx));
	assert.equal(limited.source.verifiedBytes, Buffer.byteLength(text));
	assert.equal(limited.search.scannedBytes, ARCHIVE_SEARCH_DEFAULT_SCAN_BYTES);
	assert.equal(limited.search.matchPresence, "unknown");
	assert.equal(limited.resultsComplete, false);
	assert.ok(limited.limits.includes("scan-bytes"));
	const full = success(await tool.execute({ ref, toolCallId: "command-a", needle: "target", maxScanBytes: ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES }, ctx));
	assert.equal(full.search.matchPresence, "found");
	const large = put(blobs, Buffer.alloc(ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES + 1, 120), "too-large");
	assert.deepEqual(parsed(await tool.execute({ ref: large, toolCallId: "too-large", needle: "x" }, ctx)), { ok: false, error: "ARCHIVE_UNAVAILABLE" });
});

test("complete JSON caps include escaping/base64 and mark omitted matches or long previews", async () => {
	const { blobs, ctx } = setup();
	const bytes = Buffer.concat(Array.from({ length: 100 }, () => Buffer.concat([Buffer.from("target \"\\" + "a".repeat(2000)), Buffer.from([255, 10])])));
	const ref = put(blobs, bytes);
	for (const maxOutputBytes of [64, 1024, 8192, ARCHIVE_SEARCH_MAX_OUTPUT_BYTES]) {
		const result = parsed(await tool.execute({ ref, toolCallId: "command-a", needle: "target", maxOutputBytes, maxMatches: 100, maxLineBytes: 4096 }, ctx), maxOutputBytes);
		if (result.ok) {
			assert.equal(result.source.utf8, false);
			assert.ok(result.limits.includes("output-bytes"));
			for (const match of result.matches) {
				assert.equal(match.snippet.encoding, "base64");
				assert.deepEqual(Buffer.from(match.snippet.text, "base64"), bytes.subarray(match.snippet.byteStart, match.snippet.byteEnd));
			}
		}
	}
	const longRef = put(blobs, "a".repeat(30_000) + "target" + "🙂".repeat(300), "long");
	const long = success(await tool.execute({ ref: longRef, toolCallId: "long", needle: "target", maxLineBytes: 40 }, ctx));
	assert.equal(long.matches[0]!.match.byteStart, 30_000);
	assert.equal(long.snippetsComplete, false);
	assert.ok(long.matches[0]!.snippet.text.includes("target"));
});

test("host status preserves unknown fields, explicit absent signal, and abnormal termination", async () => {
	const { blobs, ctx } = setup();
	const states: [Record<string, unknown>, string, boolean][] = [
		[{ tool: "command_run", toolCallId: "legacy", exitCode: 0, timedOut: false }, "unknown", false],
		[source("zero"), "exited-zero", true],
		[source("cancelled", { cancelled: true }), "cancelled", true],
		[source("timeout", { timedOut: true }), "timed-out", true],
		[source("signal", { signal: "SIGTERM" }), "terminated-by-signal", true],
	];
	for (const [commandState, expected, signalKnown] of states) {
		const ref = blobs.put("target passed\n", { kind: "raw", source: commandState });
		const result = success(await tool.execute({ ref, toolCallId: commandState.toolCallId, needle: "target" }, ctx));
		assert.equal(result.command.processStatus, expected);
		assert.equal(result.command.signalKnown, signalKnown);
		assert.equal(result.command.suiteStatus, "not_evaluated");
	}
});
