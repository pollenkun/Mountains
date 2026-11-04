/**
 * Work that goes on with the window closed: a system notification when a conversation finishes or needs
 * approval while the window is not in front, and a menu-bar (Windows: tray) menu of what is running.
 */
import { app, BrowserWindow, Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from "electron";
import type { Desk } from "./desk.ts";
import { starBitmap } from "./star.ts";

export const OPEN_CHANNEL = "mountains:open";

/** The menu-bar star as a template image: macOS tints it for light and dark menu bars. */
function starImage(size: number): Electron.NativeImage {
	const scale = 2;
	const image = nativeImage.createFromBitmap(starBitmap(size * scale), { width: size * scale, height: size * scale, scaleFactor: scale });
	image.setTemplateImage(true);
	return image;
}

export function bindBackground(desk: Desk, window: BrowserWindow, { tray: withTray }: { tray: boolean }): { quitting: () => boolean } {
	let quitting = false;
	const show = (conversation: string | null) => {
		if (window.isDestroyed()) return;
		window.show();
		window.focus();
		window.webContents.send(OPEN_CHANNEL, conversation);
	};

	desk.onEvent((id, event) => {
		if (window.isDestroyed() || window.isFocused() || !Notification.isSupported()) return;
		const conversation = desk.list().find((c) => c.id === id);
		const title = conversation?.title || "Mountains";
		let body = "";
		if (event.type === "run.completed" && !event.agent) {
			if (event.status === "limit" && /用量不完整，已保守计费并停止后续操作/.test(event.reason)) return;
			body = event.status === "completed" ? "完成了" : event.status === "cancelled" ? "已停止" : event.reason;
		}
		else if (event.type === "approval.requested" && event.source !== "model") body = `正在等待批准：${event.command}`;
		if (!body) return;
		const note = new Notification({ title, body, silent: event.type === "run.completed" && event.status === "cancelled" });
		note.on("click", () => show(id));
		note.show();
	});

	let tray: Tray | null = null;
	const rebuild = () => {
		if (!tray) return;
		const running = desk.running();
		const recent = desk.list().filter((c) => c.status === "idle" && c.finishedAt && Date.now() - c.finishedAt < 3 * 3600_000).slice(0, 3);
		const time = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
		const items: MenuItemConstructorOptions[] = [];
		if (running.length) {
			items.push({ label: "正在运行", enabled: false });
			for (const c of running) items.push({ label: c.title || "新对话", sublabel: c.status === "waiting" ? "正在等待批准" : "正在运行", click: () => show(c.id) });
			items.push({ type: "separator" });
		}
		if (recent.length) {
			items.push({ label: "刚刚完成", enabled: false });
			for (const c of recent) items.push({ label: c.title || "新对话", sublabel: time(c.finishedAt!), click: () => show(c.id) });
			items.push({ type: "separator" });
		}
		items.push({ label: "新对话", accelerator: "CmdOrCtrl+N", click: () => show(null) });
		items.push({ label: "打开 Mountains", click: () => { if (!window.isDestroyed()) { window.show(); window.focus(); } } });
		items.push({ type: "separator" });
		items.push({ label: "退出 Mountains", accelerator: "CmdOrCtrl+Q", ...(running.length ? { sublabel: `会导致 ${running.length} 个对话被关闭` } : {}), click: () => { quitting = true; app.quit(); } });
		tray.setContextMenu(Menu.buildFromTemplate(items));
		tray.setToolTip(running.length ? `Mountains · ${running.length} 个正在运行` : "Mountains");
	};
	if (withTray) {
		tray = new Tray(starImage(16));
		rebuild();
		desk.onChange(rebuild);
		// With a menu-bar item, closing the window keeps conversations running; quitting is in that menu.
		window.on("close", (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
		app.on("before-quit", () => { quitting = true; });
	}
	return { quitting: () => quitting };
}
