import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ShadowCheckpoints, fileSha256, type SnapshotResult } from "@mountains/checkpoints";
import { CachePlanner, type ContextPlan, ContextBuilder, ContextPublicationError, diffPlans, type MaskingConfig, MASKING_OFF } from "@mountains/context";
import {
	type EngineEvent,
	type EngineEventType,
	type EventPayload,
	HIGH_PRIORITY_EVENTS,
	PROTOCOL_VERSION,
	type ToolCall,
	type Usage,
} from "@mountains/protocol";
import { completeWithExactInputGate, exactInputIdentity, type ExactInputEvidence, type ExactInputDispatch, canonicalModel, currencyOf, type EffortSetting, estimateCost, type ModelAdapter, type ModelResponse, normalizeUsage, pricePeriod, pricingFor, worstCaseCost } from "@mountains/providers";
import { Ledger, Recorder } from "@mountains/telemetry";
import {
	type ApprovalRequest,
	BlobStore,
	defaultTools,
	FileStateTracker,
	type ToolContext,
	type ToolDefinition,
	type DefaultToolOptions,
	verifyMemory,
	type ToolResult,
	Workspace,
} from "@mountains/tools";
import { type ApprovalPolicy, BENCH_APPROVAL, BudgetExceeded, type BudgetGuard, matchRule } from "./policy.ts";
import { BASELINE_SYSTEM_PROMPT } from "./prompt.ts";
import { buildApprovalRequest, parseApprovalDecision, type ApprovalDecision, type ApprovalEvidence } from "./model-approval.ts";
import { validateApprovalSettings, type ApprovalSettings } from "./approval-settings.ts";
import { snapshotApprovalAction } from "./approval-action.ts";
import { boundedApprovalResponse, approvalCharge, trustworthyUsage } from "./approval-runtime.ts";

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

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 6, baseDelayMs: 2000, maxDelayMs: 30_000 };

export function retryDelayMs(policy: RetryPolicy, attempt: number, retryAfterMs: number | null): number {
	if (retryAfterMs !== null) return retryAfterMs;
	return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs ?? Number.POSITIVE_INFINITY);
}

export const DEFAULT_LIMITS: RunLimits = { maxTurns: 80, maxInputTokens: 20_000_000, maxOutputTokens: 1_000_000, maxCost: 1 };

export interface EngineOptions {
	workspace: string;
	/** 运行输出目录：recording.jsonl、ledger.jsonl、blobs/ */
	dataDir: string;
	adapter: ModelAdapter;
	model: string;
	thinking: { enabled: boolean; effort: EffortSetting };
	maxTokens: number;
	limits?: Partial<RunLimits>;
	/** 可重试错误（429、5xx、网络）的重试：有 Retry-After 时按它等待，否则指数退避，封顶 maxDelayMs */
	retry?: RetryPolicy;
	masking?: MaskingConfig;
	verbatimToolArguments?: boolean;
	userId?: string;
	systemPrompt?: string;
	tools?: ToolDefinition[];
	/** 默认工具的选项（可选配置，例如读取行数上限、读取去重）；给出 tools 时忽略 */
	toolOptions?: DefaultToolOptions;
	contextGuard?: boolean;
	/** Shared, project-scoped evidence directory outside the task checkout. */
	archiveDir?: string;
	archiveHistory?: boolean;
	/** 会话开始时组装好的记忆段（稳定前缀的一部分，随系统提示发送）；null 表示没有记忆 */
	memory?: string | null;
	approval?: ApprovalPolicy;
	/** 交互模式下询问用户；非交互模式不提供 */
	askApproval?: (req: ApprovalRequest) => Promise<"allow" | "deny">;
	/** Optional product mode; never enabled implicitly for an existing benchmark. */
	modelApproval?: { settings: ApprovalSettings; adapter: ModelAdapter };
	/** Shared request reservation and conservative preflight; enable in both approval comparison arms. */
	requestGuard?: boolean;
	/** Explicit trusted final-HTTP-body count; default false, never a byte/token conversion. */
	exactInputPreflight?: boolean;
	budget: BudgetGuard;
	onEvent?: (e: EngineEvent) => void;
	sessionId?: string;
	runId?: string;
	checkpoints?: boolean;
	/** 应用数据目录（影子检查点仓库位置） */
	appDataDir?: string;
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

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			resolve();
		});
	});

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/** 一个会话：可以连续执行多个 run（对话历史保留）。 */
export class AgentSession {
	readonly sessionId: string;
	readonly options: EngineOptions;
	readonly builder: ContextBuilder;
	private readonly planner: CachePlanner;
	private readonly tools: ToolDefinition[];
	private readonly toolByName: Map<string, ToolDefinition>;
	private readonly workspace: Workspace;
	private readonly files = new FileStateTracker();
	private readonly blobs: BlobStore;
	private readonly ledger: Ledger;
	private readonly recorder: Recorder;
	private seq = 0;
	private prevPlan: ContextPlan | null = null;
	private runCount = 0;
	private memoryValidationState: string | null = null;
	private readonly userRequests: { id: string; text: string }[] = [];
	private activeRun = false;
	private activeRunController: AbortController | null = null;
	private authorizationRevision = 0;

