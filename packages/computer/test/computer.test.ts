import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import { FileStateTracker, Workspace, type ApprovalRequest, type ToolContext, type ToolDefinition } from "@mountains/tools";
import { ComputerState, corresponding,readbackIdentity } from "../src/state.ts";
import { currentInput, InputCoordinator } from "../src/coordinator.ts";
import { menuPressFailure, userInterventionReason, WindowUnavailableError } from "../src/backend.ts";
import { computerUseSkill, createComputerTools, decodePng, diffSnapshots, ElementIds, encodePng, parseKey, readSnapshot, SNAPSHOT_LIMITS, type Capture, type Desktop, type Rect, type UiApp, type UiElement } from "../src/index.ts";

/** A small fake desktop: elements with real-looking roles, actions and bounds. */
type Spec = Partial<Omit<UiElement, "children" | "raw">> & { role: string; raw?: Record<string, unknown>; kids?: Spec[]; closes?: boolean };
let closer: (() => void) | null = null;
interface FakeEl extends UiElement { log: string[]; spec: Spec; kidsList: FakeEl[] }
function el(spec: Spec, log: string[]): FakeEl {
	const kidsList = (spec.kids ?? []).map(k => el(k, log));
	const self: FakeEl = {
		role: spec.role, name: spec.name ?? null, value: spec.value ?? null, description: spec.description ?? null, stableId: spec.stableId ?? null,
		actions: spec.actions ?? [], bounds: spec.bounds ?? null, visible: spec.visible ?? true, enabled: spec.enabled ?? true, focused: spec.focused ?? false,
		selected: spec.selected ?? false, checked: spec.checked ?? null, expanded: spec.expanded ?? null, editable: spec.editable ?? false, raw: spec.raw ?? {},
		log, spec, kidsList,
		children: async () => self.kidsList,
		press: async () => { log.push(`press ${spec.name}`); if (spec.closes) closer?.(); }, focus: async () => { log.push(`focus ${spec.name}`); },
		toggle: async () => { log.push(`toggle ${spec.name}`); }, expand: async () => {}, collapse: async () => {}, select: async () => {},
		increment: async () => {}, decrement: async () => {}, scrollIntoView: async () => { log.push(`scroll into view ${spec.name}`); },
		showMenu: async () => { log.push(`menu of ${spec.name}`); },
		performAction: async (a: string) => { log.push(`perform ${a} on ${spec.name}`); },
		selectText: async (a: number, b: number) => { log.push(`select ${a}-${b} in ${spec.name}`); },
		setValue: async (v: string) => { log.push(`set ${spec.name}=${v}`); (self as { value: string | null }).value = v; },
		typeText: async (t: string) => { log.push(`type ${spec.name}:${t}`); if (self.value !== null) (self as { value: string | null }).value += t; },
	};
	return self;
}
function fakeDesktop(window: Spec, options: { closeOnPress?: boolean } = {}) {
	const log: string[] = [];
	let win: FakeEl | null = el(window, log);
	const app: UiApp = { name: "Notes", pid: 4242, isForeground: true, windows: async () => {
		if (!win) throw new Error("AXError -25204");
		return [win];
	} };
	const other: UiApp = { name: "Mountains", pid: 1, isForeground: false, windows: async () => [] };
	const capture = (w: number, h: number, origin: Rect): Capture => ({
		width: w, height: h, pixels: Buffer.alloc(w * h * 4, 40),
		desktopRectToImage: r => [{ x: (r.x - origin.x) * w / origin.width, y: (r.y - origin.y) * h / origin.height, width: r.width * w / origin.width, height: r.height * h / origin.height }],
		imageToDesktop: (x, y) => [origin.x + x * origin.width / w, origin.y + y * origin.height / h],
	});
	const launched: UiApp[] = [];
	const desktop: Desktop = {
		apps: async () => [app, other, ...launched],
		captureWindow: async (_app, window, maxWidth, region) => {
			const area = region ?? window.bounds!;
			const w = Math.min(2 * area.width, maxWidth);
			return capture(w, Math.round(area.height * w / area.width), area);
		},
		pointer: async (_app, window, g) => {
			const p = (q: [number, number]) => q.map(Math.round).join(",");
			log.push(`pointer ${g.held?.length ? `${g.held.join("+")}+` : ""}${g.kind} ${g.kind === "drag" ? `${p(g.from)}→${p(g.to)}` : p(g.at)}${g.kind === "click" ? ` ${g.button} x${g.count}` : ""}${g.kind === "scroll" ? ` ${g.dx},${g.dy}` : ""} in ${window.name}`);
		},
		key: async (_app, window, key, held) => { log.push(`key ${[...held, key].join("+")} in ${window.name}`); },
		showCursor: async (_app, _window, at) => { log.push(`cursor ${at.map(Math.round).join(",")}`); },
		ownPids: () => [],
		prepare: async () => {},
		clipboardSet: async (text, html) => { log.push(`clipboard ${JSON.stringify(text)}${html ? ` html ${html}` : ""}`); },
		clipboardRestore: async () => { log.push("clipboard restored"); },
		installedApps: async () => ["Calc", "Notes", "TextEdit"],
		launch: async name => {
			log.push(`launch ${name}`);
			if (name === "Calc") launched.push({ name: "Calc", pid: 777, isForeground: false, windows: async () => [el({ role: "window", name: "Calculator", bounds: { x: 0, y: 0, width: 200, height: 300 }, kids: [{ role: "button", name: "7", actions: ["press"], bounds: { x: 10, y: 100, width: 40, height: 40 } }] }, log)] });
			else throw new Error(`no app named ${JSON.stringify(name)} is installed`);
		},
		menus: async () => [{ path: "File > Save", shortcut: "⌘S", enabled: true }, { path: "Edit > Undo", shortcut: "⌘Z", enabled: false }],
		pressMenu: async (_app, path) => {
			if (path !== "File > Save") throw new Error(`no menu command ${JSON.stringify(path)}`);
			log.push(`menu ${path}`);
		},
	};
	closer = options.closeOnPress ? () => { win = null; } : null;
	return { desktop, log, root: () => win };
}
const WINDOW: Spec = { role: "window", name: "Note", stableId: "w1", bounds: { x: 100, y: 100, width: 400, height: 300 }, focused: true, kids: [
	{ role: "group", actions: ["focus", "scroll_to_visible"], kids: [
		{ role: "text_field", name: "Title", value: "Draft", actions: ["set_value", "focus", "show_menu"], editable: true, bounds: { x: 110, y: 120, width: 200, height: 24 } },
		{ role: "text_field", raw:{ax_subrole:"AXSecureTextField"}, name: "Password", actions: ["set_value"], bounds: { x: 110, y: 150, width: 200, height: 24 } },
		{ role: "button", name: "Save", actions: ["press", "focus"], closes: true, bounds: { x: 400, y: 360, width: 80, height: 28 } },
		{ role: "button", actions: ["press"], bounds: { x: 120, y: 360, width: 20, height: 20 } },
		{ role: "static_text", value: "Last saved 3 minutes ago" },
		{ role: "group", actions: ["focus"] },
		{ role: "button", name: "Hidden", actions: ["press"], visible: false },
	] },
] };
function ctx(answer: "allow" | "deny" = "allow"): ToolContext & { asked: ApprovalRequest[] } {
	const asked: ApprovalRequest[] = [];
	return { workspace: new Workspace(process.cwd()), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c1", asked,
		approve: async (r: ApprovalRequest) => { asked.push(r); return answer; } };
}
function tools(desktop: Desktop, extra: Parameters<typeof createComputerTools>[0] = {}): Record<string, ToolDefinition> {
	return Object.fromEntries(createComputerTools({ desktop: async () => desktop, settleMs: 0, settleMaxMs: 0, launchWaitMs: 0, ...extra }).map(t => [t.name, t]));
}

test("a snapshot keeps actionable and text elements, flattens empty containers, and keeps numbers between reads", async () => {
	const { root } = fakeDesktop(WINDOW);
	const ids = new ElementIds();
	const first = await readSnapshot([root()!], ids);
	assert.deepEqual(first.entries.map(e => e.line.trim()), [
		'e1 window "Note" [focused]',
		'e2 text_field "Title" = "Draft" {set_value}',
		'e3 text_field "Password" [password] {set_value}',
		'e4 button "Save" {press}',
		"e5 button {press}",
		'e6 static_text "" = "Last saved 3 minutes ago"'.replace(' ""', ""),
	]);
	const again = await readSnapshot([root()!], ids);
	assert.deepEqual(again.entries.map(e => e.id), first.entries.map(e => e.id));
	(root()!.kidsList[0]!.kidsList[0] as { value: string }).value = "Final";
	const changed = await readSnapshot([root()!], ids);
	assert.equal(diffSnapshots(first, changed), '~ e2 text_field "Title" = "Final" {set_value}');
	assert.equal(diffSnapshots(first, first), "No visible change in the accessibility tree.");
});

test("a collapsed branch stays closed, and a long list keeps every control plus a bounded run of rows", async () => {
	const rows = Array.from({ length: 50 }, (_, i) => ({ role: "static_text", name: `file ${i}` }));
	const tree: Spec = { role: "window", name: "Files", kids: [
		{ role: "outline_row", name: "Closed", expanded: false, actions: ["press"], kids: [{ role: "static_text", name: "Buried" }] },
		{ role: "list", kids: [...rows, { role: "text_field", name: "Save As", value: "Draft", editable: true }, { role: "button", name: "Save", actions: ["press"] }] },
	] };
	const snap = await readSnapshot([el(tree, [])], new ElementIds());
	assert.equal(snap.entries.some(entry => entry.line.includes("Buried")), false);
	assert.equal(snap.entries.some(entry => entry.line.includes("Save As")), true);
	assert.equal(snap.entries.some(entry => entry.line.includes('button "Save"')), true);
	assert.equal(snap.entries.filter(entry => /file \d+/.test(entry.line)).length, SNAPSHOT_LIMITS.fanout);
	assert.equal(snap.truncated, true);
});

test("a web area Chrome marks as not expanded is still read: only disclosure roles hide their rows", async () => {
	// Chrome and Electron report AXExpanded=false on the web area and on every element inside it.
	const tree: Spec = { role: "window", name: "Page", kids: [{ role: "group", kids: [{ role: "web_area", name: "Page", expanded: false, kids: [
		{ role: "heading", name: "Probe page", expanded: false }, { role: "button", name: "Visible button", expanded: false, actions: ["show_menu", "scroll_to_visible"] },
		{ role: "link", name: "Docs", actions: ["show_menu"] }, { role: "button", actions: ["show_menu"] },
	] }] }] };
	const snap = await readSnapshot([el(tree, [])], new ElementIds());
	assert.equal(snap.entries.some(entry => entry.line.includes('button "Visible button"')), true);
	assert.equal(snap.entries.some(entry => entry.line.includes("Probe page")), true);
	// Chrome's web controls list no press; they are kept by role and clicked with the pointer.
	assert.equal(snap.entries.some(entry => entry.line.includes('link "Docs"')), true);
	assert.equal(snap.entries.filter(entry => entry.element.role === "button").length, 1, "an unnamed control with no press stays out");
});

test("full reads include branches beyond the summary limit and keep those actions usable", async () => {
	const branches: Spec[] = Array.from({length:50},(_,index)=>({role:"group",kids:[{role:"static_text",name:`Branch ${index}`}]}));
	branches.push({role:"group",kids:[{role:"button",name:"Tail button",actions:["press"]}]});
	const {desktop,log}=fakeDesktop({role:"window",name:"Long view",bounds:{x:0,y:0,width:800,height:600},kids:[{role:"group",kids:branches}]});
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false});
	const summary=await observe(t);
	assert.doesNotMatch(summary.modelContent,/Tail button/);
	const complete=await t.screen_read!.execute({app:"Notes",full:true},ctx());
	assert.match(complete.modelContent,/Branch 49/);
	const id=complete.modelContent.match(/(e\d+) button "Tail button"/)![1];
	const pressed=await t.screen_act!.execute({app:"Notes",snapshot:complete.details?.snapshot,action:"press",id},ctx());
	assert.equal(pressed.details?.dispatched,true,pressed.modelContent);
	assert.ok(log.includes("press Tail button"));
	const found=await t.screen_read!.execute({app:"Notes",find:"Tail button"},ctx());
	assert.match(found.modelContent,/Tail button/);
});

test("custom actions keep their labels without dumping Cocoa descriptions",async()=>{
	const {root}=fakeDesktop({role:"window",name:"Actions",kids:[{role:"button",name:"Item",actions:["press","Archive","name:Move previous\n_target:0x0\n_selector:(null)"]}]});
	const snapshot=await readSnapshot([root()!],new ElementIds());
	assert.match(snapshot.entries.map(entry=>entry.line).join("\n"),/press,Archive,Move previous/);
	assert.doesNotMatch(snapshot.entries.map(entry=>entry.line).join("\n"),/_target:|_selector:/);
});


test("key specs name a key and the modifiers held with it", () => {
	assert.deepEqual(parseKey("cmd+shift+Z"), { key: "z", held: ["Meta", "Shift"] });
	assert.deepEqual(parseKey("Return"), { key: "Enter", held: [] });
	assert.deepEqual(parseKey("ctrl+f5"), { key: "F5", held: ["Ctrl"] });
	assert.deepEqual(parseKey("left"), { key: "ArrowLeft", held: [] });
	assert.deepEqual(parseKey("super+c"), { key: "c", held: ["Meta"] }, "xdotool names, as Codex takes them");
	assert.deepEqual(parseKey("Control_L+Shift_L+period"), { key: ".", held: ["Ctrl", "Shift"] });
	assert.deepEqual(parseKey("Page_Down"), { key: "PageDown", held: [] });
	assert.deepEqual(parseKey("KP_Enter"), { key: "Enter", held: [] });
	assert.throws(() => parseKey("a+b"), /can be held/);
});

test("an unnamed scroll container keeps its own actions for background navigation", async () => {
	const container = el({ role: "group", actions: ["scroll_up_by_page", "scroll_down_by_page"], kids: [{ role: "static_text", name: "Folder" }] }, []);
	const window = el({ role: "window", name: "Browser" }, []); window.kidsList.push(container);
	const snapshot = await readSnapshot([window], new ElementIds());
	const entry = snapshot.entries.find(entry => entry.element === container);
	assert.ok(entry);
	assert.match(entry.line, /scroll_up_by_page/);
	assert.match(entry.line, /scroll_down_by_page/);
});


test("PNG encoding and decoding round-trip pixels", () => {
	const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
	const png = encodePng(2, 2, pixels);
	const idat = png.subarray(png.indexOf("IDAT") + 4, png.indexOf("IEND") - 8);
	const raw = inflateSync(idat);
	assert.deepEqual([...raw], [0, ...pixels.subarray(0, 8), 0, ...pixels.subarray(8)]);
	assert.deepEqual(decodePng(png), { width: 2, height: 2, rgba: pixels });
});


async function observe(t: Record<string, ToolDefinition>, c = ctx(), window?: string) {
 const r = await t.screen_read!.execute({ app: "Notes", ...(window ? { window } : {}) }, c);
 assert.equal(r.ok, true, r.modelContent); return r;
}
async function act(t: Record<string, ToolDefinition>, args: Record<string, unknown>, c = ctx()) {
 const r = await observe(t, c); return t.screen_act!.execute({ app: "Notes", snapshot: r.details?.snapshot, ...args }, c);
}

test("an ordinary action that changes nothing does not attach an image", async () => {
 const { desktop } = fakeDesktop(WINDOW), t = tools(desktop, { imageInput: true, apps: { Notes: "act" }, cursor: false });
 const read = await observe(t);
 const pressed = await t.screen_act!.execute({ app: "Notes", snapshot: read.details?.snapshot, action: "press", id: "e4" }, ctx());
 assert.equal(pressed.details?.outcome, "unconfirmed", pressed.modelContent);
 assert.equal(pressed.images, undefined);
 assert.equal(pressed.ok, false);
});

test("a text-only model can explicitly click an observed button through window-addressed input", async () => {
	const { desktop, log } = fakeDesktop(WINDOW);
	const t = tools(desktop, { imageInput:false, apps:{ Notes:"act" }, cursor:false });
	const read = await observe(t);
	const pressed = await t.screen_act!.execute({ app:"Notes",snapshot:read.details?.snapshot,action:"click",method:"pointer",id:"e4" },ctx());
	assert.equal(pressed.details?.pointerMode,"process_addressed",pressed.modelContent);
	assert.equal(pressed.details?.dispatched,true);
	assert.ok(!log.includes("press Save"), log.join("\n"));
	assert.ok(log.some(line=>line.startsWith("pointer ")),log.join("\n"));
	log.length=0;
	const again=await observe(t);
	await t.screen_act!.execute({app:"Notes",snapshot:again.details?.snapshot,steps:[{action:"click",method:"pointer",id:"e4"}]},ctx());
	assert.ok(log.some(line=>line.startsWith("pointer ")),log.join("\n"));
	assert.ok(!log.includes("press Save"),log.join("\n"));
});

