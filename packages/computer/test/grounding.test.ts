import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { FileStateTracker, Workspace, type ToolContext } from "@mountains/tools";
import { createComputerTools, locate, parsePoint, type Capture, type Desktop, type GroundingOptions, type UiApp, type UiElement } from "../src/index.ts";

test("grounding replies in either coordinate style become image pixels; anything outside or 'none' is no point", () => {
	assert.deepEqual(parsePoint("click(start_box='(140,56)')", 400, 300), [140, 56]);
	assert.deepEqual(parsePoint("click(start_box='<|box_start|>(500,500)<|box_end|>')", 400, 300, "thousandths"), [200, 150]);
	assert.deepEqual(parsePoint("[10, 20, 30, 40]", 400, 300), [10, 20]);
	assert.equal(parsePoint("none", 400, 300), null);
	assert.equal(parsePoint("click(start_box='(900,56)')", 400, 300), null);
	assert.equal(parsePoint("I cannot see it", 400, 300), null);
	assert.deepEqual(parsePoint("Thought: (1,2) is just an example.\nAction: click(start_box='(140,56)')", 400, 300), [140, 56]);
	assert.equal(parsePoint("click(start_box='(1,2)') or click(start_box='(140,56)')", 400, 300), null);
	assert.equal(parsePoint("The example position is (1,2)", 400, 300), null);
	assert.equal(parsePoint("Thought: click(start_box='(1,2)') is only an example.\nAction: none", 400, 300), null);
	assert.equal(parsePoint("Action: click(start_box='(1,2)')\nAction: click(start_box='(3,4)')", 400, 300), null);
});

