import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ShadowCheckpoints, fileSha256 } from "../src/index.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-checkpoint-isolation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"); mkdirSync(workspace);
	const data = join(root, "data");
	const checkpoint = new ShadowCheckpoints(workspace, data);
	return { root, workspace, data, checkpoint };
}

test("restore refuses a replaced parent directory before reading or writing outside the workspace", t => {
	const { root, workspace, checkpoint } = fixture(t);
	const directory = join(workspace, "sub"); mkdirSync(directory);
	writeFileSync(join(directory, "a.txt"), "original\n");
	const tree = checkpoint.snapshot().tree;
	const outside = join(root, "outside"); mkdirSync(outside);
	writeFileSync(join(outside, "a.txt"), "last agent content\n");
	const expected = fileSha256(join(outside, "a.txt"));
	renameSync(directory, join(workspace, "saved"));
	symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => checkpoint.restore(tree, ["sub/a.txt"], { "sub/a.txt": expected }), /符号链接/);
	assert.equal(readFileSync(join(outside, "a.txt"), "utf8"), "last agent content\n");
	assert.equal(readFileSync(join(workspace, "saved/a.txt"), "utf8"), "original\n");
});

test("restore refuses final symlinks and dangling symlinks", { skip: process.platform === "win32" }, t => {
	const { root, workspace, checkpoint } = fixture(t);
	const path = join(workspace, "a.txt"); writeFileSync(path, "original\n");
	const tree = checkpoint.snapshot().tree;
	const outside = join(root, "outside.txt"); writeFileSync(outside, "last agent content\n");
	for (const target of [outside, join(root, "missing.txt")]) {
		rmSync(path); symlinkSync(target, path);
		assert.throws(() => checkpoint.restore(tree, ["a.txt"]), /符号链接/);
		assert.equal(readFileSync(outside, "utf8"), "last agent content\n");
		assert.equal(existsSync(join(root, "missing.txt")), false);
	}
});

test("restore rejects outside selections before mutating any valid selected file", t => {
	const { root, workspace, checkpoint } = fixture(t);
	const path = join(workspace, "a.txt"); writeFileSync(path, "original\n");
	const tree = checkpoint.snapshot().tree;
	writeFileSync(path, "changed\n");
	const outside = join(root, "outside.txt"); writeFileSync(outside, "outside\n");
	assert.throws(() => checkpoint.restore(tree, ["a.txt", "../outside.txt"]), /越出工作区/);
	assert.equal(readFileSync(path, "utf8"), "changed\n");
	assert.equal(readFileSync(outside, "utf8"), "outside\n");
});

// Interleave at a Git boundary deterministically, as a second CLI process can do.
type GitHost = { git(args: string[], input?: string): string };
function beforeGit(checkpoint: ShadowCheckpoints, command: string, callback: () => void) {
	const host = checkpoint as unknown as GitHost;
	const original = host.git.bind(checkpoint);
	let entered = false;
	host.git = (args, input) => {
		if (!entered && args.includes(command)) { entered = true; callback(); }
		return original(args, input);
	};
}

test("restore detects user edits made while Git retrieves the preimage", t => {
	const { workspace, checkpoint } = fixture(t);
	const path = join(workspace, "a.txt"); writeFileSync(path, "original\n");
	const tree = checkpoint.snapshot().tree;
	writeFileSync(path, "agent\n"); const expected = fileSha256(path);
	beforeGit(checkpoint, "ls-tree", () => writeFileSync(path, "new user edit\n"));
	const result = checkpoint.restore(tree, ["a.txt"], { "a.txt": expected });
	assert.equal(result.conflicts.length, 1);
	assert.deepEqual(result.restored, []);
	assert.equal(readFileSync(path, "utf8"), "new user edit\n");
});

