import type { ReleaseAsset } from "../update-types.ts";
import { downloadAssetInRanges } from "./update-download.ts";

/** electron-updater 6.8.12 owns caching, signature checks and installation.
 * Replace only its full-installer transfer; metadata continues through its executor.
 * The pinned library exposes this executor at runtime but strips it from its .d.ts.
 */
export function useRangeDownload(updater: unknown, asset: ReleaseAsset, progress: (percent: number) => void, fetcher: typeof fetch): void {
	const native = updater as { httpExecutor?: { download: (url: URL, destination: string, options: { sha512?: string }) => Promise<string> } };
	if (!native.httpExecutor || typeof native.httpExecutor.download !== "function") throw new Error("Native update transport unavailable");
	native.httpExecutor.download = async (url, destination, options) => {
		if (decodeURIComponent(url.pathname.split("/").at(-1) ?? "") !== asset.file || options.sha512 !== asset.sha512) throw new Error("Native installer does not match release");
		return downloadAssetInRanges(url.href, asset, destination, progress, fetcher);
	};
}