test("a retained AX action stays guarded without preparing an unrelated keyboard window", async () => {
	const { desktop, log } = fakeDesktop(WINDOW);
	desktop.beginInput = async () => { log.push("begin"); };
	desktop.prepareInput = async () => { throw new Error("priming a background panel can take keyboard focus"); };
	desktop.endInput = async () => { log.push("end"); return {unchanged:true}; };
	const t = tools(desktop,{apps:{Notes:"act"},cursor:false});
	await act(t,{action:"press",id:"e4"});
	assert.deepEqual(log,["begin","press Save","end"]);
	log.length=0;
	const readonly=tools(desktop,{apps:{Notes:"read"},cursor:false});
	await act(readonly,{action:"press",id:"e4"});
	assert.deepEqual(log,[]);
});

test("a verified selection followed by replacement confirms the batch without a visible selection diff", async () => {
	const { desktop, root } = fakeDesktop(WINDOW);
	const field = root()!.kidsList[0]!.kidsList[0]!;
	let range: [number,number] = [0,0];
	field.selectText = async (start,end) => { range = [start,end]; };
	field.typeText = async value => { (field as {value:string}).value = field.value!.slice(0,range[0])+value+field.value!.slice(range[1]); };
	desktop.selection = async () => range;
	const t = tools(desktop,{apps:{Notes:"act"},cursor:false});
	const read = await observe(t);
	const result = await t.screen_act!.execute({app:"Notes",snapshot:read.details?.snapshot,steps:[{action:"select_text",id:"e2",text:"raft"},{action:"type",id:"e2",text:"one"}]},ctx());
	assert.equal(field.value,"Done");
	assert.equal(result.ok,true,result.modelContent);
	assert.deepEqual((result.details?.steps as {outcome:string}[]).map(step=>step.outcome),["confirmed","confirmed"]);
});

test("a selection read back at the wrong range stops a batch before typing", async () => {
	const {desktop,root} = fakeDesktop(WINDOW);
	let typed = false;
	const field = root()!.kidsList[0]!.kidsList[0]!;
	field.selectText = async () => {};
	field.typeText = async () => { typed = true; };
	desktop.selection = async () => [0,0];
	const t = tools(desktop,{apps:{Notes:"act"},cursor:false});
	const read = await observe(t);
	const result = await t.screen_act!.execute({app:"Notes",snapshot:read.details?.snapshot,steps:[{action:"select_text",id:"e2",text:"raft"},{action:"type",id:"e2",text:"one"}]},ctx());
	assert.equal(result.ok,false);
	assert.equal(typed,false);
	assert.equal(field.value,"Draft");
	assert.equal(result.details?.stoppedAt,1);
});

test("cancellation during selection readback cannot be followed by an AX text write", async () => {
	const {desktop,root}=fakeDesktop(WINDOW);
	const controller=new AbortController();
	let typed=false;
	root()!.kidsList[0]!.kidsList[0]!.typeText=async()=>{typed=true;};
	desktop.selection=async()=>{controller.abort();return [0,0];};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false});
	const read=await observe(t);
	const context={...ctx(),signal:controller.signal};
	await t.screen_act!.execute({app:"Notes",snapshot:read.details?.snapshot,action:"type",id:"e2",text:"late"},context);
	assert.equal(typed,false);
	assert.equal(root()!.kidsList[0]!.kidsList[0]!.value,"Draft");
});

test("a second read of the same window lists only changes", async () => {
 const { desktop, root } = fakeDesktop(WINDOW), t = tools(desktop, { apps: { Notes: "read" } });
 const first = await observe(t);
 assert.match(first.modelContent, /Save/);
 const same = await t.screen_read!.execute({ app: "Notes" }, ctx());
 assert.equal(same.details?.diff, true);
 assert.match(same.modelContent, /No visible change/);
 assert.doesNotMatch(same.modelContent, /Save/);
 (root()!.kidsList[0]!.kidsList[0] as { value: string }).value = "Edited";
 const changed = await t.screen_read!.execute({ app: "Notes" }, ctx());
 assert.match(changed.modelContent, /Edited/);
 assert.doesNotMatch(changed.modelContent, /Save/);
 const full = await t.screen_read!.execute({ app: "Notes", full: true }, ctx());
 assert.match(full.modelContent, /Save/);
 assert.equal(full.details?.diff, undefined);
});

test("read permissions are cached per process and forbidden apps stay unavailable", async () => {
 const { desktop } = fakeDesktop(WINDOW); const t = tools(desktop, { excludePids: [1] }), c = ctx();
 const list = await t.screen_read!.execute({}, c); assert.match(list.modelContent, /Notes/); assert.doesNotMatch(list.modelContent, /Mountains/);
 await observe(t, c); await observe(t, c); assert.equal(c.asked.length, 1);
 assert.equal((await t.screen_read!.execute({ app: "Mountains" }, c)).ok, false);
 assert.equal((await tools(desktop, { apps: { Notes: "deny" } }).screen_read!.execute({ app: "Notes" }, c)).ok, false);
});

test("an action can omit the snapshot and a used snapshot follows the latest read", async () => {
 const { desktop, log } = fakeDesktop(WINDOW); const t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
 const noRead = await t.screen_act!.execute({ app: "Notes", action: "set_value", id: "e2", text: "wrong" }, ctx());
 assert.equal(noRead.details?.outcome, "not_executed"); assert.equal(log.length, 0);
 const read = await observe(t);
 const set = await t.screen_act!.execute({ app: "Notes", action: "set_value", id: "e2", text: "Final" }, ctx());
 assert.equal(set.details?.outcome, "confirmed"); assert.equal(set.details?.observed, "Final");
 const again = await t.screen_act!.execute({ app: "Notes", snapshot: read.details?.snapshot, action: "set_value", id: "e2", text: "Final" }, ctx());
 assert.equal(again.details?.outcome, "confirmed"); assert.deepEqual(log, ["set Title=Final", "set Title=Final"]);
});

test("no-op text writes and unrelated changes never become reported success", async () => {
 const { desktop, root, log } = fakeDesktop(WINDOW); const field = root()!.kidsList[0]!.kidsList[0]!;
 field.setValue = async () => { log.push("ignored"); (root()!.kidsList[0]!.kidsList[4] as {value:string}).value = "unrelated update"; };
 const t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
 const result = await act(t, { action: "set_value", id: "e2", text: "invented" });
 assert.equal(result.ok, false); assert.equal(result.details?.outcome, "unconfirmed"); assert.equal(result.details?.observed, "Draft");
 assert.match(result.modelContent, /Draft/); assert.doesNotMatch(result.modelContent, / = "invented"/);
});

test("delayed writes are confirmed only after the real value appears", async () => {
 const { desktop, root } = fakeDesktop(WINDOW), field = root()!.kidsList[0]!.kidsList[0]!;
 field.setValue = async value => { setTimeout(() => { (field as {value:string}).value = value; }, 30); };
 const t = tools(desktop, { apps: { Notes: "act" }, settleMaxMs: 250, settleMs: 10, cursor: false });
 const r = await act(t, { action: "set_value", id: "e2", text: "你好 Ελληνικά 🌍" });
 assert.equal(r.details?.outcome, "confirmed"); assert.equal(field.value, "你好 Ελληνικά 🌍");
});

test("type is dispatched only once and never falls back to replacing text", async () => {
 const { desktop, root, log } = fakeDesktop(WINDOW), field = root()!.kidsList[0]!.kidsList[0]!;
 field.typeText = async () => { log.push("ignored insertion"); };
 const t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
 const r = await act(t, { action: "type", id: "e2", text: "more", expect: { id: "e2", property: "value", value: "Draftmore" } });
 assert.equal(r.details?.outcome, "unconfirmed"); assert.deepEqual(log, ["ignored insertion"]); assert.equal(field.value, "Draft");
});

test("typing that shows up in the field is confirmed from the read-back", async () => {
 const { desktop, root } = fakeDesktop(WINDOW), field = root()!.kidsList[0]!.kidsList[0]!;
 const r = await act(tools(desktop, { apps: { Notes: "act" }, cursor: false }), { action: "type", id: "e2", text: " more" });
 assert.equal(r.details?.outcome, "confirmed", r.modelContent);
 assert.equal(r.ok, true);
 assert.equal(field.value, "Draft more");
});

test("a failed action cannot be rescued by another visible change", async () => {
 const { desktop, root } = fakeDesktop(WINDOW), button = root()!.kidsList[0]!.kidsList[2]!;
 button.press = async () => { (root()!.kidsList[0]!.kidsList[4] as {value:string}).value = "changed"; throw new Error("AX refused"); };
 const r = await act(tools(desktop, { apps: { Notes: "act" } }), { action: "press", id: "e4" });
 assert.equal(r.details?.outcome, "failed"); assert.equal(r.details?.dispatched, true); assert.equal(r.details?.retryUnsafe, true);
});

test("moved windows and replaced controls reject the old receipt before dispatch", async () => {
 for (const replace of [false, true]) {
  const { desktop, root, log } = fakeDesktop(WINDOW), t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
  const read = await observe(t);
  if (replace) root()!.kidsList[0]!.kidsList[0] = el(WINDOW.kids![0]!.kids![0]!, log);
  else (root()! as {bounds:Rect}).bounds = { ...root()!.bounds!, x: 200 };
  const r = await t.screen_act!.execute({ app: "Notes", snapshot: read.details?.snapshot, action: "set_value", id: "e2", text: "wrong" }, ctx());
  assert.equal(r.details?.outcome, "not_executed"); assert.equal(log.length, 0);
 }
});

test("snapshots cannot cross agents or process restarts", async () => {
 const { desktop, log } = fakeDesktop(WINDOW); const a = tools(desktop), b = tools(desktop); const read = await observe(a);
 const args = { app: "Notes", snapshot: read.details?.snapshot, action: "press", id: "e4" };
 assert.equal((await b.screen_act!.execute(args, ctx())).details?.outcome, "not_executed");
 const app = (await desktop.apps())[0]!; (app as {instance:string}).instance = "new process";
 assert.equal((await a.screen_act!.execute(args, ctx())).details?.outcome, "not_executed"); assert.equal(log.length, 0);
});

test("explicit expected predicates confirm buttons; an absent expectation stays unconfirmed", async () => {
 const { desktop, root } = fakeDesktop(WINDOW), field = root()!.kidsList[0]!.kidsList[0]!;
 root()!.kidsList[0]!.kidsList[2]!.press = async () => { (field as {value:string}).value = "Saved"; };
 const t = tools(desktop, { apps: { Notes: "act" } });
 const sent = await act(t, { action: "press", id: "e4" });
 assert.equal(sent.details?.outcome, "unconfirmed");
 assert.equal(sent.ok, true, sent.modelContent);
 assert.match(sent.modelContent, /Sent\. The changes below are the result\./);
 (field as {value:string}).value = "Draft";
 assert.equal((await act(t, { action: "press", id: "e4", expect: { id: "e2", property: "value", value: "Saved" } })).details?.outcome, "confirmed");
});

function webClickFixture() {
 const fixture=fakeDesktop({role:"window",name:"Page",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"web_area",name:"Page",kids:[
  {role:"button",name:"Run",actions:["focus"],bounds:{x:20,y:20,width:100,height:30}},
  {role:"static_text",name:"Result",value:"Before"},
 ]}]});
 const web=fixture.root()!.kidsList[0]!,button=web.kidsList[0]!,output=web.kidsList[1]!;
 const t=tools(fixture.desktop,{apps:{Notes:"act"},cursor:false,settleMaxMs:25});
 const read=async()=>{
  const snapshot=await t.screen_read!.execute({app:"Notes",full:true},ctx()),id=/\b(e\d+) button "Run"/.exec(snapshot.modelContent)?.[1],resultId=/\b(e\d+) static_text "Result"/.exec(snapshot.modelContent)?.[1];
  assert.ok(id,snapshot.modelContent);assert.ok(resultId,snapshot.modelContent);
  return {app:"Notes",snapshot:snapshot.details.snapshot,action:"click",id,resultId};
 };
 return {...fixture,web,button,output,t,read};
}

for(const withExpectation of [false,true])test(`an unchanged background web click explicitly fails ${withExpectation?"with":"without"} an expectation`,async()=>{
 const {desktop,log,root,t,read}=webClickFixture(),args=await read();
 const pointer=desktop.pointer,children=root()!.children;let sent=false,readbacks=0;
 desktop.pointer=async(...input)=>{sent=true;await pointer(...input);};
 root()!.children=async()=>{if(sent)readbacks++;return children();};
 const r=await t.screen_act!.execute({...args,...(withExpectation?{expect:{id:args.resultId,property:"value",value:"After"}}:{})},ctx());
 assert.equal(r.ok,false,r.modelContent);assert.equal(r.details.outcome,"failed");assert.equal(r.details.error,"background_click_ineffective");
 assert.equal(r.details.dispatched,true);assert.equal(r.details.retryUnsafe,true);assert.ok(readbacks>=2,"no-effect classification requires repeated readable results");
 assert.match(r.modelContent,/No background click effect was observed/);assert.match(r.modelContent,/Do not automatically retry/);assert.match(r.modelContent,/web tool.*bring_to_front after authorization/);
 assert.equal(log.filter(line=>line.startsWith("pointer ")).length,1);assert.equal(log.some(line=>line.includes("activate")),false);
});

test("background web clicks keep observed changes and matching expectations",async()=>{
 for(const kind of ["changed","matched","unmet","already-matched","resized"]){
  const {desktop,button,output,t,read}=webClickFixture(),args=await read();
  desktop.pointer=async()=>{if(kind==="resized")Object.assign(button,{bounds:{...button.bounds!,width:120}});else if(kind!=="already-matched")Object.assign(output,{value:"After"});};
  const expected=kind==="matched"?"After":kind==="already-matched"?"Before":kind==="unmet"||kind==="resized"?"Other":undefined;
  const r=await t.screen_act!.execute({...args,...(expected?{expect:{id:args.resultId,property:"value",value:expected}}:{})},ctx());
  assert.equal(r.details.error,undefined,`${kind}: ${r.modelContent}`);assert.equal(r.details.outcome,kind==="matched"||kind==="already-matched"?"confirmed":"unconfirmed");
 }
});

test("a transient web result cannot be erased by a later unchanged read",async()=>{
 const {desktop,web,output,t,read}=webClickFixture(),args=await read(),children=web.children;let sent=false,reads=0;
 desktop.pointer=async()=>{sent=true;};
 web.children=async()=>{if(sent)Object.assign(output,{value:++reads===1?"Transient":"Before"});return children();};
 const r=await t.screen_act!.execute({...args,expect:{id:args.resultId,property:"value",value:"Wanted"}},ctx());
 assert.ok(reads>=2);assert.equal(r.details.observed,"Before");assert.equal(r.details.outcome,"unconfirmed");assert.equal(r.details.error,undefined,r.modelContent);
});

test("native, semantic and explicitly authorized foreground clicks retain their existing outcomes",async()=>{
 for(const kind of ["native","semantic","foreground"]){
  const {web,button,t,read}=webClickFixture();
  if(kind==="native")Object.assign(web,{role:"group"});
  if(kind==="semantic")Object.assign(button,{actions:["press"]});
  if(kind==="foreground")assert.equal((await act(t,{action:"bring_to_front"})).details.outcome,"confirmed");
  const args=await read(),r=await t.screen_act!.execute(args,ctx());
  assert.equal(r.details.outcome,"unconfirmed",`${kind}: ${r.modelContent}`);assert.equal(r.details.error,undefined);
  assert.equal(r.details.mode,kind==="foreground"?"foreground_authorized":"background");
 }
});

test("background web clicks preserve dispatch and foreground verification errors",async()=>{
 for(const kind of ["dispatch","foreground"]){
  const {desktop,t,read}=webClickFixture(),args=await read();
  if(kind==="dispatch")desktop.pointer=async()=>{throw new Error("pointer transport disconnected");};
  else {desktop.beginInput=async()=>{};desktop.endInput=async()=>({unchanged:false,frontChanged:true,focusChanged:false,reason:"independent foreground error"});}
  const r=await t.screen_act!.execute(args,ctx());
  assert.equal(r.details.outcome,"failed");assert.match(String(r.details.error),kind==="dispatch"?/pointer transport disconnected/:/independent foreground error/);
  assert.equal(r.details.dispatched,true);assert.equal(r.details.retryUnsafe,true);assert.equal(r.details.errorMessage,undefined);
 }
});

test("a cancelled background web click is not classified as an ineffective click",async()=>{
 const {desktop,t,read}=webClickFixture(),args=await read(),controller=new AbortController();
 desktop.pointer=async()=>{controller.abort(new Error("cancelled after dispatch"));};
 const r=await t.screen_act!.execute(args,{...ctx(),signal:controller.signal});
 assert.equal(r.details.dispatched,true);assert.equal(r.details.retryUnsafe,true);assert.equal(r.details.cancelled,true);
 assert.notEqual(r.details.error,"background_click_ineffective",r.modelContent);assert.equal(r.details.outcome,"unconfirmed");
});

