import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
	createMemoryQueryTool, createMemoryTool, MEMORY_LIMITS, memoryEnvironment, memoryFileFor,
	MemoryStore, renderMemory, verifyMemory, type MemoryEntry,
} from "../src/memory.ts";
import { FileStateTracker, sha256, Workspace } from "../src/workspace.ts";
import type { ToolContext } from "../src/types.ts";

const run = promisify(execFile);
const moduleUrl = new URL("../src/memory.ts", import.meta.url).href;
function setup(t: TestContext) {
	const base = fs.mkdtempSync(join(tmpdir(), "memory-v4-"));
	const root = join(base, "project"); fs.mkdirSync(root);
	const file = join(base, "state", "memory.jsonl");
	const store = new MemoryStore(file);
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "test-call", approve: async () => "allow" };
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	fs.writeFileSync(join(root, "package.json"), '{\n  "name": "fixture",\n  "scripts": {"test": "node --test"}\n}\n');
	fs.writeFileSync(join(root, "config.json"), '{"override": false, "description": "same"}\n');
	const entry = (text = "prior lead"): Omit<MemoryEntry, "id"> => ({ text, evidence: [{ path: "package.json", startLine: 2, endLine: 2, sha256: sha256('  "name": "fixture",') }], createdAt: "2026-09-26T01:00:00.000Z", commit: null });
	const tool = createMemoryTool(store, { verifiedFacts: true });
	const args = (extra: Record<string, unknown> = {}) => ({ note: "This command always passes on every OS", evidence: [{ path: "package.json", start_line: 2, end_line: 2 }], fact: { kind: "package-script", path: "package.json", selector: "/scripts/test" }, ...extra });
	return { base, root, file, store, ctx, entry, tool, args };
}

function legacy(file: string, entries: Omit<MemoryEntry, "id">[], suffix = "", newline = true) {
	fs.mkdirSync(join(file, ".."), { recursive: true });
	fs.writeFileSync(file, entries.map((entry, i) => JSON.stringify({ type: "add", entry: { id: `m${i + 1}`, ...entry } })).join("\n") + (newline ? "\n" : "") + suffix);
}

test("legacy complete last line without newline survives migration with exact backup", (t) => {
	const s = setup(t); legacy(s.file, [s.entry()], "", false);
	const original = fs.readFileSync(s.file, "utf8");
	assert.equal(s.store.entries()[0]?.id, "m1");
	s.store.add(s.entry("second"));
	assert.deepEqual(s.store.entries().map((e) => e.id), ["m1", "m2"]);
	const backups = fs.readdirSync(join(s.file, "..")).filter((name) => name.endsWith(".bak"));
	assert.equal(backups.length, 1);
	assert.equal(fs.readFileSync(join(s.file, "..", backups[0]!), "utf8"), original);
	assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).version, 2);
});

test("partial legacy tail is quarantined; valid records and later updates survive", (t) => {
	const s = setup(t); const tail = '{"type":"add","entry":{"id":"m2"';
	legacy(s.file, [s.entry()], tail);
	assert.equal(s.store.entries().length, 1);
	assert.match(s.store.diagnostics.join(" "), /末行已隔离/);
	const quarantined = fs.readdirSync(join(s.file, "..")).find((name) => name.endsWith(".corrupt"));
	assert.ok(quarantined);
	assert.equal(fs.readFileSync(join(s.file, "..", quarantined), "utf8"), tail);
	assert.equal(s.store.add(s.entry("after recovery")).id, "m2");
	assert.equal(new MemoryStore(s.file).entries().length, 2);
});

test("middle corruption, complete malformed events and checksum corruption disable the store", (t) => {
	const s = setup(t);
	legacy(s.file, [s.entry()], '{bad}\n' + JSON.stringify({ type: "remove", id: "m1", at: "2026-09-26T01:00:00Z" }) + "\n");
	const original = fs.readFileSync(s.file, "utf8");
	assert.throws(() => s.store.entries(), /第 2 行损坏/);
	assert.throws(() => s.store.add(s.entry()), /第 2 行损坏/);
	assert.equal(fs.readFileSync(s.file, "utf8"), original);
	legacy(s.file, [s.entry()], JSON.stringify({ type: "remove", id: "m1" }));
	assert.throws(() => s.store.entries(), /格式|内容无效/);
	fs.unlinkSync(s.file); s.store.add(s.entry());
	const snapshot = JSON.parse(fs.readFileSync(s.file, "utf8")); snapshot.entries[0].text = "tampered";
	fs.writeFileSync(s.file, JSON.stringify(snapshot));
	assert.throws(() => s.store.entries(), /校验和错误/);
});

