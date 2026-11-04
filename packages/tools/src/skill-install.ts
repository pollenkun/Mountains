import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseSkillFile, SKILL_LIMITS, SKILL_NAME, SkillFormatError } from "./skills.ts";

const exec = promisify(execFile);
const ARCHIVE_BYTES = 20 * 1024 * 1024;
const TREE_BYTES = 8 * 1024 * 1024;
const TREE_FILES = 200;
const FILE_BYTES = 4 * 1024 * 1024;

export interface InstalledSkill { name: string; dir: string; source: string }
export interface SkillInstallReport { installed: InstalledSkill[]; failed: { source: string; error: string }[] }

/** A GitHub file or repository, or a direct SKILL.md / archive link. Other addresses are not skills. */
export function skillRemote(url: string): { kind: "github"; owner: string; repo: string; ref?: string; path?: string } | { kind: "file"; url: string } | null {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return null; }
	if (parsed.protocol !== "https:") return null;
	const parts = parsed.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
	if (parsed.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
		const [owner, repo, ref, ...rest] = parts;
		return github(owner, repo, ref, rest.join("/"));
	}
	if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
		if (parts.length < 2) return null;
		const repo = parts[1]!.replace(/\.git$/, "");
		if (parts.length === 2) return github(parts[0], repo);
		const marker = parts[2];
		if ((marker === "tree" || marker === "blob") && parts.length >= 4) return github(parts[0], repo, parts[3], parts.slice(4).join("/") || undefined);
		return null;
	}
	if (/\/SKILL\.md$/i.test(parsed.pathname) || /\.(?:zip|tgz|tar\.gz)$/i.test(parsed.pathname)) return { kind: "file", url: parsed.toString() };
	return null;
}

function github(owner: string | undefined, repo: string | undefined, ref?: string, path?: string): { kind: "github"; owner: string; repo: string; ref?: string; path?: string } | null {
	if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
	if (ref !== undefined && !/^[\w./-]+$/.test(ref)) return null;
	return { kind: "github", owner, repo, ...(ref ? { ref } : {}), ...(path ? { path } : {}) };
}

/** Install skills named in a message or dropped as files into `dest` (one folder per skill name). */
export async function installSkillSources(input: { text?: string; paths?: string[]; dest: string; fetch?: typeof fetch }): Promise<SkillInstallReport> {
	const report: SkillInstallReport = { installed: [], failed: [] };
	const sources = [...(input.paths ?? []), ...sourcesIn(input.text ?? "")];
	const seen = new Set<string>();
	for (const source of sources) {
		if (seen.has(source)) continue;
		seen.add(source);
		let found: { dir: string; owned: boolean }[] | null = null;
		try {
			found = await skillDirs(source, input.fetch ?? fetch);
			if (!found) continue;
			for (const item of found) {
				const installed = installSkillDir(item.dir, input.dest, source);
				if (!report.installed.some(skill => skill.name === installed.name)) report.installed.push(installed);
			}
		} catch (error) {
			report.failed.push({ source, error: error instanceof Error ? error.message : String(error) });
		} finally {
			for (const item of found ?? []) if (item.owned) rmSync(item.dir, { recursive: true, force: true });
		}
	}
	return report;
}

