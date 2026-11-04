import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSettings, globalAgentsPath, readGlobalAgents, writeGlobalAgents } from "../src/main/settings.ts";

test("desktop settings merge on write, and the global AGENTS.md is the one the CLI reads", () => {
	const home = mkdtempSync(join(tmpdir(), "mountains-settings-"));
	const settings = createSettings(join(home, "desktop", "settings.json"));
	assert.deepEqual(settings.read(), {});
	settings.write({ memory: true });
	assert.deepEqual(settings.read(), { memory: true });
	const previous = process.env.MOUNTAINS_HOME;
	process.env.MOUNTAINS_HOME = home;
	try {
		assert.equal(globalAgentsPath(), join(home, "AGENTS.md"));
		assert.equal(readGlobalAgents(), "");
		writeGlobalAgents("Reply in Chinese.");
		assert.equal(readFileSync(join(home, "AGENTS.md"), "utf8"), "Reply in Chinese.");
		assert.equal(existsSync(join(home, "AGENTS.md.tmp")), false);
	} finally {
		if (previous === undefined) delete process.env.MOUNTAINS_HOME; else process.env.MOUNTAINS_HOME = previous;
	}
});