test("schema, byte limit and no-evidence validation do not silently accept bad memory", async (t) => {
	const s = setup(t);
	for (const changed of [
		{ text: "x".repeat(MEMORY_LIMITS.maxNoteChars + 1) },
		{ evidence: [{ path: "../secret", startLine: 1, endLine: 1, sha256: "0".repeat(64) }] },
		{ evidence: [{ path: "package.json", startLine: 0, endLine: 1, sha256: "0".repeat(64) }] },
		{ evidence: [{ path: "package.json", startLine: 1, endLine: 1, sha256: "not-a-hash" }] },
		{ createdAt: "yesterday" }, { fact: { kind: "anything" } },
	]) assert.throws(() => s.store.add({ ...s.entry(), ...changed } as Omit<MemoryEntry, "id">), /格式或大小/);
	const noEvidence = { id: "m1", ...s.entry(), evidence: [] };
	assert.equal(verifyMemory(s.ctx.workspace, [noEvidence]).valid.length, 0);
	assert.equal(verifyMemory(s.ctx.workspace, [noEvidence], { strict: true }).valid.length, 0);
	assert.equal((await s.tool.execute(s.args({ evidence: [null] }), s.ctx)).ok, false);
	assert.equal((await s.tool.execute(s.args({ evidence: [{ path: "package.json", start_line: "2", end_line: 2 }] }), s.ctx)).ok, false);
	assert.equal((await s.tool.execute(s.args({ fact: { kind: "package-script", path: "package.json", selector: "/name", key: "fake" } }), s.ctx)).ok, false);
	fs.mkdirSync(join(s.file, ".."), { recursive: true }); fs.writeFileSync(s.file, " ".repeat(MEMORY_LIMITS.maxFileBytes + 1));
	assert.throws(() => s.store.entries(), /大小超过限制/);
});

test("atomic replacement rejects invalid input and retains old entry after pre-commit failure", (t) => {
	const s = setup(t); const old = s.store.add(s.entry("old"));
	const before = fs.readFileSync(s.file, "utf8");
	assert.throws(() => s.store.replace(old.id, { ...s.entry(), text: "" }), /格式或大小/);
	const rename = fs.renameSync;
	fs.renameSync = (() => { throw new Error("injected rename failure"); }) as typeof fs.renameSync;
	try { assert.throws(() => s.store.replace(old.id, s.entry("new")), /injected rename failure/); }
	finally { fs.renameSync = rename; }
	assert.equal(fs.readFileSync(s.file, "utf8"), before);
	assert.deepEqual(s.store.entries().map((e) => e.text), ["old"]);
	assert.equal(fs.existsSync(`${s.file}.lock`), false);
});

test("revision conflicts, transaction retries and terminal history are enforced", (t) => {
	const s = setup(t); s.store.add(s.entry("old")); const version = s.store.revision();
	const entry = s.entry("new");
	const replacement = s.store.replace("m1", entry, { expectedRevision: version, transactionId: "replace-once" });
	assert.equal(s.store.replace("m1", entry, { expectedRevision: version, transactionId: "replace-once" }).id, replacement.id);
	assert.equal(s.store.revision(), version + 1);
	assert.throws(() => s.store.replace("m1", s.entry("different"), { transactionId: "replace-once" }), /不同内容/);
	assert.throws(() => s.store.add(s.entry(), { expectedRevision: version }), /版本已变化/);
	assert.equal(s.store.remove(replacement.id), true);
	assert.deepEqual(s.store.entries(), []);
	assert.equal(s.store.entries({ includeHistory: true }).length, 2);
	assert.equal(s.store.add(s.entry("third")).id, "m3");
	assert.throws(() => s.store.replace("m1", s.entry()), /当前笔记/);
});