test("unknown, incomplete and single-read web results are not called ineffective",async()=>{
 for(const kind of ["unknown","truncated","unreadable","single-read","region"]){
  const {desktop,root,t,read}=webClickFixture();let args=await read();
  if(kind==="truncated")desktop.pointer=async()=>{root()!.kidsList[0]!.children=async()=>{throw new Error("tree unavailable");};};
  if(kind==="unreadable")desktop.pointer=async()=>{(await desktop.apps())[0]!.windows=async()=>{throw new Error("window unavailable");};};
  const chosen=kind==="single-read"?tools(desktop,{apps:{Notes:"act"},cursor:false}):t;
  if(kind==="single-read"||kind==="region"){
   const snapshot=await chosen.screen_read!.execute({app:"Notes",...(kind==="region"?{region:{x:0,y:0,width:250,height:250}}:{})},ctx());
   args={...args,snapshot:snapshot.details.snapshot,id:/\b(e\d+) button "Run"/.exec(snapshot.modelContent)![1]!};
  }
  const r=await chosen.screen_act!.execute({...args,...(kind==="unknown"?{expect:{id:args.id,property:"expanded",value:true}}:{})},ctx());
  assert.notEqual(r.details.error,"background_click_ineffective",`${kind}: ${r.modelContent}`);assert.equal(r.details.outcome,kind==="unreadable"?"failed":"unconfirmed");
 }
});

test("new and replaced windows are effects of a background web click",async()=>{
 for(const replaced of [false,true]){
  const {desktop,root,log,t,read}=webClickFixture(),args=await read(),app=(await desktop.apps())[0]!;
  const opened=el({role:"window",name:"Opened",bounds:{x:600,y:0,width:300,height:200}},log);let sent=false;
  app.windows=async()=>sent?(replaced?[opened]:[root()!,opened]):[root()!];desktop.pointer=async()=>{sent=true;};
  const r=await t.screen_act!.execute({...args,expect:{id:args.resultId,property:"value",value:"After"}},ctx());
  assert.equal(r.details.outcome,"unconfirmed");assert.equal(r.details.error,undefined,r.modelContent);
  if(replaced)assert.match(r.modelContent,/closed or was replaced/);else assert.equal((r.details.openedWindows as string[]).length,1);
 }
});

test('native unknown state is never confirmed by null or by pretending it is false',async()=>{
 const {desktop,log}=fakeDesktop(WINDOW),t=tools(desktop,{cursor:false});
 for(const property of ['value','checked','expanded','focused','selected','exists']){
  log.length=0;
  const r=await act(t,{action:'press',id:'e4',expect:{id:'e4',property,value:null}});
  assert.equal(r.details.outcome,'not_executed',r.modelContent);assert.equal(r.details.dispatched,false);assert.deepEqual(log,[]);
 }
 for(const property of ['checked','expanded']){
  const r=await act(t,{action:'press',id:'e4',expect:{id:'e4',property,value:false}});
  assert.equal(r.details.outcome,'unconfirmed',r.modelContent);assert.equal(r.details.observed,null);
 }
 const empty=await act(t,{action:'set_value',id:'e2',text:'',expect:{id:'e2',property:'value',value:''}});
 assert.equal(empty.details.outcome,'confirmed',empty.modelContent);assert.equal(empty.details.observed,'');
});

for(const [before,after,wanted]of [['off','on',true],['on','off',false],['0','1',true],['true','false',false]] as const)test(`native checked ${after} confirms boolean ${wanted}`,async()=>{
 const {desktop,root}=fakeDesktop({role:'window',name:'Own',bounds:{x:0,y:0,width:300,height:200},kids:[{role:'check_box',name:'Complete',checked:before,actions:['toggle']}]});
 const box=root()!.kidsList[0]!;box.toggle=async()=>{Object.assign(box,{checked:after});};
 const result=await act(tools(desktop,{cursor:false}),{action:'toggle',id:'e2',expect:{id:'e2',property:'checked',value:wanted}});
 assert.equal(result.details.outcome,'confirmed',result.modelContent);assert.equal(result.details.observed,wanted);
});

test('a windowless menu stops on unreadable focus verification and blocks subsequent background input',async()=>{
 const {desktop,log}=fakeDesktop(WINDOW);desktop.apps=async()=>[{name:'Notes',pid:4242,isForeground:false,windows:async()=>[]}];
 desktop.beginInput=async()=>{};desktop.endInput=async()=>{throw new Error('focus helper disconnected');};
 const t=tools(desktop,{cursor:false}),args={app:'Notes',action:'menu',text:'File > Save'};
 const first=await t.screen_act!.execute(args,ctx()),second=await t.screen_act!.execute(args,ctx());
 assert.equal(first.details.outcome,'failed',first.modelContent);assert.equal((first.details.foreground as {unchanged:boolean}).unchanged,false);assert.match(String(first.details.error),/focus helper disconnected/);
 assert.equal(second.details.dispatched,false,second.modelContent);assert.deepEqual(log,['menu File > Save']);
});

test('a windowless menu cancelled during guard setup sends no menu and still ends its guard',async()=>{
 const {desktop,log}=fakeDesktop(WINDOW),controller=new AbortController();let ended=0;
 desktop.apps=async()=>[{name:'Notes',pid:4242,isForeground:false,windows:async()=>[]}];
 desktop.beginInput=async()=>{controller.abort(new Error('cancel guard setup'));};desktop.endInput=async()=>{ended++;return{unchanged:true};};
 const result=await tools(desktop,{cursor:false}).screen_act!.execute({app:'Notes',action:'menu',text:'File > Save'},{...ctx(),signal:controller.signal});
 assert.equal(result.details.outcome,'not_executed',result.modelContent);assert.equal(result.details.dispatched,false);assert.equal(result.details.cancelled,true);assert.equal(ended,1);assert.deepEqual(log,[]);
});

test('an inactive native dialog attempts addressed keyboard input and retained controls',async()=>{
 const {desktop,log,root}=fakeDesktop({...WINDOW,raw:{ax_subrole:'AXSystemDialog'}});
 desktop.menusMayTakeFocus=true;desktop.apps=async()=>[{name:'Notes',pid:4242,isForeground:false,windows:async()=>[root()!]}];
 desktop.beginInput=async()=>{log.push('guard start');};desktop.endInput=async()=>({unchanged:true});
 const t=tools(desktop,{cursor:false});
 const refused=await act(t,{action:'key',key:'Escape'});
 assert.equal(refused.details.dispatched,true,refused.modelContent);assert.deepEqual([...log],['guard start','key Escape in Note']);
 const value=await act(t,{action:'set_value',id:'e2',text:'own dialog filename'});assert.equal(value.details.outcome,'confirmed',value.modelContent);
 const pressed=await act(t,{action:'press',id:'e4'});assert.equal(pressed.details.dispatched,true,pressed.modelContent);assert.ok(log.includes('press Save'));
});

test("pixel input requires its image and refuses a window that changed under the target", async () => {
 const { desktop, log } = fakeDesktop(WINDOW), t = tools(desktop, { imageInput: true, apps: { Notes: "act" }, cursor: false });
 const read = await observe(t);
 assert.equal((await t.screen_act!.execute({ app: "Notes", snapshot: read.details?.snapshot, action: "click", x: 500, y: 400 }, ctx())).details?.outcome, "not_executed");
 const capture = desktop.captureWindow;
 // A pixel elsewhere (a caret, a clock) does not stop the click.
 let look = await t.screen_look!.execute({ app: "Notes" }, ctx());
 desktop.captureWindow = async (...args) => { const c = await capture(...args); c.pixels[0] = 90; return c; };
 assert.notEqual((await t.screen_act!.execute({ app: "Notes", snapshot: look.details?.snapshot, image: look.details?.image, action: "click", x: 500, y: 400 }, ctx())).details?.outcome, "not_executed");
 assert.equal(log.length, 1);
 // New content where the click would land does.
 desktop.captureWindow = capture;
 look = await t.screen_look!.execute({ app: "Notes" }, ctx());
 desktop.captureWindow = async (...args) => { const c = await capture(...args); c.pixels.fill(200); return c; };
 const r = await t.screen_act!.execute({ app: "Notes", snapshot: look.details?.snapshot, image: look.details?.image, action: "click", x: 500, y: 400 }, ctx());
 assert.equal(r.details?.outcome, "not_executed"); assert.match(String(r.details?.error), /look again/); assert.equal(log.length, 1);
});

test("click uses a retained semantic button; drag and other gestures target its exact window", async () => {
 const { desktop, log } = fakeDesktop(WINDOW), t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
 for (const args of [{action:"click",id:"e4"}, {action:"double_click",id:"e2"}, {action:"right_click",id:"e2"}, {action:"scroll",id:"e2",dy:3}, {action:"drag",id:"e2",to:"e4"}, {action:"key",key:"cmd+s"}]) {
  const r = await act(t,args); assert.equal(r.details?.dispatched,true,r.modelContent);
 }
 assert.deepEqual(log, ["press Save", "pointer click 210,132 left x2 in Note", "menu of Title", "pointer scroll 210,132 0,3 in Note", "pointer drag 210,132→440,374 in Note", "key Meta+s in Note"]);
});

test("password set_value executes but never appears in readback; background window focus still needs approval",async()=>{
 const {desktop,log,root}=fakeDesktop(WINDOW),t=tools(desktop,{apps:{Notes:"act"},cursor:false});
 const typed=await act(t,{action:"set_value",id:"e3",text:"own-test-secret"});
 assert.equal(typed.details?.dispatched,true,typed.modelContent);assert.equal(root()!.kidsList[0]!.kidsList[1]!.value,"own-test-secret");
 assert.doesNotMatch(JSON.stringify(typed),/own-test-secret/);
 assert.equal((await act(t,{action:"focus",id:"e1"})).details?.outcome,"not_executed");
 assert.deepEqual(log,["set Password=own-test-secret"]);
});
for(const scoped of [false,true])test(`no-id keys allow focused password without a complete tree scan (${scoped})`,async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW),t=tools(desktop,{apps:{Notes:"act"},cursor:false});
 desktop.menusMayTakeFocus=true;Object.assign(root()!.kidsList[0]!.kidsList[1]!,{focused:true});
 let read=await observe(t);if(scoped)read=await t.screen_read!.execute({app:"Notes",snapshot:read.details?.snapshot,scope:"e2"},ctx());
 const r=await t.screen_act!.execute({app:"Notes",snapshot:read.details?.snapshot,action:"key",key:"a"},ctx());
 assert.equal(r.details?.dispatched,true,r.modelContent);assert.deepEqual(log,["key a in Note"]);
});
test("known payment field still refuses direct native input",async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW);root()!.kidsList[0]!.kidsList[0]!.raw.isPayment=true;
 const r=await act(tools(desktop,{apps:{Notes:"act"},cursor:false}),{action:"set_value",id:"e2",text:"never"});
 assert.equal(r.details?.dispatched,false);assert.match(r.modelContent,/payment/);assert.deepEqual(log,[]);
});
test("a window with thousands of elements does not prevent a shortcut",async()=>{
 const {desktop,log}=fakeDesktop({...WINDOW,kids:Array.from({length:4500},(_,i)=>({role:"static_text",name:"Own file "+i}))});
 const r=await act(tools(desktop,{apps:{Notes:"act"},cursor:false}),{action:"key",key:"cmd+a"});
 assert.equal(r.details?.dispatched,true,r.modelContent);assert.deepEqual(log,["key Meta+a in Note"]);
});

test("formatted paste requests separate approval every time and preserves a user's newer clipboard", async () => {
 const { desktop, root, log } = fakeDesktop(WINDOW); (root()!.kidsList[0]!.kidsList[0] as {focused:boolean}).focused = true;
 desktop.clipboardRestore = async () => { log.push("new user copy kept"); return { restored: false, userChanged: true }; };
 const t = tools(desktop, { apps: { Notes: "act" }, cursor: false }), c = ctx();
 for (let i=0;i<2;i++) {
  const r = await act(t,{action:"paste",id:"e2",text:"**Title**",format:"md"},c);
  assert.deepEqual(r.details?.clipboard,{restored:false,userChanged:true});
 }
 assert.equal(c.asked.length,2); assert.match(log[0]!,/html.*<strong>Title<\/strong>/); assert.equal(log.filter(x=>x==="new user copy kept").length,2);
 const denied = await act(t,{action:"paste",id:"e2",text:"no"},ctx("deny")); assert.equal(denied.details?.dispatched,false);
});

test("focus failure blocks old receipts, allows explicit reread, then stops after three consecutive failures",async()=>{
 const {desktop,log}=fakeDesktop(WINDOW);desktop.beginInput=async()=>{};desktop.endInput=async()=>({unchanged:false,reason:"foreground changed"});
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});let read=await observe(t);const stale=read.details!.snapshot;
 for(let i=1;i<=3;i++){
  const failed=await t.screen_act!.execute({app:"Notes",snapshot:read.details!.snapshot,action:"set_value",id:"e2",text:String(i)},ctx());
  assert.equal(failed.details?.outcome,"failed",failed.modelContent);
  const blocked=await t.screen_act!.execute({app:"Notes",snapshot:failed.details!.snapshot,action:"set_value",id:"e2",text:"blocked"},ctx());
  assert.equal(blocked.details?.outcome,"not_executed");
  read=await observe(t);
  if(i===1){const old=await t.screen_act!.execute({app:"Notes",snapshot:stale,action:"set_value",id:"e2",text:"stale"},ctx());assert.equal(old.details?.dispatched,false);}
 }
 const blocked=await t.screen_act!.execute({app:"Notes",snapshot:read.details!.snapshot,action:"set_value",id:"e2",text:"four"},ctx());
 assert.equal(blocked.details?.outcome,"not_executed");assert.deepEqual(log,["set Title=1","set Title=2","set Title=3"]);
});

test("background input allows another app, stops for the user in the target, and disables the route when focus is stolen", async () => {
	async function run(ends: { unchanged: boolean; byUser?: boolean; reason?: string }[], text: string) {
		const { desktop, log } = fakeDesktop(WINDOW);
		let n = 0;
		desktop.beginInput = async () => {};
		desktop.endInput = async () => ends[Math.min(n++, ends.length - 1)]!;
		const t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
		const first = await act(t, { action: "set_value", id: "e2", text });
		const second = await act(t, { action: "set_value", id: "e2", text: `${text} again` });
		return { first, second, log };
	}
	const elsewhere = await run([{ unchanged: true }], "elsewhere");
	assert.equal(elsewhere.first.details?.outcome, "confirmed", elsewhere.first.modelContent);
	assert.equal(elsewhere.second.details?.outcome, "confirmed", elsewhere.second.modelContent);
	assert.deepEqual(elsewhere.log, ["set Title=elsewhere", "set Title=elsewhere again"]);
	const here = await run([
		{ unchanged: false, byUser: true, reason: userInterventionReason("Notes") },
		{ unchanged: true },
	], "here");
	assert.equal(here.first.details?.outcome, "failed", here.first.modelContent);
	assert.match(here.first.modelContent, /The user changed 'Notes'/);
	assert.match(here.first.modelContent, /Read the window again/);
	assert.equal(here.first.details?.foreground && (here.first.details.foreground as { byUser?: boolean }).byUser, true);
	assert.equal(here.second.details?.outcome, "confirmed", here.second.modelContent);
	assert.deepEqual(here.log, ["set Title=here", "set Title=here again"]);
	const stolen = await run([{ unchanged: false, byUser: false, reason: "foreground changed during background operation" }], "stolen");
	assert.equal(stolen.first.details?.outcome, "failed", stolen.first.modelContent);
	assert.match(stolen.first.modelContent, /foreground changed during background operation/);
	assert.equal(stolen.second.details?.outcome, "failed", stolen.second.modelContent);
	assert.deepEqual(stolen.log, ["set Title=stolen","set Title=stolen again"]);
	const keyboard = await run([{ unchanged: false, byUser: false, reason: "user keyboard target changed during background operation" }], "keyboard");
	assert.equal(keyboard.first.details?.outcome, "failed", keyboard.first.modelContent);
	assert.match(keyboard.first.modelContent, /user keyboard target changed/);
	assert.equal(keyboard.second.details?.outcome, "failed", keyboard.second.modelContent);
	assert.deepEqual(keyboard.log, ["set Title=keyboard","set Title=keyboard again"]);
});

test("a change the user made with their own input fails that step but keeps background input", async () => {
 const { desktop, log } = fakeDesktop(WINDOW); desktop.beginInput=async()=>{}; let byUser=true;
 desktop.endInput=async()=>byUser?{unchanged:false,byUser:true,reason:"you switched apps or typed while this action ran, so it stopped"}:{unchanged:true};
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});
 const first=await act(t,{action:"set_value",id:"e2",text:"one"});
 assert.equal(first.details?.outcome,"failed"); assert.match(first.modelContent,/you switched apps/);
 byUser=false;
 assert.equal((await act(t,{action:"set_value",id:"e2",text:"two"})).details?.outcome,"confirmed");
 assert.deepEqual(log,["set Title=one","set Title=two"]);
});

