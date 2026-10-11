import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Workspace } from "@mountains/tools";
import { APPROVAL_ACTION_LIMITS, snapshotApprovalAction } from "../src/approval-action.ts";

function fixture(t: TestContext) {
	const base = mkdtempSync(join(tmpdir(), "approval-action-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const root = join(base, "project"); mkdirSync(root);
	const workspace = new Workspace(root);
	return { base, root: workspace.root, workspace };
}

test("same exact action and unchanged filesystem have the same bounded fingerprint", t => {
	const { root, workspace } = fixture(t);
	writeFileSync(join(root, "source.txt"), "PRIVATE_FILE_TEXT_DOES_NOT_AUTHORIZE_ANYTHING");
	const args = { path: "source.txt", oldText: "PRIVATE", newText: "PUBLIC" };
	const before = snapshotApprovalAction(workspace, "file_edit", args);
	const after = snapshotApprovalAction(workspace, "file_edit", structuredClone(args));
	assert.equal(before.fingerprint, after.fingerprint);
	assert.equal(before.risk, "workspace-write");
	assert.equal(before.cwd, root);
	assert.match(before.fingerprint, /^[a-f0-9]{64}$/);
	assert.ok(before.bindings.some(binding => binding.role === "target" && binding.kind === "file" && binding.sha256));
	assert.ok(!JSON.stringify(before).includes("PRIVATE_FILE_TEXT_DOES_NOT_AUTHORIZE_ANYTHING"));
});

test("file content or exact edit arguments changing invalidates the original snapshot", t => {
	const { root, workspace } = fixture(t);
	const args = { path: "a.txt", oldText: "old", newText: "new" };
	writeFileSync(join(root, "a.txt"), "old");
	const before = snapshotApprovalAction(workspace, "file_edit", args);
	assert.notEqual(before.fingerprint, snapshotApprovalAction(workspace, "file_edit", { ...args, newText: "different" }).fingerprint);
	writeFileSync(join(root, "a.txt"), "old but changed");
	const after = snapshotApprovalAction(workspace, "file_edit", args);
	assert.notEqual(before.fingerprint, after.fingerprint);
	assert.notEqual(before.bindings.find(b => b.role === "target")!.sha256, after.bindings.find(b => b.role === "target")!.sha256);
});

test("Windows absolute paths can differ in drive and directory letter case", { skip: process.platform !== "win32" }, t => {
	const { root, workspace } = fixture(t);
	writeFileSync(join(root, "case.txt"), "original");
	const alternate = join(root, "case.txt").toUpperCase();
	const snapshot = snapshotApprovalAction(workspace, "file_write", { path: alternate, content: "next" });
	assert.ok(snapshot.bindings.some(binding => binding.role === "target" && binding.kind === "file"));
	const missing = snapshotApprovalAction(workspace, "file_write", { path: join(root.toUpperCase(), "NEW", "new.txt"), content: "next" });
	assert.ok(missing.bindings.some(binding => binding.role === "target" && binding.kind === "missing"));
	assert.equal(snapshot.fingerprint, snapshotApprovalAction(workspace, "file_write", { path: alternate, content: "next" }).fingerprint);
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", { path: root + "-sibling/file.txt", content: "next" }), /outside/);
});

test("case-insensitive relative aliases bind existing files and missing paths by identity", t => {
	const { root, workspace } = fixture(t);
	writeFileSync(join(root, "case.txt"), "original");
	if (!existsSync(join(root, "CASE.TXT"))) { t.skip("fixture filesystem is case-sensitive"); return; }
	mkdirSync(join(root, "directory"));
	writeFileSync(join(root, "directory", "nested.txt"), "nested");
	const nested = snapshotApprovalAction(workspace, "file_write", { path: "DIRECTORY/NESTED.TXT", content: "next" });
	assert.ok(nested.bindings.some(binding => binding.role === "target" && binding.kind === "file"));
	const existing = snapshotApprovalAction(workspace, "file_write", { path: "CASE.TXT", content: "next" });
	assert.ok(existing.bindings.some(binding => binding.role === "target" && binding.kind === "file"));
	const missing = snapshotApprovalAction(workspace, "file_write", { path: "DIRECTORY/new.txt", content: "new" });
	assert.ok(missing.bindings.some(binding => binding.role === "target" && binding.kind === "missing"));
});

test("native Windows short absolute aliases bind existing and missing targets without changing original arguments", { skip: process.platform !== "win32" }, t => {
	const { base, root, workspace } = fixture(t);
	const alias = join(base, "project");
	if (!/~\d/i.test(alias) || alias === root) { t.skip("the native TEMP path exposes no distinct 8.3 alias"); return; }
	writeFileSync(join(root, "a.txt"), "original");
	const args = { path: join(alias, "a.txt"), content: "next" };
	const before = snapshotApprovalAction(workspace, "file_write", args);
	assert.ok(before.bindings.some(binding => binding.role === "target" && binding.path === join(root, "a.txt") && binding.sha256));
	assert.equal(before.fingerprint, snapshotApprovalAction(workspace, "file_write", args).fingerprint);
	assert.notEqual(before.argsSha256, snapshotApprovalAction(workspace, "file_write", { ...args, path: join(root, "a.txt") }).argsSha256);
	const missing = snapshotApprovalAction(workspace, "file_write", { path: join(alias, "new", "file.txt"), content: "new" });
	assert.ok(missing.bindings.some(binding => binding.role === "target" && binding.path === join(root, "new", "file.txt") && binding.kind === "missing"));
});

test("physical aliases into a workspace subdirectory bind prefix and suffix links and detect retargeting", t => {
	const { base, root, workspace } = fixture(t);
	for (const name of ["first", "second"]) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "a.txt"), "same bytes");
		writeFileSync(join(root, name, "b.txt"), "same bytes");
	}
	const alias = join(base, "external-alias");
	symlinkSync(join(root, "first"), alias, process.platform === "win32" ? "junction" : "dir");
	symlinkSync("a.txt", join(root, "first", "suffix-link"));
	const args = { path: join(alias, "suffix-link"), content: "next" };
	assert.equal(workspace.resolve(args.path).abs, join(root, "first", "a.txt"));
	const before = snapshotApprovalAction(workspace, "file_write", args);
	assert.ok(before.bindings.some(binding => binding.role === "symlink" && binding.path === alias));
	assert.ok(before.bindings.some(binding => binding.role === "symlink" && binding.path === join(root, "first", "suffix-link")));
	assert.ok(before.bindings.some(binding => binding.role === "parent" && binding.path === join(root, "first") && binding.entriesSha256));
	assert.ok(!before.bindings.some(binding => binding.kind === "directory" && binding.path === base), "outside directory entries must not be enumerated");
	assert.equal(before.fingerprint, snapshotApprovalAction(workspace, "file_write", args).fingerprint);
	unlinkSync(join(root, "first", "suffix-link")); symlinkSync("b.txt", join(root, "first", "suffix-link"));
	assert.notEqual(before.fingerprint, snapshotApprovalAction(workspace, "file_write", args).fingerprint, "suffix links remain bound");
	const missingArgs = { path: join(alias, "new", "file.txt"), content: "new" };
	const missing = snapshotApprovalAction(workspace, "file_write", missingArgs);
	assert.ok(missing.bindings.some(binding => binding.role === "target" && binding.kind === "missing" && binding.path === join(root, "first", "new", "file.txt")));
	unlinkSync(alias); symlinkSync(join(root, "second"), alias, process.platform === "win32" ? "junction" : "dir");
	assert.notEqual(missing.fingerprint, snapshotApprovalAction(workspace, "file_write", missingArgs).fingerprint, "alias prefix retargeting invalidates approval");
	const outside = join(base, "outside"); mkdirSync(outside);
	unlinkSync(alias); symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", missingArgs), /outside|越出工作区/);
});

