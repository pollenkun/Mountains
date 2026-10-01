import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createPlanTool, executeQueryPlan, validateQueryPlan } from "../src/plan.ts";
import { createRecipeTool, QueryRecipeStore, recipeFileFor } from "../src/recipes.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";

const roots: string[] = [];
function setup() {
	const parent = mkdtempSync(join(tmpdir(), "mountains-plan-")); roots.push(parent);
	const root = join(parent, "workspace"); mkdirSync(root);
	const controller = new AbortController();
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal, toolCallId: "plan-test", approve: async () => { throw new Error("Read-only plans must never ask for command approval"); } };
	return { parent, root, ctx, controller, store: new QueryRecipeStore(recipeFileFor(root, join(parent, "state"))) };
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

	test("cancellation and total timeout stop child processes", async () => {
		const { parent, root, ctx, controller } = setup(); writeFileSync(join(root, "a.txt"), "a"); controller.abort();
		assert.equal((await executeQueryPlan({ steps: [{ id: "a", op: "glob", patterns: ["*"] }] }, ctx)).ok, false);
		const fake = join(parent, "slow-rg"); writeFileSync(fake, "#!/bin/sh\nexec sleep 3\n", { mode: 0o700 });
		const previous = process.env.MOUNTAINS_RG;
		try {
			process.env.MOUNTAINS_RG = fake; const started = Date.now();
			const fresh = { ...ctx, signal: new AbortController().signal };
			const result = await executeQueryPlan({ steps: [{ id: "a", op: "glob", patterns: ["*"] }] }, fresh, { limits: { maxDurationMs: 40 } });
			assert.equal(result.ok, false); assert.match(result.modelContent, /time limit/); assert.ok(Date.now() - started < 1500);
		} finally { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; }
	});

	test("file changes and new matches during a plan invalidate the whole result", async () => {
		const { parent, root, ctx } = setup(); const file = join(root, "a.txt"); writeFileSync(file, "needle");
		const fake = join(parent, "changing-rg"); const previous = process.env.MOUNTAINS_RG;
		try {
			process.env.MOUNTAINS_RG = fake;
			for (const mutation of [`fs.writeFileSync(${JSON.stringify(file)}, "changed")`, `fs.writeFileSync(${JSON.stringify(join(root, "new.txt"))}, "needle")`]) {
				writeFileSync(file, "needle");
				writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);const r=cp.spawnSync('rg',args,{input:fs.readFileSync(0),encoding:'utf8'});if(args.includes('--json')){${mutation};}process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??2);\n`, { mode: 0o700 });
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

	test("failed plans never authorize edits to content the model did not receive", async () => {
		const { root, ctx } = setup(); writeFileSync(join(root, "a.txt"), "evidence");
		const tool = createPlanTool();
		const failed = await tool.execute({ steps: [{ id: "a", op: "read", path: "a.txt" }, { id: "b", op: "read", path: "missing.txt" }] }, ctx);
		assert.equal(failed.ok, false); assert.equal(ctx.files.get("a.txt"), undefined);
		const passed = await tool.execute({ steps: [{ id: "a", op: "read", path: "a.txt" }] }, ctx);
		assert.equal(passed.ok, true, passed.modelContent); assert.equal(ctx.files.get("a.txt"), passed.reads?.[0]?.hash);
	});

	test("last asynchronous inventory cannot publish stale file contents", async () => {
		const { parent, root, ctx } = setup(); const file = join(root, "a.json"); writeFileSync(file, '{"value":"OLD"}');
		const countFile = join(parent, "count"); const fake = join(parent, "last-inventory-rg"); const previous = process.env.MOUNTAINS_RG;
		writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(countFile)},'utf8'));}catch{}if(args.includes('--files')){fs.writeFileSync(${JSON.stringify(countFile)},String(++n));}const r=cp.spawnSync('rg',args,{input:fs.readFileSync(0),encoding:'utf8'});if(n===4){fs.writeFileSync(${JSON.stringify(file)},'{"value":"NEW"}');}process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??2);\n`, { mode: 0o700 });
		try {
			process.env.MOUNTAINS_RG = fake;
			const result = await executeQueryPlan({ steps: [{ id: "find", op: "glob", patterns: ["*.json"] }, { id: "value", op: "json_field", path: { from: "find", expect: "one" }, field: ["value"] }] }, ctx);
			assert.equal(result.ok, false); assert.match(result.modelContent, /Source changed during plan/); assert.doesNotMatch(result.modelContent, /OLD/);
		} finally { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; }
	});
});

