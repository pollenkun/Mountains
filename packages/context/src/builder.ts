import { createHash } from "node:crypto";
import type { AssistantMessage, Message, ToolSpec } from "@mountains/protocol";
import { chainHash, estimateTokens, shortHash } from "./tokens.ts";

export type SegmentKind = "system" | "tools" | "memory" | "history" | "file_content" | "tool_output" | "masked_placeholder" | "overhead";

export interface Segment {
	kind: SegmentKind;
	/** 在 messages 中的下标（历史类段） */
	index?: number;
	tokensEst: number;
	hash: string;
	masked?: boolean;
}

export interface MaskingConfig {
	enabled: boolean;
	/**
	 * threshold（默认）：估算上下文达到 triggerTokens 时，遮蔽除最近 K 个之外的全部工具结果。
	 * price-aware：每个请求前评估"年龄 ≥ minAgeTurns 轮、≥ minResultTokens 的旧工具结果"，
	 * 当"省下的携带成本 > 断点之后一次性重算的未命中成本 × safety"时批量遮蔽。
	 */
	policy?: "threshold" | "price-aware";
	/** price-aware：工具结果被模型看过至少这么多轮才可遮蔽 */
	minAgeTurns?: number;
	/** price-aware：小于该估算 token 的结果不遮蔽 */
	minResultTokens?: number;
	/** price-aware：缓存命中价 ÷ 未命中价，由引擎按模型价格表填入 */
	hitMissRatio?: number;
	/** price-aware：收益须超过成本的倍数（≥ 1 更保守） */
	safety?: number;
	/** 估算上下文达到该值时触发一次分批遮蔽 */
	triggerTokens: number;
	/** 最近 K 个工具结果始终完整保留 */
	keepRecentToolResults: number;
	/** 一批至少遮蔽这么多估算 token，否则不修订（避免为小收益破坏缓存） */
	minBatchTokens: number;
	/** 硬保护：估算输入 + 预留输出 + 工具余量超过该值时强制遮蔽 */
	hardLimitTokens: number;
	/**
	 * 硬保护改用"上一次请求的实际输入 token + 之后新增内容的估算"来判断窗口压力，而不是整段上下文的字符估算。
	 * 字符估算可能偏高，因此可使用最近一次实际用量与增量估算减少不必要的整段遮蔽。
	 */
	exactTrigger?: boolean;
	/**
	 * 兜底换版：硬保护遮蔽腾不出空间（或同一阶段已经遮蔽过一次又到上限）时，把最早的若干完整交互组
	 * （一条助手回复连同它的全部工具结果，包含思考）整体移出，换成程序生成的执行记录。用户原话原样保留。
	 */
	rebase?: boolean;
	/** 换版后的目标估算输入，默认 24,576 */
	rebaseTargetTokens?: number;
	/** 新的主动换版只给建议；这些预估必须由调用方明确提供，不从已完成轮数猜测。 */
	priceShadow?: PriceShadowAssumptions;
}

export interface PriceShadowAssumptions {
	/** 显式场景假设：这些后续请求都能按给定缓存价携带旧文；不是任务预测。 */
	expectedRemainingTurns: number;
	/** 所有新增输入的累计估计，含取回、后续重复携带和重试；未知时不应填零。 */
	recoveryInputTokens: number;
	/** 所有新增计费输出的累计估计，含推理、整理和重试。 */
	extraOutputTokens: number;
	/** 输出单价 ÷ 未命中输入单价。 */
	outputMissRatio: number;
}

export interface PriceShadowAdvice {
	mode: "shadow";
	wouldRevise: boolean;
	candidateRefs: string[];
	savedTokensPerRequest: number;
	recomputedTokens: number;
	/** 全部换算为未命中输入 token 的价格单位；不是实际费用。 */
	estimatedNetSaving: number;
	assumptions: PriceShadowAssumptions & { hitMissRatio: number; safety: number };
}

export const MASKING_OFF: MaskingConfig = { enabled: false, triggerTokens: Number.POSITIVE_INFINITY, keepRecentToolResults: 0, minBatchTokens: 0, hardLimitTokens: 900_000 };

