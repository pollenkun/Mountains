/**
 * The composer's helpers around files: the workspace's files for an @ reference, recent folders, and saving
 * what is pasted (a picture, a long text) as a file whose path goes in the message.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP = new Set([".git", "node_modules", ".DS_Store", "dist", "build", ".next", ".venv", "__pycache__", ".cache"]);
const LIMIT = 20_000;
const cache = new Map<string, { at: number; files: string[] }>();

function walk(root: string): string[] {
	const out: string[] = [];
	const queue = [root];
	while (queue.length && out.length < LIMIT) {
		const dir = queue.shift()!;
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (SKIP.has(entry.name)) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) queue.push(path);
			else if (entry.isFile()) out.push(relative(root, path).split(sep).join("/"));
		}
	}
	return out;
}

/** The workspace's files, as Git sees them (ignored ones left out) or by walking it; kept for ten seconds. */
export function workspaceFiles(root: string): string[] {
	const hit = cache.get(root);
	if (hit && Date.now() - hit.at < 10_000) return hit.files;
	let files: string[];
	try {
		files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean).slice(0, LIMIT);
	} catch { files = walk(root); }
	cache.set(root, { at: Date.now(), files });
	return files;
}

/** Paths that match `query` in order (letters may be apart), best first: a match in the file name beats one in its folder. */
export function matchFiles(files: readonly string[], query: string, max = 40): string[] {
	const q = query.toLowerCase();
	if (!q) return files.slice(0, max);
	const scored: { path: string; score: number }[] = [];
	for (const path of files) {
		const lower = path.toLowerCase();
		const name = lower.slice(lower.lastIndexOf("/") + 1);
		let score: number;
		if (name.startsWith(q)) score = 0;
		else if (name.includes(q)) score = 1;
		else if (lower.includes(q)) score = 2;
		else {
			let at = 0;
			for (const ch of q) { at = lower.indexOf(ch, at); if (at < 0) break; at++; }
			if (at < 0) continue;
			score = 3;
		}
		scored.push({ path, score: score * 1000 + path.length });
	}
	return scored.sort((a, b) => a.score - b.score).slice(0, max).map((entry) => entry.path);
}

/** Saves a pasted picture or text where the model can read it; the path is what goes in the message. */
export function savePasted(dir: string, kind: "png" | "jpg" | "txt", data: Uint8Array | string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
	const path = join(dir, `${kind === "txt" ? "粘贴的文本" : "粘贴的图片"}-${stamp}-${randomUUID().slice(0, 4)}.${kind}`);
	writeFileSync(path, data, { mode: 0o600 });
	return path;
}

export function isGitRepo(path: string): boolean {
	return existsSync(join(path, ".git"));
}
