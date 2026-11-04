import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReleaseAsset } from "../update-types.ts";

function secureUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password) throw new Error("Updates require HTTPS");
	return url.href;
}
export async function releaseMetadata(url: string, fetcher: typeof fetch = fetch): Promise<unknown | null> {
	const response = await fetcher(secureUrl(url), { signal: AbortSignal.timeout(12_000), headers: { "Cache-Control": "no-cache" } });
	secureUrl(response.url || url);
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`Release HTTP ${response.status}`);
	if (!response.body) throw new Error("Empty release metadata");
	let bytes = 0; const chunks: Uint8Array[] = [];
	for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 64 * 1024) throw new Error("Release metadata too large"); chunks.push(chunk); }
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** Write to a unique partial file. Only a complete file of the expected size and SHA-512 becomes installable. */
export async function downloadAsset(base: string, asset: ReleaseAsset, directory: string, progress: (percent: number) => void, fetcher: typeof fetch = fetch): Promise<string> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(asset.file)) throw new Error("Invalid update filename");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const dest = join(directory, asset.file), partial = `${dest}.${randomUUID()}.part`;
	const url = secureUrl(new URL(asset.file, base).href);
	try {
		const response = await fetcher(url, { signal: AbortSignal.timeout(30 * 60_000) });
		secureUrl(response.url || url);
		if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}`);
		let count = 0, reported = 0;
		const hash = createHash("sha512");
		const verify = new Transform({ transform(chunk: Buffer, _encoding, done) {
			count += chunk.byteLength;
			if (count > asset.size) { done(new Error("Update larger than declared size")); return; }
			hash.update(chunk);
			if (Date.now() - reported > 150) { reported = Date.now(); progress(count / asset.size * 100); }
			done(null, chunk);
		} });
		await pipeline(Readable.fromWeb(response.body as never), verify, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
		if (count !== asset.size || hash.digest("base64") !== asset.sha512) throw new Error("Update checksum mismatch");
		await rename(partial, dest); progress(100); return dest;
	} finally { await rm(partial, { force: true }); }
}

/** Bounded requests avoid losing an entire installer when a proxy ends a long response. */
export async function downloadAssetInRanges(url: string, asset: ReleaseAsset, destination: string, progress: (percent: number) => void, fetcher: typeof fetch = fetch, chunkSize = 8 * 1024 * 1024): Promise<string> {
	secureUrl(url);
	if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("Invalid range size");
	const partial = `${destination}.${randomUUID()}.part`;
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const file = await open(partial, "wx", 0o600);
	const hash = createHash("sha512");
	try {
		for (let start = 0; start < asset.size;) {
			const end = Math.min(start + chunkSize, asset.size) - 1;
			let bytes: Buffer | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(60_000) });
					secureUrl(response.url || url);
					if (response.status === 200 && start === 0) {
						await response.body?.cancel();
						const path = await downloadAsset(new URL(".", url).href, asset, dirname(destination), progress, fetcher);
						if (path !== destination) await rename(path, destination);
						return destination;
					}
					if (!response.body || (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${asset.size}`)) {
						await response.body?.cancel(); throw new Error("Invalid update range response");
					}
					const expected = end - start + 1;
					const chunks: Uint8Array[] = []; let size = 0;
					for await (const chunk of response.body) {
						size += chunk.byteLength;
						if (size > expected) throw new Error("Update larger than declared range");
						chunks.push(chunk);
					}
					if (size !== expected) throw new Error("Truncated update range");
					bytes = Buffer.concat(chunks); break;
				} catch (error) { if (attempt === 2) throw error; }
			}
			if (!bytes) throw new Error("Update range missing");
			hash.update(bytes); await file.writeFile(bytes); start += bytes.length;
			progress(Math.min(99, start / asset.size * 100));
		}
		if (hash.digest("base64") !== asset.sha512) throw new Error("Update checksum mismatch");
		await file.close(); await rename(partial, destination); progress(100); return destination;
	} finally { await file.close(); await rm(partial, { force: true }); }
}