test("legacy tombstones block reused ids, including a remove for a missing record", (t) => {
	const s = setup(t);
	legacy(s.file, [s.entry()], JSON.stringify({ type: "remove", id: "m1", at: "2026-09-26T01:00:00Z" }) + "\n");
	assert.equal(s.store.entries().length, 0);
	assert.equal(s.store.add(s.entry()).id, "m2");
	fs.unlinkSync(s.file);
	legacy(s.file, [], JSON.stringify({ type: "remove", id: "m17", at: "2026-09-26T01:00:00Z" }) + "\n");
	assert.equal(s.store.add(s.entry()).id, "m18");
	legacy(s.file, [s.entry()], JSON.stringify({ type: "remove", id: "m1", at: "2026-09-26T01:00:00Z" }) + "\n" + JSON.stringify({ type: "add", entry: { id: "m1", ...s.entry() } }) + "\n");
	assert.throws(() => s.store.entries(), /编号重复或已撤销/);
});

test("seven process-interruption positions leave a complete old or new snapshot; retry is idempotent", async (t) => {
	for (const stage of ["before-temp", "after-temp", "half-write", "after-write", "before-rename", "after-rename", "directory-sync"]) {
		await t.test(stage, async (childTest) => {
			const s = setup(childTest); s.store.add(s.entry("old"));
			const entry = s.entry("new");
			const script = `
import fs from 'node:fs'; import { MemoryStore } from ${JSON.stringify(moduleUrl)};
const stage = ${JSON.stringify(stage)}; let tempFd; const open = fs.openSync, write = fs.writeFileSync, rename = fs.renameSync, sync = fs.fsyncSync;
fs.openSync = function(path,...args) {
  const temp = String(path).includes('.tmp-'); if(temp && stage==='before-temp') process.exit(91);
  const fd = open.call(fs,path,...args); if(temp) { tempFd=fd; if(stage==='after-temp') process.exit(91); } return fd;
};
fs.writeFileSync = function(file,data,...args) {
  if(file===tempFd && stage==='half-write') { write.call(fs,file,String(data).slice(0,Math.floor(String(data).length/2)),...args); process.exit(91); }
  const result = write.call(fs,file,data,...args); if(file===tempFd && stage==='after-write') process.exit(91); return result;
};
fs.renameSync = function(...args) { if(stage==='before-rename') process.exit(91); const r=rename.apply(fs,args); if(stage==='after-rename') process.exit(91); return r; };
fs.fsyncSync = function(fd) { const r=sync.call(fs,fd); if(stage==='directory-sync' && fs.fstatSync(fd).isDirectory()) process.exit(91); return r; };
new MemoryStore(${JSON.stringify(s.file)}).replace('m1',${JSON.stringify(entry)},{expectedRevision:1,transactionId:'crash-replace'});
`;
			await assert.rejects(run(process.execPath, ["--input-type=module", "-e", script]), (error: unknown) => (error as { code: number }).code === 91);
			// The test owns this child and has confirmed its exit; production never guesses that an old lock is safe.
			assert.equal(fs.existsSync(`${s.file}.lock`), true);
			fs.unlinkSync(`${s.file}.lock`);
			const after = new MemoryStore(s.file);
			const committed = stage === "after-rename" || stage === "directory-sync";
			assert.deepEqual(after.entries().map((e) => e.text), [committed ? "new" : "old"]);
			assert.equal(after.replace("m1", entry, { expectedRevision: 1, transactionId: "crash-replace" }).id, "m2");
			assert.equal(after.revision(), 2);
			assert.deepEqual(after.entries().map((e) => e.text), ["new"]);
		});
	}
});

test("concurrent writers keep unique ids and reject stale shared revisions", async (t) => {
	const s = setup(t);
	const script = (number: number, expectedRevision?: number) => `
import {MemoryStore} from ${JSON.stringify(moduleUrl)};
const store=new MemoryStore(${JSON.stringify(s.file)}); const entry=${JSON.stringify(s.entry())}; entry.text='writer ${number}';
for(let n=0;n<200;n++) { try { const result=store.add(entry,${JSON.stringify(expectedRevision === undefined ? {} : { expectedRevision })}); console.log(result.id); break; }
catch(error) { if(String(error.message).includes('写入者')) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3); continue; } console.log('rejected'); break; } }
`;
	const results = await Promise.all(Array.from({ length: 8 }, (_, n) => run(process.execPath, ["--input-type=module", "-e", script(n)])));
	assert.equal(results.filter((r) => /^m\d+\s*$/.test(r.stdout)).length, 8);
	assert.equal(new Set(s.store.entries().map((e) => e.id)).size, 8);
	const version = s.store.revision();
	const conflicts = await Promise.all(Array.from({ length: 6 }, (_, n) => run(process.execPath, ["--input-type=module", "-e", script(n + 10, version)])));
	assert.equal(conflicts.filter((r) => /^m\d+\s*$/.test(r.stdout)).length, 1);
	assert.equal(s.store.entries().length, 9);
});

