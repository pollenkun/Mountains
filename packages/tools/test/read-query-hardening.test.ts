import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createReadTool, DEFAULT_READ_LIMITS, findSymbol, MAX_READ_OUTPUT_BYTES } from "../src/files.ts";
import { createOutlineTool, outlineLines } from "../src/outline.ts";
import { createPlanTool } from "../src/plan.ts";
import { useNodeFixture } from "./helpers/node-fixture.ts";
import { SessionArchiveIndex } from "../src/session-index.ts";
import { truncateUtf16, truncateUtf16Tail } from "../src/text.ts";
import type { ToolContext } from "../src/types.ts";
import { BlobStore, FileStateTracker, sha256, Workspace } from "../src/workspace.ts";

function setup(t: TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "mountains-read-hardening-"));
	const root = join(parent, "workspace"); mkdirSync(root);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), blobs: new BlobStore(join(parent, "blobs")),
		signal: new AbortController().signal, toolCallId: "read-hardening", approve: async () => { throw new Error("Unexpected approval"); } };
	return { root, parent, ctx };
}

test("UTF-16 clipping preserves pairs at both boundaries and ordinary exact cuts", () => {
	for (const limit of [0, 1, 2, 3, 4, 5]) {
		const head = truncateUtf16("a😀z", limit), tail = truncateUtf16Tail("a😀z", limit);
		assert.equal(Buffer.from(head).toString(), head); assert.equal(Buffer.from(tail).toString(), tail);
		assert.ok(head.length <= limit); assert.ok(tail.length <= limit);
	}
	assert.equal(truncateUtf16("a😀z", 2), "a"); assert.equal(truncateUtf16Tail("a😀z", 2), "z");
	assert.equal(truncateUtf16("abc", 2), "ab"); assert.equal(truncateUtf16Tail("abc", 2), "bc");
});

test("read and both outline routes remain indexable when an emoji straddles a cut", async t => {
	const { root, ctx } = setup(t); const index = new SessionArchiveIndex(ctx.blobs!);
	writeFileSync(join(root, "line.txt"), "a".repeat(1999) + "😀\n");
	const read = await createReadTool().execute({ path: "line.txt" }, ctx);
	assert.equal(read.ok, true); assert.equal(Buffer.from(read.modelContent).toString(), read.modelContent); assert.deepEqual(read.reads, []);
	assert.ok(read.fullOutputRef); assert.equal(ctx.blobs!.inspect(read.fullOutputRef!)!.bytes.toString(), "a".repeat(1999) + "😀\n");
	assert.doesNotThrow(() => index.record(read.modelContent, { role: "tool" }));
	const declaration = "def f(): #" + "x".repeat(149) + "😀\n    pass\n";
	writeFileSync(join(root, "source.py"), declaration);
	for (const tool of [createOutlineTool(), createReadTool({ ...DEFAULT_READ_LIMITS, outlineFirst: 1 })]) {
		const result = await tool.execute({ path: "source.py" }, ctx);
		assert.equal(result.ok, true); assert.equal(Buffer.from(result.modelContent).toString(), result.modelContent);
		assert.doesNotThrow(() => index.record(result.modelContent, { role: "tool" }));
	}
});

