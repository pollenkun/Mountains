import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { outlineLines } from "../src/outline.ts";

test("TypeScript outlines preserve method return types, modifiers and line formatting", () => {
	const lines = [
		"export class Service {",
		"  constructor(value: string) {",
		"  public static async work(): Promise<string> {",
		"  readonly getValue():string {",
		"  protected value() : \tstring | undefined {\t ",
		"  get name(): string {",
		"  set name(value: string) {",
		"  async() {",
		"  workWithoutReturnType() {",
		"  declaration(): string;",
		"  callback(): () => string {",
		"  inline(): string { return 'value'; }",
		"}",
	];
	const expected = lines.slice(0, 9).map((text, index) => ({ line: index + 1, text: text.trimEnd() }));
	for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "TS"]) {
		assert.deepEqual(outlineLines(`source.${ext}`, lines.join("\r\n")), expected, ext);
	}
});

test("TypeScript interface return-type whitespace is scanned within a bounded time", () => {
	// Keep synchronous matching in a child so a regression cannot block the test runner.
	// The largest line is the same 64 KiB case that exposed the quadratic growth.
	const script = `
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { outlineLines } from ${JSON.stringify(new URL("../src/outline.ts", import.meta.url).href)};
outlineLines('source.ts', 'interface Example {\\n  method(): void;\\n}');
const started = performance.now();
for (const width of [4096, 16384, 65536]) {
  for (const whitespace of [' ', '\\t']) {
    const source = 'interface Example {\\n  method():' + whitespace.repeat(width) + 'void;\\n}';
    assert.deepEqual(outlineLines('source.ts', source), [{ line: 1, text: 'interface Example {' }]);
  }
}
const elapsed = performance.now() - started;
assert.ok(elapsed < 1000, 'interface return-type matching took ' + elapsed + ' ms');
`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(child.error, undefined, `outline matching did not finish: ${child.error?.message}`);
	assert.equal(child.status, 0, child.stderr);
});

test("TypeScript method return-type whitespace still accepts bodies and clips long lines", () => {
	for (const whitespace of [" ", "\t", "\u00a0"]) {
		const source = "  method():" + whitespace.repeat(65536) + "void {";
		assert.deepEqual(outlineLines("source.ts", source), [{ line: 1, text: source.slice(0, 160) + "…" }]);
	}
});
