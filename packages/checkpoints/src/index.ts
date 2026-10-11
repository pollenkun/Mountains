/**
 * 检查点（D-007）：应用数据目录中的影子 Git 仓库。
 * - 独立 GIT_DIR 与 GIT_INDEX_FILE，GIT_WORK_TREE 指向工作区；不修改用户的 index、分支、stash、config
 * - 文件由 Mountains 自己枚举（ripgrep，遵守 .gitignore）并显式 hash-object + update-index 加入，
 *   避开"工作区内嵌套空仓库导致 git add 整体失败"的问题；工具写过的文件无论是否被忽略都强制纳入
 * - 恢复只作用于指定路径；当前哈希与期望不一致（用户同时手动修改）时报告冲突而不覆盖
 * - 非 Git 项目同样可用；所有调用都用 -c 覆盖用户全局配置（autocrlf 等）以保证逐字节一致
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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

	constructor(workspace: string, dataDir: string) {
		this.workspace = realpathSync(resolve(workspace));
		const key = createHash("sha256").update(this.workspace).digest("hex").slice(0, 16);
		this.gitDir = join(dataDir, "checkpoints", key);
		this.indexFile = join(this.gitDir, "mountains-index");
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

	/** 工作区文件清单：遵守 .gitignore，排除 .git，不跟随符号链接；外加强制纳入的路径 */
	listFiles(forced: string[] = []): string[] {
		const r = spawnSync(process.env.MOUNTAINS_RG ?? "rg", ["--files", "--null", "--path-separator", "/", "--hidden", "--sort", "path", "-g", "!.git", "--no-messages"], {
			cwd: this.workspace,
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
		if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error(`rg 文件枚举失败：${r.error?.message ?? r.stderr}`);
		const set = new Set(r.stdout.split("\0").filter(Boolean).map(gitPath));
		for (const f of forced) if (existsSync(join(this.workspace, f))) set.add(gitPath(f));
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
		if (existsSync(this.indexFile)) rmSync(this.indexFile);
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
		for (const p of paths) {
			const abs = join(this.workspace, p);
			const actual = fileSha256(abs);
			if (p in expected && expected[p] !== actual) {
				result.conflicts.push({ path: p, expected: expected[p] ?? "(不存在)", actual });
				continue;
			}
			const blob = this.blobAt(tree, p);
			if (blob === null) {
				if (existsSync(abs)) {
					unlinkSync(abs);
					result.deleted.push(p);
				}
				continue;
			}
			mkdirSync(dirname(abs), { recursive: true });
			const existingMode = existsSync(abs) ? statSync(abs).mode : null;
			writeFileSync(abs, blob.content, { mode: blob.executable ? 0o777 : 0o666 });
			if (process.platform !== "win32" && existingMode !== null) {
				// Git records only executable/non-executable modes. Preserve the
				// existing access scope: keep existing execute bits, or restore them
				// only for classes already allowed to read. New files respect umask.
				const execute = (existingMode & 0o111) || ((existingMode & 0o444) >> 2);
				chmodSync(abs, (existingMode & 0o666) | (blob.executable ? execute : 0));
			}
			result.restored.push(p);
		}
		return result;
	}
}
