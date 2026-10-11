import { enableCompileCache } from "node:module";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Optional Node bytecode/TypeScript cache. It never stores model/session data. */
export function enableMountainsCompileCache(): void {
	// Node treats the presence of this variable as disabling the cache. Avoid even
	// making directories when disabled; callers still load the normal program.
	if (process.env.NODE_DISABLE_COMPILE_CACHE !== undefined) return;
	try {
		let directory = homedir();
		for (const [index, part] of [".cache", "mountains", "node-compile-cache"].entries()) {
			directory = join(directory, part);
			let stat = lstatSync(directory, { throwIfNoEntry: false });
			if (!stat) {
				mkdirSync(directory, { mode: 0o700 });
				stat = lstatSync(directory);
			}
			if (!stat.isDirectory() || stat.isSymbolicLink()) return;
			if (process.platform !== "win32") {
				if (stat.uid !== process.getuid?.()) return;
				if (index === 0 && (stat.mode & 0o022) !== 0) return;
				// The general .cache parent may already be public. Mountains' own
				// subtree must be private; do not change permissions on existing dirs.
				if (index > 0 && (stat.mode & 0o077) !== 0) return;
			}
		}
		// Node validates source hashes, separates versions/architectures/users and
		// returns a failure status instead of throwing when its native cache fails.
		enableCompileCache(directory);
	} catch {
		// Read-only home, unavailable cache API, permissions and I/O errors are
		// performance misses. They must not prevent help, approval or normal work.
	}
}
