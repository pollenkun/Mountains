/**
 * Finding a described control in a window image with a grounding model (UI-TARS and similar), for windows whose
 * accessibility tree says little: canvases, timelines, game-like editors. Any OpenAI-compatible endpoint works, a
 * local one included (an MLX or llama.cpp server). The model only returns a point; Mountains still acts through
 * its own tools and checks the result.
 */
export interface GroundingOptions {
	/** OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1 */
	baseUrl: string;
	model: string;
	/** Environment variable holding the key, when the server needs one. */
	apiKeyEnv?: string;
	/** "image": the model answers in pixels of the image it was sent (UI-TARS-1.5); "thousandths": 0-1000 per axis (UI-TARS 1.0). */
	coordinates?: "image" | "thousandths";
	/** Total output budget, including reasoning when the server counts it: 1–4096, default 256. */
	maxTokens?: number;
	/** Request deadline: 1–120000 ms, default 120000. */
	timeoutMs?: number;
}
export interface GroundingImage { png: Buffer; width: number; height: number }

const PROMPT = (target: string) => `You are a GUI grounding model. In the screenshot, find: ${target}
Answer with exactly one action: click(start_box='(x,y)') where x,y is the point to click. If it is not visible, answer: none`;

function finalAnswer(reply: string): string | null {
	const labels = [...reply.matchAll(/(?:^|\n)[\t ]*Action:\s*/gi)];
	if (labels.length > 1) return null;
	const label = labels[0];
	return (label ? reply.slice(label.index! + label[0].length) : reply).trim();
}

/** One unambiguous click action (or a bare coordinate reply), as image pixels. */
export function parsePoint(reply: string, width: number, height: number, coordinates: "image" | "thousandths" = "image"): [number, number] | null {
	const answer = finalAnswer(reply);
	if (!answer) return null;
	const action = /^click\s*\(\s*start_box\s*=\s*(['"])(.*?)\1\s*\)$/s.exec(answer);
	const point = (action?.[2] ?? answer).trim().replace(/^<\|box_start\|>(.*?)<\|box_end\|>$/s, "$1");
	const match = /^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/.exec(point) ?? /^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*)?\]$/.exec(point);
	if (!match) return null;
	let x = Number(match[1]), y = Number(match[2]);
	if (coordinates === "thousandths") { x = x / 1000 * width; y = y / 1000 * height; }
	if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) return null;
	return [x, y];
}

export async function locate(options: GroundingOptions, image: GroundingImage, target: string, signal?: AbortSignal): Promise<{ point: [number, number] | null; reply: string; ms: number }> {
	const started = Date.now();
	const maxTokens = options.maxTokens === undefined ? 256 : options.maxTokens, timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
	for (const [name, value, limit] of [["maxTokens", maxTokens, 4096], ["timeoutMs", timeoutMs, 120_000]] as const) {
		if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new Error(`the grounding model's ${name} must be an integer from 1 to ${limit}`);
	}
	const key = options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined;
	if (options.apiKeyEnv && !key) throw new Error(`the grounding model's key variable ${options.apiKeyEnv} is not set`);
	const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify({ model: options.model, temperature: 0, max_tokens: maxTokens, messages: [{ role: "user", content: [
			{ type: "image_url", image_url: { url: `data:image/png;base64,${image.png.toString("base64")}` } },
			{ type: "text", text: PROMPT(target) },
		] }] }),
		signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
	});
	if (!response.ok) throw new Error(`the grounding model answered HTTP ${response.status}`);
	const body = await response.json() as { choices?: { finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown } }[];
		usage?: { completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } } } | null;
	if (!Array.isArray(body?.choices) || body.choices.length !== 1 || !body.choices[0]?.message) throw new Error("the grounding model returned an invalid response; no final answer was obtained");
	const choice = body.choices[0], content = choice.message!.content;
	const counts = [
		["output tokens", body.usage?.completion_tokens],
		["reasoning tokens", body.usage?.completion_tokens_details?.reasoning_tokens],
		["reasoning characters", typeof choice.message!.reasoning_content === "string" ? choice.message!.reasoning_content.length : undefined],
	].filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0);
	const usage = counts.length ? ` (${counts.map(([name, value]) => `${name}: ${value}`).join(", ")})` : "";
	if (choice.finish_reason === "length") throw new Error(`the grounding model's output was truncated (finish_reason=length); no final answer was obtained${usage}`);
	if (choice.finish_reason != null && choice.finish_reason !== "stop") throw new Error("the grounding model did not finish normally; no final answer was obtained");
	if (content == null || typeof content === "string" && !content.trim()) throw new Error(`the grounding model returned empty final content; this does not mean the target is absent${usage}`);
	if (typeof content !== "string") throw new Error("the grounding model returned invalid final content; expected a text answer");
	const point = parsePoint(content, image.width, image.height, options.coordinates);
	if (!point && !/^none$/i.test(finalAnswer(content) ?? "")) throw new Error("the grounding model returned an invalid or ambiguous point; expected one in-image click action or none");
	return { point, reply: content.slice(0, 500), ms: Date.now() - started };
}
