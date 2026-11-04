import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HelperResponseError, JsonHelper } from "./helper.ts";
import type { Rect } from "./backend.ts";

/** Why a web window was or was not kept visible. */
export type KeepVisibleReason = "pinned" | "already" | "not_web" | "covered";
export interface PopupChoice { changed: boolean; value: string; openMs: number; totalMs: number; closed: boolean }
export interface StatusItem { pid: number; app: string; index: number; title: string; description: string; help: string; bounds?: { x: number; y: number; width: number; height: number } }
export type StatusItemResult = { kind: "menu"; items: string[]; closed: boolean; totalMs: number } | { kind: "chosen"; closed: boolean; totalMs: number } | { kind: "window"; app: string; pid: number; totalMs: number };

/**
 * Built at release time (native/window-server.swift). It reads windows and performs one popup choice; it never
 * activates, raises or moves a window and never posts keyboard or pointer events. At end of input it restores
 * every window it kept visible.
 */
export class MacWindowServer {
	private readonly helper: JsonHelper;
	private constructor(helper: JsonHelper) { this.helper = helper; }

	static async open(): Promise<MacWindowServer> {
		if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("the window server is available on supported macOS hosts only");
		const source = fileURLToPath(new URL("../native/window-server.swift", import.meta.url));
		const binary = fileURLToPath(new URL("../native/darwin-universal/window-server", import.meta.url));
		try {
			const manifest = JSON.parse(readFileSync(binary + ".json", "utf8")) as { format: number; sourceSha256: string; binarySha256: string; architectures: string[] };
			const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
			if (manifest.format !== 1 || !manifest.architectures.includes(process.arch) || manifest.sourceSha256 !== sha(source) || manifest.binarySha256 !== sha(binary)) throw new Error("window server does not match this release");
		} catch (error) { throw new Error(`The bundled window server is missing or invalid. Reinstall the complete Mountains package. ${error instanceof Error ? error.message : String(error)}`); }
		return new MacWindowServer(new JsonHelper(binary, [], process.env, "eof"));
	}

	/** One image of the window's own pixels, covered or not. Null when this macOS has no hardware window capture. */
	async capture(window: number, file: string): Promise<{ width: number; height: number; capturedAt: number } | null> {
		try {
			const reply = await this.helper.send({ op: "capture", window, file }, 5_000);
			if (typeof reply.width !== "number" || typeof reply.height !== "number" || typeof reply.capturedAt !== "number") throw new Error("window server returned no image receipt");
			return { width: reply.width, height: reply.height, capturedAt: reply.capturedAt };
		} catch (error) {
			if (error instanceof HelperResponseError && error.reply.code === "unavailable") return null;
			throw error;
		}
	}

	/** Pin a visible web-engine window as visible, so covering it later does not stop its page. */
	async keepVisible(pid: number, window: number, exclude: readonly number[]): Promise<KeepVisibleReason> {
		const reply = await this.helper.send({ op: "keep_visible", pid, window, exclude: [...exclude] }, 3_000);
		const reason = reply.reason;
		if (reason !== "pinned" && reason !== "already" && reason !== "not_web" && reason !== "covered") throw new Error("window server returned an unknown visibility result");
		return reason;
	}

	/** Open the native popup at `bounds` in the exact window, choose `choice`, and close it again. */
	async popupSelect(pid: number, window: number, bounds: Rect, choice: string): Promise<PopupChoice> {
		const reply = await this.helper.send({ op: "popup_select", pid, window, bounds, choice }, 6_000);
		if (typeof reply.changed !== "boolean" || typeof reply.value !== "string" || typeof reply.closed !== "boolean") throw new Error("window server returned no popup receipt");
		return { changed: reply.changed, value: reply.value, openMs: Number(reply.openMs) || 0, totalMs: Number(reply.totalMs) || 0, closed: reply.closed };
	}

	/** Every app's menu bar status items, left to right. */
	async menubarList(exclude: readonly number[]): Promise<StatusItem[]> {
		const reply = await this.helper.send({ op: "menubar_list", exclude: [...exclude] }, 8_000);
		if (!Array.isArray(reply.items)) throw new Error("window server returned no menu bar items");
		return reply.items as StatusItem[];
	}
	/** Open one status item: with no path list its menu and close it; with a path choose that item. */
	async menubarAction(item: StatusItem, path: readonly string[]): Promise<StatusItemResult> {
		const reply = await this.helper.send({ op: "menubar_action", pid: item.pid, index: item.index, description: item.description || item.title, path: [...path] }, 10_000);
		if (reply.kind !== "menu" && reply.kind !== "chosen" && reply.kind !== "window") throw new Error("window server returned no menu bar receipt");
		return reply as unknown as StatusItemResult;
	}

	/** Windows of an app that are not on this screen: minimized, or on another desktop. */
	async offscreenWindows(pid: number): Promise<{ title: string; minimized: boolean }[]> {
		const reply = await this.helper.send({ op: "windows_offscreen", pid }, 4_000);
		return Array.isArray(reply.windows) ? reply.windows as { title: string; minimized: boolean }[] : [];
	}
	/** Bring one minimized window back on screen, without activating its app. */
	async unminimize(pid: number, title: string): Promise<boolean> {
		const reply = await this.helper.send({ op: "unminimize", pid, title }, 5_000);
		return reply.restored === true;
	}

	/** Set (with `value`) or read one file panel field by its identifier, with short request timeouts. */
	async panelField(pid: number, window: number, identifier: string, value?: string): Promise<string> {
		const reply = await this.helper.send({ op: "panel_field", pid, window, identifier, ...(value !== undefined ? { value } : {}) }, 8_000);
		return typeof reply.value === "string" ? reply.value : "";
	}
	async panelPress(pid: number, window: number, identifier: string): Promise<boolean> {
		const reply = await this.helper.send({ op: "panel_press", pid, window, identifier }, 8_000);
		return reply.pressed === true;
	}
	/** The name Finder and file panels show for a folder (Documents is 文稿 on a Chinese system). */
	async displayName(path: string): Promise<string> {
		const reply = await this.helper.send({ op: "display_name", path }, 3_000);
		return typeof reply.name === "string" ? reply.name : "";
	}

	get pid(): number | null { return this.helper.pid; }
	/** End of input: the server restores every window it pinned, then exits. */
	close(): Promise<void> { return this.helper.stop(); }
}
