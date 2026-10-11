import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPlanTool, type PlanOptions } from "../src/plan.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";
import { FileStateTracker, Workspace, sha256 } from "../src/workspace.ts";

type Match = { path: string; line: number; col: number; text: string; hash: string };
type SearchStep = { id: string; op: string; paths: string[]; results: Match[] };

function setup(t: TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "mountains-plan-bulk-"));
	const root = join(parent, "workspace"); mkdirSync(root);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const context = (): ToolContext => ({ workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal,
		toolCallId: "bulk-test", approve: async () => { throw new Error("Queries cannot request approval"); } });
	return { parent, root, context };
}

function searchStep(result: ToolResult): SearchStep {
	return (result.details.steps as SearchStep[]).find(step => step.op === "search")!;
}

function globallyStopped(result: ToolResult, ctx: ToolContext, path = "proof.txt") {
	assert.equal(result.ok, false, result.modelContent);
	assert.equal(result.details.status, "stopped", result.modelContent);
	assert.equal(result.details.partial, undefined);
	assert.equal(result.reads, undefined);
	assert.doesNotMatch(result.modelContent, /EARLIER_SOURCE_RECEIPT/);
	assert.equal(ctx.files.get(path), undefined);
}

// The wrapper only touches the synthetic fixture. All actual matching still uses rg.
function withRg(t: TestContext, parent: string, beforeSearch = "", afterSearch = "", everyCall = "") {
	const wrapper = join(parent, "rg-wrapper.cjs");
	writeFileSync(wrapper, `#!${process.execPath}\nconst fs = require('node:fs'); const cp = require('node:child_process');
const args = process.argv.slice(2); const searching = args.includes('--json');
${everyCall}
if (searching) { ${beforeSearch} }
const result = cp.spawnSync('rg', args, { input: fs.readFileSync(0), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
if (searching) { ${afterSearch} }
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 2);
`, { mode: 0o700 });
	const previous = process.env.MOUNTAINS_RG;
	process.env.MOUNTAINS_RG = wrapper;
	t.after(() => { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; });
}

test("bulk preserves legacy text, line/column addresses, raw hashes and canonical Unicode path order", async t => {
	const { root, context } = setup(t);
	const sources = new Map<string, string>([
		["ascii.txt", "needle\nNO match\nNeedle 中文needle\n"],
		["bom-crlf.txt", "\ufeffneedle\r\n中文needle\r\n"],
		["-dash.txt", "needle without final newline"],
		["space newline\nname.txt", "emoji😀needle\n"],
		["\ue000.txt", "needle bmp\n"],
		["𐀀.txt", "needle supplementary\n"],
	]);
	for (const [path, source] of sources) writeFileSync(join(root, path), source);
	for (const [pattern, caseSensitive] of [["needle", true], ["^needle", true], ["Needle", true], ["needle$", true], ["中文", true], ["😀", true], ["^", true], ["NEEDLE", false]] as const) {
		const args = { steps: [{ id: "find", op: "search", pattern, glob: "*.txt", caseSensitive }] };
		const legacy = await createPlanTool().execute(args, context());
		const bulk = await createPlanTool({}).execute(args, context());
		assert.equal(legacy.ok, true, legacy.modelContent); assert.equal(bulk.ok, true, bulk.modelContent);
		assert.equal(bulk.modelContent, legacy.modelContent, `pattern=${pattern}`);
		assert.deepEqual(searchStep(bulk).results, searchStep(legacy).results);
		assert.deepEqual(searchStep(bulk).paths, searchStep(legacy).paths);
		assert.deepEqual(bulk.reads, legacy.reads);
		assert.equal(bulk.details.scanBytes, legacy.details.scanBytes);
		for (const match of searchStep(bulk).results) assert.equal(match.hash, sha256(Buffer.from(sources.get(match.path)!)));
		if (pattern === "needle" && caseSensitive) {
			assert.deepEqual(searchStep(bulk).paths, [...sources.keys()].sort());
			assert.equal(searchStep(bulk).results.find(match => match.path === "space newline\nname.txt")!.col, 8);
		}
	}
});