test("an old lock is never deleted merely because it is old", (t) => {
	const s = setup(t); s.store.add(s.entry());
	fs.writeFileSync(`${s.file}.lock`, '{"pid":999999999,"at":"2000-01-01T00:00:00Z"}');
	assert.throws(() => s.store.add(s.entry()), /遗留锁/);
	assert.equal(fs.existsSync(`${s.file}.lock`), true);
	assert.equal(s.store.entries().length, 1);
});

test("strict facts expose only a program-read source field, never the model's inference", async (t) => {
	const s = setup(t);
	assert.equal((await s.tool.execute(s.args(), s.ctx)).ok, true);
	const verified = verifyMemory(s.ctx.workspace, s.store.entries(), { strict: true });
	assert.equal(verified.valid.length, 1);
	const text = renderMemory(verified)!;
	assert.match(text, /package\.json \/scripts\/test = "node --test"/);
	assert.doesNotMatch(text, /always passes|every OS/);
	const legacyEntry = s.store.add(s.entry("The tests always pass"));
	const leads = verifyMemory(s.ctx.workspace, [legacyEntry], { strict: true });
	assert.equal(leads.valid.length, 0); assert.doesNotMatch(renderMemory(leads)!, /tests always pass/);
	const compatible = verifyMemory(s.ctx.workspace, [legacyEntry]);
	assert.equal(compatible.valid.length, 1); assert.match(renderMemory(compatible)!, /do not prove their claims/);
});

test("registered file and narrow JSON dependencies invalidate even when evidence lines match", async (t) => {
	for (const kind of ["file", "json-field"] as const) {
		const s = setup(t);
		const dependency = kind === "file" ? { kind, path: "config.json" } : { kind, path: "config.json", selector: "/override" };
		assert.equal((await s.tool.execute(s.args({ dependencies: [dependency] }), s.ctx)).ok, true);
		fs.writeFileSync(join(s.root, "config.json"), '{"override": false, "description": "edited"}\n');
		let checked = verifyMemory(s.ctx.workspace, s.store.entries(), { strict: true });
		assert.equal(checked.valid.length, kind === "file" ? 0 : 1, "whole-file dependency intentionally rejects unrelated edits");
		fs.writeFileSync(join(s.root, "config.json"), '{"override": true, "description": "edited"}\n');
		checked = verifyMemory(s.ctx.workspace, s.store.entries(), { strict: true });
		assert.equal(checked.valid.length, 0);
		assert.equal(checked.stale[0]?.checks[0]?.status, "same");
		assert.ok(checked.stale[0]?.reasons?.includes("dependency-changed"));
	}
});

test("literal source facts survive irrelevant fields; undeclared runtime behavior is never asserted", async (t) => {
	const s = setup(t); await s.tool.execute(s.args(), s.ctx);
	fs.writeFileSync(join(s.root, "config.json"), '{"override": true}\n');
	fs.writeFileSync(join(s.root, "package.json"), '{\n  "name": "fixture",\n  "scripts": {"test": "node --test"},\n  "description": "new"\n}\n');
	let v = verifyMemory(s.ctx.workspace, s.store.entries(), { strict: true });
	assert.equal(v.valid.length, 1, "omitted config dependency cannot invalidate a literal field that is still equal");
	assert.doesNotMatch(renderMemory(v)!, /always passes|every OS|override/);
	const incomplete = { ...s.store.entries()[0]!, coverage: "incomplete" as const };
	v = verifyMemory(s.ctx.workspace, [incomplete], { strict: true });
	assert.equal(v.valid.length, 0);
	assert.ok(v.stale[0]?.reasons?.includes("incomplete-dependencies"));
});