test("wide UTF-8 reads page below the index cap with exact whole-line receipts and recovery", async t => {
	const { root, ctx } = setup(t), source = ("界".repeat(2000) + "\r\n").repeat(2000);
	writeFileSync(join(root, "wide.txt"), source); const index = new SessionArchiveIndex(ctx.blobs!);
	const tool = createReadTool({ ...DEFAULT_READ_LIMITS, dedupe: true }, { contextExpand: true });
	let start = 1, pages = 0;
	while (start <= 2000) {
		const result = await tool.execute({ path: "wide.txt", startLine: start }, ctx);
		assert.equal(result.ok, true, result.modelContent.slice(0, 200)); assert.ok(Buffer.byteLength(result.modelContent) <= MAX_READ_OUTPUT_BYTES);
		assert.equal(Buffer.from(result.modelContent).toString(), result.modelContent); assert.doesNotThrow(() => index.record(result.modelContent, { role: "tool" }));
		const receipt = result.reads![0]!;
		assert.equal(receipt.startLine, start); assert.equal(receipt.hash, sha256(source));
		const rows = result.modelContent.split("\n").slice(1);
		assert.equal(rows.length, receipt.endLine - start + 1);
		for (const [i, row] of rows.entries()) assert.equal(row, `${start + i}\t${"界".repeat(2000)}`);
		if (receipt.endLine < 2000) assert.match(result.modelContent, new RegExp(`startLine=${receipt.endLine + 1}(?: |$)`));
		assert.ok(result.fullOutputRef); assert.equal(ctx.blobs!.inspect(result.fullOutputRef!)!.bytes.equals(Buffer.from(source)), true);
		start = receipt.endLine + 1; pages++;
	}
	assert.ok(pages > 1); assert.equal(ctx.files.isDelivered("wide.txt", sha256(source), 1, 2000), true);
	const deduped = await tool.execute({ path: "wide.txt" }, ctx); assert.equal(deduped.details.deduped, true);
	const forced = await tool.execute({ path: "wide.txt", force: true }, ctx); assert.equal(forced.details.outputTruncated, true);
});

test("byte-limited symbol reads, sparse formatting and unavailable archives keep precise continuation", async t => {
	const { root, ctx } = setup(t); delete ctx.blobs;
	const source = "def wide():\n" + ("    #" + "界".repeat(1995) + "\n").repeat(250);
	writeFileSync(join(root, "wide.py"), source);
	const result = await createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true, lineNumbers: "sparse" }).execute({ path: "wide.py", symbol: "wide" }, ctx);
	assert.equal(result.ok, true); assert.equal(result.details.symbolTruncated, true); assert.equal(result.details.outputTruncated, true);
	assert.equal(result.details.symbolEndLine, 251); assert.ok(result.details.archiveError);
	assert.match(result.modelContent, new RegExp(`symbol incomplete: startLine=${Number(result.details.endLine) + 1} endLine=251`));
	assert.equal(result.reads![0]!.endLine, result.details.endLine);
});

test("Python symbol lookup compares complete Unicode leaf and ancestor identifiers", async t => {
	const { root, ctx } = setup(t);
	const source = "def f世():\n    return 'wrong'\n\ndef café():\n    pass\n\nclass Café:\n    def run(self):\n        return 'right'\n\ndef f\u0301():\n    pass\n";
	writeFileSync(join(root, "unicode.py"), source);
	assert.deepEqual(findSymbol(source.split("\n"), "f"), []);
	assert.deepEqual(findSymbol(source.split("\n"), "f世"), [{ start: 1, end: 2 }]);
	assert.deepEqual(findSymbol(source.split("\n"), "Caf.run"), []);
	for (const symbol of ["f世", "café", "Café.run", "f\u0301"]) {
		const result = await createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true }).execute({ path: "unicode.py", symbol }, ctx);
		assert.equal(result.ok, true, result.modelContent);
		const query = await createPlanTool().execute({ steps: [{ id: "read", op: "read", path: "unicode.py", symbol }] }, ctx);
		assert.equal(query.ok, true, query.modelContent);
	}
	const missing = await createPlanTool().execute({ steps: [{ id: "read", op: "read", path: "unicode.py", symbol: "f" }] }, ctx);
	assert.equal(missing.ok, false); assert.doesNotMatch(missing.modelContent, /wrong/); assert.deepEqual(missing.reads, []);
});

test("decorated classes use declaration metadata for structure mode, full reads retain decorators", async t => {
	const { root, ctx } = setup(t);
	for (const prefix of ["", "@decorator\n", "@decorator(\n    value=True\n)\n"]) {
		const source = prefix + "class Big:\n    def method(self):\n        return 1\n";
		writeFileSync(join(root, "class.py"), source);
		const tool = createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true, classOutlineOver: 2 });
		const outline = await tool.execute({ path: "class.py", symbol: "Big" }, ctx);
		assert.equal(outline.details.classOutline, true); assert.equal(outline.reads, undefined);
		assert.match(outline.modelContent, /\tclass Big:/); assert.match(outline.modelContent, /def method/); assert.doesNotMatch(outline.modelContent, /return 1/);
		const full = await tool.execute({ path: "class.py", symbol: "Big", full: true }, ctx);
		assert.equal(full.ok, true); assert.equal(full.reads![0]!.startLine, 1); assert.match(full.modelContent, /return 1/);
		if (prefix) assert.match(full.modelContent, /1\t@decorator/);
	}
});

