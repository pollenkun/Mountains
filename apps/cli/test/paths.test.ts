import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCacheParent, expandHome, mountainsHome } from "../src/paths.ts";

test("state defaults and overrides use native home path syntax on every supported OS", () => {
	for (const platform of ["linux", "darwin"] as const) {
		assert.equal(mountainsHome({}, "/users/example", platform), "/users/example/.mountains");
		assert.equal(mountainsHome({ MOUNTAINS_HOME: "~/custom state" }, "/users/example", platform), "/users/example/custom state");
		assert.equal(mountainsHome({ MOUNTAINS_HOME: "" }, "/users/example", platform), "/users/example/.mountains");
	}
	assert.equal(mountainsHome({}, "C:\\Users\\Example", "win32"), "C:\\Users\\Example\\.mountains");
	assert.equal(mountainsHome({ MOUNTAINS_HOME: "~\\custom state" }, "C:\\Users\\Example", "win32"), "C:\\Users\\Example\\custom state");
	assert.equal(mountainsHome({ MOUNTAINS_HOME: "D:\\Mountains state" }, "C:\\Users\\Example", "win32"), "D:\\Mountains state");
	assert.equal(mountainsHome({ MOUNTAINS_HOME: "\\\\server\\share\\state" }, "C:\\Users\\Example", "win32"), "\\\\server\\share\\state");
});

test("tilde expansion accepts Windows separators only on Windows", () => {
	assert.equal(expandHome("~", "/home/example", "linux"), "/home/example");
	assert.equal(expandHome("~/spend.jsonl", "C:\\Users\\Example", "win32"), "C:\\Users\\Example\\spend.jsonl");
	assert.equal(expandHome("~\\spend.jsonl", "/home/example", "linux"), "~\\spend.jsonl");
	assert.equal(expandHome("~another/file", "/home/example", "linux"), "~another/file");
});

test("compile cache uses OS-native parents and ignores relative environment overrides", () => {
	assert.equal(compileCacheParent({}, "/home/example", "linux"), "/home/example/.cache");
	assert.equal(compileCacheParent({ XDG_CACHE_HOME: "/tmp/custom cache" }, "/home/example", "linux"), "/tmp/custom cache");
	assert.equal(compileCacheParent({ XDG_CACHE_HOME: "relative/cache" }, "/home/example", "linux"), "/home/example/.cache");
	assert.equal(compileCacheParent({ XDG_CACHE_HOME: "/ignored" }, "/Users/example", "darwin"), "/Users/example/Library/Caches");
	assert.equal(compileCacheParent({}, "C:\\Users\\Example", "win32"), "C:\\Users\\Example\\AppData\\Local");
	assert.equal(compileCacheParent({ LOCALAPPDATA: "D:\\Local Data" }, "C:\\Users\\Example", "win32"), "D:\\Local Data");
	assert.equal(compileCacheParent({ LOCALAPPDATA: "relative" }, "C:\\Users\\Example", "win32"), "C:\\Users\\Example\\AppData\\Local");
});
