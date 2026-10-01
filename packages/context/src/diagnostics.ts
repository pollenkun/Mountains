import type { ContextPlan, Segment } from "./builder.ts";

export interface PrefixDiff {
	/** 第一个发生变化的段；null 表示前缀未变（只追加） */
	firstChanged: { position: number; kind: Segment["kind"]; index?: number } | null;
	/** 与上一轮相同的段数 */
	stableSegments: number;
	/** 候选原因（不虚构：只列出能从哈希对比直接得出的原因） */
	reasons: string[];
}

/** 对比相邻两轮的分段哈希，找出第一个变化的段并给出候选原因。 */
export function diffPlans(prev: ContextPlan | null, next: ContextPlan): PrefixDiff {
	if (!prev) return { firstChanged: null, stableSegments: 0, reasons: ["首个请求"] };
	const n = Math.min(prev.segments.length, next.segments.length);
	let pos = -1;
	for (let i = 0; i < n; i++) {
		if (prev.prefixHashes[i] !== next.prefixHashes[i]) {
			pos = i;
			break;
		}
	}
	if (pos === -1) {
		if (next.segments.length >= prev.segments.length) return { firstChanged: null, stableSegments: n, reasons: [] };
		pos = n;
	}
	const seg = next.segments[pos] ?? prev.segments[pos];
	const reasons: string[] = [];
	if (seg?.kind === "system") reasons.push("系统提示变化（动态内容进入前缀）");
	else if (seg?.kind === "tools") reasons.push("工具定义内容或顺序改变");
	else if (seg?.kind === "memory") reasons.push("记忆块变化");
	else if (next.revision !== prev.revision) reasons.push("上下文修订（分批遮蔽）");
	else if (next.segments.length < prev.segments.length) reasons.push("历史被截短");
	else reasons.push("历史内容被改写");
	return {
		firstChanged: seg ? { position: pos, kind: seg.kind, ...(seg.index !== undefined ? { index: seg.index } : {}) } : null,
		stableSegments: pos,
		reasons,
	};
}

/**
 * 缓存结果解读：前缀未变但缓存没命中时，只报告"可能过期或供应商侧原因"，不虚构原因。
 */
export function explainCacheMiss(diff: PrefixDiff, cacheReadTokens: number | null, promptTokens: number | null): string | null {
	if (cacheReadTokens === null || promptTokens === null) return "usage 未提供缓存字段";
	if (diff.firstChanged === null && diff.reasons.length === 0 && cacheReadTokens === 0) return "前缀未变但未命中：可能过期或供应商侧原因";
	if (diff.firstChanged) return `前缀在第 ${diff.firstChanged.position} 段（${diff.firstChanged.kind}）变化：${diff.reasons.join("；")}`;
	return null;
}