test("outline rejects long whitespace quickly while still recognizing ordinary definitions", () => {
	for (const ext of ["ts", "js", "java", "kt", "cs", "py"]) {
		assert.deepEqual(outlineLines(`source.${ext}`, " ".repeat(100000) + "!"), []);
	}
	assert.equal(outlineLines("source.ts", "  public static async work() {\nexport class C {\n  readonly getValue(): string {").length, 3);
	assert.equal(outlineLines("source.java", "  public static void work() {\npublic class A {\n  Map<String, Value> build() {").length, 3);
	assert.equal(outlineLines("source.py", "def café():\nclass 类:").length, 2);
});

test("all file tools reject FIFOs promptly and recover after ordinary replacement", { skip: process.platform === "win32" }, t => {
	const { root } = setup(t); const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const script = `import {createReadTool,createEditTool,createWriteTool,createOutlineTool,Workspace,FileStateTracker,sha256} from ${JSON.stringify(entry)};
import {writeFileSync,unlinkSync} from 'node:fs'; import {execFileSync} from 'node:child_process';
const root=${JSON.stringify(root)}, target=root+'/source.ts';
const ctx={workspace:new Workspace(root),files:new FileStateTracker(),signal:new AbortController().signal,toolCallId:'fifo',approve:async()=> 'allow'};
for (const [tool,args] of [[createReadTool(),{}],[createEditTool(),{oldText:'old',newText:'new',expectedHash:sha256('old')}],[createWriteTool(),{content:'new',createOnly:false,expectedHash:sha256('old')}],[createOutlineTool(),{}]]) {
 execFileSync('mkfifo',[target]); const failed=await tool.execute({path:'source.ts',...args},ctx); if(failed.ok) throw Error('FIFO accepted'); unlinkSync(target);
 writeFileSync(target,'old'); const recovered=await tool.execute({path:'source.ts',...args},ctx); if(!recovered.ok) throw Error(recovered.modelContent); unlinkSync(target);
}
writeFileSync(target,'old');ctx.beforeWrite=async()=>{unlinkSync(target);execFileSync('mkfifo',[target]);};
const changed=await createWriteTool().execute({path:'source.ts',content:'new',createOnly:false,expectedHash:sha256('old')},ctx); if(changed.ok) throw Error('FIFO swap accepted');
console.log('safe');`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
	assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /safe/);
});