test("an unreadable window after dispatch is not fabricated into a successful close", async () => {
 const { desktop }=fakeDesktop(WINDOW,{closeOnPress:true}); const r=await act(tools(desktop,{apps:{Notes:"act"}}),{action:"press",id:"e4"});
 assert.equal(r.ok,false); assert.equal(r.details?.dispatched,true); assert.equal(r.details?.outcome,"failed");
});

test("large reads and searches provide continuation instead of claiming absent results", async () => {
 const { desktop }=fakeDesktop({role:"window",bounds:{x:0,y:0,width:500,height:500},kids:Array.from({length:4500},(_,i)=>({role:"static_text",value:`row ${i}`}))});
 const t=tools(desktop,{apps:{Notes:"read"}}); let r=await t.screen_read!.execute({app:"Notes",find:"row 4400"},ctx());
 assert.equal(r.details?.complete,false); assert.match(r.modelContent,/absence here does not prove absence/);
 assert.ok(r.details?.nextCursor); r=await t.screen_read!.execute({app:"Notes",cursor:r.details?.nextCursor},ctx());
 assert.match(r.modelContent,/row 4400/);
});

test("two agents serialize input and stale same-window handoffs are rejected", async () => {
 const { desktop, root, log }=fakeDesktop(WINDOW), a=tools(desktop,{apps:{Notes:"act"},cursor:false}), b=tools(desktop,{apps:{Notes:"act"},cursor:false});
 const ra=await observe(a), rb=await observe(b); const field=root()!.kidsList[0]!.kidsList[0]!; const write=field.setValue;
 field.setValue=async v=>{ await new Promise(r=>setTimeout(r,30)); await write(v); };
 const args=(r:Awaited<ReturnType<typeof observe>>,text:string)=>({app:"Notes",snapshot:r.details?.snapshot,action:"set_value",id:"e2",text});
 const [one,two]=await Promise.all([a.screen_act!.execute(args(ra,"A"),ctx()),b.screen_act!.execute(args(rb,"B"),ctx())]);
 assert.equal(one.details?.outcome,"confirmed");assert.equal(two.details?.outcome,"not_executed"); assert.deepEqual(log,["set Title=A"]);
 assert.equal((await act(b,{action:"set_value",id:"e2",text:"B"})).details?.outcome,"confirmed");
});

test("cancellation while waiting sends nothing; cancellation after dispatch still reads the real result", async () => {
 const {desktop,root,log}=fakeDesktop(WINDOW), t=tools(desktop,{apps:{Notes:"act"},cursor:false}), c=ctx(), abort=new AbortController(); c.signal=abort.signal;
 const field=root()!.kidsList[0]!.kidsList[0]!, write=field.setValue;
 field.setValue=async v=>{ await write(v); abort.abort(); };
 const r=await act(t,{action:"set_value",id:"e2",text:"written"},c);
 assert.equal(r.details?.cancelled,true); assert.equal(r.details?.observed,"written"); assert.equal(r.details?.outcome,"confirmed");
 const c2=ctx(), a2=new AbortController(); c2.signal=a2.signal;a2.abort();
 const r2=await t.screen_act!.execute({app:"Notes",snapshot:r.details?.snapshot,action:"set_value",id:"e2",text:"never"},c2);
 assert.equal(r2.details?.dispatched,false);assert.deepEqual(log,["set Title=written"]);
});

test("foreground cleanup errors retain the original cancelled input failure",async()=>{
	const {desktop,root}=fakeDesktop(WINDOW),stop=new AbortController(),context={...ctx(),signal:stop.signal};
	desktop.beginInput=async()=>{};
	desktop.endInput=async()=>{throw new Error("original input guard unavailable");};
	root()!.kidsList[0]!.kidsList[0]!.setValue=async()=>{stop.abort(new Error("cancelled after dispatch"));throw new Error("input controller closed after down");};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),result=await act(t,{action:"set_value",id:"e2",text:"own test"},context);
	assert.equal(result.ok,false);assert.equal(result.details?.outcome,"failed");assert.equal(result.details?.cancelled,true);
	assert.match(String(result.details?.error),/input controller closed after down/);assert.match(String(result.details?.error),/could not verify foreground: original input guard unavailable/);
});

for(const final of ["violation","unverified"])test(`a completed tool keeps its real observation after final helper cleanup is ${final}`,async()=>{
	const {desktop,root}=fakeDesktop(WINDOW),coordinator=new InputCoordinator();let finalCalls=0,closed=0;
	desktop.beginInput=async()=>{currentInput()!.attachInputHelper({cancelLocal:async()=>{},finishAfterDrain:async()=>{finalCalls++;if(final==="unverified")throw new Error("owned cleanup receipt missing");return {violation:"user changed target; read its window again"};},closeUnverified:async()=>{closed++;}});};
	desktop.endInput=async()=>({unchanged:true});
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false,coordinator}),out=await act(t,{action:"set_value",id:"e2",text:"own completed result"});
	assert.equal(out.ok,false);assert.equal(out.details?.outcome,"failed");assert.equal(out.details?.dispatched,true);assert.equal(out.details?.retryUnsafe,true);
	assert.equal(out.details?.observed,"own completed result");assert.ok(out.details?.snapshot);assert.match(out.modelContent,/own completed result/);
	assert.equal(root()!.kidsList[0]!.kidsList[0]!.value,"own completed result");assert.equal(finalCalls,1);assert.equal(closed,final==="unverified"?1:0);
	assert.match(String(out.details?.error),final==="unverified"?/input helper termination could not be verified/:/read its window again/);
});

for(const cleanup of ["throw","unknown"])test(`a windowless menu retains its primary cancellation when cleanup returns ${cleanup}`,async()=>{
	const {desktop}=fakeDesktop(WINDOW),stop=new AbortController();desktop.apps=async()=>[{name:"Notes",pid:4242,isForeground:true,windows:async()=>[]}];
	desktop.beginInput=async()=>{};desktop.pressMenu=async()=>{stop.abort();throw new Error("primary menu input cancelled");};
	desktop.endInput=async()=>{if(cleanup==="throw")throw new Error("secondary guard missing");return {unchanged:false,attributionUnknown:true,reason:"secondary guard missing"};};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false,settleMs:0}),out=await t.screen_act!.execute({app:"Notes",action:"menu",text:"File > Save"},{...ctx(),signal:stop.signal});
	assert.equal(out.ok,false);assert.equal(out.details?.cancelled,true);assert.match(String(out.details?.error),/primary menu input cancelled/);assert.match(String(out.details?.error),/secondary guard missing/);
});

test("a failed revision publication cannot erase input and focus cleanup failures",async()=>{
	class FailedPublish extends InputCoordinator{count=0;override async changed(key:string){if(++this.count===2)throw new Error("third revision disk full");await super.changed(key);}}
	const {desktop,root}=fakeDesktop(WINDOW),stop=new AbortController();desktop.beginInput=async()=>{};desktop.endInput=async()=>{throw new Error("secondary guard missing");};
	root()!.kidsList[0]!.kidsList[0]!.setValue=async()=>{stop.abort();throw new Error("primary input cancelled");};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false,coordinator:new FailedPublish()}),out=await act(t,{action:"set_value",id:"e2",text:"own test"},{...ctx(),signal:stop.signal});
	assert.equal(out.ok,false);assert.equal(out.details?.cancelled,true);
	for(const text of ["primary input cancelled","secondary guard missing","third revision disk full"])assert.ok(String(out.details?.error).includes(text));
});

for(const cleanup of ["throw","unknown"])test(`a failed menu read never invokes focus-writing cleanup (${cleanup})`,async()=>{
 const {desktop}=fakeDesktop(WINDOW);let guards=0,cleanups=0;
 desktop.beginInput=async()=>{guards++;};desktop.menus=async()=>{throw new Error("primary menu read cancelled");};
 desktop.endInput=async()=>{cleanups++;if(cleanup==="throw")throw new Error("secondary read guard missing");return {unchanged:false,attributionUnknown:true,reason:"secondary read guard missing"};};
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),out=await t.screen_read!.execute({app:"Notes",menus:true},ctx());
 assert.equal(out.ok,false);assert.match(out.modelContent,/primary menu read cancelled/);assert.doesNotMatch(out.modelContent,/secondary read guard/);
 assert.equal(out.details?.dispatched,false);assert.equal(guards,0);assert.equal(cleanups,0);
});

for(const cleanup of ["throw","unknown"])test(`failed app startup retains its original failure when cleanup returns ${cleanup}`,async()=>{
	const {desktop}=fakeDesktop(WINDOW);desktop.apps=async()=>[];desktop.beginInput=async()=>{};desktop.launch=async()=>{throw new Error("primary startup cancelled");};
	desktop.endInput=async()=>{if(cleanup==="throw")throw new Error("secondary startup guard missing");return {unchanged:false,attributionUnknown:true,reason:"secondary startup guard missing"};};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),out=await t.screen_read!.execute({app:"Notes"},ctx());
	assert.equal(out.ok,false);assert.match(out.modelContent,/primary startup cancelled/);assert.match(out.modelContent,/secondary startup guard missing/);
	assert.equal(out.details?.dispatched,true);
});

test("the skill exposes images only to image-capable models and teaches explicit receipts",()=>{
 const plain=computerUseSkill(),visual=computerUseSkill({imageInput:true});
 assert.deepEqual(plain.tools?.map(t=>t.name),["screen_read","screen_act","web_read","web_act"]);
 assert.ok(visual.tools?.some(t=>t.name==="screen_look"));assert.ok(visual.tools?.some(t=>t.name==="web_look"));
 assert.match(visual.body,/snapshot/);assert.match(visual.body,/unconfirmed/);assert.match(visual.body,/Safari/);
 assert.match(plain.body,/verification codes or API keys/);
 assert.match(visual.body,/Human chat is authorization/);
 assert.match(plain.body,/final password-change step/);assert.match(plain.body,/After conversation compaction/);
 assert.match(plain.body,/command, file, API, or script/);
 assert.match(plain.body,/no such interface/);
 assert.match(plain.body,/unless the user specifically asks/);
 assert.match(plain.body,/steps \(up to 12\)/);
 assert.match(plain.body,/do not read again/);
 assert.match(plain.body,/pass full/);
 assert.match(plain.body,/Do not end the turn/);
 assert.equal(userInterventionReason("Notes"), "The user changed 'Notes'. Read the window again before sending more actions.");
});

test("scoped reads retain original paths when confirming an edit", async () => {
 const {desktop}=fakeDesktop(WINDOW),t=tools(desktop,{apps:{Notes:'act'},cursor:false});const first=await observe(t);
 const scoped=await t.screen_read!.execute({app:'Notes',snapshot:first.details?.snapshot,scope:'e2'},ctx());assert.equal(scoped.ok,true,scoped.modelContent);
 const result=await t.screen_act!.execute({app:'Notes',snapshot:scoped.details?.snapshot,action:'set_value',id:'e2',text:'Scoped'},ctx());assert.equal(result.details?.outcome,'confirmed',result.modelContent);
});

test("only an observed focused editable field needs a native typing binding", async () => {
	const { desktop, root } = fakeDesktop(WINDOW);
	const title = root()!.kidsList[0]!.kidsList[0]!;
	(title as { focused: boolean }).focused = true;
	let retained: UiElement[] = [];
	desktop.retainTextReceivers = async (_app, _window, fields) => { retained = fields; };
	await observe(tools(desktop, { apps: { Notes: "act" }, cursor: false }));
	assert.deepEqual(retained, [title]);
});

test("whole-field text can be continued without claiming a truncated value is complete",async()=>{
 const value='x'.repeat(40000)+'last page';const {desktop}=fakeDesktop({role:'window',bounds:{x:0,y:0,width:100,height:100},kids:[{role:'text_field',value,actions:['set_value']}]});const t=tools(desktop,{apps:{Notes:'read'}});const first=await observe(t);
 const text=await t.screen_read!.execute({app:'Notes',snapshot:first.details?.snapshot,id:'e2'},ctx());assert.equal(text.details?.complete,false);assert.equal(text.details?.offset,0);
 const next=await t.screen_read!.execute({app:'Notes',cursor:text.details?.nextCursor},ctx());assert.equal(next.details?.complete,true);assert.equal(next.details?.offset,40000);assert.match(next.modelContent,/last page/);
 for(const read of [first,text,next]){assert.equal(read.details?.app,'Notes');assert.equal(read.details?.pid,(await desktop.apps())[0]!.pid);}
});

test("new dialogs invalidate an earlier window observation",async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW),t=tools(desktop,{apps:{Notes:'act'}}),first=await observe(t);const app=(await desktop.apps())[0]!;
 app.windows=async()=>[root()!,el({role:'window',name:'Modal',bounds:{x:1,y:1,width:50,height:50}},log)];
 const result=await t.screen_act!.execute({app:'Notes',snapshot:first.details?.snapshot,action:'press',id:'e4'},ctx());assert.equal(result.details?.outcome,'not_executed');assert.deepEqual(log,[]);
});

test("two prepared windows in one app have independent mutation revisions",async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!,other=el({...WINDOW,name:'Other'},log);app.windows=async()=>[root()!,other];
 const a=tools(desktop,{apps:{Notes:'act'},cursor:false}),b=tools(desktop,{apps:{Notes:'act'},cursor:false});
 const list=await a.screen_read!.execute({app:'Notes'},ctx()),windows=list.details?.windows as {window:string}[];
 const ra=await observe(a,ctx(),windows[0]!.window),rb=await observe(b,ctx(),windows[1]!.window);
 const args=(r:Awaited<ReturnType<typeof observe>>,text:string)=>({app:'Notes',snapshot:r.details?.snapshot,action:'set_value',id:'e2',text});
 const results=await Promise.all([a.screen_act!.execute(args(ra,'A'),ctx()),b.screen_act!.execute(args(rb,'B'),ctx())]);assert.ok(results.every(r=>r.details?.outcome==='confirmed'));
 assert.equal(root()!.kidsList[0]!.kidsList[0]!.value,'A');assert.equal(other.kidsList[0]!.kidsList[0]!.value,'B');
});

test("foreground escape asks explicitly and grants only the selected front window",async()=>{
 const {desktop,log}=fakeDesktop(WINDOW);let guards=0;desktop.beginInput=async()=>{guards++};desktop.endInput=async()=>({unchanged:true});
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),c=ctx();
 const bring=await act(t,{action:'bring_to_front'},c);assert.equal(bring.details?.outcome,'confirmed',bring.modelContent);assert.equal(c.asked.length,1);
 const edit=await act(t,{action:'set_value',id:'e2',text:'Authorized front'},c);assert.equal(edit.details?.mode,'foreground_authorized');assert.equal(guards,0);
 const app=(await desktop.apps())[0]!;(app as {isForeground:boolean}).isForeground=false;
 const background=await act(t,{action:'set_value',id:'e2',text:'Background again'},c);assert.equal(background.details?.mode,'background');assert.equal(guards,1);
 assert.ok(log.includes('perform activate on Note'));
});

test("executable and bundle aliases resolve an already-running localized application without launching",async()=>{
 const {desktop,log}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!;
 Object.assign(app,{name:'本地化名称',bundleId:'dev.example.notes',executableName:'NotesBinary'});
 const t=tools(desktop,{apps:{'*':'read'}});
 for(const name of ['NotesBinary','dev.example.notes'])assert.equal((await t.screen_read!.execute({app:name},ctx())).ok,true);
 assert.deepEqual(log,[]);
});

test("a read taken during another agents mutation cannot authorize the handoff", async () => {
 const {desktop,root}=fakeDesktop(WINDOW),button=root()!.kidsList[0]!.kidsList[2]!;
 let release!:()=>void,started!:()=>void,calls=0;
 const pending=new Promise<void>(r=>{release=r}),entered=new Promise<void>(r=>{started=r});
 button.press=async()=>{calls++;started();await pending;};
 const a=tools(desktop,{apps:{Notes:"act"},cursor:false}),b=tools(desktop,{apps:{Notes:"act"},cursor:false});
 const running=act(a,{action:"press",id:"e4"});await entered;
 const midway=await observe(b);release();const finished=await running;
 const stale=await b.screen_act!.execute({app:"Notes",snapshot:midway.details?.snapshot,action:"press",id:"e4"},ctx());
 assert.equal(stale.details?.outcome,"not_executed");assert.equal(calls,1);
 const continued=await a.screen_act!.execute({app:"Notes",snapshot:finished.details?.snapshot,action:"press",id:"e4"},ctx());
 assert.equal(continued.details?.dispatched,true);assert.equal(calls,2);
});

