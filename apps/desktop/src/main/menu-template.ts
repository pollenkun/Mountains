/**
 * The macOS menu bar: every page and the new conversation have a shortcut there, so they can be found
 * and the menu title flashes when one is used. Kept apart from Electron so it can be tested on its own.
 */
import type { MenuItemConstructorOptions } from "electron";

export type MenuView = "all" | "search" | "settings";
/** Commands the page carries out in the open conversation. */
export type MenuCommand = "find" | "export" | "regenerate" | "changes" | "attach";
export type MenuTarget = null | { view: MenuView } | { command: MenuCommand };

export function menuTemplate(go: (target: MenuTarget) => void): MenuItemConstructorOptions[] {
	return [
		{ label: "Mountains", submenu: [
			{ role: "about", label: "关于 Mountains" },
			{ type: "separator" },
			{ label: "设置…", accelerator: "CmdOrCtrl+,", click: () => go({ view: "settings" }) },
			{ type: "separator" },
			{ role: "services", label: "服务" },
			{ type: "separator" },
			{ role: "hide", label: "隐藏 Mountains" },
			{ role: "hideOthers", label: "隐藏其他" },
			{ role: "unhide", label: "全部显示" },
			{ type: "separator" },
			{ role: "quit", label: "退出 Mountains" },
		] },
		{ label: "文件", submenu: [
			{ label: "新对话", accelerator: "CmdOrCtrl+N", click: () => go(null) },
			{ label: "添加文件…", accelerator: "CmdOrCtrl+U", click: () => go({ command: "attach" }) },
			{ label: "导出为 Markdown…", accelerator: "CmdOrCtrl+Shift+E", click: () => go({ command: "export" }) },
			{ type: "separator" },
			{ role: "close", label: "关闭窗口" },
		] },
		{ label: "编辑", submenu: [
			{ role: "undo", label: "撤销" },
			{ role: "redo", label: "重做" },
			{ type: "separator" },
			{ role: "cut", label: "剪切" },
			{ role: "copy", label: "拷贝" },
			{ role: "paste", label: "粘贴" },
			{ role: "selectAll", label: "全选" },
			{ type: "separator" },
			{ label: "查找…", accelerator: "CmdOrCtrl+F", click: () => go({ command: "find" }) },
		] },
		{ label: "对话", submenu: [
			{ label: "重新生成", accelerator: "CmdOrCtrl+R", click: () => go({ command: "regenerate" }) },
			{ label: "查看改动", accelerator: "CmdOrCtrl+Shift+D", click: () => go({ command: "changes" }) },
		] },
		{ label: "显示", submenu: [
			{ label: "所有对话", accelerator: "CmdOrCtrl+1", click: () => go({ view: "all" }) },
			{ label: "搜索", accelerator: "CmdOrCtrl+K", click: () => go({ view: "search" }) },
			{ type: "separator" },
			{ role: "togglefullscreen", label: "进入全屏幕" },
		] },
		{ role: "windowMenu", label: "窗口" },
	];
}
