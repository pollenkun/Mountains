import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateTracker, Workspace, type ToolContext, type ToolResult } from "@mountains/tools";
import { createWebTools, WebBrowser } from "../src/web.ts";

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")].find(path => existsSync(path));

// cua-driver's every-input form (test/fixtures/web-cua, MIT). Each control is filled the way a model would, and
// the page's own submit handler is the independent check.
test("every common HTML control on cua-driver's form is filled, confirmed and submitted correctly", { timeout: 120_000, skip: CHROME ? false : "Google Chrome is not installed" }, async () => {
	const html = readFileSync(new URL("./fixtures/web-cua/form_all_inputs.html", import.meta.url));
	const server: Server = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const profile = await mkdtemp(join(tmpdir(), "mountains-web-forms-"));
	const browser = new WebBrowser({ headless: true, profileDir: profile, idleMs: 300 });
	const t = Object.fromEntries(createWebTools({ browser, consent: { granted: true } }).map(tool => [tool.name, tool]));
	const ctx = (): ToolContext => ({ workspace: new Workspace(profile), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c", approve: async () => "allow" });
	try {
		let read = await t.web_read!.execute({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, full: true }, ctx());
		const id = (re: RegExp) => { const m = read.modelContent.match(re); assert.ok(m, `${re} in ${read.modelContent}`); return m[1]!; };
		const act = async (args: Record<string, unknown>, outcome = "confirmed"): Promise<ToolResult> => {
			const done = await t.web_act!.execute(args, ctx());
			assert.equal(done.details?.outcome, outcome, `${JSON.stringify(args)}: ${done.modelContent}`);
			read = await t.web_read!.execute({ tab: "t1", full: true }, ctx());
			return done;
		};
		await act({ action: "type", id: id(/(e\d+) textbox "Text"/), text: "hello 你好" });
		await act({ action: "type", id: id(/(e\d+) textbox "Password"/), text: "pw123" });
		await act({ action: "type", id: id(/(e\d+) textbox "Email"/), text: "a@b.co" });
		await act({ action: "type", id: id(/(e\d+) spinbutton "Number"/), text: "42" });
		await act({ action: "type", id: id(/(e\d+) textbox "Phone"/), text: "555-1234" });
		await act({ action: "type", id: id(/(e\d+) textbox "Message/), text: "line one" });
		await act({ action: "select", id: id(/(e\d+) combobox "Favourite/), text: "Green" });
		await act({ action: "click", id: id(/(e\d+) checkbox "I agree/) });
		await act({ action: "click", id: id(/(e\d+) radio "Banana"/) });
		// A slider takes a value; before Beta 1 the text went into the textarea that last had the caret.
		await act({ action: "type", id: id(/(e\d+) slider/), text: "75" });
		const datePart = id(/(e\d+) spinbutton "(?!Number)[^"]*"/);
		const partial = await t.web_act!.execute({ action: "type", id: datePart, text: "2026" }, ctx());
		assert.equal(partial.ok, false); assert.match(partial.modelContent, /write YYYY-MM-DD/);
		read = await t.web_read!.execute({ tab: "t1", full: true }, ctx());
		await act({ action: "type", id: id(/(e\d+) spinbutton "(?!Number)[^"]*"/), text: "2026-10-19" });
		await act({ action: "type", id: id(/(e\d+) colorwell/), text: "#00ff00" });
		await act({ action: "click", id: id(/(e\d+) button "Submit Form"/) }, "unconfirmed");
		const shot = await browser.open({ tab: "t1", full: true }, new AbortController().signal);
		const cdp = await (browser as unknown as { connection(): Promise<{ send(m: string, p: unknown, s: string): Promise<{ result: { value: string } }> }> }).connection();
		const submitted = JSON.parse((await cdp.send("Runtime.evaluate", { expression: "JSON.stringify(window._submitted||null)", returnByValue: true }, shot.sessionId)).result.value);
		assert.deepEqual(submitted, { text: "hello 你好", password: "pw123", email: "a@b.co", number: "42", tel: "555-1234", textarea: "line one", select: "green", checkbox: true, radio: "banana", range: "75", date: "2026-10-19", color: "#00ff00" });
	} finally {
		await browser.close();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("a canvas is listed and can be clicked at a point of the page image", { timeout: 120_000, skip: CHROME ? false : "Google Chrome is not installed" }, async () => {
	const html = readFileSync(new URL("./fixtures/web-cua/test_page.html", import.meta.url));
	const server: Server = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const profile = await mkdtemp(join(tmpdir(), "mountains-web-canvas-"));
	const browser = new WebBrowser({ headless: true, profileDir: profile, idleMs: 300 });
	const t = Object.fromEntries(createWebTools({ browser, consent: { granted: true }, imageInput: true }).map(tool => [tool.name, tool]));
	const ctx = (): ToolContext => ({ workspace: new Workspace(profile), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c", approve: async () => "allow" });
	try {
		const read = await t.web_read!.execute({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, full: true }, ctx());
		assert.match(read.modelContent, /canvas "drawn content: web_look, then click x\/y"/);
		const refused = await t.web_act!.execute({ action: "click", x: 10, y: 10 }, ctx());
		assert.equal(refused.ok, false); assert.match(refused.modelContent, /look at this page first/);
		const scrolled = await t.web_act!.execute({ action: "scroll", dy: 600 }, ctx());
		assert.equal(scrolled.details?.dispatched, true, scrolled.modelContent);
		const fresh = await t.web_read!.execute({ tab: "t1", full: true }, ctx());
		const look = await t.web_look!.execute({ snapshot: fresh.details?.snapshot }, ctx());
		assert.equal(look.ok, true, look.modelContent);
		const shot = await browser.open({ tab: "t1" }, new AbortController().signal);
		const cdp = await (browser as unknown as { connection(): Promise<{ send(m: string, p: unknown, s: string): Promise<{ result: { value: unknown } }> }> }).connection();
		const box = (await cdp.send("Runtime.evaluate", { expression: "(()=>{const r=document.getElementById('mycanvas').getBoundingClientRect();return [r.left,r.top,innerWidth]})()", returnByValue: true }, shot.sessionId)).result.value as number[];
		const scale = Number(look.details?.width) / box[2]!;
		const again = await t.web_read!.execute({ tab: "t1", full: true }, ctx());
		await t.web_look!.execute({ snapshot: again.details?.snapshot }, ctx());
		const clicked = await t.web_act!.execute({ snapshot: again.details?.snapshot, action: "click", x: (box[0]! + 50) * scale, y: (box[1]! + 40) * scale }, ctx());
		assert.equal(clicked.details?.dispatched, true, clicked.modelContent);
		const after = await browser.open({ tab: "t1" }, new AbortController().signal);
		const point = (await cdp.send("Runtime.evaluate", { expression: "[document.getElementById('mycanvas').dataset.lastX,document.getElementById('mycanvas').dataset.lastY]", returnByValue: true }, after.sessionId)).result.value as string[];
		assert.deepEqual(point.map(Number), [50, 40]);
	} finally {
		await browser.close();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});
