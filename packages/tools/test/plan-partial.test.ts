import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Check } from "typebox/schema";
import { createPlanTool, publishQueryResult } from "../src/plan.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";

const roots: string[] = [];
function setup() {
	const parent = mkdtempSync(join(tmpdir(), "mountains-plan-partial-")); roots.push(parent);
	const root = join(parent, "workspace"); mkdirSync(root);
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "plan-test", approve: async () => { throw new Error("Query must not request approval"); } };
	return { parent, root, ctx };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("the single visible dependent-plan example reads all matches in full and exposes limits", async () => {
	const { root, ctx } = setup(); mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "a.ts"), `${"// first source\n".repeat(60)}export const lastA = "TAIL_A";\n`);
	writeFileSync(join(root, "src", "b.ts"), `${"// second source\n".repeat(60)}export const lastB = "TAIL_B";\n`);
	const tool = createPlanTool({});
	const marker = " Example: ";
	assert.equal(tool.description.split(marker).length, 2);
	const plan = JSON.parse(tool.description.slice(tool.description.indexOf(marker) + marker.length));
	const result = await tool.execute(plan, ctx);
	assert.equal(result.ok, true, result.modelContent);
	assert.match(result.modelContent, /61\texport const lastA = "TAIL_A"/);
	assert.match(result.modelContent, /61\texport const lastB = "TAIL_B"/);
	assert.deepEqual(result.reads?.map(read => [read.path, read.endLine, read.totalLines]), [["src/a.ts", 61, 61], ["src/b.ts", 61, 61]]);
	const narrow = await createPlanTool({ read: { maxLines: 40 } }).execute(plan, ctx);
	assert.equal(narrow.ok, false); assert.match(narrow.modelContent, /Requested read exceeds 40 lines/);
	assert.doesNotMatch(narrow.modelContent, /TAIL_A|TAIL_B/); assert.equal(narrow.reads?.length, 0);
	const tooMany = await createPlanTool({ limits: { maxPaths: 1 } }).execute(plan, ctx);
	assert.equal(tooMany.ok, false); assert.match(tooMany.modelContent, /Glob result exceeds path limit/); assert.equal(tooMany.reads, undefined);
	const ambiguous = structuredClone(plan); ambiguous.steps[1].path.expect = "one";
	const refused = await tool.execute(ambiguous, ctx);
	assert.equal(refused.ok, false); assert.match(refused.modelContent, /Ambiguous path/); assert.equal(refused.reads?.length, 0);
});

test("only equivalent singular glob aliases are normalized and conflicts stay errors", async () => {
	const { root, ctx } = setup(); writeFileSync(join(root, "a.ts"), "source");
	const tool = createPlanTool({});
	for (const alias of ["pattern", "glob"]) {
		const result = await tool.execute({ steps: [{ id: "files", op: "glob", [alias]: "*.ts" }] }, ctx);
		assert.equal(result.ok, true, result.modelContent);
		assert.deepEqual((result.details.steps as any[])[0].paths, ["a.ts"]);
	}
	for (const step of [
		{ id: "x", op: "glob", patterns: ["*.ts"], pattern: "*.ts" },
		{ id: "x", op: "glob", pattern: "*.ts", glob: "*.ts" },
		{ id: "x", op: "glob", pattern: "*.ts", unknown: true },
		{ id: "x", op: "search", patterns: ["source"] },
		{ id: "x", op: "search", pattern: "source", exclude: ["*.ts"] },
	]) {
		const result = await tool.execute({ steps: [step] }, ctx);
		assert.equal(result.ok, false); assert.equal(result.reads, undefined);
	}
});