test("attached AppKit sheets are exact independent keyboard targets", async () => {
 const {desktop,root,log}=fakeDesktop({role:'window',name:'Parent',bounds:{x:0,y:0,width:800,height:600}});
 const t=tools(desktop);
 const old=await t.screen_read!.execute({app:'Notes'},ctx());
 root()!.kidsList.push(el({role:'dialog',name:'Open',raw:{ax_role:'AXSheet'},bounds:{x:100,y:100,width:500,height:300}},log));
 const stale=await t.screen_act!.execute({app:'Notes',snapshot:old.details?.snapshot,action:'key',key:'Return'},ctx());
 assert.equal(stale.details?.outcome,'not_executed');assert.equal(log.length,0);
 const listed=await t.screen_read!.execute({app:'Notes'},ctx());
 const sheet=(listed.details?.windows as {window:string;title:string}[]).find(w=>w.title==='Open');assert.ok(sheet);
 const read=await t.screen_read!.execute({app:'Notes',window:sheet.window},ctx());assert.equal(read.ok,true);
 await t.screen_act!.execute({app:'Notes',snapshot:read.details?.snapshot,action:'key',key:'cmd+shift+g'},ctx());
 assert.ok(log.includes('key Meta+Shift+g in Open'));
});

test("system keyboard delivery requires an explicitly granted foreground window",async()=>{
 const {desktop}=fakeDesktop(WINDOW),routes:boolean[]=[];
 desktop.key=async(_app,_window,_key,_held,foreground)=>{routes.push(foreground===true)};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),c=ctx();
 await act(t,{action:'key',key:'Return'},c);
 await act(t,{action:'bring_to_front'},c);
 await act(t,{action:'key',key:'Return'},c);
 const app=(await desktop.apps())[0]!;(app as {isForeground:boolean}).isForeground=false;
 await act(t,{action:'key',key:'Return'},c);
 (app as {isForeground:boolean}).isForeground=true;
 await act(t,{action:'key',key:'Return'},c);
 assert.deepEqual(routes,[false,true,false,false]);
 assert.equal(c.asked.length,1);
});

test("foreground text requires a current grant and an editable focused receiver",async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW),routes:boolean[]=[];
 desktop.text=async(_app,_window,_receiver,_text,_range,foreground)=>{routes.push(foreground===true)};
 const field=root()!.kidsList[0]!.kidsList[0]!;
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),c=ctx();
 await act(t,{action:'type',id:'e2',text:'background'},c);
 assert.ok(log.includes('type Title:background'));assert.deepEqual(routes,[]);
 await act(t,{action:'bring_to_front'},c);
 const unfocused=await act(t,{action:'type',id:'e2',text:'wrong'},c);
 assert.notEqual(unfocused.details?.outcome,'confirmed');assert.deepEqual(routes,[]);
 (field as {focused:boolean}).focused=true;
 await act(t,{action:'type',id:'e2',text:'你好 🌍'},c);
 assert.deepEqual(routes,[true]);
 (field as {editable:boolean}).editable=false;
 await act(t,{action:'type',id:'e2',text:'readonly'},c);assert.deepEqual(routes,[true]);
 (field as {editable:boolean}).editable=true;
 const app=(await desktop.apps())[0]!;(app as {isForeground:boolean}).isForeground=false;
 await act(t,{action:'type',id:'e2',text:'after focus left'},c);
 (app as {isForeground:boolean}).isForeground=true;
 await act(t,{action:'type',id:'e2',text:'after return'},c);
 assert.deepEqual(routes,[true]);assert.equal(c.asked.length,1);
});

test("an observed switch to another window revokes foreground keyboard permission",async()=>{
 const {desktop,root}=fakeDesktop(WINDOW),routes:boolean[]=[];
 desktop.key=async(_app,_window,_key,_held,foreground)=>{routes.push(foreground===true)};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),c=ctx();
 await act(t,{action:'bring_to_front'},c);
 (root()! as {active:boolean}).active=false;
 await act(t,{action:'key',key:'Return'},c);
 (root()! as {active:boolean}).active=true;
 await act(t,{action:'key',key:'Return'},c);
 assert.deepEqual(routes,[false,false]);assert.equal(c.asked.length,1);
});

test("an authorized foreground paste retains separate clipboard approval",async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW),routes:boolean[]=[];
 const field=root()!.kidsList[0]!.kidsList[0]!;(field as {focused:boolean}).focused=true;
 desktop.key=async(_app,_window,_key,_held,foreground)=>{routes.push(foreground===true);(field as {value:string}).value='Pasted';};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),c=ctx();
 await act(t,{action:'bring_to_front'},c);
 await act(t,{action:'paste',id:'e2',text:'Pasted',format:'text'},c);
 assert.deepEqual(routes,[true]);assert.equal(c.asked.length,2);
 assert.ok(log.includes('clipboard restored'));
});

test("real-pointer drag needs its own approval and a live foreground grant",async()=>{
 const {desktop}=fakeDesktop(WINDOW),routes:boolean[]=[];
 desktop.pointer=async(_app,_window,_gesture,real)=>{routes.push(real===true)};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),c=ctx();
 const drag={action:'drag',id:'e2',to:'e4'};
 await act(t,drag,c);assert.deepEqual(routes,[false]);
 const noGrant=await act(t,{...drag,allow_real_pointer:true},c);
 assert.equal(noGrant.details?.outcome,'not_executed');assert.deepEqual(routes,[false]);
 await act(t,{action:'bring_to_front'},c);
 await act(t,drag,c);assert.deepEqual(routes,[false,false]);
 const denied=await act(t,{...drag,allow_real_pointer:true},ctx('deny'));
 assert.equal(denied.details?.outcome,'not_executed');assert.deepEqual(routes,[false,false]);
 const count=c.asked.length,real=await act(t,{...drag,allow_real_pointer:true},c);
 assert.deepEqual(routes,[false,false,true]);assert.equal(c.asked.length,count+1);
 assert.equal(real.details?.pointerMode,'real_pointer');assert.equal(real.details?.mode,'foreground_authorized');
 const app=(await desktop.apps())[0]!;(app as {isForeground:boolean}).isForeground=false;
 const lost=await act(t,{...drag,allow_real_pointer:true},c);assert.equal(lost.details?.outcome,'not_executed');
 (app as {isForeground:boolean}).isForeground=true;
 const returned=await act(t,{...drag,allow_real_pointer:true},c);assert.equal(returned.details?.outcome,'not_executed');
 const wrongAction=await act(t,{action:'click',id:'e2',allow_real_pointer:true},c);assert.equal(wrongAction.details?.outcome,'not_executed');
 assert.deepEqual(routes,[false,false,true]);
});

test("foreground activation waits for the requested window to actually become frontmost",async()=>{
 const {desktop,root}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!;
 (app as {isForeground:boolean}).isForeground=false;
 root()!.performAction=async()=>{setTimeout(()=>{(app as {isForeground:boolean}).isForeground=true},25)};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false,settleMs:5,settleMaxMs:200});
 const result=await act(t,{action:'bring_to_front'},ctx());assert.equal(result.details?.outcome,'confirmed');
 assert.deepEqual(result.details?.observed,{foreground:true,activeWindow:result.details?.window});
});

test("a sheet is read on its own, and the window's foreground grant carries over to it",async()=>{
 const {desktop,root,log}=fakeDesktop({role:'window',name:'Parent',bounds:{x:0,y:0,width:800,height:600},kids:[{role:'button',name:'Behind',actions:['press'],bounds:{x:10,y:10,width:60,height:20}}]});
 const routes:boolean[]=[];desktop.key=async(_app,window,key,_held,foreground)=>{routes.push(foreground===true);log.push(`key ${key} in ${window.name}`);};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),c=ctx();
 assert.equal((await act(t,{action:'bring_to_front'},c)).details?.outcome,'confirmed');
 const sheet=el({role:'dialog',name:'Open',raw:{ax_role:'AXSheet'},bounds:{x:100,y:100,width:500,height:300},kids:[{role:'button',name:'Import',actions:['press'],bounds:{x:400,y:350,width:60,height:20}}]},log);
 (sheet as {active:boolean}).active=true;(root()! as {active:boolean}).active=false;root()!.kidsList.push(sheet);
 const listed=await t.screen_read!.execute({app:'Notes'},c);
 const handle=(listed.details?.windows as {window:string;title:string}[]).find(w=>w.title==='Open')!.window,parent=(listed.details?.windows as {window:string;title:string}[]).find(w=>w.title==='Parent')!.window;
 const main=await observe(t,c,parent);
 assert.match(main.modelContent,new RegExp(`dialog is open on this window \\(${handle}\\)`));assert.doesNotMatch(main.modelContent,/Import/);
 const read=await observe(t,c,handle);assert.match(read.modelContent,/Import/);
 await t.screen_act!.execute({app:'Notes',snapshot:read.details?.snapshot,action:'key',key:'Return'},c);
 assert.deepEqual(routes,[true]);assert.equal(c.asked.length,1);assert.ok(log.includes('key Enter in Open'));
});

test("an action another process may have carried out is reported unconfirmed, not failed",async()=>{
 const {desktop,root}=fakeDesktop({role:'window',name:'Open',bounds:{x:0,y:0,width:600,height:400},kids:[{role:'cell',name:'clip.mp4',actions:['open'],bounds:{x:10,y:10,width:200,height:20}}]});
 root()!.kidsList[0]!.performAction=async()=>{throw new Error("Platform error (-25204): AXOpen");};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false});const read=await observe(t);
 const r=await t.screen_act!.execute({app:'Notes',snapshot:read.details?.snapshot,action:'perform',id:read.modelContent.match(/(e\d+) cell/)![1],text:'open'},ctx());
 assert.equal(r.details?.outcome,'unconfirmed',r.modelContent);assert.equal(r.details?.dispatched,true);assert.match(r.modelContent,/may still have run/);
});

test("an unsupported accessibility attribute is reported as a failure",async()=>{
 const {desktop,root}=fakeDesktop({role:'window',name:'Open',bounds:{x:0,y:0,width:600,height:400},kids:[{role:'cell',name:'clip.mp4',actions:['open'],bounds:{x:10,y:10,width:200,height:20}}]});
 root()!.kidsList[0]!.performAction=async()=>{throw new Error("Platform error (-25205): AXOpen");};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false});const read=await observe(t);
 const r=await t.screen_act!.execute({app:'Notes',snapshot:read.details?.snapshot,action:'perform',id:read.modelContent.match(/(e\d+) cell/)![1],text:'open'},ctx());
 assert.equal(r.ok,false,r.modelContent);assert.match(r.modelContent,/-25205/);assert.doesNotMatch(r.modelContent,/may still have run/);
});

test("typing where the keyboard is needs an app brought to the front",async()=>{
 const {desktop}=fakeDesktop(WINDOW),typed:string[]=[];desktop.typeAtFocus=async(_app,_window,text)=>{typed.push(text);};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),c=ctx();
 assert.equal((await act(t,{action:'type',text:'Mountains 验收'},c)).details?.outcome,'not_executed');
 await act(t,{action:'bring_to_front'},c);
 assert.notEqual((await act(t,{action:'type',text:'Mountains 验收'},c)).details?.outcome,'not_executed');
 assert.deepEqual(typed,['Mountains 验收']);
});

test("a disabled menu command is marked, and a disabled press is not success", async () => {
	const { desktop } = fakeDesktop(WINDOW);
	const t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
	const menus = await t.screen_read!.execute({ app: "Notes", menus: true }, ctx());
	assert.match(menus.modelContent, /Edit > Undo \(⌘Z\) \[disabled\]/);
	assert.match(menus.modelContent, /File > Save \(⌘S\)/);
	assert.doesNotMatch(menus.modelContent, /Save \(⌘S\) \[disabled\]/);
	assert.equal(menuPressFailure(false, "Edit > Delete"), "menu command is disabled: \"Edit > Delete\"");
	assert.match(menuPressFailure(null, "Edit > Delete") ?? "", /no menu command/);
	assert.match(menuPressFailure(-25206, "Edit > Delete") ?? "", /accessibility error -25206/);
	assert.equal(menuPressFailure(0, "File > Save"), undefined);
});

test("an app with no window open takes app-wide menu commands without a snapshot",async()=>{
 const {desktop,log}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!,t=tools(desktop,{apps:{Notes:'act'},cursor:false});
 const withWindow=await t.screen_act!.execute({app:'Notes',action:'menu',text:'File > New Window'},ctx());
 assert.equal(withWindow.details?.outcome,'not_executed');assert.match(withWindow.modelContent,/snapshot is required/);
 app.windows=async()=>[];
 const r=await t.screen_act!.execute({app:'Notes',action:'menu',text:'File > Save'},ctx());
 assert.equal(r.details?.outcome,'unconfirmed',r.modelContent);assert.ok(log.includes('menu File > Save'));
});

test("a window menu uses the latest read when snapshot is omitted", async () => {
	const { desktop, log } = fakeDesktop(WINDOW);
	const t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
	await t.screen_read!.execute({ app: "Notes" }, ctx());
	const result = await t.screen_act!.execute({ app: "Notes", action: "menu", text: "File > Save" }, ctx());
	assert.notEqual(result.details?.outcome, "not_executed", result.modelContent);
	assert.deepEqual(log.filter(line => line.startsWith("menu ")), ["menu File > Save"]);
});

test("computer use is agreed to once per conversation; the front and the clipboard still ask each time",async()=>{
 const {desktop}=fakeDesktop(WINDOW),consent={granted:false},c=ctx();
 const lead=tools(desktop,{cursor:false,consent}),member=tools(desktop,{cursor:false,consent});
 await act(lead,{action:'set_value',id:'e2',text:'one'},c);
 await act(member,{action:'set_value',id:'e2',text:'two'},c);
 assert.deepEqual(c.asked.map(r=>r.command),["Use computer use in this conversation"]);
 await act(lead,{action:'bring_to_front'},c);
 await act(lead,{action:'bring_to_front'},c);
 assert.equal(c.asked.length,3);
 const refused=await tools(desktop,{cursor:false}).screen_read!.execute({app:'Notes'},ctx('deny'));
 assert.equal(refused.ok,false);assert.match(refused.modelContent,/not agreed to/);
});

test("a batch of set_value and press runs both steps and reports the last snapshot", async () => {
	const { desktop, log } = fakeDesktop(WINDOW), t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
	const read = await observe(t);
	const r = await t.screen_act!.execute({ app: "Notes", snapshot: read.details?.snapshot, steps: [{ action: "set_value", id: "e2", text: "Final" }, { action: "press", id: "e4" }] }, ctx());
	const steps = r.details?.steps as { action: string; outcome: string; snapshot?: string }[];
	assert.equal(r.ok, false, r.modelContent);
	assert.deepEqual(steps.map(step => step.outcome), ["confirmed", "unconfirmed"]);
	assert.deepEqual(steps.map(step => step.action), ["set_value", "press"]);
	assert.deepEqual((r.details.steps as {pid:number}[]).map(step=>step.pid),[4242,4242]);
	assert.deepEqual(r.details.targetPids,[4242]);
	assert.equal(r.details?.outcome, "unconfirmed");
	assert.equal(r.details?.snapshot, steps[1]?.snapshot);
	assert.notEqual(r.details?.snapshot, read.details?.snapshot);
	assert.equal(r.details?.app, "Notes");
	assert.equal(typeof r.details?.window, "string");
	assert.equal(r.details?.dispatched, true);
	assert.equal(r.details?.retryUnsafe, true);
	assert.equal(r.details?.stoppedAt, undefined);
	assert.deepEqual(log, ["set Title=Final", "press Save"]);
	assert.match(r.modelContent, /^1\. set_value e2 → confirmed\n2\. press e4 → unconfirmed\n~ e2 text_field "Title" = "Final" \{set_value\}\n\[Notes, window w:[^,]+, snapshot s:[^.]+\. Element numbers not listed as changed still hold\.\]$/);
	assert.match(r.modelContent, new RegExp(`snapshot ${r.details?.snapshot}`));
	assert.doesNotMatch(r.modelContent, /Stopped at|No visible change/);
});

test("each batch step and the whole call retain the helper's selected remote PIDs",async()=>{
	const {desktop}=fakeDesktop(WINDOW);let n=0;
	desktop.beginInput=async()=>{};desktop.endInput=async()=>({unchanged:true,inputTargetPids:[++n===1?8181:8282],inputRoutesComplete:true});
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t);
	const r=await t.screen_act!.execute({app:"Notes",snapshot:read.details.snapshot,steps:[{action:"set_value",id:"e2",text:"Own"},{action:"press",id:"e4"}]},ctx());
	assert.deepEqual(r.details.inputTargetPids,[8181,8282]);
	assert.deepEqual((r.details.steps as {inputTargetPids:number[]}[]).map(step=>step.inputTargetPids),[[8181],[8282]]);
});

test("a batch stops at a failing step and does not run the rest", async () => {
	const { desktop, log } = fakeDesktop(WINDOW), t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
	const read = await observe(t);
	const r = await t.screen_act!.execute({ app: "Notes", snapshot: read.details?.snapshot, steps: [{ action: "set_value", id: "e2", text: "Final" }, { action: "press", id: "e99" }, { action: "press", id: "e4" }] }, ctx());
	const steps = r.details?.steps as { action: string; outcome: string; error?: string; snapshot?: string }[];
	assert.equal(r.ok, false);
	assert.deepEqual(log, ["set Title=Final"]);
	assert.equal(steps.length, 2);
	assert.deepEqual(steps.map(step => step.outcome), ["confirmed", "not_executed"]);
	assert.match(steps[1]?.error ?? "", /absent from this snapshot/);
	assert.equal(r.details?.outcome, "not_executed");
	assert.equal(r.details?.stoppedAt, 2);
	assert.equal(r.details?.snapshot, steps[0]?.snapshot);
	assert.equal(r.details?.dispatched, true);
	assert.match(r.modelContent, /1\. set_value e2 → confirmed\n2\. press e99 → not_executed: element id is absent from this snapshot\nStopped at step 2; steps 3\.\. were not run\./);
	assert.doesNotMatch(r.modelContent, /3\. press/);
});