test("binary and invalid UTF-8 candidates are skipped without changing the scan accounting", async t => {
	const { root, context } = setup(t);
	const content = [Buffer.from("needle\n"), Buffer.from("needle\0binary"), Buffer.from([0xff, ...Buffer.from("needle")])];
	for (const [i, bytes] of content.entries()) writeFileSync(join(root, `${i}.txt`), bytes);
	const args = { steps: [{ id: "find", op: "search", pattern: "needle", glob: "*.txt" }] };
	const legacy = await createPlanTool().execute(args, context());
	const bulk = await createPlanTool({}).execute(args, context());
	assert.equal(bulk.ok, true, bulk.modelContent); assert.equal(bulk.modelContent, legacy.modelContent);
	assert.deepEqual(searchStep(bulk).paths, ["0.txt"]);
	assert.equal(bulk.details.scannedFiles, 3);
	assert.equal(bulk.details.scanBytes, content.reduce((sum, bytes) => sum + bytes.length, 0));
});

test("positive globs stay intersected with ignore rules and cannot expose external symlinks", async t => {
	const { parent, root, context } = setup(t);
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), "ignored.txt\nignored-dir/\n");
	writeFileSync(join(root, "visible.txt"), "needle visible");
	writeFileSync(join(root, "ignored.txt"), "needle IGNORED_PRIVATE");
	mkdirSync(join(root, "ignored-dir")); writeFileSync(join(root, "ignored-dir", "inside.txt"), "needle IGNORED_PRIVATE");
	writeFileSync(join(parent, "external.txt"), "needle EXTERNAL_PRIVATE");
	symlinkSync(join(parent, "external.txt"), join(root, "external-link.txt"));
	const config = join(parent, "rg-config"); writeFileSync(config, "--no-ignore\n--follow\n");
	const previous = process.env.RIPGREP_CONFIG_PATH; process.env.RIPGREP_CONFIG_PATH = config;
	t.after(() => { if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = previous; });
	const args = { steps: [{ id: "find", op: "search", pattern: "needle", glob: "*.txt" }] };
	const legacy = await createPlanTool().execute(args, context());
	const bulk = await createPlanTool({}).execute(args, context());
	assert.equal(bulk.ok, true, bulk.modelContent); assert.equal(bulk.modelContent, legacy.modelContent);
	assert.deepEqual(searchStep(bulk).paths, ["visible.txt"]);
	assert.doesNotMatch(bulk.modelContent, /IGNORED_PRIVATE|EXTERNAL_PRIVATE/);
	const ctx = context();
	const escape = await createPlanTool({}).execute({ steps: [{ id: "escape", op: "read", path: "external-link.txt" }] }, ctx);
	globallyStopped(escape, ctx);
});

test("search results still feed exact dependent reads and deferred publication", async t => {
	const { root, context } = setup(t); writeFileSync(join(root, "a.py"), "def needle():\n    return 'value'\n");
	const args = { steps: [{ id: "find", op: "search", pattern: "needle", glob: "*.py" }, { id: "read", op: "read", path: { from: "find", expect: "one" }, symbol: "needle" }] };
	const legacy = await createPlanTool().execute(args, context());
	const ctx = context(); ctx.deferReadPublication = true;
	const bulk = await createPlanTool({}).execute(args, ctx);
	assert.equal(bulk.ok, true, bulk.modelContent); assert.equal(bulk.modelContent, legacy.modelContent); assert.deepEqual(bulk.reads, legacy.reads);
	const read = bulk.reads![0]!;
	assert.equal(ctx.files.get("a.py"), read.hash);
	assert.equal(ctx.files.isDelivered(read.path, read.hash, read.startLine, read.endLine), false);
});

test("bulk handles the 2000-file default boundary without per-file subprocess overhead", async t => {
	const { parent, root, context } = setup(t);
	for (let i = 0; i < 2000; i++) writeFileSync(join(root, `f${String(i).padStart(4, "0")}.txt`), i === 1999 ? "needle\n" : "ordinary\n");
	const log = join(parent, "calls.jsonl");
	withRg(t, parent, "", "", `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ searching }) + '\\n');`);
	const args = { steps: [{ id: "find", op: "search", pattern: "needle", glob: "*.txt" }] };
	const bulk = await createPlanTool({}).execute(args, context());
	assert.equal(bulk.ok, true, bulk.modelContent); assert.equal(bulk.details.scannedFiles, 2000);
	assert.deepEqual(searchStep(bulk).paths, ["f1999.txt"]);
	const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { searching: boolean });
	assert.ok(calls.filter(call => call.searching).length < 20, "small search output must not require one subprocess per file");
	writeFileSync(join(root, "extra.txt"), "ordinary\n");
	const ctx = context(); const over = await createPlanTool({}).execute(args, ctx);
	globallyStopped(over, ctx); assert.match(over.modelContent, /File enumeration limit/);
});