test("atomic staging is private before content arrives and final permissions are preserved", { skip: process.platform === "win32" }, t => {
	const { root } = setup(t); const entry = fileURLToPath(new URL("../src/files.ts", import.meta.url));
	const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.writeFileSync, modes=[]; fs.writeFileSync=function(path,...args) {if(typeof path==='number') modes.push(fs.fstatSync(path).mode&0o777); return original(path,...args);}; syncBuiltinESMExports();
const {atomicWrite}=await import(${JSON.stringify(entry)}); const target=${JSON.stringify(join(root, "secret.txt"))};
process.umask(0o022); fs.writeFileSync(target,'old',{mode:0o640}); atomicWrite(target,'synthetic private update');
assert.deepEqual(modes,[0o600]); assert.equal(fs.statSync(target).mode&0o777,0o640);
fs.unlinkSync(target);atomicWrite(target,'new');assert.equal(fs.statSync(target).mode&0o777,0o644);console.log('private');`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
	assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /private/);
});

test("narrow query inventories exclude unrelated output without overriding ignore rules", async t => {
	const { root, ctx } = setup(t); execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, "target.txt"), "needle\n");
	for (let i = 0; i < 1500; i++) writeFileSync(join(root, `unrelated_${String(i).padStart(4, "0")}_${"x".repeat(170)}.txt`), "");
	for (const step of [
		{ id: "find", op: "search", path: "target.txt", pattern: "needle" },
		{ id: "find", op: "search", glob: "target.txt", pattern: "needle" },
		{ id: "find", op: "glob", patterns: ["target.txt"] },
	]) {
		const result = await createPlanTool().execute({ steps: [step] }, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.ok(Number(result.details.processBytes) < 4096);
		assert.match(result.modelContent, /target.txt/);
	}
	writeFileSync(join(root, ".gitignore"), "target.txt\n");
	for (const step of [{ id: "find", op: "search", path: "target.txt", pattern: "needle" }, { id: "find", op: "glob", patterns: ["target.txt"] }]) {
		const ignored = await createPlanTool().execute({ steps: [step] }, ctx);
		assert.equal(ignored.ok, true, ignored.modelContent); assert.doesNotMatch(ignored.modelContent, /needle|\n.*target.txt/);
	}
});

test("literal inventory type filters preserve unusual basenames and nested glob membership", async t => {
	const { root, ctx } = setup(t); mkdirSync(join(root, "src")); mkdirSync(join(root, "other"));
	for (const name of ["a[1].txt", "café.txt", "ends .txt", "brace{a}.txt", "target.txt", ...(process.platform === "win32" ? [] : ["include:txt", "trailing ", "star*.txt", "question?.txt", "backslash\\name.txt"])]) {
		writeFileSync(join(root, "src", name), "needle\n");
		const result = await createPlanTool().execute({ steps: [{ id: "find", op: "search", path: `src/${name}`, pattern: "needle" }] }, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.match(result.modelContent, /needle/);
	}
	writeFileSync(join(root, "other", "target.txt"), "needle outside requested glob\n");
	for (const patterns of [["src/*.txt"], ["src/{target,café}.txt"], ["src/**"], ["**/*.txt", "!other/**"]]) {
		const result = await createPlanTool().execute({ steps: [{ id: "find", op: "glob", patterns }] }, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.doesNotMatch(result.modelContent, /other\/target.txt/);
	}
});

test("file edit/write approval cancellation settles without a callback response or later mutation", async t => {
	const { root, ctx } = setup(t);
	const { createEditTool, createWriteTool } = await import("../src/files.ts");
	for (const tool of [createEditTool({ approveFileWrites: true }), createWriteTool({ approveFileWrites: true })]) {
		writeFileSync(join(root, "cancel.txt"), "before");
		const ac = new AbortController(); let finish!: (value: "allow" | "deny") => void; let reject!: (reason: Error) => void; let hooks = 0;
		const pending = tool.execute({ path: "cancel.txt", oldText: "before", newText: "after", content: "after", createOnly: false, expectedHash: sha256("before") }, {
			...ctx, signal: ac.signal, beforeWrite: async () => { hooks++; }, approve: () => new Promise((resolve, fail) => { finish = resolve; reject = fail; }),
		});
		await new Promise(resolve => setImmediate(resolve)); ac.abort();
		let timer: NodeJS.Timeout | undefined;
		const result = await Promise.race([pending, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error("approval did not cancel")), 500); })]).finally(() => clearTimeout(timer));
		assert.equal(result.ok, false); assert.equal(result.details.cancelled, true); assert.equal(hooks, 0);
		if (tool.name === "file_edit") finish("allow"); else reject(new Error("late synthetic rejection"));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(readFileSync(join(root, "cancel.txt"), "utf8"), "before"); assert.equal(hooks, 0);
	}
});

test("narrow inventories still recheck ignore changes before publishing any receipt", async t => {
	const { root, parent, ctx } = setup(t); execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, "target.txt"), "needle PRIVATE_CURRENT_SOURCE\n");
	const wrapper = join(parent, "rg-ignore-change.cjs"); useNodeFixture(t, wrapper);
	writeFileSync(wrapper, `const fs=require('node:fs'),cp=require('node:child_process'); const args=process.argv.slice(2);
const result=cp.spawnSync('rg',args,{input:fs.readFileSync(0),encoding:'utf8'});
if(args.includes('--json'))fs.writeFileSync('.gitignore','target.txt\\n');
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??2);`, { mode: 0o700 });
	const previous = process.env.MOUNTAINS_RG; process.env.MOUNTAINS_RG = wrapper;
	t.after(() => { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; });
	const result = await createPlanTool().execute({ steps: [
		{ id: "read", op: "read", path: "target.txt" },
		{ id: "find", op: "search", path: "target.txt", pattern: "needle" },
	] }, ctx);
	assert.equal(result.ok, false); assert.match(result.modelContent, /scope changed/); assert.doesNotMatch(result.modelContent, /PRIVATE_CURRENT_SOURCE/);
	assert.equal(result.reads, undefined); assert.equal(ctx.files.get("target.txt"), undefined);
});

test("literal file and directory scopes prune unrelated same-name candidates while respecting ignored parents", async t => {
	const { root, ctx } = setup(t); execFileSync("git", ["init", "-q"], { cwd: root });
	mkdirSync(join(root, "scope")); writeFileSync(join(root, "scope", "target.txt"), "needle\n");
	for (let i = 0; i < 1500; i++) {
		const directory = join(root, `unrelated_${String(i).padStart(4, "0")}_${"x".repeat(160)}`);
		mkdirSync(directory); writeFileSync(join(directory, "target.txt"), "");
	}
	for (const path of ["scope/target.txt", "scope"]) {
		const result = await createPlanTool().execute({ steps: [{ id: "find", op: "search", path, pattern: "needle" }] }, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.ok(Number(result.details.processBytes) < 4096);
		assert.equal(result.details.scannedFiles, 1);
	}
	writeFileSync(join(root, ".gitignore"), "scope/\n");
	for (const path of ["scope/target.txt", "scope"]) {
		const result = await createPlanTool().execute({ steps: [{ id: "find", op: "search", path, pattern: "needle" }] }, ctx);
		assert.equal(result.ok, true, result.modelContent); assert.equal(result.details.scannedFiles, 0);
		assert.doesNotMatch(result.modelContent, /needle/);
	}
});

test("literal type inventories use portable singleton classes and remain bounded with metacharacters", async t => {
	const { root, parent, ctx } = setup(t); execFileSync("git", ["init", "-q"], { cwd: root });
	const names = ["a[1].ts", "brace{a}.ts", "open[.ts", "close].ts", "[[braces{}]].ts"];
	for (const name of [...names, "a1.ts", "bracea.ts", "open.ts", "close.ts"]) writeFileSync(join(root, name), "needle\n");
	for (let i = 0; i < 1500; i++) writeFileSync(join(root, `unrelated_${String(i).padStart(4, "0")}_${"x".repeat(170)}.ts`), "");
	const log = join(parent, "type-globs.jsonl"), wrapper = join(parent, "rg-portable-type-globs.cjs"); useNodeFixture(t, wrapper);
	writeFileSync(wrapper, `const fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);
