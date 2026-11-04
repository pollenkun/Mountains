/**
 * AGENTS.md in two layers: the user's own (~/.mountains/AGENTS.md) and the workspace's. A workspace with no
 * AGENTS.md falls back to CLAUDE.md, so files kept for other tools still apply. Both empty means nothing is added.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const INSTRUCTIONS_LIMIT = 32 * 1024;

function read(path: string): string {
	try {
		if (!existsSync(path) || !statSync(path).isFile()) return "";
		const text = readFileSync(path, "utf8").trim();
		return Buffer.byteLength(text) > INSTRUCTIONS_LIMIT ? `${Buffer.from(text).subarray(0, INSTRUCTIONS_LIMIT).toString("utf8").replace(/\uFFFD+$/, "")}\n[truncated]` : text;
	} catch {
		return "";
	}
}

export function readInstructions(workspace: string, home: string): string {
	const global = read(join(home, "AGENTS.md"));
	const project = read(join(workspace, "AGENTS.md")) || read(join(workspace, "CLAUDE.md"));
	return [
		global ? `# User instructions (AGENTS.md)\n${global}` : "",
		project ? `# Project instructions (AGENTS.md)\n${project}` : "",
	].filter(Boolean).join("\n\n");
}
