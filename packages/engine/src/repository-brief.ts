import { opendirSync } from "node:fs";
import type { Workspace } from "@mountains/tools";
import { inspectEnvironment, type EnvironmentFacts } from "./environment.ts";

export const REPOSITORY_BRIEF_LIMITS = Object.freeze({ scannedEntries: 256, shownEntries: 32, nameBytes: 96, noticeBytes: 4096 });
export interface RepositoryBrief {
	rootEntries: string[];
	rootComplete: boolean;
	rootUnavailable: boolean;
	omittedEntries: number;
	environment: EnvironmentFacts;
	notice: string;
}

/** Root names and manifest declarations only; no source traversal, shell, or inferred test success. */
export function inspectRepositoryBrief(workspace: Workspace): RepositoryBrief {
	const environment = inspectEnvironment(workspace);
	const rootEntries: string[] = [];
	let scanned = 0, omittedEntries = 0, rootComplete = true, rootUnavailable = false;
	try {
		const dir = opendirSync(workspace.root);
		try {
			for (;;) {
				const entry = dir.readSync();
				if (!entry) break;
				if (++scanned > REPOSITORY_BRIEF_LIMITS.scannedEntries) { rootComplete = false; omittedEntries++; break; }
				if ([".git", ".mountains", "node_modules"].includes(entry.name)) continue;
				if (Buffer.byteLength(entry.name) > REPOSITORY_BRIEF_LIMITS.nameBytes) { omittedEntries++; continue; }
				rootEntries.push(entry.name + (entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""));
			}
		} finally { dir.closeSync(); }
	} catch { rootComplete = false; rootUnavailable = true; }
	rootEntries.sort();
	if (rootEntries.length > REPOSITORY_BRIEF_LIMITS.shownEntries) {
		omittedEntries += rootEntries.length - REPOSITORY_BRIEF_LIMITS.shownEntries;
		rootEntries.length = REPOSITORY_BRIEF_LIMITS.shownEntries;
	}
	if (omittedEntries > 0) rootComplete = false;
	const header = `[Repository facts; observed root only${rootComplete ? "" : "; incomplete listing"}${rootUnavailable ? "; listing unavailable" : ""}]`;
	const notice = `${header} entries=${JSON.stringify(rootEntries)}; node_modules=${environment.nodeModules}; package.json=${environment.packageJson}; ` +
		`declared script names=${JSON.stringify(environment.scriptNames)}${environment.omittedScriptNames ? " (additional names omitted)" : ""}; lockfiles=${JSON.stringify(environment.lockfiles)}. ` +
		"No checks have run; declarations and absent root dependencies do not establish which tests can run. " +
		"Use available repository checks and current source evidence; do not search the file system for other interpreters, packages or copies of this project.";
	if (Buffer.byteLength(notice) > REPOSITORY_BRIEF_LIMITS.noticeBytes) {
		// Filename escaping may be much larger than the raw name. Omit names instead of cutting strings.
		rootEntries.length = 0;
		return { rootEntries, rootComplete: false, rootUnavailable, omittedEntries: scanned, environment,
			notice: `[Repository facts; root names omitted due to output limit] node_modules=${environment.nodeModules}; package.json=${environment.packageJson}; declared script names=${JSON.stringify(environment.scriptNames)}. No checks have run. Use available repository checks; do not search the file system for other environments.` };
	}
	return { rootEntries, rootComplete, rootUnavailable, omittedEntries, environment, notice };
}
