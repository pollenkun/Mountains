import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEditTool, createReadTool } from "../src/files.ts";
import type { ApprovalRequest, ToolContext, ToolResult } from "../src/types.ts";
import { FileStateTracker, sha256, Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, original: string, approved: boolean, batch = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mountains-many-edits-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const rel = "many.txt", path = join(root, rel);
	writeFileSync(path, original); chmodSync(path, 0o640);
	const originalMode = statSync(path).mode & 0o777;
	const controller = new AbortController();
	const approvals: ApprovalRequest[] = [];
	const ctx: ToolContext = {
		workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal, toolCallId: "many-replacements",
		approve: async request => { assert.equal(approved, true, "default edits must not ask"); approvals.push(request); return "allow"; },
	};
	const read = await createReadTool().execute({ path: rel }, ctx);
	assert.equal(read.ok, true, read.modelContent);
	assert.equal(ctx.files.get(rel), sha256(original), "the actual read tool must bind the edit to the original bytes");
	const tool = createEditTool({ ...(batch ? { batch: true } : {}), ...(approved ? { approveFileWrites: true } : {}) });
	return { root, rel, path, originalMode, controller, approvals, ctx, tool };
}

function successfulBytes(f: Awaited<ReturnType<typeof fixture>>, result: ToolResult, original: string, expected: string) {
	assert.equal(result.ok, true, result.modelContent);
	const bytes = readFileSync(f.path);
	assert.deepEqual(bytes, Buffer.from(expected, "utf8"));
	assert.equal(result.details.beforeHash, sha256(original));
	assert.equal(result.details.afterHash, sha256(bytes));
	assert.deepEqual(result.writes, [{ path: f.rel, beforeHash: sha256(original), afterHash: sha256(bytes) }]);
	assert.equal(f.ctx.files.get(f.rel), sha256(bytes));
	assert.equal(statSync(f.path).mode & 0o777, f.originalMode);
	assert.equal(readdirSync(f.root).some(name => name.endsWith(".tmp")), false);
}

for (const approved of [false, true]) {
	const route = approved ? "manual approval" : "default automatic edit";
	test(`${route}: many replacements preserve gaps, tail, return metadata and final execution check`, async t => {
		const count = 20_000;
		const original = `头😀\n${"a|".repeat(count)}\n尾`;
		const f = await fixture(t, original, approved);
		const args = { path: f.rel, oldText: "a", newText: "乙😀", expectedMatches: count };
		const order: string[] = [];
		f.ctx.beforeWrite = async () => { order.push("checkpoint"); assert.deepEqual(readFileSync(f.path), Buffer.from(original)); };
		f.ctx.assertExecutionAllowed = () => { order.push("execution"); assert.deepEqual(readFileSync(f.path), Buffer.from(original)); };
		const result = await f.tool.execute(args, f.ctx);
		const expected = `头😀\n${"乙😀|".repeat(count)}\n尾`;
		successfulBytes(f, result, original, expected);
		assert.deepEqual(order, ["checkpoint", "execution"]);
		assert.equal(result.summary, `修改 many.txt（第 2 行附近，-${count} +${count} 行）`);
		assert.equal(result.modelContent, `edited many.txt: ${count} replacement(s) at line 2; new sha256:${sha256(expected).slice(0, 12)}`);
		assert.deepEqual(result.details, { path: f.rel, line: 2, replacements: count, beforeHash: sha256(original), afterHash: sha256(expected), oldText: "a", newText: "乙😀" });
		assert.equal(f.approvals.length, approved ? 1 : 0);
		if (approved) assert.equal(f.approvals[0]?.command, `file_edit ${JSON.stringify(args, null, 2)}`);
	});

	test(`${route}: adjacent batch edits are sorted and matched against the original, never earlier replacements`, async t => {
		const count = 4_000;
		const original = `首${"abcd".repeat(count)}尾`;
		const f = await fixture(t, original, approved, true);
		const edits = [{ oldText: "cd", newText: "ab", expectedMatches: count }, { oldText: "ab", newText: "cd😀", expectedMatches: count }];
		const args = { path: f.rel, edits };
		const result = await f.tool.execute(args, f.ctx);
		successfulBytes(f, result, original, `首${"cd😀ab".repeat(count)}尾`);
		assert.equal(result.details.replacements, count * 2);
		assert.deepEqual(result.details.edits, edits);
		assert.equal(f.approvals.length, approved ? 1 : 0);
	});

	test(`${route}: multiline replacements keep CRLF and approval still shows unnormalized parameters`, async t => {
		const count = 2_000;
		const original = `首\r\n${"a\r\nb\r\n".repeat(count)}尾`;
		const f = await fixture(t, original, approved);
		const args = { path: f.rel, oldText: "a\nb", newText: "甲\n乙", expectedMatches: count };
		const result = await f.tool.execute(args, f.ctx);
		successfulBytes(f, result, original, `首\r\n${"甲\r\n乙\r\n".repeat(count)}尾`);
		assert.equal(result.details.oldText, "a\r\nb");
		assert.equal(result.details.newText, "甲\r\n乙");
		assert.deepEqual(args, { path: f.rel, oldText: "a\nb", newText: "甲\n乙", expectedMatches: count });
		if (approved) assert.equal(f.approvals[0]?.command, `file_edit ${JSON.stringify(args, null, 2)}`);
	});

	test(`${route}: a surrogate pair can cross a retained gap and replacement before UTF-8 encoding`, async t => {
		const count = 4_000;
		const original = "😀".repeat(count);
		const f = await fixture(t, original, approved);
		const result = await f.tool.execute({ path: f.rel, oldText: "\ude00", newText: "\ude01", expectedMatches: count }, f.ctx);
		successfulBytes(f, result, original, "😁".repeat(count));
	});

	test(`${route}: splitting emoji leaves canonical UTF-8 bytes and every returned hash describes those bytes`, async t => {
		const count = 4_000;
		const original = "😀".repeat(count);
		const f = await fixture(t, original, approved);
		const result = await f.tool.execute({ path: f.rel, oldText: "\ud83d", newText: "X", expectedMatches: count }, f.ctx);
		successfulBytes(f, result, original, "X\ufffd".repeat(count));
		assert.equal(result.details.newText, "X");
		assert.equal(result.details.oldText, "\ud83d");
	});

	test(`${route}: many matches cannot bypass stale hashes, counts, or overlapping batch validation`, async t => {
		const count = 8_000;
		const original = "aa|".repeat(count);
		const f = await fixture(t, original, approved, true);
		f.ctx.approve = async () => { assert.fail("invalid edits must not reach approval"); };
		f.ctx.beforeWrite = async () => { assert.fail("invalid edits must not reach checkpoint"); };
		for (const args of [
			{ oldText: "a", newText: "b", expectedMatches: count * 2 - 1 },
			{ oldText: "a", newText: "b", expectedMatches: count * 2, expectedHash: "00000000" },
			{ edits: [{ oldText: "aa", newText: "b", expectedMatches: count }, { oldText: "a", newText: "c", expectedMatches: count * 2 }] },
		]) {
			const result = await f.tool.execute({ path: f.rel, ...args }, f.ctx);
			assert.equal(result.ok, false);
			assert.equal(result.writes, undefined);
			assert.deepEqual(readFileSync(f.path), Buffer.from(original));
		}
	});

	test(`${route}: cancellation, external edits and final revocation preserve actual bytes`, async t => {
		for (const failure of ["cancel", "external-change", "revoke"] as const) {
			const count = 8_000, original = "a|".repeat(count);
			const f = await fixture(t, original, approved);
			const manual = Buffer.from("用户手动修改\r\n😀\r\n");
			let executionChecks = 0;
			f.ctx.beforeWrite = async () => {
				if (failure === "cancel") f.controller.abort();
				if (failure === "external-change") writeFileSync(f.path, manual);
			};
			f.ctx.assertExecutionAllowed = () => { executionChecks++; if (failure === "revoke") throw new Error("execution authorization revoked"); };
			const result = await f.tool.execute({ path: f.rel, oldText: "a", newText: "b", expectedMatches: count }, f.ctx);
			assert.equal(result.ok, false, failure);
			assert.equal(result.writes, undefined);
			assert.deepEqual(readFileSync(f.path), failure === "external-change" ? manual : Buffer.from(original));
			assert.equal(readdirSync(f.root).some(name => name.endsWith(".tmp")), false);
			if (failure === "revoke") { assert.equal(executionChecks, 1); assert.match(result.modelContent, /execution authorization revoked/); }
		}
	});
}

