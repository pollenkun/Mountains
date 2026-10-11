import type { Usage } from "@mountains/protocol";
import type { ProviderId } from "./capabilities.ts";

/** 支持的原始 usage 字段的并集（只列出用到的字段） */
export interface RawUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	/** DeepSeek */
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	/** 智谱、Moonshot：cached_tokens；Moonshot 另有 cache_write_tokens */
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
	/** Moonshot 旧字段（顶层） */
	cached_tokens?: number;
	completion_tokens_details?: { reasoning_tokens?: number } | null;
	/** OpenRouter 官方响应中本次请求的实际 USD 费用；必须由官方适配器另行验证。 */
	cost?: number;
}

/** @deprecated 使用 RawUsage */
export type DeepSeekRawUsage = RawUsage;

const EMPTY: Usage = { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total: null, partial: true };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * 原始 usage → 账本四项（D-008）。普通输入 = 未命中且未写入缓存的部分；缓存读取 = 命中；输出含推理。
 * - DeepSeek：命中/未命中两个字段；没有缓存写入口径（null，不是 0）。
 * - 智谱：prompt_tokens 含命中；命中 = prompt_tokens_details.cached_tokens；没有写入口径。
 * - Moonshot：命中、写入、未缓存三者互斥，之和 = prompt_tokens（官方缓存页）。
 */
export function normalizeUsage(provider: ProviderId, raw: RawUsage | null | undefined): Usage {
	if (!raw) return { ...EMPTY };
	const prompt = num(raw.prompt_tokens);
	const out = num(raw.completion_tokens);
	let hit: number | undefined;
	let miss: number | undefined;
	let write: number | null = null;
	if (provider === "deepseek") {
		hit = num(raw.prompt_cache_hit_tokens) ?? num(raw.prompt_tokens_details?.cached_tokens);
		miss = num(raw.prompt_cache_miss_tokens) ?? (prompt !== undefined && hit !== undefined ? prompt - hit : undefined);
	} else if (provider === "zhipu") {
		hit = num(raw.prompt_tokens_details?.cached_tokens);
		// 智谱在无命中时可能省略 prompt_tokens_details；有 prompt_tokens 时按 0 命中处理
		if (hit === undefined && prompt !== undefined && raw.prompt_tokens_details == null) hit = 0;
		miss = prompt !== undefined && hit !== undefined ? prompt - hit : undefined;
	} else if (provider === "moonshot") {
		hit = num(raw.prompt_tokens_details?.cached_tokens) ?? num(raw.cached_tokens);
		if (hit === undefined && prompt !== undefined && raw.prompt_tokens_details == null) hit = 0;
		write = num(raw.prompt_tokens_details?.cache_write_tokens) ?? 0;
		miss = prompt !== undefined && hit !== undefined ? prompt - hit - write : undefined;
	} else if (provider === "siliconflow") {
		// 硅基官方兼容接口提供命中/未命中字段，未给出时才读取标准字段。
		hit = num(raw.prompt_cache_hit_tokens) ?? num(raw.prompt_tokens_details?.cached_tokens);
		miss = num(raw.prompt_cache_miss_tokens) ?? (prompt !== undefined && hit !== undefined ? prompt - hit : undefined);
	} else {
		// OpenAI 标准：缓存属于 prompt_tokens，不能复用 Moonshot 的缓存写入口径。
		// 没有 cached_tokens 时仍然未知，不能把一次未知的账单当成零缓存。
		hit = num(raw.prompt_tokens_details?.cached_tokens);
		miss = prompt !== undefined && hit !== undefined ? prompt - hit : undefined;
	}
	const total = num(raw.total_tokens) ?? (prompt !== undefined && out !== undefined ? prompt + out : undefined);
	const u: Usage = {
		input: miss ?? null,
		cacheRead: hit ?? null,
		cacheWrite: write,
		output: out ?? null,
		reasoning: num(raw.completion_tokens_details?.reasoning_tokens) ?? null,
		total: total ?? null,
		partial: false,
	};
	// Native hit/miss fields must still agree with the provider's prompt total.
	// A matching total_tokens alone cannot make contradictory cheaper parts known.
	u.partial = u.input === null || u.cacheRead === null || u.output === null
		|| prompt !== undefined && miss !== undefined && hit !== undefined && miss + hit + (write ?? 0) !== prompt;
	return u;
}

export function normalizeDeepSeekUsage(raw: RawUsage | null | undefined): Usage {
	return normalizeUsage("deepseek", raw);
}

/** 各项之和应等于 total_tokens；不一致时返回说明（账本标记异常） */
export function usageInconsistency(u: Usage): string | null {
	if (u.input === null || u.cacheRead === null || u.output === null || u.total === null) return null;
	const sum = u.input + u.cacheRead + (u.cacheWrite ?? 0) + u.output;
	return sum === u.total ? null : `input+cacheRead+cacheWrite+output=${sum} ≠ total=${u.total}`;
}