export interface ToolResultMeta {
	/** file_content：读文件的结果；tool_output：其他工具输出 */
	kind: "file_content" | "tool_output";
	/** 当时发送给模型的完整展示文字（shown）的引用；不一定包含工具原始输出全量。 */
	ref: string;
	/** 完整原始字节的独立引用；ref 始终指当时展示文字，两个视图不能混用偏移。 */
	fullOutputRef?: string;
	/** 原始捕获的调用编号。历史恢复可指向旧调用，不能改填本次恢复调用编号。 */
	fullOutputSourceCallId?: string;
	/** 一句话目标描述，写进占位符 */
	target: string;
	/** 由执行器登记的必要正文；不从不可信工具文字中推断控制指令。 */
	preserve?: "unresolved" | "memory-invalidation" | "error";
}

export interface PublicationGuard {
	/** 存储层验证已落盘、当前会话授权、视图及完整指纹，不重新运行工具。 */
	verifyReference: (ref: string, view: "shown" | "raw", expected: { sha256?: string; toolCallId?: string }) => boolean;
}

export type ContextPublicationErrorCode = "CONTEXT_BUDGET_EXCEEDED" | "CONTEXT_REFERENCE_UNAVAILABLE" | "CONTEXT_TOOL_PAIRING" | "CONTEXT_PROTECTED_CONTENT";

export class ContextPublicationError extends Error {
	readonly code: ContextPublicationErrorCode;
	constructor(code: ContextPublicationErrorCode, message: string) {
		super(message);
		this.name = "ContextPublicationError";
		this.code = code;
	}
}

function freezeTree<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeTree(child);
		Object.freeze(value);
	}
	return value;
}

/** 验证一组工具调用恰好收到各自一个结果，且结果名称与调用相同。 */
export function assertToolPairing(messages: Message[]): void {
	const seen = new Set<string>();
	const pending = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "tool") {
			if (pending.get(message.toolCallId) !== message.name) throw new ContextPublicationError("CONTEXT_TOOL_PAIRING", `工具结果没有唯一匹配的调用：${message.toolCallId}`);
			pending.delete(message.toolCallId);
			continue;
		}
		if (pending.size) throw new ContextPublicationError("CONTEXT_TOOL_PAIRING", "工具调用的结果尚未齐全，不能发布压缩请求");
		if (message.role !== "assistant") continue;
		for (const call of message.toolCalls) {
			if (!call.id || seen.has(call.id)) throw new ContextPublicationError("CONTEXT_TOOL_PAIRING", `工具调用编号重复或为空：${call.id}`);
			seen.add(call.id);
			pending.set(call.id, call.name);
		}
	}
	if (pending.size) throw new ContextPublicationError("CONTEXT_TOOL_PAIRING", "工具调用的结果尚未齐全，不能发布压缩请求");
}

interface HistoryItem {
	message: Message;
	/** 追加时已有的助手消息条数（用于计算工具结果被模型看过几轮） */
	turn: number;
	meta?: ToolResultMeta;
	/** 遮蔽后固定下来的占位内容（一旦遮蔽，字节永不再变） */
	maskedContent?: string;
}

export interface ContextPlan {
	system: string;
	tools: ToolSpec[];
	messages: Message[];
	segments: Segment[];
	/** 与 segments 一一对应的累积前缀哈希 */
	prefixHashes: string[];
	totalTokensEst: number;
	revision: number;
}

export interface RevisionResult {
	reason: "threshold" | "hard-limit" | "price-aware" | "rebase";
	/** rebase：被整体移出活动上下文的完整交互组数（助手回复 + 它的全部工具结果） */
	removedGroups?: number;
	maskedRefs: string[];
	maskedIndices: number[];
	tokensBefore: number;
	tokensAfter: number;
}

/**
 * 占位符是确定性函数：只由元数据和原文长度决定，重复生成字节完全相同。
 * 写明如何取回：有取回工具时用引用取回当时的原文；否则文件内容重新读取、其他工具输出重新运行
 * （引用 ID 对应本地保存的原文，供审计与离线核对）。
 */
