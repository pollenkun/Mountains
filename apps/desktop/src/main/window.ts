import { BrowserWindow, ipcMain, nativeTheme, screen, type BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";
import type { Desk } from "./desk.ts";

export const COMMAND_CHANNEL = "mountains:command";
export const EVENT_CHANNEL = "mountains:event";

let navigationBlocked = 0;
let windowsDenied = 0;

export function securityCounts(): { navigationBlocked: number; windowsDenied: number; commandsDropped: number } {
	return { navigationBlocked, windowsDenied, commandsDropped };
}

function chrome(root: string): BrowserWindowConstructorOptions {
	const dark = nativeTheme.shouldUseDarkColors;
	const mac = process.platform === "darwin";
	const win = process.platform === "win32";
	// Half of this display, so macOS can tile the window to one side. A 13-inch Air is 1470 points wide;
	// a fixed 880 cannot fit in that half. Wider screens keep 880.
	const half = Math.floor(screen.getPrimaryDisplay().workAreaSize.width / 2) - 16;
	return {
		width: 1440,
		height: 900,
		minWidth: Math.min(880, Math.max(560, half)),
		minHeight: 640,
		show: false,
		title: "Mountains",
		backgroundColor: dark ? "#000000" : "#FFFFFF",
		paintWhenInitiallyHidden: true,
		titleBarStyle: mac ? "hiddenInset" : "hidden",
		...(mac ? { trafficLightPosition: { x: 16, y: 16 }, vibrancy: "sidebar" as const, visualEffectState: "active" as const } : {}),
		...(win ? {
			backgroundMaterial: "mica" as const,
			titleBarOverlay: {
				color: dark ? "#0A0A0A" : "#F5F5F5",
				symbolColor: dark ? "#EDEDED" : "#181818",
				height: 36,
			},
		} : {}),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			preload: join(root, "dist", "preload.js"),
		},
	};
}

export function createDesktopWindow(desk: Desk, { root, hidden }: { root: string; hidden: boolean }): BrowserWindow {
	const window = new BrowserWindow(chrome(root));
	const queued: unknown[] = [];
	let ready = false;

	// Every conversation's events reach the page, tagged with the conversation, so background runs stay current.
	const deliver = (conversation: string, event: unknown) => {
		if (window.isDestroyed()) return;
		if (!ready) queued.push({ conversation, event });
		else window.webContents.send(EVENT_CHANNEL, { conversation, event });
	};
	desk.onEvent(deliver);

	window.webContents.on("did-finish-load", () => {
		ready = true;
		for (const event of queued) window.webContents.send(EVENT_CHANNEL, event);
		queued.length = 0;
	});
	window.webContents.on("will-navigate", (event) => {
		navigationBlocked++;
		event.preventDefault();
	});
	window.webContents.on("will-redirect", (event) => {
		navigationBlocked++;
		event.preventDefault();
	});
	window.webContents.setWindowOpenHandler(() => {
		windowsDenied++;
		return { action: "deny" };
	});
	window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
		const headers = { ...details.responseHeaders };
		headers["Content-Security-Policy"] = ["default-src 'self'"];
		callback({ responseHeaders: headers });
	});

	nativeTheme.on("updated", () => {
		if (window.isDestroyed()) return;
		const dark = nativeTheme.shouldUseDarkColors;
		window.setBackgroundColor(dark ? "#000000" : "#FFFFFF");
		if (process.platform === "win32") {
			window.setTitleBarOverlay({
				color: dark ? "#0A0A0A" : "#F5F5F5",
				symbolColor: dark ? "#EDEDED" : "#181818",
				height: 36,
			});
		}
	});

	if (!hidden) window.once("ready-to-show", () => window.show());
	void window.loadFile(join(root, "dist", "renderer", "index.html"));
	return window;
}

let commandsDropped = 0;

/** Only the window's own top frame may command the engine, and only for a conversation that exists. */
export function bindCommands(desk: Desk, window: BrowserWindow): void {
	ipcMain.on(COMMAND_CHANNEL, (event, payload: unknown) => {
		if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
			console.error("mountains: dropped a command from another frame");
			return;
		}
		const { conversation, command } = payload && typeof payload === "object" ? payload as { conversation?: unknown; command?: unknown } : {};
		if (typeof conversation !== "string" || !desk.command(conversation, command)) {
			commandsDropped++;
			console.error("mountains: dropped a command for no known conversation");
		}
	});
}
