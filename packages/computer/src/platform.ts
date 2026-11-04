import { xa11yDesktop, type Desktop } from "./backend.ts";
import { windowsDesktop } from "./backend-windows.ts";

/** This computer's desktop: the macOS adapter, or the read-only Windows one. */
export function defaultDesktop(options: { cursorLabel?: string; cursorColor?: string; cursor?: boolean } = {}): Promise<Desktop> {
	return process.platform === "win32" ? windowsDesktop() : xa11yDesktop(options);
}