export function placeholderFor(name: string, meta: ToolResultMeta, originalTokens: number, expandTool?: string, archiveSearchTool?: string, leanRefs = false): string {
	const how = expandTool
		? meta.kind === "file_content"
			? `call ${expandTool} with this ref for the text shown then, or read the file again for its current contents`
			: `call ${expandTool} with this ref to see it again`
		: meta.kind === "file_content"
			? "read the file again if you need it"
			// 不提示"重新运行"：命令可能改文件或数据，重跑会重复副作用（GPT-6 Pro 上下文设计 v2 §5.3）
			: "not kept; re-run only a read-only command if you really need it, never repeat a command that changes files";
	const raw = meta.fullOutputRef ? ` | raw_ref=${meta.fullOutputRef} (complete captured bytes; use a separate range from shown)` : "";
	const search = expandTool && archiveSearchTool && name === "command_run" && meta.fullOutputRef && meta.fullOutputSourceCallId
		? ` | search original lines with ${archiveSearchTool} ref=${meta.fullOutputRef} toolCallId=${JSON.stringify(meta.fullOutputSourceCallId)}` : "";
	// leanRefs 且没有取回工具：引用只供审计，模型用不上，不写进占位符
	if (leanRefs && !expandTool) return `[earlier ${name} output removed to save context | ${meta.target} | ~${originalTokens} tokens | ${how}]`;
	return `[earlier ${name} output removed to save context | ${meta.target} | ~${originalTokens} tokens | ${how} | ref=${meta.ref}${raw}${search}]`;
}

/** 换版时由程序生成的执行记录：只列事实（改了哪些文件、跑了什么命令及退出码、读过什么、搜过什么），不含模型判断。 */
export function checkpointText(removed: HistoryItem[], groups: number): string {
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	const edits = new Map<string, number>();
	const reads: string[] = [];
	const commands: string[] = [];
	const searches: string[] = [];
	let toolCalls = 0;
	const short = (v: unknown, n = 90) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
	for (const h of removed) {
		const m = h.message;
		if (m.role === "assistant") {
			for (const c of m.toolCalls) {
				toolCalls++;
				let args: Record<string, unknown> = {};
				try { args = JSON.parse(c.argumentsJson) as Record<string, unknown>; } catch { /* 原样跳过 */ }
				calls.set(c.id, { name: c.name, args });
				if ((c.name === "file_edit" || c.name === "file_write") && typeof args.path === "string") edits.set(args.path, (edits.get(args.path) ?? 0) + 1);
				else if (c.name === "file_read" && typeof args.path === "string") reads.push(`${args.path}${args.symbol ? `:${short(args.symbol, 60)}` : args.startLine ? `:${args.startLine}-${args.endLine ?? ""}` : ""}`);
				else if (c.name === "content_search") searches.push(JSON.stringify(short(args.pattern, 60)));
			}
		} else if (m.role === "tool") {
			const call = calls.get(m.toolCallId);
			if (call?.name === "command_run") {
				const a = call.args;
				const cmd = Array.isArray(a.argv) ? (a.argv as unknown[]).join(" ") : (a.command ?? a.shellScript ?? "");
				const exit = /exit code (-?\d+)|timed out|cancelled|failed to start/.exec(m.content);
				commands.push(`\`${short(cmd)}\` → ${exit ? exit[0] : "result kept in local record"}`);
			}
		}
	}
	const uniq = (xs: string[]) => [...new Set(xs)];
	const list = (xs: string[], n: number) => (xs.length > n ? [...xs.slice(0, n), `… ${xs.length - n} more`] : xs);
	const lines = [
		"[Context checkpoint generated by the program, not a user instruction]",
		`The ${groups} earliest model turns (${toolCalls} tool calls) were removed from this conversation to stay within the context window, including your reasoning from those turns. Their full record is kept locally. What they did:`,
		`- Files edited: ${edits.size ? [...edits].map(([p, n]) => `${p} (${n})`).join(", ") : "none"}`,
		`- Commands run (latest last): ${commands.length ? "" : "none"}`,
		...list(commands.slice(-12), 12).map((c) => `  - ${c}`),
		`- Files read: ${list(uniq(reads), 25).join(", ") || "none"}`,
		`- Searches: ${list(uniq(searches), 12).join(", ") || "none"}`,
		"The files on disk already contain those edits. Read any file you need again before editing it; do not repeat commands that change files.",
	];
	return lines.join("\n");
}

