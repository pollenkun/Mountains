import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonHelper } from "./helper.ts";

/**
 * Window images from a ScreenCaptureKit stream of each window Mountains works in (native/capture.swift): frames
 * are at hand at once, and while a stream runs macOS shows the user that the screen is being recorded. Each
 * image shows the window as it is after the request, never an older frame. No desktop fallback.
 * Built at release time, never on the user's Mac; streams need macOS 14.2+.
 */
export class MacCapture {
    private readonly helper: JsonHelper;
    private constructor(binary: string) { this.helper = new JsonHelper(binary, []); }

	/** The bundled helper; null when it cannot be used here: not macOS, or it does not match this release. */
	static async open(): Promise<MacCapture | null> {
		if (process.platform !== "darwin") return null;
		const source = fileURLToPath(new URL("../native/capture.swift", import.meta.url));
		const binary = fileURLToPath(new URL("../native/darwin-universal/capture", import.meta.url));
		try { verifyCaptureHelper(source, binary, process.arch); } catch { return null; }
		return new MacCapture(binary);
	}

    async frame(window: number, file: string, timeoutMs = 10_000): Promise<CaptureFrame> {
        const result = await this.helper.send({ op: "frame", window, file }, timeoutMs);
        if (typeof result.capturedAt !== "number" || typeof result.width !== "number" || typeof result.height !== "number") throw new Error("capture returned no frame receipt");
        return { width: result.width, height: result.height, capturedAt: result.capturedAt };
    }
    close(): Promise<void> { return this.helper.stop(); }

}

/** Capture time is observation freshness, not a claim that pixels changed. */
export interface CaptureFrame { width: number; height: number; capturedAt: number }

/** Throws unless the binary is the one built from this source for this architecture. */
export function verifyCaptureHelper(source: string, binary: string, arch: string): void {
	try {
		const manifest = JSON.parse(readFileSync(binary + ".json", "utf8")) as { format: number; sourceSha256: string; binarySha256: string; architectures: string[] };
		const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
		if (manifest.format !== 1 || !manifest.architectures.includes(arch) || manifest.sourceSha256 !== sha(source) || manifest.binarySha256 !== sha(binary)) throw new Error("the capture helper does not match this release");
	} catch (error) { throw new Error(`The bundled capture helper is missing or invalid. Reinstall the complete Mountains package. ${error instanceof Error ? error.message : String(error)}`); }
}