describe("replayable query methods", () => {
	test("new session replays current values and stores methods without old answers", async () => {
		const { root, ctx, store } = setup(); writeFileSync(join(root, "package.json"), '{"scripts":{"test":"OLD_COMMAND_SECRET"}}');
		const saved = await createPlanTool({ recipes: store }).execute({ ...jsonPlan, saveAs: "test command" }, ctx);
		assert.equal(saved.ok, true, saved.modelContent); const id = saved.details.recipeId;
		const stored = readFileSync(store.file, "utf8"); assert.doesNotMatch(stored, /OLD_COMMAND_SECRET|results|modelContent/);
		writeFileSync(join(root, "package.json"), '{"name":"updated","scripts":{"test":"NEW_COMMAND"}}');
		const freshContext = { ...ctx, files: new FileStateTracker() }; const fresh = createRecipeTool(new QueryRecipeStore(store.file));
		const listed = await fresh.execute({ action: "list" }, freshContext); assert.doesNotMatch(listed.modelContent, /OLD_COMMAND_SECRET|NEW_COMMAND/);
		const replayed = await fresh.execute({ action: "replay", id }, freshContext);
		assert.equal(replayed.ok, true, replayed.modelContent); assert.match(replayed.modelContent, /NEW_COMMAND/); assert.doesNotMatch(replayed.modelContent, /OLD_COMMAND_SECRET/);
		assert.notEqual((saved.details.steps as { results: { hash: string }[] }[])[0]?.results[0]?.hash, (replayed.details.steps as { results: { hash: string }[] }[])[0]?.results[0]?.hash);
	});

	test("negative search is never saved; a new matching file is observed on the next run", async () => {
		const { root, ctx, store } = setup(); writeFileSync(join(root, "a.txt"), "nothing");
		const tool = createPlanTool({ recipes: store }); const plan = { steps: [{ id: "find", op: "search", pattern: "needle", glob: "*.txt" }], saveAs: "find needle" };
		assert.equal((await tool.execute(plan, ctx)).ok, false); assert.equal(existsSync(store.file), false);
		writeFileSync(join(root, "new.txt"), "needle"); const result = await tool.execute(plan, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.match(result.modelContent, /new.txt/);
	});

	test("replay re-enumerates paths and stops when new files create ambiguity", async () => {
		const { root, ctx, store } = setup(); writeFileSync(join(root, "one.json"), '{"a":1}');
		const saved = await createPlanTool({ recipes: store }).execute({ saveAs: "one config", steps: [
			{ id: "files", op: "glob", patterns: ["*.json"] }, { id: "value", op: "json_field", path: { from: "files", expect: "one" }, field: ["a"] },
		] }, ctx);
		assert.equal(saved.ok, true, saved.modelContent); writeFileSync(join(root, "two.json"), '{"a":2}');
		const replay = await createRecipeTool(store).execute({ action: "replay", id: saved.details.recipeId }, ctx);
		assert.equal(replay.ok, false); assert.match(replay.modelContent, /Ambiguous/);
	});

	test("same workspace on a different branch invalidates a saved method", async () => {
		const { root, ctx, store } = setup(); execFileSync("git", ["init", "-q", "-b", "first"], { cwd: root });
		writeFileSync(join(root, "package.json"), '{"scripts":{"test":"run"}}'); execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
		const saved = await createPlanTool({ recipes: store }).execute({ ...jsonPlan, saveAs: "test" }, ctx); assert.equal(saved.ok, true, saved.modelContent);
		execFileSync("git", ["checkout", "-qb", "second"], { cwd: root });
		const replay = await createRecipeTool(store).execute({ action: "replay", id: saved.details.recipeId }, ctx);
		assert.equal(replay.ok, false); assert.match(replay.modelContent, /no longer applies/);
	});

	test("a new commit on the same branch replays current evidence", async () => {
		const { root, ctx, store } = setup(); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		const commit = () => { execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root }); };
		writeFileSync(join(root, "package.json"), '{"scripts":{"test":"before"}}'); commit();
		const saved = await createPlanTool({ recipes: store }).execute({ ...jsonPlan, saveAs: "test" }, ctx); assert.equal(saved.ok, true, saved.modelContent);
		writeFileSync(join(root, "package.json"), '{"scripts":{"test":"after"}}'); commit();
		const replay = await createRecipeTool(store).execute({ action: "replay", id: saved.details.recipeId }, ctx);
		assert.equal(replay.ok, true, replay.modelContent); assert.match(replay.modelContent, /after/); assert.doesNotMatch(replay.modelContent, /before/);
	});

	test("store writer lock prevents lost updates and mutating tools are classified conservatively", async () => {
		const { root, ctx, store } = setup(); writeFileSync(join(root, "package.json"), '{"scripts":{"test":"run"}}');
		const tool = createPlanTool({ recipes: store }); assert.equal(tool.readOnly, false); assert.equal(createRecipeTool(store).readOnly, false); assert.equal(createPlanTool().readOnly, true);
		const saved = await tool.execute({ ...jsonPlan, saveAs: "test" }, ctx); assert.equal(saved.ok, true, saved.modelContent);
		const before = readFileSync(store.file, "utf8"); writeFileSync(`${store.file}.lock`, "1234");
		const blocked = await tool.execute({ ...jsonPlan, saveAs: "blocked" }, ctx);
		assert.equal(blocked.ok, false); assert.match(blocked.modelContent, /locked/); assert.equal(readFileSync(store.file, "utf8"), before);
	});

	test("inside-repository and symlinked storage are refused before writing", async () => {
		const { parent, root, ctx } = setup(); writeFileSync(join(root, "package.json"), '{"scripts":{"test":"run"}}');
		symlinkSync(root, join(parent, "alias"));
		for (const file of [join(root, "state", "recipes.json"), join(parent, "alias", "state", "recipes.json")]) {
			const result = await createPlanTool({ recipes: new QueryRecipeStore(file) }).execute({ ...jsonPlan, saveAs: "test" }, ctx);
			assert.equal(result.ok, false); assert.match(result.modelContent, /outside/); assert.equal(existsSync(file), false);
		}
	});

	test("revoked, version-mismatched and corrupted methods do not execute", async () => {
		const { root, ctx, store } = setup(); writeFileSync(join(root, "package.json"), '{"scripts":{"test":"run"}}');
		const saved = await createPlanTool({ recipes: store }).execute({ ...jsonPlan, saveAs: "test" }, ctx); assert.equal(saved.ok, true, saved.modelContent);
		const tool = createRecipeTool(store); assert.equal((await tool.execute({ action: "forget", id: saved.details.recipeId }, ctx)).ok, true);
		assert.equal((await tool.execute({ action: "replay", id: saved.details.recipeId }, ctx)).ok, false);
		const again = await createPlanTool({ recipes: store }).execute({ ...jsonPlan, saveAs: "test" }, ctx); assert.equal(again.ok, true, again.modelContent);
		const data = JSON.parse(readFileSync(store.file, "utf8")); data.recipes[0].environment.version = "obsolete"; writeFileSync(store.file, JSON.stringify(data));
		assert.equal((await tool.execute({ action: "replay", id: again.details.recipeId }, ctx)).ok, false);
		writeFileSync(store.file, "{"); assert.equal((await tool.execute({ action: "list" }, ctx)).ok, false);
	});

	test("revocation during replay prevents publication", async () => {
		const { parent, root, ctx, store } = setup(); writeFileSync(join(root, "package.json"), '{"scripts":{"test":"CURRENT"}}');
		const fake = join(parent, "revoking-rg"); const counter = join(parent, "version-count"); const previous = process.env.MOUNTAINS_RG;
		writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('--version')){let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'));}catch{}fs.writeFileSync(${JSON.stringify(counter)},String(++n));if(n===4)fs.writeFileSync(${JSON.stringify(store.file)},JSON.stringify({version:1,recipes:[]}));}const r=cp.spawnSync('rg',args,{input:fs.readFileSync(0),encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??2);\n`, { mode: 0o700 });
		try {
			process.env.MOUNTAINS_RG = fake; const saved = await createPlanTool({ recipes: store }).execute({ ...jsonPlan, saveAs: "test" }, ctx);
			assert.equal(saved.ok, true, saved.modelContent);
			const replay = await createRecipeTool(store).execute({ action: "replay", id: saved.details.recipeId }, ctx);
			assert.equal(replay.ok, false); assert.match(replay.modelContent, /revoked during replay/); assert.doesNotMatch(replay.modelContent, /CURRENT/);
		} finally { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; }
	});
});
