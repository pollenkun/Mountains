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
	} else {
		if (command) process.stderr.write(`错误：未知命令 ${command}\n`);
		process.stderr.write(USAGE);
		process.exitCode = 2;
	}
} catch (error) {
	process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