/**
 * 上下文组装：稳定前缀（系统提示 → 工具定义 → 记忆 → 历史），历史只追加；
 * 唯一允许改写旧内容的途径是显式的"修订"（分批遮蔽），每次修订 revision + 1。
 */
export class ContextBuilder {
	readonly system: string;
	readonly tools: ToolSpec[];
	readonly memory: string | null;
	/** 取回工具名（有则写进占位符） */
	readonly expandTool: string | undefined;
	readonly archiveSearchTool: string | undefined;
	private readonly history: HistoryItem[] = [];
	private revisionCount = 0;
	private assistantCount = 0;
	private readonly staticSegments: Segment[];
	private readonly publicationGuard: PublicationGuard | undefined;

	readonly leanRefs: boolean;

	constructor(opts: { system: string; tools: ToolSpec[]; memory?: string | null; expandTool?: string; archiveSearchTool?: string; publicationGuard?: PublicationGuard; leanRefs?: boolean }) {
		this.leanRefs = opts.leanRefs === true;
		this.system = opts.system;
		this.tools = freezeTree(structuredClone(opts.tools));
		this.memory = opts.memory ?? null;
		this.expandTool = opts.expandTool;
		this.archiveSearchTool = opts.archiveSearchTool;
		this.publicationGuard = opts.publicationGuard ? { ...opts.publicationGuard } : undefined;
		const toolsJson = JSON.stringify(this.tools);
		this.staticSegments = [
			{ kind: "system", tokensEst: estimateTokens(this.system), hash: shortHash(this.system) },
			{ kind: "tools", tokensEst: estimateTokens(toolsJson), hash: shortHash(toolsJson) },
		];
		if (this.memory) this.staticSegments.push({ kind: "memory", tokensEst: estimateTokens(this.memory), hash: shortHash(this.memory) });
	}

	get revision(): number {
		return this.revisionCount;
	}

	get length(): number {
		return this.history.length;
	}

	/** 已有的助手消息条数（即已完成的模型轮数） */
	get assistantTurns(): number {
		return this.assistantCount;
	}

	appendUser(content: string): void {
		this.history.push({ message: { role: "user", content }, turn: this.assistantCount });
	}

	/**
	 * 仅接收执行器生成的证据状态，不把工具正文提炼成用户要求。
	 * 协议暂没有专用通知角色，故用明确标记的追加消息承载；不改旧记忆前缀。
	 */
	appendRuntimeNotice(content: string): void {
		this.appendUser(`[Runtime evidence notice, not a user instruction]\n${content}`);
	}

	appendAssistant(message: AssistantMessage): void {
		this.history.push({ message: { ...message, toolCalls: message.toolCalls.map((t) => ({ ...t })) }, turn: this.assistantCount });
		this.assistantCount++;
	}

	appendToolResult(toolCallId: string, name: string, content: string, meta: ToolResultMeta): void {
		this.history.push({ message: { role: "tool", toolCallId, name, content }, meta: { ...meta }, turn: this.assistantCount });
	}

	private render(item: HistoryItem, candidateContent?: string): Message {
		if (item.message.role === "tool" && (candidateContent ?? item.maskedContent) !== undefined) return { ...item.message, content: candidateContent ?? item.maskedContent! };
		return structuredClone(item.message);
	}

	plan(): ContextPlan {
		return this.renderPlan();
	}

