import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnv } from "./env.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OLD_USAGE = "用法：\n  mountains run --task <描述> | --task-file <路径> --workspace <路径> [--config <json>] [--json] [--out <目录>] [--run-id <id>] [--base-url <url>] [--spend-ledger <路径>]\n" +
	"  mountains replay --recording <recording.jsonl> --workspace <路径> [--out <目录>] [--json]\n";

function run(main: string, args: string[], preload?: string, noWrites = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const home = mkdtempSync(join(tmpdir(), "mountains-entry-home-"));
	const env = isolatedEnv(home);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), main, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", data => { stdout += String(data); });
		child.stderr.on("data", data => { stderr += String(data); });
		child.on("error", error => { rmSync(home, { recursive: true, force: true }); reject(error); });
		child.on("close", code => {
			try {
				if (noWrites) assert.deepEqual(readdirSync(home), [], "help/version must leave the home directory untouched");
				resolve({ code, stdout, stderr });
			} catch (error) { reject(error); }
			finally { rmSync(home, { recursive: true, force: true }); }
		});
	});
}

test("no arguments outside TTY preserve the original CLI usage and exit code", async () => {
	const result = await run(MAIN, []);
	assert.deepEqual(result, { code: 2, stdout: "", stderr: OLD_USAGE });
});

test("an unknown command is a usage error", async () => {
	const result = await run(MAIN, ["--demo"]);
	assert.deepEqual(result, { code: 2, stdout: "", stderr: `错误：未知命令 --demo\n${OLD_USAGE}` });
});

test("version works without a key or TTY and does not emit terminal control codes", async () => {
	const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
	assert.deepEqual(await run(MAIN, ["--version"], undefined, true), { code: 0, stdout: `mountains ${version}\n`, stderr: "" });
});

test("version with extra arguments and existing commands retain CLI usage errors", async () => {
	for (const [args, error] of [
		[["--version", "extra"], "未知命令 --version"],
		[["run"], "缺少 --workspace"],
		[["replay"], "replay 需要 --recording 与 --workspace"],
	] as const) {
		assert.deepEqual(await run(MAIN, [...args]), { code: 2, stdout: "", stderr: `错误：${error}\n${OLD_USAGE}` });
	}
});

test("without a command the CLI shows its usage, in a terminal too", async () => {
	assert.deepEqual(await run(MAIN, []), { code: 2, stdout: "", stderr: OLD_USAGE });
});

test("help is successful without configuration, credentials, a TTY or filesystem writes", async () => {
	for (const args of [["--help"], ["-h"], ["run", "--help"], ["run", "-h"], ["replay", "--help"], ["replay", "-h"], ["run", "--help", "--config", "missing-config.json"], ["replay", "--help", "--recording", "missing-recording.jsonl"]]) {
		assert.deepEqual(await run(MAIN, args, undefined, true), { code: 0, stdout: OLD_USAGE, stderr: "" });
	}
});
