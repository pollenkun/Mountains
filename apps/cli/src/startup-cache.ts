import { enableCompileCache } from "node:module";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { compileCacheParent } from "./paths.ts";

/** Optional Node bytecode/TypeScript cache. It never stores model/session data. */
export function enableMountainsCompileCache(): void {
	// Node treats the presence of this variable as disabling the cache. Avoid even
	// making directories when disabled; callers still load the normal program.
	if (process.env.NODE_DISABLE_COMPILE_CACHE !== undefined) return;
	try {
		const parent = compileCacheParent();
		const directory = join(parent, "mountains", "node-compile-cache");
		const directories = [parent, join(parent, "mountains"), directory];
		for (const [index, current] of directories.entries()) {
			let stat = lstatSync(current, { throwIfNoEntry: false });
			if (!stat) {
				mkdirSync(current, { mode: 0o700, recursive: index === 0 });
				stat = lstatSync(current);
			}
			if (!stat.isDirectory() || stat.isSymbolicLink()) return;
			if (process.platform !== "win32") {
				if (stat.uid !== process.getuid?.()) return;
				if (index === 0 && (stat.mode & 0o022) !== 0) return;
				// The OS cache parent may already be public. Mountains' own
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
