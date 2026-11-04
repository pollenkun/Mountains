import assert from "node:assert/strict";
import { test } from "node:test";
import { pickTitle } from "../src/renderer/titles.ts";

test("a new conversation's line never repeats the last one, and Once Upon a Token stays English", () => {
	const saved = new Map<string, string>();
	(globalThis as { localStorage?: unknown }).localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) };
	let last = "";
	for (let i = 0; i < 200; i++) {
		const title = pickTitle("zh-CN");
		assert.notEqual(title, last);
		last = title;
	}
	const english = new Set(Array.from({ length: 200 }, () => pickTitle("en-US")));
	assert.ok(english.has("Once Upon a Token…"));
	assert.ok(english.has("What should we build?"));
	const chinese = new Set(Array.from({ length: 200 }, () => pickTitle("zh-CN")));
	assert.ok(chinese.has("你在想什么？"));
	assert.ok(!chinese.has("你的思绪是什么？"));
	delete (globalThis as { localStorage?: unknown }).localStorage;
});
