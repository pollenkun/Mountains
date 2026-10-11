import { statSync } from "node:fs";
import { dirname } from "node:path";

interface PathIdentity { dev: bigint; ino: bigint; directory: boolean }
interface IdentityHost { parent(path: string): string; identity(path: string): PathIdentity }
const nativeHost: IdentityHost = {
	parent: dirname,
	identity(path) {
		const stat = statSync(path, { bigint: true });
		return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
	},
};

/** Existing, real paths only. Case-folded path text cannot prove Windows ancestry. */
export function hasPathAncestor(root: string, path: string, host: IdentityHost = nativeHost): boolean {
	try {
		const expected = host.identity(root);
		if (!expected.directory || expected.ino === 0n) return false;
		let current = path;
		for (;;) {
			const actual = host.identity(current);
			if (actual.ino === 0n) return false;
			if (actual.directory && actual.dev === expected.dev && actual.ino === expected.ino) return true;
			const parent = host.parent(current);
			if (parent === current) return false;
			current = parent;
		}
	} catch { return false; }
}
