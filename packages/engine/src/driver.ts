import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ShadowCheckpoints, fileSha256 } from "@mountains/checkpoints";
import { CachePlanner, imageTokens, type ContextPlan, type ContextStateV1, ContextBuilder, ContextPublicationError, assertFitsWindow, assertToolPairing, checkpointArchiveRef, diffPlans, SKILL_NOTICE, estimateTokens, type ContextPolicy, type RevisionResult, toolTarget } from "@mountains/context";
import {
	type EngineEvent,
	type EngineEventType,
	type EventPayload,
	HIGH_PRIORITY_EVENTS,
	type Message,
	PROTOCOL_VERSION,
	type ToolCall,
	type Usage,
} from "@mountains/protocol";
import { completeWithExactInputGate, exactInputIdentity, type ExactInputEvidence, type ExactInputDispatch, responseModelMatches, verifiedBillingReceipt, currencyOf, type Currency, type EffortSetting, estimateCost, isUnbilledCatalogModel, type ModelAdapter, type ModelResponse, normalizeUsage, pricePeriod, pricingFor, worstCaseCost, capabilitiesFor } from "@mountains/providers";
import { Ledger, Recorder, redactValue, type ModelLedgerWitness } from "@mountains/telemetry";
import {
	type ApprovalRequest,
	BlobStore,
	SessionArchiveIndex,
	SESSION_SEARCH_LIMITS,
	type SessionRecordMetadata,
	createSessionSearchTool,
	createTaskNoteTool,
	createSkillTool,
	discoverSkills,
	modelSkills,
	renderSkillContent,
	skillBody,
	skillInvocation,
	skillMentions,
	skillPermission,
	type BuiltinSkill,
	type SkillEntry,
	type SkillPermission,
	type SkillRoot,
	generalTools,
	normalizeToolOptions,
	FileStateTracker,
	type Risk,
	type ToolContext,
	type ToolDefinition,
	type ToolOptions,
	type ToolResult,
	Workspace,
} from "@mountains/tools";
import { type ApprovalPolicy, BENCH_APPROVAL, BudgetExceeded, type BudgetGuard, matchRule } from "./policy.ts";
import { COMPACTION_REQUEST, DEFAULT_CONTEXT_POLICY, SYSTEM_PROMPT, TOOL_NOTES } from "./prompt.ts";
import { ApprovalInputError, buildApprovalRequest, parseApprovalStep, type ApprovalContextRequest, type ApprovalDecision, type ApprovalEvidence, type ApprovalFetchedItem, type RiskLevel } from "./model-approval.ts";
import { validateApprovalSettings, type ApprovalSettings } from "./approval-settings.ts";
import { snapshotApprovalAction } from "./approval-action.ts";
import { boundedApprovalResponse, approvalCharge, trustworthyUsage } from "./approval-runtime.ts";
import { inspectRepositoryBrief } from "./repository-brief.ts";
import { observationCopy, observationFailureCode, observeTool, observerTimeout, type ToolExecutionObserver, type ToolExecutionIdentity, type ToolResponseSource, type ToolExecutionInstant, type ToolObservationValue } from "./tool-observer.ts";

/** file_read 实际返回的行范围（大纲等没有行范围的结果返回空），供上下文判断旧读取是否已被覆盖。 */
function readLines(details: Record<string, unknown>): { lines?: { start: number; end: number } } {
	// A reference, outline or lossy display is not another copy of source evidence.
	if (details.deduped || details.outline || details.classOutline || details.invalidUtf8 || Number(details.longLines ?? 0) > 0) return {};
	const start = details.startLine, end = details.endLine, total = details.totalLines;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 1 || (end as number) < (start as number)) return {};
	const last = Number.isInteger(total) ? Math.min(end as number, total as number) : (end as number);
	if (last < (start as number)) return {};
	return { lines: { start: start as number, end: last } };
}

/** Tools can throw any JS value; formatting it must not skip real results and observer cleanup. */
function toolFailureMessage(error: unknown): string {
	try {
		const message = error instanceof Error ? error.message : String(error);
		return typeof message === "string" ? message : "Tool threw an unreadable error";
	} catch { return "Tool threw an unreadable error"; }
}

export interface RunLimits {
	maxTurns: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	/** 单次运行费用上限（按模型的计价币种） */
	maxCost: number;
	/** Includes retries. Optional for compatibility with earlier experiment configs. */
	maxRequests?: number;
	maxDurationMs?: number;
}

/** 默认值与 OpenCode 1.18.32 一致（session/retry.ts：初始 2 秒、倍数 2、无响应头时封顶 30 秒、最多重试 5 次） */
export interface RetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs?: number;
}

/** Ten automatic retries after the first attempt (user decision 2026-10-24), then the run pauses. */
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 11, baseDelayMs: 2000, maxDelayMs: 30_000 };

/** The longest delay a Node timer honours; a larger one fires after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647;
const timerDelay = (ms: number): number => Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_TIMER_MS) : MAX_TIMER_MS;

export function retryDelayMs(policy: RetryPolicy, attempt: number, retryAfterMs: number | null): number {
	// A server's wait longer than a timer can hold still means "wait", never "retry now".
	if (retryAfterMs !== null) return timerDelay(retryAfterMs);
	return timerDelay(Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs ?? Number.POSITIVE_INFINITY));
}

/** The most a request can cost; nothing for a model on this computer. */
function modelUnbilled(o: Pick<EngineOptions, "model" | "localModel">): boolean {
	return o.localModel === true || isUnbilledCatalogModel(o.model);
}

function worstCase(o: Pick<EngineOptions, "model" | "maxTokens" | "billingCurrency" | "localModel">, inputTokens: number): number {
	return modelUnbilled(o) ? 0 : worstCaseCost(o.model, inputTokens, o.maxTokens, o.billingCurrency);
}

export const DEFAULT_LIMITS: RunLimits = { maxTurns: 200, maxInputTokens: 20_000_000, maxOutputTokens: 1_000_000, maxCost: 1 };

export interface EngineOptions {
	workspace: string;
	/** Measure the context lines against this many tokens instead of the model's own window (for example 128k); at least 32768. */
	contextWindow?: number;
	/** 运行输出目录：recording.jsonl、ledger.jsonl、blobs/ */
	dataDir: string;
	adapter: ModelAdapter;
	model: string;
	/** Explicit opt-in currency. Omitted preserves legacy model pricing. */
	billingCurrency?: Currency;
	/** A model served on this computer, outside the price list: its requests cost nothing, so no cost is reserved or charged. */
	localModel?: boolean;
	/** Runtime user inputs affect the next request without cancelling this run. */
	allowInterjection?: boolean;
	/** Explicit pure-data snapshot export/restore; disabled for existing callers. */
	allowSessionSnapshots?: boolean;
	/** An agent started from another's conversation reads the same archive, so what was folded there can be opened here. */
	forkedFrom?: AgentSession;
	/** Desktop only: allow file, search and command cwd tools to resolve paths outside the default workspace folder. */
	allowOutsideWorkspace?: boolean;
	/**
	 * Desktop's 自动审批: the approval model stops what is wrong rather than allowing what is authorized and rates the
	 * risk. Reads and edits a checkpoint can undo skip it, and what the user approved is not asked again.
	 */
	lenientApproval?: boolean;
	thinking: { enabled: boolean; effort: EffortSetting };
	maxTokens: number;
	limits?: Partial<RunLimits>;
	/** 可重试错误（429、5xx、网络）的重试：有 Retry-After 时按它等待，否则指数退避，封顶 maxDelayMs */
	retry?: RetryPolicy;
	/** Context lines; the default folds from 60% of the window and compacts from 90%. */
	contextPolicy?: ContextPolicy;
	verbatimToolArguments?: boolean;
	userId?: string;
	/** Replaces the built-in system prompt; the tool notes are still appended. */
	systemPrompt?: string;
	/** The user's AGENTS.md text, already assembled by the host; absent or empty adds nothing to the request. */
	instructions?: string;
	tools?: ToolDefinition[];
	/** Host tools after the built-in ones (memory_search when memory is on); absent adds nothing. */
	extraTools?: ToolDefinition[];
	/** 工具选项（例如读取行数上限）；给出 tools 时忽略 */
	toolOptions?: ToolOptions;
	/**
	 * Skills: directories to search (earlier ones win a name), built-in skills, which tool-bearing
	 * built-in skills to turn on, and allow/ask/deny by name pattern. Without any skill the model sees
	 * no skill tool, so requests stay exactly as before.
	 */
	skills?: { roots?: SkillRoot[]; builtin?: BuiltinSkill[]; enable?: string[]; permissions?: Record<string, SkillPermission> };
	/** Project-scoped archive directory outside the task checkout (folded and compacted originals). */
	archiveDir?: string;
	approval?: ApprovalPolicy;
	/** 交互模式下询问用户；非交互模式不提供 */
	askApproval?: (req: ApprovalRequest) => Promise<"allow" | "deny">;
	/** Optional product mode; never enabled implicitly for an existing benchmark. */
	modelApproval?: { settings: ApprovalSettings; adapter: ModelAdapter; manualFallback?: boolean };
	/** Shared request reservation and conservative preflight. On unless set to false, so the CLI, Desktop and SDK callers are guarded alike. */
	requestGuard?: boolean;
	/** Desktop interactive runs keep conservative worst-case billing when usage is partial without halting the conversation. */
	allowPartialUsage?: boolean;
	/** Explicit trusted final-HTTP-body count; default false, never a byte/token conversion. */
	exactInputPreflight?: boolean;
	budget: BudgetGuard;
	onEvent?: (e: EngineEvent) => void;
	/** Trusted runtime-only execution evidence. Disabled unless explicitly supplied by the host. */
	toolObserver?: ToolExecutionObserver;
	/** Trusted synchronous receipt of every actual model bill, including approvals and compaction. */
	onModelLedger?: (witness: ModelLedgerWitness) => void;
	sessionId?: string;
	runId?: string;
	checkpoints?: boolean;
	/** 应用数据目录（影子检查点仓库位置） */
	appDataDir?: string;
	/**
	 * Multi-agent work (UltraCode): the team's tools, its instructions after the system prompt, and a wait
	 * before the final answer while other agents still work. Needs allowInterjection. Unset keeps requests exactly as before.
	 */
	team?: { tools: ToolDefinition[]; instructions: string; beforeFinish?: (signal: AbortSignal) => Promise<void> };
}

export interface RunTotals {
	requests: number;
	input: number;
	cacheRead: number;
	output: number;
	reasoning: number;
	/** 估算费用（原币种，见 currency） */
	cost: number;
	currency: string;
	usagePartialRequests: number;
	approvalRequests?: number;
	approvalCost?: number;
}

/** A human fallback retains the model review's exact action and authorization. */
type ReviewedApprovalDecision = ApprovalDecision & { manualFallback?: () => boolean };

export interface RunSummary {
	sessionId: string;
	runId: string;
	status: "completed" | "failed" | "cancelled" | "limit";
	reason: string;
	turns: number;
	totals: RunTotals;
	durationMs: number;
	finalText: string;
	filesChanged: string[];
	checkpoint: { tree: string; changed: { status: string; path: string }[] } | null;
}

export type InterjectionReceipt = { accepted: true; id: string; runId: string } | {
	accepted: false; reason: "disabled" | "idle" | "closing" | "invalid-input" | "queue-full";
};

export interface AgentSnapshotV1 {
	format: "mountains-agent-session";
	version: 1;
	sessionId: string;
	workspaceHash: string;
	archiveRootHash: string;
	model: string;
	billingCurrency: Currency | null;
	configHash: string;
	context: ContextStateV1;
	userRequests: { id: string; text: string }[];
	runCount: number;
	seq: number;
}

interface RestoredInteractionArchive { content: string; messages: Message[]; turns?: number[] }
interface RestoredSessionRecord { content: string; metadata: SessionRecordMetadata }

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) { resolve(); return; }
		const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
		const timer = setTimeout(done, timerDelay(ms));
		signal?.addEventListener("abort", done, { once: true });
	});

/** Abandoned approval UIs must not keep a cancelled run alive or approve a later operation. */
function cancellableApproval(ask: () => Promise<"allow" | "deny">, signal: AbortSignal): Promise<"allow" | "deny"> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { resolve("deny"); return; }
		let settled = false;
		const finish = (answer: "allow" | "deny", error?: unknown) => {
			if (settled) return;
			settled = true; signal.removeEventListener("abort", abort);
			if (error !== undefined) reject(error); else resolve(answer);
		};
		const abort = () => finish("deny");
		signal.addEventListener("abort", abort, { once: true });
		try { Promise.resolve(ask()).then(answer => finish(signal.aborted ? "deny" : answer), error => finish("deny", error)); }
		catch (error) { finish("deny", error); }
	});
}

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/** Do not execute accessors/toJSON from an unknown restore input. Preserve key order. */
function snapshotData(raw: unknown): unknown {
	let nodes = 0, bytes = 0;
	const ancestors = new Set<object>();
	const copy = (value: unknown, depth: number): unknown => {
		if (++nodes > 200_000 || depth > 64) throw new Error("会话快照过大或嵌套过深");
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			bytes += Buffer.byteLength(value, "utf8");
			if (bytes > 16_000_000) throw new Error("会话快照过大");
			return value;
		}
		if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("会话快照必须是无循环的纯数据");
		const array = Array.isArray(value);
		if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error("会话快照原型无效");
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.getOwnPropertySymbols(value).length) throw new Error("会话快照含非法字段");
		ancestors.add(value);
		try {
			if (array) {
				const length = descriptors.length?.value as unknown;
				if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 200_000 || Object.keys(descriptors).length !== (length as number) + 1) throw new Error("会话快照数组无效");
				const out: unknown[] = [];
				for (let i = 0; i < (length as number); i++) {
					const field = descriptors[String(i)];
					if (!field || !("value" in field) || !field.enumerable) throw new Error("会话快照数组含访问器");
					out.push(copy(field.value, depth + 1));
				}
				return out;
			}
			const out: Record<string, unknown> = {};
			for (const [key, field] of Object.entries(descriptors)) {
				if (["__proto__", "prototype", "constructor", "toJSON"].includes(key) || !("value" in field) || !field.enumerable) throw new Error("会话快照含访问器或非法字段");
				out[key] = copy(field.value, depth + 1);
			}
			return out;
		} finally { ancestors.delete(value); }
	};
	const result = copy(raw, 0);
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16_000_000) throw new Error("会话快照过大");
	return result;
}

