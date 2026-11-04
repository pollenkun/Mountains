import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateTracker, Workspace, type ApprovalRequest, type ToolContext, type ToolDefinition } from "@mountains/tools";
import { createComputerTools, type Desktop, type UiApp, type UiElement } from "../src/index.ts";
import { MacWindowServer } from "../src/window-server-mac.ts";

type ForegroundCheck = Awaited<ReturnType<NonNullable<Desktop["endInput"]>>>;
type Spec = { role: string; name?: string; value?: string; actions?: string[]; raw?: Record<string, unknown>; bounds?: { x: number; y: number; width: number; height: number }; kids?: Spec[] };

function element(spec: Spec, log: string[]): UiElement & { value: string | null } {
	const kids = (spec.kids ?? []).map(kid => element(kid, log));
	const self = {
		role: spec.role, name: spec.name ?? null, value: spec.value ?? null, description: null, stableId: null, actions: spec.actions ?? [],
		bounds: spec.bounds ?? null, visible: true, enabled: true, focused: false, selected: false, checked: null, expanded: null, editable: false, raw: spec.raw ?? {},
		children: async () => kids,
		press: async () => { log.push(`press ${spec.name}`); }, focus: async () => {}, toggle: async () => {}, expand: async () => {}, collapse: async () => {}, select: async () => {},
		increment: async () => {}, decrement: async () => {}, scrollIntoView: async () => {}, showMenu: async () => {},
		performAction: async (action: string) => { log.push(`perform ${action}`); }, selectText: async () => {},
		setValue: async (value: string) => { self.value = value; }, typeText: async () => {},
	};
	return self as UiElement & { value: string | null };
}

/** A window with one native popup; the desktop reports what its foreground guard saw. */
function desktop(check: ForegroundCheck) {
	const log: string[] = [];
	const popup: Spec = { role: "pop_up_button", name: "Size", value: "Small", actions: ["press"], raw: { ax_role: "AXPopUpButton" }, bounds: { x: 120, y: 140, width: 120, height: 24 } };
	const window = element({ role: "window", name: "Settings", bounds: { x: 100, y: 100, width: 400, height: 300 }, kids: [popup] }, log);
	const app: UiApp = { name: "Notes", pid: 4242, isForeground: false, windows: async () => [window] };
	const kept: string[] = [];
	const d: Desktop = {
		apps: async () => [app],
		captureWindow: async () => { throw new Error("no images in this test"); },
		pointer: async () => { log.push("pointer"); },
		key: async () => { log.push("key"); },
		showCursor: async () => {},
		ownPids: () => [],
		prepare: async () => {},
		clipboardSet: async () => {}, clipboardRestore: async () => {},
		installedApps: async () => [], launch: async () => {},
		menus: async () => [], pressMenu: async () => {},
		beginInput: async () => { log.push("begin"); },
		endInput: async () => { log.push("end"); return check; },
		keepVisible: async (_app, w) => { kept.push(String(w.name)); return kept.length === 1 ? "covered" : "pinned"; },
		popupSelect: async (_app, _w, target, choice) => {
			log.push(`popup ${target.name}=${choice}`);
			(window as unknown as { children(): Promise<(UiElement & { value: string | null })[]> }).children().then(kids => { kids[0]!.value = choice; });
			await Promise.resolve();
			return { changed: true, value: choice, openMs: 120, totalMs: 260, closed: true };
		},
	};
	return { d, log, kept };
}

