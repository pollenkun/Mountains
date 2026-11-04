import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const task = "用一句话回答：1+1 等于几？";

function run(args: string[], captureDir: string, home: string, extra: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra, MOUNTAINS_HOME: home, MOUNTAINS_BUDGET: "5", DEEPSEEK_API_KEY: "desktop-test-key", MOUNTAINS_TEST_KEYS: "1", MOUNTAINS_CAPTURE_DIR: captureDir };
	delete env.NODE_OPTIONS;
	delete env.ELECTRON_RUN_AS_NODE;
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.on("close", (code) => resolve({ code, stderr }));
	});
}

function bodies(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.endsWith(".txt")).sort().map((name) => readFileSync(join(dir, name), "utf8"));
}

function firstDifference(left: string, right: string): string {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		if (left[index] !== right[index]) return `byte ${index}: ${JSON.stringify(left.slice(index, index + 80))} vs ${JSON.stringify(right.slice(index, index + 80))}`;
	}
	return `length ${left.length} vs ${right.length}`;
}

test("desktop engine host sends the same request bytes as the CLI", async () => {
	const home = mkdtempSync(join(tmpdir(), "mountains-desktop-home-"));
	const workspace = mkdtempSync(join(tmpdir(), "mountains-desktop-ws-"));
	const config = join(home, "config.json");
	writeFileSync(config, `${JSON.stringify({
		model: "deepseek-flash",
		baseUrl: "https://offline.invalid/v1",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		checkpoints: false,
		skills: { enabled: false, dirs: [], enable: [], permissions: {} },
		retry: { maxAttempts: 1, baseDelayMs: 0 },
		limits: { maxTurns: 4, maxRequests: 4, maxCost: 5 },
	})}\n`);
	const cliCapture = join(home, "cli-bodies");
	const desktopCapture = join(home, "desktop-bodies");
	const capture = join(root, "apps/desktop/test/capture-fetch.mjs");
	const shared = ["--import", capture];
	const cli = await run([
		...shared,
		join(root, "apps/cli/src/main.ts"),
		"run",
		"--task", task,
		"--workspace", workspace,
		"--config", config,
		"--out", join(home, "cli-out"),
		"--spend-ledger", join(home, "cli-spend.jsonl"),
		"--json",
	], cliCapture, home, {});
	assert.equal(cli.code, 0, cli.stderr);
	const desktop = await run([
		...shared,
		join(root, "apps/desktop/src/main/run-once.ts"),
		"--task", task,
		"--workspace", workspace,
		"--config", config,
		"--out", join(home, "desktop-out"),
		"--spend-ledger", join(home, "desktop-spend.jsonl"),
	], desktopCapture, home, {});
	assert.equal(desktop.code, 0, desktop.stderr);
	const left = bodies(cliCapture);
	const right = bodies(desktopCapture);
	assert.equal(left.length, 1, `CLI requests: ${left.length}\n${cli.stderr}`);
	assert.equal(right.length, 1, `desktop requests: ${right.length}\n${desktop.stderr}`);
	assert.equal(left[0], right[0], firstDifference(left[0] ?? "", right[0] ?? ""));
	assert.ok(left[0]?.includes(task));
});
