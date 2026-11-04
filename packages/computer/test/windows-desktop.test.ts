import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FileStateTracker, Workspace, type ToolContext, type ToolDefinition } from "@mountains/tools";
import { InputCoordinator } from "../src/coordinator.ts";
import { verifyWindowsHelper, WINDOWS_SEMANTIC_ONLY, windowHandle, windowScale, windowsDesktop, type WindowsHelper } from "../src/backend-windows.ts";
import { userInterventionReason } from "../src/backend.ts";
import { createComputerTools, decodePng, encodePng, WindowUnavailableError, type Rect, type UiElement } from "../src/index.ts";

type Spec = { role: string; name?: string; value?: string; stableId?: string; actions?: string[]; bounds?: Rect; kids?: Spec[] };
function el(spec: Spec, log: string[]): UiElement {
	const kids = (spec.kids ?? []).map(k => el(k, log));
	const act = (what: string) => async () => { log.push(`${what} ${spec.name}`); };
	return { role: spec.role, name: spec.name ?? null, value: spec.value ?? null, description: null, stableId: spec.stableId ?? null, actions: spec.actions ?? [],
		bounds: spec.bounds ?? null, visible: true, enabled: true, focused: false, selected: false, checked: null, expanded: null, editable: false, raw: {},
		children: async () => kids, press: act("press"), focus: act("focus"), toggle: act("toggle"), expand: act("expand"), collapse: act("collapse"), select: act("select"),
		increment: act("increment"), decrement: act("decrement"), setValue: act("set"), typeText: act("type"), scrollIntoView: act("scroll"),
		selectText: act("select text"), performAction: act("perform"), showMenu: act("menu") };
}

// Notepad as xa11y reported it in the Windows 11 VM: the window rectangle includes the invisible resize border.
const NOTEPAD: Spec = { role: "window", name: "Untitled - Notepad", stableId: "hwnd:0x10548", bounds: { x: 78, y: 78, width: 768, height: 519 }, kids: [
	{ role: "group", stableId: "hwnd:0x1056a", bounds: { x: 84, y: 153, width: 756, height: 406 }, kids: [
		{ role: "web_area", name: "Text editor", value: "hello", actions: ["set_value", "focus"], bounds: { x: 84, y: 153, width: 756, height: 406 } },
	] },
	{ role: "web_area", name: "Help page", actions: ["focus"], bounds: { x: 90, y: 90, width: 100, height: 40 } },
	{ role: "button", name: "Settings", actions: ["press", "focus"], bounds: { x: 800, y: 100, width: 32, height: 32 } },
] };
const FRAME = { x: 85, y: 78, width: 754, height: 512 };

function fakeHelper(options: { scale?: number; pid?: number; minimized?: boolean; gone?: boolean; moveAfterCapture?: boolean } = {}) {
	const k = options.scale ?? 1, sent: Record<string, unknown>[] = [];
	const physical = (r: Rect) => ({ x: r.x / k, y: r.y / k, width: r.width / k, height: r.height / k });
	let moved = false;
	// Another program's window is in front, and the user's last input is at tick 1000; tests move both.
	const helper: WindowsHelper & { sent: typeof sent; disposed: boolean; front: { hwnd: number; pid: number }; tick: number; broken: Set<string> } = {
		sent, pid: 31337, disposed: false, front: { hwnd: 0x2a1, pid: 999 }, tick: 1000, broken: new Set(),
		async send(command) {
			sent.push(command);
			if (helper.broken.has(String(command.op))) throw new Error(`Win32Exception: ${String(command.op)} failed`);
			if (command.op === "foreground") return { hwnd: helper.front.hwnd, pid: helper.front.pid };
			if (command.op === "last_input") return { tick: helper.tick, now: helper.tick + 5 };
			if (command.op === "processes") return { processes: { 5688: { pid: 5688, name: "Notepad", start: "2026-10-22T01:02:03.0000000Z", path: "C:\\Program Files\\WindowsApps\\Notepad\\Notepad.exe" } } };
			if (command.op === "window") {
				if (options.gone) throw new Error("InvalidOperationException: the window is gone");
				const bounds = moved ? { ...NOTEPAD.bounds!, x: NOTEPAD.bounds!.x + 40 } : NOTEPAD.bounds!;
				return { pid: options.pid ?? 5688, bounds: physical(bounds), frame: physical(FRAME), visible: true, minimized: options.minimized === true, cloaked: false };
			}
			if (command.op === "capture") {
				const area = physical(FRAME), width = Math.round(area.width), height = Math.round(area.height), rgba = Buffer.alloc(width * height * 4);
				// Left half red, right half blue, and every alpha zero (as a capture can deliver).
				for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(x < width / 2 ? [255, 0, 0, 0] : [0, 0, 255, 0], (y * width + x) * 4);
				writeFileSync(String(command.file), encodePng(width, height, rgba));
				if (options.moveAfterCapture) moved = true;
				return { method: "graphics-capture", width, height, area, windowRect: physical(NOTEPAD.bounds!) };
			}
			throw new Error(`unexpected op ${String(command.op)}`);
		},
		async dispose() { helper.disposed = true; },
	};
	return helper;
}

