/** Update policy. Network and installer are injected so failover and task protection can be tested offline. */
import semver from "semver";
import type { ReleaseAsset, UpdatePreferences, UpdateState } from "../update-types.ts";
export type { ReleaseAsset, UpdatePreferences, UpdateState } from "../update-types.ts";
export interface UpdateEndpoint { id: "hk" | "github"; url: string }
export function updateEndpoints(prefs: UpdatePreferences): UpdateEndpoint[] {
	const endpoints: UpdateEndpoint[] = [
		{ id: "hk", url: "https://updates.cnsai.top/desktop/" },
		{ id: "github", url: `https://github.com/pollenkun/Mountains/releases/download/desktop-${prefs.channel}/` },
	];
	return prefs.source === "auto" ? endpoints : endpoints.filter(source => source.id === prefs.source);
}
export function releaseFile(prefs: UpdatePreferences, platform: string, arch: string): string { return `${prefs.channel}-${platform}-${arch}.json`; }
export function validateRelease(value: unknown, prefs: UpdatePreferences, platform: string, arch: string): ReleaseAsset {
	if (!value || typeof value !== "object") throw new Error("Invalid release metadata");
	const asset = value as ReleaseAsset;
	if (!semver.valid(asset.version) || asset.channel !== prefs.channel || asset.platform !== platform || asset.arch !== arch ||
		(prefs.channel === "stable" && semver.prerelease(asset.version)) ||
		typeof asset.file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(asset.file) ||
		!asset.file.endsWith(platform === "darwin" ? ".dmg" : ".exe") ||
		typeof asset.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(asset.sha512) ||
		!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3 ||
		(asset.notes !== undefined && (typeof asset.notes !== "string" || asset.notes.length > 20_000))) throw new Error("Invalid release metadata");
	return asset;
}
export interface UpdateTransport {
	metadata(url: string): Promise<unknown | null>;
	download(endpoint: UpdateEndpoint, asset: ReleaseAsset, progress: (percent: number) => void): Promise<string>;
	install(path: string): Promise<void>;
}
export function createUpdates(options: {
	version: string; platform: string; arch: string; preferences: () => UpdatePreferences;
	transport: UpdateTransport; installMode: UpdateState["installMode"]; isBusy: () => boolean;
	changed?: (state: UpdateState) => void; endpoints?: (prefs: UpdatePreferences) => UpdateEndpoint[];
}) {
	let state: UpdateState = { phase: "idle", installMode: options.installMode, busy: options.isBusy() };
	let selected: { endpoint: UpdateEndpoint; asset: ReleaseAsset } | null = null;
	let downloaded: string | null = null;
	let working = false;
	const endpoints = options.endpoints ?? updateEndpoints;
	const set = (next: Omit<UpdateState, "installMode" | "busy">) => {
		state = { ...next, installMode: options.installMode, busy: options.isBusy() }; options.changed?.({ ...state });
	};
	const same = (a: ReleaseAsset, b: ReleaseAsset) => a.version === b.version && a.sha512 === b.sha512 && a.file === b.file && a.size === b.size;
	return {
		state(): UpdateState { return { ...state, busy: options.isBusy() }; },
		reset(): void {
			if (working) throw new Error("UPDATE_IN_PROGRESS");
			selected = null; downloaded = null; set({ phase: "idle" });
		},
		async check(): Promise<UpdateState> {
			if (working || state.phase === "ready") return this.state();
			working = true; selected = null; downloaded = null; set({ phase: "checking" });
			let failures = 0, missing = 0;
			const prefs = options.preferences();
			try {
				for (const endpoint of endpoints(prefs)) {
					try {
						const raw = await options.transport.metadata(new URL(releaseFile(prefs, options.platform, options.arch), endpoint.url).href);
						if (raw === null) { missing++; continue; }
						const asset = validateRelease(raw, prefs, options.platform, options.arch);
						if (!semver.gt(asset.version, options.version)) { set({ phase: "latest", source: endpoint.id }); break; }
						selected = { endpoint, asset };
						set({ phase: "available", version: asset.version, source: endpoint.id, ...(asset.notes ? { notes: asset.notes } : {}) }); break;
					} catch { failures++; }
				}
				if (state.phase === "checking") set(failures ? { phase: "error", error: "CHECK_FAILED" } : { phase: missing ? "unpublished" : "error", error: "NO_RELEASE" });
			} finally { working = false; }
			if (selected && prefs.automatic) await this.download();
			return this.state();
		},
		async download(): Promise<UpdateState> {
			if (working || !selected || state.phase === "ready") return this.state();
			working = true;
			const { asset, endpoint: first } = selected;
			const prefs = options.preferences();
			const choices = [first, ...endpoints(prefs).filter(source => source.id !== first.id)];
			try {
				for (const endpoint of choices) {
					try {
						if (endpoint.id !== first.id) {
							const raw = await options.transport.metadata(new URL(releaseFile(prefs, options.platform, options.arch), endpoint.url).href);
							if (!raw || !same(asset, validateRelease(raw, prefs, options.platform, options.arch))) continue;
						}
						set({ phase: "downloading", version: asset.version, source: endpoint.id, percent: 0 });
						downloaded = await options.transport.download(endpoint, asset, percent => set({ phase: "downloading", version: asset.version, source: endpoint.id, percent: Math.min(100, Math.max(0, Math.round(percent))) }));
						selected = { endpoint, asset }; set({ phase: "ready", version: asset.version, source: endpoint.id }); return this.state();
					} catch { /* Restart from a matching mirror. Never mix files from different releases. */ }
				}
				set({ phase: "error", version: asset.version, error: "DOWNLOAD_FAILED" });
			} finally { working = false; }
			return this.state();
		},
		async install(): Promise<UpdateState> {
			// Even a caller bypassing the disabled button cannot interrupt a running or approval-waiting task.
			if (options.isBusy()) throw new Error("TASKS_RUNNING");
			if (working || !downloaded || state.phase !== "ready") throw new Error("UPDATE_NOT_READY");
			await options.transport.install(downloaded); return this.state();
		},
	};
}
export type Updates = ReturnType<typeof createUpdates>;
