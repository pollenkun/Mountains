#!/usr/bin/env node
import { enableMountainsCompileCache } from "./startup-cache.ts";

const [command, ...args] = process.argv.slice(2);
// Help/version/usage must not write to the user's home or initialize run state.
if ((command === "run" || command === "replay") && !args.some(arg => arg === "--help" || arg === "-h")) {
	enableMountainsCompileCache();
}
try {
	await import("./cli-main.ts");
} catch (error) {
	process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