async function notepad(options: Parameters<typeof fakeHelper>[0] = {}) {
	const log: string[] = [], helper = fakeHelper(options), window = el(NOTEPAD, log);
	const desktop = await windowsDesktop({ helper, list: async () => [{ name: "Notepad", pid: 5688, isForeground: false, windows: async () => [window] }] });
	const [app] = await desktop.apps();
	return { desktop, app: app!, window: (await app!.windows())[0]!, helper, log };
}

test("the window number comes from xa11y's stableId and nothing else", () => {
	assert.equal(windowHandle(el(NOTEPAD, [])), 0x10548);
	assert.throws(() => windowHandle(el({ role: "window", stableId: "runtime:42" }, [])), /no window handle/);
	assert.throws(() => windowHandle(el({ role: "window" }, [])), /no window handle/);
});

test("helper pixels are scaled to xa11y's coordinates, matched by the window rectangle or the visible frame", () => {
	const live = (bounds: Rect, frame: Rect) => ({ pid: 1, bounds, frame, minimized: false, cloaked: false, visible: true });
	assert.equal(windowScale(NOTEPAD.bounds!, live(NOTEPAD.bounds!, FRAME)), 1);
	// Node not DPI aware at 150%: xa11y sees two thirds of the physical pixels.
	assert.equal(windowScale({ x: 100, y: 60, width: 400, height: 300 }, live({ x: 150, y: 90, width: 600, height: 450 }, { x: 160, y: 90, width: 580, height: 440 })), 400 / 600);
	assert.equal(windowScale({ x: 85, y: 78, width: 754, height: 512 }, live(NOTEPAD.bounds!, FRAME)), 1);
	assert.equal(windowScale(NOTEPAD.bounds!, live({ ...NOTEPAD.bounds!, x: 300 }, { ...FRAME, x: 307 })), null);
});

test("apps carry the process start time, and an editable Document is a text area while a read-only one stays a web area", async () => {
	const { app, window, helper } = await notepad();
	assert.equal(app.instance, "2026-10-22T01:02:03.0000000Z");
	assert.equal(app.executableName, "Notepad.exe");
	assert.deepEqual(helper.sent.find(c => c.op === "processes")?.pids, [5688]);
	const [group, help] = await window.children();
	const [editor] = await group!.children();
	assert.equal(editor!.role, "text_area");
	assert.equal(editor!.value, "hello");
	assert.equal(help!.role, "web_area");
	assert.equal(window.role, "window");
});

test("window identity is the live window number, checked against its owner and state", async () => {
	const { desktop, app, window } = await notepad();
	assert.deepEqual(await desktop.windowIdentity!(app, window), { id: String(0x10548), bounds: NOTEPAD.bounds });
	const other = await notepad({ pid: 999 });
	await assert.rejects(other.desktop.windowIdentity!(other.app, other.window), /another process/);
	const small = await notepad({ minimized: true });
	await assert.rejects(small.desktop.windowIdentity!(small.app, small.window), (e: unknown) => e instanceof WindowUnavailableError && /minimized/.test(String(e)));
	const gone = await notepad({ gone: true });
	await assert.rejects(gone.desktop.windowIdentity!(gone.app, gone.window), WindowUnavailableError);
});

