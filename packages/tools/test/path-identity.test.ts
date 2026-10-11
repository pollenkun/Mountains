import assert from "node:assert/strict";
import { win32 } from "node:path";
import { test } from "node:test";
import { hasPathAncestor } from "../src/path-identity.ts";

function windowsFixture() {
	const ids = new Map<string, bigint>([
		["C:\\", 1n], ["C:\\parent", 2n], ["C:\\parent\\Repo", 3n],
		["C:\\parent\\repo", 4n], ["C:\\PARENT\\REPO", 3n], ["C:\\PARENT", 2n],
	]);
	return {
		parent: win32.dirname,
		identity(path: string) {
			const ino = ids.get(path);
			if (ino === undefined) throw new Error("identity unavailable");
			return { dev: 10n, ino, directory: true };
		},
	};
}

test("Windows identity accepts a same-directory case alias and filesystem root", () => {
	const host = windowsFixture();
	assert.equal(hasPathAncestor("C:\\parent\\Repo", "C:\\PARENT\\REPO", host), true);
	assert.equal(hasPathAncestor("C:\\", "C:\\parent\\Repo", host), true);
});

test("Windows identity rejects distinct case-sensitive siblings, including resolved junction targets", () => {
	const host = windowsFixture();
	assert.equal(win32.relative("C:\\parent\\Repo", "C:\\parent\\repo"), "", "lexical comparison alone loses the boundary");
	assert.equal(hasPathAncestor("C:\\parent\\Repo", "C:\\parent\\repo", host), false);
	assert.equal(hasPathAncestor("C:\\parent\\Repo", "C:\\parent", host), false);
});

test("missing or unusable filesystem identities fail closed", () => {
	const host = windowsFixture();
	assert.equal(hasPathAncestor("C:\\parent\\Repo", "C:\\missing", host), false);
	assert.equal(hasPathAncestor("C:\\parent\\Repo", "C:\\parent\\Repo", {
		...host, identity: () => ({ dev: 10n, ino: 0n, directory: true }),
	}), false);
});