test("action together with steps is refused before anything runs", async () => {
	const { desktop, log } = fakeDesktop(WINDOW), t = tools(desktop, { apps: { Notes: "act" }, cursor: false });
	const read = await observe(t);
	const apps = desktop.apps.bind(desktop);
	desktop.apps = async () => { log.push("apps"); return apps(); };
	const r = await t.screen_act!.execute({ app: "Notes", snapshot: read.details?.snapshot, action: "press", id: "e4", steps: [{ action: "press", id: "e4" }] }, ctx());
	assert.equal(r.ok, false);
	assert.equal(r.details?.outcome, "not_executed");
	assert.equal(r.details?.dispatched, false);
	assert.deepEqual(log, []);
	assert.match(r.modelContent, /give either action or steps, not both/);
	assert.equal(r.details?.steps, undefined);
});

test("a later pixel step uses the image the previous step returned", async () => {
	const { desktop, log } = fakeDesktop(WINDOW), t = tools(desktop, { imageInput: true, apps: { Notes: "act" }, cursor: false });
	const look = await t.screen_look!.execute({ app: "Notes" }, ctx());
	const r = await t.screen_act!.execute({ app: "Notes", snapshot: look.details?.snapshot, image: look.details?.image, steps: [{ action: "click", x: 20, y: 20 }, { action: "click", x: 24, y: 24 }] }, ctx());
	const steps = r.details?.steps as { outcome: string }[];
	assert.equal(steps.length, 2, r.modelContent);
	assert.deepEqual(steps.map(step => step.outcome), ["unconfirmed", "unconfirmed"], r.modelContent);
	assert.equal(log.length, 2, log.join("\n"));
	assert.equal(typeof r.details?.image, "string");
	assert.notEqual(r.details?.image, look.details?.image);
	assert.ok(r.images?.length);
	assert.match(r.modelContent, /^1\. click → unconfirmed\n2\. click → unconfirmed\n/);
	assert.match(r.modelContent, /\[Image /);
});

test("a batch shows only the last step's image, never an out-of-date one", async () => {
	const { desktop } = fakeDesktop(WINDOW), t = tools(desktop, { imageInput: true, apps: { Notes: "act" }, cursor: false });
	const look = await t.screen_look!.execute({ app: "Notes" }, ctx());
	const r = await t.screen_act!.execute({ app: "Notes", snapshot: look.details?.snapshot, image: look.details?.image, steps: [{ action: "click", x: 20, y: 20 }, { action: "set_value", id: "e2", text: "After" }] }, ctx());
	assert.deepEqual((r.details?.steps as { outcome: string }[]).map(s => s.outcome), ["unconfirmed", "confirmed"], r.modelContent);
	assert.equal(r.images, undefined); assert.equal(r.details?.image, undefined);
});

test("a cold localized name or bundle identifier launches the resolved installed app", async () => {
	for (const query of ["计算器", "dev.example.calc"]) {
		const {desktop,log}=fakeDesktop(WINDOW), original=desktop.launch;
		desktop.resolveInstalledApp=async name=>name===query?{name:"Calc",bundleId:"dev.example.calc",path:"/Applications/Calc.app"}:null;
		desktop.launch=async name=>{
			assert.equal(name,"dev.example.calc");
			await original("Calc");
			const app=(await desktop.apps()).find(app=>app.name==="Calc")!;
			Object.assign(app,{bundleId:"dev.example.calc"});
			return {bundleId:"dev.example.calc"};
		};
		const result=await tools(desktop,{apps:{"dev.example.calc":"read"}}).screen_read!.execute({app:query},ctx("deny"));
		assert.equal(result.ok,true,result.modelContent);
		assert.match(result.modelContent,/Calculator/);
		assert.deepEqual(log,["launch Calc"]);
	}
});

for (const outcome of ["clean", "restored", "unreturned", "restored-with-guard-failure"] as const) test(`cold startup reports its actual launcher foreground result: ${outcome}`, async () => {
	const {desktop,log}=fakeDesktop(WINDOW), original=desktop.launch;
	const launchReceipt={pid:777,gaveBack:outcome.startsWith("restored")?1:0,frontTaken:outcome.startsWith("restored")?1:0,
		restoreRequests:outcome==="clean"?0:1,returnFailed:outcome==="unreturned",watchStopped:null,
		originalWindow:456,keyRestoreRequests:outcome==="clean"?0:2,keyRestorePairsSent:outcome.startsWith("restored")?1:0};
	let cleanups=0;
	desktop.beginInput=async()=>{};
	desktop.endInput=async()=>{cleanups++;return outcome==="restored-with-guard-failure"
		? {unchanged:false,frontChanged:true,restored:true,reason:"independent foreground guard also observed the interruption"}
		: {unchanged:true};};
	desktop.launch=async name=>{
		await original(name);
		const app=(await desktop.apps()).find(app=>app.name==="Calc")!;
		Object.assign(app,{bundleId:"dev.example.calc"});
		return {bundleId:"dev.example.calc",launchReceipt};
	};
	const t=tools(desktop,{apps:{Calc:"read"}}),result=await t.screen_read!.execute({app:"Calc"},ctx("deny"));
	assert.equal(result.ok,outcome==="clean",result.modelContent);
	assert.deepEqual(log,["launch Calc"]);assert.equal(cleanups,1);
	if(outcome!=="clean"){
		assert.equal(result.details.outcome,"failed");assert.equal(result.details.dispatched,true);assert.equal(result.details.retryUnsafe,true);
		assert.equal(result.details.pid,777);assert.deepEqual(result.details.launchReceipt,launchReceipt);
		assert.match(result.modelContent,/Do not launch it again automatically; read its existing window/);
		if(outcome==="unreturned")assert.match(result.modelContent,/could not confirm that the original app regained the foreground/);
		else assert.match(result.modelContent,/entered the foreground during startup; returning it afterwards does not satisfy background mode/);
		if(outcome==="restored-with-guard-failure")assert.equal((result.details.foreground as {frontChanged:boolean}).frontChanged,true);
		const read=await t.screen_read!.execute({app:"Calc"},ctx("deny"));
		assert.equal(read.ok,true,read.modelContent);assert.deepEqual(log,["launch Calc"],"read the existing app without repeating startup");
	}
});

test("cold Chrome screen reads refuse before dispatch and keep running Chrome readable", async () => {
	const {desktop,log}=fakeDesktop(WINDOW);
	desktop.resolveInstalledApp=async()=>({name:"Google Chrome",bundleId:"com.google.Chrome",path:"/Applications/Google Chrome.app"});
	desktop.beginInput=async()=>{log.push("begin");};
	const t=tools(desktop,{apps:{"com.google.Chrome":"read"}});
	const refused=await t.screen_read!.execute({app:"Google Chrome"},ctx("deny"));
	assert.equal(refused.ok,false);assert.equal(refused.details.dispatched,false);assert.equal(refused.details.outcome,"not_executed");
	assert.match(refused.modelContent,/use web_read/);assert.deepEqual(log,[]);
	const running=(await desktop.apps())[0]!;Object.assign(running,{name:"Google Chrome",bundleId:"com.google.Chrome"});
	const read=await t.screen_read!.execute({app:"Google Chrome"},ctx("deny"));
	assert.equal(read.ok,true,read.modelContent);assert.deepEqual(log,[]);
});

test("a denied bundle alias cannot bypass app permissions through a localized name", async () => {
	const {desktop,log}=fakeDesktop(WINDOW);
	desktop.resolveInstalledApp=async()=>({name:"Calc",bundleId:"dev.example.calc",path:"/Applications/Calc.app"});
	const result=await tools(desktop,{apps:{"dev.example.calc":"deny"}}).screen_read!.execute({app:"计算器"},ctx());
	assert.equal(result.ok,false);assert.deepEqual(log,[]);
});

test("menu reads never prime a window and report its current enabled state", async()=>{
 const {desktop,log}=fakeDesktop(WINDOW);
 desktop.beginInput=async()=>{log.push("begin");};
 desktop.prepareInput=async()=>{throw new Error("readonly menu primed an input window");};
 desktop.menus=async()=>[{path:"File > New",shortcut:null,enabled:false}];
 desktop.endInput=async()=>{log.push("end");return {unchanged:true};};
 const t=tools(desktop,{apps:{Notes:"read"}});
 const r=await t.screen_read!.execute({app:"Notes",menus:true},ctx("deny"));
 assert.equal(r.ok,true,r.modelContent);assert.match(r.modelContent,/File > New \[disabled\]/);assert.equal(r.details.pid,4242);
 assert.deepEqual(log,[]);
 desktop.endInput=async()=>{throw new Error("read-only menu must never restore focus");};
 assert.equal((await t.screen_read!.execute({app:"Notes",menus:true},ctx())).ok,true);
 assert.deepEqual(log,[]);
});


test("editing a field does not reset its existing caret by priming the whole window",async()=>{
	const {desktop,root}=fakeDesktop(WINDOW),field=root()!.kidsList[0]!.kidsList[0]!;
	Object.assign(field,{focused:true});
	desktop.prepareInput=async()=>{Object.assign(field,{focused:false});throw new Error("window activation discarded the field's editor");};
	const t=tools(desktop,{apps:{Notes:"act"}}),c=ctx("deny");
	const changed=await act(t,{action:"set_value",id:"e2",text:"new value"},c);
	assert.equal(changed.details?.outcome,"confirmed",changed.modelContent);
	assert.equal(field.value,"new value");assert.equal(field.focused,true);
});

test("an unnamed pressable row carries its child title and acts on the row",async()=>{
	const {desktop,root,log}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",actions:["press"],bounds:{x:10,y:10,width:300,height:50},kids:[{role:"static_text",name:"Own test note",bounds:{x:20,y:15,width:100,height:20}}]}]});
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),r=await observe(t);
	assert.match(r.modelContent,/e2 table_cell "Own test note" \{press\}/);
	const result=await t.screen_act!.execute({app:"Notes",action:"press",id:"e2"},ctx());
	assert.equal(result.details?.dispatched,true);
	assert.deepEqual(log,["press undefined"]);
	assert.notEqual(root()!.kidsList[0]!.kidsList[0]!.role,"table_cell");
});

test("a recycled unnamed row cannot keep the old child's title as click authority",async()=>{
	const {desktop,root,log}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",actions:["press"],bounds:{x:10,y:10,width:300,height:50},kids:[{role:"static_text",name:"Own test note"}]}]});
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
	Object.assign(root()!.kidsList[0]!.kidsList[0]!,{name:"Someone else's note"});
	const result=await t.screen_act!.execute({app:"Notes",action:"press",id:"e2"},ctx());
	assert.equal(result.details?.outcome,"not_executed");assert.deepEqual(log,[]);
});

test("identical checkboxes in recycled rows keep the observed row as authority",async()=>{
	const {desktop,root,log}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",name:"Own test item",kids:[{role:"check_box",name:"Complete",checked:"off",actions:["press","toggle"],bounds:{x:20,y:20,width:20,height:20}}]}]});
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t);
	const id=/\b(e\d+) check_box/.exec(read.modelContent)![1]!;
	Object.assign(root()!.kidsList[0]!,{name:"A different item"});
	const result=await t.screen_act!.execute({app:"Notes",action:"toggle",id},ctx());
	assert.equal(result.details?.outcome,"not_executed");assert.deepEqual(log,[]);
});

test("readback cannot confirm a checkbox recycled into another row", async()=>{
	const {root}=fakeDesktop({role:"window",name:"List",kids:[{role:"table_cell",name:"Own item",kids:[{role:"check_box",name:"Complete",checked:"off",actions:["toggle"]}]}]});
	const before=await readSnapshot([root()!],new ElementIds());
	const checkbox=before.entries.find(e=>e.element.role==="check_box")!;
	Object.assign(root()!.kidsList[0]!,{name:"Other item"});
	Object.assign(root()!.kidsList[0]!.kidsList[0]!,{checked:"on"});
	const after=await readSnapshot([root()!],new ElementIds());
	assert.equal(corresponding(checkbox,after),undefined);
});

test("an action that recycles a row cannot upgrade its old number to another item",async()=>{
	const {desktop,root,log}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",name:"Own item A",kids:[{role:"check_box",name:"Complete",checked:"off",actions:["toggle"],bounds:{x:20,y:20,width:20,height:20}}]}]});
	const row=root()!.kidsList[0]!,box=row.kidsList[0]!;
	box.toggle=async()=>{log.push(`toggle ${row.name}`);Object.assign(row,{name:"Other item B"});};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t),id=/\b(e\d+) check_box/.exec(read.modelContent)![1]!;
	await t.screen_act!.execute({app:"Notes",snapshot:read.details.snapshot,action:"toggle",id},ctx());
	const stale=await t.screen_act!.execute({app:"Notes",snapshot:read.details.snapshot,action:"toggle",id},ctx());
	assert.equal(stale.details.dispatched,false);assert.equal(stale.details.outcome,"not_executed");
	assert.deepEqual(log,["toggle Own item A"]);
});

test("paste restores the clipboard when the write succeeded but its acknowledgement was lost",async()=>{
	const {desktop,root,log}=fakeDesktop(WINDOW),field=root()!.kidsList[0]!.kidsList[0]!;
	Object.assign(field,{focused:true});let clipboard="original";
	desktop.clipboardSet=async()=>{clipboard="temporary";throw new Error("acknowledgement lost");};
	desktop.clipboardRestore=async()=>{clipboard="original";log.push("restored");return {restored:true,userChanged:false};};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),r=await act(t,{action:"paste",id:"e2",text:"temporary"});
	assert.equal(r.ok,false);assert.equal(clipboard,"original");assert.deepEqual(log,["restored"]);
});

test("a promoted child label also binds the checkbox below an unnamed pressable row",async()=>{
	const {desktop,root,log}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",actions:["press"],kids:[{role:"static_text",name:"Own item A"},{role:"check_box",name:"Complete",checked:"off",actions:["toggle"],bounds:{x:20,y:20,width:20,height:20}}]}]});
	const row=root()!.kidsList[0]!,label=row.kidsList[0]!,box=row.kidsList[1]!;
	box.toggle=async()=>{log.push(`toggle ${label.name}`);Object.assign(label,{name:"Other item B"});};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t),id=/\b(e\d+) check_box/.exec(read.modelContent)![1]!;
	await t.screen_act!.execute({app:"Notes",snapshot:read.details.snapshot,action:"toggle",id},ctx());
	const stale=await t.screen_act!.execute({app:"Notes",snapshot:read.details.snapshot,action:"toggle",id},ctx());
	assert.equal(stale.details.dispatched,false);assert.deepEqual(log,["toggle Own item A"]);
});

test("a restored transient focus change still fails ordinary actions",async()=>{
 const {desktop}=fakeDesktop(WINDOW);desktop.beginInput=async()=>{};desktop.prepareInput=async()=>{};
 desktop.endInput=async()=>({unchanged:true,focusChanged:true,frontChanged:false,restored:true});
 const t=tools(desktop,{apps:{Notes:"act"}}),r=await act(t,{action:"set_value",id:"e2",text:"new"});
 assert.equal(r.ok,false);assert.equal(r.details.outcome,"failed");assert.equal((r.details.foreground as {focusChanged:boolean}).focusChanged,true);
});

test("an ambiguous action identifies the latest window without silently choosing it",async()=>{
	const {desktop,root,log}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!;
	const other=el({...WINDOW,name:"Other"},log);
	app.windows=async()=>[root()!,other];
	const t=tools(desktop,{apps:{Notes:"act"}}),listed=await t.screen_read!.execute({app:"Notes"},ctx());
	const windows=listed.details.windows as {window:string}[];
	await observe(t,ctx(),windows[0]!.window);
	await observe(t,ctx(),windows[1]!.window);
	const action=await t.screen_act!.execute({app:"Notes",action:"key",key:"cmd+s"},ctx());
	assert.equal(action.details.dispatched,false);
	assert.match(action.modelContent,/several windows were read; pass window/);
	assert.ok(action.modelContent.includes(windows[1]!.window));
	assert.deepEqual(log,[]);
});

test("readable custom action labels retain their exact native dispatch and reject ambiguous labels",async()=>{
	const raw="name:Delete\n_target:0x0\n_selector:(null)";
	const {desktop,log,root}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",actions:[raw],bounds:{x:10,y:10,width:300,height:50},kids:[{role:"static_text",name:"Own test note"}]}]});
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
	const result=await t.screen_act!.execute({app:"Notes",action:"perform",id:"e2",text:"Delete"},ctx());
	assert.equal(result.details?.dispatched,true);assert.deepEqual(log,[`perform ${raw} on undefined`]);
	log.length=0;Object.assign(root()!.kidsList[0]!,{actions:[raw,"name:Delete\n_target:0x1\n_selector:(null)"]});
	await observe(t);const ambiguous=await t.screen_act!.execute({app:"Notes",action:"perform",id:"e2",text:"Delete"},ctx());
	assert.equal(ambiguous.details?.outcome,"not_executed");assert.deepEqual(log,[]);
});

