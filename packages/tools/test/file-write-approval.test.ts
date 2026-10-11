import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { generalTools } from "../src/index.ts";
import type { ApprovalRequest, ToolContext } from "../src/types.ts";
import { FileStateTracker, sha256, Workspace } from "../src/workspace.ts";

const quotedFilename = process.platform === "win32" ? "a 'file'.txt" : 'a "file".txt';
const cases = [
	{ name: "single edit", tool: "file_edit", original: "alpha\r\nbeta\r\ngamma\r\n", args: { oldText: "alpha\nbeta", newText: "甲\n乙" }, after: "甲\r\n乙\r\ngamma\r\n" },
	{ name: "batch edit", tool: "file_edit", original: "alpha\r\nbeta\r\ngamma\r\n", args: { edits: [{ oldText: "alpha", newText: "甲" }, { oldText: "gamma", newText: "丙" }] }, after: "甲\r\nbeta\r\n丙\r\n" },
	{ name: "create", tool: "file_write", original: null, args: { content: "甲\n" }, after: "甲\n" },
	{ name: "overwrite", tool: "file_write", original: "alpha\nbeta\n", args: { content: "甲\n", createOnly: false, expectedHash: sha256("alpha\nbeta\n") }, after: "甲\n" },
] satisfies { name: string; tool: string; original: string | null; args: Record<string, unknown>; after: string }[];

function fixture(t: TestContext, scenario: typeof cases[number], enabled?: boolean) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mountains-file-approval-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const rel = `目录/${quotedFilename}`;
	const path = join(root, rel);
	if (scenario.original !== null) { mkdirSync(dirname(path)); writeFileSync(path, scenario.original); }
	const controller = new AbortController();
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal, toolCallId: `call-${scenario.name}`, approve: async () => "allow" };
	if (scenario.original !== null) ctx.files.record(rel, sha256(scenario.original));
	const tools = generalTools({ batchEdit: true, ...(enabled === undefined ? {} : { approveFileWrites: enabled }) });
	const tool = tools.find((tool) => tool.name === scenario.tool)!;
	const args = { path: rel, ...scenario.args };
	const unchanged = () => {
		if (scenario.original === null) { assert.equal(existsSync(path), false); assert.equal(existsSync(dirname(path)), false, "no directory may be created before approval"); }
		else assert.equal(readFileSync(path, "utf8"), scenario.original);
	};
	return { root, rel, path, ctx, controller, tool, args, unchanged };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

