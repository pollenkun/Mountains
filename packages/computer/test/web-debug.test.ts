import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateTracker, Workspace, type ToolContext } from "@mountains/tools";
import { createWebTools, WebBrowser } from "../src/web.ts";

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")].find(path => existsSync(path));

test("a page's console, errors and requests can be read, a later text waited for, and the page saved as a PDF", { timeout: 90_000, skip: CHROME ? false : "Google Chrome is not installed" }, async () => {
	const page = `<!doctype html><meta charset="utf-8"><title>Debug page</title><h1>Orders</h1><div id="late"></div>
<script>
console.log("hello from the page", 42);
console.warn("careful");
fetch("/api/orders").then(r => r.json()).then(j => console.log("orders", j.count));
fetch("/missing");
setTimeout(() => { document.getElementById("late").textContent = "Export finished"; }, 1500);
setTimeout(() => { throw new Error("boom in a timer"); }, 100);
</script>`;
	const server: Server = createServer((req, res) => {
		if (req.url === "/api/orders") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"count":3}'); return; }
		if (req.url === "/missing") { res.writeHead(404); res.end(); return; }
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as { port: number }).port;
	const profile = await mkdtemp(join(tmpdir(), "mountains-web-debug-")), workspace = await mkdtemp(join(tmpdir(), "mountains-web-debug-ws-"));
	const browser = new WebBrowser({ headless: true, profileDir: profile, idleMs: 400 });
	const t = Object.fromEntries(createWebTools({ browser, consent: { granted: true } }).map(tool => [tool.name, tool]));
	const ctx = (): ToolContext => ({ workspace: new Workspace(workspace), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c", approve: async () => "allow" });
	try {
		const opened = await t.web_read!.execute({ url: `http://127.0.0.1:${port}/`, wait_for: "Export finished", wait_ms: 10_000 }, ctx());
		assert.equal(opened.ok, true, opened.modelContent);
		assert.match(opened.modelContent, /The page now shows "Export finished"/);
		assert.match(opened.modelContent, /Export finished/);
		const debug = await t.web_read!.execute({ tab: opened.details?.tab, console: true, network: true, save_pdf: "out/page" }, ctx());
		assert.equal(debug.ok, true, debug.modelContent);
		assert.match(debug.modelContent, /log: hello from the page 42/);
		assert.match(debug.modelContent, /warning: careful/);
		assert.match(debug.modelContent, /log: orders 3/);
		assert.match(debug.modelContent, /exception: [^\n]*boom in a timer/);
		assert.match(debug.modelContent, /GET http:\/\/127\.0\.0\.1:\d+\/api\/orders → 200/);
		assert.match(debug.modelContent, /GET http:\/\/127\.0\.0\.1:\d+\/missing → 404/);
		const pdf = join(workspace, "out/page.pdf");
		assert.match(debug.modelContent, /Saved the page as a PDF/);
		assert.equal(readFileSync(pdf).subarray(0, 5).toString(), "%PDF-");
		const never = await t.web_read!.execute({ tab: opened.details?.tab, wait_for: "never shown", wait_ms: 600 }, ctx());
		assert.match(never.modelContent, /"never shown" did not appear within 1 s/);
		const outside = await t.web_read!.execute({ tab: opened.details?.tab, save_pdf: "/tmp/elsewhere.pdf" }, ctx());
		assert.equal(outside.ok, false); assert.match(outside.modelContent, /inside the workspace or the download folder/);
	} finally {
		await browser.close();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
		await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
	}
});