test("a capture maps the visible frame, zooms inside it, scales down, and is opaque", async () => {
	for (const scale of [1, 2 / 3]) {
		const { desktop, app, window } = await notepad({ scale });
		const shot = await desktop.captureWindow(app, window, 4000);
		assert.equal(shot.windowId, String(0x10548));
		const [frame] = shot.desktopRectToImage(FRAME);
		assert.ok(Math.abs(frame!.x) < 1e-6 && Math.abs(frame!.y) < 1e-6 && Math.abs(frame!.width - shot.width) < 1e-6, `frame fills the image at scale ${scale}`);
		const [x, y] = shot.imageToDesktop(shot.width, shot.height);
		assert.ok(Math.abs(x - (FRAME.x + FRAME.width)) < 1e-6 && Math.abs(y - (FRAME.y + FRAME.height)) < 1e-6);
		assert.ok(shot.pixels.every((v, i) => i % 4 !== 3 || v === 255), "alpha is opaque");
		const small = await desktop.captureWindow(app, window, 300);
		assert.equal(small.width, 300);
		const right = await desktop.captureWindow(app, window, 4000, { x: FRAME.x + FRAME.width / 2 + 10, y: 100, width: 100, height: 50 });
		assert.deepEqual([...right.pixels.subarray(0, 4)], [0, 0, 255, 255], "the zoom shows the right half");
		const [zoomed] = right.desktopRectToImage({ x: FRAME.x + FRAME.width / 2 + 10, y: 100, width: 100, height: 50 });
		assert.ok(Math.abs(zoomed!.x) < 1 && Math.abs(zoomed!.width - right.width) < 1);
	}
	const { desktop, app, window } = await notepad();
	await assert.rejects(desktop.captureWindow(app, window, 1000, { x: 0, y: 0, width: 10, height: 10 }), /outside the exact window/);
	await assert.rejects(desktop.captureWindow(app, window, 1000, { x: 78, y: 300, width: 5, height: 10 }), /invisible border/);
	const moving = await notepad({ moveAfterCapture: true });
	await assert.rejects(moving.desktop.captureWindow(moving.app, moving.window, 1000), /moved|changed/);
});

test("every input path of the desktop itself refuses before anything is sent, and closing stops the helper", async () => {
	const { desktop, app, window, helper } = await notepad();
	const before = helper.sent.length;
	for (const run of [() => desktop.pointer(app, window, { kind: "click", at: [100, 100] }), () => desktop.key(app, window, "a", []), () => desktop.text!(app, window, window, "x"), () => desktop.typeAtFocus!(app, window, "x"),
		() => desktop.clipboardSet("x"), () => desktop.launch("Notepad"), () => desktop.pressMenu(app, "File > Save")])
		await assert.rejects(run(), (e: unknown) => String(e).includes(WINDOWS_SEMANTIC_ONLY));
	await assert.rejects(desktop.menus(app), /not available on Windows/);
	assert.equal(helper.sent.length, before, "no helper command was sent");
	assert.equal(desktop.inputs, "semantic");
	assert.equal("readOnly" in desktop, false);
	assert.equal(desktop.unminimize, undefined);
	assert.equal(desktop.menubarItems, undefined);
	assert.equal(desktop.panelField, undefined);
	assert.deepEqual(desktop.ownPids(), [31337]);
	assert.deepEqual(await desktop.installedApps(), []);
	await desktop.close!();
	assert.equal(helper.disposed, true);
});