test("literal search.path stays rooted, preserves metacharacters and enforces workspace boundaries", async () => {
	const { root, parent, ctx } = setup(); mkdirSync(join(root, "nested")); mkdirSync(join(root, "folder"));
	writeFileSync(join(root, "a[1].ts"), "needle"); writeFileSync(join(root, "a1.ts"), "needle");
	writeFileSync(join(root, "nested", "a[1].ts"), "needle"); writeFileSync(join(root, "folder", "inside.ts"), "needle");
	writeFileSync(join(parent, "secret.ts"), "needle"); symlinkSync(join(parent, "secret.ts"), join(root, "escape.ts"));
	const tool = createPlanTool({});
	for (const [path, expected] of [["a[1].ts", ["a[1].ts"]], ["folder", ["folder/inside.ts"]]] as const) {
		const result = await tool.execute({ steps: [{ id: "find", op: "search", pattern: "needle", path }] }, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.deepEqual((result.details.steps as any[])[0].paths, expected);
	}
	for (const step of [
		{ id: "find", op: "search", pattern: "needle", path: "escape.ts" },
		{ id: "find", op: "search", pattern: "needle", path: "../secret.ts" },
		{ id: "find", op: "search", pattern: "needle", path: "missing/**/*.ts" },
		{ id: "find", op: "search", pattern: "needle", path: "folder", glob: "*.ts" },
	]) assert.equal((await tool.execute({ steps: [step] }, ctx)).ok, false);
});

test("local failures preserve independent verified reads while failed dependencies are skipped", async () => {
	const { root, ctx } = setup(); writeFileSync(join(root, "first.txt"), "FIRST_SOURCE"); writeFileSync(join(root, "last.txt"), "LAST_SOURCE");
	const result = await createPlanTool({}).execute({ steps: [
		{ id: "first", op: "read", path: "first.txt" },
		{ id: "missing", op: "read", path: "missing.txt" },
		{ id: "dependent", op: "read", path: { from: "missing", expect: "all" } },
		{ id: "last", op: "read", path: "last.txt" },
	] }, ctx);
	assert.equal(result.ok, false); assert.equal(result.details.partial, true); assert.equal(result.details.receiptsVerified, true);
	assert.match(result.modelContent, /FIRST_SOURCE/); assert.match(result.modelContent, /LAST_SOURCE/);
	assert.match(result.modelContent, /\[missing\] FAILED/); assert.match(result.modelContent, /\[dependent\] SKIPPED/);
	assert.deepEqual(result.reads?.map(read => read.path), ["first.txt", "last.txt"]);
	for (const read of result.reads!) assert.equal(ctx.files.isDelivered(read.path, read.hash, read.startLine, read.endLine), true);
});

test("a failed fan-out rolls back only that step and never suppresses a later real read", async () => {
	const { root, ctx } = setup(); writeFileSync(join(root, "a.txt"), "SAFE"); writeFileSync(join(root, "b.txt"), "TOO_LONG");
	const result = await createPlanTool({ read: { dedupe: true, dedupeRanges: true, maxLineChars: 4 } }).execute({ steps: [
		{ id: "find", op: "glob", patterns: ["*.txt"] },
		{ id: "many", op: "read", path: { from: "find", expect: "all" } },
		{ id: "again", op: "read", path: "a.txt" },
	] }, ctx);
	assert.equal(result.ok, false); assert.equal(result.details.partial, true);
	assert.equal((result.modelContent.match(/SAFE/g) ?? []).length, 1);
	assert.match(result.modelContent, /\[again\][\s\S]*1\tSAFE/); assert.doesNotMatch(result.modelContent, /already shown/);
	assert.deepEqual(result.reads?.map(read => read.path), ["a.txt"]); assert.equal(ctx.files.get("b.txt"), undefined);
});

test("empty search is explicit current evidence and does not erase another read", async () => {
	const { root, ctx } = setup(); writeFileSync(join(root, "a.txt"), "SOURCE");
	const result = await createPlanTool({}).execute({ steps: [
		{ id: "empty", op: "search", pattern: "not-present" }, { id: "read", op: "read", path: "a.txt" },
	] }, ctx);
	assert.equal(result.ok, true, result.modelContent); assert.match(result.modelContent, /0 matches/); assert.match(result.modelContent, /SOURCE/);
	assert.deepEqual((result.details.steps as any[])[0].paths, []);
	const invalid = await createPlanTool({}).execute({ steps: [{ id: "bad", op: "search", pattern: "[", glob: "*.absent" }] }, ctx);
	assert.equal(invalid.ok, false); assert.equal(invalid.details.partial, undefined);
});

test("global file/output budgets and workspace escapes discard every partial read", async () => {
	const { root, ctx } = setup(); writeFileSync(join(root, "a.txt"), "SOURCE"); writeFileSync(join(root, "b.txt"), "SECOND");
	for (const limits of [{ maxScanBytes: 8 }, { maxOutputBytes: 15 }, { maxFiles: 1 }]) {
		const result = await createPlanTool({ limits }).execute({ steps: [{ id: "a", op: "read", path: "a.txt" }, { id: "b", op: "read", path: "b.txt" }] }, ctx);
		assert.equal(result.ok, false); assert.equal(result.details.partial, undefined); assert.equal(result.reads, undefined);
		assert.doesNotMatch(result.modelContent, /SOURCE/); assert.equal(ctx.files.get("a.txt"), undefined);
	}
	const escape = await createPlanTool({}).execute({ steps: [{ id: "a", op: "read", path: "a.txt" }, { id: "b", op: "read", path: "../outside" }] }, ctx);
	assert.equal(escape.ok, false); assert.equal(escape.reads, undefined); assert.equal(ctx.files.get("a.txt"), undefined);
});

test("deferred publication marks no ranges and fabricated partial receipts cannot publish", async () => {
	const { root, ctx } = setup(); ctx.deferReadPublication = true; writeFileSync(join(root, "a.txt"), "SOURCE");
	const result = await createPlanTool({}).execute({ steps: [{ id: "a", op: "read", path: "a.txt" }, { id: "bad", op: "read", path: "missing" }] }, ctx);
	assert.equal(result.details.partial, true); assert.equal(result.reads?.length, 1);
	const read = result.reads![0]!; assert.equal(ctx.files.isDelivered(read.path, read.hash, read.startLine, read.endLine), false);
	assert.throws(() => publishQueryResult({ ok: false, modelContent: "fake", summary: "fake", details: { partial: true, receiptsVerified: true }, reads: result.reads! }, ctx), /lacks current source observations/);
	writeFileSync(join(root, "a.txt"), "CHANGED");
	assert.throws(() => publishQueryResult(result, ctx), /Source changed/);
});
