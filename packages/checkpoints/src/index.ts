/**
 * 检查点（D-007）：应用数据目录中的影子 Git 仓库。
 * - 独立 GIT_DIR 与 GIT_INDEX_FILE，GIT_WORK_TREE 指向工作区；不修改用户的 index、分支、stash、config
 * - 文件由 Mountains 自己枚举（ripgrep，遵守 .gitignore）并显式 hash-object + update-index 加入，
 *   避开"工作区内嵌套空仓库导致 git add 整体失败"的问题；工具写过的文件无论是否被忽略都强制纳入
 * - 恢复只作用于指定路径；当前哈希与期望不一致（用户同时手动修改）时报告冲突而不覆盖
 * - 非 Git 项目同样可用；所有调用都用 -c 覆盖用户全局配置（autocrlf 等）以保证逐字节一致
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const GIT_CFG = [
	"-c", "core.autocrlf=false",
	"-c", "core.safecrlf=false",
	"-c", "core.symlinks=true",
	"-c", "core.longpaths=true",
	"-c", "core.fsmonitor=false",
	"-c", "core.quotepath=false",
	"-c", `core.hooksPath=${devNull}`,
	"-c", "gc.auto=0",
];

function gitPath(path: string): string {
	// Backslashes are separators on Windows, but valid filename bytes on POSIX.
	return path.split(sep).join("/").replace(/^\.\//, "");
}

function quoteGitPath(path: string): string {
	// hash-object --stdin-paths uses line-delimited, C-quoted paths (not -z).
	return `"${path.replace(/[\\"\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`)}"`;
}

export interface SnapshotResult {
	tree: string;
	files: number;
	skippedSymlinks: number;
	durationMs: number;
}

export interface RestoreResult {
	restored: string[];
	deleted: string[];
	/** 当前内容与期望不符（用户同时修改），未覆盖 */
	conflicts: { path: string; expected: string; actual: string | null }[];
}

