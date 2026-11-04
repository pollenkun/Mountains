/** Produce matching JSON and native-updater YAML from the exact installer bytes. No credentials or network. */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../src/main/version.ts";
import { validateRelease } from "../src/main/updates.ts";
import type { ReleaseAsset, UpdateChannel } from "../src/update-types.ts";

export async function prepareRelease(installer: string, platform: "darwin" | "win32", arch: "arm64" | "x64", out: string, options: { version?: string; notes?: string } = {}): Promise<ReleaseAsset> {
	const version = options.version ?? APP_VERSION;
	const channel: UpdateChannel = version.includes("-") ? "preview" : "stable";
	const sha = createHash("sha512"); for await (const chunk of createReadStream(installer)) sha.update(chunk);
	const asset: ReleaseAsset = { version, channel, platform, arch, file: basename(installer), sha512: sha.digest("base64"), size: statSync(installer).size, ...(options.notes ? { notes: options.notes } : {}) };
	validateRelease(asset, { channel, source: "auto", automatic: false }, platform, arch);
	mkdirSync(out, { recursive: true });
	const dest = join(out, asset.file);
	if (existsSync(dest)) {
		const old = createHash("sha512"); for await (const chunk of createReadStream(dest)) old.update(chunk);
		if (old.digest("base64") !== asset.sha512) throw new Error("An installer with this filename already exists with different bytes. Bump the version.");
	} else copyFileSync(installer, dest);
	const name = `${channel}-${platform}-${arch}`;
	// JSON is valid YAML. Windows reads this via electron-updater's generic provider.
	const native = { version, files: [{ url: asset.file, sha512: asset.sha512, size: asset.size }], path: asset.file, sha512: asset.sha512, releaseDate: new Date().toISOString() };
	if (platform === "win32") writeFileSync(join(out, `${name}.yml`), JSON.stringify(native, null, 2) + "\n");
	writeFileSync(join(out, `${name}.json`), JSON.stringify(asset, null, 2) + "\n");
	return asset;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [platform, arch, installer, out, notes] = process.argv.slice(2);
	if ((platform !== "darwin" && platform !== "win32") || (arch !== "arm64" && arch !== "x64") || !installer || !out) throw new Error("Usage: node scripts/release-feed.ts darwin|win32 arm64|x64 installer output-directory [notes-file]");
	console.log(JSON.stringify(await prepareRelease(installer, platform, arch, out, notes ? { notes: readFileSync(notes, "utf8").trim() } : {}), null, 2));
}