for (const scenario of cases) {
	test(`${scenario.name}: omitted and false approval option preserve automatic writes`, async (t) => {
		for (const enabled of [undefined, false]) {
			const f = fixture(t, scenario, enabled);
			f.ctx.approve = async () => { assert.fail("default file tools must not request approval"); };
			const result = await f.tool.execute(f.args, f.ctx);
			assert.equal(result.ok, true, result.modelContent);
			assert.equal(readFileSync(f.path, "utf8"), scenario.after);
		}
	});

	test(`${scenario.name}: full original parameters and summary are approved before the checkpoint and write`, async (t) => {
		const f = fixture(t, scenario, true);
		const entered = deferred<ApprovalRequest>();
		const decision = deferred<"allow">();
		const order: string[] = [];
		f.ctx.approve = async (request) => { order.push("approval"); entered.resolve(request); return decision.promise; };
		f.ctx.beforeWrite = async (path) => { order.push("checkpoint"); assert.equal(path, f.path); f.unchanged(); };
		const running = f.tool.execute(f.args, f.ctx);
		const request = await entered.promise;
		f.unchanged();
		assert.deepEqual(order, ["approval"]);
		assert.equal(request.toolCallId, f.ctx.toolCallId);
		assert.equal(request.risk, "workspace-write");
		assert.equal(request.cwd, ".");
		assert.equal(request.command, `${scenario.tool} ${JSON.stringify(f.args, null, 2)}`);
		assert.deepEqual(JSON.parse(request.command.slice(scenario.tool.length + 1)), f.args, "CRLF normalization cannot change the displayed original arguments");
		assert.ok(request.explanation.includes(f.rel));
		assert.match(request.explanation, /行/);
		if (scenario.name === "batch edit") assert.match(request.explanation, /2 处替换/);
		if (scenario.name === "overwrite") assert.match(request.explanation, /原 2 行，新 1 行/);
		decision.resolve("allow");
		const result = await running;
		assert.equal(result.ok, true, result.modelContent);
		assert.deepEqual(order, ["approval", "checkpoint"]);
		assert.equal(readFileSync(f.path, "utf8"), scenario.after);
		assert.equal(result.writes?.length, 1);
	});

	test(`${scenario.name}: denial leaves bytes and checkpoint untouched`, async (t) => {
		const f = fixture(t, scenario, true);
		let approvals = 0;
		f.ctx.approve = async () => { approvals++; return "deny"; };
		f.ctx.beforeWrite = async () => { assert.fail("denied action must not enter the checkpoint"); };
		const result = await f.tool.execute(f.args, f.ctx);
		assert.equal(result.ok, false);
		assert.equal(result.details.approved, false);
		assert.equal(result.writes, undefined);
		assert.equal(approvals, 1);
		f.unchanged();
	});

	test(`${scenario.name}: cancellation during approval cannot write after a late allow`, async (t) => {
		const f = fixture(t, scenario, true);
		const entered = deferred<void>();
		const decision = deferred<"allow">();
		f.ctx.approve = async () => { entered.resolve(); return decision.promise; };
		f.ctx.beforeWrite = async () => { assert.fail("cancelled action must not enter the checkpoint"); };
		const running = f.tool.execute(f.args, f.ctx);
		await entered.promise;
		f.unchanged();
		f.controller.abort();
		decision.resolve("allow");
		const result = await running;
		assert.equal(result.ok, false);
		assert.equal(result.details.cancelled, true);
		assert.equal(result.writes, undefined);
		f.unchanged();
	});

	test(`${scenario.name}: already-cancelled action does not ask or write`, async (t) => {
		const f = fixture(t, scenario, true);
		f.ctx.approve = async () => { assert.fail("already-cancelled writes must not request approval"); };
		f.ctx.beforeWrite = async () => { assert.fail("already-cancelled writes must not checkpoint"); };
		f.controller.abort();
		const result = await f.tool.execute(f.args, f.ctx);
		assert.equal(result.ok, false);
		assert.equal(result.details.cancelled, true);
		f.unchanged();
	});

	test(`${scenario.name}: cancellation or checkpoint failure after allow preserves bytes`, async (t) => {
		for (const failure of ["cancel", "throw"]) {
			const f = fixture(t, scenario, true);
			f.ctx.beforeWrite = async () => { if (failure === "cancel") f.controller.abort(); else throw new Error("checkpoint failed"); };
			const result = await f.tool.execute(f.args, f.ctx);
			assert.equal(result.ok, false);
			if (failure === "cancel") assert.equal(result.details.cancelled, true);
			else assert.match(result.modelContent, /checkpoint failed/);
			f.unchanged();
		}
	});

	test(`${scenario.name}: a file changed during approval or checkpoint is preserved`, async (t) => {
		for (const stage of ["approval", "checkpoint"]) {
			const f = fixture(t, scenario, true);
			const change = () => { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, "manual edit during wait\n"); };
			f.ctx.approve = async () => { if (stage === "approval") change(); return "allow"; };
			f.ctx.beforeWrite = async () => { if (stage === "checkpoint") change(); };
			const result = await f.tool.execute(f.args, f.ctx);
			assert.equal(result.ok, false, stage);
			assert.equal(result.writes, undefined);
			assert.equal(readFileSync(f.path, "utf8"), "manual edit during wait\n");
			assert.ok(!readdirSync(dirname(f.path)).some((name) => name.endsWith(".tmp")));
		}
	});
}

test("invalid writes fail validation before requesting approval", async (t) => {
	for (const scenario of cases) {
		const f = fixture(t, scenario, true);
		f.ctx.approve = async () => { assert.fail("invalid write must not request approval"); };
		f.ctx.beforeWrite = async () => { assert.fail("invalid write must not checkpoint"); };
		const args = scenario.tool === "file_edit" ? { ...f.args, expectedHash: "00000000" } : { ...f.args, content: 42 };
		assert.equal((await f.tool.execute(args, f.ctx)).ok, false);
		f.unchanged();
	}
});

test("file_write rechecks the parent directory after approval and checkpoint", async (t) => {
	for (const scenario of cases.filter((scenario) => scenario.tool === "file_write")) {
		const f = fixture(t, scenario, true);
		const outside = mkdtempSync(join(tmpdir(), "mountains-file-approval-outside-"));
		t.after(() => rmSync(outside, { recursive: true, force: true }));
		if (!existsSync(dirname(f.path))) mkdirSync(dirname(f.path));
		writeFileSync(join(outside, quotedFilename), "outside must stay unchanged\n");
		f.ctx.beforeWrite = async () => { renameSync(dirname(f.path), join(f.root, "saved")); symlinkSync(outside, dirname(f.path), process.platform === "win32" ? "junction" : "dir"); };
		const result = await f.tool.execute(f.args, f.ctx);
		assert.equal(result.ok, false);
		assert.equal(readFileSync(join(outside, quotedFilename), "utf8"), "outside must stay unchanged\n");
		if (scenario.original !== null) assert.equal(readFileSync(join(f.root, "saved", quotedFilename), "utf8"), scenario.original);
	}
});

test("approval display preserves long file content without truncation", async (t) => {
	const f = fixture(t, cases[2]!, true);
	const content = `头\n${"long-content-".repeat(1000)}\n尾\n`;
	f.ctx.approve = async (request) => { assert.equal(JSON.parse(request.command.slice("file_write ".length)).content, content); return "deny"; };
	assert.equal((await f.tool.execute({ ...f.args, content }, f.ctx)).ok, false);
	f.unchanged();
});