test("bulk accepts exactly the default 32 MiB scan ceiling and rejects one extra byte", async t => {
	const { root, context } = setup(t);
	const block = Buffer.alloc(2 * 1024 * 1024, "x");
	for (let i = 0; i < 16; i++) {
		const bytes = Buffer.from(block); if (i === 0) bytes.write("needle\n");
		writeFileSync(join(root, `f${String(i).padStart(2, "0")}.txt`), bytes);
	}
	const args = { steps: [{ id: "find", op: "search", pattern: "^needle$", glob: "*.txt" }] };
	const bulk = await createPlanTool({}).execute(args, context());
	assert.equal(bulk.ok, true, bulk.modelContent); assert.equal(bulk.details.scanBytes, 32 * 1024 * 1024);
	assert.deepEqual(searchStep(bulk).paths, ["f00.txt"]);
	writeFileSync(join(root, "z-extra.txt"), "x");
	const ctx = context(); const over = await createPlanTool({}).execute(args, ctx);
	globallyStopped(over, ctx); assert.match(over.modelContent, /file\/scan limit/);
});

test("bulk match and child-output budgets discard earlier reads rather than publishing partial evidence", async t => {
	const { root, context } = setup(t);
	writeFileSync(join(root, "proof.txt"), "EARLIER_SOURCE_RECEIPT"); writeFileSync(join(root, "matches.txt"), "needle\nneedle\nneedle\n");
	const steps = [{ id: "proof", op: "read", path: "proof.txt" }, { id: "find", op: "search", pattern: "needle", glob: "matches.txt" }];
	for (const limits of [{ maxMatches: 2 }, { maxProcessBytes: 128 }, { maxFileBytes: 20 }, { maxFiles: 1 }] satisfies Partial<PlanOptions["limits"]>[]) {
		const ctx = context(); const stopped = await createPlanTool({ limits }).execute({ steps }, ctx);
		globallyStopped(stopped, ctx);
	}
	const exact = await createPlanTool({ limits: { maxMatches: 3 } }).execute({ steps }, context());
	assert.equal(exact.ok, true, exact.modelContent); assert.equal(searchStep(exact).results.length, 3);
	const ctx = context();
	const output = await createPlanTool({ limits: { maxOutputBytes: 10 } }).execute({ steps: steps.slice(1) }, ctx);
	globallyStopped(output, ctx); assert.match(output.modelContent, /output limit/);
});

for (const mutation of ["replace", "add", "delete"] as const) {
	test(`source ${mutation} during bulk search stops the whole call and publishes no earlier reads`, async t => {
		const { parent, root, context } = setup(t);
		writeFileSync(join(root, "proof.txt"), "EARLIER_SOURCE_RECEIPT"); writeFileSync(join(root, "source.txt"), "needle ORIGINAL");
		const source = JSON.stringify(join(root, "source.txt"));
		const change = mutation === "replace" ? `fs.renameSync(${source}, ${JSON.stringify(join(parent, "old.txt"))}); fs.writeFileSync(${source}, 'needle REPLACED');`
			: mutation === "add" ? `fs.writeFileSync(${JSON.stringify(join(root, "new.txt"))}, 'needle NEW_MATCH');` : `fs.unlinkSync(${source});`;
		withRg(t, parent, "", change);
		const ctx = context();
		const result = await createPlanTool({}).execute({ steps: [{ id: "proof", op: "read", path: "proof.txt" }, { id: "find", op: "search", pattern: "needle", glob: "*.txt" }] }, ctx);
		globallyStopped(result, ctx); assert.doesNotMatch(result.modelContent, /ORIGINAL|REPLACED|NEW_MATCH/);
	});
}

