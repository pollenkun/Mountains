import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import type { Message } from "@mountains/protocol";
import { ChatCompletionsAdapter } from "../src/index.ts";

const SSE = `data: ${JSON.stringify({ id: "r1", object: "chat.completion.chunk", model: "x", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
	usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 } })}\n\ndata: [DONE]\n\n`;
let server: http.Server;
let port = 0;
const bodies: { messages: { role: string; content: unknown }[] }[] = [];
before(async () => {
	server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(SSE);
	});
	await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
	port = (server.address() as { port: number }).port;
});
after(() => { server.closeAllConnections(); server.close(); });

const messages: Message[] = [
	{ role: "user", content: "look" },
	{ role: "assistant", content: "", reasoning: "r", toolCalls: [{ id: "c1", name: "screen_look", argumentsJson: '{"app":"Notes"}' }] },
	{ role: "tool", toolCallId: "c1", name: "screen_look", content: "[Image of Notes]", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=", width: 2, height: 2 }] },
];

test("a tool image reaches a model that accepts images, and is left out for a text-only model", async () => {
	const adapter = new ChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" });
	const base = { system: "s", tools: [{ name: "screen_look", description: "d", parameters: { type: "object" } }], messages, thinking: { enabled: false, effort: "default" as const }, maxTokens: 100 };
	assert.ok((await adapter.complete({ ...base, model: "deepseek-flash" })).ok);
	const withImage = JSON.stringify(bodies.at(-1));
	assert.match(withImage, /"image_url":\{"url":"data:image\/png;base64,iVBORw0KGgo="/);
	assert.ok(bodies.at(-1)!.messages.some(m => m.role === "tool" && JSON.stringify(m.content).includes("[Image of Notes]")));
	assert.ok((await adapter.complete({ ...base, model: "deepseek-v4-pro" })).ok);
	assert.doesNotMatch(JSON.stringify(bodies.at(-1)), /image_url|iVBORw0KGgo/);
});
