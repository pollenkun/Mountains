import { app, net, shell } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { NsisUpdater } from "electron-updater";
import { createUpdates, type UpdatePreferences, type UpdateState } from "./updates.ts";
import { downloadAssetInRanges, releaseMetadata } from "./update-download.ts";
import { useRangeDownload } from "./update-native-download.ts";
import { APP_VERSION } from "./version.ts";

export function startUpdates(options: { preferences: () => UpdatePreferences; isBusy: () => boolean; changed: (state: UpdateState) => void; enabled: boolean }) {
	let installer: NsisUpdater | null = null;
	const fetcher = ((url, init) => net.fetch(url as string, init)) as typeof fetch;
	const nativeInstall = process.platform === "win32" && app.isPackaged;
	const updates = createUpdates({
		version: APP_VERSION, platform: process.platform, arch: process.arch,
		preferences: options.preferences, isBusy: options.isBusy, changed: options.changed,
		installMode: nativeInstall ? "restart" : "manual",
		transport: {
			metadata: url => releaseMetadata(url, fetcher),
			async download(endpoint, asset, progress) {
				if (!nativeInstall) return downloadAssetInRanges(new URL(asset.file, endpoint.url).href, asset, join(app.getPath("downloads"), "Mountains Updates", asset.file), progress, fetcher);
				const { NsisUpdater } = createRequire(import.meta.url)("electron-updater") as typeof import("electron-updater");
				const updater = new NsisUpdater({ provider: "generic", url: endpoint.url, channel: `${asset.channel}-${asset.platform}-${asset.arch}` });
				updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
				updater.allowPrerelease = asset.channel === "preview"; updater.allowDowngrade = false;
				updater.disableWebInstaller = true; updater.disableDifferentialDownload = true;
				updater.on("error", () => {});
				updater.on("download-progress", value => progress(value.percent));
				const checked = await updater.checkForUpdates();
				const info = checked?.updateInfo;
				// Bind native updater metadata to the catalog already chosen. A stale mirror cannot switch releases.
				if (!info || info.version !== asset.version || info.files.length !== 1 || info.files[0]?.url !== asset.file || info.files[0].sha512 !== asset.sha512 || info.files[0].size !== asset.size) throw new Error("Native update metadata mismatch");
				useRangeDownload(updater, asset, progress, fetcher);
				const paths = await updater.downloadUpdate();
				if (!paths[0]) throw new Error("Installer was not downloaded");
				installer = updater; return paths[0];
			},
			async install(path) {
				if (nativeInstall) {
					if (!installer) throw new Error("Installer not ready");
					installer.quitAndInstall(false, true);
				} else {
					const error = await shell.openPath(path);
					if (error) throw new Error(error);
				}
			},
		},
	});
	let timer: ReturnType<typeof setInterval> | undefined;
	let startup: ReturnType<typeof setTimeout> | undefined;
	if (options.enabled) {
		startup = setTimeout(() => { void updates.check(); }, 30_000); startup.unref();
		timer = setInterval(() => { void updates.check(); }, 4 * 60 * 60_000); timer.unref();
	}
	return { ...updates, dispose() { clearTimeout(startup); clearInterval(timer); } };
}