for (const outsideMatches of [true, false]) {
	test(`a restored parent-directory swap cannot ${outsideMatches ? "publish outside text with the original hash" : "hide a match in the original snapshot"}`, async t => {
		const { parent, root, context } = setup(t);
		const sub = join(root, "sub"); const saved = join(parent, "saved-sub"); const external = join(parent, "external");
		mkdirSync(sub); mkdirSync(external);
		writeFileSync(join(root, "proof.txt"), "EARLIER_SOURCE_RECEIPT");
		writeFileSync(join(sub, "a.txt"), "needle LOCAL_ORIGINAL\n");
		writeFileSync(join(external, "a.txt"), outsideMatches ? "needle EXTERNAL_SYNTHETIC_TEXT\n" : "EXTERNAL_SYNTHETIC_TEXT without the match\n");
		withRg(t, parent,
			`fs.renameSync(${JSON.stringify(sub)}, ${JSON.stringify(saved)}); fs.symlinkSync(${JSON.stringify(external)}, ${JSON.stringify(sub)});`,
			`fs.unlinkSync(${JSON.stringify(sub)}); fs.renameSync(${JSON.stringify(saved)}, ${JSON.stringify(sub)});`);
		const ctx = context();
		const result = await createPlanTool({}).execute({ steps: [{ id: "proof", op: "read", path: "proof.txt" }, { id: "find", op: "search", pattern: "needle", glob: "sub/*.txt" }] }, ctx);
		assert.doesNotMatch(result.modelContent, /EXTERNAL_SYNTHETIC_TEXT/, "only the previously hashed local bytes may become evidence");
		if (result.ok) {
			assert.match(result.modelContent, /LOCAL_ORIGINAL/);
			assert.equal(searchStep(result).results.length, 1, "a replacement directory cannot create a false absence");
			assert.equal(searchStep(result).results[0]!.hash, sha256("needle LOCAL_ORIGINAL\n"));
		} else globallyStopped(result, ctx);
	});
}

for (const failure of [false, true]) {
	test(`private snapshots are removed after a ${failure ? "failed" : "successful"} bulk subprocess`, async t => {
		const { parent, root, context } = setup(t);
		writeFileSync(join(root, "a.txt"), "needle original\n");
		const log = join(parent, "snapshots.jsonl");
		withRg(t, parent,
			`for (const path of args.slice(args.indexOf('--') + 1)) {
			const directory = require('node:path').dirname(path);
			fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ path, directory, fileMode: fs.statSync(path).mode, directoryMode: fs.statSync(directory).mode }) + '\\n');
			}`,
			failure ? "process.stderr.write('synthetic subprocess failure');" : "");
		const result = await createPlanTool({}).execute({ steps: [{ id: "find", op: "search", pattern: "needle", glob: "*.txt" }] }, context());
		assert.equal(result.ok, !failure, result.modelContent);
		const snapshots = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { path: string; directory: string; fileMode: number; directoryMode: number });
		assert.ok(snapshots.length > 0);
		for (const snapshot of snapshots) {
			assert.notEqual(snapshot.path, join(root, "a.txt"));
			assert.equal(existsSync(snapshot.path), false); assert.equal(existsSync(snapshot.directory), false);
			if (process.platform !== "win32") {
				assert.equal(snapshot.fileMode & 0o077, 0); assert.equal(snapshot.directoryMode & 0o077, 0);
			}
		}
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "needle original\n");
	});
}

test("invalid regex and stderr remain global failures even with partial results enabled", async t => {
	const { parent, root, context } = setup(t);
	writeFileSync(join(root, "proof.txt"), "EARLIER_SOURCE_RECEIPT");
	const steps = [{ id: "proof", op: "read", path: "proof.txt" }, { id: "find", op: "search", pattern: "[", glob: "*.absent" }];
	const invalidCtx = context(); const invalid = await createPlanTool({}).execute({ steps }, invalidCtx);
	globallyStopped(invalid, invalidCtx); assert.match(invalid.modelContent, /regex parse error/);
	withRg(t, parent, "", "process.stderr.write('synthetic read failure');");
	const ctx = context();
	const error = await createPlanTool({}).execute({ steps: [{ ...steps[0] }, { id: "find", op: "search", pattern: "EARLIER", glob: "*.txt" }] }, ctx);
	globallyStopped(error, ctx); assert.match(error.modelContent, /synthetic read failure/);
});