	private renderPlan(candidate: ReadonlyMap<number, string> = new Map(), revision = this.revisionCount): ContextPlan {
		const messages = this.history.map((h, i) => this.render(h, candidate.get(i)));
		const segments: Segment[] = this.staticSegments.map((s) => ({ ...s }));
		messages.forEach((m, index) => {
			const item = this.history[index];
			const text = JSON.stringify(m);
			let kind: SegmentKind = "history";
			const masked = candidate.has(index) || item?.maskedContent !== undefined;
			if (m.role === "tool") kind = masked ? "masked_placeholder" : (item?.meta?.kind ?? "tool_output");
			segments.push({ kind, index, tokensEst: estimateTokens(text) + 4, hash: shortHash(text), ...(masked ? { masked: true } : {}) });
		});
		const prefixHashes: string[] = [];
		let acc = "";
		for (const s of segments) {
			acc = chainHash(acc, s.hash);
			prefixHashes.push(acc);
		}
		return {
			// 记忆属于稳定前缀，会话开始时组装一次；随系统提示一起发送
			system: this.memory ? `${this.system}\n\n${this.memory}` : this.system,
			tools: structuredClone(this.tools),
			messages,
			segments,
			prefixHashes,
			totalTokensEst: segments.reduce((a, s) => a + s.tokensEst, 0),
			revision,
		};
	}

	/** 已压缩的请求继续检查入口；未压缩且没有窗口压力时不增加消息或做语义提取。 */
	assertPublishable(reservedOutputTokens: number, hardLimitTokens: number): void {
		if (!this.publicationGuard) return;
		const plan = this.plan();
		if (this.revisionCount > 0) this.validateCandidate(plan, new Map(), reservedOutputTokens, hardLimitTokens);
		else this.assertFits(plan, reservedOutputTokens, hardLimitTokens);
	}

	private assertFits(plan: ContextPlan, reservedOutputTokens: number, hardLimitTokens: number): void {
		if (!Number.isFinite(reservedOutputTokens) || reservedOutputTokens < 0 || !(hardLimitTokens > 0) || plan.totalTokensEst + reservedOutputTokens > hardLimitTokens) {
			throw new ContextPublicationError("CONTEXT_BUDGET_EXCEEDED", `必要正文与预留输出超过上下文上限：${plan.totalTokensEst} + ${reservedOutputTokens} > ${hardLimitTokens}`);
		}
	}

	private validateCandidate(plan: ContextPlan, candidate: ReadonlyMap<number, string>, reservedOutputTokens: number, hardLimitTokens: number): void {
		assertToolPairing(plan.messages);
		for (let i = 0; i < this.history.length; i++) {
			const item = this.history[i]!;
			// 保留全部用户原话与助手记录，以及显式登记的错误、未解事项和记忆作废通知。
			// 这是结构保护，不声称已识别所有自然语言要求。
			if (item.message.role !== "tool" || item.meta?.preserve) {
				if (JSON.stringify(plan.messages[i]) !== JSON.stringify(item.message)) throw new ContextPublicationError("CONTEXT_PROTECTED_CONTENT", `必要内容不能被遮蔽：消息 ${i}`);
			}
			if (!candidate.has(i) && item.maskedContent === undefined) continue;
			const meta = item.meta;
			if (!this.expandTool || !this.tools.some((t) => t.name === this.expandTool)) throw new ContextPublicationError("CONTEXT_REFERENCE_UNAVAILABLE", "没有可调用的历史取回工具，不能移走正文");
			try {
				const shown = { sha256: createHash("sha256").update(item.message.content).digest("hex") };
				const raw = meta?.fullOutputSourceCallId === undefined ? {} : { toolCallId: meta.fullOutputSourceCallId };
				if (!meta?.ref || !this.publicationGuard?.verifyReference(meta.ref, "shown", shown) || (meta.fullOutputRef !== undefined && !this.publicationGuard.verifyReference(meta.fullOutputRef, "raw", raw))) throw new Error("reference unavailable");
			} catch {
				throw new ContextPublicationError("CONTEXT_REFERENCE_UNAVAILABLE", `历史归档不可验证，保留原上下文：消息 ${i}`);
			}
		}
		this.assertFits(plan, reservedOutputTokens, hardLimitTokens);
	}