type Tools = Record<string, ToolDefinition>;
const toolContext = (): ToolContext & { asked: unknown[] } => {
	const asked: unknown[] = [];
	return { workspace: new Workspace(process.cwd()), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c1", asked, approve: async (request) => { asked.push(request); return "allow"; } };
};
const toolsFor = (desktop: Awaited<ReturnType<typeof windowsDesktop>>): Tools => Object.fromEntries(createComputerTools({ desktop: async () => desktop, imageInput: true, settleMs: 0, settleMaxMs: 0, coordinator: new InputCoordinator() }).map(t => [t.name, t]));

test("screen_read and screen_look work through the tools on Windows, and a click with nothing to press is refused with not_executed", async () => {
	const { desktop, log, helper } = await notepad();
	const tools = toolsFor(desktop), ctx = toolContext();
	const read = await tools.screen_read!.execute({ app: "Notepad" }, ctx);
	assert.equal(read.ok, true, read.modelContent);
	assert.match(read.modelContent, /text_area|Text editor/);
	const snapshot = String(read.details.snapshot);
	const look = await tools.screen_look!.execute({ app: "Notepad" }, ctx);
	assert.equal(look.ok, true, look.modelContent);
	assert.equal(look.images?.length, 1);
	assert.equal(decodePng(Buffer.from(look.images![0]!.data, "base64")).width, look.details.width);
	const sent = helper.sent.length;
	// e1 is the window: it has no press action, so a click would have to be a mouse event.
	const act = await tools.screen_act!.execute({ app: "Notepad", snapshot, action: "click", id: "e1" }, ctx);
	assert.equal(act.ok, false);
	assert.equal(act.details.outcome, "not_executed");
	assert.equal(act.details.dispatched, false);
	assert.match(act.modelContent, /would need the mouse/);
	assert.match(act.modelContent, /no input was sent/);
	assert.deepEqual(helper.sent.slice(sent).map(c => c.op).filter(op => op !== "processes" && op !== "window"), [], "only reads of the app and the window; the foreground guard never started");
	const missing = await tools.screen_read!.execute({ app: "Paint" }, ctx);
	assert.equal(missing.ok, false);
	assert.match(missing.modelContent, /no running app/);
	assert.deepEqual(log, [], "no element method ran");
});

// A form whose controls change when they are used, so an action can be read back.
function liveForm(options: { onPress?: (helper: ReturnType<typeof fakeHelper>) => void } = {}) {
	const log: string[] = [], helper = fakeHelper();
	const state = { checked: "false", expanded: false, selected: false, name: "old", volume: 3, status: "idle" };
	const leaf = (spec: Spec, props: Record<string, () => unknown> = {}, methods: Record<string, (...args: unknown[]) => void> = {}): UiElement => {
		const element = el(spec, log) as unknown as Record<string, unknown>;
		for (const [key, get] of Object.entries(props)) Object.defineProperty(element, key, { get, enumerable: true });
		for (const [key, run] of Object.entries(methods)) {
			const original = element[key] as (...args: unknown[]) => Promise<void>;
			element[key] = async (...args: unknown[]) => { await original(...args); run(...args); };
		}
		return element as unknown as UiElement;
	};
	const b = (n: number): Rect => ({ x: 90, y: 90 + n * 30, width: 200, height: 24 });
	const kids = [
		leaf({ role: "button", name: "Apply", actions: ["press", "focus"], bounds: b(1) }, {}, { press: () => { state.status = "applied"; options.onPress?.(helper); } }),
		leaf({ role: "check_box", name: "Agree", actions: ["toggle", "focus"], bounds: b(2) }, { checked: () => state.checked }, { toggle: () => { state.checked = state.checked === "true" ? "false" : "true"; } }),
		leaf({ role: "tree_item", name: "Advanced", actions: ["expand", "collapse"], bounds: b(3) }, { expanded: () => state.expanded }, { expand: () => { state.expanded = true; }, collapse: () => { state.expanded = false; } }),
		leaf({ role: "list_item", name: "Second", actions: ["select"], bounds: b(4) }, { selected: () => state.selected }, { select: () => { state.selected = true; } }),
		leaf({ role: "text_field", name: "Name", actions: ["set_value", "focus"], bounds: b(5) }, { value: () => state.name, editable: () => true }, { setValue: value => { state.name = String(value); } }),
		leaf({ role: "slider", name: "Volume", actions: ["increment", "decrement"], bounds: b(6) }, { value: () => String(state.volume) }, { increment: () => { state.volume++; }, decrement: () => { state.volume--; } }),
		leaf({ role: "button", name: "Far away", actions: ["press", "scroll_to_visible"], bounds: b(7) }),
		leaf({ role: "static_text", name: "Status", bounds: b(8) }, { value: () => state.status }),
		leaf({ role: "combo_box", name: "Size", value: "Small", actions: ["expand", "collapse", "set_value"], bounds: b(9) }),
	];
	const window = el({ role: "window", name: "Form - Notepad", stableId: "hwnd:0x10548", bounds: NOTEPAD.bounds! }, log) as unknown as { children: () => Promise<UiElement[]> };
	window.children = async () => kids;
	return { log, helper, state, window: window as unknown as UiElement };
}
async function formTools(form: ReturnType<typeof liveForm>) {
	const desktop = await windowsDesktop({ helper: form.helper, list: async () => [{ name: "Notepad", pid: 5688, isForeground: false, windows: async () => [form.window] }] });
	const tools = toolsFor(desktop), ctx = toolContext();
	const read = await tools.screen_read!.execute({ app: "Notepad" }, ctx);
	assert.equal(read.ok, true, read.modelContent);
	const idOf = (text: string, needle: string) => { const line = text.split("\n").find(l => l.includes(needle)); assert.ok(line, `${needle} is listed in\n${text}`); return line.trim().split(" ")[0]!; };
	return { desktop, tools, ctx, read, idOf, ids: Object.fromEntries(["Apply", "Agree", "Advanced", "Second", "Name", "Volume", "Far away", "Status", "Size"].map(name => [name, idOf(read.modelContent, `"${name}"`)])) as Record<string, string> };
}

test("each semantic action reaches its element method, in the background, with a real outcome", async () => {
	const form = liveForm(), { tools, ctx, ids, desktop } = await formTools(form);
	const act = (args: Record<string, unknown>) => tools.screen_act!.execute({ app: "Notepad", ...args }, ctx);
	const run = async (args: Record<string, unknown>, method: string, outcome: string) => {
		form.log.length = 0;
		const done = await act(args);
		assert.deepEqual(form.log, [method], `${String(args.action)} ran ${method} and nothing else: ${done.modelContent}`);
		assert.equal(done.details.outcome, outcome, done.modelContent);
		assert.equal(done.details.dispatched, true);
		assert.equal(done.details.mode, "background");
		assert.deepEqual({ unchanged: (done.details.foreground as { unchanged: boolean }).unchanged, byUser: (done.details.foreground as { byUser: boolean }).byUser }, { unchanged: true, byUser: false });
		return done;
	};
	const pressed = await run({ action: "press", id: ids.Apply }, "press Apply", "unconfirmed");
	assert.equal(pressed.ok, true, "the changed Status line is the evidence");
	assert.match(pressed.modelContent, /applied/);
	await run({ action: "toggle", id: ids.Agree }, "toggle Agree", "confirmed");
	assert.equal(form.state.checked, "true");
	await run({ action: "expand", id: ids.Advanced }, "expand Advanced", "confirmed");
	assert.equal(form.state.expanded, true);
	await run({ action: "collapse", id: ids.Advanced }, "collapse Advanced", "confirmed");
	assert.equal(form.state.expanded, false);
	await run({ action: "select", id: ids.Second }, "select Second", "confirmed");
	assert.equal(form.state.selected, true);
	await run({ action: "set_value", id: ids.Name, text: "new text" }, "set Name", "confirmed");
	assert.equal(form.state.name, "new text");
	await run({ action: "increment", id: ids.Volume }, "increment Volume", "unconfirmed");
	assert.equal(form.state.volume, 4);
	await run({ action: "decrement", id: ids.Volume }, "decrement Volume", "unconfirmed");
	assert.equal(form.state.volume, 3);
	await run({ action: "scroll_to_visible", id: ids["Far away"] }, "scroll Far away", "unconfirmed");
	// A plain click on a control that has a press action is that press, never a pointer event.
	form.state.status = "idle";
	await run({ action: "click", id: ids.Apply }, "press Apply", "unconfirmed");
	assert.equal(form.state.status, "applied");
	// Only reads of the foreground and the last-input tick ever reached the helper for these actions.
	assert.ok(form.helper.sent.every(c => ["processes", "window", "capture", "foreground", "last_input"].includes(String(c.op))), JSON.stringify(form.helper.sent.map(c => c.op)));
	await desktop.close!();
});

test("everything that needs the keyboard, the mouse, the clipboard or the foreground is refused before anything is sent", async () => {
	const form = liveForm(), { tools, ctx, ids, desktop, read } = await formTools(form);
	const snapshot = String(read.details.snapshot);
	form.log.length = 0;
	const refused: [string, Record<string, unknown>][] = [
		["double_click", { id: ids.Apply }], ["right_click", { id: ids.Apply }], ["hover", { id: ids.Apply }], ["drag", { id: ids.Apply, to: ids.Agree }], ["scroll", { id: ids.Apply, dy: 100 }], ["scroll", { id: ids["Far away"] }],
		["focus", { id: ids.Name }], ["select_text", { id: ids.Name, text: "o" }], ["perform", { id: ids.Apply, text: "press" }],
		["key", { key: "Enter" }], ["key", { key: "ctrl+s" }], ["type", { id: ids.Name, text: "x" }], ["type", { text: "x" }], ["paste", { id: ids.Name, text: "x" }],
		["menu", { text: "File > Save" }], ["menubar", { id: "m1" }], ["file_path", { text: "C:\\Temp\\a.txt" }], ["unminimize", { text: "Form" }], ["bring_to_front", {}],
		["click", { id: ids.Apply, x: 10, y: 10 }], ["click", { id: ids.Apply, method: "pointer" }], ["click", { id: ids.Apply, modifiers: ["Shift"] }],
	];
	// A click on an element with nothing to press is known to be a mouse event only once the element is looked up.
	const needsElement: [string, Record<string, unknown>][] = [["click", { id: ids.Status }], ["click", { id: ids.Name }]];
	const asked = ctx.asked.length, sent = form.helper.sent.length;
	for (const [action, extra] of refused) {
		const done = await tools.screen_act!.execute({ app: "Notepad", snapshot, action, ...extra }, ctx);
		assert.equal(done.ok, false, `${action} ${JSON.stringify(extra)} must be refused`);
		assert.equal(done.details.outcome, "not_executed", `${action}: ${done.modelContent}`);
		assert.equal(done.details.dispatched, false, action);
		assert.match(done.modelContent, /[Nn]o input was sent|Nothing was sent/, action);
		assert.equal(form.helper.sent.length, sent, `${action} sent no helper command at all`);
	}
	for (const [action, extra] of needsElement) {
		const done = await tools.screen_act!.execute({ app: "Notepad", snapshot, action, ...extra }, ctx);
		assert.equal(done.details.outcome, "not_executed", `${action}: ${done.modelContent}`);
		assert.equal(done.details.dispatched, false, action);
		assert.match(done.modelContent, /would need the mouse, and this element has no press action/, action);
	}
	assert.deepEqual(form.helper.sent.slice(sent).map(c => c.op).filter(op => op !== "processes" && op !== "window"), [], "the element lookups only read; the foreground guard never started");
	assert.deepEqual(form.log, [], "no element method ran");
	assert.equal(ctx.asked.length, asked, "a refused action asks the user for nothing");
	// A dropdown that cannot be pressed open would be opened with the mouse: refused too, with the choice unsent.
	const choose = await tools.screen_act!.execute({ app: "Notepad", snapshot, action: "select", id: ids.Size, text: "Large" }, ctx);
	assert.equal(choose.details.outcome, "not_executed");
	assert.match(choose.modelContent, /would need the mouse/);
	// The refusal names what does work.
	const key = await tools.screen_act!.execute({ app: "Notepad", snapshot, action: "key", key: "Enter" }, ctx);
	assert.match(key.modelContent, /press, toggle, select, expand, collapse, set_value, increment, decrement and scroll_to_visible/);
	assert.match(key.modelContent, /keyboard, mouse, clipboard or foreground/);
	assert.deepEqual(form.log, []);
	await desktop.close!();
});

test("a batch with one refused step is refused whole, and no earlier step runs", async () => {
	const form = liveForm(), { tools, ctx, ids, desktop, read } = await formTools(form);
	const snapshot = String(read.details.snapshot), sent = form.helper.sent.length;
	const done = await tools.screen_act!.execute({ app: "Notepad", snapshot, steps: [{ action: "toggle", id: ids.Agree }, { action: "key", key: "Enter" }, { action: "press", id: ids.Apply }] }, ctx);
	assert.equal(done.ok, false);
	assert.equal(done.details.outcome, "not_executed");
	assert.equal(done.details.dispatched, false);
	assert.match(done.modelContent, /no step ran/);
	assert.deepEqual(form.log, []);
	assert.equal(form.state.checked, "false");
	assert.equal(form.helper.sent.length, sent);
	// The same steps without the key press run, in order, and stop on nothing.
	const fine = await tools.screen_act!.execute({ app: "Notepad", snapshot, steps: [{ action: "toggle", id: ids.Agree }, { action: "press", id: ids.Apply }] }, ctx);
	assert.equal(fine.details.dispatched, true, fine.modelContent);
	assert.deepEqual(form.log, ["toggle Agree", "press Apply"]);
	// A step whose click would be a mouse event stops the batch at that step, with the earlier ones kept.
	form.log.length = 0;
	const stopped = await tools.screen_act!.execute({ app: "Notepad", steps: [{ action: "select", id: ids.Second }, { action: "click", id: ids.Status }, { action: "press", id: ids.Apply }] }, ctx);
	assert.deepEqual(form.log, ["select Second"]);
	assert.equal(stopped.details.stoppedAt, 2);
	assert.equal(stopped.details.outcome, "not_executed");
	await desktop.close!();
});

test("a foreground change or the user's own input during an action is reported by the tools, not hidden", async () => {
	// The action itself brings another window to the front.
	const moved = liveForm({ onPress: helper => { helper.front = { hwnd: 0x999, pid: 4321 }; } }), a = await formTools(moved);
	const stolen = await a.tools.screen_act!.execute({ app: "Notepad", action: "press", id: a.ids.Apply }, a.ctx);
	assert.equal(stolen.ok, false);
	assert.equal(stolen.details.outcome, "failed");
	assert.equal(stolen.details.dispatched, true);
	assert.equal(stolen.details.retryUnsafe, true);
	assert.match(String(stolen.details.error), /foreground window changed/);
	assert.equal((stolen.details.foreground as { frontChanged: boolean }).frontChanged, true);
	// The user types in the very app being operated.
	const typing = liveForm({ onPress: helper => { helper.tick += 250; } }), b = await formTools(typing);
	typing.helper.front = { hwnd: 0x10548, pid: 5688 };
	const taken = await b.tools.screen_act!.execute({ app: "Notepad", action: "press", id: b.ids.Apply }, b.ctx);
	assert.equal(taken.details.outcome, "failed");
	assert.equal(taken.details.error, userInterventionReason("Notepad"));
	assert.equal((taken.details.foreground as { byUser: boolean }).byUser, true);
	// The user works in another app meanwhile: that does not stop anything.
	const elsewhere = liveForm({ onPress: helper => { helper.tick += 250; } }), c = await formTools(elsewhere);
	const fine = await c.tools.screen_act!.execute({ app: "Notepad", action: "press", id: c.ids.Apply }, c.ctx);
	assert.equal(fine.details.outcome, "unconfirmed");
	assert.equal(fine.ok, true, fine.modelContent);
	// A guard that cannot be read fails the action rather than passing it.
	const blind = liveForm(), d = await formTools(blind);
	blind.helper.broken.add("foreground");
	const noGuard = await d.tools.screen_act!.execute({ app: "Notepad", action: "toggle", id: d.ids.Agree }, d.ctx);
	assert.equal(noGuard.details.outcome, "not_executed");
	assert.deepEqual(blind.log, [], "the action did not run without its foreground baseline");
});

test("the foreground guard compares the front window and the user's input tick, and sends no input of its own", async () => {
	const { desktop, app, helper } = await notepad();
	const run = async (during: () => void) => { await desktop.beginInput!(app); during(); return desktop.endInput!(); };
	const quiet = await run(() => {});
	assert.deepEqual(quiet, { unchanged: true, byUser: false, frontChanged: false, focusChanged: false, restored: true, attributionUnknown: false });
	assert.deepEqual(helper.sent.map(c => c.op).filter(op => op !== "processes"), ["foreground", "last_input", "foreground", "last_input"]);
	// Another window comes to the front.
	const front = await run(() => { helper.front = { hwnd: 0x3b2, pid: 4321 }; });
	assert.equal(front.unchanged, false);
	assert.equal(front.frontChanged, true);
	assert.equal(front.byUser, false);
	assert.equal(front.restored, false);
	assert.match(front.reason ?? "", /window 0x2a1 of process 999 was in front, window 0x3b2 of process 4321 is now/);
	helper.front = { hwnd: 0x2a1, pid: 999 };
	// The same program opens a window of its own in front: still a different front window.
	helper.front = { hwnd: 0x10548, pid: 5688 };
	assert.equal((await run(() => { helper.front = { hwnd: 0x10600, pid: 5688 }; })).frontChanged, true);
	// The user uses the keyboard or mouse while the target is in front: the user changed it.
	const typing = await run(() => { helper.tick += 40; });
	assert.deepEqual({ unchanged: typing.unchanged, byUser: typing.byUser, frontChanged: typing.frontChanged, reason: typing.reason }, { unchanged: false, byUser: true, frontChanged: false, reason: userInterventionReason("Notepad") });
	// The user leaves the target for another window (input and front both change): by the user, and the change is shown.
	const left = await run(() => { helper.tick += 40; helper.front = { hwnd: 0x77, pid: 31 }; });
	assert.deepEqual({ byUser: left.byUser, frontChanged: left.frontChanged, unchanged: left.unchanged, reason: left.reason }, { byUser: true, frontChanged: true, unchanged: false, reason: userInterventionReason("Notepad") });
	// The user works in some other app all along: the action is untouched.
	helper.front = { hwnd: 0x2a1, pid: 999 };
	const elsewhere = await run(() => { helper.tick += 40; });
	assert.equal(elsewhere.unchanged, true);
	assert.equal(elsewhere.byUser, false);
	// The tick is a 32-bit clock that wraps: equality, not order.
	helper.front = { hwnd: 0x10548, pid: 5688 }; helper.tick = 4294967290;
	assert.equal((await run(() => { helper.tick = 5; })).byUser, true);
	// No baseline, an unreadable helper, or an unusable reply never pass as "unchanged".
	const unknown = await desktop.endInput!();
	assert.deepEqual({ unchanged: unknown.unchanged, attributionUnknown: unknown.attributionUnknown }, { unchanged: false, attributionUnknown: true });
	helper.broken.add("last_input");
	await assert.rejects(desktop.beginInput!(app), /last_input failed/);
	helper.broken.clear();
	await desktop.beginInput!(app);
	helper.broken.add("foreground");
	await assert.rejects(desktop.endInput!(), /foreground failed/);
	assert.equal((await desktop.endInput!()).attributionUnknown, true, "a failed end leaves no stale baseline");
	helper.broken.clear();
	assert.ok(helper.sent.every(c => ["processes", "foreground", "last_input"].includes(String(c.op))), "the guard only reads");
});

test("the bundled Windows helper matches its manifest, and a changed byte or another architecture is refused", () => {
	const source = fileURLToPath(new URL("../native/windows-helper/Program.cs", import.meta.url));
	const project = fileURLToPath(new URL("../native/windows-helper/windows-helper.csproj", import.meta.url));
	const binary = fileURLToPath(new URL("../native/win-anycpu/mountains-windows-helper.exe", import.meta.url));
	for (const arch of ["x64", "arm64"]) verifyWindowsHelper(source, project, binary, arch);
	assert.throws(() => verifyWindowsHelper(source, project, binary, "ia32"), /missing or invalid/);
	const dir = mkdtempSync(join(tmpdir(), "mountains-helper-check-"));
	try {
		const copy = join(dir, "mountains-windows-helper.exe");
		copyFileSync(binary, copy); copyFileSync(binary + ".json", copy + ".json");
		verifyWindowsHelper(source, project, copy, "x64");
		writeFileSync(copy, Buffer.concat([readFileSync(binary), Buffer.from([0])]));
		assert.throws(() => verifyWindowsHelper(source, project, copy, "x64"), /missing or invalid/);
		const edited = join(dir, "Program.cs");
		writeFileSync(edited, "// changed\n");
		assert.throws(() => verifyWindowsHelper(edited, project, binary, "x64"), /missing or invalid/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
