import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { test, type TestContext } from "node:test";
import { Workspace } from "../src/workspace.ts";

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "workspace-portability-"));
	const parent = process.platform === "win32" || process.platform === "darwin" ? realpathSync.native(dir) : realpathSync(dir);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "Workspace"); mkdirSync(root);
	writeFileSync(join(root, "file.txt"), "inside");
	return { parent, root };
}

test("filesystem-root workspaces accept descendants, including drive roots on Windows", t => {
	const { root } = fixture(t);
	const workspace = new Workspace(parse(root).root);
	assert.equal(workspace.resolve(join(root, "file.txt")).abs, realpathSync(join(root, "file.txt")));
	assert.equal(workspace.resolve(join(root, "new", "file.txt"), { forWrite: true }).abs, join(root, "new", "file.txt"));
});

test("workspace containment still rejects parent traversal and similarly prefixed siblings", t => {
	const { parent, root } = fixture(t), workspace = new Workspace(root);
	const sibling = join(parent, "Workspace-other"); mkdirSync(sibling); writeFileSync(join(sibling, "file.txt"), "outside");
	for (const path of [dirname(root), "..", "../Workspace-other/file.txt", join(sibling, "file.txt")]) {
		assert.throws(() => workspace.resolve(path), /越出工作区/);
	}
	assert.throws(() => workspace.resolve("../Workspace-other/new.txt", { forWrite: true }), /越出工作区/);
});

test("case-insensitive workspace aliases resolve to exact filesystem spelling", t => {
	const { parent, root } = fixture(t), workspace = new Workspace(root);
	if (!existsSync(join(root, "FILE.TXT"))) { t.skip("filesystem probe shows case-sensitive entries"); return; }
	assert.deepEqual(workspace.resolve("FILE.TXT"), { abs: join(root, "file.txt"), rel: "file.txt" });
	assert.deepEqual(workspace.resolve(join(root, "FILE.TXT")), { abs: join(root, "file.txt"), rel: "file.txt" });
	if (process.platform === "win32") assert.deepEqual(workspace.resolve(join(root, "file.txt").toUpperCase()), { abs: join(root, "file.txt"), rel: "file.txt" });
	assert.equal(new Workspace(join(parent, "WORKSPACE")).root, root);
	const directory = join(root, "MixedCase"); mkdirSync(directory);
	assert.deepEqual(workspace.resolve("MIXEDCASE/NewFile.txt", { forWrite: true }), { abs: join(directory, "NewFile.txt"), rel: "MixedCase/NewFile.txt" });
	writeFileSync(join(directory, "NewFile.txt"), "new");
	assert.deepEqual(workspace.resolve("mixedcase/newfile.txt"), { abs: join(directory, "NewFile.txt"), rel: "MixedCase/NewFile.txt" });
});

test("case-sensitive filesystem entries remain distinct rather than being case-folded", t => {
	const { parent, root } = fixture(t);
	if (existsSync(join(root, "FILE.TXT"))) { t.skip("filesystem probe shows case-insensitive entries"); return; }
	writeFileSync(join(root, "FILE.TXT"), "different file");
	const workspace = new Workspace(root);
	assert.deepEqual(workspace.resolve("file.txt"), { abs: join(root, "file.txt"), rel: "file.txt" });
	assert.deepEqual(workspace.resolve("FILE.TXT"), { abs: join(root, "FILE.TXT"), rel: "FILE.TXT" });
	const sibling = join(parent, "workspace"); mkdirSync(sibling);
	writeFileSync(join(sibling, "file.txt"), "outside case-sensitive sibling");
	assert.throws(() => workspace.resolve(join(sibling, "file.txt")), /越出工作区/);
});