	/**
	 * 分批遮蔽（CachePlanner 决策后调用）：一次性遮蔽除最近 K 个之外所有尚未遮蔽的工具输出。
	 * 遮蔽量不足 minBatchTokens 时不修订（硬保护除外）。
	 */
	maskOlderToolResults(cfg: MaskingConfig, reason: RevisionResult["reason"], reservedOutputTokens = 0): RevisionResult | null {
		const toolIdx = this.history.map((h, i) => (h.message.role === "tool" ? i : -1)).filter((i) => i >= 0);
		const keep = new Set(toolIdx.slice(Math.max(0, toolIdx.length - cfg.keepRecentToolResults)));
		const candidates = toolIdx.filter((i) => !keep.has(i) && this.history[i]?.maskedContent === undefined && this.history[i]?.meta && !this.history[i]?.meta?.preserve);
		return this.maskIndices(candidates, cfg, reason, reservedOutputTokens);
	}

	private priceCandidates(cfg: MaskingConfig): { indices: number[]; saved: number } {
		const indices: number[] = [];
		let saved = 0;
		this.history.forEach((h, i) => {
			if (h.message.role !== "tool" || h.maskedContent !== undefined || !h.meta || h.meta.preserve) return;
			if (this.assistantCount - h.turn < (cfg.minAgeTurns ?? 2)) return;
			const original = estimateTokens(h.message.content);
			if (original < (cfg.minResultTokens ?? 200)) return;
			const delta = original - estimateTokens(placeholderFor(h.message.name, h.meta, original, this.expandTool, this.archiveSearchTool, this.leanRefs));
			if (delta <= 0) return;
			indices.push(i);
			saved += delta;
		});
		return { indices, saved };
	}

	/** 新控制器只给离线建议，永不发布候选；未来轮数、取回与新增输出均为显式假设。 */
	priceShadowAdvice(cfg: MaskingConfig): PriceShadowAdvice | null {
		const a = cfg.priceShadow;
		const r = cfg.hitMissRatio;
		const safety = cfg.safety ?? 1;
		if (!a || r === undefined || !(r > 0 && r < 1) || !Number.isFinite(safety) || safety < 1 || [a.expectedRemainingTurns, a.recoveryInputTokens, a.extraOutputTokens, a.outputMissRatio].some((n) => !Number.isFinite(n) || n < 0)) return null;
		const { indices, saved } = this.priceCandidates(cfg);
		const first = indices[0];
		const after = first === undefined ? 0 : this.plan().segments.filter((s) => s.index !== undefined && s.index >= first).reduce((sum, s) => sum + s.tokensEst, 0);
		const recomputedTokens = Math.max(0, after - saved);
		const benefit = saved * r * a.expectedRemainingTurns;
		const cost = (recomputedTokens * (1 - r) + a.recoveryInputTokens + a.extraOutputTokens * a.outputMissRatio) * safety;
		return { mode: "shadow", wouldRevise: indices.length > 0 && benefit > cost, candidateRefs: indices.map((i) => this.history[i]!.meta!.ref), savedTokensPerRequest: saved, recomputedTokens, estimatedNetSaving: benefit - cost, assumptions: { ...a, hitMissRatio: r, safety } };
	}

	/**
	 * 价格感知淘汰（每个请求前评估）：候选为年龄 ≥ minAgeTurns、估算 ≥ minResultTokens 的未遮蔽工具结果。
	 * 收益 = 省下的 token × 命中价 × 预计剩余轮数（用已进行的轮数估计）；
	 * 成本 = 第一个候选之后的全部内容（遮蔽后）在下一个请求中由命中变为未命中的差价。
	 * 以"命中价 ÷ 未命中价"r 表示：省下 × r × 剩余 > 之后 × (1 − r) × safety 时遮蔽。
	 */
	maskByPrice(cfg: MaskingConfig, reservedOutputTokens = 0): RevisionResult | null {
		const r = cfg.hitMissRatio ?? 0;
		if (!(r > 0 && r < 1)) return null;
		const { indices: candidates, saved } = this.priceCandidates(cfg);
		if (candidates.length === 0) return null;
		const first = Math.min(...candidates);
		const plan = this.plan();
		const afterNow = plan.segments.filter((s) => s.index !== undefined && s.index >= first).reduce((a, s) => a + s.tokensEst, 0);
		const afterMasked = Math.max(0, afterNow - saved);
		const remaining = Math.max(1, this.assistantCount);
		if (saved * r * remaining <= afterMasked * (1 - r) * (cfg.safety ?? 1)) return null;
		return this.maskIndices(candidates, { ...cfg, minBatchTokens: 0 }, "price-aware", reservedOutputTokens);
	}