test("canonical fact identity and full-group checks prevent alias and by-id conflict bypasses", async (t) => {
	const s = setup(t); await s.tool.execute(s.args(), s.ctx);
	fs.writeFileSync(join(s.root, "package.json"), '{\n  "name": "fixture",\n  "scripts": {"test": "node custom-test.js"}\n}\n');
	await s.tool.execute(s.args({ fact: { kind: "json-field", path: "./package.json", selector: "/scripts/test" } }), s.ctx);
	const entries = s.store.entries();
	assert.equal(entries[0]?.fact?.key, entries[1]?.fact?.key);
	// Property order cannot hide identical scopes in persisted data.
	const scope = entries[1]!.scope!; entries[1]!.scope = { branch: scope.branch, environment: scope.environment, module: scope.module, workspace: scope.workspace };
	let verified = verifyMemory(s.ctx.workspace, entries, { strict: true });
	assert.equal(verified.valid.length, 0);
	assert.equal(verified.stale.filter((e) => e.reasons?.includes("conflicting-values")).length, 2);
	const queried = await createMemoryQueryTool(s.store).execute({ id: "m2" }, s.ctx);
	assert.deepEqual(queried.details.valid, []);
	assert.match(queried.modelContent, /conflicting-values/);
	assert.doesNotMatch(queried.modelContent, /custom-test/);
	const tampered = { ...entries[1]!, fact: { ...entries[1]!.fact!, key: "my-custom-test-command" } };
	verified = verifyMemory(s.ctx.workspace, [tampered], { strict: true });
	assert.equal(verified.valid.length, 0);
});

test("workspace, runtime, branch, module and renamed-source mismatches stay conservative", async (t) => {
	const s = setup(t);
	execFileSync("git", ["init", "--quiet"], { cwd: s.root });
	await s.tool.execute(s.args(), s.ctx);
	const entries = s.store.entries();
	assert.equal(verifyMemory(s.ctx.workspace, entries, { strict: true, environment: `${memoryEnvironment()}-changed` }).valid.length, 0);
	assert.equal(verifyMemory(s.ctx.workspace, entries, { strict: true, module: "packages/api" }).valid.length, 0);
	const other = join(s.base, "other"); fs.mkdirSync(other); fs.copyFileSync(join(s.root, "package.json"), join(other, "package.json"));
	assert.equal(verifyMemory(new Workspace(other), entries, { strict: true }).valid.length, 0);
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/another"], { cwd: s.root });
	assert.ok(verifyMemory(s.ctx.workspace, entries, { strict: true }).stale[0]?.reasons?.includes("branch-mismatch"));
	fs.renameSync(join(s.root, "package.json"), join(s.root, "renamed.json"));
	assert.equal(verifyMemory(s.ctx.workspace, entries, { strict: true }).valid.length, 0);
});

test("superseded facts never revive after source deletion, restoration or replacement deletion", async (t) => {
	const s = setup(t); const original = fs.readFileSync(join(s.root, "package.json"), "utf8");
	await s.tool.execute(s.args(), s.ctx);
	fs.writeFileSync(join(s.root, "package.json"), original.replace("node --test", "node new.js"));
	assert.equal((await s.tool.execute(s.args({ replaces: "m1" }), s.ctx)).ok, true);
	fs.unlinkSync(join(s.root, "package.json"));
	assert.equal(verifyMemory(s.ctx.workspace, s.store.entries(), { strict: true }).valid.length, 0);
	fs.writeFileSync(join(s.root, "package.json"), original);
	assert.equal(verifyMemory(s.ctx.workspace, s.store.entries({ includeHistory: true }), { strict: true }).valid.length, 0);
	s.store.remove("m2");
	const queried = await createMemoryQueryTool(s.store).execute({ id: "m1" }, s.ctx);
	assert.deepEqual(queried.details.valid, []);
	assert.match(queried.modelContent, /historical/);
	assert.doesNotMatch(queried.modelContent, /node --test/);
});