test("same bytes replacing the inode and parent directory identity are both detected", t => {
	const { root, workspace } = fixture(t);
	mkdirSync(join(root, "dir")); writeFileSync(join(root, "dir", "a.txt"), "same");
	const args = { path: "dir/a.txt", content: "next" };
	const before = snapshotApprovalAction(workspace, "file_write", args);
	renameSync(join(root, "dir"), join(root, "old-dir"));
	mkdirSync(join(root, "dir")); writeFileSync(join(root, "dir", "a.txt"), "same");
	const after = snapshotApprovalAction(workspace, "file_write", args);
	assert.notEqual(before.fingerprint, after.fingerprint);
	const parent = (value: typeof before) => value.bindings.find(b => b.role === "parent" && b.path === join(root, "dir"))!;
	assert.notEqual(parent(before).ino, parent(after).ino);
});

test("file creation binds the nearest existing parent and changes when directories or target appear", t => {
	const { root, workspace } = fixture(t);
	const args = { path: "new/sub/file.txt", content: "contents" };
	const missing = snapshotApprovalAction(workspace, "file_write", args);
	assert.equal(missing.bindings.find(b => b.role === "target")!.kind, "missing");
	assert.ok(missing.bindings.some(b => b.role === "parent" && b.path === root));
	mkdirSync(join(root, "new", "sub"), { recursive: true });
	const directories = snapshotApprovalAction(workspace, "file_write", args);
	assert.notEqual(missing.fingerprint, directories.fingerprint);
	writeFileSync(join(root, "new", "sub", "file.txt"), "unexpected file");
	const existing = snapshotApprovalAction(workspace, "file_write", args);
	assert.notEqual(directories.fingerprint, existing.fingerprint);
	assert.equal(existing.bindings.find(b => b.role === "target")!.kind, "file");
});