	private maskIndices(candidates: number[], cfg: MaskingConfig, reason: RevisionResult["reason"], reservedOutputTokens: number): RevisionResult | null {
		let saved = 0;
		const prepared: { i: number; content: string }[] = [];
		for (const i of candidates) {
			const item = this.history[i];
			if (!item?.meta || item.message.role !== "tool" || item.meta.preserve || item.maskedContent !== undefined) continue;
			const original = estimateTokens(item.message.content);
			const ph = placeholderFor(item.message.name, item.meta, original, this.expandTool, this.archiveSearchTool, this.leanRefs);
			const delta = original - estimateTokens(ph);
			if (delta <= 0) continue;
			saved += delta;
			prepared.push({ i, content: ph });
		}
		if (prepared.length === 0 || (reason === "threshold" && saved < cfg.minBatchTokens)) return null;
		const before = this.plan().totalTokensEst;
		const candidate = new Map(prepared.map((p) => [p.i, p.content]));
		const next = this.renderPlan(candidate, this.revisionCount + 1);
		if (this.publicationGuard) this.validateCandidate(next, candidate, reservedOutputTokens, cfg.hardLimitTokens);
		// 所有检查通过后一次发布。失败时正式历史、占位符和修订号保持原样。
		for (const p of prepared) {
			const item = this.history[p.i];
			if (item) item.maskedContent = p.content;
		}
		this.revisionCount++;
		return {
			reason,
			maskedRefs: prepared.map((p) => this.history[p.i]?.meta?.ref ?? ""),
			maskedIndices: prepared.map((p) => p.i),
			tokensBefore: before,
			tokensAfter: next.totalTokensEst,
		};
	}

	/**
	 * 兜底换版（rebase）：移出最早的若干完整交互组，直到估算输入不超过 targetTokens；至少保留最后一组。
	 * - 交互组 = 一条助手回复（含思考、正文、工具调用）+ 紧随其后的全部工具结果；整组移出，绝不留下删了思考的助手消息。
	 * - 被移出范围里的用户消息（含运行时通知）原样保留、保持顺序；任务原文在首组之前，不受影响。
	 * - 在保留部分之前插入一条程序生成的执行记录（不是用户指令），不调用模型。
	 * 原始内容不在这里删除：由调用方的事件记录与归档保存。
	 */
	rebase(targetTokens: number): RevisionResult | null {
		const starts: number[] = [];
		this.history.forEach((h, i) => { if (h.message.role === "assistant") starts.push(i); });
		if (starts.length < 2) return null;
		const before = this.plan().totalTokensEst;
		let chosen: { cut: number; items: HistoryItem[]; est: number } | null = null;
		for (let cut = 1; cut < starts.length; cut++) {
			const removedRange = this.history.slice(starts[0]!, starts[cut]!);
			const keptUsers = removedRange.filter((h) => h.message.role === "user");
			const removed = removedRange.filter((h) => h.message.role !== "user");
			const notice: HistoryItem = { message: { role: "user", content: checkpointText(removed, cut) }, turn: this.history[starts[cut]!]!.turn };
			const items = [...this.history.slice(0, starts[0]!), ...keptUsers, notice, ...this.history.slice(starts[cut]!)];
			const est = this.estimateItems(items);
			chosen = { cut, items, est };
			if (est <= targetTokens) break;
		}
		if (!chosen) return null;
		// 工具配对必须成立：保留部分从组边界开始，配对检查对新视图照常执行
		assertToolPairing(chosen.items.map((h) => this.render(h)));
		const removedGroups = chosen.cut;
		this.history.splice(0, this.history.length, ...chosen.items);
		this.revisionCount++;
		return { reason: "rebase", maskedRefs: [], maskedIndices: [], removedGroups, tokensBefore: before, tokensAfter: this.plan().totalTokensEst };
	}

