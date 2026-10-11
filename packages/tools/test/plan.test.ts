import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createPlanTool, executeQueryPlan, validateQueryPlan } from "../src/plan.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";
import { useNodeFixture } from "./helpers/node-fixture.ts";

const roots: string[] = [];
function setup() {
	const parent = mkdtempSync(join(tmpdir(), "mountains-plan-")); roots.push(parent);
	const root = join(parent, "workspace"); mkdirSync(root);
	const controller = new AbortController();
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal, toolCallId: "plan-test", approve: async () => { throw new Error("Read-only plans must never ask for command approval"); } };
	return { parent, root, ctx, controller };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const jsonPlan = { steps: [{ id: "config", op: "json_field", path: "package.json", field: ["scripts", "test"] }] };

describe("bounded query plan", () => {
	test("search paths feed a later read; repeated matches deduplicate to one path", async () => {
		const { root, ctx } = setup(); writeFileSync(join(root, "service.py"), "def work():\n    # work\n    return 42\n");
		const result = await executeQueryPlan({ steps: [
			{ id: "find", op: "search", pattern: "work", glob: "*.py" },
			{ id: "definition", op: "read", path: { from: "find", expect: "one" }, symbol: "work" },
		] }, ctx);
		assert.equal(result.ok, true, result.modelContent);
		assert.match(result.modelContent, /return 42/);
		assert.equal(result.reads?.length, 1);
		assert.deepEqual((result.details.steps as { paths: string[] }[])[0]?.paths, ["service.py"]);
	});

	test("glob feeds JSON selection and an all-path read without choosing an arbitrary candidate", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "a.json"), '{"value":"a"}'); writeFileSync(join(root, "b.json"), '{"value":"b"}');
		const steps = [{ id: "find", op: "glob", patterns: ["*.json"] }, { id: "values", op: "json_field", path: { from: "find", expect: "one" }, field: ["value"] }];
		const ambiguous = await executeQueryPlan({ steps }, ctx);
		assert.equal(ambiguous.ok, false); assert.match(ambiguous.modelContent, /Ambiguous/);
		steps[1]!.path!.expect = "all";
		const result = await executeQueryPlan({ steps }, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.match(result.modelContent, /= "a"/); assert.match(result.modelContent, /= "b"/);
	});

	test("rejects executable operations, unknown fields, forward/cyclic references and duplicate IDs", async () => {
		const { ctx } = setup();
		for (const steps of [
			[{ id: "x", op: "shell", command: "touch nope" }],
			[{ id: "x", op: "read", path: "a", eval: "process.exit()" }],
			[{ id: "x", op: "read", path: { from: "later", expect: "one" } }],
			[{ id: "x", op: "glob", patterns: ["*"] }, { id: "x", op: "read", path: "a" }],
		]) assert.equal((await executeQueryPlan({ steps }, ctx)).ok, false);
		assert.throws(() => validateQueryPlan({ steps: new Array(30).fill({ id: "x", op: "glob", patterns: ["*"] }) }));
		assert.equal((await executeQueryPlan(jsonPlan, ctx, { limits: { maxSteps: Infinity } })).ok, false);
	});

	test("enforces workspace boundary and rejects directories and external symlinks", async () => {
		const { parent, root, ctx } = setup(); writeFileSync(join(parent, "outside.txt"), "secret");
		symlinkSync(join(parent, "outside.txt"), join(root, "link.txt"));
		for (const path of ["../outside.txt", join(parent, "outside.txt"), "link.txt", "."]) {
			const result = await executeQueryPlan({ steps: [{ id: "read", op: "read", path }] }, ctx);
			assert.equal(result.ok, false); assert.doesNotMatch(result.modelContent, /secret/);
		}
	});

	test("file and scan byte limits accumulate across steps, including repeated files", async () => {
		const { root, ctx } = setup(); writeFileSync(join(root, "a.txt"), "0123456789");
		const plan = { steps: [{ id: "a", op: "read", path: "a.txt" }, { id: "b", op: "read", path: "a.txt" }] };
		assert.equal((await executeQueryPlan(plan, ctx, { limits: { maxScanBytes: 15 } })).ok, false);
		assert.equal((await executeQueryPlan(plan, ctx, { limits: { maxFiles: 1 } })).ok, false);
		assert.equal((await executeQueryPlan(plan, ctx, { limits: { maxFileBytes: 5 } })).ok, false);
	});

	test("long reads, long lines, output overflow and result overflow never report completion", async () => {
		const { root, ctx } = setup(); writeFileSync(join(root, "a.txt"), "match\n".repeat(8));
		for (const options of [{ read: { maxLines: 3 } }, { read: { maxLineChars: 3 } }, { limits: { maxOutputBytes: 20 } }]) {
			const result = await executeQueryPlan({ steps: [{ id: "a", op: "read", path: "a.txt" }] }, ctx, options);
			assert.equal(result.ok, false); assert.equal(result.details.complete, false);
		}
		const result = await executeQueryPlan({ steps: [{ id: "a", op: "search", pattern: "match" }] }, ctx, { limits: { maxMatches: 2 } });
		assert.equal(result.ok, false); assert.match(result.modelContent, /Match limit/);
	});

	test("invalid JSON, inherited property and ambiguous or incomplete symbols stop", async () => {
		const { root, ctx } = setup(); writeFileSync(join(root, "bad.json"), "{"); writeFileSync(join(root, "ok.json"), "{}");
		writeFileSync(join(root, "a.py"), "def work():\n    pass\ndef work():\n    pass\n");
		for (const step of [
			{ id: "x", op: "json_field", path: "bad.json", field: ["a"] },
			{ id: "x", op: "json_field", path: "ok.json", field: ["toString"] },
			{ id: "x", op: "read", path: "a.py", symbol: "work" },
		]) assert.equal((await executeQueryPlan({ steps: [step] }, ctx)).ok, false);
	});

	test("respects ignore rules; ripgrep user config cannot alter the query", async () => {
		const { parent, root, ctx } = setup(); execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "ignored.txt\n"); writeFileSync(join(root, "ignored.txt"), "wanted"); writeFileSync(join(root, "visible.txt"), "wanted");
		const config = join(parent, "rg-config"); writeFileSync(config, "--no-ignore\n"); const previous = process.env.RIPGREP_CONFIG_PATH;
		try {
			process.env.RIPGREP_CONFIG_PATH = config;
			const result = await executeQueryPlan({ steps: [{ id: "find", op: "search", pattern: "wanted", glob: "*.txt" }] }, ctx);
			assert.equal(result.ok, true, result.modelContent); assert.match(result.modelContent, /visible.txt/); assert.doesNotMatch(result.modelContent, /ignored.txt/);
		} finally { if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = previous; }
	});

	test("cancellation and total timeout stop child processes", async t => {
		const { parent, root, ctx, controller } = setup(); writeFileSync(join(root, "a.txt"), "a"); controller.abort();
		assert.equal((await executeQueryPlan({ steps: [{ id: "a", op: "glob", patterns: ["*"] }] }, ctx)).ok, false);
		const fake = join(parent, "slow-rg.cjs"); writeFileSync(fake, "setTimeout(()=>{},3000);\n"); useNodeFixture(t, fake);
		const previous = process.env.MOUNTAINS_RG;
		try {
			process.env.MOUNTAINS_RG = fake; const started = Date.now();
			const fresh = { ...ctx, signal: new AbortController().signal };
			const result = await executeQueryPlan({ steps: [{ id: "a", op: "glob", patterns: ["*"] }] }, fresh, { limits: { maxDurationMs: 40 } });
			assert.equal(result.ok, false); assert.match(result.modelContent, /time limit/); assert.ok(Date.now() - started < 1500);
		} finally { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; }
	});

	test("file changes and new matches during a plan invalidate the whole result", async t => {
		const { parent, root, ctx } = setup(); const file = join(root, "a.txt"); writeFileSync(file, "needle");
		const fake = join(parent, "changing-rg.cjs"); useNodeFixture(t, fake); const previous = process.env.MOUNTAINS_RG;
		try {
			process.env.MOUNTAINS_RG = fake;
			for (const mutation of [`fs.writeFileSync(${JSON.stringify(file)}, "changed")`, `fs.writeFileSync(${JSON.stringify(join(root, "new.txt"))}, "needle")`]) {
				writeFileSync(file, "needle");
				writeFileSync(fake, `const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);const r=cp.spawnSync('rg',args,{input:fs.readFileSync(0),encoding:'utf8'});if(args.includes('--json')){${mutation};}process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??2);\n`, { mode: 0o700 });
				const result = await executeQueryPlan({ steps: [{ id: "find", op: "search", pattern: "needle", glob: "*.txt" }] }, ctx);
				assert.equal(result.ok, false); assert.match(result.modelContent, /changed during plan/);
			}
		} finally { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; }
	});

	test("cumulative subprocess bytes and binary file scope are bounded", async () => {
		const { root, ctx } = setup(); writeFileSync(join(root, "a.txt"), "needle"); writeFileSync(join(root, "asset.bin"), Buffer.from([1, 0, 2]));
		const result = await executeQueryPlan({ steps: [{ id: "a", op: "search", pattern: "needle" }] }, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.equal(result.details.scannedFiles, 2);
		const limited = await executeQueryPlan({ steps: [{ id: "a", op: "glob", patterns: ["*"] }] }, ctx, { limits: { maxProcessBytes: 30 } });
		assert.equal(limited.ok, false); assert.match(limited.modelContent, /output limit/);
	});

	test("non-regular files cannot block reads", { skip: process.platform === "win32" }, async () => {
		const { root, ctx } = setup(); execFileSync("mkfifo", [join(root, "pipe")]);
		const started = Date.now(); const result = await executeQueryPlan({ steps: [{ id: "read", op: "read", path: "pipe" }] }, ctx);
		assert.equal(result.ok, false); assert.match(result.modelContent, /regular file/); assert.ok(Date.now() - started < 1000);
	});

	test("last asynchronous inventory cannot publish stale file contents", async t => {
		const { parent, root, ctx } = setup(); const file = join(root, "a.json"); writeFileSync(file, '{"value":"OLD"}');
		const countFile = join(parent, "count"); const fake = join(parent, "last-inventory-rg.cjs"); useNodeFixture(t, fake); const previous = process.env.MOUNTAINS_RG;
		writeFileSync(fake, `const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(countFile)},'utf8'));}catch{}if(args.includes('--files')){fs.writeFileSync(${JSON.stringify(countFile)},String(++n));}const r=cp.spawnSync('rg',args,{input:fs.readFileSync(0),encoding:'utf8'});if(n===4){fs.writeFileSync(${JSON.stringify(file)},'{"value":"NEW"}');}process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??2);\n`, { mode: 0o700 });
		try {
			process.env.MOUNTAINS_RG = fake;
			const result = await executeQueryPlan({ steps: [{ id: "find", op: "glob", patterns: ["*.json"] }, { id: "value", op: "json_field", path: { from: "find", expect: "one" }, field: ["value"] }] }, ctx);
			assert.equal(result.ok, false); assert.match(result.modelContent, /Source changed during plan/); assert.doesNotMatch(result.modelContent, /OLD/);
		} finally { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; }
	});
});

