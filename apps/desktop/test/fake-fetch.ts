/** Replayed model replies for the hidden-window tests; no real request leaves the machine. */
const USAGE = {
	prompt_tokens: 20,
	completion_tokens: 8,
	total_tokens: 28,
	prompt_tokens_details: { cached_tokens: 0 },
	completion_tokens_details: { reasoning_tokens: 0 },
	prompt_cache_hit_tokens: 0,
	prompt_cache_miss_tokens: 20,
};

function chunk(delta: Record<string, unknown>, finish: string | null, usage?: unknown): string {
	return `data: ${JSON.stringify({
		id: "r1",
		object: "chat.completion.chunk",
		model: "deepseek-flash",
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(usage ? { usage } : {}),
	})}\n\n`;
}

export function installDesktopFakeFetch(mode: string): void {
	let requests = 0;
	globalThis.fetch = async (_input, init) => {
		const signal = init?.signal ?? undefined;
		requests++;
		if (mode === "command" && requests === 1) {
			const call = chunk({ tool_calls: [{ index: 0, id: "call_echo", type: "function", function: { name: "command_run", arguments: JSON.stringify({ argv: ["echo", "hello from mountains"] }) } }] }, "tool_calls", USAGE);
			return new Response(`${call}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		if (mode === "partial") {
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					// Usage is included so a guarded run can still record the request. The stream stays open, with no finish reason, until the caller aborts.
					controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "先说到这里" }, null, USAGE)));
					const abort = () => controller.error(new DOMException("The operation was aborted.", "AbortError"));
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		const body = chunk({ role: "assistant", content: "这是 Mountains 的工作文件夹，用来放对话和任务。" }, null)
			+ chunk({}, "stop", USAGE)
			+ "data: [DONE]\n\n";
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}