test("retargeted in-workspace symlinks are bound and outside symlinks are refused", t => {
	const { base, root, workspace } = fixture(t);
	writeFileSync(join(root, "first.txt"), "first"); writeFileSync(join(root, "second.txt"), "second");
	symlinkSync("first.txt", join(root, "alias.txt"));
	const args = { path: "alias.txt", content: "next" };
	const before = snapshotApprovalAction(workspace, "file_write", args);
	assert.equal(before.bindings.find(b => b.role === "symlink")!.linkTarget, "first.txt");
	unlinkSync(join(root, "alias.txt")); symlinkSync("second.txt", join(root, "alias.txt"));
	assert.notEqual(before.fingerprint, snapshotApprovalAction(workspace, "file_write", args).fingerprint);
	writeFileSync(join(base, "outside.txt"), "outside must not be hashed");
	unlinkSync(join(root, "alias.txt")); symlinkSync(join(base, "outside.txt"), join(root, "alias.txt"));
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", args), /outside|越出工作区/);
	assert.equal(readFileSync(join(base, "outside.txt"), "utf8"), "outside must not be hashed");
});

test("command argv script is resolved relative to cwd and changed script invalidates approval", t => {
	const { root, workspace } = fixture(t);
	mkdirSync(join(root, "scripts")); writeFileSync(join(root, "scripts", "check.mjs"), "console.log('a')");
	const args = { argv: [process.execPath, "check.mjs"], cwd: "scripts" };
	const before = snapshotApprovalAction(workspace, "command_run", args);
	const script = before.bindings.find(b => b.role === "argv-path" && b.argumentIndex === 1)!;
	assert.equal(before.cwd, join(root, "scripts")); assert.ok(script.sha256);
	assert.ok(!before.bindings.some(b => b.path === process.execPath));
	writeFileSync(join(root, "scripts", "check.mjs"), "console.log('b')");
	assert.notEqual(before.fingerprint, snapshotApprovalAction(workspace, "command_run", args).fingerprint);
});

test("final symlink includes the resolved target parent identity", t => {
	const { root, workspace } = fixture(t);
	mkdirSync(join(root, "real", "nested"), { recursive: true });
	writeFileSync(join(root, "real", "nested", "a.txt"), "original");
	symlinkSync("real/nested/a.txt", join(root, "alias"));
	const snapshot = snapshotApprovalAction(workspace, "file_edit", { path: "alias", oldText: "original", newText: "changed" });
	assert.ok(snapshot.bindings.some(b => b.role === "parent" && b.path === join(root, "real", "nested") && b.ino));
});

