import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("mountains models search prints DeepSeek V4.1 Flash first", () => {
	const child = spawnSync(process.execPath, [MAIN, "models", "search", "深度求索", "flash"], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout.split("\n")[0] ?? "", /deepseek-flash/);
});
