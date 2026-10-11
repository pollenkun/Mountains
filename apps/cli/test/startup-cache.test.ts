import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { compileCacheParent } from "../src/paths.ts";
import { isolatedEnv } from "./env.ts";

const helper = new URL("../src/startup-cache.ts", import.meta.url).href;
function fixture(t: TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "mountains-startup-cache-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	writeFileSync(join(home, "loaded.mjs"), "export const usable = true;\n");
	return home;
}
function load(home: string, options: { env?: NodeJS.ProcessEnv; flags?: string[]; preload?: string } = {}) {
	const code = `import { getCompileCacheDir } from 'node:module';
		const { enableMountainsCompileCache } = await import(${JSON.stringify(helper)});
		enableMountainsCompileCache();
		const { usable } = await import(${JSON.stringify(pathToFileURL(join(home, "loaded.mjs")).href)});
		process.stdout.write(JSON.stringify({ usable, directory: getCompileCacheDir() ?? null }) + '\\n');`;
	const child = spawnSync(process.execPath, [...(options.flags ?? []), ...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []), "--input-type=module", "-e", code], {
		encoding: "utf8", timeout: 15_000,
		env: { ...isolatedEnv(home), ...options.env },
	});
	assert.equal(child.error, undefined);
	assert.equal(child.status, 0, child.stderr);
	assert.doesNotMatch(child.stderr, /错误|cache failed|Error:/i);
	return JSON.parse(child.stdout) as { usable: boolean; directory: string | null };
}

test("compile cache is isolated under HOME and persists reusable Node entries", t => {
	const home = fixture(t), parent = compileCacheParent(isolatedEnv(home), home), cache = join(parent, "mountains", "node-compile-cache");
	const first = load(home);
	assert.equal(first.usable, true);
	assert.ok(first.directory);
	const inside = relative(cache, first.directory);
	assert.ok(inside !== ".." && !inside.startsWith(`..${sep}`), "Node's effective directory stays within the selected cache root");
	assert.ok(readdirSync(first.directory).length > 0, "Node must persist cache entries when the child exits");
	if (process.platform !== "win32") {
		for (const directory of [join(parent, "mountains"), cache]) assert.equal(lstatSync(directory).mode & 0o777, 0o700);
	}
	assert.deepEqual(load(home), first);
});

test("explicit cache disable leaves HOME untouched and normal modules usable", t => {
	const home = fixture(t);
	assert.deepEqual(load(home, { env: { NODE_DISABLE_COMPILE_CACHE: "1" } }), { usable: true, directory: null });
	assert.equal(existsSync(compileCacheParent(isolatedEnv(home), home)), false);
});

test("cache directory creation failure does not block normal module loading", t => {
	const home = fixture(t), blocked = compileCacheParent(isolatedEnv(home), home);
	mkdirSync(join(blocked, ".."), { recursive: true });
	writeFileSync(blocked, "existing ordinary file\n");
	assert.deepEqual(load(home), { usable: true, directory: null });
	assert.equal(readFileSync(blocked, "utf8"), "existing ordinary file\n");
});

test("read-only home enforced by Node permissions falls back without a cache", t => {
	const home = fixture(t), writable = join(home, "allowed-write");
	mkdirSync(writable);
	assert.deepEqual(load(home, { flags: ["--permission", "--allow-fs-read=*", `--allow-fs-write=${writable}`] }), { usable: true, directory: null });
	assert.equal(existsSync(compileCacheParent(isolatedEnv(home), home)), false);
});

test("native cache failure status and exceptions both leave module loading usable", t => {
	const home = fixture(t), preload = join(home, "cache-failure.mjs");
	for (const replacement of ["() => ({ status: module.constants.compileCacheStatus.FAILED, message: 'fixture cache unavailable' })", "() => { throw new Error('fixture cache unavailable'); }"]) {
		writeFileSync(preload, `import module from 'node:module';
			module.enableCompileCache = ${replacement};
			module.syncBuiltinESMExports();\n`);
		assert.deepEqual(load(home, { preload }), { usable: true, directory: null });
	}
});

test("a linked Mountains cache subtree is not traversed or changed", t => {
	const home = fixture(t), outside = join(home, "outside"), parent = compileCacheParent(isolatedEnv(home), home);
	mkdirSync(parent, { recursive: true }); mkdirSync(outside);
	writeFileSync(join(outside, "sentinel.txt"), "unchanged\n");
	symlinkSync(outside, join(parent, "mountains"), process.platform === "win32" ? "junction" : "dir");
	assert.deepEqual(load(home), { usable: true, directory: null });
	assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
	assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "unchanged\n");
});
