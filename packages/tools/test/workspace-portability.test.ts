import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { test, type TestContext } from "node:test";
import { Workspace } from "../src/workspace.ts";

function fixture(t: TestContext) {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "workspace-portability-")));
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

test("Windows absolute workspace paths tolerate different casing", { skip: process.platform !== "win32" }, t => {
	const { root } = fixture(t), workspace = new Workspace(root);
	assert.equal(workspace.resolve(join(root, "file.txt").toUpperCase()).abs.toLowerCase(), join(root, "file.txt").toLowerCase());
});
