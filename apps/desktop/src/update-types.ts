export type UpdateChannel = "stable" | "preview";
export type UpdateSource = "auto" | "hk" | "github";
export interface UpdatePreferences { channel: UpdateChannel; source: UpdateSource; automatic: boolean }
export interface ReleaseAsset {
	version: string; channel: UpdateChannel; platform: "darwin" | "win32"; arch: "arm64" | "x64";
	file: string; sha512: string; size: number; notes?: string;
}
export interface UpdateState {
	phase: "idle" | "checking" | "latest" | "unpublished" | "available" | "downloading" | "ready" | "error";
	version?: string; source?: "hk" | "github"; percent?: number; error?: string; notes?: string;
	installMode: "manual" | "restart"; busy: boolean;
}