	constructor(options: EngineOptions) {
		if (options.requestGuard !== undefined && typeof options.requestGuard !== "boolean") throw new Error("requestGuard 必须是布尔值");
		if (options.exactInputPreflight !== undefined && typeof options.exactInputPreflight !== "boolean") throw new Error("exactInputPreflight 必须是布尔值");
		if (options.exactInputPreflight && !exactInputIdentity(options.adapter)) throw new Error("精确输入预检需要由受信工厂创建的适配器");
		options = { ...options, requestGuard: options.requestGuard === true || !!options.modelApproval || options.exactInputPreflight === true };
		if (options.modelApproval) {
			const settings = validateApprovalSettings(options.modelApproval.settings, currencyOf(options.model) ?? "USD");
			if (settings.maxCost > (options.limits?.maxCost ?? DEFAULT_LIMITS.maxCost)) throw new Error("审批子预算不能超过任务总预算");
			options = { ...options, modelApproval: { settings, adapter: options.modelApproval.adapter } };
		}
		this.options = options;
		this.sessionId = options.sessionId ?? `ses_${randomUUID().slice(0, 12)}`;
		this.workspace = new Workspace(options.workspace);
		this.blobs = new BlobStore(options.archiveDir ?? join(options.dataDir, "blobs"), {
			workspaceRoot: this.workspace.root, sessionId: this.sessionId,
			allowWorkspaceHistory: options.archiveHistory ?? false,
		});
		this.tools = options.tools ?? defaultTools(options.toolOptions);
		this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
		if (this.toolByName.has("context_search") && !this.toolByName.has("context_expand")) throw new Error("context_search 需要 context_expand");
		this.builder = new ContextBuilder({
			system: options.systemPrompt ?? BASELINE_SYSTEM_PROMPT,
			tools: this.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
			memory: options.memory ?? null,
			// 有取回工具时，占位符写明用引用取回
			...(this.toolByName.has("context_expand") ? { expandTool: "context_expand" } : {}),
			...(this.toolByName.has("context_search") ? { archiveSearchTool: "context_search" } : {}),
			...(options.toolOptions?.leanOutput ? { leanRefs: true } : {}),
			...(options.contextGuard ? { publicationGuard: { verifyReference: (ref: string, view: "shown" | "raw", expected?: { toolCallId?: string; sha256?: string }) => this.blobs.has(ref, view, expected) } } : {}),
		});
		// 价格感知淘汰需要"命中价 ÷ 未命中价"：策略配置相同，比值来自模型价格表（模型接入层的事实）
		const masking = options.masking ?? MASKING_OFF;
		const price = pricingFor(options.model);
		const ratio = price ? price.peak.cacheHit / price.peak.cacheMiss : undefined;
		this.planner = new CachePlanner((masking.policy === "price-aware" || masking.priceShadow) && masking.hitMissRatio === undefined && ratio !== undefined ? { ...masking, hitMissRatio: ratio } : masking);
		this.ledger = new Ledger(join(options.dataDir, "ledger.jsonl"));
		this.recorder = new Recorder(join(options.dataDir, "recording.jsonl"));
		this.recorder.write("meta", {
			sessionId: this.sessionId,
			model: options.model,
			thinking: options.thinking,
			maxTokens: options.maxTokens,
			masking: options.masking ?? MASKING_OFF,
			verbatimToolArguments: options.verbatimToolArguments ?? false,
			systemPromptSha256: sha256(options.systemPrompt ?? BASELINE_SYSTEM_PROMPT),
			tools: this.tools.map((t) => t.name),
			toolOptions: options.toolOptions ? { ...options.toolOptions, memory: options.toolOptions.memory?.file ?? null, recipes: options.toolOptions.recipes?.file ?? null } : null,
			contextGuard: options.contextGuard ?? false,
			requestGuard: options.requestGuard,
			...(options.exactInputPreflight ? { exactInputPreflight: true, counterIdentity: exactInputIdentity(options.adapter) } : {}),
			memorySha256: options.memory ? sha256(options.memory) : null,
		});
	}

