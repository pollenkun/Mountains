/** Bundles the Electron main process into dist/main.js so an installer can ship it. Electron itself stays outside the bundle. */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const result = spawnSync("npx", ["--yes", "esbuild", join(root, "src/main/index.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${join(root, "dist/main.mjs")}`, "--external:electron", "--external:electron-updater", "--loader:.node=file"], {
	cwd: root,
	stdio: "inherit",
});
if (result.status !== 0) throw new Error("main bundle failed");
const catalog = join(root, "dist/catalog");
mkdirSync(catalog, { recursive: true });
const from = join(repo, "packages/providers/catalog");
for (const name of ["models.dev.snapshot.json", "zh-names.json"]) copyFileSync(join(from, name), join(catalog, name));