test("Manual denial, late cancellation and file changes during approval never overwrite original or manual bytes", async t => {
	for (const decision of ["deny", "cancel", "external-change"] as const) {
		const count = 8_000, original = "a|".repeat(count);
		const f = await fixture(t, original, true);
		const manual = Buffer.from("等待批准时的手动改动\r\n");
		f.ctx.approve = async () => {
			if (decision === "cancel") f.controller.abort();
			if (decision === "external-change") writeFileSync(f.path, manual);
			return decision === "deny" ? "deny" : "allow";
		};
		f.ctx.beforeWrite = async () => { if (decision !== "external-change") assert.fail("denied or cancelled edits must not checkpoint"); };
		const result = await f.tool.execute({ path: f.rel, oldText: "a", newText: "b", expectedMatches: count }, f.ctx);
		assert.equal(result.ok, false);
		assert.equal(result.writes, undefined);
		assert.deepEqual(readFileSync(f.path), decision === "external-change" ? manual : Buffer.from(original));
	}
});

test("a bounded subprocess edits 1.5 MB with 1.5 million replacements instead of repeatedly copying the whole file", { timeout: 30_000 }, t => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mountains-many-edits-perf-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const count = 1_500_000, path = join(root, "many.txt");
	writeFileSync(path, "a".repeat(count));
	const filesUrl = new URL("../src/files.ts", import.meta.url).href;
	const workspaceUrl = new URL("../src/workspace.ts", import.meta.url).href;
	const script = `
		import assert from "node:assert/strict";
		import { readFileSync } from "node:fs";
		import { createEditTool, createReadTool } from ${JSON.stringify(filesUrl)};
		import { Workspace, FileStateTracker, sha256 } from ${JSON.stringify(workspaceUrl)};
		const ctx = { workspace: new Workspace(${JSON.stringify(root)}), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "bounded-many-edits", approve: async () => assert.fail("default edit asked for approval") };
		const read = await createReadTool().execute({ path: "many.txt" }, ctx);
		assert.equal(read.ok, true);
		const result = await createEditTool().execute({ path: "many.txt", oldText: "a", newText: "b", expectedMatches: ${count} }, ctx);
		assert.equal(result.ok, true, result.modelContent);
		const expected = Buffer.from("b".repeat(${count}));
		assert.deepEqual(readFileSync(${JSON.stringify(path)}), expected);
		assert.equal(result.details.afterHash, sha256(expected));
		process.stdout.write("many replacements committed correctly");
	`;
	const child = spawnSync(process.execPath, ["--max-old-space-size=512", "--input-type=module", "-e", script], { timeout: 15_000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 16 * 1024 });
	assert.equal(child.error, undefined, `bounded edit failed: ${child.error?.message}; ${child.stderr}`);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout, "many replacements committed correctly");
});
