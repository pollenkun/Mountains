#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { enableMountainsCompileCache } from "./startup-cache.ts";
import { USAGE, parseRunArgs, parseReplayArgs } from "./cli-args.ts";

const [command, ...args] = process.argv.slice(2);
try {
	if ((command === "--help" || command === "-h") && args.length === 0) process.stdout.write(USAGE);
	else if (command === "--version" && args.length === 0) {
		const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
		process.stdout.write(`mountains ${version}\n`);
	} else if (command === "run" || command === "replay") {
		const { values } = command === "run" ? parseRunArgs(args) : parseReplayArgs(args);
		if (values.help) process.stdout.write(USAGE);
		else {
			enableMountainsCompileCache();
			await import("./cli-main.ts");
		}
	} else if (command === "computer-history") {
		const { readHistory } = await import("@mountains/computer/history");
		const { join } = await import("node:path");
		const { mountainsHome } = await import("./paths.ts");
		const days = Math.max(1, Math.min(31, Number(args[args.indexOf("--days") + 1]) || 1));
		const entries = await readHistory(join(mountainsHome(), "computer-history"), args.includes("--days") ? days : 1);
		if (!entries.length) process.stdout.write("没有 Computer-use 操作记录。\n");
		for (const e of entries) process.stdout.write(`${e.at.replace("T", " ").slice(0, 19)}  ${e.tool === "web_act" ? "网页" : "应用"} ${e.target}  ${e.action}  ${e.outcome}  ${e.ms} ms\n`);
	} else if (command === "models") {
		const { searchModels } = await import("./cli-models.ts");
		searchModels(args);
	} else if (command === "secret") {
		// Only the Keychain helper and a small scope file; the engine is not loaded.
		await (await import("./cli-secret.ts")).cmdSecret(args);
	} else {
		if (command) process.stderr.write(`错误：未知命令 ${command}\n`);
		process.stderr.write(USAGE);
		process.exitCode = 2;
	}
} catch (error) {
	process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