test("all stale, conflict and fact output shares the same prompt limit, including zero notes", (t) => {
	const s = setup(t);
	const entries: MemoryEntry[] = Array.from({ length: 501 }, (_, n) => ({ id: `m${n + 1}`, ...s.entry(`private old value ${n}`), evidence: [{ path: "missing-" + "x".repeat(1000), startLine: 1, endLine: 1, sha256: "0".repeat(64) }] }));
	const verified = verifyMemory(s.ctx.workspace, entries, { strict: true });
	for (const maxChars of [1, 60, 240, 6000]) {
		const text = renderMemory(verified, { maxNotes: 30, maxChars });
		assert.ok(text !== null && text.length <= maxChars);
		assert.doesNotMatch(text, /private old value/);
	}
	assert.equal(renderMemory(verified, { maxNotes: 0 }), null);
});

test("memory storage stays outside the task repository, including symlinked home overrides", async (t) => {
	const s = setup(t);
	assert.throws(() => memoryFileFor(s.root, join(s.root, "memory-home")), /工作区外/);
	const link = join(s.base, "linked-home"); fs.symlinkSync(s.root, link, "dir");
	assert.throws(() => memoryFileFor(s.root, link), /工作区外/);
	const unsafe = createMemoryTool(new MemoryStore(join(s.root, "memory.jsonl")));
	assert.equal((await unsafe.execute({ note: "x", evidence: [{ path: "package.json", start_line: 2, end_line: 2 }] }, s.ctx)).ok, false);
	assert.equal(fs.existsSync(join(s.root, "memory.jsonl")), false);
	assert.ok(memoryFileFor(s.root, join(s.base, "valid-home")).startsWith(join(s.base, "valid-home")));
});

test("a transaction evicted from the retry table cannot silently create another entry", (t) => {
	const s = setup(t); const entry = s.entry();
	assert.throws(() => s.store.add(entry, { transactionId: "requires-version" }), /原库版本/);
	s.store.add(entry, { transactionId: "once", expectedRevision: 0 });
	for (let n = 0; n < 64; n++) s.store.add(s.entry(`later ${n}`));
	assert.throws(() => s.store.add(entry, { transactionId: "once", expectedRevision: 0 }), /版本已变化/);
	assert.throws(() => s.store.add(entry, { transactionId: "once" }), /原库版本/);
	assert.equal(s.store.entries().length, 65);
});

test("an interrupted migration backup leaves the original recoverable without a partial final backup", async (t) => {
	const s = setup(t); legacy(s.file, [s.entry()]);
	const original = fs.readFileSync(s.file, "utf8");
	const script = `
import fs from 'node:fs'; import {MemoryStore} from ${JSON.stringify(moduleUrl)};
const open=fs.openSync, write=fs.writeFileSync; let backup;
fs.openSync=function(path,...args) {const fd=open.call(fs,path,...args); if(String(path).includes('.bak.tmp-')) backup=fd; return fd;};
fs.writeFileSync=function(file,data,...args) {if(file===backup){write.call(fs,file,String(data).slice(0,10),...args);process.exit(91);}return write.call(fs,file,data,...args);};
new MemoryStore(${JSON.stringify(s.file)}).add(${JSON.stringify(s.entry("second"))});
`;
	await assert.rejects(run(process.execPath, ["--input-type=module", "-e", script]), (error: unknown) => (error as { code: number }).code === 91);
	assert.equal(fs.readFileSync(s.file, "utf8"), original);
	assert.equal(fs.readdirSync(join(s.file, "..")).filter((name) => name.endsWith(".bak")).length, 0);
	fs.unlinkSync(`${s.file}.lock`);
	assert.equal(s.store.add(s.entry("second")).id, "m2");
	const backup = fs.readdirSync(join(s.file, "..")).find((name) => name.endsWith(".bak"))!;
	assert.equal(fs.readFileSync(join(s.file, "..", backup), "utf8"), original);
});

test("retired ids without terminal entry state disable the snapshot, even with a valid checksum", async (t) => {
	const s = setup(t); await s.tool.execute(s.args(), s.ctx);
	const { checksum: _checksum, ...body } = JSON.parse(fs.readFileSync(s.file, "utf8"));
	body.retiredIds = ["m1"];
	fs.writeFileSync(s.file, JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) }));
	assert.throws(() => s.store.entries({ includeHistory: true }), /撤销状态不完整/);
	assert.equal((await createMemoryQueryTool(s.store).execute({ id: "m1" }, s.ctx)).ok, false);
});

