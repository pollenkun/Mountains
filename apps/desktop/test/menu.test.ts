import assert from "node:assert/strict";
import { test } from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import { menuTemplate, type MenuTarget } from "../src/main/menu-template.ts";

test("the menu bar reaches every page and a new conversation by shortcut", () => {
	const went: MenuTarget[] = [];
	const items = menuTemplate((target) => went.push(target)).flatMap((menu) => (menu.submenu as MenuItemConstructorOptions[] | undefined) ?? []);
	const shortcuts = new Map(items.filter((item) => item.accelerator && item.click).map((item) => [String(item.accelerator), item]));
	for (const key of ["CmdOrCtrl+N", "CmdOrCtrl+1", "CmdOrCtrl+K", "CmdOrCtrl+,", "CmdOrCtrl+F", "CmdOrCtrl+R", "CmdOrCtrl+U", "CmdOrCtrl+Shift+E", "CmdOrCtrl+Shift+D"]) {
		(shortcuts.get(key)!.click as () => void)();
	}
	assert.deepEqual(went, [null, { view: "all" }, { view: "search" }, { view: "settings" },
		{ command: "find" }, { command: "regenerate" }, { command: "attach" }, { command: "export" }, { command: "changes" }]);
	assert.equal(new Set(items.map((item) => item.accelerator).filter(Boolean)).size, items.filter((item) => item.accelerator).length);
});
