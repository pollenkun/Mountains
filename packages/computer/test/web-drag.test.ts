import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateTracker, Workspace, type ToolContext, type ToolDefinition } from "@mountains/tools";
import { axFixtureNodes, axFixtureReply } from "./fixtures/ax-protocol.ts";
import { createWebTools, type CdpEvent, type CdpLike } from "../src/web.ts";

/** A page with a card, a drop column, a slider and an upload area; boxes in CSS pixels. */
const BOXES: Record<number, [number, number, number, number]> = { 21: [10, 10, 100, 40], 22: [300, 200, 200, 300], 23: [50, 400, 200, 20], 24: [600, 50, 150, 100], 25: [10, 900, 50, 20] };
class DragPage implements CdpLike {
	sent: { method: string; params: Record<string, unknown> }[] = [];
	private readonly listeners = new Set<(event: CdpEvent) => void>();
	/** Emit Input.dragIntercepted after this many mouse moves (an HTML-draggable source). */
	interceptAfter: number | undefined;
	fail: ((method: string, params: Record<string, unknown>) => boolean) | undefined;
	visibility = "visible";
	private moves = 0;
	async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
		this.sent.push({ method, params });
		if (this.fail?.(method, params)) throw new Error(`${method} failed`);
		if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page-1", type: "page", title: "Board", url: "http://localhost/board" }] };
		if (method === "Target.createTarget") return { targetId: "page-1" };
		if (method === "Target.attachToTarget") return { sessionId: "s-page-1" };
		if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "f1", url: "http://localhost/board" } } };
		if (method === "Page.navigate") { this.emit("Page.loadEventFired", {}, sessionId); this.emit("Page.lifecycleEvent", { name: "networkIdle" }, sessionId); return { frameId: "f1" }; }
		if (method === "DOM.performSearch") return { searchId: "none", resultCount: 0 };
		if (method === "Accessibility.getFullAXTree") return { nodes: axFixtureNodes(this.tree(), "f1") };
		if (["Accessibility.getRootAXNode", "Accessibility.getChildAXNodes", "Accessibility.getAXNodeAndAncestors"].includes(method)) return axFixtureReply(axFixtureNodes(this.tree(), "f1"), method, params, "f1");
		if (method === "DOM.getBoxModel") { const [x, y, w, h] = BOXES[Number(params.backendNodeId)]!; return { model: { content: [x, y, x + w, y, x + w, y + h, x, y + h] } }; }
		if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 }, cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
		if (method === "Runtime.evaluate" && String(params.expression).includes("mountainsSettle")) return { result: { value: true } };
		if (method === "Runtime.evaluate" && params.expression === "document.visibilityState") return { result: { value: this.visibility } };
		if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && ++this.moves === this.interceptAfter)
			queueMicrotask(() => this.emit("Input.dragIntercepted", { data: { items: [{ mimeType: "text/plain", data: "card-a" }], dragOperationsMask: 1 } }, sessionId));
		return {};
	}
	on(listener: (event: CdpEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	async close(): Promise<void> {}
	input(): { method: string; params: Record<string, unknown> }[] { return this.sent.filter(call => call.method.startsWith("Input.")); }
	private emit(method: string, params: Record<string, unknown>, sessionId?: string): void { for (const listener of this.listeners) listener({ method, params, ...(sessionId ? { sessionId } : {}) }); }
	private tree() {
		return [
			{ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3", "4", "5", "6"] },
			{ nodeId: "2", role: { value: "button" }, name: { value: "Card A" }, backendDOMNodeId: 21, childIds: [] },
			{ nodeId: "3", role: { value: "button" }, name: { value: "Done column" }, backendDOMNodeId: 22, childIds: [] },
			{ nodeId: "4", role: { value: "slider" }, name: { value: "Volume" }, value: { value: "10" }, backendDOMNodeId: 23, childIds: [] },
			{ nodeId: "5", role: { value: "button" }, name: { value: "Drop files here" }, backendDOMNodeId: 24, childIds: [] },
			{ nodeId: "6", role: { value: "button" }, name: { value: "Far below" }, backendDOMNodeId: 25, childIds: [] },
		];
	}
}
const ctx = (): ToolContext => ({ workspace: new Workspace(process.cwd()), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c1", approve: async () => "allow" });
const tools = (page: CdpLike, headless = false): Record<string, ToolDefinition> => Object.fromEntries(createWebTools({ connect: async () => page, consent: { granted: true }, headless }).map(tool => [tool.name, tool]));
const idOf = (content: string, role: string, name: string): string => { const match = content.match(new RegExp(`(e\\d+) ${role} "${name}"`)); assert.ok(match, content); return match[1]!; };
async function board(page = new DragPage(), headless = false) {
	const t = tools(page, headless), read = await t.web_read!.execute({ url: "http://localhost/board" }, ctx());
	assert.equal(read.ok, true, read.modelContent);
	page.sent.length = 0;
	return { page, t, read, id: (role: string, name: string) => idOf(read.modelContent, role, name) };
}
const center = (id: number): [number, number] => { const [x, y, w, h] = BOXES[id]!; return [x + w / 2, y + h / 2]; };

test("a pointer drag presses at the source, moves with the button held, and releases on the target, all through CDP", async () => {
	const { page, t, id } = await board();
	const result = await t.web_act!.execute({ action: "drag", id: id("button", "Card A"), to: id("button", "Done column") }, ctx());
	assert.equal(result.details.dispatched, true, result.modelContent);
	const input = page.input();
	assert.deepEqual(input[0], { method: "Input.setInterceptDrags", params: { enabled: true } });
	assert.deepEqual(input[1]!.params, { type: "mousePressed", x: center(21)[0], y: center(21)[1], button: "left", buttons: 1, clickCount: 1 });
	const moves = input.filter(call => call.params.type === "mouseMoved");
	assert.equal(moves.length, 13);
	assert.ok(moves.every(call => call.params.buttons === 1 && call.params.button === "left"));
	assert.deepEqual([moves.at(-1)!.params.x, moves.at(-1)!.params.y], center(22));
	assert.deepEqual(input.at(-2)!.params, { type: "mouseReleased", x: center(22)[0], y: center(22)[1], button: "left", buttons: 0, clickCount: 1 });
	assert.deepEqual(input.at(-1), { method: "Input.setInterceptDrags", params: { enabled: false } });
	assert.equal(input.some(call => call.method === "Input.dispatchDragEvent"), false);
});

test("an HTML drag the page starts is finished with drag events carrying the page's own drag data", async () => {
	const page = new DragPage(); page.interceptAfter = 2;
	const { t, id } = await board(page);
	const result = await t.web_act!.execute({ action: "drag", id: id("button", "Card A"), to: id("button", "Done column") }, ctx());
	assert.equal(result.details.dispatched, true, result.modelContent);
	const input = page.input(), drags = input.filter(call => call.method === "Input.dispatchDragEvent");
	assert.equal(input.filter(call => call.params.type === "mouseMoved").length, 2, "no more mouse moves once Chrome owns the drag");
	assert.deepEqual(drags.map(call => call.params.type), ["dragEnter", "dragOver", ...Array(11).fill("dragOver"), "drop"]);
	assert.deepEqual(drags.at(-1)!.params, { type: "drop", x: center(22)[0], y: center(22)[1], data: { items: [{ mimeType: "text/plain", data: "card-a" }], dragOperationsMask: 1 } });
	const release = input.findIndex(call => call.params.type === "mouseReleased");
	assert.ok(release > input.indexOf(drags.at(-1)!), "the button is released after the drop");
	assert.deepEqual(input.at(-1), { method: "Input.setInterceptDrags", params: { enabled: false } });
});

test("a slider drags by dx/dy, and a drop point off the visible page sends nothing", async () => {
	const { page, t, id } = await board();
	await t.web_act!.execute({ action: "drag", id: id("slider", "Volume"), dx: 60, dy: 0 }, ctx());
	const moves = page.input().filter(call => call.params.type === "mouseMoved");
	assert.deepEqual([moves.at(-1)!.params.x, moves.at(-1)!.params.y], [center(23)[0] + 60, center(23)[1]]);
	page.sent.length = 0;
	const { page: second, t: t2, id: id2 } = await board();
	const off = await t2.web_act!.execute({ action: "drag", id: id2("button", "Card A"), to: id2("button", "Far below") }, ctx());
	assert.equal(off.ok, false);
	assert.match(off.modelContent, /outside the visible page/);
	assert.equal(off.details.outcome, "not_executed");
	assert.equal(second.input().length, 0);
	const bare = await t2.web_act!.execute({ action: "drag", id: id2("button", "Card A") }, ctx());
	assert.match(bare.modelContent, /drag needs to/);
});

test("a failure after Chrome took over the drag cancels it and still releases the button", async () => {
	const page = new DragPage(); page.interceptAfter = 1;
	page.fail = (method, params) => method === "Input.dispatchDragEvent" && params.type === "drop";
	const { t, id } = await board(page);
	const result = await t.web_act!.execute({ action: "drag", id: id("button", "Card A"), to: id("button", "Done column") }, ctx());
	assert.equal(result.ok, false);
	const types = page.input().map(call => String(call.params.type ?? call.params.enabled));
	assert.ok(types.includes("dragCancel"), types.join(" "));
	assert.ok(types.indexOf("mouseReleased") > types.indexOf("dragCancel"));
	assert.equal(types.at(-1), "false", "interception is turned off");
});

test("drop puts absolute local files on the drop area without a file chooser", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-drop-"));
	try {
		const file = join(dir, "report.txt"); writeFileSync(file, "hello");
		const { page, t, id } = await board();
		const result = await t.web_act!.execute({ action: "drop", id: id("button", "Drop files here"), files: [file] }, ctx());
		assert.equal(result.details.dispatched, true, result.modelContent);
		const drags = page.input().filter(call => call.method === "Input.dispatchDragEvent");
		assert.deepEqual(drags.map(call => call.params.type), ["dragEnter", "dragOver", "drop"]);
		assert.deepEqual(drags[2]!.params, { type: "drop", x: center(24)[0], y: center(24)[1], data: { items: [], files: [file], dragOperationsMask: 1 } });
		assert.equal(page.sent.some(call => call.method === "Page.setInterceptFileChooserDialog"), false);
		page.sent.length = 0;
		const relative = await t.web_act!.execute({ action: "drop", id: id("button", "Drop files here"), files: ["report.txt"] }, ctx());
		assert.equal(relative.details.outcome, "not_executed");
		assert.equal(page.input().length, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("headless Chrome brings a background tab forward before a drag, since a hidden tab delays every held move", async () => {
	const page = new DragPage(); page.visibility = "hidden";
	const { t, id } = await board(page, true);
	await t.web_act!.execute({ action: "drag", id: id("button", "Card A"), to: id("button", "Done column") }, ctx());
	const activate = page.sent.findIndex(call => call.method === "Target.activateTarget"), press = page.sent.findIndex(call => call.params.type === "mousePressed");
	assert.ok(activate >= 0 && activate < press, "the tab comes forward before the button is pressed");
	assert.deepEqual(page.sent[activate]!.params, { targetId: "page-1" });
	const visible = await board(new DragPage(), true);
	await visible.t.web_act!.execute({ action: "drag", id: visible.id("button", "Card A"), to: visible.id("button", "Done column") }, ctx());
	assert.equal(visible.page.sent.some(call => call.method === "Target.activateTarget"), false);
	const headed = await board(Object.assign(new DragPage(), { visibility: "hidden" }));
	await headed.t.web_act!.execute({ action: "drag", id: headed.id("button", "Card A"), to: headed.id("button", "Done column") }, ctx());
	assert.equal(headed.page.sent.some(call => call.method === "Target.activateTarget"), false, "a headed window is never brought forward");
});