export function fileSha256(abs: string): string | null {
	if (!existsSync(abs)) return null;
	return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

export class ShadowCheckpoints {
	readonly workspace: string;
	readonly gitDir: string;
	private readonly indexFile: string;
	private readonly workspaceIdentity: { dev: bigint; ino: bigint };

	constructor(workspace: string, dataDir: string) {
		this.workspace = process.platform === "win32" || process.platform === "darwin" ? realpathSync.native(resolve(workspace)) : realpathSync(resolve(workspace));
		this.workspaceIdentity = statSync(this.workspace, { bigint: true });
		const key = createHash("sha256").update(this.workspace).digest("hex").slice(0, 16);
		this.gitDir = join(dataDir, "checkpoints", key);
		// Each instance owns its staging index; concurrent sessions share only Git objects.
		this.indexFile = join(this.gitDir, `mountains-index-${randomUUID()}`);
		if (!existsSync(join(this.gitDir, "HEAD"))) {
			mkdirSync(this.gitDir, { recursive: true });
			execFileSync("git", ["init", "-q", "--bare", this.gitDir]);
		}
	}

	private git(args: string[], input?: string): string {
		const r = spawnSync("git", [...GIT_CFG, ...args], {
			input,
			cwd: this.workspace,
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
			env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workspace, GIT_INDEX_FILE: this.indexFile },
		});
		if (r.status !== 0) throw new Error(`git ${args[0]} 失败：${r.error?.message ?? r.stderr}`);
		return r.stdout;
	}

	/** Check every component without following symlinks, including missing targets. */
	private checkedPath(path: string): string {
		const parts = path.split(process.platform === "win32" ? /[\\/]/ : /\//);
		if (isAbsolute(path) || parts.includes("..") || (process.platform === "win32" && /^[a-z]:/i.test(path))) throw new Error(`检查点路径越出工作区：${path}`);
		const abs = resolve(this.workspace, path);
		const rel = relative(this.workspace, abs);
		if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`检查点路径越出工作区：${path}`);
		const root = lstatSync(this.workspace, { bigint: true });
		const real = process.platform === "win32" || process.platform === "darwin" ? realpathSync.native(this.workspace) : realpathSync(this.workspace);
		if (!root.isDirectory() || root.isSymbolicLink() || real !== this.workspace || root.dev !== this.workspaceIdentity.dev || root.ino !== this.workspaceIdentity.ino) throw new Error("检查点工作区路径已改变");
		let at = this.workspace;
		const components = rel.split(sep);
		for (const [index, part] of components.entries()) {
			at = join(at, part);
			const st = lstatSync(at, { throwIfNoEntry: false });
			if (!st) break;
			if (st.isSymbolicLink()) throw new Error(`检查点路径不能经过符号链接：${path}`);
			if (index < components.length - 1 ? !st.isDirectory() : !st.isFile()) throw new Error(`检查点路径不是普通文件：${path}`);
		}
		return abs;
	}

	private withIndex<T>(operation: () => T): T {
		try { return operation(); }
		finally { rmSync(this.indexFile, { force: true }); }
	}

	private canonicalPath(path: string): string {
		const p = gitPath(path), abs = join(this.workspace, p);
		// Keep symlinks visible to snapshot's skip check. Existing regular files
		// use native Windows/macOS spelling so aliases do not duplicate entries.
		if (process.platform !== "win32" && process.platform !== "darwin" || !lstatSync(abs, { throwIfNoEntry: false })?.isFile()) return p;
		return gitPath(relative(this.workspace, realpathSync.native(abs)));
	}

	/** 工作区文件清单：遵守 .gitignore，排除 .git，不跟随符号链接；外加强制纳入的路径 */
	listFiles(forced: string[] = []): string[] {
		const r = spawnSync(process.env.MOUNTAINS_RG ?? "rg", ["--files", "--null", "--path-separator", "/", "--hidden", "--sort", "path", "-g", "!.git", "--no-messages"], {
			cwd: this.workspace,
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
		if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error(`rg 文件枚举失败：${r.error?.message ?? r.stderr}`);
		const set = new Set(r.stdout.split("\0").filter(Boolean).map(gitPath));
		for (const f of forced) if (existsSync(join(this.workspace, f))) set.add(this.canonicalPath(f));
		return [...set].sort();
	}

	/** 对工作区做一次树快照（只写对象，不写 ref，不提交） */
	snapshot(forced: string[] = []): SnapshotResult {
		const t0 = Date.now();
		const files: string[] = [];
		let skippedSymlinks = 0;
		for (const f of this.listFiles(forced)) {
			const st = lstatSync(join(this.workspace, f));
			if (st.isSymbolicLink()) skippedSymlinks++;
			else if (st.isFile()) files.push(f);
		}
		return this.withIndex(() => {
			const hashes = files.length ? this.git(["hash-object", "-w", "--stdin-paths", "--no-filters"], `${files.map(quoteGitPath).join("\n")}\n`).trim().split("\n") : [];
			const info = files.map((f, i) => {
				const mode = statSync(join(this.workspace, f)).mode & 0o111 ? "100755" : "100644";
				return `${mode} ${hashes[i]}\t${f}`;
			});
			// A missing index starts empty. update-index builds the full nonempty
			// snapshot directly; only an empty file list needs an explicit empty index.
			if (info.length) this.git(["update-index", "-z", "--index-info"], `${info.join("\0")}\0`);
			else this.git(["read-tree", "--empty"]);
			const tree = this.git(["write-tree"]).trim();
			return { tree, files: files.length, skippedSymlinks, durationMs: Date.now() - t0 };
		});
	}

	/**
	 * Add an existing file omitted from the baseline (for example by .gitignore),
	 * without re-snapshotting other paths or replacing their original contents.
	 * Call once per canonical workspace-relative path, immediately before its
	 * first authorized write. The caller must also remember absent preimages so
	 * a later write to a newly created file cannot turn it into a baseline file.
	 */
	capturePreimage(tree: string, path: string): string {
		const p = this.canonicalPath(path);
		if (this.git(["--literal-pathspecs", "ls-tree", "-z", tree, "--", p])) return tree;
		const st = lstatSync(join(this.workspace, p), { throwIfNoEntry: false });
		if (!st) return tree;
		if (!st.isFile()) throw new Error(`检查点只能保存普通文件：${p}`);
		const hash = this.git(["hash-object", "-w", "--stdin-paths", "--no-filters"], `${quoteGitPath(p)}\n`).trim();
		const mode = st.mode & 0o111 ? "100755" : "100644";
		return this.withIndex(() => {
			this.git(["read-tree", tree]);
			this.git(["update-index", "-z", "--index-info"], `${mode} ${hash}\t${p}\0`);
			return this.git(["write-tree"]).trim();
		});
	}

	/** 快照中某路径的内容；不在快照中返回 null */
	private blobAt(tree: string, path: string): { content: Buffer; executable: boolean } | null {
		const line = this.git(["--literal-pathspecs", "ls-tree", "-z", tree, "--", gitPath(path)]);
		if (!line) return null;
		const [mode, , sha] = line.slice(0, line.indexOf("\t")).split(" ");
		if (!sha) return null;
		const content = execFileSync("git", [...GIT_CFG, "cat-file", "blob", sha], { env: { ...process.env, GIT_DIR: this.gitDir }, maxBuffer: 256 * 1024 * 1024 });
		return { content, executable: mode === "100755" };
	}

	/** 两个快照之间变化的路径（A=新增 M=修改 D=删除） */
	changedPaths(fromTree: string, toTree: string): { status: string; path: string }[] {
		const out = this.git(["diff-tree", "-r", "--no-renames", "--name-status", "-z", fromTree, toTree]);
		const parts = out.split("\0").filter(Boolean);
		const res: { status: string; path: string }[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) res.push({ status: parts[i] ?? "", path: parts[i + 1] ?? "" });
		return res;
	}

	/**
	 * 把指定路径恢复到 tree 中的内容。expected 给出"本次运行结束时"各路径的 sha256：
	 * 当前内容与之不符说明用户同时改过，报告冲突，不覆盖。
	 */
	restore(tree: string, paths: string[], expected: Record<string, string | null> = {}): RestoreResult {
		const result: RestoreResult = { restored: [], deleted: [], conflicts: [] };
		// Validate the entire selection before changing any files.
		for (const p of paths) this.checkedPath(p);
		for (const p of paths) {
			// Git subprocesses can take time. Resolve the preimage before the final
			// path/content checks so edits made during lookup are not overwritten.
			const blob = this.blobAt(tree, p);
			const abs = this.checkedPath(p);
			const actual = fileSha256(abs);
			if (Object.hasOwn(expected, p) && expected[p] !== actual) {
				result.conflicts.push({ path: p, expected: expected[p] ?? "(不存在)", actual });
				continue;
			}
			if (blob === null) {
				if (existsSync(abs)) {
					unlinkSync(abs);
					result.deleted.push(p);
				}
				continue;
			}
			mkdirSync(dirname(abs), { recursive: true });
			this.checkedPath(p);
			const existingMode = lstatSync(abs, { throwIfNoEntry: false })?.mode ?? null;
			const temp = join(dirname(abs), `.mountains-restore-${randomUUID()}`);
			try {
				// Prepare the whole replacement first; an I/O failure must not truncate
				// the current file. Rename also avoids mutating another hard-link name.
				writeFileSync(temp, blob.content, { flag: "wx", mode: 0o600 });
				if (process.platform !== "win32" && existingMode !== null) {
					const execute = (existingMode & 0o111) || ((existingMode & 0o444) >> 2);
					chmodSync(temp, (existingMode & 0o666) | (blob.executable ? execute : 0));
				} else chmodSync(temp, (blob.executable ? 0o777 : 0o666) & ~process.umask());
				this.checkedPath(p);
				const latest = fileSha256(abs);
				if (latest !== actual) {
					result.conflicts.push({ path: p, expected: actual ?? "(不存在)", actual: latest });
					continue;
				}
				renameSync(temp, abs);
				result.restored.push(p);
			} finally { rmSync(temp, { force: true }); }
		}
		return result;
	}
}