test("array pointers read only JSON indices, not JavaScript array properties", async (t) => {
	const s = setup(t); fs.writeFileSync(join(s.root, "data.json"), '{"items":[1,2,3]}');
	for (const selector of ["/items/length", "/items/01", "/items/-1", "/items/3"]) {
		assert.equal((await s.tool.execute(s.args({ fact: { kind: "json-field", path: "data.json", selector } }), s.ctx)).ok, false, selector);
	}
	assert.equal((await s.tool.execute(s.args({ fact: { kind: "json-field", path: "data.json", selector: "/items/0" } }), s.ctx)).ok, true);
	assert.equal(verifyMemory(s.ctx.workspace, s.store.entries(), { strict: true }).valid[0]?.entry.fact?.value, 1);
});

test("a narrow unchanged field refreshes its full source identity after old evidence changes", async (t) => {
	const s = setup(t); await s.tool.execute(s.args(), s.ctx);
	const first = verifyMemory(s.ctx.workspace, s.store.entries(), { strict: true });
	const original = fs.readFileSync(join(s.root, "package.json"), "utf8");
	const changed = original.replace('"name": "fixture"', '"name": "renamed fixture"');
	fs.writeFileSync(join(s.root, "package.json"), changed);
	const second = verifyMemory(s.ctx.workspace, s.store.entries(), { strict: true });
	assert.equal(second.valid.length, 1);
	assert.equal(second.valid[0]?.checks[0]?.status, "changed");
	assert.equal(second.valid[0]?.source?.sha256, sha256(changed));
	assert.notEqual(second.valid[0]?.source?.sha256, first.valid[0]?.source?.sha256);
	assert.match(renderMemory(second)!, /current source: package\.json#\/scripts\/test/);
	assert.doesNotMatch(renderMemory(second)!, /evidence: package\.json:2-2/);
});

test("UTF-8 BOM bytes affect full-source and file-dependency digests", async (t) => {
	const s = setup(t); await s.tool.execute(s.args({ dependencies: [{ kind: "file", path: "config.json" }] }), s.ctx);
	const entry = s.store.entries()[0]!;
	const before = verifyMemory(s.ctx.workspace, [entry], { strict: true });
	const source = join(s.root, "package.json"); const changed = "\uFEFF" + fs.readFileSync(source, "utf8"); fs.writeFileSync(source, changed);
	const after = verifyMemory(s.ctx.workspace, [entry], { strict: true });
	assert.equal(after.valid.length, 1);
	assert.equal(after.valid[0]?.source?.sha256, sha256(fs.readFileSync(source)));
	assert.notEqual(after.valid[0]?.source?.sha256, before.valid[0]?.source?.sha256);
	const config = join(s.root, "config.json"); fs.writeFileSync(config, "\uFEFF" + fs.readFileSync(config, "utf8"));
	assert.ok(verifyMemory(s.ctx.workspace, [entry], { strict: true }).stale[0]?.reasons?.includes("dependency-changed"));
});

test("strict leads and other modules do not rescan sources or crowd out an applicable fact", async (t) => {
	const s = setup(t); await s.tool.execute(s.args(), s.ctx);
	const fact = s.store.entries()[0]!;
	const leads = Array.from({ length: 500 }, (_, i) => ({ ...s.entry(), id: `m${i + 2}` }));
	const otherModules = Array.from({ length: 500 }, (_, i) => ({ ...fact, id: `m${i + 502}`, scope: { ...fact.scope!, module: `packages/module-${i}` } }));
	const open = fs.openSync; let sourceReads = 0;
	fs.openSync = function (path, ...args) {
		if (String(path).startsWith(s.ctx.workspace.root)) sourceReads++;
		return Reflect.apply(open, fs, [path, ...args]);
	} as typeof fs.openSync;
	try {
		const onlyLeads = verifyMemory(s.ctx.workspace, leads, { strict: true });
		assert.equal(onlyLeads.valid.length, 0); assert.equal(sourceReads, 0);
		const mixed = verifyMemory(s.ctx.workspace, [fact, ...otherModules], { strict: true });
		assert.equal(mixed.valid.length, 1); assert.equal(sourceReads, 1);
		const text = renderMemory(mixed, { maxNotes: 5, maxChars: 1500 })!;
		assert.match(text, /node --test/);
		assert.doesNotMatch(text, /module-mismatch/);
	} finally { fs.openSync = open; }
});
