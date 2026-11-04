/** Builds the page with Vite and the sandboxed preload (CommonJS) with tsc into dist/. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({ configFile: join(root, "vite.config.ts") });
const tsc = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.preload.json"), "--pretty", "false"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) throw new Error("preload compile failed");
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "package.json"), "{ \"type\": \"commonjs\" }\n");