test("anonymous native range controls remain readable and actionable when the provider lacks their role",async()=>{
	const {root}=fakeDesktop({role:"window",name:"Appointment",kids:[{role:"unknown",stableId:"start-datepicker",raw:{ax_role:"AXDateTimeArea"},actions:["increment","decrement"]}]});
	const snapshot=await readSnapshot([root()!],new ElementIds());
	assert.match(snapshot.entries.map(e=>e.line).join("\n"),/date_time_area "start-datepicker" \{increment,decrement\}/);
});

test("a dropdown picks an exact closed option without opening a keyboard-owning menu",async()=>{
	const {desktop,log}=fakeDesktop({role:"window",name:"Form",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"combo_box",name:"Method",value:"First",actions:["press"],bounds:{x:10,y:10,width:200,height:30},kids:[{role:"menu",visible:false,kids:[{role:"menu_item",name:"Second",actions:["pick"],visible:false}]}]}]});
	desktop.menusMayTakeFocus=true;
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
	const r=await t.screen_act!.execute({app:"Notes",action:"select",id:"e2",text:"Second"},ctx());
	assert.equal(r.details?.dispatched,true);assert.deepEqual(log,["perform pick on Second"]);
	log.length=0;await observe(t);const absent=await t.screen_act!.execute({app:"Notes",action:"select",id:"e2",text:"Missing"},ctx());
	assert.equal(absent.details?.outcome,"failed");assert.equal(absent.details.dispatched,true);assert.deepEqual(log,['press Method']);assert.match(absent.modelContent,/after opening/);
});

test("one actionable row is not duplicated for its title, preview and timestamp",async()=>{
	const {root}=fakeDesktop({role:"window",name:"List",kids:[{role:"table_cell",actions:["press"],kids:[{role:"static_text",name:"Own test note"},{role:"static_text",name:"Preview"},{role:"static_text",name:"12:00"}]}]});
	const row=root()!.kidsList[0]!,snapshot=await readSnapshot([root()!],new ElementIds());
	assert.equal(snapshot.entries.filter(e=>e.element===row).length,1);
	assert.match(snapshot.entries.find(e=>e.element===row)!.line,/Own test note/);
	assert.ok(snapshot.entries.some(e=>e.element.role==="static_text"&&e.element.name==="Preview"));
});

test("native date values appear in reads and stale date changes prevent an increment",async()=>{
	const {desktop,root,log}=fakeDesktop({role:"window",name:"Appointment",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"unknown",stableId:"start-datepicker",raw:{ax_role:"AXDateTimeArea"},actions:["increment","decrement"],bounds:{x:20,y:20,width:100,height:25}}]});
	let date="2026-10-18T02:00:00.000Z";
	desktop.controlValues=async(_app,_window,elements)=>new Map(elements.filter(el=>el.raw.ax_role==="AXDateTimeArea").map(el=>[el,date]));
	root()!.kidsList[0]!.increment=async()=>{log.push("increment");date="2026-10-19T02:00:00.000Z";};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),first=await observe(t);
	assert.match(first.modelContent,/start-datepicker.*2026-10-18T02:00:00.000Z/);
	const changed=await t.screen_act!.execute({app:"Notes",action:"increment",id:"e2"},ctx());
	assert.match(changed.modelContent,/2026-10-19T02:00:00.000Z/);assert.deepEqual(log,["increment"]);
	date="2026-10-20T02:00:00.000Z";
	const stale=await t.screen_act!.execute({app:"Notes",action:"increment",id:"e2"},ctx());
	assert.equal(stale.details?.outcome,"not_executed");assert.deepEqual(log,["increment"]);
});

test("split text inside a row is bound together before a destructive custom action",async()=>{
	const {desktop,root,log}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",actions:["Delete"],bounds:{x:10,y:10,width:300,height:50},kids:[{role:"static_text",name:"Common prefix"},{role:"static_text",name:"Unique A"}]}]});
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t);
	assert.match(read.modelContent,/table_cell "Common prefix Unique A"/);
	Object.assign(root()!.kidsList[0]!.kidsList[1]!,{name:"Unique B"});
	const result=await t.screen_act!.execute({app:"Notes",action:"perform",id:"e2",text:"Delete"},ctx());
	assert.equal(result.details?.outcome,"not_executed");assert.deepEqual(log,[]);
});

test("an unavailable sibling window cannot hide the valid target or receive a fallback action",async()=>{
	const {desktop,root,log}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!;
	const hidden=el({role:"window",name:"Closed sheet",bounds:{x:0,y:0,width:200,height:200}},log);
	hidden.children=async()=>{throw new Error("unavailable window was traversed");};
	app.windows=async()=>[hidden,root()!];
	desktop.windowIdentity=async(_app,window)=>{if(window===hidden)throw new WindowUnavailableError("window closed");return {id:"live",bounds:window.bounds!};};
	const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t);
	assert.match(read.modelContent,/window w:live/);assert.match(read.modelContent,/Draft/);
	const wrong=await t.screen_act!.execute({app:"Notes",window:"w:hidden",action:"menu",text:"File > Save"},ctx());
	assert.equal(wrong.details?.outcome,"not_executed");assert.deepEqual(log,[]);
	desktop.windowIdentity=async()=>{throw new Error("window identity is ambiguous");};
	assert.equal((await t.screen_read!.execute({app:"Notes"},ctx())).ok,false);
});


test("custom actions recover native casing on the retained element and honor cancellation",async()=>{
 const raw="name:Delete\n_target:0x0\n_selector:(null)",canonical="Name:Delete\nTarget:0x0\nSelector:(null)";
 const {desktop,log,root}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",name:"Own note",actions:[raw],bounds:{x:10,y:10,width:200,height:40}}]});
 const retained=root()!.kidsList[0]!;
 desktop.canonicalAction=async(_app,_window,element,action)=>{assert.equal(element,retained);assert.equal(action,raw);return canonical;};
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
 const result=await t.screen_act!.execute({app:"Notes",action:"perform",id:"e2",text:"Delete"},ctx());
 assert.equal(result.details?.dispatched,true);assert.deepEqual(log,[`perform ${canonical} on Own note`]);
 log.length=0;await observe(t);const cancel=new AbortController();
 desktop.canonicalAction=async()=>{cancel.abort();return canonical;};
 await t.screen_act!.execute({app:"Notes",action:"perform",id:"e2",text:"Delete"},{...ctx(),signal:cancel.signal});
 assert.deepEqual(log,[]);
});

test("a custom clipboard action still needs separate approval",async()=>{
 const {desktop,log}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table_cell",name:"Own item",actions:["name:_copy\n_target:0x0\n_selector:(null)"],bounds:{x:10,y:10,width:200,height:40}}]});
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);const denied=ctx("deny");
 const result=await t.screen_act!.execute({app:"Notes",action:"perform",id:"e2",text:"name:_copy\n_target:0x0\n_selector:(null)"},denied);
 assert.equal(result.details?.dispatched,false);assert.equal(denied.asked.length,1);assert.deepEqual(log,[]);
});


test("moving clipboard items here requires the same approval as paste",async()=>{
 const {desktop,log}=fakeDesktop(WINDOW);desktop.pressMenu=async()=>{log.push("move");};
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
 for(const name of ["Edit > Move Item Here","编辑 > 将项目移到这里"]){
  const denied=ctx("deny");const result=await t.screen_act!.execute({app:"Notes",action:"menu",text:name},denied);
  assert.equal(result.details?.dispatched,false);assert.equal(denied.asked.length,1);
 }
 assert.deepEqual(log,[]);
});

test("one read enumerates windows once but still rechecks target identity before publishing",async()=>{
 const {desktop,root}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!,windows=app.windows;
 let enumerations=0,identities=0,moved=false;
 app.windows=async()=>{enumerations++;return windows();};
 desktop.windowIdentity=async(_app,window)=>{identities++;return {id:"target",bounds:{...window.bounds!,x:moved?999:window.bounds!.x}};};
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});const first=await observe(t);
 assert.equal(first.ok,true);assert.equal(enumerations,1);assert.equal(identities,2);
 enumerations=0;identities=0;
 const children=root()!.children;root()!.children=async()=>{if(identities>0)moved=true;return children();};
 const changed=await t.screen_read!.execute({app:"Notes",full:true},ctx());assert.equal(changed.ok,false);assert.match(changed.modelContent,/window changed during observation/);
 assert.equal(enumerations,1);assert.equal(identities,2);
});


test("a closed sheet's reused window ID cannot retain the old foreground permission",async()=>{
 const {desktop,root,log}=fakeDesktop({role:"window",name:"Editor",stableId:"parent",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"window",name:"Save",stableId:"sheet",raw:{ax_role:"AXSheet"},bounds:{x:50,y:50,width:300,height:200}}]});
 const app=(await desktop.apps())[0]!;desktop.windowIdentity=async(_app,window)=>({id:window.stableId!,bounds:window.bounds!});
 const state=new ComputerState(async()=>desktop,[]);await state.windows(app);
 assert.equal(state.within("w:sheet","w:parent"),true,JSON.stringify([...state.sheetOf]));
 root()!.kidsList=[];
 const unrelated=el({role:"window",name:"Unrelated",stableId:"sheet",bounds:{x:50,y:50,width:300,height:200}},log);
 app.windows=async()=>[root()!,unrelated];await state.windows(app);
 assert.equal(state.within("w:sheet","w:parent"),false);
});


test("an editable label does not hide its selectable row or turn focus into selection",async()=>{
 const {desktop,root,log}=fakeDesktop({role:"window",name:"Lists",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"tree_item",actions:["show_default_u_i"],bounds:{x:10,y:10,width:300,height:40},kids:[{role:"table_cell",actions:["focus"],kids:[{role:"text_field",name:"Cloud",value:"Own test calendar",actions:["focus","set_value"],bounds:{x:30,y:10,width:200,height:40}}]}]}]});
 const row=root()!.kidsList[0]!;row.select=async()=>{log.push("select exact row");(row as {selected:boolean}).selected=true;};
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t);
 assert.match(read.modelContent,/e2 tree_item "Own test calendar"/);assert.match(read.modelContent,/text_field "Cloud" = "Own test calendar"/);
 const result=await t.screen_act!.execute({app:"Notes",action:"select",id:"e2"},ctx());
 assert.equal(result.details?.outcome,"confirmed");assert.deepEqual(log,["select exact row"]);
 await row.kidsList[0]!.kidsList[0]!.setValue("Someone else's calendar");log.length=0;
 const stale=await t.screen_act!.execute({app:"Notes",action:"select",id:"e2"},ctx());
 assert.equal(stale.details?.dispatched,false);assert.deepEqual(log,[]);
});


test("a named collection remains available as the keyboard target for row navigation",async()=>{
 const {desktop,log}=fakeDesktop({role:"window",name:"Lists",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"list",name:"Sources",actions:["focus"],bounds:{x:10,y:10,width:300,height:200},kids:[{role:"static_text",name:"Own test row"}]}]});
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t);
 assert.match(read.modelContent,/e2 list "Sources".*\{focus\}/);
 await t.screen_act!.execute({app:"Notes",steps:[{action:"focus",id:"e2"},{action:"key",key:"ArrowDown"}]},ctx());
 assert.deepEqual(log,["focus Sources","key ArrowDown in Lists"]);
});


test("a batch retains the completed edit but stops after a transient foreground violation",async()=>{
 const {desktop}=fakeDesktop(WINDOW);let ends=0;
 desktop.beginInput=async()=>{};desktop.endInput=async()=>({unchanged:true,frontChanged:++ends===1,focusChanged:false});
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
 const r=await t.screen_act!.execute({app:"Notes",steps:[{action:"set_value",id:"e2",text:"Edited first"},{action:"set_value",id:"e2",text:"Edited first"}]},ctx());
 assert.match(r.modelContent,/~ e2 text_field "Title" = "Edited first"/);assert.doesNotMatch(r.modelContent,/No visible change/);
 assert.deepEqual(r.details?.foreground,{unchanged:false,frontChanged:true,focusChanged:false});
 const steps=r.details?.steps as {foreground?:{frontChanged:boolean}}[];assert.equal(steps.length,1);assert.equal(steps[0]?.foreground?.frontChanged,true);
 assert.equal(r.ok,false);assert.equal(r.details.outcome,"failed");assert.equal(r.details.stoppedAt,1);
});

test("a refused last batch step still reports earlier observed edits without claiming a fresh read",async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW);(root()!.kidsList[0]!.kidsList[2] as {enabled:boolean}).enabled=false;
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
 const r=await t.screen_act!.execute({app:"Notes",steps:[{action:"set_value",id:"e2",text:"Saved earlier edit"},{action:"press",id:"e4"}]},ctx());
 assert.equal(r.details?.outcome,"not_executed");assert.match(r.modelContent,/before step 2 was refused/);assert.match(r.modelContent,/Saved earlier edit/);assert.match(r.modelContent,/Read the window again/);
 assert.deepEqual(log,["set Title=Saved earlier edit"]);
});


test("opening another window reports its handle even when the original window stays unchanged",async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!,opened=el({role:"window",name:"Own folder info",bounds:{x:600,y:100,width:300,height:300},kids:[{role:"text_field",name:"Name",value:"Own folder"}]},log);
 let shown=false;app.windows=async()=>shown?[root()!,opened]:[root()!];root()!.kidsList[0]!.kidsList[2]!.press=async()=>{shown=true;};
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
 const r=await t.screen_act!.execute({app:"Notes",action:"press",id:"e4"},ctx());
 const handles=r.details?.openedWindows as string[];assert.equal(handles.length,1);assert.ok(r.modelContent.includes(`New windows: ${handles[0]}`));
 assert.equal(r.ok,true,r.modelContent);assert.equal(r.details.outcome,"unconfirmed","a newly opened window is a result to inspect, not proof of completed work");
 const read=await t.screen_read!.execute({app:"Notes",window:handles[0]},ctx());assert.match(read.modelContent,/Own folder info/);
});

test("a new window cannot hide a focus violation or an unmet explicit expectation",async()=>{
 for(const focusFailed of [false,true]){
  const {desktop,root,log}=fakeDesktop(WINDOW),app=(await desktop.apps())[0]!,opened=el({role:"window",name:"Own save panel",bounds:{x:600,y:100,width:300,height:200}},log);
  let shown=false;app.windows=async()=>shown?[root()!,opened]:[root()!];root()!.kidsList[0]!.kidsList[2]!.press=async()=>{shown=true;};
  desktop.beginInput=async()=>{};desktop.endInput=async()=>({unchanged:!focusFailed,frontChanged:focusFailed,focusChanged:false});
  const t=tools(desktop,{apps:{Notes:"act"},cursor:false});await observe(t);
  const r=await t.screen_act!.execute({app:"Notes",action:"press",id:"e4",...(!focusFailed?{expect:{id:"e2",property:"value",value:"Changed"}}:{})},ctx());
  assert.equal((r.details.openedWindows as string[]).length,1);assert.equal(r.ok,false,r.modelContent);
  assert.equal(r.details.outcome,focusFailed?"failed":"unconfirmed");
 }
});


test("focus-only named cells remain readable and can be clicked by their observed number",async()=>{
 const {desktop,log}=fakeDesktop({role:"window",name:"Results",bounds:{x:0,y:0,width:500,height:400},kids:[{role:"table",name:"Event list",actions:["focus"],kids:[{role:"table_row",kids:[{role:"table_cell",name:"Own event, Monday 11:00",actions:["focus"],bounds:{x:20,y:30,width:200,height:40}}]}]}]});
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t);
 const id=/\b(e\d+) table_cell "Own event, Monday 11:00"/.exec(read.modelContent)?.[1];assert.ok(id,read.modelContent);
 await t.screen_act!.execute({app:"Notes",action:"double_click",id},ctx());
 assert.deepEqual(log,["pointer click 120,50 left x2 in Results"]);
});


test("equal nested checkboxes remain addressable under different named rows", async () => {
 const {desktop,root,log}=fakeDesktop({role:"window",name:"List",bounds:{x:0,y:0,width:500,height:400},kids:["A","B"].map((name,i)=>({
  role:"table_row",name:"Unique item "+name,kids:[{role:"table_cell",kids:[{role:"check_box",name:"Complete",checked:"off",actions:["toggle"],bounds:{x:20,y:20+i*30,width:20,height:20}}]}]
 }))});
 for(const row of root()!.kidsList){const box=row.kidsList[0]!.kidsList[0]!;box.toggle=async()=>{log.push("toggle "+row.name);Object.assign(box,{checked:"on"});};}
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),read=await observe(t),id=/\b(e\d+) check_box/.exec(read.modelContent)![1]!;
 const r=await t.screen_act!.execute({app:"Notes",action:"toggle",id},ctx());
 assert.equal(r.details.outcome,"confirmed",r.modelContent);assert.deepEqual(log,["toggle Unique item A"]);
});

