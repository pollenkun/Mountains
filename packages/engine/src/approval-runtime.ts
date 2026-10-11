import { responseModelMatches, normalizeUsage, usageInconsistency, type ModelAdapter, type ModelRequest, type ModelResponse } from "@mountains/providers";
import type { Usage } from "@mountains/protocol";
import type { ApprovalSettings } from "./approval-settings.ts";

/** A judge cannot make a cancelled operation run by returning a late allow. */
export async function boundedApprovalResponse(adapter: ModelAdapter, request: ModelRequest, timeoutMs: number): Promise<ModelResponse> {
	const controller = new AbortController();
	const parent = request.signal;
	const startedAt = Date.now();
	const fail = (message: string): ModelResponse => ({
		ok: false, message: { role: "assistant", content: "", reasoning: "", toolCalls: [] },
		finishReason: null, responseModel: request.model, responseId: null, rawUsage: null,
		usage: normalizeUsage("deepseek", null), httpStatus: null, requestBody: null,
		startedAt, firstByteAt: null, finishedAt: Date.now(), error: { message, retryable: false }, retryAfterMs: null, aborted: true,
	});
	if (parent?.aborted) return fail("审批已取消");
	let finishAbort: (response: ModelResponse) => void = () => {};
	const interrupted = new Promise<ModelResponse>((resolve) => { finishAbort = resolve; });
	const onAbort = () => { controller.abort(); finishAbort(fail("审批已取消")); };
	parent?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => { controller.abort(); finishAbort(fail("审批超时，未执行操作")); }, timeoutMs);
	try {
		if (parent?.aborted) onAbort();
		const response = await Promise.race([
			Promise.resolve().then(() => controller.signal.aborted ? fail("审批已取消") : adapter.complete({ ...request, signal: controller.signal })).catch(() => fail("审批接口失败，扣费状态未知")),
			interrupted,
		]);
		return parent?.aborted || controller.signal.aborted ? fail("审批已取消或超时") : response;
	} finally { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); }
}

/** Amount is in the task's currency; native amount is retained for audit. */
export function trustworthyUsage(u: Usage): boolean {
	const count = (n: number | null) => n !== null && Number.isSafeInteger(n) && n >= 0;
	return !u.partial && [u.input, u.output, u.cacheRead, u.total].every(count)
		&& (u.cacheWrite === null || count(u.cacheWrite))
		&& (u.reasoning === null || count(u.reasoning) && u.reasoning <= u.output!)
		&& usageInconsistency(u) === null;
}

export function approvalCharge(settings: ApprovalSettings, response: ModelResponse): { amount: number; nativeAmount: number } | null {
	const u = response.usage;
	if (!trustworthyUsage(u) || response.responseModel !== null && !responseModelMatches(settings.model, response.responseModel)) return null;
	const p = settings.pricing;
	const nativeAmount = (u.input! * p.inputPerMillion + u.cacheRead! * (p.cacheReadPerMillion ?? p.inputPerMillion) + (u.cacheWrite ?? 0) * p.inputPerMillion + u.output! * p.outputPerMillion) / 1_000_000;
	const amount = nativeAmount * (settings.conversion?.rate ?? 1);
	return Number.isFinite(amount) && amount >= 0 ? { nativeAmount, amount } : null;
}