test("grounding uses final content, diagnoses incomplete replies, and sends a configurable output budget", async t => {
	let answer: unknown, seenTokens: number | undefined;
	const server = createServer((req, res) => {
		let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
			seenTokens = (JSON.parse(body) as { max_tokens: number }).max_tokens;
			res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const options = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "fixture" };
	const image = { png: Buffer.from("fixture"), width: 400, height: 300 };
	const reply = (content: unknown, finish_reason: string = "stop", reasoning_content?: string) => ({ choices: [{ finish_reason, message: { content, reasoning_content } }] });
	try {
		await t.test("the complete final action is parsed before the display text is shortened", async () => {
			answer = reply(`Thought: ${"The example coordinate (1,2) is not the target. ".repeat(20)}\nAction: click(start_box='(140,56)')`, "stop", "click(start_box='(5,6)')");
			const found = await locate(options, image, "play");
			assert.deepEqual(found.point, [140, 56]);
			assert.equal(found.reply.length, 500);
			assert.equal(seenTokens, 256);
			await locate({ ...options, maxTokens: 512, timeoutMs: 1000 }, image, "play");
			assert.equal(seenTokens, 512);
		});
		await t.test("only an explicit none means the target is absent", async () => {
			for (const content of [" none \n", "Thought: click(start_box='(1,2)') is only an example.\nAction: none"]) {
				answer = reply(content);
				assert.equal((await locate(options, image, "play")).point, null);
			}
		});
		await t.test("length is an error even if a coordinate appears before truncation", async () => {
			for (const content of ["", "click(start_box='(140,56)')"]) {
				answer = { ...reply(content, "length", "private reasoning"), usage: { completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 64 } } };
				await assert.rejects(locate(options, image, "play"), error => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /truncated.*finish_reason=length/);
					assert.match(error.message, /output tokens: 64, reasoning tokens: 64, reasoning characters: 17/);
					assert.doesNotMatch(error.message, /private reasoning/);
					return true;
				});
			}
		});
		await t.test("reasoning-only replies never supply a point", async () => {
			for (const content of [null, "", " \n"]) {
				answer = reply(content, "stop", "click(start_box='(5,6)')");
				await assert.rejects(locate(options, image, "play"), /empty final content.*does not mean the target is absent/);
			}
		});
		await t.test("bad, ambiguous, out-of-image and non-text replies cannot become a marker", async () => {
			for (const content of ["I cannot see it", "click(start_box='(900,56)')", "click(start_box='(1,2)') or click(start_box='(3,4)')", "Action: click(start_box='(1,2)')\nAction: none", "none\nclick(start_box='(1,2)')", { text: "(1,2)" }]) {
				answer = reply(content);
				await assert.rejects(locate(options, image, "play"), /invalid|ambiguous/);
			}
		});
		await t.test("abnormal completion and malformed envelopes are rejected", async () => {
			answer = reply("click(start_box='(1,2)')", "content_filter");
			await assert.rejects(locate(options, image, "play"), /did not finish normally/);
			for (answer of [null, {}, { choices: [] }, { choices: [null] }, { choices: [{}, {}] }]) await assert.rejects(locate(options, image, "play"), /invalid response/);
		});
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("grounding validates limits before sending and obeys its request deadline", async () => {
	let requests = 0;
	const server = createServer(() => { requests++; });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const options = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "fixture" };
	const image = { png: Buffer.from("fixture"), width: 400, height: 300 };
	try {
		for (const [key, maximum] of [["maxTokens", 4096], ["timeoutMs", 120_000]] as const) {
			for (const value of [null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, maximum + 1]) {
				await assert.rejects(locate({ ...options, [key]: value } as GroundingOptions, image, "play"), new RegExp(key));
			}
		}
		assert.equal(requests, 0);
		await assert.rejects(locate({ ...options, timeoutMs: 50 }, image, "play"), { name: "TimeoutError" });
		assert.equal(requests, 1);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("screen_look locate asks the configured model with the clean image and marks its point", async () => {
	let seen: { model?: string; hasImage?: boolean; text?: string | undefined } = {};
	let finishReason = "stop";
	const server = createServer((req, res) => {
		let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
			const parsed = JSON.parse(body) as { model: string; messages: { content: { type: string; image_url?: { url: string }; text?: string }[] }[] };
			seen = { model: parsed.model, hasImage: parsed.messages[0]!.content.some(c => c.image_url?.url.startsWith("data:image/png;base64,")), text: parsed.messages[0]!.content.find(c => c.type === "text")?.text };
			res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: "click(start_box='(140,56)')" } }] }));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	try {
		const window = { role: "window", name: "Timeline", value: null, description: null, stableId: null, actions: [], bounds: { x: 0, y: 0, width: 200, height: 150 }, visible: true, enabled: true, focused: false, selected: false, checked: null, expanded: null, editable: false, raw: {}, children: async () => [] } as unknown as UiElement;
		const app: UiApp = { name: "Editor", pid: 9, isForeground: false, windows: async () => [window] };
		const capture: Capture = { width: 400, height: 300, pixels: Buffer.alloc(400 * 300 * 4, 80), desktopRectToImage: r => [{ x: r.x * 2, y: r.y * 2, width: r.width * 2, height: r.height * 2 }], imageToDesktop: (x, y) => [x / 2, y / 2] };
		const d = { apps: async () => [app], captureWindow: async () => capture, pointer: async () => {}, key: async () => {}, showCursor: async () => {}, ownPids: () => [], prepare: async () => {},
			clipboardSet: async () => {}, clipboardRestore: async () => {}, installedApps: async () => [], launch: async () => {}, menus: async () => [], pressMenu: async () => {} } as Desktop;
		const t = Object.fromEntries(createComputerTools({ desktop: async () => d, apps: { Editor: "act" }, imageInput: true, cursor: false,
			grounding: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "ui-tars-1.5-7b" } }).map(x => [x.name, x]));
		const ctx = (): ToolContext => ({ workspace: new Workspace(process.cwd()), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c", approve: async () => "allow" });
		const looked = await t.screen_look!.execute({ app: "Editor", locate: "the play button" }, ctx());
		assert.equal(looked.ok, true, looked.modelContent);
		assert.match(looked.modelContent, /put "the play button" at x 140, y 56 in this image/);
		assert.deepEqual(seen, { model: "ui-tars-1.5-7b", hasImage: true, text: seen.text });
		assert.match(seen.text ?? "", /find: the play button/);
		finishReason = "length";
		const incomplete = await t.screen_look!.execute({ app: "Editor", locate: "the play button" }, ctx());
		assert.equal(incomplete.ok, false);
		assert.match(incomplete.modelContent, /truncated/);
		assert.doesNotMatch(incomplete.modelContent, /put "the play button"|did not find/);
		const none = Object.fromEntries(createComputerTools({ desktop: async () => d, apps: { Editor: "act" }, imageInput: true, cursor: false }).map(x => [x.name, x]));
		const refused = await none.screen_look!.execute({ app: "Editor", locate: "x" }, ctx());
		assert.equal(refused.ok, false); assert.match(refused.modelContent, /no grounding model is configured/);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
