import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { createComputerTools } from "../packages/computer/src/tools.ts";
import { createWebTools, WebBrowser } from "../packages/computer/src/web.ts";
import { FileStateTracker, Workspace } from "@mountains/tools";

const consent = { granted: true };
const computer = createComputerTools({ apps: { "*": "act" }, cursor: false, settleMs: 250, consent });
const browser = new WebBrowser({ headless: false });
const web = createWebTools({ imageInput: false, browser, consent });
const tools = Object.fromEntries([...computer, ...web].map(tool => [tool.name, tool]));
const ctx = {
	workspace: new Workspace(new URL("..", import.meta.url).pathname),
	files: new FileStateTracker(),
	signal: new AbortController().signal,
	toolCallId: "op",
	approve: async () => "allow",
};
const rl = createInterface({ input: process.stdin });
const emit = (value) => writeSync(1, JSON.stringify(value) + "\n");
writeSync(1, "ready\n");
for await (const line of rl) {
	if (!line.trim()) continue;
	let req;
	try { req = JSON.parse(line); }
	catch (error) { emit({ ok: false, modelContent: String(error) }); continue; }
	const tool = tools[req.tool];
	if (!tool) { emit({ ok: false, modelContent: "no tool" }); continue; }
	try {
		const result = await tool.execute(req.args ?? {}, { ...ctx, signal: AbortSignal.timeout(req.timeout ?? 90000) });
		const { images, ...rest } = result;
		emit({ ...rest, imageCount: images?.length ?? 0 });
	} catch (error) {
		emit({ ok: false, modelContent: error instanceof Error ? error.message : String(error) });
	}
}