for(let i=0;i<args.length;i++)if(args[i]==='--type-add'){
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args[i+1])+'\\n');
 // globset's Windows type-glob default treats backslashes as path separators.
 // This semantic shim makes accidental backslash escapes fail on POSIX as well.
 args[i+1]=args[i+1].replace(/\\\\/g,'/');
}
const result=cp.spawnSync('rg',args,{input:fs.readFileSync(0),encoding:'utf8',maxBuffer:8*1024*1024});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??2);`, { mode: 0o700 });
	const previous = process.env.MOUNTAINS_RG; process.env.MOUNTAINS_RG = wrapper;
	t.after(() => { if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous; });
	for (const path of names) {
		const result = await createPlanTool().execute({ steps: [{ id: "find", op: "search", path, pattern: "needle" }] }, ctx);
		assert.equal(result.ok, true, result.modelContent);
		assert.deepEqual((result.details.steps as { paths: string[] }[])[0]!.paths, [path]);
		assert.equal(result.details.scannedFiles, 1); assert.ok(Number(result.details.processBytes) < 4096);
	}
	const definitions = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string);
	assert.ok(definitions.includes("mountainsquery:a[[]1[]].ts"));
	assert.ok(definitions.includes("mountainsquery:brace[{]a[}].ts"));
	assert.equal(definitions.some(definition => definition.includes("\\")), false);
	writeFileSync(join(root, ".gitignore"), "a[[]1].ts\n");
	const ignored = await createPlanTool().execute({ steps: [{ id: "find", op: "search", path: "a[1].ts", pattern: "needle" }] }, ctx);
	assert.equal(ignored.ok, true, ignored.modelContent); assert.equal(ignored.details.scannedFiles, 0);
});
