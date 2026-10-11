import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileSha256, ShadowCheckpoints } from "../src/index.ts";

function userGitFingerprint(dir: string): string {
	const parts = [
		readFileSync(join(dir, ".git", "index")).toString("base64"),
		execFileSync("git", ["for-each-ref"], { cwd: dir, encoding: "utf8" }),
		readFileSync(join(dir, ".git", "HEAD"), "utf8"),
		execFileSync("git", ["stash", "list"], { cwd: dir, encoding: "utf8" }),
		readFileSync(join(dir, ".git", "config"), "utf8"),
	];
	return createHash("sha256").update(parts.join("|")).digest("hex");
}

describe("影子 Git 检查点", () => {
	test("空清单与非空清单切换，删除的旧文件不会留在新快照中", (t) => {
		const root = mkdtempSync(join(tmpdir(), "ckpt-transitions-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const ws = join(root, "workspace");
		mkdirSync(ws);
		const ck = new ShadowCheckpoints(ws, join(root, "data"));
		const empty = ck.snapshot();
		assert.equal(empty.files, 0);
		writeFileSync(join(ws, "old.txt"), "original\n");
		const first = ck.snapshot();
		assert.deepEqual(ck.changedPaths(empty.tree, first.tree), [{ status: "A", path: "old.txt" }]);
		rmSync(join(ws, "old.txt"));
		writeFileSync(join(ws, "new.txt"), "replacement\n");
		const replacement = ck.snapshot();
		assert.equal(replacement.files, 1);
		assert.deepEqual(ck.changedPaths(first.tree, replacement.tree), [
			{ status: "A", path: "new.txt" }, { status: "D", path: "old.txt" },
		]);
		rmSync(join(ws, "new.txt"));
		const emptyAgain = ck.snapshot();
		assert.equal(emptyAgain.tree, empty.tree);
		assert.deepEqual(ck.changedPaths(replacement.tree, emptyAgain.tree), [{ status: "D", path: "new.txt" }]);
		assert.deepEqual(ck.restore(first.tree, ["old.txt"]).restored, ["old.txt"]);
		assert.equal(readFileSync(join(ws, "old.txt"), "utf8"), "original\n");
		assert.equal(ck.snapshot().tree, first.tree);
	});

	test("快照保留可执行位，并识别仅权限变化", { skip: process.platform === "win32" }, (t) => {
		const root = mkdtempSync(join(tmpdir(), "ckpt-modes-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const ws = join(root, "workspace");
		mkdirSync(ws);
		const script = join(ws, "run.sh");
		writeFileSync(script, "#!/bin/sh\nprintf 'ok\\n'\n");
		chmodSync(script, 0o755);
		const ck = new ShadowCheckpoints(ws, join(root, "data"));
		const executable = ck.snapshot();
		const treeEntry = (tree: string) => execFileSync("git", ["--git-dir", ck.gitDir, "ls-tree", tree, "--", "run.sh"], { encoding: "utf8" });
		assert.match(treeEntry(executable.tree), /^100755 blob /);
		chmodSync(script, 0o644);
		const plain = ck.snapshot();
		assert.match(treeEntry(plain.tree), /^100644 blob /);
		assert.deepEqual(ck.changedPaths(executable.tree, plain.tree), [{ status: "M", path: "run.sh" }]);
		assert.equal(treeEntry(executable.tree).split(/\s+/)[2], treeEntry(plain.tree).split(/\s+/)[2], "内容不变，只记录权限变化");
	});

	test("多文件修改撤回后逐字节一致；不改动用户的 index/refs/stash/config", () => {
		const ws = mkdtempSync(join(tmpdir(), "ckpt-ws-"));
		const data = mkdtempSync(join(tmpdir(), "ckpt-data-"));
		execFileSync("git", ["init", "-q"], { cwd: ws });
		mkdirSync(join(ws, "中文 目录"));
		writeFileSync(join(ws, "crlf.txt"), "a\r\nb\r\n");
		writeFileSync(join(ws, "bin.dat"), Buffer.from([0, 1, 2, 255, 0]));
		writeFileSync(join(ws, "中文 目录", "文件 一.txt"), "你好\n");
		execFileSync("git", ["add", "-A"], { cwd: ws });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
		writeFileSync(join(ws, "wip.txt"), "wip\n");
		execFileSync("git", ["stash", "-u", "-q"], { cwd: ws });
		const before = userGitFingerprint(ws);
		const ck = new ShadowCheckpoints(ws, data);
		const snap = ck.snapshot();
		const originals = Object.fromEntries(["crlf.txt", "bin.dat", "中文 目录/文件 一.txt"].map((p) => [p, readFileSync(join(ws, p))]));
		// agent 的修改：改 CRLF、改二进制、删文件、新增文件
		writeFileSync(join(ws, "crlf.txt"), "changed\n");
		writeFileSync(join(ws, "bin.dat"), Buffer.from([9]));
		execFileSync("rm", [join(ws, "中文 目录", "文件 一.txt")]);
		writeFileSync(join(ws, "added.txt"), "new\n");
		const after = ck.snapshot();
		const changed = ck.changedPaths(snap.tree, after.tree).map((c) => c.path);
		assert.deepEqual(changed.sort(), ["added.txt", "bin.dat", "crlf.txt", "中文 目录/文件 一.txt"].sort());
		const r = ck.restore(snap.tree, changed);
		assert.equal(r.conflicts.length, 0);
		for (const [p, buf] of Object.entries(originals)) assert.ok(readFileSync(join(ws, p)).equals(buf), `${p} 逐字节一致`);
		assert.equal(existsSync(join(ws, "added.txt")), false);
		assert.equal(userGitFingerprint(ws), before, "用户 Git 状态未变");
	});

	test("用户同时手动修改的文件产生冲突提示而不是被覆盖", () => {
		const ws = mkdtempSync(join(tmpdir(), "ckpt-ws-"));
		const ck = new ShadowCheckpoints(ws, mkdtempSync(join(tmpdir(), "ckpt-data-")));
		writeFileSync(join(ws, "a.txt"), "v1\n");
		const snap = ck.snapshot();
		writeFileSync(join(ws, "a.txt"), "v2 by agent\n");
		const agentHash = fileSha256(join(ws, "a.txt"));
		writeFileSync(join(ws, "a.txt"), "v3 by user\n");
		const r = ck.restore(snap.tree, ["a.txt"], { "a.txt": agentHash });
		assert.equal(r.conflicts.length, 1);
		assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "v3 by user\n");
	});

	test("非 Git 目录可用；工作区内嵌套的空仓库不影响快照", () => {
		const ws = mkdtempSync(join(tmpdir(), "ckpt-ws-"));
		const ck = new ShadowCheckpoints(ws, mkdtempSync(join(tmpdir(), "ckpt-data-")));
		mkdirSync(join(ws, "vendor", "lib"), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: join(ws, "vendor", "lib") });
		writeFileSync(join(ws, "vendor", "lib", "inner.txt"), "inner\n");
		writeFileSync(join(ws, "top.txt"), "top\n");
		const snap = ck.snapshot();
		assert.equal(snap.files, 2);
		writeFileSync(join(ws, "vendor", "lib", "inner.txt"), "changed\n");
		ck.restore(snap.tree, ["vendor/lib/inner.txt"]);
		assert.equal(readFileSync(join(ws, "vendor", "lib", "inner.txt"), "utf8"), "inner\n");
		assert.equal(existsSync(join(ws, ".git")), false, "不在工作区创建 .git");
	});

	test("被 .gitignore 忽略但工具写过的文件可强制纳入", () => {
		const ws = mkdtempSync(join(tmpdir(), "ckpt-ws-"));
		execFileSync("git", ["init", "-q"], { cwd: ws });
		writeFileSync(join(ws, ".gitignore"), ".env\n");
		writeFileSync(join(ws, ".env"), "A=1\n");
		const ck = new ShadowCheckpoints(ws, mkdtempSync(join(tmpdir(), "ckpt-data-")));
		const plain = ck.listFiles();
		assert.ok(!plain.includes(".env"));
		const snap = ck.snapshot([".env"]);
		writeFileSync(join(ws, ".env"), "A=2\n");
		ck.restore(snap.tree, [".env"]);
		assert.equal(readFileSync(join(ws, ".env"), "utf8"), "A=1\n");
	});
});
