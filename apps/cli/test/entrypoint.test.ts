import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OLD_USAGE = "用法：\n  mountains run --task <描述> | --task-file <路径> --workspace <路径> [--config <json>] [--json] [--out <目录>] [--run-id <id>] [--base-url <url>] [--spend-ledger <路径>]\n" +
	"  mountains replay --recording <recording.jsonl> --workspace <路径> [--out <目录>] [--json]\n";

function run(main: string, args: string[], preload?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const home = mkdtempSync(join(tmpdir(), "mountains-entry-home-"));
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
	for (const key of ["DEEPSEEK_API_KEY", "ZHIPU_API_KEY", "MOONSHOT_API_KEY"]) delete env[key];
	delete env.NODE_COMPILE_CACHE;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...(preload ? ["--import", preload] : []), main, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", data => { stdout += String(data); });
		child.stderr.on("data", data => { stderr += String(data); });
		child.on("error", error => { rmSync(home, { recursive: true, force: true }); reject(error); });
		child.on("close", code => { rmSync(home, { recursive: true, force: true }); resolve({ code, stdout, stderr }); });
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
	assert.deepEqual(await run(MAIN, ["--version"]), { code: 0, stdout: `mountains ${version}\n`, stderr: "" });
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