/**
 * Conservative input size for budget reservations: one token per byte of text, plus twice the area
 * estimate for each image (its base64 text would overstate an image by two orders of magnitude).
 */
function requestByteBound(system: string, tools: unknown, messages: readonly Message[]): number {
	let images = 0;
	const text = messages.map(m => {
		if (m.role !== "tool" || !m.images?.length) return m;
		images += m.images.reduce((n, i) => n + 2 * imageTokens(i.width, i.height), 0);
		const { images: _images, ...rest } = m;
		return rest;
	});
	return Buffer.byteLength(JSON.stringify({ system, tools, messages: text }), "utf8") + 4096 + images;
}

const approvalKey = (tool: string, args: Record<string, unknown>) => `${tool}\n${JSON.stringify(args)}`;

const FOLD_NOTICE = /^\[Context checkpoint generated by the program, not a user instruction\]\nFolded \d+ earlier tool calls? /;

function snapshotInputsAgree(context: ContextStateV1, inputs: readonly { text: string }[]): boolean {
	// Runtime notices use a reserved textual marker until the protocol has a notice role.
	// Never let restored authorization evidence turn those notices into user instructions.
	const markers = ["[Runtime evidence notice, not a user instruction]\n", "[Context checkpoint generated by the program, not a user instruction]\n", SKILL_NOTICE];
	const isNotice = (text: string) => markers.some((marker) => text.startsWith(marker));
	if (inputs.some((input) => isNotice(input.text))) return false;
	const users = context.history.filter((item) => item.message.role === "user" && !isNotice(item.message.content));
	// A compaction moves earlier user messages into its archive; the ones still present are the newest.
	const compacted = context.history.some((item) => item.message.role === "user" && item.message.content.startsWith(markers[1]!) && item.message.content.includes("\n<summary>\n"));
	if (compacted ? users.length > inputs.length : users.length !== inputs.length) return false;
	const offset = inputs.length - users.length;
	return users.every((item, index) => item.message.content === inputs[offset + index]!.text);
}

/** `/name` at the start and `@name` anywhere, once each. The user's own request stands in for approval. */
function citedSkills(text: string, skills: readonly SkillEntry[], permissions: Readonly<Record<string, SkillPermission>>): SkillEntry[] {
	const invoked = skillInvocation(text, skills, permissions);
	const out: SkillEntry[] = invoked ? [invoked] : [];
	for (const entry of skillMentions(text, skills, permissions)) if (!out.some(skill => skill.name === entry.name)) out.push(entry);
	return out;
}

/** 一个会话：可以连续执行多个 run（对话历史保留）。 */
export class AgentSession {
	readonly sessionId: string;
	readonly options: EngineOptions;
	readonly builder: ContextBuilder;
	private readonly planner: CachePlanner;
	/** 模型的上下文窗口（来自模型能力表）；未知时不做窗口检查 */
	private readonly contextWindow: number | undefined;
	private readonly tools: ToolDefinition[];
	private readonly skills: SkillEntry[];
	private readonly skillPermissions: Record<string, SkillPermission>;
	private readonly skillWarnings: string[];
	/** Skills the user loaded with /name; the user's choice stands in for approval, and their files become readable. */
	private readonly userLoadedSkills = new Set<string>();
	private readonly toolByName: Map<string, ToolDefinition>;
	private readonly workspace: Workspace;
	private readonly files = new FileStateTracker();
	private readonly blobs: BlobStore;
	private readonly sessionIndex: SessionArchiveIndex | undefined;
	private sessionIndexGap = false;
	/** This run's edits can be taken back. */
	private undoable = false;
	/** Actions the user approved in this conversation, and the risk they were given. */
	private readonly userAllowed = new Map<string, RiskLevel | undefined>();
	private readonly ledger: Ledger;
	private readonly recorder: Recorder;
	private seq = 0;
	private prevPlan: ContextPlan | null = null;
	private runCount = 0;
	private readonly userRequests: { id: string; text: string }[] = [];
	private activeRun = false;
	private activeRunController: AbortController | null = null;
	private authorizationRevision = 0;
	private actionEpoch = 0;
	/**
	 * Desktop plan mode: operations of these risks are refused before any rule, reviewer or person is asked,
	 * and no file is written. Null (the default) leaves every run as it was.
	 */
	refuseRisks: ReadonlySet<Risk> | null = null;
	private activeRunId: string | null = null;
	private acceptingInterjections = false;
	private readonly interjections: { id: string; text: string; source: "interjection" | "agent" }[] = [];
	private snapshotReady = false;

