import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CAPABILITIES } from "../src/capabilities.ts";
import { applyHandwritten, catalogIsStale, mapSnapshot, readSnapshot, writeCatalogFile, type SnapshotFile } from "../src/catalog.ts";

test("a models.dev model maps onto the fields Mountains already uses", () => {
	const snapshot = readSnapshot();
	const flash = mapSnapshot(snapshot).find(entry => entry.provider === "deepseek" && entry.id === "deepseek-v4-pro");
	assert.ok(flash);
	assert.equal(flash.contextWindow, 1_048_576);
	assert.equal(flash.maxOutputTokens, 393_216);
	assert.deepEqual(flash.inputModalities, ["text"]);
	assert.equal(flash.requiresReasoningPassback, true);
	assert.equal(flash.priced, true);
	assert.equal(flash.costUsd?.cacheRead, 0.022);
});

test("video and other inputs are dropped; a model without a price stays unpriced", () => {
	const snapshot: SnapshotFile = {
		source: "fixture", license: "MIT", fetchedAt: "2026-10-25T00:00:00Z",
		providers: { example: { name: "Example", models: {
			"view-only": { name: "View", reasoning: false, context: 8000, output: 1000, input: ["text", "image", "video", "pdf"], interleaved: false },
		} } },
	};
	const [entry] = mapSnapshot(snapshot);
	assert.deepEqual(entry!.inputModalities, ["text", "image"]);
	assert.equal(entry!.priced, false);
	assert.equal(entry!.costUsd, undefined);
});

test("the eight handwritten models replace a colliding snapshot row", () => {
	const snapshot: SnapshotFile = {
		source: "fixture", license: "MIT", fetchedAt: "2026-10-25T00:00:00Z",
		providers: { deepseek: { name: "DeepSeek", models: {
			"deepseek-flash": { name: "Snapshot name", reasoning: false, context: 1, output: 1, input: ["text"], interleaved: false },
		} } },
	};
	const merged = applyHandwritten(mapSnapshot(snapshot));
	const flash = merged.find(entry => entry.id === "deepseek-flash");
	assert.equal(flash?.handwritten, true);
	assert.equal(flash?.displayName, CAPABILITIES["deepseek-flash"]!.displayName);
	assert.equal(flash?.contextWindow, CAPABILITIES["deepseek-flash"]!.contextWindow);
	assert.deepEqual(flash?.inputModalities, ["text", "image"]);
	assert.equal(merged.filter(entry => entry.id === "deepseek-flash").length, 1);
});

test("a catalog file older than a day is stale and can be rewritten", () => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-catalog-"));
	const dest = join(dir, "catalog.json");
	assert.equal(catalogIsStale(dest), true);
	writeCatalogFile(dest, [], new Date("2026-10-25T00:00:00Z"));
	assert.equal(catalogIsStale(dest, Date.parse("2026-10-25T01:00:00Z")), false);
	const old = new Date("2026-10-23T00:00:00Z");
	utimesSync(dest, old, old);
	assert.equal(catalogIsStale(dest, Date.parse("2026-10-25T00:00:00Z")), true);
	writeCatalogFile(dest, applyHandwritten([]).slice(0, 1));
	const saved = JSON.parse(readFileSync(dest, "utf8")) as { models: { id: string; handwritten: boolean }[] };
	assert.equal(saved.models[0]?.handwritten, true);
	assert.ok(statSync(dest).size > 0);
	rmSync(dir, { recursive: true, force: true });
});
