import { writeFileSync } from "node:fs";
import type { BrowserWindow } from "electron";
import { PROTOCOL_VERSION } from "@mountains/protocol";
import type { Desk } from "../src/main/desk.ts";
import { EVENT_CHANNEL, securityCounts } from "../src/main/window.ts";
import { approvalBoard, demoScript, paymentsBoard, siuiBoard } from "./boards.ts";

async function loadSettled(window: BrowserWindow): Promise<void> {
	if (!window.webContents.isLoading()) return;
	await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function securityProbe(window: BrowserWindow, desk: Desk): Promise<void> {
	const page = await window.webContents.executeJavaScript(`({ require: typeof require, process: typeof process, mountains: typeof window.mountains, send: typeof window.mountains.send })`) as {
		require: string; process: string; mountains: string; send: string;
	};
	const droppedBefore = securityCounts().commandsDropped;
	const runsBefore = desk.liveHosts().length;
	await window.webContents.executeJavaScript(`window.mountains.send({ type: "nope" })`);
	await window.webContents.executeJavaScript(`window.mountains.send({ protocolVersion: "0.1.0", type: "run.start", task: 1 })`);
	await delay(150);
	const urlBefore = window.webContents.getURL();
	await window.webContents.executeJavaScript(`window.location.href = "https://example.com/mountains-navigation-probe"`);
	await delay(250);
	await window.webContents.executeJavaScript(`window.open("https://example.com/mountains-window-probe")`);
	await delay(150);
	const shot = process.env.MOUNTAINS_DESKTOP_RESULT;
	if (!shot) throw new Error("MOUNTAINS_DESKTOP_RESULT is required");
	writeFileSync(shot, `${JSON.stringify({
		page,
		droppedCommands: securityCounts().commandsDropped - droppedBefore,
		runsStarted: desk.liveHosts().length - runsBefore,
		urlBefore,
		urlAfter: window.webContents.getURL(),
		...securityCounts(),
	})}\n`);
}

async function screenshotProbe(window: BrowserWindow, desk: Desk): Promise<void> {
	const shot = process.env.MOUNTAINS_DESKTOP_SHOT;
	if (!shot) throw new Error("MOUNTAINS_DESKTOP_SHOT is required");
	const task = process.env.MOUNTAINS_DESKTOP_TASK ?? "这个文件夹是做什么的？";
	let status = "";
	const conversation = desk.create();
	desk.onEvent((id, event) => {
		if (id === conversation.id && event.type === "run.completed") status = event.status;
	});
	desk.command(conversation.id, { protocolVersion: PROTOCOL_VERSION, type: "run.start", task });
	const cancel = process.env.MOUNTAINS_DESKTOP_FAKE === "partial";
	if (cancel) {
		const started = Date.now();
		let text = "";
		while (!text && Date.now() - started < 8000) {
			text = await window.webContents.executeJavaScript(`document.querySelector(".bubble.assistant")?.textContent ?? ""`) as string;
			if (!text) await delay(40);
		}
		window.webContents.focus();
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
		await window.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
	}
	const started = Date.now();
	while (!status && Date.now() - started < 30000) await delay(40);
	if (!status) throw new Error("run did not finish");
	// A fast run can finish before the page has drawn it: wait for the reply itself, then for its words to settle.
	let reply = "";
	for (const drawn = Date.now(); !reply && Date.now() - drawn < 8000; ) {
		reply = await window.webContents.executeJavaScript(`[...document.querySelectorAll(".bubble.assistant")].map(b => b.textContent).join("")`) as string;
		if (!reply) await delay(40);
	}
	await delay(900);
	let output = "";
	if (process.env.MOUNTAINS_DESKTOP_EXPAND === "1") {
		// The run can finish before the page has drawn its last events.
		const opened = Date.now();
		while (Date.now() - opened < 4000 && !(await window.webContents.executeJavaScript(`(() => { const row = document.querySelector(".tool-row"); row?.click(); return !!row; })()`))) await delay(40);
		while (!output && Date.now() - opened < 8000) {
			output = await window.webContents.executeJavaScript(`document.querySelector(".card pre.output")?.textContent ?? ""`) as string;
			if (!output) await delay(40);
		}
		await delay(400);
	}
	const image = await window.webContents.capturePage();
	writeFileSync(shot, image.toPNG());
	writeFileSync(`${shot}.json`, `${JSON.stringify({ status, reply, output })}\n`);
}

/** Drops a real file on the composer through the DevTools protocol, the way Finder would. */
async function dropProbe(window: BrowserWindow): Promise<void> {
	const file = process.env.MOUNTAINS_DESKTOP_DROP_FILE;
	const result = process.env.MOUNTAINS_DESKTOP_RESULT;
	if (!file || !result) throw new Error("MOUNTAINS_DESKTOP_DROP_FILE and MOUNTAINS_DESKTOP_RESULT are required");
	const page = window.webContents;
	let at: { x: number; y: number } | null = null;
	for (const started = Date.now(); !at && Date.now() - started < 8000; ) {
		at = await page.executeJavaScript(`(() => { const r = document.querySelector(".composer")?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`) as { x: number; y: number } | null;
		if (!at) await delay(40);
	}
	if (!at) throw new Error("no composer");
	// The first screen's composer rises in; aim at where it comes to rest.
	await delay(800);
	at = await page.executeJavaScript(`(() => { const r = document.querySelector(".composer").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`) as { x: number; y: number };
	page.debugger.attach("1.3");
	const data = { items: [], files: [file], dragOperationsMask: 1 };
	for (const type of ["dragEnter", "dragOver"]) await page.debugger.sendCommand("Input.dispatchDragEvent", { type, ...at, data });
	await delay(80);
	const highlighted = await page.executeJavaScript(`!!document.querySelector(".composer.dropping")`) as boolean;
	await page.debugger.sendCommand("Input.dispatchDragEvent", { type: "drop", ...at, data });
	// A dropped file becomes an attachment chip; its full path is the chip's title.
	let text = "";
	for (const dropped = Date.now(); !text && Date.now() - dropped < 3000; ) {
		text = await page.executeJavaScript(`[...document.querySelectorAll(".attach")].map((chip) => chip.title).join("\\n")`) as string;
		if (!text) await delay(40);
	}
	const after = await page.executeJavaScript(`!!document.querySelector(".composer.dropping")`) as boolean;
	writeFileSync(result, `${JSON.stringify({ highlighted, text, after })}\n`);
}

/** Drags the thinking-tier knob from the first stop to the last with real mouse events, the way a hand would. */
async function sliderProbe(window: BrowserWindow): Promise<void> {
	const result = process.env.MOUNTAINS_DESKTOP_RESULT;
	if (!result) throw new Error("MOUNTAINS_DESKTOP_RESULT is required");
	const page = window.webContents;
	let opened = false;
	for (const started = Date.now(); !opened && Date.now() - started < 8000; ) {
		opened = await page.executeJavaScript(`(() => { const b = document.querySelector(".di[data-k='model']"); b?.click(); return !!b; })()`) as boolean;
		if (!opened) await delay(60);
	}
	type Track = { x: number; y: number; width: number };
	let track = null as Track | null;
	// The dock opens on a spring: the slider is usable once the panel has fully arrived.
	for (const started = Date.now(); !track && Date.now() - started < 4000; ) {
		track = await page.executeJavaScript(`(() => { const r = document.querySelector(".slider")?.getBoundingClientRect(), open = document.querySelector(".dock-panel.open"); return r && open?.style.opacity === "1" ? { x: r.x, y: r.y + r.height / 2, width: r.width } : null; })()`) as Track | null;
		if (!track) await delay(60);
	}
	await delay(500);
	track = await page.executeJavaScript(`(() => { const r = document.querySelector(".slider").getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, width: r.width }; })()`) as Track;
	if (!track) throw new Error("no slider");
	const knob = () => page.executeJavaScript(`Math.round(document.querySelector(".knob").getBoundingClientRect().x)`) as Promise<number>;
	const label = () => page.executeJavaScript(`document.querySelector(".effort-label").textContent`) as Promise<string>;
	page.debugger.attach("1.3");
	const mouse = (type: string, x: number) => page.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y: track!.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
	const before = await label(), from = track.x + 20, to = track.x + track.width - 20;
	await mouse("mousePressed", from);
	const path: number[] = [];
	for (let i = 1; i <= 10; i++) { await mouse("mouseMoved", from + (to - from) * i / 10); await delay(16); path.push(await knob()); }
	await mouse("mouseReleased", to);
	await delay(600);
	writeFileSync(result, `${JSON.stringify({ before, after: await label(), path })}\n`);
}

/** Plays with a SIUI reply: moves its price slider, reads the results again, and presses its send button. */
async function siuiProbe(window: BrowserWindow): Promise<void> {
	const result = process.env.MOUNTAINS_DESKTOP_RESULT;
	if (!result) throw new Error("MOUNTAINS_DESKTOP_RESULT is required");
	const page = window.webContents;
	await delay(300);
	for (const event of siuiBoard()) page.send(EVENT_CHANNEL, { conversation: "c_board0000000", event });
	let ready = false;
	for (const started = Date.now(); !ready && Date.now() - started < 8000; ) {
		ready = await page.executeJavaScript(`!!document.querySelector(".ui-slider input")`) as boolean;
		if (!ready) await delay(60);
	}
	const stats = () => page.executeJavaScript(`[...document.querySelectorAll(".ui-stat-value")].map((v) => v.textContent)`) as Promise<string[]>;
	const before = await stats();
	await page.executeJavaScript(`(() => { const input = document.querySelector(".ui-slider input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "500"); input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
	await delay(100);
	const after = await stats();
	await page.executeJavaScript(`[...document.querySelectorAll(".ui-button")].find((b) => b.textContent.includes("就按这个算")).click()`);
	await delay(100);
	const draft = await page.executeJavaScript(`document.getElementById("composer").value`) as string;
	const sent = await page.executeJavaScript(`document.querySelectorAll(".bubble.user").length`) as number;
	writeFileSync(result, `${JSON.stringify({ before, after, draft, sent })}\n`);
}

/** Replays a design board's events straight into the page, so the shot shows what those events render to. */
async function boardProbe(window: BrowserWindow): Promise<void> {
	const shot = process.env.MOUNTAINS_DESKTOP_SHOT;
	if (!shot) throw new Error("MOUNTAINS_DESKTOP_SHOT is required");
	const folded = process.env.MOUNTAINS_DESKTOP_FOLDED !== "false";
	await window.webContents.executeJavaScript(`localStorage.setItem("mountains.tools.folded", "${folded}")`);
	const reloaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
	window.webContents.reload();
	await reloaded;
	await delay(200);
	const name = process.env.MOUNTAINS_DESKTOP_BOARD;
	const board = name === "empty" ? [] : name === "approval" ? approvalBoard() : name === "siui" ? siuiBoard() : paymentsBoard();
	for (const event of board) window.webContents.send(EVENT_CHANNEL, { conversation: "c_board0000000", event });
	// Streamed words take a moment to rise and settle.
	await delay(2500);
	const open = process.env.MOUNTAINS_DESKTOP_OPEN;
	if (open) {
		const script = open.startsWith("css:")
			? `document.querySelector(${JSON.stringify(open.slice(4))})?.click()`
			: `[...document.querySelectorAll("button.tool-row")].filter((row) => ${JSON.stringify(open)} === "last" || row.textContent.includes(${JSON.stringify(open)})).at(-1)?.click()`;
		await window.webContents.executeJavaScript(script);
		if (process.env.MOUNTAINS_DESKTOP_TYPE) {
			await delay(150);
			await window.webContents.insertText(process.env.MOUNTAINS_DESKTOP_TYPE);
			await delay(700);
		}
		await delay(250);
	}
	const image = await window.webContents.capturePage();
	writeFileSync(shot, image.toPNG());
	const rows = await window.webContents.executeJavaScript(`[...document.querySelectorAll(".tool-row")].map((row) => row.textContent)`) as string[];
	writeFileSync(`${shot}.json`, `${JSON.stringify({ rows })}\n`);
}

/** Plays a timed stream into a visible window and stays open until the window is closed. */
async function demoProbe(window: BrowserWindow): Promise<void> {
	const closed = new Promise<void>((resolve) => window.on("closed", () => resolve()));
	await delay(600);
	for (;;) {
		for (const [wait, event] of demoScript()) {
			if (window.isDestroyed()) return;
			await delay(wait);
			window.webContents.send(EVENT_CHANNEL, { conversation: "c_demo00000000", event });
			// Open the reasoning once it starts, so the demo shows its words rising too.
			if (event.type === "message.delta" && event.kind === "thinking" && event.seq === 2) {
				await delay(250);
				await window.webContents.executeJavaScript(`document.querySelector(".thinking .tool-row")?.click()`);
			}
		}
		if (await Promise.race([closed.then(() => true), delay(4000).then(() => false)])) return;
		if (window.isDestroyed()) return;
		window.webContents.reload();
		await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
	}
}

export async function runProbe(window: BrowserWindow, desk: Desk): Promise<void> {
	await loadSettled(window);
	const mode = process.env.MOUNTAINS_DESKTOP_PROBE;
	if (mode === "security") await securityProbe(window, desk);
	else if (mode === "screenshot") await screenshotProbe(window, desk);
	else if (mode === "board") await boardProbe(window);
	else if (mode === "demo") await demoProbe(window);
	else if (mode === "drop") await dropProbe(window);
	else if (mode === "slider") await sliderProbe(window);
	else if (mode === "siui") await siuiProbe(window);
	else throw new Error(`unknown probe ${mode ?? ""}`);
}
