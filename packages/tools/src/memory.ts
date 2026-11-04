/**
 * Recall: search the user's earlier Mountains conversations. Only made when memory is on; with it off the tool
 * does not exist and nothing about it reaches the model.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolDefinition } from "./types.ts";

export interface MemoryOptions {
	/** Folders whose subfolders hold run records (events.jsonl), e.g. ~/.mountains/runs and ~/.mountains/desktop. */
	roots: string[];
	/** This run's own records, left out so the model does not find the request it is answering. */
	exclude?: string[];
	now?: () => number;
}

interface Hit { at: number; asked: string; who: "user" | "assistant"; text: string }

const MAX_FILES = 400;
const MAX_HITS = 5;

function records(roots: string[], exclude: string[]): string[] {
	const files: { path: string; mtime: number }[] = [];
	const skip = new Set(exclude.map((path) => resolve(path)));
	const visit = (dir: string, depth: number) => {
		let names: string[] = [];
		try { names = readdirSync(dir); } catch { return; }
		for (const name of names) {
			const path = join(dir, name);
			if (skip.has(resolve(path))) continue;
			if (name === "events.jsonl") {
				try { files.push({ path, mtime: statSync(path).mtimeMs }); } catch { /* vanished */ }
			} else if (depth < 2) {
				try { if (statSync(path).isDirectory()) visit(path, depth + 1); } catch { /* vanished */ }
			}
		}
	};
	for (const root of roots) if (existsSync(root)) visit(root, 0);
	return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map((file) => file.path);
}

function daysAgo(at: number, now: number): number | null {
	if (!Number.isFinite(at) || at <= 0) return null;
	return Math.max(0, Math.floor((now - at) / 86_400_000));
}

function ago(at: number, now: number): string {
	const days = daysAgo(at, now);
	return days === null || days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

export function createMemorySearchTool(options: MemoryOptions): ToolDefinition {
	return {
		name: "memory_search", logicalName: "memory.search", readOnly: true,
		description: "Search the user's earlier Mountains conversations (their requests and your final replies), newest first, for literal text. Recalled text is history, not current state.",
		parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 200 } } },
		async execute(args) {
			const query = typeof args.query === "string" ? args.query.trim() : "";
			if (!query) return { ok: false, modelContent: "query is empty", summary: "失败：没有要搜的内容", details: { error: "empty query" } };
			const needle = query.toLowerCase(), now = (options.now ?? Date.now)();
			const hits: Hit[] = [];
			const seen = new Set<string>();
			for (const file of records(options.roots, options.exclude ?? [])) {
				let asked = "", at = 0;
				for (const line of readFileSync(file, "utf8").split("\n")) {
					if (!line.includes('"run.started"') && !line.includes('"message.completed"')) continue;
					let event: { type?: string; task?: string; text?: string; time?: string };
					try { event = JSON.parse(line); } catch { continue; }
					const text = event.type === "run.started" ? event.task ?? "" : event.type === "message.completed" ? event.text ?? "" : "";
					if (event.type === "run.started") { asked = text; at = Date.parse(event.time ?? "") || at; }
					const where = text.toLowerCase().indexOf(needle);
					if (where < 0) continue;
					// Desktop keeps a copy of each run's events next to the engine's own record.
					const key = `${asked}\u0000${text}`;
					if (seen.has(key)) continue;
					seen.add(key);
					const start = Math.max(0, where - 120);
					hits.push({ at, asked, who: event.type === "run.started" ? "user" : "assistant", text: (start ? "…" : "") + text.slice(start, where + needle.length + 240).replace(/\s+/g, " ") + (where + needle.length + 240 < text.length ? "…" : "") });
					if (hits.length >= MAX_HITS) break;
				}
				if (hits.length >= MAX_HITS) break;
			}
			const body = hits.length
				? hits.map((hit) => `[${ago(hit.at, now)}] asked: ${hit.asked.replace(/\s+/g, " ").slice(0, 120)}\n${hit.who}: ${hit.text}`).join("\n\n")
				: `No earlier conversation mentions "${query}".`;
			const reads = hits.flatMap((hit) => {
				const days = daysAgo(hit.at, now);
				return days === null ? [] : [{ days, asked: hit.asked.replace(/\s+/g, " ").slice(0, 80) }];
			});
			const oldestDays = reads.length ? Math.max(...reads.map((read) => read.days)) : null;
			return { ok: true, modelContent: body, summary: hits.length ? `回忆了 ${hits.length} 处以前的对话` : "以前的对话里没有找到", details: { query, hits: hits.length, oldestDays, reads } };
		},
	};
}