test("command directory argument records identity and metadata changes", t => {
	const { root, workspace } = fixture(t);
	mkdirSync(join(root, "target"));
	const args = { argv: ["ls", "target"] };
	const before = snapshotApprovalAction(workspace, "command_run", args);
	const binding = before.bindings.find(b => b.role === "argv-path")!;
	assert.equal(binding.kind, "directory"); assert.ok(binding.mtimeNs); assert.ok(binding.ino); assert.ok(binding.dev);
	assert.match(binding.entriesSha256!, /^[a-f0-9]{64}$/);
	writeFileSync(join(root, "target", "new.txt"), "new entry");
	const after = snapshotApprovalAction(workspace, "command_run", args);
	assert.notEqual(binding.entriesSha256, after.bindings.find(b => b.role === "argv-path")!.entriesSha256);
	assert.notEqual(before.fingerprint, after.fingerprint);
});

test("direct directory entries invalidate approval even when the directory mtime is restored", t => {
	const { root, workspace } = fixture(t);
	const target = join(root, "target"); mkdirSync(target);
	writeFileSync(join(target, "old.txt"), "old entry");
	const fixedTime = new Date("2020-01-01T00:00:00.000Z");
	utimesSync(target, fixedTime, fixedTime);
	const args = { argv: ["ls", "target"] };
	const before = snapshotApprovalAction(workspace, "command_run", args);
	renameSync(join(target, "old.txt"), join(target, "new.txt"));
	utimesSync(target, fixedTime, fixedTime);
	const renamed = snapshotApprovalAction(workspace, "command_run", args);
	const binding = (snapshot: typeof before) => snapshot.bindings.find(b => b.role === "argv-path")!;
	assert.equal(binding(before).mtimeNs, binding(renamed).mtimeNs);
	assert.notEqual(binding(before).entriesSha256, binding(renamed).entriesSha256);
	assert.notEqual(before.fingerprint, renamed.fingerprint);
	unlinkSync(join(target, "new.txt")); mkdirSync(join(target, "new.txt"));
	utimesSync(target, fixedTime, fixedTime);
	const replaced = snapshotApprovalAction(workspace, "command_run", args);
	assert.equal(binding(renamed).mtimeNs, binding(replaced).mtimeNs);
	assert.notEqual(binding(renamed).entriesSha256, binding(replaced).entriesSha256, "same entry name with a different type is detected");
});

test("directory entry digests are sorted and do not recurse or read child file contents", t => {
	const { root, workspace } = fixture(t);
	const target = join(root, "target"); mkdirSync(target);
	writeFileSync(join(target, "z.txt"), "z"); writeFileSync(join(target, "a.txt"), "a");
	mkdirSync(join(target, "nested")); writeFileSync(join(target, "nested", "inside.txt"), "original");
	const args = { argv: ["ls", "target"] };
	const before = snapshotApprovalAction(workspace, "command_run", args);
	writeFileSync(join(target, "a.txt"), Buffer.alloc(APPROVAL_ACTION_LIMITS.fileBytes + 1));
	writeFileSync(join(target, "nested", "additional.txt"), "not directly in the target");
	const changedContents = snapshotApprovalAction(workspace, "command_run", args);
	assert.equal(before.fingerprint, changedContents.fingerprint, "child contents and descendants remain explicitly unbound");
	unlinkSync(join(target, "a.txt")); unlinkSync(join(target, "z.txt"));
	writeFileSync(join(target, "a.txt"), "a"); writeFileSync(join(target, "z.txt"), "z");
	const reordered = snapshotApprovalAction(workspace, "command_run", args);
	const digest = (snapshot: typeof before) => snapshot.bindings.find(b => b.role === "argv-path")!.entriesSha256;
	assert.equal(digest(before), digest(reordered), "creating identical entry names in a different order does not change their digest");
});

test("directory enumeration rejects excessive entries and total bytes before approving", t => {
	const { root, workspace } = fixture(t);
	const tooMany = join(root, "too-many"); mkdirSync(tooMany);
	for (let n = 0; n <= APPROVAL_ACTION_LIMITS.directoryEntries; n++) writeFileSync(join(tooMany, String(n)), "");
	assert.throws(() => snapshotApprovalAction(workspace, "command_run", { argv: ["ls", "too-many"] }), /directory entry limit/);
	const longNames = join(root, "long-names"); mkdirSync(longNames);
	// Below the entry cap, but both bounded passes exceed the total byte cap.
	for (let n = 0; n < 300; n++) writeFileSync(join(longNames, String(n).padStart(4, "0") + "x".repeat(246)), "");
	assert.throws(() => snapshotApprovalAction(workspace, "command_run", { argv: ["ls", "long-names"] }), /directory byte limit/);
});

