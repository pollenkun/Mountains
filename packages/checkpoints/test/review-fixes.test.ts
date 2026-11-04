import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ShadowCheckpoints } from "../src/index.ts";

// Review B03: snapshots hold private files verbatim, and a restored file keeps its permissions.
test("B03: the checkpoint store is owner-only and a deleted 0600 file comes back as 0600", { skip: process.platform === "win32" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-checkpoint-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"), data = join(root, "data");
	mkdirSync(workspace);
	writeFileSync(join(workspace, ".env"), "SECRET_FIXTURE=1\n"); chmodSync(join(workspace, ".env"), 0o600);
	writeFileSync(join(workspace, "readme.txt"), "public\n"); chmodSync(join(workspace, "readme.txt"), 0o644);
	const checkpoints = new ShadowCheckpoints(workspace, data);
	assert.equal(statSync(checkpoints.gitDir).mode & 0o777, 0o700);
	const { tree } = checkpoints.snapshot([".env"]);
	unlinkSync(join(workspace, ".env")); unlinkSync(join(workspace, "readme.txt"));
	const result = checkpoints.restore(tree, [".env", "readme.txt"]);
	assert.deepEqual(result.restored.sort(), [".env", "readme.txt"]);
	assert.equal(statSync(join(workspace, ".env")).mode & 0o777, 0o600, "the private file stays private");
	assert.equal(statSync(join(workspace, "readme.txt")).mode & 0o777, 0o644 & ~process.umask(), "an ordinary file keeps the default");
});

// Review A04: what a snapshot accepts, a restore can bring back; the blob is streamed to disk, not buffered.
test("A04: a large file restores byte for byte through the streamed path", (t) => {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-checkpoint-large-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	const bytes = Buffer.alloc(6 * 1024 * 1024);
	for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
	writeFileSync(join(workspace, "large.bin"), bytes);
	const checkpoints = new ShadowCheckpoints(workspace, join(root, "data"));
	const { tree } = checkpoints.snapshot();
	writeFileSync(join(workspace, "large.bin"), "changed");
	assert.deepEqual(checkpoints.restore(tree, ["large.bin"]).restored, ["large.bin"]);
	assert.ok(readFileSync(join(workspace, "large.bin")).equals(bytes));
});
