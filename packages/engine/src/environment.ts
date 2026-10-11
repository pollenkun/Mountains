import { closeSync, fstatSync, lstatSync, openSync, readSync, constants } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "@mountains/tools";

/** Fixed root-level reads only. No shell, dependency traversal, or lockfile contents. */
export const ENVIRONMENT_LIMITS = Object.freeze({ packageBytes: 65_536, scriptNames: 16 });

const LOCKFILES = ["bun.lock", "bun.lockb", "npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;
type PathFact = "directory" | "file" | "missing" | "unavailable" | "other";
export interface EnvironmentFacts {
	nodeModules: PathFact;
	packageJson: "read" | "missing" | "unavailable" | "too-large" | "invalid";
	scriptNames: string[];
	/** Includes names deliberately omitted because of length or unusual characters. */
	omittedScriptNames: number;
	lockfiles: string[];
}

function pathFact(workspace: Workspace, relative: string): PathFact {
	try {
		// Distinguish a missing path from a dangling or out-of-workspace symlink.
		lstatSync(join(workspace.root, relative));
		const stat = lstatSync(workspace.resolve(relative).abs);
		return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
	}
}

/** Root-level facts about the workspace's dependencies, for the repository brief. */
export function inspectEnvironment(workspace: Workspace): EnvironmentFacts {
	const facts: EnvironmentFacts = {
		nodeModules: pathFact(workspace, "node_modules"), packageJson: "unavailable", scriptNames: [],
		omittedScriptNames: 0, lockfiles: LOCKFILES.filter(path => pathFact(workspace, path) === "file"),
	};
	if (pathFact(workspace, "package.json") === "missing") facts.packageJson = "missing";
	else {
		let fd: number | undefined;
		try {
			const candidate = join(workspace.root, "package.json");
			const before = lstatSync(candidate);
			// A startup observation does not need to follow even an in-workspace symlink.
			// Refusing non-regular files before open also avoids device/FIFO side effects.
			if (!before.isFile()) throw new Error("manifest is not a regular root file");
			const resolved = workspace.resolve("package.json");
			if (resolved.abs !== candidate) throw new Error("manifest path changed");
			// NONBLOCK remains necessary: the regular file can become a FIFO after lstat.
			fd = openSync(resolved.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
			const stat = fstatSync(fd);
			// Revalidate the boundary and opened identity before reading any bytes. A
			// replaced parent, symlink, or file cannot authorize reading the new target.
			const after = workspace.resolve("package.json");
			if (!stat.isFile() || after.abs !== candidate || stat.dev !== before.dev || stat.ino !== before.ino) facts.packageJson = "unavailable";
			else if (stat.size > ENVIRONMENT_LIMITS.packageBytes) facts.packageJson = "too-large";
			else {
				const bytes = Buffer.alloc(ENVIRONMENT_LIMITS.packageBytes + 1);
				let size = 0;
				while (size < bytes.length) {
					const count = readSync(fd, bytes, size, bytes.length - size, size);
					if (!count) break;
					size += count;
				}
				if (size > ENVIRONMENT_LIMITS.packageBytes) facts.packageJson = "too-large";
				else {
					const parsed: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"));
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) facts.packageJson = "invalid";
					else {
						facts.packageJson = "read";
						const scripts = (parsed as Record<string, unknown>).scripts;
						if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
							const names = Object.keys(scripts);
							facts.scriptNames = names.filter(name => /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,47}$/.test(name))
								.sort().slice(0, ENVIRONMENT_LIMITS.scriptNames);
							facts.omittedScriptNames = names.length - facts.scriptNames.length;
						}
					}
				}
			}
		} catch (error) {
			facts.packageJson = error instanceof SyntaxError ? "invalid" : "unavailable";
		} finally { if (fd !== undefined) closeSync(fd); }
	}
	return facts;
}