	constructor(options: EngineOptions) {
		if (options.toolObserver) observerTimeout(options.toolObserver);
		// One configuration: the system prompt and tool notes, the general tools, a session archive and the context policy.
		options = { ...options,
			systemPrompt: (options.systemPrompt ?? SYSTEM_PROMPT) + TOOL_NOTES + (options.team ? `\n\n${options.team.instructions}` : ""),
			toolOptions: normalizeToolOptions({ ...options.toolOptions, editFeedback: options.toolOptions?.editFeedback ?? true }),
			contextPolicy: options.contextPolicy ?? DEFAULT_CONTEXT_POLICY,
		};
		for (const key of ["allowInterjection", "allowSessionSnapshots", "allowOutsideWorkspace"] as const) {
			if (options[key] !== undefined && typeof options[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
		}
		if (options.team && !options.allowInterjection) throw new Error("多 Agent 协作需要 allowInterjection：其他 Agent 的消息要在运行中送达");
		if (options.allowInterjection && options.exactInputPreflight) throw new Error("插话暂不支持精确输入预检；不能发送遗漏新输入的正文");
		if (options.billingCurrency !== undefined) {
			if (options.billingCurrency !== "USD" && options.billingCurrency !== "CNY") throw new Error("计费币种只能是 USD 或 CNY");
			if (!pricingFor(options.model, options.billingCurrency)) throw new Error("所选模型没有该币种的价格");
		}
		const billingCurrency = currencyOf(options.model, options.billingCurrency);
		if (billingCurrency !== undefined && options.budget.currency !== billingCurrency) throw new Error("计费币种必须与预算账本币种一致");
		if (options.requestGuard !== undefined && typeof options.requestGuard !== "boolean") throw new Error("requestGuard 必须是布尔值");
		if (options.exactInputPreflight !== undefined && typeof options.exactInputPreflight !== "boolean") throw new Error("exactInputPreflight 必须是布尔值");
		if (options.exactInputPreflight && !exactInputIdentity(options.adapter)) throw new Error("精确输入预检需要由受信工厂创建的适配器");
		options = { ...options, requestGuard: options.requestGuard !== false || !!options.modelApproval || options.exactInputPreflight === true };
		if (options.modelApproval) {
			if (options.modelApproval.manualFallback !== undefined && typeof options.modelApproval.manualFallback !== "boolean") throw new Error("modelApproval.manualFallback 必须为布尔值");
			const settings = validateApprovalSettings(options.modelApproval.settings, currencyOf(options.model, options.billingCurrency) ?? "USD");
			if (settings.maxCost > (options.limits?.maxCost ?? DEFAULT_LIMITS.maxCost)) throw new Error("审批子预算不能超过任务总预算");
			options = { ...options, modelApproval: { settings, adapter: options.modelApproval.adapter,
				...(options.modelApproval.manualFallback === undefined ? {} : { manualFallback: options.modelApproval.manualFallback }) } };
		}
		this.options = options;
		this.sessionId = options.sessionId ?? `ses_${randomUUID().slice(0, 12)}`;
		this.workspace = new Workspace(options.workspace, { allowOutside: options.allowOutsideWorkspace === true });
		for (const path of [options.dataDir, options.appDataDir, options.budget.ledgerPath]) {
			if (path !== undefined && this.workspace.contains(path)) throw new Error("运行数据、费用账本与检查点必须存放在任务工作区之外");
		}
		this.blobs = options.forkedFrom?.blobs ?? new BlobStore(options.archiveDir ?? join(options.dataDir, "blobs"), {
			workspaceRoot: this.workspace.root, sessionId: this.sessionId,
			allowWorkspaceHistory: false,
		});
		this.sessionIndex = new SessionArchiveIndex(this.blobs);
		// Skills are found once per session; a tool-bearing built-in skill counts only when turned on.
		const skillOptions = options.skills;
		const found = skillOptions ? discoverSkills(skillOptions.roots ?? [], (skillOptions.builtin ?? []).filter(b => !b.tools?.length || (skillOptions.enable ?? []).includes(b.name))) : { skills: [], warnings: [] };
		this.skills = found.skills;
        const persistent=this.skills.filter(skill=>skill.builtin?.persistentInstructions&&skillPermission(skill,skillOptions?.permissions??{})!=="deny").map(skill=>`<builtin_skill name="${skill.name}">\n${skill.builtin!.body}\n</builtin_skill>`).join("\n\n");
        if(persistent)options.systemPrompt+="\n\n"+persistent;
		// AGENTS.md comes last in the system block: it changes least often after the fixed parts, and an empty one adds no bytes.
		if (options.instructions?.trim()) options.systemPrompt += `\n\n${options.instructions.trim()}`;
		this.skillWarnings = found.warnings;
		this.skillPermissions = { ...skillOptions?.permissions };
		const skillTools = this.skills.filter(s=>skillPermission(s,this.skillPermissions)!=="deny").flatMap(s => s.builtin?.tools ?? []);
		const listedSkills = modelSkills(this.skills, this.skillPermissions);
		// Skills only the user starts still need the tool to read their bundled files.
		const userSkills = this.skills.some(s => s.userInvocable && s.dir && skillPermission(s, this.skillPermissions) !== "deny");
		// The tool list is fixed for the session, so the tool prefix never changes.
		this.tools = [...(options.tools ?? generalTools(options.toolOptions)).filter(t => t.name !== "session_search" && t.name !== "task_note" && t.name !== "skill"),
			createSessionSearchTool(this.sessionIndex, { brief: true }), createTaskNoteTool(), ...(options.extraTools ?? []), ...skillTools,
			...(listedSkills.length || userSkills ? [createSkillTool(this.skills, this.skillPermissions, this.userLoadedSkills)] : []), ...(options.team?.tools ?? [])];
		if (new Set(this.tools.map(t => t.name)).size !== this.tools.length) throw new Error("工具名重复：技能带来的工具不能和已有工具同名");
		this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
		if (!this.toolByName.has("context_expand")) throw new Error("需要 context_expand 才能取回会话原文");
		this.builder = new ContextBuilder({
			system: options.systemPrompt!,
			tools: this.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
			expandTool: "context_expand",
			...(options.toolOptions?.leanOutput ? { leanRefs: true } : {}),
			publicationGuard: { verifyReference: (ref: string, view: "shown" | "raw", expected?: { toolCallId?: string; sha256?: string }) => this.blobs.has(ref, view, expected),
				archiveInteraction: (content: string) => this.blobs.put(Buffer.from(content), { kind: "raw" }) },
		});
		if (options.forkedFrom) {
			options.forkedFrom.builder.forkInto(this.builder);
			this.userRequests.push(...structuredClone(options.forkedFrom.userRequests));
		}
		// The context lines scale with the model's window, or with a smaller window the caller assumes.
		const configured = options.contextPolicy!;
		const modelWindow = capabilitiesFor(options.model)?.contextWindow;
		if (options.contextWindow !== undefined && (!Number.isSafeInteger(options.contextWindow) || options.contextWindow < 32_768)) throw new Error("contextWindow 必须是不小于 32768 的整数");
		if (options.contextWindow && modelWindow && options.contextWindow > modelWindow) throw new Error(`contextWindow 不能大于模型窗口 ${modelWindow}`);
		const window = options.contextWindow ?? modelWindow;
		this.contextWindow = window;
		const f = configured.windowFractions;
		const policy = f && window ? { ...configured, triggerTokens: Math.floor(window * f.trigger), hardLimitTokens: Math.floor(window * f.hard),
			compactTokens: Math.floor(window * f.compact), compactTailTokens: Math.floor(window * f.tail), minBatchTokens: Math.floor(window * f.batch) } : configured;
		this.planner = new CachePlanner(policy);
		this.ledger = new Ledger(join(options.dataDir, "ledger.jsonl"), options.onModelLedger);
		this.recorder = new Recorder(join(options.dataDir, "recording.jsonl"));
		this.recorder.write("meta", {
			sessionId: this.sessionId,
			model: options.model,
			...(options.billingCurrency !== undefined ? { billingCurrency: options.billingCurrency } : {}),
			thinking: options.thinking,
			maxTokens: options.maxTokens,
			contextPolicy: options.contextPolicy,
			...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
			verbatimToolArguments: options.verbatimToolArguments ?? false,
			systemPromptSha256: sha256(options.systemPrompt!),
			tools: this.tools.map((t) => t.name),
			toolOptions: options.toolOptions ?? null,
			requestGuard: options.requestGuard,
			...(this.skills.length || this.skillWarnings.length ? { skills: { names: this.skills.map(s => `${s.source}:${s.name}`), warnings: this.skillWarnings } } : {}),
			...(options.exactInputPreflight ? { exactInputPreflight: true, counterIdentity: exactInputIdentity(options.adapter) } : {}),
		});
	}

	/** Verify the complete checkpoint graph before importing history, with bounded work and no recursion. */
	private restoredInteractionArchives(refs: string[]): Map<string, RestoredInteractionArchive> {
		const archives = new Map<string, RestoredInteractionArchive>();
		const pending = new Set(refs);
		let bytes = 0, messages = 0;
		for (const ref of pending) {
			if (pending.size > 20_000) throw new Error("会话交互归档过多，不能恢复");
			const content = this.blobs.has(ref, "raw") ? this.blobs.get(ref) : null;
			if (content === null) throw new Error("会话交互归档缺失或不属于该会话，不能恢复");
			bytes += Buffer.byteLength(content, "utf8");
			if (bytes > 64 * 1024 * 1024) throw new Error("会话交互归档过大，不能恢复");
			let archive: RestoredInteractionArchive;
			try {
				const parsed = JSON.parse(content) as { format?: unknown; version?: unknown; messages?: unknown; turns?: unknown };
				if (parsed?.format !== "mountains-interaction" || parsed.version !== 1 || !Array.isArray(parsed.messages)) throw new Error("invalid archive");
				if (parsed.turns !== undefined && (!Array.isArray(parsed.turns) || parsed.turns.length !== parsed.messages.length ||
					parsed.turns.some(turn => !Number.isSafeInteger(turn) || (turn as number) < 0))) throw new Error("invalid archive");
				messages += parsed.messages.length;
				if (messages > 200_000) throw new Error("too many messages");
				for (const message of parsed.messages) {
					if (!message || typeof message.content !== "string" || !["user", "assistant", "tool"].includes(message.role) ||
						message.role === "assistant" && !Array.isArray(message.toolCalls)) throw new Error("invalid message");
				}
				assertToolPairing(parsed.messages);
				archive = { content, messages: parsed.messages, ...(parsed.turns ? { turns: parsed.turns as number[] } : {}) };
			} catch { throw new Error("会话交互归档内容无效或过大，不能恢复"); }
			archives.set(ref, archive);
			for (const message of archive.messages) {
				const nested = message.role === "user" ? checkpointArchiveRef(message.content) : null;
				if (nested) pending.add(nested);
			}
		}
		return archives;
	}

	/** Prepare bounded visible records before import; repeated notices represent repeated interactions. */
	private restoredSessionRecords(context: ContextStateV1, archives: ReadonlyMap<string, RestoredInteractionArchive>): RestoredSessionRecord[] {
		const notice = (text: string) => text.startsWith("[Runtime ") || text.startsWith("[Context checkpoint generated by the program, not a user instruction]\n") || text.startsWith(SKILL_NOTICE);
		type Pending = { message: Message; target?: string; ref?: string; turn: number | null; depth: number };
		const pending: (Pending | { endArchive: string })[] = context.history.map(item => ({ message: item.message, turn: item.turn, depth: 0,
			...(item.meta?.target ? { target: item.meta.target } : {}), ...(item.meta?.ref ? { ref: item.meta.ref } : {}) })).reverse();
		const active = new Set<string>(), records: RestoredSessionRecord[] = [];
		// A compaction keeps the newest request ahead of its notice, so archive order is not time order.
		// Every message's turn, archived or not, restores the order the live index saw.
		const order: { turn: number; phase: number; depth: number }[] = [];
		let timed = true;
		let visited = 0, bytes = 0, expandedBytes = 0;
		const record = (content: string, metadata: SessionRecordMetadata, item: Pending) => {
			const size = Buffer.byteLength(content, "utf8");
			bytes += size;
			if (size > SESSION_SEARCH_LIMITS.maxRecordBytes || bytes > SESSION_SEARCH_LIMITS.maxIndexBytes || records.length >= SESSION_SEARCH_LIMITS.maxEntries) {
				throw new Error("会话搜索索引过大，不能恢复");
			}
			records.push({ content, metadata });
			if (item.turn === null) timed = false;
			// Within a turn: the previous call's results, then user messages, then the answer; older (deeper) archives first.
			order.push({ turn: item.turn ?? 0, phase: metadata.role === "tool" ? 0 : metadata.role === "user" ? 1 : 2, depth: item.depth });
		};
		while (pending.length) {
			const item = pending.pop()!;
			if ("endArchive" in item) { active.delete(item.endArchive); continue; }
			const message = item.message;
			expandedBytes += Buffer.byteLength(message.content, "utf8");
			if (++visited > 200_000 || expandedBytes > 64 * 1024 * 1024) throw new Error("会话交互归档展开后过大，不能恢复");
			if (message.role === "user") {
				const archiveRef = checkpointArchiveRef(message.content);
				const archived = archiveRef ? archives.get(archiveRef) : undefined;
				if (archived !== undefined) {
					if (active.has(archiveRef!)) throw new Error("会话交互归档存在循环，不能恢复");
					active.add(archiveRef!);
					pending.push({ endArchive: archiveRef! });
					const targets = new Map<string, string>();
					for (const m of archived.messages) {
						if (m.role === "assistant") for (const call of m.toolCalls) targets.set(call.id, toolTarget(call.name, call.argumentsJson));
					}
					const listed = message.content.lastIndexOf("\nArchived evidence references: ");
					if (listed >= 0) {
						try {
							for (const entry of JSON.parse(message.content.slice(listed + "\nArchived evidence references: ".length)) as { toolCallId?: unknown; target?: unknown }[]) {
								if (typeof entry.toolCallId === "string" && typeof entry.target === "string") targets.set(entry.toolCallId, entry.target);
							}
						} catch { /* labels only; the archived bodies are still indexed */ }
					}
					// A fold stays in place: its answer has the notice's turn and its results the next one.
					let counted = FOLD_NOTICE.test(message.content) ? item.turn : null;
					const turns = archived.messages.map(m => {
						const turn = counted;
						if (counted !== null && m.role === "assistant") counted++;
						return turn;
					});
					for (let i = archived.messages.length - 1; i >= 0; i--) {
						const m = archived.messages[i]!;
						pending.push({ message: m, turn: archived.turns?.[i] ?? turns[i]!, depth: item.depth + 1, ...(m.role === "tool" && targets.has(m.toolCallId) ? { target: targets.get(m.toolCallId)! } : {}) });
					}
				} else if (!notice(message.content)) record(message.content, { role: "user" }, item);
			} else if (message.role === "assistant") {
				if (message.content) record(message.content, { role: "assistant" }, item);
			} else {
				record(message.content, { role: "tool", toolCallId: message.toolCallId, name: message.name, ...(item.target ? { target: item.target } : {}), ...(item.ref ? { ref: item.ref } : {}) }, item);
			}
		}
		// Archives written before turns were recorded keep their stored order.
		if (!timed) return records;
		return records.map((r, i) => ({ r, i })).sort((a, b) => {
			const x = order[a.i]!, y = order[b.i]!;
			return x.turn - y.turn || x.phase - y.phase || y.depth - x.depth || a.i - b.i;
		}).map(({ r }) => r);
	}

	/**
	 * The index only serves search, so a record it refuses is left out and the run goes on. Nothing is lost:
	 * the message stays in context, and folding and compaction check their own archives before dropping anything.
	 */
	private indexVisible(content: string, metadata: SessionRecordMetadata): void {
		if (!this.sessionIndex) return;
		try { this.sessionIndex.record(content, metadata); }
		catch (error) {
			this.sessionIndex.incomplete = true;
			console.error(`mountains: left out of session search: ${error instanceof Error ? error.message : String(error)}`);
			if (this.sessionIndexGap || !this.activeRunId) return;
			this.sessionIndexGap = true;
			this.emit(this.activeRunId, "error", { message: "有内容没进搜索索引，之后可能搜不到；任务继续", retryable: true });
		}
	}

	/** Queues input for the next request. A message from another agent leaves the run's pending authorizations in place; the user's input revokes them. */
	interject(text: string, from: "user" | "agent" = "user"): InterjectionReceipt {
		if (!this.options.allowInterjection) return { accepted: false, reason: "disabled" };
		if (!this.activeRun || !this.activeRunId) return { accepted: false, reason: "idle" };
		if (!this.acceptingInterjections) return { accepted: false, reason: "closing" };
		if (typeof text !== "string" || !text.trim() || text.length > 65_536) return { accepted: false, reason: "invalid-input" };
		if (this.interjections.length >= 32 || this.interjections.reduce((sum, item) => sum + item.text.length, text.length) > 131_072) return { accepted: false, reason: "queue-full" };
		const id = `${this.activeRunId}:interject:${randomUUID()}`;
		const source = from === "agent" ? "agent" : "interjection";
		this.recorder.write("user.input", { runId: this.activeRunId, id, task: text, source, status: "queued" });
		if (source === "interjection") this.actionEpoch++;
		this.interjections.push({ id, text, source });
		return { accepted: true, id, runId: this.activeRunId };
	}

	private drainInterjections(runId: string): string[] {
		if (!this.options.allowInterjection || this.interjections.length === 0) return [];
		assertToolPairing(this.builder.plan().messages);
		const inputs = this.interjections.splice(0);
		for (const input of inputs) {
			this.indexVisible(input.text, { role: "user" });
			this.builder.appendUser(input.text);
			this.userRequests.push({ id: input.id, text: input.text });
			this.recorder.write("user.input", { runId, id: input.id, task: input.text, source: input.source, status: "applied" });
		}
		return inputs.map((input) => input.id);
	}

	private snapshotConfigHash(): string {
		const o = this.options;
		return sha256(JSON.stringify({ model: o.model, billingCurrency: o.billingCurrency ?? null,
			thinking: o.thinking, maxTokens: o.maxTokens, contextPolicy: o.contextPolicy, contextWindow: o.contextWindow ?? null,
			verbatimToolArguments: o.verbatimToolArguments ?? false,
			requestGuard: o.requestGuard === true, exactInputPreflight: o.exactInputPreflight === true,
			priceVersion: pricingFor(o.model, o.billingCurrency)?.version ?? null }));
	}

	exportSnapshot(): AgentSnapshotV1 {
		if (!this.options.allowSessionSnapshots) throw new Error("会话快照能力未开启");
		if (this.activeRun || !this.snapshotReady || this.interjections.length) throw new Error("只能导出已完整结束的会话");
		if (this.userRequests.length > 10_000 || this.userRequests.some((input) => input.id.length > 256 || input.text.length > 8 * 1024 * 1024)) throw new Error("会话快照的用户输入记录过大");
		const snapshot: AgentSnapshotV1 = {
			format: "mountains-agent-session", version: 1, sessionId: this.sessionId,
			workspaceHash: sha256(this.workspace.root), archiveRootHash: sha256(this.blobs.dir),
			model: this.options.model, billingCurrency: this.options.billingCurrency ?? null,
			configHash: this.snapshotConfigHash(), context: this.builder.exportState(),
			userRequests: structuredClone(this.userRequests), runCount: this.runCount, seq: this.seq,
		};
		if (!snapshotInputsAgree(snapshot.context, snapshot.userRequests)) throw new Error("会话中的用户原话与授权记录不一致，不能导出可续聊快照");
		snapshotData(snapshot);
		if (JSON.stringify(redactValue(snapshot)) !== JSON.stringify(snapshot)) throw new Error("会话包含需脱敏的内容，不能导出可续聊快照；可单独保存脱敏后的界面记录");
		return snapshot;
	}

	/** `acrossModels`: the history goes on with this session's model and settings, whatever it was saved under. */
	restoreSnapshot(raw: unknown, { acrossModels = false }: { acrossModels?: boolean } = {}): void {
		if (!this.options.allowSessionSnapshots) throw new Error("会话快照能力未开启");
		if (this.activeRun || this.runCount !== 0 || this.builder.length !== 0) throw new Error("只能在空闲的新会话中还原快照");
		const fail = (): never => { throw new Error("会话快照版本、内容、工作区或配置不匹配"); };
		raw = snapshotData(raw);
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) fail();
		const s = raw as Record<string, unknown>;
		const keys = ["format", "version", "sessionId", "workspaceHash", "archiveRootHash", "model", "billingCurrency", "configHash", "context", "userRequests", "runCount", "seq"];
		if (Object.keys(s).length !== keys.length || Object.keys(s).some((key) => !keys.includes(key))) fail();
		if (JSON.stringify(s).length > 16_000_000 || JSON.stringify(redactValue(s)) !== JSON.stringify(s)) fail();
		if (s.format !== "mountains-agent-session" || s.version !== 1 || s.sessionId !== this.sessionId ||
			s.workspaceHash !== sha256(this.workspace.root) || s.archiveRootHash !== sha256(this.blobs.dir) ||
			(!acrossModels && (s.model !== this.options.model || s.billingCurrency !== (this.options.billingCurrency ?? null) || s.configHash !== this.snapshotConfigHash()))) fail();
		if (!Number.isSafeInteger(s.runCount) || (s.runCount as number) < 1 || !Number.isSafeInteger(s.seq) || (s.seq as number) < 1) fail();
		if (!Array.isArray(s.userRequests) || s.userRequests.length < 1 || s.userRequests.length > 10_000) fail();
		const inputs: { id: string; text: string }[] = [];
		const seen = new Set<string>();
		for (const item of s.userRequests as unknown[]) {
			if (!item || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) fail();
			const input = item as Record<string, unknown>;
			if (Object.keys(input).length !== 2 || typeof input.id !== "string" || !input.id || input.id.length > 256 || seen.has(input.id) ||
				typeof input.text !== "string" || input.text.length > 8 * 1024 * 1024) fail();
			seen.add(input.id as string); inputs.push({ id: input.id as string, text: input.text as string });
		}
		// Validate against a fresh builder and host-selected archive before mutating this one.
		const candidate = new ContextBuilder({ system: this.builder.system, tools: this.builder.tools,
			...(this.builder.expandTool ? { expandTool: this.builder.expandTool } : {}), leanRefs: this.builder.leanRefs });
		candidate.restoreState(s.context);
		const context = candidate.exportState();
		if (!snapshotInputsAgree(context, inputs)) throw new Error("会话中的用户原话与授权记录不一致，不能恢复");
		for (const item of context.history) {
			if (item.meta?.ref && !this.blobs.has(item.meta.ref, "shown", item.message.role === "tool" ? { toolCallId: item.message.toolCallId, sha256: sha256(item.message.content) } : undefined)) throw new Error("会话工具归档缺失、正文不匹配或不属于该会话");
			if (item.meta?.fullOutputRef && !this.blobs.has(item.meta.fullOutputRef, "raw", item.meta.fullOutputSourceCallId ? { toolCallId: item.meta.fullOutputSourceCallId } : undefined)) throw new Error("会话原文归档缺失或不属于该会话");
		}
		// Compaction can archive earlier checkpoint notices, so validate their transitive references too.
		const archives = this.restoredInteractionArchives(candidate.checkpointArchiveRefs());
		const records = this.sessionIndex ? this.restoredSessionRecords(context, archives) : [];
		this.builder.restoreState(context);
		for (const [ref, archive] of archives) this.builder.registerInteractionArchive(ref, sha256(archive.content));
		for (const { content, metadata } of records) this.indexVisible(content, metadata);
		this.userRequests.push(...inputs);
		for (const input of inputs) {
			for (const skill of citedSkills(input.text, this.skills, this.skillPermissions)) this.userLoadedSkills.add(skill.name);
		}
		this.runCount = s.runCount as number;
		this.seq = s.seq as number;
		this.prevPlan = this.builder.plan();
		this.snapshotReady = true;
	}

	private emit<T extends EngineEventType>(runId: string, type: T, payload: EventPayload<T>, onRecordingError?: (event: EngineEvent) => void): void {
		this.seq++;
		const event = {
			protocolVersion: PROTOCOL_VERSION,
			sessionId: this.sessionId,
			runId,
			seq: this.seq,
			eventId: randomUUID(),
			time: new Date().toISOString(),
			...(HIGH_PRIORITY_EVENTS.has(type) ? { priority: "high" as const } : {}),
			type,
			...payload,
		} as unknown as EngineEvent;
		if (type !== "message.delta" && type !== "tool.writing") {
			try { this.recorder.write("engine.event", event); }
			catch (error) {
				if (!onRecordingError) throw error;
				onRecordingError(event);
			}
		}
		// Every outward event can become a log or UI message; keep raw values in execution only.
		try { this.options.onEvent?.(redactValue(event) as EngineEvent); }
		catch (error) {
			if (!onRecordingError) throw error;
			// CLI event files can fail independently of Recorder. Do not abandon completed tools.
			onRecordingError(event);
		}
	}

	/** File skills added after the session began can still be cited. The tool list stays as it was. */
	private refreshFileSkills(): void {
		const roots = this.options.skills?.roots;
		if (!roots?.length) return;
		for (const entry of discoverSkills(roots).skills) {
			if (entry.dir && !this.skills.some(skill => skill.name === entry.name)) this.skills.push(entry);
		}
	}

	async run(task: string, signal: AbortSignal = new AbortController().signal): Promise<RunSummary> {
		// A new input invalidates outstanding model approvals, even when this API
		// cannot yet enqueue that input. Never execute under a superseded request.
		this.authorizationRevision++;
		if (this.activeRun) {
			this.activeRunController?.abort();
			throw new Error("同一会话正在运行；旧审批已失效，请等待停止后重新提交新指令");
		}
		this.activeRun = true;
		this.snapshotReady = false;
		this.activeRunController = new AbortController();
		let ended = false;
		try { const result = await this.runExclusive(task, AbortSignal.any([signal, this.activeRunController.signal])); ended = true; return result; }
		finally {
			this.activeRun = false; this.activeRunController = null; this.activeRunId = null;
			this.acceptingInterjections = false; this.interjections.length = 0; this.snapshotReady = ended;
		}
	}

	private async runExclusive(task: string, signal: AbortSignal): Promise<RunSummary> {
		const o = this.options;
		const guarded = o.requestGuard === true;
		const exact = o.exactInputPreflight === true;
		const runAuthorizationRevision = this.authorizationRevision;
		const limits: RunLimits = { ...DEFAULT_LIMITS, ...o.limits };
		const deadlineSignal = limits.maxDurationMs ? AbortSignal.timeout(limits.maxDurationMs) : null;
		if (deadlineSignal) signal = AbortSignal.any([signal, deadlineSignal]);
		const retry = o.retry ?? DEFAULT_RETRY;
		this.runCount++;
		const runId = o.runId && this.runCount === 1 ? o.runId : `run_${randomUUID().slice(0, 12)}`;
		this.activeRunId = runId;
		this.acceptingInterjections = o.allowInterjection === true;
		const started = Date.now();
		const totals: RunTotals = { requests: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, cost: 0, currency: currencyOf(o.model, o.billingCurrency) ?? "USD", usagePartialRequests: 0 };
		const filesChanged = new Set<string>();
		let finalText = "";
		let turns = 0;
		let ckpt: ShadowCheckpoints | null = null;
		let baselineTree: string | null = null;
		if (o.checkpoints !== false) {
			try {
				ckpt = new ShadowCheckpoints(o.workspace, o.appDataDir ?? join(o.dataDir, "appdata"));
				baselineTree = ckpt.snapshot().tree;
			} catch {
				ckpt = null;
			}
		}
		this.undoable = ckpt !== null;
		const beforeWrite = (abs: string) => {
			const path = this.workspace.rel(abs);
			// The hook runs after approval, before mutation. Remember even absent
			// paths so repeated writes keep the first preimage (or its absence).
			if (!filesChanged.has(path)) {
				// Approval may have awaited a human while a parent directory changed.
				// Recheck the authorized target before mutating or reading bytes into the checkpoint.
				if (this.workspace.resolve(path, { forWrite: true }).abs !== abs) throw new Error("文件路径在验证后已改变，检查点未保存");
				if (ckpt && baselineTree && !isAbsolute(path)) baselineTree = ckpt.capturePreimage(baselineTree, path);
			}
			filesChanged.add(path);
		};
		if (this.runCount === 1) this.emit(runId, "session.started", { workspace: this.workspace.root, model: o.model });
		this.emit(runId, "run.started", { task });
		// "/name" at the start, and "@name" anywhere, show that skill to the model. The user's words stay as typed.
		this.refreshFileSkills();
		const cited = citedSkills(task, this.skills, this.skillPermissions);
		const loaded: string[] = [];
		for (const skill of cited) {
			try {
				const content = renderSkillContent(skill, skillBody(skill));
				this.userLoadedSkills.add(skill.name);
				this.builder.appendUser(`${SKILL_NOTICE}${content}`);
				loaded.push(skill.name);
			} catch (error) { this.skillWarnings.push(`技能 ${skill.name} 加载失败：${error instanceof Error ? error.message : String(error)}`); }
		}
		this.recorder.write("user.input", { runId, task, ...(cited[0] ? { skill: cited[0].name, skillLoaded: loaded.length === cited.length, skills: cited.map(skill => skill.name) } : {}) });
		this.indexVisible(task, { role: "user" });
		this.builder.appendUser(task);
		// An agent's task is not the user speaking: approval sees only the user's own words.
		if (!o.forkedFrom) this.userRequests.push({ id: `${runId}:user:${this.userRequests.length + 1}`, text: task });
		// A later run must not call an earlier run's source delivery its own observation.
		this.files.forgetDelivered();
		// Every message in a conversation is a run; the repository brief is sent once per session.
		if (this.runCount === 1 && !o.forkedFrom) {
			const brief = inspectRepositoryBrief(this.workspace);
			this.builder.appendRuntimeNotice(brief.notice);
			this.recorder.write("environment", { runId, ...brief });
		}
		let approvalDenials = 0;

		const finish = (status: RunSummary["status"], reason: string): RunSummary => {
			this.acceptingInterjections = false;
			const recordingFailed = () => {
				status = "failed";
				const notice = "运行记录写入失败，请修复存储后继续";
				if (!reason.includes(notice)) reason += `；${notice}`;
			};
			const record = (write: () => void) => { try { write(); } catch { recordingFailed(); } };
			if (this.interjections.length) {
				reason += `；${this.interjections.length} 条跟进未送达，请作为新任务提交`;
				for (const input of this.interjections.splice(0)) record(() => this.recorder.write("user.input", { runId, id: input.id, task: input.text, source: input.source, status: "undelivered" }));
			}
			let checkpoint: RunSummary["checkpoint"] = null;
			if (ckpt && baselineTree) {
				try {
					const end = ckpt.snapshot([...filesChanged].filter((p) => !isAbsolute(p)));
					checkpoint = { tree: baselineTree, changed: ckpt.changedPaths(baselineTree, end.tree) };
				} catch {
					checkpoint = null;
				}
			}
			// 检查点已生成后，附属录制失败不能丢掉可用的回滚句柄。
			if (checkpoint) {
				const changed = checkpoint.changed;
				record(() => this.recorder.write("file.hashes", { runId, changed: changed.map(c => ({ ...c, after: fileSha256(join(this.workspace.root, c.path)) })) }));
			}
			this.emit(runId, "run.completed", {
				status,
				reason,
				turns,
				totals: { requests: totals.requests, input: totals.input, cacheRead: totals.cacheRead, output: totals.output, cost: totals.cost, currency: totals.currency },
			}, event => {
				recordingFailed();
				// 只发布一次终态事件；磁盘录制失败时仍向调用方交付真实终态。
				if (event.type === "run.completed") { event.status = status; event.reason = reason; }
			});
			return {
				sessionId: this.sessionId,
				runId,
				status,
				reason,
				turns,
				totals,
				durationMs: Date.now() - started,
				finalText,
				filesChanged: [...filesChanged],
				checkpoint,
			};
		};

		// Recovering a funded run needs its complete transcript and counters. Do not
		// pretend a new session with the same ID starts with zero consumed tokens.
		if (guarded) {
			try { o.budget.claimRun(runId); }
			catch { return finish("limit", "该运行已有记录、正在执行或账本不可用；请核对旧账和历史，不能从零重新启动"); }
		}

		const preparePlan = () => {
			const interjectionIds = this.drainInterjections(runId);
			// Bind grants to the inputs actually present, before event callbacks can enqueue more.
			const actionEpoch = this.actionEpoch;
			// Past the first context line, results the program judges lossless fold in the background.
			const revision = this.planner.beforeRequest(this.builder, o.maxTokens);
			if (revision) this.noteRevision(runId, revision);
			const plan = this.builder.plan();
			// 旧运行若因其他异常留下未配对调用，不能作为新请求继续发送。
			assertToolPairing(plan.messages);
			assertFitsWindow(plan, o.maxTokens, this.contextWindow);
			const diff = diffPlans(this.prevPlan, plan);
			this.prevPlan = plan;
			return { plan, diff, interjectionIds, actionEpoch };
		};
		for (let turnIndex = 0; turnIndex < limits.maxTurns; turnIndex++) {
			if (runAuthorizationRevision !== this.authorizationRevision) return finish("limit", "用户已发来新指令，旧运行停止；请重新提交新指令");
			if (signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", deadlineSignal?.aborted ? "达到运行时间上限" : "用户取消");
			const turnId = `t${turnIndex + 1}`;
			turns = turnIndex + 1;
			this.emit(runId, "turn.started", { turnId, turnIndex });

			let prepared: ReturnType<typeof preparePlan>;
			// At the compaction line, fold what is lossless and let the model summarize the rest.
			try { await this.compactContext(runId, turnId, totals, limits, signal, false); }
			catch (err) {
				if (err instanceof ContextPublicationError) return finish("limit", `上下文未发布：${err.code}: ${err.message}`);
				if (err instanceof BudgetExceeded) return finish("limit", err.message);
				throw err;
			}
			try { prepared = preparePlan(); }
			catch (err) {
				if (err instanceof ContextPublicationError) return finish("limit", `上下文未发布：${err.code}: ${err.message}`);
				throw err;
			}
			let { plan, diff, interjectionIds } = prepared;

			let resp: ModelResponse | null = null;
			let responseSource: ToolResponseSource | null = null;
			let responseActionEpoch = prepared.actionEpoch;
			for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
				if (runAuthorizationRevision !== this.authorizationRevision) return finish("limit", "用户已发来新指令，旧运行不再请求模型");
				if (totals.requests >= (limits.maxRequests ?? Number.POSITIVE_INFINITY)) return finish("limit", `达到上游请求上限 ${limits.maxRequests}`);
				if (signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", deadlineSignal?.aborted ? "达到运行时间上限" : "用户取消");
				if (o.allowInterjection && attempt > 1) {
					try {
						prepared = preparePlan(); plan = prepared.plan; diff = prepared.diff;
						interjectionIds = [...interjectionIds, ...prepared.interjectionIds];
					} catch (err) {
						if (err instanceof ContextPublicationError) return finish("limit", `上下文未发布：${err.code}: ${err.message}`);
						throw err;
					}
				}
				// An event emitted while planning can synchronously accept another input.
				// Rebuild until the request contains it; do not grant the old body a new epoch.
				let rebuilds = 0;
				while (o.allowInterjection && this.interjections.length) {
					if (++rebuilds > 32) return finish("limit", "请求组装期间跟进过于频繁，未发送旧正文");
					try {
						prepared = preparePlan(); plan = prepared.plan; diff = prepared.diff;
						interjectionIds = [...interjectionIds, ...prepared.interjectionIds];
					} catch (err) {
						if (err instanceof ContextPublicationError) return finish("limit", `上下文未发布：${err.code}: ${err.message}`);
						throw err;
					}
				}
				responseActionEpoch = prepared.actionEpoch;
				const requestId = `${runId}-${turnId}-a${attempt}${guarded ? `-${randomUUID()}` : ""}`;
				let inputBound = exact ? 0 : guarded ? requestByteBound(plan.system, plan.tools, plan.messages) : plan.totalTokensEst;
				if (!exact && guarded && (totals.input + totals.cacheRead + inputBound > limits.maxInputTokens || totals.output + o.maxTokens > limits.maxOutputTokens)) return finish("limit", "下一次模型请求会超过任务 token 上限");
				if (!exact) try {
					const worst = worstCase(o, inputBound);
					if (guarded) o.budget.reserve({ runId, requestId, amount: worst }, limits.maxCost);
					else o.budget.check(worst, limits.maxCost, runId);
				} catch (err) {
					if (err instanceof BudgetExceeded) return finish("limit", err.message);
					throw err;
				}
				const emitRequest = () => this.emit(runId, "model.request", {
					turnId,
					requestId,
					attempt,
					isRetry: attempt > 1,
					purpose: "agent-turn",
					segments: plan.segments.map((s) => ({ kind: s.kind, tokensEst: s.tokensEst, hash: s.hash, ...(s.masked ? { masked: true } : {}) })),
					prefixHash: plan.prefixHashes.at(-1) ?? "",
					firstChangedSegment: diff.firstChanged ? `${diff.firstChanged.position}:${diff.firstChanged.kind}` : null,
					...(o.allowInterjection && interjectionIds.length ? { interjectionIds } : {}),
				});
				let gateClosed = false;
				let preparedEvidence: ExactInputEvidence | null = null;
				let reserved = false;
				let dispatched = false;
				let gateError: string | null = null;
				const refuse = (reason: string): never => { gateError = reason; gateClosed = true; throw new Error(reason); };
				const checkLive = () => {
					if (gateClosed) refuse("发送检查已关闭，不能继续旧请求");
					if (signal.aborted) refuse("请求发送前已取消");
					if (runAuthorizationRevision !== this.authorizationRevision) refuse("用户已发来新指令，旧请求不能发送");
					if (limits.maxDurationMs && Date.now() - started >= limits.maxDurationMs) refuse("达到运行时间上限");
					if (totals.requests >= (limits.maxRequests ?? Number.POSITIVE_INFINITY)) refuse("达到上游请求上限");
				};
				const dispatchControl: ExactInputDispatch = {
					beforeDispatch: async evidence => {
						checkLive();
						if (preparedEvidence || reserved) refuse("精确输入检查被重复调用");
						if (evidence.counterIdentity !== exactInputIdentity(o.adapter) || evidence.method !== "trusted-final-body" ||
							evidence.model !== o.model || evidence.maxTokens !== o.maxTokens || !/^[a-f0-9]{64}$/.test(evidence.bodySha256) ||
							!Number.isSafeInteger(evidence.bodyBytes) || evidence.bodyBytes < 1 || !Number.isSafeInteger(evidence.inputTokens) || evidence.inputTokens < 0) refuse("精确计数身份或正文信息无效");
						inputBound = evidence.inputTokens;
						if (totals.input + totals.cacheRead + inputBound > limits.maxInputTokens || totals.output + o.maxTokens > limits.maxOutputTokens) refuse("下一次模型请求会超过任务 token 上限");
						preparedEvidence = Object.freeze({ ...evidence });
						o.budget.reserve({ runId, requestId, amount: worstCase(o, inputBound) }, limits.maxCost);
						reserved = true;
						this.recorder.write("model.preflight", { runId, requestId, ...preparedEvidence, status: "prepared-not-sent" });
						emitRequest();
						checkLive();
					},
					dispatch: (evidence, send) => {
						checkLive();
						if (!reserved || !preparedEvidence || dispatched || JSON.stringify(evidence) !== JSON.stringify(preparedEvidence)) refuse("请求未通过检查、正文改变或重复发送");
						this.recorder.write("model.dispatch", { runId, requestId, bodySha256: evidence.bodySha256, status: "dispatch-attempt" });
						checkLive();
						dispatched = true;
						// No asynchronous work between the private state transition and the actual fetch.
						return send();
					},
				};
				if (!exact) emitRequest();
				const requestStarted = Date.now();
				try {
					const request = {
						model: o.model,
						system: plan.system,
						tools: plan.tools,
						messages: plan.messages,
						thinking: o.thinking,
						maxTokens: o.maxTokens,
						...(o.userId ? { userId: o.userId } : {}),
						signal,
						verbatimToolArguments: o.verbatimToolArguments ?? false,
					};
					const handlers = {
						onText: (d: string) => this.emit(runId, "message.delta", { turnId, kind: "text", text: d }),
						onThinking: (d: string) => this.emit(runId, "message.delta", { turnId, kind: "thinking", text: d }),
						onToolArgs: (index: number, tool: string, text: string) => { if (tool === "file_write" || tool === "file_edit") this.emit(runId, "tool.writing", { turnId, index, tool, text }); },
					};
					resp = exact ? await completeWithExactInputGate(o.adapter, request, { ...handlers, exactInput: dispatchControl }) : await o.adapter.complete(request, handlers);
				} catch (error) {
					if (!guarded) throw error;
					if (exact && !dispatched) gateError ??= error instanceof Error ? error.message : String(error);
					resp = {
						ok: false, message: { role: "assistant", content: "", reasoning: "", toolCalls: [] }, finishReason: null,
						responseModel: o.model, responseId: null, rawUsage: null, usage: normalizeUsage("deepseek", null), httpStatus: null,
						requestBody: null, startedAt: requestStarted, firstByteAt: null, finishedAt: Date.now(),
						error: { message: "模型接口异常，扣费状态未知", retryable: false }, retryAfterMs: null, aborted: signal.aborted,
					};
				}
				// Closing is permanent even if an outer wrapper raced cancellation against counting.
				gateClosed = true;
				if (exact && !dispatched) {
					const reason = gateError ?? resp.error?.message ?? "受信适配器没有经过发送检查";
					try {
						if (reserved) o.budget.settleReservation({ runId, requestId, amount: 0, partial: false });
						this.recorder.write("model.not-sent", { runId, requestId, reason, reserved, evidence: preparedEvidence, cost: 0 });
					} catch { return finish("limit", "未发送请求的记录或零结算失败；保留账本，停止后续操作"); }
					return finish(signal.aborted && !deadlineSignal?.aborted ? "cancelled" : "limit", reason);
				}
				let feePartial: boolean;
				try { feePartial = this.account(runId, turnId, requestId, attempt, resp, plan, diff.firstChanged ? `${diff.firstChanged.position}:${diff.firstChanged.kind}` : null, totals, inputBound); }
				catch (error) {
					if (!guarded) throw error;
					return finish("limit", "请求已发生，但费用超出预留或记账失败；已停止后续操作，请检查账本");
				}
				if (exact && resp.rawUsage !== null && resp.rawUsage.prompt_tokens !== inputBound) return finish("limit", "精确输入计数与模型报告不一致；费用已记录，停止后续操作");
				if (resp.ok && trustworthyUsage(resp.usage)) this.planner.noteUsage(plan.totalTokensEst, plan.revision, (resp.usage.input ?? 0) + (resp.usage.cacheRead ?? 0) + (resp.usage.cacheWrite ?? 0));
				// A server error status (503 overloaded) with no usage or invoice evidence at all is charged at
				// worst case and retried. Anything else with incomplete usage, such as a stream that broke after
				// HTTP 200 or contradictory invoice evidence, still stops a guarded run here.
				const bareServerError = !resp.ok && resp.error?.retryable === true && resp.rawUsage === null && resp.httpStatus !== null && resp.httpStatus >= 500
					&& resp.billingReceipt === undefined && resp.billingReceiptRejected !== true;
				if (guarded && !o.allowPartialUsage && feePartial && !bareServerError) return finish("limit", "请求用量不完整，已保守计费并停止后续操作");
				if (resp.ok) {
					responseSource = Object.freeze({ sessionId: this.sessionId, runId, turnId, requestId, attempt, responseId: resp.responseId ?? null });
					break;
				}
				if (resp.aborted || signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", deadlineSignal?.aborted ? "达到运行时间上限" : "用户取消");
				this.emit(runId, "error", { message: resp.error?.message ?? "模型请求失败", retryable: resp.error?.retryable ?? false });
				if (!resp.error?.retryable) return finish("failed", `模型请求失败：${resp.error?.message ?? "未知错误"}`);
				if (attempt === retry.maxAttempts) return finish("failed", `模型服务连续出错，已自动重试 ${attempt - 1} 次，先暂停：${resp.error?.message ?? "未知错误"}`);
				if (resp.retryAfterMs !== null && !(resp.retryAfterMs <= MAX_TIMER_MS)) return finish("failed", "模型服务要求等待的时间超过可等待的上限，停止重试");
				await sleep(retryDelayMs(retry, attempt, resp.retryAfterMs), signal);
			}
			if (!resp?.ok || !responseSource) return finish("failed", "模型请求失败");
			if (runAuthorizationRevision !== this.authorizationRevision) return finish("limit", "用户已发来新指令，旧模型响应不再执行操作");

			const msg = resp.message;
			try { this.builder.validateAssistantToolCalls(msg); }
			catch (error) { return finish("failed", `模型工具调用无效：${error instanceof Error ? error.message : String(error)}`); }
			if (msg.content) this.indexVisible(msg.content, { role: "assistant" });
			this.builder.appendAssistant(msg);
			this.emit(runId, "message.completed", {
				turnId,
				text: msg.content,
				reasoningChars: msg.reasoning.length,
				toolCalls: msg.toolCalls.map((t) => ({ id: t.id, name: t.name })),
			});
			if (totals.input + totals.cacheRead > limits.maxInputTokens) return finish("limit", `输入 token 超过上限 ${limits.maxInputTokens}`);
			if (totals.output > limits.maxOutputTokens) return finish("limit", `输出 token 超过上限 ${limits.maxOutputTokens}`);

			if (msg.toolCalls.length === 0) {
				finalText = msg.content;
				if (resp.finishReason === "length") return finish("failed", "输出达到 max_tokens 被截断");
				this.emit(runId, "turn.completed", { turnId, stopReason: resp.finishReason ?? "stop" });
				if (o.allowInterjection && this.interjections.length) continue;
				// Agents still working report here first; their answers arrive as input and the run goes on.
				if (o.team?.beforeFinish) {
					await o.team.beforeFinish(signal);
					if (this.interjections.length) continue;
					if (signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", "运行已取消");
				}
				return finish("completed", "模型给出最终答复");
			}

			let pauseReason: string | null = null;
			const { results, recordingFailed, observationFailed } = await this.executeToolCalls(responseSource, msg.toolCalls, signal, beforeWrite, async (call, args) => {
				if (runAuthorizationRevision !== this.authorizationRevision) pauseReason = "用户已发来新指令，旧运行停止";
				if (pauseReason) return { decision: "ask", reason: pauseReason };
				if (!o.modelApproval || !["command_run", "file_edit", "file_write", ...o.modelApproval.settings.manualTools].includes(call.name)) return null;
				let decision: ReviewedApprovalDecision;
				try { decision = await this.reviewTool(runId, turnId, call, args, plan, limits, totals, signal); }
				catch { decision = { decision: "ask", reason: "审批处理失败，操作未执行，请检查审批记录" }; }
				if (decision.decision === "ask" && !decision.manualFallback) pauseReason = decision.reason ?? "需要用户决定";
				if (decision.decision === "deny" && !(o.allowInterjection && responseActionEpoch !== this.actionEpoch) && ++approvalDenials >= o.modelApproval.settings.maxDenials) pauseReason = "审批拒绝次数达到上限，请用户检查授权或操作方案";
				return decision;
			}, o.allowInterjection ? responseActionEpoch : undefined);
			let archiveFailed = false;
			for (const r of results) {
				// The tool has already run. A failed archive must not lose its result or leave the call unpaired;
				// without an archive the result simply stays verbatim (it cannot be folded).
				let shownRef = "";
				try { shownRef = this.blobs.put(r.result.modelContent, { kind: "shown", source: { toolCallId: r.call.id } }); }
				catch { archiveFailed = true; }
				this.builder.appendToolResult(r.call.id, r.call.name, r.result.modelContent, {
					kind: r.call.name === "file_read" ? "file_content" : "tool_output",
					ref: shownRef,
					target: toolTarget(r.call.name, (r.call as { argumentsJson?: string }).argumentsJson ?? "{}"),
					...(r.result.fullOutputRef ? { fullOutputRef: r.result.fullOutputRef } : {}),
					...(r.result.fullOutputRef && ["file_read", "command_run"].includes(r.call.name) ? { fullOutputSourceCallId: r.call.id } : {}),
					...(!r.result.ok ? { preserve: "error" as const } : {}),
					checkpointSafe: r.result.ok && this.toolByName.get(r.call.name)?.readOnly === true,
					// A recorded working note is never masked or folded.
					...((r.call.name === "task_note" || r.call.name === "skill") && r.result.ok ? { preserve: "unresolved" as const } : {}),
					...(r.call.name === "file_read" && r.result.ok ? readLines(r.result.details) : {}),
					...(!shownRef ? { preserve: "unresolved" as const } : {}),
				}, r.result.images);
				if (shownRef) {
					// A call with its arguments misnamed has no target; that is the model's mistake to correct, not a storage fault.
					const target = toolTarget(r.call.name, r.call.argumentsJson);
					this.indexVisible(r.result.modelContent, { role: "tool", toolCallId: r.call.id, name: r.call.name, ...(target ? { target } : {}), ref: shownRef });
				}
				const verifiedPartialQuery = r.call.name === "query_plan" &&
					r.result.details.partial === true && r.result.details.receiptsVerified === true;
				if ((r.result.ok || verifiedPartialQuery) && !r.result.details.deduped && !r.result.details.outline && !r.result.details.classOutline && !r.result.details.invalidUtf8 && Number(r.result.details.longLines ?? 0) === 0) {
					// Only source ranges actually published above may become references on future reads.
					for (const read of r.result.reads ?? []) {
						if (typeof read.path === "string" && /^[a-f0-9]{64}$/.test(read.hash) && Number.isSafeInteger(read.startLine) && Number.isSafeInteger(read.endLine) && Number.isSafeInteger(read.totalLines) && read.startLine >= 1 && read.endLine >= read.startLine && read.endLine <= read.totalLines) {
							this.files.markDelivered(read.path, read.hash, read.startLine, read.endLine);
						}
					}
				}
			}
			const handoff = results.find(r => r.result.ok && this.toolByName.get(r.call.name)?.canHandoff && r.result.control?.kind === "handoff");
			if (handoff) finalText = handoff.result.control!.message;
			if (recordingFailed) return finish("failed", "工具记录写入失败；已有工具结果已保留，未开始的操作未执行");
			if (archiveFailed) return finish("failed", "工具已执行，但结果归档失败；工具结果已保留在对话中，请修复存储后再继续");
			if (observationFailed) return finish("failed", "工具执行核对失败；已有工具结果已保留，未开始的操作未执行");
			if (runAuthorizationRevision !== this.authorizationRevision) return finish("limit", "用户已发来新指令，未执行剩余操作");
			if (signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", "运行已取消，未执行剩余操作");
			if (handoff) { this.emit(runId, "turn.completed", { turnId, stopReason: "handoff" }); return finish("completed", "网页已交还用户，等待回复"); }
			if (pauseReason) return finish("limit", `等待用户审批：${pauseReason}`);
			this.emit(runId, "turn.completed", { turnId, stopReason: "tool_calls" });
		}
		return finish("limit", `达到最大轮数 ${limits.maxTurns}`);
	}

	private async reviewTool(runId: string, turnId: string, call: ToolCall, args: Record<string, unknown>, plan: ContextPlan, limits: RunLimits, totals: RunTotals, signal: AbortSignal): Promise<ReviewedApprovalDecision> {
		const approval = this.options.modelApproval!;
		const settings = approval.settings;
		const authorizationRevision = this.authorizationRevision;
		const actionEpoch = this.actionEpoch;
		let actionHash = "";
		const resolve = (decision: ApprovalDecision, rule: string | null = null): ApprovalDecision => {
			if (decision.decision === "allow" && this.options.allowInterjection && actionEpoch !== this.actionEpoch) {
				decision = { decision: "deny", reason: "用户插话使旧审批失效，操作未执行" }; rule = null;
			}
			this.emit(runId, "approval.resolved", { toolCallId: call.id, decision: decision.decision, rule, actionHash, ...(decision.risk ? { level: decision.risk } : {}), ...(decision.decision !== "allow" && decision.reason ? { reason: decision.reason } : {}) });
			this.recorder.write("approval.decision", { runId, turnId, toolCallId: call.id, actionHash, rule, ...decision });
			return decision;
		};
		const ask = (reason: string) => resolve({ decision: "ask", reason });
		if (signal.aborted) return ask("运行已取消");
		if (settings.manualTools.includes(call.name)) return ask("该操作已设为由用户亲自审批");
		let snapshot: ReturnType<typeof snapshotApprovalAction>;
		try { snapshot = snapshotApprovalAction(this.workspace, call.name, args); }
		catch { return ask("无法固定操作目标或读取范围，请用户检查参数"); }
		actionHash = snapshot.fingerprint;
		if (this.options.lenientApproval) {
			if (snapshot.risk === "read-only") return resolve({ decision: "allow", risk: "low" }, "read-only");
			if (this.canUndo(call.name, args)) return resolve({ decision: "allow", risk: "low" }, "reversible");
			const allowed = approvalKey(call.name, args);
			if (this.userAllowed.has(allowed)) {
				const risk = this.userAllowed.get(allowed);
				return resolve({ decision: "allow", ...(risk ? { risk } : {}) }, "remembered");
			}
		}
		this.emit(runId, "approval.requested", { toolCallId: call.id, command: `${call.name} ${JSON.stringify(args)}`, cwd: snapshot.cwd, risk: snapshot.risk, explanation: "核对用户授权与实际操作范围", source: "model" });
		if (this.options.allowInterjection && actionEpoch !== this.actionEpoch) return resolve({ decision: "deny", reason: "用户插话使旧审批失效，操作未执行" });
		// Preauthorizations are exact user-authored records, not regex risk shortcuts.
		const currentTask = this.userRequests.at(-1)?.text;
		const stable = (value: unknown): string => {
			if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
			if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
			return JSON.stringify(value);
		};
		const rule = settings.allowRules.find((r) => r.userRequest === currentTask && r.tool === call.name && r.cwd === snapshot.cwd && stable(r.arguments) === stable(args));
		if (rule) return resolve({ decision: "allow" }, rule.id);
		// The lenient window moves in steps, so reviews in a row keep the same start for the cache.
		const windowStart = Math.max(0, plan.messages.length - settings.contextMessages);
		let selected = settings.contextMessages === 0 ? [] : plan.messages.slice(this.options.lenientApproval ? windowStart - windowStart % 6 : -settings.contextMessages);
		let earlierEnd = plan.messages.length - selected.length;
		const fetchedContext: ApprovalFetchedItem[] = [];
		const maxExtraRounds = settings.maxRequests > 1 ? 2 : 0;
		for (let round = 0; round <= maxExtraRounds; round++) {
			const allowContextRequest = round < maxExtraRounds;
			const evidence: ApprovalEvidence = {
				action: { id: call.id, tool: call.name, arguments: structuredClone(args), cwd: snapshot.cwd, risk: snapshot.risk, observationLimits: snapshot.limitations },
				userRequests: structuredClone(this.userRequests),
				context: { system: this.options.lenientApproval ? "" : plan.system, messages: selected, omittedMessages: plan.messages.length - selected.length },
				memoryState: null,
				...(fetchedContext.length ? { fetchedContext: structuredClone(fetchedContext) } : {}),
			};
			let request;
			for (;;) {
				try {
					request = buildApprovalRequest(evidence, { model: settings.model, thinking: settings.thinking, maxTokens: settings.maxTokens, maxInputChars: settings.maxInputChars, signal, lenient: this.options.lenientApproval === true, allowContextRequest });
					break;
				} catch (error) {
					if (error instanceof ApprovalInputError && error.code === "APPROVAL_INPUT_TOO_LARGE" && round === 0 && selected.length > 0) {
						selected = selected.slice(1);
						earlierEnd = plan.messages.length - selected.length;
						evidence.context = { system: this.options.lenientApproval ? "" : plan.system, messages: selected, omittedMessages: earlierEnd };
						continue;
					}
					return ask("审批材料超过限额或格式不完整，请用户检查；没有额外请求模型");
				}
			}
			// UTF-8 byte size + protocol margin is deliberately conservative for preflight.
			const inputBound = Buffer.byteLength(request.system + JSON.stringify(request.messages), "utf8") + 4096;
			if (totals.requests >= (limits.maxRequests ?? Number.POSITIVE_INFINITY) || totals.input + totals.cacheRead + inputBound > limits.maxInputTokens || totals.output + settings.maxTokens > limits.maxOutputTokens) return ask("审批请求会超过任务次数或 token 上限");
			const rate = settings.conversion?.rate ?? 1;
			const price = settings.pricing;
			const worst = (inputBound * Math.max(price.inputPerMillion, price.cacheReadPerMillion ?? price.inputPerMillion) + settings.maxTokens * price.outputPerMillion) / 1_000_000 * rate;
			const requestId = `${runId}-${turnId}-approval-${randomUUID()}`;
			try {
				this.options.budget.reserve({ runId, requestId, amount: worst, scope: { key: `approval:${runId}`, maxCost: settings.maxCost, maxRequests: settings.maxRequests } }, limits.maxCost);
			} catch { return ask("审批预算不足、已达调用上限或账本不可用；操作未执行"); }
			this.emit(runId, "model.request", { turnId, requestId, attempt: round + 1, isRetry: false, purpose: "approval", segments: [], prefixHash: sha256(request.system), firstChangedSegment: null });
			this.recorder.write("approval.request", { runId, turnId, requestId, toolCallId: call.id, actionHash, round: round + 1, model: settings.model, thinking: settings.thinking, evidence, bindings: snapshot.bindings, limitations: snapshot.limitations, inputBound, reservedCost: worst });
			const response = await boundedApprovalResponse(approval.adapter, request, settings.timeoutMs);
			const charge = approvalCharge(settings, response);
			const cost = charge?.amount ?? worst;
			const usage = response.usage;
			totals.requests++;
			totals.approvalRequests = (totals.approvalRequests ?? 0) + 1;
			totals.approvalCost = (totals.approvalCost ?? 0) + cost;
			totals.cost += cost;
			totals.input += charge ? usage.input! + (usage.cacheWrite ?? 0) : inputBound;
			totals.cacheRead += charge ? usage.cacheRead! : 0;
			totals.output += charge ? usage.output! : settings.maxTokens;
			totals.reasoning += charge ? usage.reasoning ?? 0 : 0;
			if (!charge) totals.usagePartialRequests++;
			let settlementFailed = false;
			try { this.options.budget.settleReservation({ runId, requestId, ...(charge ? { amount: cost } : {}), partial: !charge }); }
			catch { settlementFailed = true; }
			this.ledger.append({ sessionId: this.sessionId, runId, turnId, requestId, responseId: response.responseId, attempt: round + 1, isRetry: false, purpose: "approval", model: response.responseModel ?? settings.model, startedAt: new Date(response.startedAt).toISOString(), firstTokenAt: response.firstByteAt ? new Date(response.firstByteAt).toISOString() : null, finishedAt: new Date(response.finishedAt).toISOString(), usage, rawUsage: response.rawUsage, cost, currency: totals.currency, costEstimated: true, costPartial: !charge, priceVersion: `${price.version}${settings.conversion ? `;conversion=${rate}@${settings.conversion.asOf}` : ""}`, pricePeriod: "configured-approval", httpStatus: response.httpStatus, error: response.error?.message ?? null, requestSha256: response.requestBody ? sha256(response.requestBody) : null, contextRevision: plan.revision, firstChangedSegment: null });
			this.recorder.write("approval.usage", { runId, requestId, responseId: response.responseId, nativeCurrency: price.currency, nativeCost: charge?.nativeAmount ?? worst / rate, convertedCost: cost, taskCurrency: totals.currency, conversion: settings.conversion ?? null, partial: !charge });
			if (settlementFailed) return ask("审批费用超出预留或账本不能结算；操作未执行，请检查费用记录");
			// Interactive callers must persist an unknown charge, rather than treating its
			// conservative reservation as a verified bill. Legacy event fields stay unchanged.
			const eventModel = approval.manualFallback ? response.responseModel ?? settings.model : settings.model;
			const eventCost = approval.manualFallback && !charge ? null : cost;
			this.emit(runId, "usage", { turnId, requestId, model: eventModel, usage, rawUsage: response.rawUsage, cost: eventCost, currency: totals.currency, costEstimated: true, priceVersion: price.version, pricePeriod: "configured-approval", durationMs: response.finishedAt - response.startedAt, firstTokenMs: response.firstByteAt ? response.firstByteAt - response.startedAt : null });
			if (signal.aborted) return ask("运行已取消，迟到的审批不会执行");
			if (authorizationRevision !== this.authorizationRevision) return ask("用户已发来新指令，旧审批已失效；请先处理新指令");
			if (this.options.allowInterjection && actionEpoch !== this.actionEpoch) return resolve({ decision: "deny", reason: "用户插话使旧审批失效，迟到的授权不会执行" });
			if (!charge && !this.options.allowPartialUsage) return ask("审批用量或扣费不完整，已保守计费；请用户检查");
			if (totals.output > limits.maxOutputTokens || totals.input + totals.cacheRead > limits.maxInputTokens || totals.cost > limits.maxCost) return ask("审批后达到任务限额，操作未执行");
			const step = parseApprovalStep(response, evidence, { allowContextRequest, lenient: this.options.lenientApproval === true });
			if (step.decision === "need_context") {
				this.emit(runId, "approval.requested", { toolCallId: call.id, command: `${call.name} ${JSON.stringify(args)}`, cwd: snapshot.cwd, risk: snapshot.risk, explanation: "正在获取更多上下文", source: "model" });
				const usedChars = request.system.length + request.messages[0]!.content.length;
				const room = Math.max(0, settings.maxInputChars - usedChars - 512);
				if (room < 256) return ask("审批上下文已达输入上限，需要用户确认");
				const gathered = await this.fulfillApprovalContext(step.requests, plan, earlierEnd, room, signal);
				earlierEnd = gathered.nextEarlierEnd;
				this.recorder.write("approval.context", { runId, turnId, toolCallId: call.id, round: round + 1, requests: step.requests, items: gathered.items.length });
				if (!gathered.items.length) return ask("未能获取到更多审批上下文，需要用户确认");
				fetchedContext.push(...gathered.items);
				continue;
			}
			const decision = step;
			if (decision.decision === "allow") {
				try { if (snapshotApprovalAction(this.workspace, call.name, args).fingerprint !== actionHash) return ask("审批期间操作目标发生变化，请重新检查"); }
				catch { return ask("审批后无法重新核对操作目标"); }
			}
			if (decision.decision === "ask" && approval.manualFallback && this.options.askApproval && !response.aborted
				&& ["command_run", "file_edit", "file_write"].includes(call.name)) {
				// Only arrive here after complete usage, successful settlement and limit checks.
				// The official tool asks the human; its eventual allow cannot approve changed targets.
				return { ...resolve(decision), manualFallback: () => {
					if (signal.aborted || authorizationRevision !== this.authorizationRevision
						|| this.options.allowInterjection && actionEpoch !== this.actionEpoch) return false;
					try { return snapshotApprovalAction(this.workspace, call.name, args).fingerprint === actionHash; }
					catch { return false; }
				} };
			}
			return resolve(decision);
		}
		return ask("审批上下文补充次数已达上限，需要用户确认");
	}

	private async fulfillApprovalContext(
		requests: ApprovalContextRequest[],
		plan: ContextPlan,
		earlierEnd: number,
		roomChars: number,
		signal: AbortSignal,
	): Promise<{ items: ApprovalFetchedItem[]; nextEarlierEnd: number }> {
		const items: ApprovalFetchedItem[] = [];
		let remaining = roomChars;
		let cursor = earlierEnd;
		const pushItem = (kind: ApprovalFetchedItem["kind"], target: string, rawContent: string) => {
			const overhead = target.length + 80;
			if (remaining <= overhead + 32) return;
			const cap = Math.min(3200, remaining - overhead);
			const content = rawContent.length > cap ? `${rawContent.slice(0, cap)}…[truncated]` : rawContent;
			items.push({ kind, target, content });
			remaining -= JSON.stringify({ kind, target, content }).length + 4;
		};
		for (const req of requests) {
			if (signal.aborted || remaining < 160) break;
			if (req.kind === "earlier_messages") {
				if (cursor <= 0) {
					pushItem("earlier_messages", "messages[none]", "No earlier messages remain outside the provided window.");
					continue;
				}
				const count = Math.min(req.count ?? 8, 20, cursor);
				const start = Math.max(0, cursor - count);
				const slice = plan.messages.slice(start, cursor).map((msg, i) => {
					const idx = start + i;
					if (msg.role === "assistant") {
						const calls = msg.toolCalls.map((c) => `${c.name}(${c.argumentsJson.slice(0, 160)})`).join(", ");
						return `[#${idx} assistant] ${msg.content.slice(0, 600)}${calls ? ` | calls: ${calls}` : ""}`;
					}
					if (msg.role === "tool") return `[#${idx} tool:${msg.name}] ${msg.content.slice(0, 600)}`;
					return `[#${idx} user] ${msg.content.slice(0, 600)}`;
				}).join("\n");
				cursor = start;
				pushItem("earlier_messages", `messages[${start}..${start + count - 1}]`, slice);
			} else if (req.kind === "search_history") {
				try {
					if (!this.sessionIndex) {
						pushItem("search_history", req.query, "Session search unavailable.");
						continue;
					}
					const found = await this.sessionIndex.search({ needle: req.query, maxMatches: 5 }, { blobs: this.blobs, workspaceRoot: this.workspace.root, signal });
					const summary = found.ok && found.matches.length
						? found.matches.map((m) => `[#${m.ordinal} ${m.role}${m.name ? `:${m.name}` : ""} ref=${m.ref}] ${m.text}`).join("\n")
						: "No matching text in earlier session records.";
					pushItem("search_history", req.query, summary);
				} catch {
					pushItem("search_history", req.query, "Session search unavailable.");
				}
			} else if (req.kind === "expand_blob") {
				const text = (this.blobs.has(req.ref, "shown") || this.blobs.has(req.ref, "raw")) ? this.blobs.get(req.ref) : null;
				pushItem("expand_blob", req.ref, text ?? "Archive ref not found in this session.");
			} else if (req.kind === "read_file") {
				try {
					const { abs } = this.workspace.resolve(req.path);
					const st = lstatSync(abs);
					if (!st.isFile()) pushItem("read_file", req.path, "Target is not a regular file.");
					else if (st.size > 2 * 1024 * 1024) pushItem("read_file", req.path, `File is ${st.size} bytes (> 2 MB); skipped.`);
					else {
						const lines = readFileSync(abs, "utf8").split(/\r?\n/);
						const start = Math.max(1, req.startLine ?? 1);
						const end = Math.min(lines.length, req.endLine ?? start + 119, start + 199);
						const body = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line.slice(0, 300)}`).join("\n");
						pushItem("read_file", `${req.path}:${start}-${end}`, body || "(empty)");
					}
				} catch {
					pushItem("read_file", req.path, "File does not exist or cannot be read.");
				}
			}
		}
		return { items, nextEarlierEnd: cursor };
	}

	private noteRevision(runId: string, revision: RevisionResult): void {
		this.files.forgetDelivered();
		this.recorder.write("context.revision", { runId, ...revision });
		this.emit(runId, "context.revision", { reason: revision.reason, maskedRefs: revision.maskedRefs, tokensBefore: revision.tokensBefore, tokensAfter: revision.tokensAfter });
	}

	/**
	 * At the compaction line (or on request): fold everything the program judges lossless;
	 * when that is not enough, the model summarizes the earlier interactions in one extra request on the
	 * cached prefix. If that request cannot run or fails, the program writes its own record instead.
	 */
	private async compactContext(runId: string, turnId: string, totals: RunTotals, limits: RunLimits, signal: AbortSignal, force: boolean): Promise<RevisionResult | null> {
		const o = this.options;
		const lines = this.planner.policy;
		const compactAt = lines.compactTokens ?? lines.hardLimitTokens;
		const over = () => this.planner.pressure(this.builder) + o.maxTokens >= compactAt;
		if (signal.aborted || !force && !over()) return null;
		let folded: RevisionResult | null = null;
		let budgetError: ContextPublicationError | null = null;
		try { folded = this.builder.losslessRevision(lines, o.maxTokens, this.planner.pressure(this.builder), true); }
		catch (error) {
			// A failed publication keeps the original history intact. It may still fit after
			// program compaction, without sending the over-limit history to the model.
			if (!(error instanceof ContextPublicationError) || error.code !== "CONTEXT_BUDGET_EXCEEDED") throw error;
			budgetError = error;
		}
		if (folded) this.noteRevision(runId, folded);
		if (!force && !budgetError && !over()) return folded;
		// On request (/compact) the kept tail is at most a quarter of the conversation, so something always goes.
		const tailStart = this.builder.compactionTailStart(lines.compactTailTokens ?? 0, force ? 0.25 : 1);
		if (tailStart === null) {
			if (budgetError) throw budgetError;
			return folded;
		}
		if (budgetError) this.recorder.write("context.compaction-request", { runId, sent: false, reason: "context-limit" });
		const summary = budgetError ? null : await this.requestSummary(runId, turnId, totals, limits, signal);
		// A cancelled compaction is a result of its own, never a reason to publish the program's fallback record.
		if (signal.aborted) return folded;
		// A summary longer than what it replaces would only grow the context: keep the program's record instead.
		const revision = (summary !== null ? this.builder.applyCompaction(summary, tailStart, o.maxTokens, lines.hardLimitTokens, true, true) : null)
			?? this.builder.applyCompaction(this.builder.compactionRecord(tailStart), tailStart, o.maxTokens, lines.hardLimitTokens, false);
		this.noteRevision(runId, revision);
		return revision;
	}

	/** The summary request: the unchanged conversation plus one instruction, so the cached prefix is reused. */
	private async requestSummary(runId: string, turnId: string, totals: RunTotals, limits: RunLimits, signal: AbortSignal): Promise<string | null> {
		const o = this.options;
		if (o.exactInputPreflight) return null;
		const guarded = o.requestGuard === true;
		const plan = this.builder.plan();
		const messages = [...plan.messages, { role: "user" as const, content: COMPACTION_REQUEST }];
		if (this.contextWindow && this.planner.pressure(this.builder) + estimateTokens(COMPACTION_REQUEST) + o.maxTokens > this.contextWindow) {
			this.recorder.write("context.compaction-request", { runId, sent: false, reason: "window" });
			return null;
		}
		const requestId = `${runId}-${turnId}-compact${guarded ? `-${randomUUID()}` : ""}`;
		const inputBound = guarded ? requestByteBound(plan.system, plan.tools, messages) : plan.totalTokensEst;
		const blocked = signal.aborted ? "cancelled"
			: totals.requests >= (limits.maxRequests ?? Number.POSITIVE_INFINITY) ? "request-limit"
			: guarded && (totals.input + totals.cacheRead + inputBound > limits.maxInputTokens || totals.output + o.maxTokens > limits.maxOutputTokens) ? "token-limit" : null;
		if (blocked) {
			this.recorder.write("context.compaction-request", { runId, sent: false, reason: blocked });
			return null;
		}
		try {
			const worst = worstCase(o, inputBound);
			if (guarded) o.budget.reserve({ runId, requestId, amount: worst }, limits.maxCost);
			else o.budget.check(worst, limits.maxCost, runId);
		} catch (err) {
			if (!(err instanceof BudgetExceeded)) throw err;
			this.recorder.write("context.compaction-request", { runId, sent: false, reason: err.message });
			return null;
		}
		// Hosts account every paid request from its announcement; the summary is one of them.
		this.emit(runId, "model.request", { turnId, requestId, attempt: 1, isRetry: false, purpose: "compaction",
			segments: plan.segments.map((seg) => ({ kind: seg.kind, tokensEst: seg.tokensEst, hash: seg.hash, ...(seg.masked ? { masked: true } : {}) })),
			prefixHash: plan.prefixHashes.at(-1) ?? "", firstChangedSegment: null });
		const started = Date.now();
		let resp: ModelResponse;
		try {
			resp = await o.adapter.complete({ model: o.model, system: plan.system, tools: plan.tools, messages, thinking: o.thinking, maxTokens: o.maxTokens,
				...(o.userId ? { userId: o.userId } : {}), signal, verbatimToolArguments: o.verbatimToolArguments ?? false });
		} catch (error) {
			if (!guarded) throw error;
			resp = {
				ok: false, message: { role: "assistant", content: "", reasoning: "", toolCalls: [] }, finishReason: null,
				responseModel: o.model, responseId: null, rawUsage: null, usage: normalizeUsage("deepseek", null), httpStatus: null,
				requestBody: null, startedAt: started, firstByteAt: null, finishedAt: Date.now(),
				error: { message: "模型接口异常，扣费状态未知", retryable: false }, retryAfterMs: null, aborted: signal.aborted,
			};
		}
		let partial: boolean;
		try { partial = this.account(runId, turnId, requestId, 1, resp, plan, null, totals, inputBound, "compaction"); }
		catch (error) {
			if (!guarded) throw error;
			throw new BudgetExceeded("压缩请求已发生，但费用超出预留或记账失败；已停止后续操作，请检查账本");
		}
		const usable = resp.ok && !resp.message.toolCalls.length && resp.finishReason !== "length" && resp.message.content.trim().length > 0;
		this.recorder.write("context.compaction-request", { runId, requestId, sent: true, ok: resp.ok, usable, finishReason: resp.finishReason, toolCalls: resp.message.toolCalls.length, chars: resp.message.content.length, usage: resp.usage });
		if (guarded && !o.allowPartialUsage && partial) throw new BudgetExceeded("压缩请求用量不完整，已保守计费并停止后续操作");
		return usable ? resp.message.content : null;
	}

	/** Compact an idle conversation now (a host's /compact). */
	async compactNow(signal: AbortSignal = new AbortController().signal): Promise<{ revision: RevisionResult | null; cost: number }> {
		const o = this.options;
		if (this.activeRun) throw new Error("任务运行中，先停止再压缩");
		if (signal.aborted) return { revision: null, cost: 0 };
		this.activeRun = true;
		// Compaction neither makes an unfinished session exportable nor an exportable one unfinished.
		const wasReady = this.snapshotReady;
		this.snapshotReady = false;
		const runId = `compact_${randomUUID().slice(0, 12)}`;
		const totals: RunTotals = { requests: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, cost: 0, currency: currencyOf(o.model, o.billingCurrency) ?? "USD", usagePartialRequests: 0 };
		try {
			if (o.requestGuard) o.budget.claimRun(runId);
			const revision = await this.compactContext(runId, "t0", totals, { ...DEFAULT_LIMITS, ...o.limits }, signal, true);
			this.prevPlan = this.builder.plan();
			return { revision, cost: totals.cost };
		} finally { this.activeRun = false; this.snapshotReady = wasReady; }
	}

	private account(
		runId: string,
		turnId: string,
		requestId: string,
		attempt: number,
		resp: ModelResponse,
		plan: ContextPlan,
		firstChanged: string | null,
		totals: RunTotals,
		inputBound = plan.totalTokensEst,
		purpose: "agent-turn" | "compaction" = "agent-turn",
	): boolean {
		const o = this.options;
		const guarded = o.requestGuard === true;
		const at = new Date(resp.startedAt);
		const modelMatches = resp.responseModel === null || responseModelMatches(o.model, resp.responseModel);
		// A registered response snapshot belongs to the requested route. In particular,
		// an OpenRouter request retains its route price instead of an upstream price.
		const pricingModel = modelMatches ? o.model : resp.responseModel ?? o.model;
		const est = estimateCost(pricingModel, resp.rawUsage ?? undefined, at, o.billingCurrency);
		const verifiedReceipt = resp.responseModel !== null && modelMatches
			? verifiedBillingReceipt(o.model, resp.rawUsage, resp.usage, resp.billingReceipt, currencyOf(o.model, o.billingCurrency) ?? "USD") : null;
		// An invalid invoice cannot fall back to catalog pricing, even when cache
		// details happen to be complete. Retain its conservative budget charge.
		const receiptCostProvided = (o.model === "openai/gpt-4.1-mini" || o.model === "Qwen/Qwen2.5-7B-Instruct") && resp.rawUsage?.cost !== undefined;
		const receiptRejected = resp.billingReceiptRejected === true || (resp.billingReceipt !== undefined || receiptCostProvided) && !verifiedReceipt;
		const receipt = receiptRejected ? null : verifiedReceipt;
		// usage 缺失时不能当作 0 成本：按最坏情况保守计入。
		// 例外：4xx 且没有 usage（限流 429、参数错误 400 等）供应商不计费，按 0 计，与代理口径一致；
		// 否则限流时每次 429 都按最坏情况累计，会让 Mountains 比 OpenCode 更早触发自己的费用上限。
		// A model on this computer costs nothing, so its usage report can be incomplete (LM Studio sends no cache fields) without stopping a guarded run.
		const unbilled = modelUnbilled(o) || !receiptRejected && !receipt && (guarded ? resp.rawUsage === null : !est) && resp.httpStatus !== null && resp.httpStatus >= 400 && resp.httpStatus < 500;
		const invalidUsage = !!guarded && (!modelMatches || !receipt && !trustworthyUsage(resp.usage));
		const partial = !unbilled && (receiptRejected || !receipt && (!est || est.partial || invalidUsage));
		const cost = unbilled ? 0 : receipt ? receipt.amount : est && !partial ? est.amount : worstCase(o, inputBound);
		const priceVersion = est?.priceVersion ?? pricingFor(o.model, o.billingCurrency)?.version ?? "unknown";
		const period = pricePeriod(at, pricingModel, o.billingCurrency);
		const u: Usage = resp.usage;
		totals.requests++;
		// Receipt input is the aggregate prompt count. Subtract only separately
		// counted cache hits; omitted cache details stay null in response evidence.
		const countedInput = u.input ?? (modelUnbilled(o) && typeof resp.rawUsage?.prompt_tokens === "number" ? resp.rawUsage.prompt_tokens : 0);
		totals.input += receipt ? receipt.inputTokens - (u.cacheRead ?? 0) : guarded && partial ? inputBound : countedInput + (guarded ? u.cacheWrite ?? 0 : 0);
		totals.cacheRead += guarded && partial ? 0 : u.cacheRead ?? 0;
		totals.output += receipt ? receipt.outputTokens : guarded && partial ? o.maxTokens : u.output ?? 0;
		totals.reasoning += guarded && partial ? 0 : u.reasoning ?? 0;
		totals.cost += cost;
		if (partial || receipt && u.partial) totals.usagePartialRequests++;
		// The independent budget journal must retain known actual cost even if the
		// detailed telemetry file cannot be written. Still try to save response evidence.
		let settlementError: unknown;
		if (guarded) {
			try { o.budget.settleReservation({ runId, requestId, amount: cost, partial }); }
			catch (error) { settlementError = error; }
		} else o.budget.record({ runId, requestId, amount: cost, partial });
		this.ledger.append({
			sessionId: this.sessionId,
			runId,
			turnId,
			requestId,
			responseId: resp.responseId ?? null,
			attempt,
			isRetry: attempt > 1,
			purpose,
			model: resp.responseModel,
			startedAt: new Date(resp.startedAt).toISOString(),
			firstTokenAt: resp.firstByteAt ? new Date(resp.firstByteAt).toISOString() : null,
			finishedAt: new Date(resp.finishedAt).toISOString(),
			usage: u,
			rawUsage: resp.rawUsage,
			cost,
			currency: totals.currency,
			costEstimated: true,
			costPartial: partial,
			priceVersion,
			pricePeriod: period,
			httpStatus: resp.httpStatus,
			error: resp.error?.message ?? null,
			requestSha256: resp.requestBody ? sha256(resp.requestBody) : null,
			contextRevision: plan.revision,
			firstChangedSegment: firstChanged,
		});
		this.recorder.write("model.response", {
			runId,
			turnId,
			requestId,
			attempt,
			ok: resp.ok,
			message: resp.message,
			// Arguments may be redacted in message; retain fingerprints without duplicating secrets.
			toolCallIdentities: resp.message.toolCalls.map(call => ({ id: call.id, name: call.name, argumentsSha256: sha256(call.argumentsJson), recordedArgumentsSha256: sha256(this.recorder.sanitize(call.argumentsJson) as string) })),
			finishReason: resp.finishReason,
			responseModel: resp.responseModel,
			responseId: resp.responseId ?? null,
			rawUsage: resp.rawUsage,
			...(receipt ? { billingReceipt: receipt } : {}),
			...(receiptRejected ? { billingReceiptRejected: true } : {}),
			httpStatus: resp.httpStatus,
			error: resp.error,
			aborted: resp.aborted,
			requestSha256: resp.requestBody ? sha256(resp.requestBody) : null,
		});
		this.emit(runId, "usage", {
			turnId,
			requestId,
			model: resp.responseModel ?? o.model,
			usage: u,
			rawUsage: resp.rawUsage,
			...(receipt ? { billingReceipt: receipt } : {}),
			...(receiptRejected ? { billingReceiptRejected: true } : {}),
			cost: receiptRejected ? null : cost,
			currency: totals.currency,
			costEstimated: !receipt,
			priceVersion,
			pricePeriod: period,
			durationMs: resp.finishedAt - resp.startedAt,
			firstTokenMs: resp.firstByteAt ? resp.firstByteAt - resp.startedAt : null,
		});
		if (settlementError) throw settlementError;
		return partial;
	}

	private async executeToolCalls(
		source: ToolResponseSource,
		calls: ToolCall[],
		signal: AbortSignal,
		beforeWrite: (abs: string) => void,
		review?: (call: ToolCall, args: Record<string, unknown>) => Promise<ReviewedApprovalDecision | null>,
		expectedActionEpoch?: number,
	): Promise<{ results: { call: ToolCall; result: ToolResult }[]; recordingFailed: boolean; observationFailed: boolean }> {
		const { runId, turnId } = source;
		const observer = this.options.toolObserver;
		let recordingFailed = false;
		let observationFailed = false;
		let handedOff = false;
		const onRecordingError = () => { recordingFailed = true; };
		const record = (write: () => void) => { try { write(); } catch { onRecordingError(); } };
		const notExecuted = (): ToolResult => ({ ok: false, modelContent: "未执行：工具记录写入失败，已停止后续操作", summary: "工具记录失败，操作未执行", details: { executed: false, recordingFailed: true } });
		const runOne = async (call: ToolCall): Promise<{ call: ToolCall; result: ToolResult }> => {
			const tool = this.toolByName.get(call.name);
			const identity: ToolExecutionIdentity = Object.freeze({ executionId: randomUUID(), source, toolCallId: call.id, name: call.name, argumentsSha256: sha256(call.argumentsJson), recordedArgumentsSha256: sha256(this.recorder.sanitize(call.argumentsJson) as string) });
			const metadata = { runId, turnId, toolCallId: call.id, name: call.name, executionId: identity.executionId, source };
			const instant = (): ToolExecutionInstant => Object.freeze({ wallTimeMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() });
			let started: ToolExecutionInstant | null = null, finished: ToolExecutionInstant | null = null;
			let dispatch: "not-started" | "returned" | "threw" = "not-started";
			const observation: Record<string, unknown> = {};
			const stale = () => expectedActionEpoch !== undefined && expectedActionEpoch !== this.actionEpoch && !tool?.readOnly;
			const revoked = (): ToolResult => ({ ok: false, modelContent: "未执行：用户插话使旧操作授权失效，请重新提出操作", summary: "旧操作授权已撤销", details: { approved: false, revoked: true } });
			const blocked = (): ToolResult | null => {
				if (handedOff) return { ok: false, modelContent: "未执行：网页已交还用户，等待新的人类回复", summary: "等待用户，后续操作未执行", details: { executed: false, awaitingUser: true } };
				if (recordingFailed) return notExecuted();
				if (observationFailed) return { ok: false, modelContent: "未执行：工具执行核对失败，已停止后续操作", summary: "工具执行核对失败，操作未执行", details: { executed: false, observationFailed: true } };
				if (signal.aborted) return { ok: false, modelContent: "操作已取消", summary: "操作已取消", details: { executed: false, cancelled: true } };
				return stale() ? revoked() : null;
			};
			let args: Record<string, unknown> = {};
			let argError: string | null = null;
			try {
				const v = JSON.parse(call.argumentsJson || "{}") as unknown;
				if (v && typeof v === "object" && !Array.isArray(v)) args = v as Record<string, unknown>;
				else argError = "参数必须是 JSON 对象";
			} catch {
				argError = "参数不是合法 JSON";
			}
			this.emit(runId, "tool.requested", { turnId, toolCallId: call.id, tool: call.name, args: argError ? call.argumentsJson : args, summary: call.name }, onRecordingError);
			record(() => this.recorder.write("tool.input", { ...metadata, arguments: call.argumentsJson, argumentsSha256: identity.argumentsSha256, recordedArgumentsSha256: identity.recordedArgumentsSha256 }));
			const t0 = Date.now();
			let result: ToolResult;
			const initialBlock = blocked();
			if (initialBlock) result = initialBlock;
			else if (!tool) result = { ok: false, modelContent: `错误：未知工具 ${call.name}`, summary: `未知工具 ${call.name}`, details: {} };
			else if (argError) result = { ok: false, modelContent: `错误：${argError}`, summary: argError, details: {} };
			else {
				let decision: ReviewedApprovalDecision | null = null;
				try { decision = await review?.(call, args) ?? null; }
				catch { decision = { decision: "ask", reason: "审批处理失败，操作未执行" }; }
				const reviewedBlock = blocked();
				if (reviewedBlock) result = reviewedBlock;
				else if (decision && decision.decision !== "allow" && !decision.manualFallback) {
					const reason = decision.reason ?? "需要用户决定";
					result = { ok: false, modelContent: `未执行：${reason}`, summary: `审批${decision.decision === "ask" ? "需用户决定" : "拒绝"}`, details: { approved: false, decision: decision.decision, reason } };
				} else {
					const manualFallback = decision?.manualFallback;
					let humanApproved = false;
					const ctx: ToolContext = {
						workspace: this.workspace,
						files: this.files,
						blobs: this.blobs,
						signal,
						toolCallId: call.id,
						deferReadPublication: true,
						// In model mode this exact call already passed the common gate. Risk labels
						// are evidence for review, not an unconditional dangerous-command veto.
						approve: async (req) => {
							if (this.refuseRisks?.has(req.risk)) return "deny";
							if (stale() || signal.aborted || manualFallback && (req.toolCallId !== call.id || !manualFallback())) return "deny";
							// The user sees why the approval model stopped, not the tool's own label.
							const asked = this.options.lenientApproval && decision?.reason ? { ...req, explanation: decision.reason } : req;
							const answer = this.options.modelApproval && decision?.decision === "allow" ? "allow" : await this.approve(runId, asked, signal, manualFallback, decision?.risk);
							humanApproved = answer === "allow";
							if (humanApproved && this.options.lenientApproval && decision?.decision !== "allow" && req.risk !== "dangerous" && decision?.risk !== "high") this.userAllowed.set(approvalKey(call.name, args), decision?.risk);
							return stale() || signal.aborted || manualFallback && !manualFallback() ? "deny" : answer;
						},
						...(expectedActionEpoch !== undefined || manualFallback ? { assertExecutionAllowed: () => {
							if (stale()) throw new Error("用户插话使旧操作授权失效，操作未执行");
							if (manualFallback && (!humanApproved || !manualFallback())) throw new Error("人工审批未完成或操作目标与授权已变化，操作未执行");
						} } : {}),
						beforeWrite: async (abs) => {
							if (this.refuseRisks?.has("workspace-write")) throw new Error("计划模式下不改文件");
							beforeWrite(abs);
						},
					};
					let prepared: ToolObservationValue = null;
					let beforeCompleted = false;
					if (observer) {
						try {
							prepared = await observeTool(observer, s => observer.before(identity, observationCopy(args), s), signal);
							beforeCompleted = true;
							observation.before = { status: "completed", receipt: prepared };
						} catch (error) {
							// Cancellation before dispatch is not a tool failure or permission to replay.
							if (!signal.aborted) observationFailed = true;
							observation.before = { status: signal.aborted ? "cancelled" : "failed", failure: observationFailureCode(error) };
						}
					}
					// Another parallel before may have failed while this one was waiting.
					const executionBlock = blocked();
					if (executionBlock) result = executionBlock;
					else {
						started = instant();
						try { result = await tool.execute(args, ctx); dispatch = "returned"; }
						catch (error) {
							dispatch = "threw";
							const message = toolFailureMessage(error);
							result = { ok: false, modelContent: `Tool failed: ${message}`, summary: `${call.name} failed`, details: { error: message } };
						}
						finished = instant();
					}
					if (observer && beforeCompleted) {
						try {
							const outcome = Object.freeze({ dispatch, started, finished, ok: result.ok, modelContentSha256: sha256(result.modelContent), recordedModelContentSha256: sha256(this.recorder.sanitize(result.modelContent) as string),
								details: observationCopy(result.details), reads: observationCopy(result.reads ?? []), writes: observationCopy(result.writes ?? []), control: observationCopy(result.control ?? null) });
							const receipt = await observeTool(observer, s => observer.after(identity, prepared, outcome, s));
							observation.after = { status: "completed", receipt };
						} catch (error) {
							observationFailed = true;
							observation.after = { status: "failed", failure: observationFailureCode(error) };
							// Preserve the actual ToolResult and all writes even when evidence is missing.
						}
					}
				}
			}
			if (tool?.canHandoff && result.ok && result.control?.kind === "handoff") handedOff = true;
			const durationMs = Date.now() - t0;
			// 执行结果独立于录制：不能将已完成的写入改成失败，也不能重放来补记录。
			record(() => this.recorder.write("tool.output", { ...metadata, ok: result.ok, modelContent: result.modelContent, details: result.details, durationMs,
				execution: { dispatch, started, finished }, ...(observer ? { observation } : {}),
				...(observer ? { modelContentSha256: sha256(result.modelContent), recordedModelContentSha256: sha256(this.recorder.sanitize(result.modelContent) as string) } : {}),
				...(result.images?.length ? { images: result.images.map(i => ({ mimeType: i.mimeType, width: i.width, height: i.height, sha256: sha256(i.data) })) } : {}) }));
			this.emit(runId, "tool.completed", {
				turnId,
				toolCallId: call.id,
				tool: call.name,
				ok: result.ok,
				summary: result.summary,
				modelContentChars: result.modelContent.length,
				durationMs,
				details: result.details,
			}, onRecordingError);
			return { call, result };
		};
		const allReadOnly = calls.every((c) => this.toolByName.get(c.name)?.readOnly && !this.toolByName.get(c.name)?.canHandoff && !this.options.modelApproval?.settings.manualTools.includes(c.name));
		// 并行读取必须全部收束后才能关闭运行；顺序调用则为未执行部分补齐结果。
		const results: { call: ToolCall; result: ToolResult }[] = [];
		if (allReadOnly) results.push(...await Promise.all(calls.map(runOne)));
		else for (const call of calls) results.push(await runOne(call));
		return { results, recordingFailed, observationFailed };
	}

	/** A file edit inside the workspace, which the run's checkpoints can put back. */
	private canUndo(tool: string, args: Record<string, unknown>): boolean {
		if (!this.undoable || (tool !== "file_write" && tool !== "file_edit") || typeof args.path !== "string") return false;
		try { return this.workspace.contains(this.workspace.resolve(args.path, { forWrite: true }).abs); }
		catch { return false; }
	}

	private async approve(runId: string, req: ApprovalRequest, signal: AbortSignal, manualFallback?: () => boolean, level?: RiskLevel): Promise<"allow" | "deny"> {
		const policy = this.options.approval ?? BENCH_APPROVAL;
		const rule = manualFallback ? null : matchRule(policy, req);
		this.emit(runId, "approval.requested", { toolCallId: req.toolCallId, command: req.command, cwd: req.cwd, risk: req.risk, explanation: req.explanation, source: "human", ...(level ? { level } : {}) });
		let decision: "allow" | "deny";
		if (rule) decision = rule.decision;
		else if ((manualFallback || policy.fallback === "ask") && this.options.askApproval) decision = await cancellableApproval(() => this.options.askApproval!(req), signal);
		else decision = "deny";
		if (decision === "allow" && manualFallback && !manualFallback()) decision = "deny";
		this.emit(runId, "approval.resolved", { toolCallId: req.toolCallId, decision, rule: rule?.id ?? null });
		return decision;
	}
}