	private emit<T extends EngineEventType>(runId: string, type: T, payload: EventPayload<T>): void {
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
		if (type !== "message.delta") this.recorder.write("engine.event", event);
		this.options.onEvent?.(event);
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
		this.activeRunController = new AbortController();
		try { return await this.runExclusive(task, AbortSignal.any([signal, this.activeRunController.signal])); }
		finally { this.activeRun = false; this.activeRunController = null; }
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
		const started = Date.now();
		const totals: RunTotals = { requests: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, cost: 0, currency: currencyOf(o.model) ?? "USD", usagePartialRequests: 0 };
		const filesChanged = new Set<string>();
		let finalText = "";
		let turns = 0;
		let ckpt: ShadowCheckpoints | null = null;
		let snap0: SnapshotResult | null = null;
		if (o.checkpoints !== false) {
			try {
				ckpt = new ShadowCheckpoints(o.workspace, o.appDataDir ?? join(o.dataDir, "appdata"));
				snap0 = ckpt.snapshot();
			} catch {
				ckpt = null;
			}
		}
		if (this.runCount === 1) this.emit(runId, "session.started", { workspace: this.workspace.root, model: o.model });
		this.emit(runId, "run.started", { task });
		this.recorder.write("user.input", { runId, task });
		this.builder.appendUser(task);
		this.userRequests.push({ id: `${runId}:user:${this.userRequests.length + 1}`, text: task });
		let approvalDenials = 0;

		const finish = (status: RunSummary["status"], reason: string): RunSummary => {
			let checkpoint: RunSummary["checkpoint"] = null;
			if (ckpt && snap0) {
				try {
					const end = ckpt.snapshot([...filesChanged]);
					checkpoint = { tree: snap0.tree, changed: ckpt.changedPaths(snap0.tree, end.tree) };
					this.recorder.write("file.hashes", {
						runId,
						changed: checkpoint.changed.map((c) => ({ ...c, after: fileSha256(join(this.workspace.root, c.path)) })),
					});
				} catch {
					checkpoint = null;
				}
			}
			this.emit(runId, "run.completed", {
				status,
				reason,
				turns,
				totals: { requests: totals.requests, input: totals.input, cacheRead: totals.cacheRead, output: totals.output, cost: totals.cost, currency: totals.currency },
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

		for (let turnIndex = 0; turnIndex < limits.maxTurns; turnIndex++) {
			if (runAuthorizationRevision !== this.authorizationRevision) return finish("limit", "用户已发来新指令，旧运行停止；请重新提交新指令");
			if (signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", deadlineSignal?.aborted ? "达到运行时间上限" : "用户取消");
			const turnId = `t${turnIndex + 1}`;
			turns = turnIndex + 1;
			this.emit(runId, "turn.started", { turnId, turnIndex });

			this.refreshMemory(runId);
			const shadow = this.planner.shadowAdvice(this.builder);
			if (shadow) this.recorder.write("context.shadow", { runId, ...shadow });
			let revision;
			try { revision = this.planner.beforeRequest(this.builder, o.maxTokens); }
			catch (err) {
				if (err instanceof ContextPublicationError) return finish("limit", `上下文未发布：${err.code}: ${err.message}`);
				throw err;
			}
			if (revision) {
				// 被遮蔽的内容已不在上下文中：读取去重的“已发送”记录随之作废
				this.files.forgetDelivered();
				this.emit(runId, "context.revision", {
					reason: revision.reason,
					maskedRefs: revision.maskedRefs,
					tokensBefore: revision.tokensBefore,
					tokensAfter: revision.tokensAfter,
				});
			}
			const plan = this.builder.plan();
			const diff = diffPlans(this.prevPlan, plan);
			this.prevPlan = plan;

			let resp: ModelResponse | null = null;
			for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
				if (runAuthorizationRevision !== this.authorizationRevision) return finish("limit", "用户已发来新指令，旧运行不再请求模型");
				if (totals.requests >= (limits.maxRequests ?? Number.POSITIVE_INFINITY)) return finish("limit", `达到上游请求上限 ${limits.maxRequests}`);
				if (signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", deadlineSignal?.aborted ? "达到运行时间上限" : "用户取消");
				const requestId = `${runId}-${turnId}-a${attempt}${guarded ? `-${randomUUID()}` : ""}`;
				let inputBound = exact ? 0 : guarded ? Buffer.byteLength(JSON.stringify({ system: plan.system, tools: plan.tools, messages: plan.messages }), "utf8") + 4096 : plan.totalTokensEst;
				if (!exact && guarded && (totals.input + totals.cacheRead + inputBound > limits.maxInputTokens || totals.output + o.maxTokens > limits.maxOutputTokens)) return finish("limit", "下一次模型请求会超过任务 token 上限");
				if (!exact) try {
					const worst = worstCaseCost(o.model, inputBound, o.maxTokens);
					if (guarded) o.budget.reserve({ runId, requestId, amount: worst }, limits.maxCost);
					else o.budget.check(worst, limits.maxCost);
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
						o.budget.reserve({ runId, requestId, amount: worstCaseCost(o.model, inputBound, o.maxTokens) }, limits.maxCost);
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
				try { this.account(runId, turnId, requestId, attempt, resp, plan, diff.firstChanged ? `${diff.firstChanged.position}:${diff.firstChanged.kind}` : null, totals, inputBound); }
				catch (error) {
					if (!guarded) throw error;
					return finish("limit", "请求已发生，但费用超出预留或记账失败；已停止后续操作，请检查账本");
				}
				if (exact && resp.rawUsage !== null && resp.rawUsage.prompt_tokens !== inputBound) return finish("limit", "精确输入计数与模型报告不一致；费用已记录，停止后续操作");
				if (resp.ok && trustworthyUsage(resp.usage)) this.planner.noteUsage(plan.totalTokensEst, plan.revision, (resp.usage.input ?? 0) + (resp.usage.cacheRead ?? 0) + (resp.usage.cacheWrite ?? 0));
				if (guarded && totals.usagePartialRequests > 0) return finish("limit", "请求用量不完整，已保守计费并停止后续操作");
				if (resp.ok) break;
				if (resp.aborted || signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", deadlineSignal?.aborted ? "达到运行时间上限" : "用户取消");
				this.emit(runId, "error", { message: resp.error?.message ?? "模型请求失败", retryable: resp.error?.retryable ?? false });
				if (!resp.error?.retryable || attempt === retry.maxAttempts) return finish("failed", `模型请求失败：${resp.error?.message ?? "未知错误"}`);
				await sleep(retryDelayMs(retry, attempt, resp.retryAfterMs), signal);
			}
			if (!resp?.ok) return finish("failed", "模型请求失败");
			if (runAuthorizationRevision !== this.authorizationRevision) return finish("limit", "用户已发来新指令，旧模型响应不再执行操作");

			const msg = resp.message;
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
				return finish("completed", "模型给出最终答复");
			}

			let pauseReason: string | null = null;
			const results = await this.executeToolCalls(runId, turnId, msg.toolCalls, signal, filesChanged, async (call, args) => {
				if (runAuthorizationRevision !== this.authorizationRevision) pauseReason = "用户已发来新指令，旧运行停止";
				if (pauseReason) return { decision: "ask", reason: pauseReason };
				if (!o.modelApproval || !["command_run", "file_edit", "file_write", ...o.modelApproval.settings.manualTools].includes(call.name)) return null;
				let decision: ApprovalDecision;
				try { decision = await this.reviewTool(runId, turnId, call, args, plan, limits, totals, signal); }
				catch { decision = { decision: "ask", reason: "审批处理失败，操作未执行，请检查审批记录" }; }
				if (decision.decision === "ask") pauseReason = decision.reason ?? "需要用户决定";
				if (decision.decision === "deny" && ++approvalDenials >= o.modelApproval.settings.maxDenials) pauseReason = "审批拒绝次数达到上限，请用户检查授权或操作方案";
				return decision;
			});
			for (const r of results) {
				this.builder.appendToolResult(r.call.id, r.call.name, r.result.modelContent, {
					kind: r.call.name === "file_read" ? "file_content" : "tool_output",
					ref: this.blobs.put(r.result.modelContent, { kind: "shown", source: { toolCallId: r.call.id } }),
					target: r.result.summary.slice(0, 120),
					...(r.result.fullOutputRef ? { fullOutputRef: r.result.fullOutputRef } : {}),
					...(r.result.fullOutputRef && ["file_read", "command_run"].includes(r.call.name) ? { fullOutputSourceCallId: r.call.id } : {}),
					...(!r.result.ok ? { preserve: "error" as const } : {}),
				});
			}
			if (runAuthorizationRevision !== this.authorizationRevision) return finish("limit", "用户已发来新指令，未执行剩余操作");
			if (signal.aborted) return finish(deadlineSignal?.aborted ? "limit" : "cancelled", "运行已取消，未执行剩余操作");
			if (pauseReason) return finish("limit", `等待用户审批：${pauseReason}`);
			this.emit(runId, "turn.completed", { turnId, stopReason: "tool_calls" });
		}
		return finish("limit", `达到最大轮数 ${limits.maxTurns}`);
	}

	private async reviewTool(runId: string, turnId: string, call: ToolCall, args: Record<string, unknown>, plan: ContextPlan, limits: RunLimits, totals: RunTotals, signal: AbortSignal): Promise<ApprovalDecision> {
		const approval = this.options.modelApproval!;
		const settings = approval.settings;
		const authorizationRevision = this.authorizationRevision;
		let actionHash = "";
		const resolve = (decision: ApprovalDecision, rule: string | null = null): ApprovalDecision => {
			this.emit(runId, "approval.resolved", { toolCallId: call.id, decision: decision.decision, rule, actionHash, ...(decision.decision !== "allow" && decision.reason ? { reason: decision.reason } : {}) });
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
		this.emit(runId, "approval.requested", { toolCallId: call.id, command: `${call.name} ${JSON.stringify(args)}`, cwd: snapshot.cwd, risk: snapshot.risk, explanation: "核对用户授权与实际操作范围" });
		// Preauthorizations are exact user-authored records, not regex risk shortcuts.
		const currentTask = this.userRequests.at(-1)?.text;
		const stable = (value: unknown): string => {
			if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
			if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
			return JSON.stringify(value);
		};
		const rule = settings.allowRules.find((r) => r.userRequest === currentTask && r.tool === call.name && r.cwd === snapshot.cwd && stable(r.arguments) === stable(args));
		if (rule) return resolve({ decision: "allow" }, rule.id);
		const selected = settings.contextMessages === 0 ? [] : plan.messages.slice(-settings.contextMessages);
		const evidence: ApprovalEvidence = {
			action: { id: call.id, tool: call.name, arguments: structuredClone(args), cwd: snapshot.cwd, risk: snapshot.risk, observationLimits: snapshot.limitations },
			userRequests: structuredClone(this.userRequests),
			context: { system: plan.system, messages: selected, omittedMessages: plan.messages.length - selected.length },
			memoryState: this.memoryValidationState,
		};
		let request;
		try { request = buildApprovalRequest(evidence, { model: settings.model, thinking: settings.thinking, maxTokens: settings.maxTokens, maxInputChars: settings.maxInputChars, signal }); }
		catch { return ask("审批材料超过限额或格式不完整，请用户检查；没有额外请求模型"); }
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
		this.emit(runId, "model.request", { turnId, requestId, attempt: 1, isRetry: false, purpose: "approval", segments: [], prefixHash: sha256(request.system), firstChangedSegment: null });
		this.recorder.write("approval.request", { runId, turnId, requestId, toolCallId: call.id, actionHash, model: settings.model, thinking: settings.thinking, evidence, bindings: snapshot.bindings, limitations: snapshot.limitations, inputBound, reservedCost: worst });
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
		this.ledger.append({ sessionId: this.sessionId, runId, turnId, requestId, attempt: 1, isRetry: false, purpose: "approval", model: response.responseModel ?? settings.model, startedAt: new Date(response.startedAt).toISOString(), firstTokenAt: response.firstByteAt ? new Date(response.firstByteAt).toISOString() : null, finishedAt: new Date(response.finishedAt).toISOString(), usage, rawUsage: response.rawUsage, cost, currency: totals.currency, costEstimated: true, costPartial: !charge, priceVersion: `${price.version}${settings.conversion ? `;conversion=${rate}@${settings.conversion.asOf}` : ""}`, pricePeriod: "configured-approval", httpStatus: response.httpStatus, error: response.error?.message ?? null, requestSha256: response.requestBody ? sha256(response.requestBody) : null, contextRevision: plan.revision, firstChangedSegment: null });
		this.recorder.write("approval.usage", { runId, requestId, nativeCurrency: price.currency, nativeCost: charge?.nativeAmount ?? worst / rate, convertedCost: cost, taskCurrency: totals.currency, conversion: settings.conversion ?? null, partial: !charge });
		if (settlementFailed) return ask("审批费用超出预留或账本不能结算；操作未执行，请检查费用记录");
		this.emit(runId, "usage", { turnId, requestId, model: settings.model, usage, rawUsage: response.rawUsage, cost, currency: totals.currency, costEstimated: true, priceVersion: price.version, pricePeriod: "configured-approval", durationMs: response.finishedAt - response.startedAt, firstTokenMs: response.firstByteAt ? response.firstByteAt - response.startedAt : null });
		if (signal.aborted) return ask("运行已取消，迟到的审批不会执行");
		if (authorizationRevision !== this.authorizationRevision) return ask("用户已发来新指令，旧审批已失效；请先处理新指令");
		if (!charge) return ask("审批用量或扣费不完整，已保守计费；请用户检查");
		if (totals.output > limits.maxOutputTokens || totals.input + totals.cacheRead > limits.maxInputTokens || totals.cost > limits.maxCost) return ask("审批后达到任务限额，操作未执行");
		const decision = parseApprovalDecision(response, evidence);
		if (decision.decision === "allow") {
			try { if (snapshotApprovalAction(this.workspace, call.name, args).fingerprint !== actionHash) return ask("审批期间操作目标发生变化，请重新检查"); }
			catch { return ask("审批后无法重新核对操作目标"); }
		}
		return resolve(decision);
	}

	/** Only changed validation state is appended; the stable memory prefix is never rewritten. */
	private refreshMemory(runId: string): void {
		const store = this.options.toolOptions?.memory;
		if (!store || !this.options.toolOptions?.verifiedMemory) return;
		try {
			const checked = verifyMemory(this.workspace, store.entries(), { strict: true });
			const state = JSON.stringify({ valid: checked.valid.map((x) => x.entry.id), stale: checked.stale.map((x) => x.entry.id) });
			if ((this.memoryValidationState !== null && state !== this.memoryValidationState) || (this.memoryValidationState === null && checked.stale.length > 0)) {
				this.builder.appendRuntimeNotice(`Project memory was rechecked against current files. Valid note IDs: ${checked.valid.map((x) => x.entry.id).join(", ") || "none"}. Stale or unverified note IDs: ${checked.stale.map((x) => x.entry.id).join(", ") || "none"}. Do not rely on their earlier values. Use memory_query or current files to verify details.`);
				this.recorder.write("memory.validation", { runId, ...JSON.parse(state) });
			}
			this.memoryValidationState = state;
		} catch {
			if (this.memoryValidationState !== "unavailable") this.builder.appendRuntimeNotice("Project memory could not be validated. Earlier memory values are unverified; use current files instead.");
			this.memoryValidationState = "unavailable";
			this.recorder.write("memory.validation", { runId, status: "unavailable" });
		}
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
	): void {
		const o = this.options;
		const guarded = o.requestGuard === true;
		const at = new Date(resp.startedAt);
		const est = estimateCost(resp.responseModel ?? o.model, resp.rawUsage ?? undefined, at);
		// usage 缺失时不能当作 0 成本：按最坏情况保守计入。
		// 例外：4xx 且没有 usage（限流 429、参数错误 400 等）供应商不计费，按 0 计，与代理口径一致；
		// 否则限流时每次 429 都按最坏情况累计，会让 Mountains 比 OpenCode 更早触发自己的费用上限。
		const unbilled = (guarded ? resp.rawUsage === null : !est) && resp.httpStatus !== null && resp.httpStatus >= 400 && resp.httpStatus < 500;
		const invalidUsage = !!guarded && (!trustworthyUsage(resp.usage) || resp.responseModel !== null && canonicalModel(resp.responseModel) !== canonicalModel(o.model));
		const partial = !unbilled && (!est || est.partial || invalidUsage);
		const cost = unbilled ? 0 : est && !partial ? est.amount : worstCaseCost(o.model, inputBound, o.maxTokens);
		const priceVersion = est?.priceVersion ?? pricingFor(o.model)?.version ?? "unknown";
		const period = pricePeriod(at, resp.responseModel ?? o.model);
		const u: Usage = resp.usage;
		totals.requests++;
		totals.input += guarded && partial ? inputBound : (u.input ?? 0) + (guarded ? u.cacheWrite ?? 0 : 0);
		totals.cacheRead += guarded && partial ? 0 : u.cacheRead ?? 0;
		totals.output += guarded && partial ? o.maxTokens : u.output ?? 0;
		totals.reasoning += guarded && partial ? 0 : u.reasoning ?? 0;
		totals.cost += cost;
		if (partial) totals.usagePartialRequests++;
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
			attempt,
			isRetry: attempt > 1,
			purpose: "agent-turn",
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
			finishReason: resp.finishReason,
			responseModel: resp.responseModel,
			rawUsage: resp.rawUsage,
			httpStatus: resp.httpStatus,
			error: resp.error,
			aborted: resp.aborted,
			requestSha256: resp.requestBody ? sha256(resp.requestBody) : null,
		});
		if (settlementError) throw settlementError;
		this.emit(runId, "usage", {
			turnId,
			requestId,
			model: resp.responseModel ?? o.model,
			usage: u,
			rawUsage: resp.rawUsage,
			cost,
			currency: totals.currency,
			costEstimated: true,
			priceVersion,
			pricePeriod: period,
			durationMs: resp.finishedAt - resp.startedAt,
			firstTokenMs: resp.firstByteAt ? resp.firstByteAt - resp.startedAt : null,
		});
	}

	private async executeToolCalls(
		runId: string,
		turnId: string,
		calls: ToolCall[],
		signal: AbortSignal,
		filesChanged: Set<string>,
		review?: (call: ToolCall, args: Record<string, unknown>) => Promise<ApprovalDecision | null>,
	): Promise<{ call: ToolCall; result: ToolResult }[]> {
		const runOne = async (call: ToolCall): Promise<{ call: ToolCall; result: ToolResult }> => {
			const tool = this.toolByName.get(call.name);
			let args: Record<string, unknown> = {};
			let argError: string | null = null;
			try {
				const v = JSON.parse(call.argumentsJson || "{}") as unknown;
				if (v && typeof v === "object" && !Array.isArray(v)) args = v as Record<string, unknown>;
				else argError = "参数必须是 JSON 对象";
			} catch {
				argError = "参数不是合法 JSON";
			}
			this.emit(runId, "tool.requested", { turnId, toolCallId: call.id, tool: call.name, args: argError ? call.argumentsJson : args, summary: call.name });
			this.recorder.write("tool.input", { runId, toolCallId: call.id, name: call.name, arguments: call.argumentsJson });
			const t0 = Date.now();
			let result: ToolResult;
			if (!tool) result = { ok: false, modelContent: `错误：未知工具 ${call.name}`, summary: `未知工具 ${call.name}`, details: {} };
			else if (argError) result = { ok: false, modelContent: `错误：${argError}`, summary: argError, details: {} };
			else if (signal.aborted) result = { ok: false, modelContent: "操作已取消", summary: "操作已取消", details: { cancelled: true } };
			else {
				let decision: ApprovalDecision | null = null;
				try { decision = await review?.(call, args) ?? null; }
				catch { decision = { decision: "ask", reason: "审批处理失败，操作未执行" }; }
				if (decision && decision.decision !== "allow") {
					const reason = decision.reason ?? "需要用户决定";
					result = { ok: false, modelContent: `未执行：${reason}`, summary: `审批${decision.decision === "ask" ? "需用户决定" : "拒绝"}`, details: { approved: false, decision: decision.decision, reason } };
				} else if (signal.aborted) result = { ok: false, modelContent: "操作已取消", summary: "操作已取消", details: { cancelled: true } };
				else {
					const ctx: ToolContext = {
						workspace: this.workspace,
						files: this.files,
						blobs: this.blobs,
						signal,
						toolCallId: call.id,
						// In model mode this exact call already passed the common gate. Risk labels
						// are evidence for review, not an unconditional dangerous-command veto.
						approve: (req) => this.options.modelApproval && decision?.decision === "allow" ? Promise.resolve("allow") : this.approve(runId, req),
						beforeWrite: async (abs) => {
							filesChanged.add(this.workspace.rel(abs));
						},
					};
					try { result = await tool.execute(args, ctx); }
					catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						result = { ok: false, modelContent: `Tool failed: ${message}`, summary: `${call.name} failed`, details: { error: message } };
					}
				}
			}
			const durationMs = Date.now() - t0;
			this.recorder.write("tool.output", { runId, toolCallId: call.id, name: call.name, ok: result.ok, modelContent: result.modelContent, details: result.details, durationMs });
			this.emit(runId, "tool.completed", {
				turnId,
				toolCallId: call.id,
				tool: call.name,
				ok: result.ok,
				summary: result.summary,
				modelContentChars: result.modelContent.length,
				durationMs,
				details: result.details,
			});
			return { call, result };
		};
		const allReadOnly = calls.every((c) => this.toolByName.get(c.name)?.readOnly && !this.options.modelApproval?.settings.manualTools.includes(c.name));
		if (allReadOnly) return Promise.all(calls.map(runOne));
		const out: { call: ToolCall; result: ToolResult }[] = [];
		for (const c of calls) out.push(await runOne(c));
		return out;
	}

	private async approve(runId: string, req: ApprovalRequest): Promise<"allow" | "deny"> {
		const policy = this.options.approval ?? BENCH_APPROVAL;
		const rule = matchRule(policy, req);
		this.emit(runId, "approval.requested", { toolCallId: req.toolCallId, command: req.command, cwd: req.cwd, risk: req.risk, explanation: req.explanation });
		let decision: "allow" | "deny";
		if (rule) decision = rule.decision;
		else if (policy.fallback === "ask" && this.options.askApproval) decision = await this.options.askApproval(req);
		else decision = "deny";
		this.emit(runId, "approval.resolved", { toolCallId: req.toolCallId, decision, rule: rule?.id ?? null });
		return decision;
	}
}
