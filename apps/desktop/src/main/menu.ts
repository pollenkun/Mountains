/** Installs the macOS menu bar (menu-template.ts). Windows draws its own title bar and keeps no menu. */
import { BrowserWindow, Menu } from "electron";
import { OPEN_CHANNEL } from "./background.ts";
import { menuTemplate, type MenuTarget } from "./menu-template.ts";

export function bindMenu(window: BrowserWindow): void {
	const go = (target: MenuTarget) => {
		if (window.isDestroyed()) return;
		window.show();
		window.focus();
		window.webContents.send(OPEN_CHANNEL, target);
	};
	Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(go)));
	// Windows draws its own title bar. The menu stays installed so Ctrl+N and Ctrl+, still work.
	if (process.platform !== "darwin") window.setMenuBarVisibility(false);
}