function sourcesIn(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/https:\/\/[^\s<>)\]]+/g)) {
		const url = match[0].replace(/[.,;:]+$/, "");
		if (skillRemote(url)) found.push(url);
	}
	for (const token of text.split(/\s+/)) {
		const clean = token.replace(/^["']|["']$/g, "");
		if (!/[\\/]|\.(?:md|zip|tgz|tar\.gz)$/i.test(clean) || !existsSync(clean)) continue;
		found.push(clean);
	}
	return found;
}

async function skillDirs(source: string, fetchImpl: typeof fetch): Promise<{ dir: string; owned: boolean }[] | null> {
	const lower = source.toLowerCase();
	if (!/^https?:\/\//.test(source)) {
		if (existsSync(source) && (lower.endsWith(".zip") || lower.endsWith(".tgz") || lower.endsWith(".tar.gz"))) {
			try { return (await extractSkillDirs(source)).map(dir => ({ dir, owned: true })); }
			catch (error) { if (error instanceof Error && error.message === "压缩包里没有 SKILL.md") return null; throw error; }
		}
		const local = localSkillDirs(source);
		return local ? local.map(dir => ({ dir, owned: false })) : null;
	}
	const remote = skillRemote(source);
	if (!remote) return null;
	if (remote.kind === "file") {
		const file = await download(remote.url, remote.url.toLowerCase().endsWith(".md") ? SKILL_LIMITS.bodyBytes : ARCHIVE_BYTES, fetchImpl);
		const temp = mkdtempSync(join(tmpdir(), "mountains-skill-"));
		try {
			if (remote.url.toLowerCase().endsWith(".md")) {
				const path = join(temp, "SKILL.md");
				writeFileSync(path, file);
				const found = localSkillDirs(path);
				if (!found?.length) throw new SkillFormatError("这不是一个技能文件");
				return found.map(dir => ({ dir: keep(dir), owned: true }));
			}
			const archive = join(temp, "skill.archive");
			writeFileSync(archive, file);
			return (await extractSkillDirs(archive)).map(dir => ({ dir, owned: true }));
		} finally { rmSync(temp, { recursive: true, force: true }); }
	}
	const ref = remote.ref ?? await defaultBranch(remote.owner, remote.repo, fetchImpl);
	const packed = await download(`https://codeload.github.com/${remote.owner}/${remote.repo}/tar.gz/refs/heads/${encodeURIComponent(ref)}`, ARCHIVE_BYTES, fetchImpl);
	const temp = mkdtempSync(join(tmpdir(), "mountains-skill-"));
	try {
		const archive = join(temp, "repo.tar.gz");
		writeFileSync(archive, packed);
		const extracted = join(temp, "repo");
		mkdirSync(extracted);
		await exec("tar", ["-xzf", archive, "-C", extracted], { timeout: 30_000 });
		const tops = readdirSync(extracted).filter(name => !name.startsWith("."));
		if (tops.length !== 1) throw new Error("仓库里没有技能");
		let base = join(extracted, tops[0]!);
		if (remote.path) base = join(base, ...remote.path.split("/").filter(Boolean));
		if (remote.path?.endsWith("SKILL.md")) base = dirname(base);
		const found = findSkillDirs(base, 0, 3);
		if (!found.length) throw new Error("这里没有 SKILL.md");
		return found.map(dir => ({ dir: keep(dir), owned: true }));
	} finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Copy a tree out of a directory that is about to be deleted. */
function keep(dir: string): string {
	const dest = mkdtempSync(join(tmpdir(), "mountains-skill-kept-"));
	copyTree(dir, dest);
	return dest;
}

function localSkillDirs(source: string): string[] | null {
	if (!existsSync(source)) return null;
	const st = lstatSync(source);
	if (st.isSymbolicLink()) return null;
	if (st.isFile()) {
		if (basename(source) !== "SKILL.md") return null;
		return [dirname(source)];
	}
	if (!st.isDirectory()) return null;
	const found = findSkillDirs(source, 0, 3);
	return found.length ? found : null;
}

function findSkillDirs(root: string, depth: number, maxDepth: number): string[] {
	let st;
	try { st = lstatSync(root); } catch { return []; }
	if (!st.isDirectory() || st.isSymbolicLink()) return [];
	if (existsSync(join(root, "SKILL.md"))) return [root];
	if (depth >= maxDepth) return [];
	const out: string[] = [];
	for (const name of readdirSync(root)) {
		if (name === "node_modules" || name === "dist" || name === "build" || name === ".git") continue;
		if (name.startsWith(".") && name !== ".agents" && name !== ".mountains" && name !== ".claude") continue;
		out.push(...findSkillDirs(join(root, name), depth + 1, maxDepth));
		if (out.length >= 20) break;
	}
	return out;
}

async function extractSkillDirs(archive: string): Promise<string[]> {
	const dest = mkdtempSync(join(tmpdir(), "mountains-skill-archive-"));
	try {
		await exec("tar", ["-xf", archive, "-C", dest], { timeout: 30_000 });
		const found = findSkillDirs(dest, 0, 4);
		if (!found.length) throw new Error("压缩包里没有 SKILL.md");
		return found.map(dir => keep(dir));
	} finally { rmSync(dest, { recursive: true, force: true }); }
}

function installSkillDir(dir: string, destRoot: string, source: string): InstalledSkill {
	const text = readFileSync(join(dir, "SKILL.md"), "utf8");
	const { fields } = parseSkillFile(text);
	const name = fields.name?.trim() ?? "";
	const description = (fields.description ?? "").replace(/\s+/g, " ").trim();
	if (!name || name.length > SKILL_LIMITS.name || !SKILL_NAME.test(name)) throw new SkillFormatError(`技能名无效：${JSON.stringify(name)}`);
	if (!description || description.length > SKILL_LIMITS.description) throw new SkillFormatError(`技能 ${name} 的 description 必须是 1–1024 个字符`);
	const dest = join(destRoot, name);
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	copyTree(dir, dest);
	return { name, dir: dest, source };
}

function copyTree(from: string, to: string): void {
	let files = 0, bytes = 0;
	const walk = (src: string, dest: string) => {
		for (const name of readdirSync(src)) {
			if (name === ".git" || name === "node_modules") continue;
			const sp = join(src, name), dp = join(dest, name);
			const st = lstatSync(sp);
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) { mkdirSync(dp); walk(sp, dp); continue; }
			if (!st.isFile() || st.size > FILE_BYTES) continue;
			files += 1;
			bytes += st.size;
			if (files > TREE_FILES || bytes > TREE_BYTES) throw new Error("技能文件太多");
			copyFileSync(sp, dp);
		}
	};
	walk(from, to);
}

async function defaultBranch(owner: string, repo: string, fetchImpl: typeof fetch): Promise<string> {
	const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, { headers: { "User-Agent": "Mountains", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) return "main";
	const body = await response.json() as { default_branch?: unknown };
	return typeof body.default_branch === "string" && /^[\w./-]+$/.test(body.default_branch) ? body.default_branch : "main";
}

/** Local archives are recognized by name; the caller extracts them before install. */
export async function installLocalArchive(archive: string, dest: string): Promise<InstalledSkill[]> {
	const dirs = await extractSkillDirs(archive);
	try { return dirs.map(dir => installSkillDir(dir, dest, archive)); }
	finally { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
}

async function download(url: string, maxBytes: number, fetchImpl: typeof fetch): Promise<Buffer> {
	const response = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "Mountains" }, signal: AbortSignal.timeout(20_000) });
	if (!response.ok || !response.body) throw new Error(`下载没有返回（${response.status}）`);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) throw new Error("文件太大");
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks);
}