test("shell script stays exact and declares incomplete dependency coverage without parsing it", t => {
	const { root, workspace } = fixture(t);
	writeFileSync(join(root, "hidden-dependency.sh"), "first");
	const args = { shellScript: "sh hidden-dependency.sh > out.txt" };
	const before = snapshotApprovalAction(workspace, "command_run", args);
	assert.ok(before.limitations.some(text => /shellScript.*not enumerated/.test(text)));
	assert.ok(!before.bindings.some(binding => binding.path.endsWith("hidden-dependency.sh")));
	writeFileSync(join(root, "hidden-dependency.sh"), "second");
	// Demonstrates the declared limitation; unchanged fingerprint is NOT a safety claim.
	assert.equal(before.fingerprint, snapshotApprovalAction(workspace, "command_run", args).fingerprint);
	assert.notEqual(before.fingerprint, snapshotApprovalAction(workspace, "command_run", { shellScript: args.shellScript + " " }).fingerprint);
});

test("argc and per-file and cumulative content bytes have hard bounds", t => {
	const { root, workspace } = fixture(t);
	assert.throws(() => snapshotApprovalAction(workspace, "command_run", { argv: Array(APPROVAL_ACTION_LIMITS.argv + 1).fill("x") }), /excessive argv/);
	writeFileSync(join(root, "large.bin"), Buffer.alloc(APPROVAL_ACTION_LIMITS.fileBytes + 1));
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", { path: "large.bin", content: "" }), /file read limit/);
	for (let n = 0; n < 5; n++) writeFileSync(join(root, `${n}.bin`), Buffer.alloc(APPROVAL_ACTION_LIMITS.fileBytes));
	assert.throws(() => snapshotApprovalAction(workspace, "command_run", { argv: ["program", "0.bin", "1.bin", "2.bin", "3.bin", "4.bin"] }), /file read limit/);
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", { path: "a", content: "x".repeat(APPROVAL_ACTION_LIMITS.argumentBytes + 1) }), /argument bytes/);
});

test("invalid, outside, missing edit, directory write and unsupported actions fail closed", t => {
	const { root, workspace } = fixture(t);
	assert.throws(() => snapshotApprovalAction(workspace, "file_edit", { path: "missing" }), /文件不存在/);
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", { path: "../outside", content: "" }), /outside/);
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", { path: ".", content: "" }), /regular file/);
	assert.throws(() => snapshotApprovalAction(workspace, "command_run", { argv: ["ls"], cwd: "/" }), /outside/);
	assert.throws(() => snapshotApprovalAction(workspace, "command_run", { argv: ["ls"], shellScript: "pwd" }), /exclusively/);
	assert.throws(() => snapshotApprovalAction(workspace, "command_run", { argv: ["a\0b"] }), /invalid/);
	assert.throws(() => snapshotApprovalAction(workspace, "arbitrary", {}), /unsupported tool/);
	symlinkSync("missing-target", join(root, "dangling"));
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", { path: "dangling", content: "" }));
});

test("parameter accessors and non-JSON objects are never executed or accepted", t => {
	const { workspace } = fixture(t);
	let calls = 0;
	const args = Object.defineProperty({}, "path", { enumerable: true, get() { calls++; return "a"; } });
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", args), /accessors/);
	assert.equal(calls, 0);
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", { path: "a", content: new Date() }), /plain JSON/);
	const hidden = Object.defineProperty({}, "path", { get() { calls++; return "a"; } });
	assert.throws(() => snapshotApprovalAction(workspace, "file_write", hidden), /accessors/);
	const argv = ["ls"];
	Object.defineProperty(argv, "map", { enumerable: true, value() { calls++; return []; } });
	assert.throws(() => snapshotApprovalAction(workspace, "command_run", { argv }), /extended argument arrays/);
	assert.equal(calls, 0);
});
