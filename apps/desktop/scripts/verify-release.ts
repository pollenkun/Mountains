/** Check the exact files to publish, including copies left behind by an earlier build. */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../src/main/version.ts";
import { validateRelease } from "../src/main/updates.ts";

async function digest(path: string): Promise<string> {
	const hash = createHash("sha512");
	for await (const bytes of createReadStream(path)) hash.update(bytes);
	return hash.digest("base64");
}
export async function verifyRelease(directory: string, candidates?: string, version = APP_VERSION): Promise<number> {
	const names = readdirSync(directory), allowed = new Set<string>();
	const catalogs = names.filter(name => name.endsWith(".json"));
	if (!catalogs.length) throw new Error("No release catalogs");
	for (const name of catalogs) {
		const raw = JSON.parse(readFileSync(join(directory, name), "utf8"));
		if (!["darwin", "win32"].includes(raw.platform) || !["arm64", "x64"].includes(raw.arch)) throw new Error("Unsupported release target");
		const channel = version.includes("-") ? "preview" : "stable";
		const asset = validateRelease(raw, { channel, source: "auto", automatic: false }, raw.platform, raw.arch);
		const stem = `${channel}-${asset.platform}-${asset.arch}`;
		const expected = `Mountains-${version}-${asset.platform === "darwin" ? "mac" : "win"}-${asset.arch}.${asset.platform === "darwin" ? "dmg" : "exe"}`;
		if (asset.version !== version || name !== `${stem}.json` || asset.file !== expected) throw new Error(`Release version or filename mismatch: ${name}`);
		for (const path of [join(directory, asset.file), ...(candidates ? [join(candidates, asset.file)] : [])]) {
			if (statSync(path).size !== asset.size || await digest(path) !== asset.sha512) throw new Error(`Installer bytes differ from catalog: ${path}`);
		}
		allowed.add(name); allowed.add(asset.file);
		if (asset.platform === "win32") {
			const yaml = `${stem}.yml`, native = JSON.parse(readFileSync(join(directory, yaml), "utf8"));
			if (native.version !== asset.version || native.path !== asset.file || native.sha512 !== asset.sha512 || native.files?.length !== 1 || native.files[0].url !== asset.file || native.files[0].sha512 !== asset.sha512 || native.files[0].size !== asset.size) throw new Error(`Native metadata mismatch: ${yaml}`);
			allowed.add(yaml);
		}
	}
	if (names.some(name => !allowed.has(name))) throw new Error("Release directory contains unexpected files");
	return catalogs.length;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (!process.argv[2]) throw new Error("Usage: node scripts/verify-release.ts feed-directory [candidate-directory]");
	console.log(`Verified ${await verifyRelease(process.argv[2], process.argv[3])} release catalogs and their installer bytes`);
}
