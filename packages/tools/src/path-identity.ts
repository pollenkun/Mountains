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

/** Existing, real paths only. Missing identity is not evidence of being outside. */
export function pathAncestry(root: string, path: string, host: IdentityHost = nativeHost): "inside" | "outside" | "unknown" {
	try {
		const expected = host.identity(root);
		if (!expected.directory || expected.ino === 0n) return "unknown";
		let current = path;
		for (;;) {
			const actual = host.identity(current);
			if (actual.ino === 0n) return "unknown";
			if (actual.directory && actual.dev === expected.dev && actual.ino === expected.ino) return "inside";
			const parent = host.parent(current);
			if (parent === current) return "outside";
			current = parent;
		}
	} catch { return "unknown"; }
}

/** Case-folded path text cannot prove Windows ancestry; uncertainty fails closed. */
export function hasPathAncestor(root: string, path: string, host: IdentityHost = nativeHost): boolean {
	return pathAncestry(root, path, host) === "inside";
}
