import { mkdirSync, writeFileSync } from "node:fs";

const dir = process.env.MOUNTAINS_CAPTURE_DIR;
let count = 0;

const usage = {
	prompt_tokens: 20,
	completion_tokens: 4,
	total_tokens: 24,
	prompt_tokens_details: { cached_tokens: 0 },
	completion_tokens_details: { reasoning_tokens: 0 },
	prompt_cache_hit_tokens: 0,
	prompt_cache_miss_tokens: 20,
};

const body = `data: ${JSON.stringify({
	id: "r1",
	object: "chat.completion.chunk",
	model: "deepseek-flash",
	choices: [{ index: 0, delta: { role: "assistant", content: "2。" }, finish_reason: null }],
})}\n\ndata: ${JSON.stringify({
	id: "r1",
	object: "chat.completion.chunk",
	model: "deepseek-flash",
	choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	usage,
})}\n\ndata: [DONE]\n\n`;

if (dir) mkdirSync(dir, { recursive: true });

globalThis.fetch = async (_input, init) => {
	if (dir && typeof init?.body === "string") {
		writeFileSync(`${dir}/${String(count).padStart(2, "0")}.txt`, init.body);
		count += 1;
	}
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};
