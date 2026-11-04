import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolResult } from "@mountains/tools";

/**
 * A local record of what computer use did, for the user to look back on (cua-driver's Computer History idea).
 * Metadata only: when, which tool and action, which app or web host, the outcome and how long it took. Never typed
 * text, window titles, element names, full URLs, images or results. One JSON line per action, readable only by
 * the user (0600 files in a 0700 folder).
 */
export interface HistoryEntry { at: string; tool: string; action: string; target: string; outcome: string; ms: number; dispatched: boolean; steps?: number }

const ACTING = new Set(["screen_act", "web_act"]);

/** The entry for one finished call, or undefined for reads. */
export function historyEntry(tool: string, args: Record<string, unknown>, result: ToolResult, ms: number, now = new Date()): HistoryEntry | undefined {
	if (!ACTING.has(tool)) return undefined;
	const d = result.details ?? {};
	let target = "";
	if (tool === "web_act") {
		const url = typeof d.url === "string" ? d.url : "";
		try { target = url ? new URL(url).host : `tab ${String(d.tab ?? "?")}`; } catch { target = `tab ${String(d.tab ?? "?")}`; }
	} else target = String(d.app ?? args.app ?? "");
	const steps = Array.isArray(args.steps) ? args.steps.length : undefined;
	const action = steps ? (args.steps as { action?: unknown }[]).map(step => String(step?.action ?? "?")).join("+") : String(args.action ?? d.action ?? "");
	return { at: now.toISOString(), tool, action: action.slice(0, 200), target: target.slice(0, 120), outcome: String(d.outcome ?? (result.ok ? "ok" : "failed")), ms: Math.round(ms), dispatched: d.dispatched === true, ...(steps ? { steps } : {}) };
}

export async function appendHistory(dir: string, entry: HistoryEntry): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await appendFile(join(dir, `${entry.at.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** The newest entries first, from the last `days` daily files. */
export async function readHistory(dir: string, days = 1): Promise<HistoryEntry[]> {
	let files: string[];
	try { files = (await readdir(dir)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-Math.max(1, days)); } catch { return []; }
	const out: HistoryEntry[] = [];
	for (const file of files) for (const line of (await readFile(join(dir, file), "utf8")).split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line) as HistoryEntry); } catch { /* a torn last line */ } }
	return out.reverse();
}
