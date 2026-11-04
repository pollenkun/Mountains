import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** These browser bundles need a windowless start followed by a background web window.
 * Match exact bundle identities; Electron and unrelated Chromium apps are not included. */
export function requiresManagedChromeLaunch(bundleId: string | undefined): boolean {
	return bundleId !== undefined && ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev",
		"com.google.Chrome.canary", "com.google.chrome.for.testing", "org.chromium.Chromium"].includes(bundleId);
}
export const MANAGED_CHROME_LAUNCH_MESSAGE = "Background Chrome must start without a window; use web_read to create a background browser window. Direct startup and --app mode may interrupt the foreground app.";

export interface AppLaunchReceipt {
	pid: number;
	gaveBack: number;
	frontTaken: number;
	restoreRequests: number;
	returnFailed: boolean;
	watchStopped: string | null;
	originalWindow?: number;
	keyRestoreRequests?: number;
	keyRestorePairsSent?: number;
}

/** The initial PID line proves startup only. Only the final line contains the watch result. */
export function parseAppLaunchReceipt(stdout: string): AppLaunchReceipt {
	const invalid = () => new Error("the app launch was sent, but its final foreground report is missing or invalid; do not launch it again automatically");
	let value: unknown;
	try { value = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? ""); } catch { throw invalid(); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const receipt = value as Record<string, unknown>;
	for (const field of ["pid", "gaveBack", "frontTaken", "restoreRequests"] as const) {
		if (!Number.isSafeInteger(receipt[field]) || Number(receipt[field]) < (field === "pid" ? 1 : 0)) throw invalid();
	}
	if (typeof receipt.returnFailed !== "boolean" || receipt.watchStopped !== null && typeof receipt.watchStopped !== "string") throw invalid();
	const diagnostics: Pick<AppLaunchReceipt, "originalWindow" | "keyRestoreRequests" | "keyRestorePairsSent"> = {};
	for (const field of ["originalWindow", "keyRestoreRequests", "keyRestorePairsSent"] as const) {
		if (!Object.hasOwn(receipt, field)) continue;
		if (!Number.isSafeInteger(receipt[field]) || Number(receipt[field]) < 0) throw invalid();
		diagnostics[field] = Number(receipt[field]);
	}
	return { pid: Number(receipt.pid), gaveBack: Number(receipt.gaveBack), frontTaken: Number(receipt.frontTaken),
		restoreRequests: Number(receipt.restoreRequests), returnFailed: receipt.returnFailed, watchStopped: receipt.watchStopped as string | null, ...diagnostics };
}

/** The bundled launcher requests background startup, then briefly tries to restore the original
 * front app if startup takes focus. Restoration stops after observed user input or another app. */
export function appLauncher(): string {
	if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("the app launcher is available on supported macOS hosts only");
	const source = fileURLToPath(new URL("../native/launch-app.swift", import.meta.url));
	const binary = fileURLToPath(new URL("../native/darwin-universal/launch-app", import.meta.url));
	try {
		const manifest = JSON.parse(readFileSync(binary + ".json", "utf8")) as { format: number; sourceSha256: string; binarySha256: string; architectures: string[] };
		const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
		if (manifest.format !== 1 || !manifest.architectures.includes(process.arch) || manifest.sourceSha256 !== sha(source) || manifest.binarySha256 !== sha(binary)) throw new Error("launcher does not match this release");
	} catch (error) { throw new Error(`The bundled app launcher is missing or invalid. Reinstall the complete Mountains package. ${error instanceof Error ? error.message : String(error)}`); }
	return binary;
}

/** True for the launcher's own path: its exit is the hand-off, not the app quitting. */
export function isAppLauncher(file: string): boolean {
	return file.endsWith("/native/darwin-universal/launch-app");
}
