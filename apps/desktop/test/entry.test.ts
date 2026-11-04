import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the shipped main process reads no test switches", () => {
	const dir = fileURLToPath(new URL("../src/main/", import.meta.url));
	for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
		const source = readFileSync(join(dir, name), "utf8");
		assert.doesNotMatch(source, /MOUNTAINS_DESKTOP_|globalThis\.fetch\s*=/, name);
	}
});
