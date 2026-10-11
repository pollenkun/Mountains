import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUsage, type ModelResponse, type RawUsage } from "@mountains/providers";
import { approvalCharge } from "../src/approval-runtime.ts";
import { validateApprovalSettings } from "../src/approval-settings.ts";

const rawUsage: RawUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
	prompt_tokens_details: { cached_tokens: 20 }, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80 };
function response(responseModel: string | null, extra: Partial<ModelResponse> = {}): ModelResponse {
	return { ok: true, message: { role: "assistant", content: "", reasoning: "", toolCalls: [] }, finishReason: "stop",
		responseModel, responseId: null, rawUsage, usage: normalizeUsage("openai", rawUsage), httpStatus: 200,
		requestBody: null, startedAt: 0, firstByteAt: null, finishedAt: 1, error: null, retryAfterMs: null, aborted: false, ...extra };
}
const openai = validateApprovalSettings({ model: "gpt-4.1-mini", maxCost: 1,
	pricing: { currency: "USD", inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 3, version: "explicit-approval-test" } }, "USD");

test("registered OpenAI approval snapshot uses the explicit approval prices instead of catalog prices", () => {
	const charge = approvalCharge(openai, response("gpt-4.1-mini-2025-04-14"));
	assert.deepEqual(charge, { nativeAmount: 0.0002, amount: 0.0002 });
	assert.deepEqual(charge, approvalCharge(openai, response("gpt-4.1-mini")));
});

for (const model of ["openai/gpt-4.1-mini", "openai/gpt-4.1-mini-2025-04-14", "gpt-4.1-mini-2026-10-03", "gpt-4.1-mini-other"] as const) {
	test(`approval response from an unregistered identity or other route remains unknown: ${model}`, () => {
		assert.equal(approvalCharge(openai, response(model)), null);
	});
}

test("a valid approval snapshot cannot make incomplete or inconsistent usage known", () => {
	const known = normalizeUsage("openai", rawUsage);
	assert.equal(approvalCharge(openai, response("gpt-4.1-mini-2025-04-14", { usage: { ...known, partial: true } })), null);
	assert.equal(approvalCharge(openai, response("gpt-4.1-mini-2025-04-14", { usage: { ...known, total: 999 } })), null);
	assert.equal(approvalCharge(openai, response("gpt-4.1-mini-2025-04-14", { rawUsage: null, usage: normalizeUsage("openai", null) })), null);
});

test("registered approval snapshots preserve an explicit cross-currency conversion", () => {
	const settings = validateApprovalSettings({ ...openai, conversion: { rate: 7, asOf: "2026-10-03" } }, "CNY");
	const charge = approvalCharge(settings, response("gpt-4.1-mini-2025-04-14"));
	assert.equal(charge?.nativeAmount, 0.0002);
	assert.ok(charge && Math.abs(charge.amount - 0.0014) < 1e-12);
});

for (const [model, returnedModel] of [
	["deepseek-flash", "deepseek-v4-flash"],
	["glm-5.3-flash", "glm-5.3-flash"],
	["kimi-k2.7-code", "kimi-k2.7-code"],
] as const) {
	test(`${model}: existing approval identity and configured-price formula are unchanged`, () => {
		const settings = validateApprovalSettings({ model, maxCost: 1,
			pricing: { currency: "USD", inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 3, version: "explicit-legacy-test" } }, "USD");
		assert.deepEqual(approvalCharge(settings, response(returnedModel)), { nativeAmount: 0.0002, amount: 0.0002 });
		assert.deepEqual(approvalCharge(settings, response(null)), { nativeAmount: 0.0002, amount: 0.0002 });
	});
}
