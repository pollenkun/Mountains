#!/usr/bin/env node
import { enableMountainsCompileCache } from "./startup-cache.ts";

const [command] = process.argv.slice(2);
// Help/version/usage keep their existing no-write behavior. Run/replay and the
// interactive entry are the only routes that can benefit from caching the engine.
if (command === "run" || command === "replay"
	|| (command === undefined || command === "--demo") && process.stdin.isTTY && process.stdout.isTTY) {
	enableMountainsCompileCache();
}
try {
	await import("./cli-main.ts");
} catch (error) {
	process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