test("restore replaces a file without modifying its other hard-link name", t => {
	const { root, workspace, checkpoint } = fixture(t);
	const path = join(workspace, "a.txt"); writeFileSync(path, "original\n");
	const tree = checkpoint.snapshot().tree;
	writeFileSync(path, "agent\n");
	const other = join(root, "other.txt"); linkSync(path, other);
	checkpoint.restore(tree, ["a.txt"]);
	assert.equal(readFileSync(path, "utf8"), "original\n");
	assert.equal(readFileSync(other, "utf8"), "agent\n");
	assert.ok(!readdirSync(workspace).some(name => name.startsWith(".mountains-restore-")));
});

for (const operation of ["snapshot", "capturePreimage"] as const) {
	test(`${operation} keeps its own index when a second session snapshots the same workspace`, t => {
		const { workspace, data, checkpoint } = fixture(t);
		execFileSync("git", ["init", "-q"], { cwd: workspace });
		writeFileSync(join(workspace, ".gitignore"), "*.txt\n");
		writeFileSync(join(workspace, "a.txt"), "A\n"); writeFileSync(join(workspace, "b.txt"), "B\n");
		const baseline = checkpoint.snapshot().tree;
		const other = new ShadowCheckpoints(workspace, data);
		beforeGit(checkpoint, "write-tree", () => { other.snapshot(["b.txt"]); });
		const tree = operation === "snapshot" ? checkpoint.snapshot(["a.txt"]).tree : checkpoint.capturePreimage(baseline, "a.txt");
		assert.deepEqual(checkpoint.changedPaths(baseline, tree), [{ status: "A", path: "a.txt" }]);
		assert.ok(!readdirSync(checkpoint.gitDir).some(name => name.startsWith("mountains-index")), "operation indexes must be cleaned up");
	});
}

test("failed snapshot removes its private index", t => {
	const { workspace, checkpoint } = fixture(t);
	writeFileSync(join(workspace, "a.txt"), "A\n");
	beforeGit(checkpoint, "write-tree", () => { throw new Error("simulated Git failure"); });
	assert.throws(() => checkpoint.snapshot(), /simulated Git failure/);
	assert.ok(!readdirSync(checkpoint.gitDir).some(name => name.startsWith("mountains-index")));
});


test("restore refuses a replacement workspace at the same pathname", t => {
	const { root, workspace, checkpoint } = fixture(t);
	writeFileSync(join(workspace, "a.txt"), "original\n");
	const tree = checkpoint.snapshot().tree;
	writeFileSync(join(workspace, "a.txt"), "agent\n");
	const expected = fileSha256(join(workspace, "a.txt"));
	renameSync(workspace, join(root, "saved")); mkdirSync(workspace);
	writeFileSync(join(workspace, "a.txt"), "agent\n");
	assert.throws(() => checkpoint.restore(tree, ["a.txt"], { "a.txt": expected }), /工作区路径已改变/);
	assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "agent\n");
});

test("restore staging is private before any preimage bytes are written", { skip: process.platform === "win32" }, t => {
	const { workspace, checkpoint } = fixture(t);
	const path = join(workspace, "private.txt"); writeFileSync(path, "private preimage\n"); chmodSync(path, 0o600);
	const tree = checkpoint.snapshot().tree; writeFileSync(path, "agent\n");
	const original = fs.writeFileSync;
	const mask = process.umask(0o022);
	let observed = false;
	fs.writeFileSync = ((file: Parameters<typeof original>[0], ...args: unknown[]) => {
		const result = (original as (...args: unknown[]) => void)(file, ...args);
		if (String(file).includes(".mountains-restore-")) {
			observed = true;
			assert.equal(statSync(String(file)).mode & 0o077, 0, "temporary preimage bytes must never be readable by other users");
		}
		return result;
	}) as typeof original;
	syncBuiltinESMExports();
	try { checkpoint.restore(tree, ["private.txt"]); }
	finally { fs.writeFileSync = original; syncBuiltinESMExports(); process.umask(mask); }
	assert.equal(observed, true);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(readFileSync(path, "utf8"), "private preimage\n");
});
