import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createUpdates, validateRelease, type ReleaseAsset, type UpdatePreferences } from "../src/main/updates.ts";
import { downloadAsset, releaseMetadata } from "../src/main/update-download.ts";
import { prepareRelease } from "../scripts/release-feed.ts";
import { verifyRelease } from "../scripts/verify-release.ts";

const prefs: UpdatePreferences = { channel: "preview", source: "auto", automatic: false };
const bytes = Buffer.from("update integrity fixture, not an installer");
const asset: ReleaseAsset = { version: "0.2.0-preview.3", channel: "preview", platform: "darwin", arch: "arm64", file: "Mountains-0.2.0-preview.3-mac-arm64.dmg", sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
const endpoints = [{ id: "hk" as const, url: "https://hk.invalid/" }, { id: "github" as const, url: "https://github.invalid/" }];
function fixture(options: { metadata?: (url: string) => Promise<unknown | null>; download?: (source: string) => Promise<string>; automatic?: boolean; busy?: () => boolean } = {}) {
	const calls: string[] = [], installed: string[] = [];
	const updates = createUpdates({ version: "0.2.0-preview.2", platform: "darwin", arch: "arm64", installMode: "manual", preferences: () => ({ ...prefs, automatic: options.automatic ?? false }), endpoints: () => endpoints,
		isBusy: options.busy ?? (() => false), transport: {
			metadata: options.metadata ?? (async () => asset),
			download: async source => { calls.push(source.id); return options.download ? options.download(source.id) : "/verified.dmg"; },
			install: async path => { installed.push(path); },
		} });
	return { updates, calls, installed };
}
test("uses semantic versions, stable excludes previews, and no downgrade is offered", async () => {
	for (const version of ["0.2.0-preview.1", "0.2.0-preview.2"]) {
		const f = fixture({ metadata: async () => ({ ...asset, version }) }); assert.equal((await f.updates.check()).phase, "latest");
	}
	const f = fixture({ metadata: async () => ({ ...asset, version: "0.2.0-preview.10" }) }); assert.equal((await f.updates.check()).phase, "available");
	assert.throws(() => validateRelease(asset, { ...prefs, channel: "stable" }, "darwin", "arm64"));
});
test("falls back when Hong Kong cannot be reached, but does not call a network failure up to date", async () => {
	const f = fixture({ metadata: async url => { if (url.includes("hk.invalid")) throw new Error("timeout"); return asset; } });
	assert.equal((await f.updates.check()).source, "github");
	assert.equal((await fixture({ metadata: async () => { throw new Error("offline"); } }).updates.check()).phase, "error");
	assert.equal((await fixture({ metadata: async () => null }).updates.check()).phase, "unpublished");
});
test("download fallback requires exactly the same release, filename, size and checksum", async () => {
	const f = fixture({ automatic: true, download: async source => { if (source === "hk") throw new Error("cut off"); return "/verified.dmg"; } });
	assert.equal((await f.updates.check()).phase, "ready"); assert.deepEqual(f.calls, ["hk", "github"]);
	for (const mismatch of [{ version: "0.2.0-preview.1" }, { sha512: createHash("sha512").update("different").digest("base64") }, { size: 5 }]) {
		const bad = fixture({ automatic: true, metadata: async url => url.includes("hk.invalid") ? asset : { ...asset, ...mismatch }, download: async () => { throw new Error("broken"); } });
		assert.equal((await bad.updates.check()).phase, "error"); assert.deepEqual(bad.calls, ["hk"]);
	}
});
test("manual download is opt in and active or approval-waiting tasks cannot be interrupted by install", async () => {
	let busy = true; const f = fixture({ busy: () => busy });
	await f.updates.check(); assert.deepEqual(f.calls, []); await f.updates.download();
	await assert.rejects(f.updates.install(), /TASKS_RUNNING/); assert.deepEqual(f.installed, []);
	busy = false; await f.updates.install(); assert.deepEqual(f.installed, ["/verified.dmg"]);
});
test("settings cannot replace a release in the middle of its download", async () => {
	let finish!: (path: string) => void;
	const f = fixture({ download: () => new Promise(resolve => { finish = resolve; }) });
	await f.updates.check(); const download = f.updates.download();
	assert.throws(() => f.updates.reset(), /UPDATE_IN_PROGRESS/); finish("/verified.dmg"); await download;
	f.updates.reset(); await assert.rejects(f.updates.install(), /UPDATE_NOT_READY/);
});
test("repeated checks and downloads leave one active download and its release unchanged", async () => {
	let finish!: (path: string) => void;
	let metadataCalls = 0;
	const f = fixture({ metadata: async () => { metadataCalls++; return asset; }, download: () => new Promise(resolve => { finish = resolve; }) });
	await f.updates.check(); const active = f.updates.download();
	for (let attempt = 0; attempt < 5; attempt++) {
		assert.equal((await f.updates.check()).phase, "downloading");
		assert.equal((await f.updates.download()).version, asset.version);
	}
	assert.equal(metadataCalls, 1); assert.deepEqual(f.calls, ["hk"]);
	finish("/verified.dmg"); assert.equal((await active).phase, "ready");
	assert.equal((await f.updates.check()).phase, "ready");
	assert.equal(metadataCalls, 1); assert.deepEqual(f.calls, ["hk"]);
});
test("wrong architecture, unsafe filenames, missing hashes and excessive sizes are rejected", () => {
	for (const bad of [{ arch: "x64" }, { file: "../evil.dmg" }, { file: "https://evil.invalid/p.dmg" }, { sha512: "" }, { size: 0 }, { size: 3 * 1024 ** 3 }]) assert.throws(() => validateRelease({ ...asset, ...bad }, prefs, "darwin", "arm64"));
});
test("streamed download verifies bytes and removes corrupt, oversized and truncated partial files", async t => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-update-download-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fetcher = (async () => new Response(bytes)) as typeof fetch;
	const path = await downloadAsset("https://fixture.invalid/", asset, dir, () => {}, fetcher);
	assert.deepEqual(readFileSync(path), bytes); rmSync(path);
	for (const body of [bytes.subarray(1), Buffer.concat([bytes, bytes]), Buffer.alloc(bytes.length)]) {
		await assert.rejects(downloadAsset("https://fixture.invalid/", asset, dir, () => {}, (async () => new Response(body)) as typeof fetch));
		assert.deepEqual(readdirSync(dir), []);
	}
	await assert.rejects(downloadAsset("http://fixture.invalid/", asset, dir, () => {}, fetcher), /HTTPS/);
});
test("metadata is bounded and an unpublished version is distinct from an error", async () => {
	assert.equal(await releaseMetadata("https://fixture.invalid/x", (async () => new Response(null, { status: 404 })) as typeof fetch), null);
	await assert.rejects(releaseMetadata("https://fixture.invalid/x", (async () => new Response(" ".repeat(70_000))) as typeof fetch), /too large/);
});
test("a real interrupted response switches mirrors, rejects corrupt bytes, and permits retry", async t => {
	let primaryWorks = false, corruptBackup = false;
	const server = createServer((request, response) => {
		if (request.url?.endsWith(".json")) { response.end(JSON.stringify(asset)); return; }
		response.writeHead(200, { "Content-Length": bytes.length });
		if (request.url?.startsWith("/hk/") && !primaryWorks) {
			response.write(bytes.subarray(0, 5)); setImmediate(() => response.destroy()); return;
		}
		response.end(corruptBackup ? Buffer.alloc(bytes.length) : bytes);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const dir = mkdtempSync(join(tmpdir(), "mountains-update-network-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fetcher = (async (input, init) => {
		const url = new URL(String(input));
		const reply = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${url.hostname.split(".")[0]}${url.pathname}`, init);
		return new Response(reply.body, { status: reply.status, headers: reply.headers });
	}) as typeof fetch;
	const calls: string[] = [];
	const updates = createUpdates({ version: "0.2.0-preview.2", platform: "darwin", arch: "arm64", installMode: "manual", preferences: () => prefs, endpoints: () => endpoints, isBusy: () => false,
		transport: { metadata: url => releaseMetadata(url, fetcher), download: async (source, info, progress) => { calls.push(source.id); return downloadAsset(source.url, info, dir, progress, fetcher); }, install: async () => {} } });
	await updates.check(); assert.equal((await updates.download()).source, "github");
	assert.equal(updates.state().phase, "ready"); assert.deepEqual(calls, ["hk", "github"]);
	assert.deepEqual(readFileSync(join(dir, asset.file)), bytes); rmSync(join(dir, asset.file));
	updates.reset(); corruptBackup = true; await updates.check();
	assert.equal((await updates.download()).phase, "error"); assert.deepEqual(readdirSync(dir), []);
	primaryWorks = true; corruptBackup = false;
	assert.equal((await updates.download()).phase, "ready"); assert.deepEqual(readFileSync(join(dir, asset.file)), bytes);
});
test("release catalog and native YAML bind the same installer bytes; reusing a filename with different bytes fails", async t => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-release-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "Mountains-0.2.0-preview.3-win-arm64.exe"), out = join(dir, "feed"); writeFileSync(file, bytes);
	const prepared = await prepareRelease(file, "win32", "arm64", out, { version: asset.version });
	const native = JSON.parse(readFileSync(join(out, "preview-win32-arm64.yml"), "utf8"));
	assert.equal(native.files[0].sha512, prepared.sha512); assert.equal(native.files[0].url, prepared.file);
	writeFileSync(file, "changed"); await assert.rejects(prepareRelease(file, "win32", "arm64", out, { version: asset.version }), /Bump the version/);
});
test("release audit rejects a stale feed copy even when its own checksum is consistent", async t => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-release-audit-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "Mountains-0.2.0-preview.3-win-arm64.exe"), out = join(dir, "feed"); writeFileSync(file, bytes);
	await prepareRelease(file, "win32", "arm64", out, { version: asset.version });
	assert.equal(await verifyRelease(out, dir, asset.version), 1);
	writeFileSync(file, "rebuilt installer");
	await assert.rejects(verifyRelease(out, dir, asset.version), /Installer bytes differ/);
});
test("release audit rejects mixed native metadata, mislabeled versions and extra files", async t => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-release-audit-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "Mountains-0.2.0-preview.3-win-arm64.exe"), out = join(dir, "feed"); writeFileSync(file, bytes);
	await prepareRelease(file, "win32", "arm64", out, { version: asset.version });
	await assert.rejects(verifyRelease(out, dir, "0.2.0-preview.4"), /version or filename/);
	const yaml = join(out, "preview-win32-arm64.yml"), original = readFileSync(yaml, "utf8");
	writeFileSync(yaml, original.replace(asset.sha512, "wrong"));
	await assert.rejects(verifyRelease(out, dir, asset.version), /Native metadata mismatch/);
	writeFileSync(yaml, original); writeFileSync(join(out, "qa-settings.json"), "{}");
	await assert.rejects(verifyRelease(out, dir, asset.version));
});

test("bounded installer requests retry only an interrupted range and preserve the final hash", async t => {
	const { downloadAssetInRanges } = await import("../src/main/update-download.ts");
	const dir = mkdtempSync(join(tmpdir(), "mountains-ranges-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const requested: string[] = []; let cut = false;
	const fetcher = (async (_url, init) => {
		const range = new Headers(init?.headers).get("Range")!; requested.push(range);
		const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!; const start = Number(a), end = Number(b);
		const body = bytes.subarray(start, end + 1);
		const headers = { "Content-Range": `bytes ${start}-${end}/${bytes.length}` };
		if (start === 8 && !cut) { cut = true; return new Response(body.subarray(0, 2), { status: 206, headers }); }
		return new Response(body, { status: 206, headers });
	}) as typeof fetch;
	const path = await downloadAssetInRanges("https://fixture.invalid/installer.exe", asset, join(dir, "installer.exe"), () => {}, fetcher, 8);
	assert.deepEqual(readFileSync(path), bytes);
	assert.equal(requested.filter(x => x === "bytes=0-7").length, 1);
	assert.equal(requested.filter(x => x === "bytes=8-15").length, 2);
	assert.deepEqual(readdirSync(dir), ["installer.exe"]);
});
test("bounded downloads reject shifted ranges, corrupt bytes and ignored ranges after the first chunk", async t => {
	const { downloadAssetInRanges } = await import("../src/main/update-download.ts");
	const dir = mkdtempSync(join(tmpdir(), "mountains-range-reject-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const bad of ["shifted", "corrupt", "ignored"]) {
		const fetcher = (async (_url, init) => {
			const [, a, b] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get("Range")!)!;
			const start = Number(a), end = Number(b);
			if (bad === "ignored" && start) return new Response(bytes);
			return new Response(bad === "corrupt" ? Buffer.alloc(end - start + 1) : bytes.subarray(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${bad === "shifted" ? start + 1 : start}-${end}/${bytes.length}` } });
		}) as typeof fetch;
		await assert.rejects(downloadAssetInRanges("https://fixture.invalid/x", asset, join(dir, "x"), () => {}, fetcher, 8));
		assert.deepEqual(readdirSync(dir), []);
	}
});
test("native download bridge keeps metadata intact and rejects a different installer", async t => {
	const { useRangeDownload } = await import("../src/main/update-native-download.ts");
	const dir = mkdtempSync(join(tmpdir(), "mountains-native-bridge-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const metadata = () => "unchanged";
	const updater = { httpExecutor: { metadata, download: async (_url: URL, _dest: string, _opts: { sha512?: string }) => "unused" } };
	useRangeDownload(updater, asset, () => {}, (async () => new Response(bytes)) as typeof fetch);
	const dest = join(dir, "native-temp.dmg");
	await updater.httpExecutor.download(new URL(`https://fixture.invalid/${asset.file}`), dest, { sha512: asset.sha512 });
	assert.deepEqual(readFileSync(dest), bytes); assert.equal(updater.httpExecutor.metadata, metadata);
	await assert.rejects(updater.httpExecutor.download(new URL("https://fixture.invalid/other.exe"), dest, { sha512: asset.sha512 }));
	assert.throws(() => useRangeDownload({}, asset, () => {}, fetch), /unavailable/);
});

test("Mac DMG range failure discards partial bytes and finishes from a matching mirror", async t => {
	const { downloadAssetInRanges } = await import("../src/main/update-download.ts");
	const dir = mkdtempSync(join(tmpdir(), "mountains-mac-range-failover-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const requests: string[] = [];
	const server = createServer((request, response) => {
		if (request.url?.endsWith(".json")) { response.end(JSON.stringify(asset)); return; }
		const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.range!)!;
		const start = Number(a), end = Number(b); requests.push(`${request.url}:${start}`);
		response.writeHead(206, { "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${bytes.length}` });
		if (request.url?.startsWith("/hk/") && start === 8) { response.write(bytes.subarray(start, start + 1)); setImmediate(() => response.destroy()); return; }
		response.end(bytes.subarray(start, end + 1));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
	const fetcher = (async (url, init) => {
		const parsed = new URL(String(url));
		const reply = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${parsed.hostname.split(".")[0]}${parsed.pathname}`, init);
		return new Response(reply.body, { status: reply.status, headers: reply.headers });
	}) as typeof fetch;
	const updates = createUpdates({ version: "0.2.0-preview.2", platform: "darwin", arch: "arm64", installMode: "manual", preferences: () => prefs, endpoints: () => endpoints, isBusy: () => false,
		transport: { metadata: url => releaseMetadata(url, fetcher), download: (source, info, progress) => downloadAssetInRanges(new URL(info.file, source.url).href, info, join(dir, info.file), progress, fetcher, 8), install: async () => {} } });
	await updates.check(); assert.equal((await updates.download()).source, "github"); assert.equal(updates.state().phase, "ready");
	assert.equal(requests.filter(x => x.startsWith("/hk/") && x.endsWith(":0")).length, 1);
	assert.equal(requests.filter(x => x.startsWith("/hk/") && x.endsWith(":8")).length, 3);
	assert.deepEqual(readFileSync(join(dir, asset.file)), bytes); assert.deepEqual(readdirSync(dir), [asset.file]);
});