	private estimateItems(items: HistoryItem[]): number {
		const stat = this.staticSegments.reduce((a, s) => a + s.tokensEst, 0);
		return stat + items.reduce((a, h) => a + estimateTokens(JSON.stringify(this.render(h))) + 4, 0);
	}
}

const EXACT_DELTA_FACTOR = 1.2;
const DEFAULT_REBASE_TARGET = 24_576;
const REBASE_MARGIN_TOKENS = 4_096;
const EXACT_MARGIN_TOKENS = 1024;

/** CachePlanner v0：只在达到阈值或触及硬保护时修订，两次修订之间前缀保持不变。 */
export class CachePlanner {
	readonly masking: MaskingConfig;

	/** 上一次请求：当时的估算、供应商报告的实际输入、当时的修订号 */
	private calibration: { est: number; actual: number; revision: number } | null = null;
	/** 上次换版以来做过几次硬保护遮蔽 */
	private masksSinceRebase = 0;

	constructor(masking: MaskingConfig = MASKING_OFF) {
		this.masking = masking;
	}

	/** 模型请求返回可信用量后调用：记下这次请求的估算值与实际输入 token。 */
	noteUsage(estAtRequest: number, revision: number, actualInputTokens: number): void {
		if (!Number.isSafeInteger(actualInputTokens) || actualInputTokens <= 0 || !(estAtRequest > 0)) return;
		this.calibration = { est: estAtRequest, actual: actualInputTokens, revision };
	}

	/**
	 * 窗口压力。开启 exactTrigger 且上一次请求之后没有修订时：实际输入 + 新增部分的估算 × 1.2 + 1024。
	 * 新增部分仍是估算，所以放大并留余量；其余情况退回整段估算。
	 */
	pressure(builder: ContextBuilder): number {
		const est = builder.plan().totalTokensEst;
		const c = this.calibration;
		if (!this.masking.exactTrigger || !c || c.revision !== builder.revision || est < c.est) return est;
		return c.actual + Math.ceil((est - c.est) * EXACT_DELTA_FACTOR) + EXACT_MARGIN_TOKENS;
	}

	/** 在组装请求前调用；需要修订时返回修订结果（已应用到 builder） */
	beforeRequest(builder: ContextBuilder, reservedOutputTokens: number): RevisionResult | null {
		const raw = builder.plan().totalTokensEst;
		const est = this.pressure(builder);
		let revision: RevisionResult | null = null;
		if (est + reservedOutputTokens >= this.masking.hardLimitTokens) {
			// 同一阶段（上次换版以来）只做一次硬保护遮蔽；再到上限、或遮蔽后仍然放不下，就换版
			if (!this.masking.rebase || this.masksSinceRebase === 0) {
				revision = builder.maskOlderToolResults({ ...this.masking, keepRecentToolResults: Math.max(1, this.masking.keepRecentToolResults) }, "hard-limit", reservedOutputTokens);
				if (revision) this.masksSinceRebase++;
			}
			const after = builder.plan().totalTokensEst;
			if (this.masking.rebase && (!revision || after + reservedOutputTokens >= this.masking.hardLimitTokens - Math.min(REBASE_MARGIN_TOKENS, Math.floor(this.masking.hardLimitTokens / 16)))) {
				const r = builder.rebase(this.masking.rebaseTargetTokens ?? DEFAULT_REBASE_TARGET);
				if (r) { revision = r; this.masksSinceRebase = 0; }
			}
		} else if (this.masking.enabled) {
			if (this.masking.policy === "price-aware") revision = builder.maskByPrice(this.masking, reservedOutputTokens);
			else if (est >= this.masking.triggerTokens) revision = builder.maskOlderToolResults(this.masking, "threshold", reservedOutputTokens);
		}
		// 新修订已在提交前完成检查，不在提交后再做一次可能失败的存储查询。
		// 发布检查按整段估算做；压力值与整段估算不同时，把差额折进上限，使两处判断一致。
		if (!revision) builder.assertPublishable(reservedOutputTokens, this.masking.hardLimitTokens + (raw - est));
		return revision;
	}

	shadowAdvice(builder: ContextBuilder): PriceShadowAdvice | null {
		return builder.priceShadowAdvice(this.masking);
	}
}
