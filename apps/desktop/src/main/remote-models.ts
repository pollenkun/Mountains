/** The model ids an OpenAI-compatible address lists at /v1/models. The key stays in the main process. */

export function modelsEndpoints(baseUrl: string): string[] {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//.test(base)) throw new Error("接口地址要以 http 或 https 开头");
	return base.endsWith("/v1") ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
}

export function modelIdsFrom(body: unknown): string[] {
	const record = body && typeof body === "object" ? body as { data?: unknown; models?: unknown } : {};
	const rows = Array.isArray(body) ? body : Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
	const ids = rows.map((row) => typeof row === "string" ? row : row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : "");
	return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 200))].sort((a, b) => a.localeCompare(b));
}

function failureText(text: string, status: number): string {
	try {
		const body = JSON.parse(text) as { error?: { message?: unknown } };
		if (typeof body.error?.message === "string" && body.error.message.trim()) return body.error.message.trim().slice(0, 200);
	} catch { /* the body was not JSON */ }
	return `模型列表没有返回（${status}）`;
}

/** Ids from the first address that answers. A missing /v1/models falls through to /models. */
export async function fetchModelIds(baseUrl: string, key: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string[]> {
	let missed = false;
	for (const url of modelsEndpoints(baseUrl)) {
		const response = await fetchImpl(url, {
			headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
			signal: AbortSignal.timeout(20_000),
		});
		const text = await response.text();
		if (response.status === 404) { missed = true; continue; }
		if (!response.ok) throw new Error(failureText(text, response.status));
		let body: unknown;
		try { body = JSON.parse(text); } catch { throw new Error("模型列表无法读取"); }
		const ids = modelIdsFrom(body);
		if (!ids.length) throw new Error("这个接口没有返回模型");
		return ids;
	}
	throw new Error(missed ? "这个接口没有模型列表" : "这个接口没有返回模型");
}