test('disposed computer skill refuses cached desktop actions',async()=>{
 const {desktop,log}=fakeDesktop(WINDOW),skill=computerUseSkill({desktop:async()=>desktop,apps:{Notes:'act'},cursor:false});
 const t=Object.fromEntries(skill.tools!.map(tool=>[tool.name,tool]));
 await observe(t);await skill.dispose!();
 const r=await t.screen_act!.execute({app:'Notes',action:'set_value',id:'e2',text:'must not write'},ctx());
 assert.equal(r.details.outcome,'not_executed');assert.equal(r.details.dispatched,false);assert.deepEqual(log,[]);
});

test('concurrent skill disposal waits for in-flight cleanup and shares one promise',async()=>{
 const {desktop}=fakeDesktop(WINDOW);let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 desktop.beginInput=async()=>{};desktop.prepareInput=async()=>{};
 desktop.endInput=async()=>{entered();await gate;return {unchanged:true};};
 const skill=computerUseSkill({desktop:async()=>desktop,apps:{Notes:'act'},cursor:false}),t=Object.fromEntries(skill.tools!.map(tool=>[tool.name,tool]));
 await observe(t);
 const action=t.screen_act!.execute({app:'Notes',action:'set_value',id:'e2',text:'written before close'},ctx());
 await ready;
 const first=skill.dispose!(),second=skill.dispose!();assert.equal(first,second);
 let done=false;void first.then(()=>{done=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(done,false);
 release();await action;await first;assert.equal(done,true);
});

for(const action of ['right_click','click','double_click','drag','press','key'])test(`native controls attempt ${action} and report real focus failures`,async()=>{
 const {desktop,root,log}=fakeDesktop({role:'window',name:'Panel',raw:{ax_subrole:'AXFloatingWindow'},bounds:{x:0,y:0,width:500,height:400},kids:[{role:'combo_box',name:'Method',value:'First',actions:['press','show_menu'],bounds:{x:10,y:10,width:200,height:30}},{role:'button',name:'End',actions:['press'],bounds:{x:300,y:200,width:30,height:30}}]});
 desktop.menusMayTakeFocus=true;let guards=0;
 desktop.beginInput=async()=>{guards++;};desktop.endInput=async()=>({unchanged:false,restored:true,focusChanged:true,frontChanged:false,byUser:false,reason:'native popup changed keyboard focus; restored'});
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),read=await observe(t);
 const r=await t.screen_act!.execute({app:'Notes',snapshot:read.details.snapshot,action,id:'e2',...(action==='key'?{key:'Enter'}:{}),...(['click','double_click'].includes(action)?{method:'pointer',modifiers:['Ctrl']}:action==='drag'?{modifiers:['Ctrl']}:{}),...(action==='drag'?{to:'e3'}:{})},ctx());
 assert.equal(r.details.dispatched,true,r.modelContent);assert.equal(r.details.outcome,'failed');assert.equal((r.details.foreground as {restored:boolean}).restored,true);assert.equal(guards,1);assert.ok(log.length>0);
 const retry=await t.screen_act!.execute({app:'Notes',action:'press',id:'e2'},ctx());assert.equal(retry.details.dispatched,false);assert.equal(guards,1);
});

test('a lazily created native dropdown option can be selected after opening',async()=>{
 const {desktop,root,log}=fakeDesktop({role:'window',name:'Form',bounds:{x:0,y:0,width:500,height:400},kids:[{role:'combo_box',name:'Method',value:'First',actions:['press'],bounds:{x:10,y:10,width:200,height:30}}]});
 desktop.menusMayTakeFocus=true;const dropdown=root()!.kidsList[0]!;
 dropdown.press=async()=>{log.push('opened Method');const choice=el({role:'menu_item',name:'Second',actions:['pick']},log);choice.performAction=async()=>{log.push('picked Second');Object.assign(dropdown,{value:'Second'});};dropdown.kidsList=[choice];};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false});await observe(t);
 const r=await t.screen_act!.execute({app:'Notes',action:'select',id:'e2',text:'Second'},ctx());
 assert.equal(r.details.outcome,'confirmed',r.modelContent);assert.equal(dropdown.value,'Second');assert.deepEqual(log,['opened Method','picked Second']);
});

test('a same-named choice in another menu never becomes the opened dropdown choice',async()=>{
 const {desktop,root,log}=fakeDesktop({role:'window',name:'Form',bounds:{x:0,y:0,width:500,height:400},kids:[{role:'combo_box',name:'Option',value:'Draft',actions:['press'],bounds:{x:10,y:10,width:200,height:30}},{role:'menu',name:'Unrelated menu',kids:[{role:'menu_item',name:'Reviewed',actions:['pick']}]}]});
 const unrelated=root()!.kidsList[1]!.kidsList[0]!;unrelated.performAction=async()=>{log.push('WRONG MENU');};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false});await observe(t);
 const r=await t.screen_act!.execute({app:'Notes',action:'select',id:'e2',text:'Reviewed'},ctx());
 assert.equal(r.ok,false);assert.equal(r.details.dispatched,true);assert.deepEqual(log,['press Option']);assert.doesNotMatch(r.modelContent,/confirmed/);
});

for(const role of ['menu_item','list_item','option'])test(`a ${role} dropdown choice uses its value and exact canonical action`,async()=>{
 const {desktop,root,log}=fakeDesktop({role:'window',name:'Form',bounds:{x:0,y:0,width:500,height:400},kids:[{role:'combo_box',name:'Option',value:'Draft',actions:['press'],bounds:{x:10,y:10,width:200,height:30},kids:[{role:'menu',visible:false,kids:[{role,name:'',value:'Reviewed',actions:[role==='option'?'select':'press'],visible:false}]}]}]});
 const dropdown=root()!.kidsList[0]!,choice=dropdown.kidsList[0]!.kidsList[0]!;
 desktop.canonicalAction=async(_app,_window,element,action)=>{assert.notEqual(role,'option','semantic select must not query AX action names');assert.equal(element,choice);assert.equal(action,'press');return 'AXConfirm';};
 choice.performAction=async action=>{assert.equal(action,'AXConfirm');log.push('exact AXConfirm');Object.assign(dropdown,{value:'Reviewed'});};
 choice.select=async()=>{assert.equal(role,'option');log.push('semantic select');Object.assign(dropdown,{value:'Reviewed'});};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false});await observe(t);
 const r=await t.screen_act!.execute({app:'Notes',action:'select',id:'e2',text:'Reviewed'},ctx());
 assert.equal(r.details.outcome,'confirmed',r.modelContent);assert.deepEqual(log,[role==='option'?'semantic select':'exact AXConfirm']);
});

test('cancel during dropdown action-name lookup sends no option action',async()=>{
 const {desktop,log}=fakeDesktop({role:'window',name:'Form',bounds:{x:0,y:0,width:500,height:400},kids:[{role:'combo_box',name:'Option',value:'Draft',actions:['press'],bounds:{x:10,y:10,width:200,height:30},kids:[{role:'menu_item',name:'Reviewed',actions:['press'],visible:false}]}]});
 const cancel=new AbortController();desktop.canonicalAction=async()=>{cancel.abort();return 'AXConfirm';};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false});await observe(t);
 const r=await t.screen_act!.execute({app:'Notes',action:'select',id:'e2',text:'Reviewed'},{...ctx(),signal:cancel.signal});
 assert.equal(r.ok,false);assert.deepEqual(log,[]);
});

for(const expectAbsent of [false,true])test(`a moved unique row ${expectAbsent?'cannot be confirmed absent':'is confirmed at its new position'}`,async()=>{
 const row=(name:string):Spec=>({role:'row',kids:[{role:'static_text',name},{role:'check_box',name:'Complete',checked:'off',actions:['toggle'],bounds:{x:30,y:40,width:20,height:20}}]});
 const {desktop,root,log}=fakeDesktop({role:'window',name:'List',bounds:{x:0,y:0,width:500,height:400},kids:[row('Alpha'),row('Beta'),row('Gamma')]});
 const win=root()!,alpha=win.kidsList[0]!.kidsList[1]!;alpha.toggle=async()=>{log.push('toggle Alpha');Object.assign(alpha,{checked:'on'});win.kidsList=[win.kidsList[1]!,win.kidsList[2]!,win.kidsList[0]!];};
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),first=await observe(t),id=/\b(e\d+) check_box/.exec(first.modelContent)![1]!;
 const r=await t.screen_act!.execute({app:'Notes',action:'toggle',id,...(expectAbsent?{expect:{id,property:'exists',value:false}}:{})},ctx());
 assert.deepEqual(log,['toggle Alpha']);assert.equal(alpha.checked,'on');
 if(expectAbsent){assert.equal(r.ok,false);assert.equal(r.details.observed,true);assert.notEqual(r.details.outcome,'confirmed');}
 else{assert.equal(r.details.outcome,'confirmed',r.modelContent);assert.equal(r.details.observed,true);assert.match(r.modelContent,new RegExp(id+' check_box.*checked'));}
});

test('semantic readback rejects duplicate rows, recycled slot IDs, duplicate controls and incomplete ranges',async()=>{
 const row=(name:string,stableId?:string):Spec=>({role:'row',kids:[{role:'static_text',name},{role:'check_box',name:'Complete',checked:'off',actions:['toggle'],...(stableId?{stableId}:{}),bounds:{x:30,y:40,width:20,height:20}}]});
 for(const scenario of ['recycled-id','two-before-one-after','duplicate-control','truncated','region','hidden','removed']){
  const {root,log}=fakeDesktop({role:'window',name:'List',bounds:{x:0,y:0,width:500,height:400},kids:[row('Alpha',scenario==='recycled-id'?'slot-1':undefined),row(scenario==='two-before-one-after'?'Alpha':'Beta')]});
  const win=root()!,before=await readSnapshot([win],new ElementIds(),{full:true}),entry=before.entries.find(e=>e.element.role==='check_box')!;
  if(scenario==='recycled-id')Object.assign(win.kidsList[0]!.kidsList[0]!,{name:'Other'});
  else if(scenario==='two-before-one-after')win.kidsList=[win.kidsList[0]!];
  else if(scenario==='duplicate-control')win.kidsList[0]!.kidsList.push(el({role:'check_box',name:'Complete',checked:'on',actions:['toggle']},log));
  else if(scenario==='hidden')Object.assign(win.kidsList[0]!,{visible:false});
  else if(scenario==='removed')win.kidsList=win.kidsList.slice(1);
  else win.kidsList=[win.kidsList[1]!,win.kidsList[0]!];
  const after=await readSnapshot([win],new ElementIds(),{full:true});
  if(scenario==='truncated')after.truncated=true;if(scenario==='region')after.wholeWindow=false;
  assert.deepEqual(readbackIdentity(entry,after,before),{absent:false},scenario);
 }
});

test('only unique identities in consecutive complete reads keep row numbers through a reorder',async()=>{
 const {root,log}=fakeDesktop({role:'window',name:'List',kids:['Alpha','Beta'].map(name=>({role:'row',kids:[{role:'static_text',name},{role:'check_box',name:'Complete',checked:'off',actions:['toggle']}]}))});
 const win=root()!,ids=new ElementIds(),first=await readSnapshot([win],ids,{full:true}),alpha=first.entries.find(e=>e.element.role==='check_box')!;
 win.kidsList.reverse();const second=await readSnapshot([win],ids,{full:true}),moved=second.entries.find(e=>e.observed?.context===alpha.observed?.context&&e.element.role==='check_box')!;assert.equal(moved.id,alpha.id);assert.notEqual(moved.path,alpha.path);
 const alphaRow=win.kidsList.find(row=>row.kidsList[0]!.name==='Alpha')!;alphaRow.kidsList.push(el({role:'check_box',name:'Complete',checked:'off',actions:['toggle']},log));
 const duplicated=await readSnapshot([win],ids,{full:true});assert.equal(duplicated.byId.size,duplicated.entries.length);
 alphaRow.kidsList.pop();const restored=await readSnapshot([win],ids,{full:true}),newAlpha=restored.entries.find(e=>e.observed?.context===alpha.observed?.context&&e.element.role==='check_box')!;assert.notEqual(newAlpha.id,alpha.id,'a removed ambiguity cannot revive an old identity');
});

for(const scenario of ['renamed-control','duplicate-control','hidden-row'])test(`readback cannot confirm a replacement via ${scenario}`,async()=>{
 const checkbox=(visible=true):Spec=>({role:'check_box',name:'Alpha',visible,checked:'off',actions:['toggle'],bounds:{x:30,y:40,width:20,height:20}});
 const row=(visible:boolean):Spec=>({role:'row',visible,kids:[{role:'static_text',name:'Alpha row'},checkbox()]});
 const {desktop,root,log}=fakeDesktop({role:'window',name:'List',bounds:{x:0,y:0,width:500,height:400},kids:scenario==='hidden-row'?[row(true),row(false)]:scenario==='duplicate-control'?[checkbox(),checkbox()]:[checkbox()]});
 const win=root()!,target=scenario==='hidden-row'?win.kidsList[0]!.kidsList[1]!:win.kidsList[0]!;
 target.toggle=async()=>{
  log.push('one actual toggle');
  if(scenario==='renamed-control')Object.assign(target,{name:'Beta',checked:'on'});
  else if(scenario==='duplicate-control'){Object.assign(win.kidsList[1]!,{checked:'on'});win.kidsList=[win.kidsList[1]!];}
  else{Object.assign(win.kidsList[0]!,{visible:false});Object.assign(win.kidsList[1]!,{visible:true});Object.assign(win.kidsList[1]!.kidsList[1]!,{checked:'on'});win.kidsList.reverse();}
 };
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),read=await observe(t),id=/\b(e\d+) check_box/.exec(read.modelContent)![1]!;
 const r=await t.screen_act!.execute({app:'Notes',action:'toggle',id},ctx());assert.equal(r.ok,false,r.modelContent);assert.notEqual(r.details.outcome,'confirmed');assert.deepEqual(log,['one actual toggle']);
});

test('an unrelated truncated list does not block a verified text-field value write',async()=>{
 const {desktop,log}=fakeDesktop({role:'window',name:'Form',bounds:{x:0,y:0,width:500,height:400},kids:[{role:'text_field',name:'Name',value:'Old',editable:true,actions:['set_value'],bounds:{x:10,y:10,width:200,height:25}},{role:'group',kids:Array.from({length:60},(_,i)=>({role:'static_text',name:'Item '+i}))}]});
 desktop.menusMayTakeFocus=true;
 const t=tools(desktop,{apps:{Notes:'act'},cursor:false}),read=await observe(t);
 const r=await t.screen_act!.execute({app:'Notes',action:'set_value',id:'e2',text:'New'},ctx());
 assert.equal(read.details.complete,false);assert.equal(r.details.dispatched,true,r.modelContent);assert.deepEqual(log,['set Name=New']);
});


for(const name of ["粘贴","拷贝","剪切","Paste","Copy","Cut"])test(`pressing clipboard menu ${name} asks separately each time`,async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW);const button=root()!.kidsList[0]!.kidsList[2]!;Object.assign(button,{name});
 const t=tools(desktop,{apps:{Notes:"act"},cursor:false}),c=ctx("deny");
 for(let i=0;i<2;i++){const r=await act(t,{action:"press",id:"e4"},c);assert.equal(r.details?.dispatched,false,r.modelContent);}
 assert.equal(c.asked.length,2);assert.deepEqual(log,[]);
});
for(const name of ["Card number","卡号","CVV","有效期"])test(`native payment label ${name} refuses input without autocomplete`,async()=>{
 const {desktop,root,log}=fakeDesktop(WINDOW);Object.assign(root()!.kidsList[0]!.kidsList[0]!,{name});
 const r=await act(tools(desktop,{apps:{Notes:"act"},cursor:false}),{action:"set_value",id:"e2",text:"never"});assert.equal(r.details?.dispatched,false);assert.match(r.modelContent,/payment/);assert.deepEqual(log,[]);
});

test("readonly menu listing never starts input or runs an input cleanup that could activate apps",async()=>{
 const {desktop,log}=fakeDesktop(WINDOW);
 desktop.beginInput=async()=>{throw new Error("readonly menu started a focus-writing helper");};
 desktop.endInput=async()=>{throw new Error("readonly menu tried to restore focus");};
 desktop.prepareInput=async()=>{throw new Error("readonly menu prepared a key window");};
 desktop.showCursor=async()=>{throw new Error("readonly menu initialized cursor UI");};
 desktop.menus=async()=>{log.push("read menu");return [{path:"File > New",shortcut:null,enabled:false}];};
 const t=tools(desktop,{apps:{Notes:"read"},cursor:false}),out=await t.screen_read!.execute({app:"Notes",menus:true},ctx("deny"));
 assert.equal(out.ok,true,out.modelContent);assert.deepEqual(log,["read menu"]);assert.match(out.modelContent,/File > New \[disabled\]/);
});