function ctx(): ToolContext & { asked: ApprovalRequest[] } {
	const asked: ApprovalRequest[] = [];
	return { workspace: new Workspace(process.cwd()), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c1", asked, approve: async request => { asked.push(request); return "allow"; } };
}
function tools(d: Desktop): Record<string, ToolDefinition> {
	return Object.fromEntries(createComputerTools({ desktop: async () => d, settleMs: 0, settleMaxMs: 0, apps: { Notes: "act" }, cursor: false }).map(t => [t.name, t]));
}
async function choose(t: Record<string, ToolDefinition>, choice: string) {
	const read = await t.screen_read!.execute({ app: "Notes" }, ctx());
	assert.equal(read.ok, true, read.modelContent);
	const id = read.modelContent.match(/(e\d+) pop_up_button "Size"/)?.[1];
	assert.ok(id, read.modelContent);
	return t.screen_act!.execute({ app: "Notes", snapshot: read.details?.snapshot, action: "select", id, text: choice }, ctx());
}

test("a native popup is chosen through the window server, and its menu briefly holding the keyboard is not a failure", async () => {
	const { d, log } = desktop({ unchanged: false, focusChanged: true, frontChanged: false, restored: true, attributionUnknown: false });
	const result = await choose(tools(d), "Large");
	assert.equal(result.details?.outcome, "confirmed", result.modelContent);
	assert.match(result.modelContent, /held the keyboard for about 260 ms/);
	assert.ok(log.includes("popup Size=Large"));
	assert.equal(log.includes("press Size"), false, "the popup is not pressed through the accessibility library, whose press waits out the menu loop");
});

test("a popup choice that changed the front app, or left focus unrestored or unexplained, still fails", async () => {
	for (const check of [
		{ unchanged: false, focusChanged: true, frontChanged: true, restored: true, attributionUnknown: false },
		{ unchanged: false, focusChanged: true, frontChanged: false, restored: false, attributionUnknown: false },
		{ unchanged: false, focusChanged: true, frontChanged: false, restored: true, attributionUnknown: true },
	] as ForegroundCheck[]) {
		const { d } = desktop(check);
		const result = await choose(tools(d), "Large");
		assert.equal(result.details?.outcome, "failed", JSON.stringify(check));
		assert.doesNotMatch(result.modelContent, /held the keyboard/);
	}
});

test("a window is offered to the visibility keep-alive once, and again only while it was covered", async () => {
	const { d, kept } = desktop({ unchanged: true });
	const t = tools(d);
	for (let i = 0; i < 3; i++) assert.equal((await t.screen_read!.execute({ app: "Notes", full: true }, ctx())).ok, true);
	assert.deepEqual(kept, ["Settings", "Settings"], "covered the first time, pinned the second, then left alone");
});

test("the bundled window server answers without touching any window", { skip: process.platform !== "darwin" }, async () => {
	const server = await MacWindowServer.open();
	const dir = mkdtempSync(join(tmpdir(), "mountains-window-server-"));
	try {
		assert.equal(await server.keepVisible(process.pid, 0, []), "not_web", "a process with no web engine is left alone");
		await assert.rejects(server.popupSelect(process.pid, 0, { x: 0, y: 0, width: 10, height: 10 }, "x"), /exact window is gone/);
		assert.equal(await server.capture(0, join(dir, "none.png")), null, "no window 0, no image");
	} finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("menu bar status items are listed by m-number, a menu is read and closed, and a path is chosen in the background", async () => {
	const { d, log } = desktop({ unchanged: false, focusChanged: true, frontChanged: false, restored: true, attributionUnknown: false });
	const items = [{ pid: 77, app: "Clash Verge", index: 0, title: "", description: "Clash Verge", help: "" }, { pid: 88, app: "Control Center", index: 3, title: "", description: "Wi‑Fi", help: "" }];
	d.menubarItems = async () => items;
	d.menubarAction = async (item, path) => { log.push(`menubar ${item.description} ${path.join(">")}`); return path.length ? { kind: "chosen", closed: true, totalMs: 300 } : { kind: "menu", items: ["System Proxy [✓]", "TUN Mode", "Quit"], closed: true, totalMs: 200 }; };
	const t = tools(d);
	const list = await t.screen_read!.execute({ menubar: true }, ctx());
	assert.match(list.modelContent, /m1 "Clash Verge" \(Clash Verge, pid 77\)/);
	assert.match(list.modelContent, /m2 "Wi‑Fi" \(Control Center, pid 88\)/);
	const menu = await t.screen_act!.execute({ app: "menubar", action: "menubar", id: "m1" }, ctx());
	assert.equal(menu.details?.outcome, "confirmed", menu.modelContent);
	assert.match(menu.modelContent, /System Proxy \[✓\]/);
	assert.match(menu.modelContent, /held the keyboard while it was open/);
	const chosen = await t.screen_act!.execute({ app: "menubar", action: "menubar", id: "m1", text: "TUN Mode" }, ctx());
	assert.equal(chosen.details?.outcome, "unconfirmed", chosen.modelContent);
	assert.deepEqual(log.filter(line => line.startsWith("menubar")), ["menubar Clash Verge ", "menubar Clash Verge TUN Mode"]);
	const unknown = await t.screen_act!.execute({ app: "menubar", action: "menubar", id: "m9" }, ctx());
	assert.equal(unknown.ok, false); assert.match(unknown.modelContent, /read the menu bar first/);
});

test("the local action record keeps metadata only: no typed text, no names, no full addresses", async () => {
	const { historyEntry, appendHistory, readHistory } = await import("../src/history.ts");
	const dir = mkdtempSync(join(tmpdir(), "mountains-history-"));
	try {
		const native = historyEntry("screen_act", { app: "Notes", action: "type", id: "e4", text: "my secret note" }, { ok: true, modelContent: "typed my secret note", summary: "", details: { app: "Notes", outcome: "confirmed", dispatched: true } }, 312.4, new Date("2026-10-19T12:00:00Z"))!;
		const web = historyEntry("web_act", { steps: [{ action: "type", text: "hello" }, { action: "click" }] }, { ok: true, modelContent: "", summary: "", details: { url: "https://mail.example.com/inbox?id=42", outcome: "unconfirmed", dispatched: true } }, 80, new Date("2026-10-19T12:00:01Z"))!;
		assert.equal(historyEntry("screen_read", { app: "Notes" }, { ok: true, modelContent: "", summary: "", details: {} }, 5), undefined, "reads are not recorded");
		await appendHistory(dir, native); await appendHistory(dir, web);
		const back = await readHistory(dir);
		assert.deepEqual(back.map(e => [e.tool, e.target, e.action, e.outcome, e.ms]), [["web_act", "mail.example.com", "type+click", "unconfirmed", 80], ["screen_act", "Notes", "type", "confirmed", 312]]);
		assert.doesNotMatch(JSON.stringify(back), /secret note|hello|inbox|id=42/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a save panel takes a whole path: the name into its name field, the folder into its path field, committed", async () => {
	const log: string[] = [];
	const field = (id: string, value: string, actions: string[]) => ({ ...element({ role: "text_field", name: id, value, actions, bounds: { x: 0, y: 0, width: 100, height: 20 } }, log), stableId: id, editable: true,
		setValue: async (v: string) => { log.push(`set ${id}=${v}`); (f as { value: string | null }).value = v; }, performAction: async (a: string) => { log.push(`${a} ${id}`); } }) as UiElement & { value: string | null };
	let f: UiElement & { value: string | null };
	const name = (f = field("saveAsNameTextField", "Untitled", ["set_value"]));
	const path = field("PathTextField", "/Users/me/Desktop", ["set_value", "confirm"]);
	// The panel's Where control follows the path field once it is confirmed, unless `stuck`.
	let stuck = false;
	const where = { ...element({ role: "combo_box", name: "Where:", value: "Desktop", raw: { ax_role: "AXPopUpButton" }, bounds: { x: 0, y: 30, width: 100, height: 20 } }, log), stableId: "where popup" } as UiElement & { value: string | null };
	const sheet = element({ role: "sheet", name: "Save", bounds: { x: 100, y: 100, width: 400, height: 300 } }, log);
	(sheet as unknown as { children(): Promise<UiElement[]> }).children = async () => [where, name, path];
	let pathRef = path; pathRef.setValue = async (v: string) => { log.push(`set PathTextField=${v}`); pathRef.value = v; };
	pathRef.performAction = async (a: string) => { log.push(`${a} PathTextField`); if (!stuck) where.value = (pathRef.value ?? "").split("/").at(-1)!; };
	const app: UiApp = { name: "Notes", pid: 4242, isForeground: false, windows: async () => [sheet] };
	const d = { apps: async () => [app], captureWindow: async () => { throw new Error("none"); }, pointer: async () => {}, key: async () => { log.push("key"); }, showCursor: async () => {}, ownPids: () => [],
		prepare: async () => {}, clipboardSet: async () => {}, clipboardRestore: async () => {}, installedApps: async () => [], launch: async () => {}, menus: async () => [], pressMenu: async () => {} } as Desktop;
	const t = tools(d);
	await t.screen_read!.execute({ app: "Notes" }, ctx());
	const done = await t.screen_act!.execute({ app: "Notes", action: "file_path", text: "/Users/me/Documents/Reports/q3.txt" }, ctx());
	assert.equal(done.details?.outcome, "confirmed", done.modelContent);
	assert.deepEqual(log.filter(line => /^(set|confirm)/.test(line)), ["set PathTextField=/Users/me/Documents/Reports", "confirm PathTextField", "set saveAsNameTextField=q3.txt"], "the folder first, the name only after it");
	// The folder did not change: nothing goes into the name field, and it is a failure.
	stuck = true; log.length = 0; await t.screen_read!.execute({ app: "Notes" }, ctx());
	const wrong = await t.screen_act!.execute({ app: "Notes", action: "file_path", text: "/Users/me/Other/q9.txt" }, ctx());
	assert.equal(wrong.details?.outcome, "failed", wrong.modelContent); assert.match(wrong.modelContent, /the file name was not set/);
	assert.deepEqual(log.filter(line => /^set saveAs/.test(line)), []);
	stuck = false;
	const relative = await t.screen_act!.execute({ app: "Notes", action: "file_path", text: "docs/q3.txt" }, ctx());
	assert.equal(relative.ok, false); assert.match(relative.modelContent, /absolute path/);
	// A panel without a path field (macOS 26's own panels) takes a bare name, and refuses a whole path untouched.
	(sheet as unknown as { children(): Promise<UiElement[]> }).children = async () => [where, name];
	await t.screen_read!.execute({ app: "Notes" }, ctx());
	log.length = 0;
	const whole = await t.screen_act!.execute({ app: "Notes", action: "file_path", text: "/Users/me/Documents/q4.txt" }, ctx());
	assert.equal(whole.ok, false); assert.match(whole.modelContent, /no path field[^]*nothing was typed/);
	assert.deepEqual(log.filter(line => /^set/.test(line)), []);
	await t.screen_read!.execute({ app: "Notes" }, ctx());
	const bare = await t.screen_act!.execute({ app: "Notes", action: "file_path", text: "q4.txt" }, ctx());
	assert.equal(bare.details?.outcome, "confirmed", bare.modelContent);
	assert.deepEqual(log.filter(line => /^set/.test(line)), ["set saveAsNameTextField=q4.txt"]);
});

test("windows off this screen are named, and a minimized one is restored under the focus guard", async () => {
	const { d, log } = desktop({ unchanged: true });
	let hidden = [{ title: "Draft 2", minimized: true }, { title: "Board", minimized: false }];
	d.offscreenWindows = async () => hidden;
	d.unminimize = async (_app, title) => { log.push(`unminimize ${title}`); hidden = hidden.filter(w => w.title !== title); return true; };
	const second = element({ role: "window", name: "Other", bounds: { x: 600, y: 100, width: 300, height: 200 } }, log);
	const app = (await d.apps())[0]!; const first = (await app.windows())[0]!;
	app.windows = async () => [first, second];
	const t = tools(d);
	const choose = await t.screen_read!.execute({ app: "Notes" }, ctx());
	assert.match(choose.modelContent, /Not on this screen: "Draft 2" \(minimized: screen_act unminimize with its title\), "Board" \(on another desktop: reading or operating it would switch the user.s desktop/);
	const restored = await t.screen_act!.execute({ app: "Notes", action: "unminimize", text: "Draft 2" }, ctx());
	assert.equal(restored.details?.outcome, "confirmed", restored.modelContent);
	assert.deepEqual(log.filter(l => /^(begin|unminimize|end)/.test(l)), ["begin", "unminimize Draft 2", "end"]);
});

test("a crashed window server's pins are put back by the next one", { skip: process.platform !== "darwin" }, async () => {
	const home = mkdtempSync(join(tmpdir(), "mountains-pins-"));
	const before = process.env.MOUNTAINS_HOME;
	try {
		const { writeFileSync, existsSync } = await import("node:fs");
		writeFileSync(join(home, "window-server-pins.json"), JSON.stringify([{ window: 0, previous: true }]));
		process.env.MOUNTAINS_HOME = home;
		const server = await MacWindowServer.open();
		assert.equal(await server.keepVisible(process.pid, 0, []), "not_web");
		assert.equal(existsSync(join(home, "window-server-pins.json")), false, "leftover pins are restored and the record removed at start");
		await server.close();
	} finally { if (before === undefined) delete process.env.MOUNTAINS_HOME; else process.env.MOUNTAINS_HOME = before; rmSync(home, { recursive: true, force: true }); }
});

test("a bare file name goes through the window server's bounded panel requests, and press:true saves", async () => {
	const { d, log } = desktop({ unchanged: true });
	const app = (await d.apps())[0]!, win = (await app.windows())[0]!;
	(win as unknown as { children(): Promise<UiElement[]> }).children = async () => [{ ...element({ role: "text_field", name: "Save As", value: "Untitled", raw: {}, bounds: { x: 0, y: 0, width: 50, height: 20 } }, log), stableId: "saveAsNameTextField" } as UiElement];
	d.panelField = async (_a, _w, id, value) => { log.push(`field ${id}=${value}`); return value ?? ""; };
	d.panelPress = async (_a, _w, id) => { log.push(`press ${id}`); return true; };
	const t = tools(d);
	await t.screen_read!.execute({ app: "Notes" }, ctx());
	const done = await t.screen_act!.execute({ app: "Notes", action: "file_path", text: "report.txt", press: true }, ctx());
	assert.equal(done.details?.outcome, "confirmed", done.modelContent);
	assert.match(done.modelContent, /Its Save button was pressed/);
	assert.deepEqual(log.filter(l => /^(field|press )/.test(l)), ["field saveAsNameTextField=report.txt", "press OKButton"]);
});
