/**
 * What a conversation's runs did to files, from the snapshots the engine takes before each run: the files changed
 * since a point, their diff, and putting them back as they were. A file someone else changed since is never
 * overwritten; it is reported instead.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileSha256, ShadowCheckpoints } from "@mountains/checkpoints";

/** One run that changed files, as the desk keeps it (runs.jsonl). */
export interface RunChanges {
	/** The run.started event of the run. */
	run: string;
	outDir: string;
	/** The snapshot taken before the run. */
	tree: string;
	changed: { status: string; path: string }[];
	/** Each changed file's hash when the run ended; null for a file the run deleted. */
	after: Record<string, string | null>;
	at: number;
	/** The user's message that started the run. */
	task: string;
}

export interface ChangedFile { path: string; added: number | null; removed: number | null }

/** Where each file's earlier state lives: the first run (from `runs`) that changed it, and the latest hash a run left. */
function origins(runs: readonly RunChanges[]): Map<string, { run: RunChanges; expected: string | null }> {
	const out = new Map<string, { run: RunChanges; expected: string | null }>();
	for (const run of runs) {
		for (const { path } of run.changed) {
			const seen = out.get(path);
			out.set(path, { run: seen?.run ?? run, expected: run.after[path] ?? null });
		}
	}
	return out;
}

function grouped(runs: readonly RunChanges[]): Map<RunChanges, string[]> {
	const byRun = new Map<RunChanges, string[]>();
	for (const [path, { run }] of origins(runs)) byRun.set(run, [...(byRun.get(run) ?? []), path]);
	return byRun;
}

const checkpoints = (workspace: string, run: RunChanges) => new ShadowCheckpoints(workspace, join(run.outDir, "appdata"));

/** The files `runs` changed, compared with now; files that are back as they were drop out. */
export function changedFiles(workspace: string, runs: readonly RunChanges[]): ChangedFile[] {
	const files: ChangedFile[] = [];
	for (const [run, paths] of grouped(runs)) {
		const ck = checkpoints(workspace, run);
		const now = ck.snapshot(paths).tree;
		files.push(...ck.lineCounts(run.tree, now, paths));
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** One file's diff against how it was before the first of `runs` changed it. */
export function fileDiff(workspace: string, runs: readonly RunChanges[], path: string): string {
	const origin = origins(runs).get(path);
	if (!origin) return "";
	const ck = checkpoints(workspace, origin.run);
	return ck.diff(origin.run.tree, ck.snapshot([path]).tree, [path]);
}

/** Puts every file `runs` changed back as it was before them. Files changed since by someone else are left and listed. */
export function restoreFiles(workspace: string, runs: readonly RunChanges[]): { restored: string[]; conflicts: string[] } {
	const restored: string[] = [], conflicts: string[] = [];
	const all = origins(runs);
	for (const [run, paths] of grouped(runs)) {
		const expected = Object.fromEntries(paths.map((path) => [path, all.get(path)!.expected]));
		const result = checkpoints(workspace, run).restore(run.tree, paths, expected);
		restored.push(...result.restored, ...result.deleted);
		conflicts.push(...result.conflicts.map((conflict) => conflict.path));
	}
	return { restored, conflicts };
}

/** Keeps the files `runs` changed as they are now, so a restore can be taken back. Read this before restoring. */
export function keepFiles(workspace: string, runs: readonly RunChanges[]): RunChanges | null {
	const newest = runs[runs.length - 1], paths = [...origins(runs).keys()];
	if (!newest || !paths.length) return null;
	const tree = checkpoints(workspace, newest).snapshot(paths).tree;
	return { ...newest, tree, changed: paths.map((path) => ({ status: "M", path })), after: {} };
}

/** The hashes a run left its changed files with, read right after it ends. */
export function hashesAfter(workspace: string, changed: readonly { path: string }[]): Record<string, string | null> {
	const root = realpathSync(workspace);
	return Object.fromEntries(changed.map(({ path }) => [path, fileSha256(join(root, path))]));
}
