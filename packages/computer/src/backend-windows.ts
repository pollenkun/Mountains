import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "./image.ts";
import { JsonHelper } from "./helper.ts";
import { userInterventionReason, WindowUnavailableError, type Capture, type Desktop, type Rect, type UiApp, type UiElement } from "./backend.ts";

/**
 * What the model is told when the keyboard, the mouse, the clipboard, the foreground or a launch is asked of the Windows
 * desktop. It takes none of them: it acts through UI Automation patterns on the control itself.
 */
export const WINDOWS_SEMANTIC_ONLY = "Computer use on Windows works through UI Automation patterns only (press, toggle, expand, collapse, select, set a value, step a value, scroll into view); this needs the keyboard, the mouse, the clipboard, the foreground or a launch, so nothing was sent. Do the task another way (commands, files, the web tools) or tell the user.";

/** The Windows helper's replies, as `JsonHelper.send` returns them. */
export interface WindowsHelper { send(command: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>; readonly pid: number | null; dispose(): Promise<void> }

/** The window in front and the user's last-input tick, sampled around one action. */
interface InputSample { front: { hwnd: number; pid: number }; input: number }
const hex = (hwnd: number) => `0x${hwnd.toString(16)}`;

interface LiveWindow { pid: number; bounds: Rect; frame: Rect; minimized: boolean; cloaked: boolean; visible: boolean }

/** The bundled helper, checked against the manifest the release build wrote. */
export function openWindowsHelper(): WindowsHelper {
	const source = fileURLToPath(new URL("../native/windows-helper/Program.cs", import.meta.url));
	const project = fileURLToPath(new URL("../native/windows-helper/windows-helper.csproj", import.meta.url));
	const binary = fileURLToPath(new URL("../native/win-anycpu/mountains-windows-helper.exe", import.meta.url));
	verifyWindowsHelper(source, project, binary, process.arch);
	return new JsonHelper(binary, [], process.env, "eof");
}

export function verifyWindowsHelper(source: string, project: string, binary: string, arch: string): void {
	try {
		const manifest = JSON.parse(readFileSync(binary + ".json", "utf8")) as { format: number; sourceSha256: string; projectSha256: string; binarySha256: string; architectures: string[] };
		const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
		if (manifest.format !== 1 || !manifest.architectures.includes(arch) || manifest.sourceSha256 !== sha(source) || manifest.projectSha256 !== sha(project) || manifest.binarySha256 !== sha(binary)) throw new Error("the Windows helper does not match this release");
	} catch (error) { throw new Error(`The bundled Windows helper is missing or invalid. Reinstall the complete Mountains package. ${error instanceof Error ? error.message : String(error)}`); }
}

/** The window number xa11y puts in a window's stableId ("hwnd:0x10548"). */
export function windowHandle(window: UiElement): number {
	const match = /^hwnd:0x([0-9a-f]+)$/i.exec(window.stableId ?? "");
	if (!match) throw new Error("the window has no window handle; it cannot be bound safely");
	return parseInt(match[1]!, 16);
}

/**
 * xa11y's coordinates for the live window rectangle. The helper reports physical pixels; xa11y reports what
 * Windows gives the Node process, which is scaled when Node is not DPI aware. The scale comes from the widths.
 */
export function windowScale(observed: Rect, live: LiveWindow): number | null {
	for (const rect of [live.bounds, live.frame]) {
		if (rect.width <= 0 || rect.height <= 0) continue;
		const k = observed.width / rect.width;
		if (k < 0.25 || k > 4) continue;
		if (Math.abs(rect.x * k - observed.x) <= 3 && Math.abs(rect.y * k - observed.y) <= 3 && Math.abs(rect.height * k - observed.height) <= 3) return k;
	}
	return null;
}

/** New Notepad's editor is a UI Automation Document, which xa11y calls a web area. An editable one is a text area. */
function windowsElement(element: UiElement): UiElement {
	return new Proxy(element, {
		get(target, property) {
			if (property === "role") return target.role === "web_area" && target.actions.includes("set_value") ? "text_area" : target.role;
			if (property === "children") return async () => (await target.children()).map(windowsElement);
			if (property === "parent") return target.parent ? async () => { const parent = await target.parent!(); return parent ? windowsElement(parent) : null; } : undefined;
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

interface Xa11yApp { name: string; pid: number | null; isForeground: boolean; windows(): Promise<unknown[]> }

/**
 * Windows: xa11y (UI Automation) for apps, control trees and the pattern actions (press, toggle, expand, collapse,
 * select, set value, step, scroll into view), the bundled helper for window identity, process start times, covered-window
 * images and the foreground check. `inputs` is "semantic": the keyboard, the mouse, the clipboard, the foreground and
 * launching refuse before anything is sent, and the helper itself never sends input or activates anything.
 */
export async function windowsDesktop(options: { helper?: WindowsHelper; list?: () => Promise<Xa11yApp[]> } = {}): Promise<Desktop> {
	let list = options.list;
	if (!list) {
		let x: typeof import("@crowecawcaw/xa11y");
		try { const mod = await import("@crowecawcaw/xa11y") as unknown as { default?: typeof import("@crowecawcaw/xa11y") }; x = mod.default ?? (mod as unknown as typeof import("@crowecawcaw/xa11y")); }
		catch (error) { throw new Error(`无法加载 xa11y（这个平台可能没有预编译版本）：${error instanceof Error ? error.message : String(error)}`); }
		list = () => x.App.list() as unknown as Promise<Xa11yApp[]>;
	}
	const helper = options.helper ?? openWindowsHelper();
	let closed = false;
	const send = (command: Record<string, unknown>, timeoutMs?: number) => { if (closed) throw new Error("desktop was closed"); return helper.send(command, timeoutMs); };
	const live = async (hwnd: number): Promise<LiveWindow> => {
		try { return await send({ op: "window", hwnd }, 5_000) as unknown as LiveWindow; }
		catch (error) { if (/the window is gone/.test(String(error))) throw new WindowUnavailableError("the window closed"); throw error; }
	};
	/** The live window behind an observed one, its owner checked, and the scale from helper pixels to xa11y's. */
	const bind = async (app: UiApp, window: UiElement): Promise<{ hwnd: number; scale: number; bounds: Rect }> => {
		const hwnd = windowHandle(window), b = window.bounds;
		if (app.pid === null || !b) throw new Error(`${app.name}'s window has no process or position`);
		const now = await live(hwnd);
		if (now.pid !== app.pid) throw new Error("the window now belongs to another process; read again");
		if (now.minimized) throw new WindowUnavailableError(`${app.name}'s window is minimized`);
		if (now.cloaked || !now.visible) throw new WindowUnavailableError(`${app.name}'s window is not on this desktop`);
		const scale = windowScale(b, now);
		if (scale === null) throw new Error("window moved or resized; read it again");
		return { hwnd, scale, bounds: { ...b } };
	};
	const refuse = async (): Promise<never> => { throw new Error(WINDOWS_SEMANTIC_ONLY); };
	/** The foreground window and the user's last-input tick now. Replies are checked: a guess would hide a violation. */
	const sample = async (): Promise<InputSample> => {
		const front = await send({ op: "foreground" }, 3_000), input = await send({ op: "last_input" }, 3_000);
		const hwnd = Number(front.hwnd), pid = Number(front.pid), tick = Number(input.tick);
		if (![hwnd, pid, tick].every(Number.isFinite)) throw new Error("the helper's foreground reply is unusable");
		return { front: { hwnd, pid }, input: tick };
	};
	/** Set by beginInput, taken by endInput; one action runs at a time. */
	let begun: (InputSample & { app: string; pid: number | null }) | null = null;
	return {
		native: true,
		inputs: "semantic",
		async beginInput(app) { begun = null; begun = { ...await sample(), app: app.name, pid: app.pid }; },
		/**
		 * We send no input of our own, so the foreground window changing is the app's doing or the user's, and a changed
		 * last-input tick is the user's. The tick counts as the user working in the target only while the target is the
		 * window in front at the start or the end (as on macOS, the user working in some other app does not stop the action).
		 */
		async endInput() {
			const start = begun; begun = null;
			if (!start) return { unchanged: false, byUser: false, frontChanged: false, focusChanged: false, restored: false, attributionUnknown: true, reason: "the foreground was not recorded before this action, so it could not be verified" };
			const end = await sample();
			const frontChanged = end.front.hwnd !== start.front.hwnd;
			// Ticks wrap every 49 days: equality only, never a comparison.
			const inputAdvanced = end.input !== start.input;
			const inTarget = start.pid !== null && (start.front.pid === start.pid || end.front.pid === start.pid);
			if (inputAdvanced && inTarget) return { unchanged: false, byUser: true, reason: userInterventionReason(start.app), frontChanged, focusChanged: false, restored: !frontChanged, attributionUnknown: false };
			if (frontChanged) return { unchanged: false, byUser: false, frontChanged: true, focusChanged: false, restored: false, attributionUnknown: false,
				reason: `The foreground window changed during the action (window ${hex(start.front.hwnd)} of process ${start.front.pid} was in front, window ${hex(end.front.hwnd)} of process ${end.front.pid} is now). Background mode allows no foreground change, and Mountains does not take the foreground back on Windows. Read the window again before more input.` };
			return { unchanged: true, byUser: false, frontChanged: false, focusChanged: false, restored: true, attributionUnknown: false };
		},
		async close() { if (closed) return; closed = true; await helper.dispose(); },
		async apps() {
			const apps = await list();
			const pids = [...new Set(apps.map(a => a.pid).filter((p): p is number => p !== null))];
			const started = pids.length ? (await send({ op: "processes", pids }, 10_000)).processes as Record<string, { start?: string; path?: string }> : {};
			return apps.map(app => {
				const known = app.pid !== null ? started[String(app.pid)] : undefined;
				const executable = known?.path?.split("\\").pop();
				return { name: app.name, pid: app.pid, isForeground: app.isForeground, ...(known?.start ? { instance: known.start } : {}), ...(executable ? { executableName: executable } : {}),
					windows: async () => (await app.windows() as UiElement[]).map(windowsElement) };
			});
		},
		async windowIdentity(app, window) {
			const { hwnd, bounds } = await bind(app, window);
			return { id: String(hwnd), bounds };
		},
		async captureWindow(app, window, maxWidth, region) {
			const { hwnd, scale, bounds } = await bind(app, window);
			const dir = mkdtempSync(join(tmpdir(), "mountains-look-"));
			try {
				const file = join(dir, "window.png");
				const shot = await send({ op: "capture", hwnd, file }, 8_000) as { area: Rect; method: string };
				let image = decodePng(readFileSync(file));
				// Window images are opaque; a capture's empty alpha would show as black.
				for (let i = 3; i < image.rgba.length; i += 4) image.rgba[i] = 255;
				const again = await bind(app, window);
				if (again.hwnd !== hwnd || JSON.stringify(again.bounds) !== JSON.stringify(bounds)) throw new Error("window changed while captured; look again");
				// The image shows the area the helper reports (the visible frame, without the invisible resize border).
				const shown = { x: shot.area.x * scale, y: shot.area.y * scale, width: shot.area.width * scale, height: shot.area.height * scale };
				const sx = image.width / shown.width, sy = image.height / shown.height;
				let area = shown;
				if (region) {
					if (region.x < bounds.x || region.y < bounds.y || region.x + region.width > bounds.x + bounds.width || region.y + region.height > bounds.y + bounds.height) throw new Error("zoom is outside the exact window");
					const x0 = Math.max(region.x, shown.x), y0 = Math.max(region.y, shown.y), x1 = Math.min(region.x + region.width, shown.x + shown.width), y1 = Math.min(region.y + region.height, shown.y + shown.height);
					if (x1 <= x0 || y1 <= y0) throw new Error("zoom covers only the window's invisible border");
					const px = Math.round((x0 - shown.x) * sx), py = Math.round((y0 - shown.y) * sy);
					const width = Math.max(1, Math.min(image.width - px, Math.round((x1 - x0) * sx))), height = Math.max(1, Math.min(image.height - py, Math.round((y1 - y0) * sy)));
					const rgba = Buffer.alloc(width * height * 4);
					for (let y = 0; y < height; y++) image.rgba.copy(rgba, y * width * 4, ((py + y) * image.width + px) * 4, ((py + y) * image.width + px + width) * 4);
					image = { width, height, rgba };
					area = { x: shown.x + px / sx, y: shown.y + py / sy, width: width / sx, height: height / sy };
				}
				if (image.width > maxWidth) {
					const width = maxWidth, height = Math.max(1, Math.round(image.height * width / image.width)), rgba = Buffer.alloc(width * height * 4);
					for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
						const from = (Math.min(image.height - 1, Math.floor(y * image.height / height)) * image.width + Math.min(image.width - 1, Math.floor(x * image.width / width))) * 4;
						image.rgba.copy(rgba, (y * width + x) * 4, from, from + 4);
					}
					image = { width, height, rgba };
				}
				const scaleX = image.width / area.width, scaleY = image.height / area.height;
				const capture: Capture = { width: image.width, height: image.height, pixels: image.rgba, windowId: String(hwnd), capturedAt: Date.now(),
					desktopRectToImage: r => [{ x: (r.x - area.x) * scaleX, y: (r.y - area.y) * scaleY, width: r.width * scaleX, height: r.height * scaleY }],
					imageToDesktop: (x, y) => [area.x + x / scaleX, area.y + y / scaleY] };
				return capture;
			} finally { rmSync(dir, { recursive: true, force: true }); }
		},
		ownPids: () => (helper.pid ? [helper.pid] : []),
		async installedApps() { return []; },
		async prepare() {},
		async menus() { throw new Error("reading menus is not available on Windows yet; read the window instead"); },
		pressMenu: refuse,
		pointer: refuse,
		key: refuse,
		text: refuse,
		typeAtFocus: refuse,
		showCursor: async () => {},
		clipboardSet: refuse,
		async clipboardRestore() {},
		launch: refuse,
	};
}
