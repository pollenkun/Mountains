import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INSTRUCTIONS_LIMIT, readInstructions } from "../src/instructions.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("AGENTS.md is read in two layers, falls back to CLAUDE.md, and is capped", () => {
	const home = mkdtempSync(join(tmpdir(), "mountains-instr-home-"));
	const ws = mkdtempSync(join(tmpdir(), "mountains-instr-ws-"));
	assert.equal(readInstructions(ws, home), "");
	writeFileSync(join(home, "AGENTS.md"), "  \n\n");
	assert.equal(readInstructions(ws, home), "", "blank files add nothing");
	writeFileSync(join(ws, "CLAUDE.md"), "Use pnpm.");
	assert.equal(readInstructions(ws, home), "# Project instructions (AGENTS.md)\nUse pnpm.");
	writeFileSync(join(ws, "AGENTS.md"), "Run tests with npm test.");
	writeFileSync(join(home, "AGENTS.md"), "Reply in Chinese.");
	assert.equal(readInstructions(ws, home), "# User instructions (AGENTS.md)\nReply in Chinese.\n\n# Project instructions (AGENTS.md)\nRun tests with npm test.");
	writeFileSync(join(ws, "AGENTS.md"), "中".repeat(INSTRUCTIONS_LIMIT));
	const capped = readInstructions(ws, home);
	assert.ok(capped.endsWith("\n[truncated]"));
	assert.ok(Buffer.byteLength(capped) < INSTRUCTIONS_LIMIT + 200);
	assert.doesNotMatch(capped, /�/);
});

function runCli(workspace: string, home: string, capture: string, extra: Record<string, unknown> = {}): Promise<number | null> {
	const config = join(home, "config.json");
	writeFileSync(config, JSON.stringify({ model: "deepseek-flash", baseUrl: "https://offline.invalid/v1", apiKeyEnv: "DEEPSEEK_API_KEY", checkpoints: false, skills: { enabled: false, dirs: [], enable: [], permissions: {} }, retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 2, maxRequests: 2, maxCost: 5 }, ...extra }));
	const env: NodeJS.ProcessEnv = { ...process.env, MOUNTAINS_HOME: home, MOUNTAINS_BUDGET: "5", DEEPSEEK_API_KEY: "k", MOUNTAINS_CAPTURE_DIR: capture };
	delete env.NODE_OPTIONS;
	const args = ["--import", join(root, "apps/desktop/test/capture-fetch.mjs"), join(root, "apps/cli/src/main.ts"), "run", "--task", "1+1?", "--workspace", workspace, "--config", config, "--out", join(home, `out-${Date.now()}-${Math.random()}`), "--spend-ledger", join(home, "spend.jsonl"), "--json"];
	return new Promise((resolve) => spawn(process.execPath, args, { cwd: root, env, stdio: "ignore" }).on("close", resolve));
}

function body(dir: string): string {
	const [name] = readdirSync(dir).filter((file) => file.endsWith(".txt")).sort();
	return readFileSync(join(dir, name!), "utf8");
}

test("without AGENTS.md, or with empty ones, the request is byte for byte the same; with one, only the system text grows", async () => {
	const home = mkdtempSync(join(tmpdir(), "mountains-instr-cli-"));
	const ws = mkdtempSync(join(tmpdir(), "mountains-instr-cliws-"));
	const plain = join(home, "plain"), blank = join(home, "blank"), blankProject = join(home, "blank-project"), filled = join(home, "filled");
	for (const dir of [plain, blank, blankProject, filled]) mkdirSync(dir);
	assert.equal(await runCli(ws, home, plain), 0);
	writeFileSync(join(home, "AGENTS.md"), "\n");
	assert.equal(await runCli(ws, home, blank), 0);
	assert.equal(body(blank), body(plain), "an empty ~/.mountains/AGENTS.md changes nothing");
	type Body = { messages: { role: string; content: string }[] };
	const before = JSON.parse(body(plain)) as Body;
	// A file in the workspace shows up in the repository facts like any file; the system text must not change.
	writeFileSync(join(ws, "AGENTS.md"), "  \n");
	assert.equal(await runCli(ws, home, blankProject), 0);
	assert.equal((JSON.parse(body(blankProject)) as Body).messages[0]!.content, before.messages[0]!.content);
	writeFileSync(join(ws, "AGENTS.md"), "Run tests with npm test.");
	assert.equal(await runCli(ws, home, filled), 0);
	const after = JSON.parse(body(filled)) as Body;
	assert.equal(after.messages[0]!.content, `${before.messages[0]!.content}\n\n# Project instructions (AGENTS.md)\nRun tests with npm test.`);
	assert.deepEqual(after.messages[1], before.messages[1]);
	const rest = (b: Body) => ({ ...b, messages: [] });
	assert.deepEqual(rest(after), rest(before), "tools and settings are unchanged");
});

test("memory off adds no tool; memory on adds memory_search and nothing else", async () => {
	const home = mkdtempSync(join(tmpdir(), "mountains-memory-cli-"));
	const ws = mkdtempSync(join(tmpdir(), "mountains-memory-cliws-"));
	const off = join(home, "off"), on = join(home, "on");
	mkdirSync(off); mkdirSync(on);
	assert.equal(await runCli(ws, home, off), 0);
	assert.equal(await runCli(ws, home, on, { memory: true }), 0);
	type Body = { messages: unknown[]; tools: { function: { name: string } }[] };
	const a = JSON.parse(body(off)) as Body, b = JSON.parse(body(on)) as Body;
	assert.ok(!a.tools.some((tool) => tool.function.name === "memory_search"));
	assert.deepEqual(b.tools.map((tool) => tool.function.name).filter((name) => !a.tools.some((tool) => tool.function.name === name)), ["memory_search"]);
	assert.deepEqual(b.messages, a.messages);
});
