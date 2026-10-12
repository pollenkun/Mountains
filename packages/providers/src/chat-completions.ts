/**
 * OpenAI Chat Completions 兼容的模型适配器（DeepSeek、智谱、Moonshot）：经 Pi 的底层 openai-completions 通道调用，
 * Pi 的类型只在本文件内部使用，对外只暴露 Mountains 自己的类型。
 *
 * 约定（D-001 / D-009）：显式传 apiKey、maxRetries: 0（重试由 AgentDriver 负责）、cacheRetention: "short"、
 * 显式思考参数；用自定义 fetch 复制响应流，拿到原始 SSE、原始 usage 与逐字的工具参数，并记录实际发出的请求体。
 *
 * base URL 指向本机兼容代理时，Pi 无法按 URL 识别供应商，所以兼容参数全部由能力表显式给出。
 * 思考参数与 OpenCode 1.18.32 对同一模型发出的保持一致：
 * - deepseek：thinking {type} + reasoning_effort
 * - zai（GLM）：thinking {type:"enabled", clear_thinking:false}；effort 为 "default" 时不发 reasoning_effort（服务端默认 max）
 * - always-on（Kimi）：不发任何思考参数；temperature 固定 1
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context as PiContext, Message as PiMessage, Model as PiModel } from "@earendil-works/pi-ai";
import { stream as piStream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessage, Message, ModelBillingReceipt, ToolCall, ToolSpec, Usage } from "@mountains/protocol";
import { capabilitiesFor, type Effort, type ModelCapabilities, type ProviderId, providerOf, responseModelMatches } from "./capabilities.ts";
import { officialBillingReceipt, officialBillingReceiptRejected } from "./billing.ts";
import { normalizeUsage, type RawUsage } from "./usage.ts";

/** "default"：不发 reasoning_effort，使用服务端默认强度 */
export type EffortSetting = Effort | "default";

export interface ModelRequest {
	model: string;
	system: string;
	tools: ToolSpec[];
	messages: Message[];
	thinking: { enabled: boolean; effort: EffortSetting };
	maxTokens: number;
	/** user_id 会隔离 KV 缓存（DeepSeek 实测）；同一会话内不设或固定 */
	userId?: string;
	signal?: AbortSignal;
	/** 回放助手消息时逐字使用模型生成的参数 JSON（而不是 Pi 的重新序列化） */
	verbatimToolArguments?: boolean;
}

export interface ExactInputEvidence {
	readonly bodySha256: string;
	readonly bodyBytes: number;
	readonly model: string;
	readonly maxTokens: number;
	readonly inputTokens: number;
	readonly method: "trusted-final-body";
	readonly counterIdentity: string;
}
export interface ExactInputDispatch {
	beforeDispatch(evidence: ExactInputEvidence): Promise<void>;
	/** Must call send synchronously, at most once, after checking the current host state. */
	dispatch(evidence: ExactInputEvidence, send: () => Promise<Response>): Promise<Response>;
}
export interface ModelStreamHandlers {
	exactInput?: ExactInputDispatch;
	onText?: (delta: string) => void;
	onThinking?: (delta: string) => void;
	onFirstByte?: () => void;
}

export interface ModelResponse {
	ok: boolean;
	message: AssistantMessage;
	finishReason: string | null;
	responseModel: string | null;
	responseId: string | null;
	rawUsage: RawUsage | null;
	usage: Usage;
	/** 官方接口附加的费用依据；缓存统计仍可为 unknown，消费端必须再次验证。 */
	billingReceipt?: ModelBillingReceipt;
	/** HOST 看到了显式坏账单/坏用量，费用消费端必须停止，不回退目录价。 */
	billingReceiptRejected?: true;
	httpStatus: number | null;
	/** 实际发出的请求体（字节级原文） */
	requestBody: string | null;
	startedAt: number;
	firstByteAt: number | null;
	finishedAt: number;
	error: { message: string; retryable: boolean } | null;
	/** 响应头 retry-after-ms / retry-after 给出的建议等待时间（毫秒）；没有时为 null */
	retryAfterMs: number | null;
	aborted: boolean;
}

/** 解析 retry-after-ms、retry-after（秒或 HTTP 日期）；与 OpenCode 1.18.32 session/retry.ts 的口径一致 */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | null {
	const ms = Number(headers.get("retry-after-ms"));
	if (headers.get("retry-after-ms") !== null && Number.isFinite(ms) && ms >= 0) return ms;
	const ra = headers.get("retry-after");
	if (ra === null) return null;
	const sec = Number(ra);
	if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec * 1000);
	const at = Date.parse(ra);
	return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export interface ModelAdapter {
	readonly id: string;
	complete(req: ModelRequest, handlers?: ModelStreamHandlers): Promise<ModelResponse>;
}

export interface ChatCompletionsAdapterOptions {
	baseUrl: string;
	apiKey: string;
	/** 可注入 fetch（测试或代理） */
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

export const EXACT_INPUT_DEFAULTS = Object.freeze({ maxBodyBytes: 8 * 1024 * 1024, countTimeoutMs: 15_000, method: "trusted-final-body" as const });
export interface ExactChatOptions extends ChatCompletionsAdapterOptions {
	/** Reviewed counter code + configuration/asset digest, never model-controlled. */
	counterIdentity: string;
	countInput(body: Buffer, parsed: Record<string, unknown>): number | Promise<number>;
	validateSerializedRequest?: (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => void;
	maxBodyBytes?: number;
	countTimeoutMs?: number;
}
const exactAdapters = new WeakMap<ModelAdapter, string>();
const exactTerminals = new WeakMap<ModelAdapter, ChatCompletionsAdapter>();
const exactConfigurations = new WeakMap<ChatCompletionsAdapter, Readonly<ExactChatOptions>>();
interface ExactCallScope {
	terminal: ChatCompletionsAdapter;
	active: boolean;
	entered: boolean;
	terminalEvidence: ExactInputEvidence | null;
	sending: ExactInputEvidence | null;
}
const exactCalls = new AsyncLocalStorage<ExactCallScope>();
const LOCAL_ERRORS = {
	EXACT_GATE_REQUIRED: "Exact input requires its original host dispatch gate",
	EXACT_GATE_REPLACED: "Exact input dispatch did not pass through this call's original host gate",
	EXACT_CALL_CLOSED: "Exact input call is closed or already used",
	REQUEST_SNAPSHOT_FAILED: "Request data could not be copied before counting",
	REQUEST_BUILD_FAILED: "Request body could not be constructed before dispatch",
	SERIALIZED_REQUEST_REJECTED: "Serialized request failed the local body check",
	INPUT_COUNTER_FAILED: "Local input counter failed before dispatch",
	INPUT_COUNTER_TIMEOUT: "Local input counter timed out before dispatch",
	INPUT_COUNTER_INVALID: "Local input counter returned an invalid token count",
	REQUEST_CANCELLED: "Request was cancelled before dispatch",
	HOST_GATE_REJECTED: "Host pre-dispatch check rejected the request",
} as const;
type LocalErrorCode = keyof typeof LOCAL_ERRORS;
class ExactLocalError extends Error {
	readonly code: LocalErrorCode;
	constructor(code: LocalErrorCode) { super(`${code}: ${LOCAL_ERRORS[code]}`); this.code = code; }
}

/** Bind one exact call to its original host gate. Guards audited wrapper mistakes, not malicious host JS. */
export async function completeWithExactInputGate(adapter: ModelAdapter, request: ModelRequest, handlers: ModelStreamHandlers & { exactInput: ExactInputDispatch }): Promise<ModelResponse> {
	const terminal = exactTerminals.get(adapter);
	if (!terminal || exactCalls.getStore()) throw new ExactLocalError("EXACT_GATE_REQUIRED");
	const scope: ExactCallScope = { terminal, active: true, entered: false, terminalEvidence: null, sending: null };
	const checkEvidence = (e: ExactInputEvidence) => {
		if (!scope.active || exactCalls.getStore() !== scope) throw new ExactLocalError("EXACT_CALL_CLOSED");
		if (!scope.terminalEvidence || e !== scope.terminalEvidence) throw new ExactLocalError("EXACT_GATE_REPLACED");
	};
	// Capture methods now: a wrapper cannot mutate the caller's control after binding.
	const before = handlers.exactInput.beforeDispatch.bind(handlers.exactInput);
	const dispatch = handlers.exactInput.dispatch.bind(handlers.exactInput);
	const gate: ExactInputDispatch = Object.freeze({
		beforeDispatch: (e: ExactInputEvidence) => {
			checkEvidence(e);
			return before(e);
		},
		dispatch: (e: ExactInputEvidence, send: () => Promise<Response>) => {
			checkEvidence(e);
			return dispatch(e, () => {
				if (!scope.active || scope.sending) throw new ExactLocalError("EXACT_CALL_CLOSED");
				// Permission lasts only for this synchronous send, not the inherited async context.
				scope.sending = e;
				try { return send(); } finally { scope.sending = null; }
			});
		},
	});
	try { return await exactCalls.run(scope, () => adapter.complete(request, { ...handlers, exactInput: gate })); }
	finally { scope.active = false; }
}
/** Host factory, not a model-supplied capability flag. No I/O during construction. */
export function createExactChatCompletionsAdapter(options: ExactChatOptions): ModelAdapter {
	if (!/^[a-f0-9]{64}$/.test(options.counterIdentity) || typeof options.countInput !== "function") throw new Error("Exact counter identity is required");
	if (options.maxBodyBytes !== undefined && (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1)) throw new Error("Invalid exact body byte limit");
	if (options.countTimeoutMs !== undefined && (!Number.isSafeInteger(options.countTimeoutMs) || options.countTimeoutMs < 1)) throw new Error("Invalid counter timeout");
	const fixed = Object.freeze({ ...options });
	const adapter = new ChatCompletionsAdapter(fixed);
	exactConfigurations.set(adapter, fixed);
	exactAdapters.set(adapter, fixed.counterIdentity);
	exactTerminals.set(adapter, adapter);
	return Object.freeze(adapter);
}
export function exactInputIdentity(adapter: ModelAdapter): string | null { return exactAdapters.get(adapter) ?? null; }
/** Only audited host wrappers use this. Dropping handlers still fails inside the terminal adapter. */
export function preserveExactInputCapability(delegate: ModelAdapter, wrapper: ModelAdapter): ModelAdapter {
	const identity = exactInputIdentity(delegate);
	if (identity) { exactAdapters.set(wrapper, identity); exactTerminals.set(wrapper, exactTerminals.get(delegate)!); return Object.freeze(wrapper); }
	return wrapper;
}
async function boundedCount(config: Readonly<ExactChatOptions>, body: string, signal?: AbortSignal): Promise<number> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(() => config.countInput(Buffer.from(body), JSON.parse(body) as Record<string, unknown>)),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new ExactLocalError("INPUT_COUNTER_TIMEOUT")), config.countTimeoutMs ?? EXACT_INPUT_DEFAULTS.countTimeoutMs);
				abort = () => reject(new ExactLocalError("REQUEST_CANCELLED"));
				if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}

interface RawToolCall {
	id?: string;
	name?: string;
	args: string;
}

interface SseCapture {
	firstByteAt: number | null;
	usage: RawUsage | null;
	finishReason: string | null;
	model: string | null;
	id: string | null;
	toolCalls: Map<number, RawToolCall>;
	/** Only a fully drained, understood tap may replace Pi's assembled arguments. */
	complete: boolean;
	reliable: boolean;
	protocolError: boolean;
	done: Promise<void>;
}

const THINKING_MAP = { minimal: null, low: "low", medium: null, high: "high", max: "max" } as const;

function providerFor(modelId: string): ProviderId {
	return capabilitiesFor(modelId)?.provider ?? providerOf(modelId) ?? "openai";
}

/**
 * Pi 内部的供应商名。助手消息与目标模型的供应商名、api、模型 ID 三者一致时，Pi 才把思考块作为 reasoning_content 回传，
 * 否则会把思考内容降级成普通文本（transform-messages.ts 的 isSameModel），所以两处必须用同一个函数。
 */
function piProviderName(modelId: string): string {
	const provider = providerFor(modelId);
	return provider === "zhipu" ? "zai" : provider === "moonshot" ? "moonshotai-cn" : provider;
}

/** 能力表 → Pi 的模型描述。未登记的模型按供应商前缀推断。 */
function piModel(modelId: string, baseUrl: string, effort: EffortSetting): PiModel<"openai-completions"> {
	const cap: ModelCapabilities | undefined = capabilitiesFor(modelId);
	const provider = providerFor(modelId);
	const format = cap?.thinkingFormat ?? (provider === "zhipu" ? "zai" : provider === "moonshot" ? "always-on" : provider === "deepseek" ? "deepseek" : "none");
	const sendsEffort = effort !== "default" && (cap ? cap.effortLevels.includes(effort) : format !== "always-on" && format !== "none");
	return {
		id: modelId,
		name: cap?.displayName ?? modelId,
		api: "openai-completions",
		provider: piProviderName(modelId),
		baseUrl,
		reasoning: format !== "none",
		thinkingLevelMap: THINKING_MAP,
		input: ["text"],
		// 费用由 Mountains 按官方价格自行计算，这里只填占位
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: cap?.contextWindow ?? 1048576,
		maxTokens: cap?.maxOutputTokens ?? 393216,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: sendsEffort,
			supportsUsageInStreaming: true,
			maxTokensField: cap?.maxTokensField ?? "max_tokens",
			requiresReasoningContentOnAssistantMessages: cap?.requiresReasoningPassback ?? format !== "none",
			// always-on 走 Pi 的 OpenAI 分支：supportsReasoningEffort 为 false 时不发任何思考参数
			thinkingFormat: format === "always-on" || format === "none" ? "openai" : format,
			zaiToolStream: false,
			supportsLongCacheRetention: false,
			sendSessionAffinityHeaders: false,
		},
	} as unknown as PiModel<"openai-completions">;
}

function parseArgs(json: string): Record<string, unknown> {
	try {
		const v = JSON.parse(json) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Mountains 消息 → Pi 上下文。时间戳固定为 0，避免任何非确定内容。 */
function toPiContext(req: ModelRequest): PiContext {
	const passback = capabilitiesFor(req.model)?.requiresReasoningPassback ?? ["deepseek", "zhipu", "moonshot"].includes(providerFor(req.model));
	const messages: PiMessage[] = req.messages.map((m): PiMessage => {
		if (m.role === "user") return { role: "user", content: m.content, timestamp: 0 };
		if (m.role === "tool") {
			return {
				role: "toolResult",
				toolCallId: m.toolCallId,
				toolName: m.name,
				content: [{ type: "text", text: m.content }],
				isError: false,
				timestamp: 0,
			} as PiMessage;
		}
		const content: unknown[] = [];
		if (m.reasoning && passback) content.push({ type: "thinking", thinking: m.reasoning, thinkingSignature: "reasoning_content" });
		if (m.content) content.push({ type: "text", text: m.content });
		for (const tc of m.toolCalls) content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: parseArgs(tc.argumentsJson) });
		return {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: piProviderName(req.model),
			model: req.model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: m.toolCalls.length ? "toolUse" : "stop",
			timestamp: 0,
		} as PiMessage;
	});
	return {
		systemPrompt: req.system,
		tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as never })),
		messages,
	};
}

/** Capture one complete SSE event, never an individual data field. */
function captureSseData(cap: SseCapture, data: string): void {
	let chunk: {
		id?: string;
		model?: string;
		usage?: RawUsage | null;
		error?: unknown;
		choices?: { finish_reason?: string | null; delta?: { tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
	};
	try { chunk = JSON.parse(data); }
	catch { cap.reliable = false; cap.protocolError = true; return; }
	if (!chunk || typeof chunk !== "object") { cap.reliable = false; return; }
	if (chunk.error) cap.protocolError = true;
	cap.id ??= chunk.id ?? null;
	cap.model ??= chunk.model ?? null;
	if (chunk.usage) cap.usage = chunk.usage;
	const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
	if (choice?.finish_reason) cap.finishReason = choice.finish_reason;
	const calls = choice?.delta?.tool_calls ?? [];
	if (!Array.isArray(calls)) { cap.reliable = false; cap.protocolError = true; return; }
	for (const tc of calls) {
		if (!tc || typeof tc !== "object") { cap.reliable = false; cap.protocolError = true; continue; }
		// Pi also accepts ID-only/custom tool fragments. If the tap cannot track
		// their exact order, keep Pi's complete result instead of a raw prefix.
		if (!Number.isSafeInteger(tc.index) || tc.index < 0 || !tc.function) { cap.reliable = false; continue; }
		const cur = cap.toolCalls.get(tc.index) ?? { args: "" };
		if (tc.id) cur.id = tc.id;
		if (tc.function.name) cur.name = tc.function.name;
		if (typeof tc.function.arguments === "string") cur.args += tc.function.arguments;
		else if (tc.function.arguments !== undefined) cap.reliable = false;
		cap.toolCalls.set(tc.index, cur);
	}
}

/** Incremental SSE framing: CR, LF and CRLF may all straddle byte chunks. */
function sseCaptureParser(cap: SseCapture): (text: string) => void {
	let line = "";
	let skipLf = false;
	let data: string[] = [];
	let event: string | null = null;
	let done = false;
	const acceptLine = () => {
		if (line === "") {
			if (data.length > 0) {
				const payload = data.join("\n");
				if (payload.startsWith("[DONE]")) done = true;
				else if (!event?.startsWith("thread.")) captureSseData(cap, payload);
			}
			data = [];
			event = null;
		} else if (!line.startsWith(":")) {
			const colon = line.indexOf(":");
			const field = colon < 0 ? line : line.slice(0, colon);
			let value = colon < 0 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "data") data.push(value);
			else if (field === "event") event = value;
		}
		line = "";
	};
	return (text: string) => {
		let start = 0;
		for (let i = 0; i < text.length; i++) {
			if (done) return;
			const char = text[i];
			if (skipLf) {
				skipLf = false;
				if (char === "\n") { start = i + 1; continue; }
			}
			if (char === "\r" || char === "\n") {
				line += text.slice(start, i);
				acceptLine();
				skipLf = char === "\r";
				start = i + 1;
			}
		}
		if (!done) line += text.slice(start);
	};
}

/** 检查思考设置能否用于该模型；不能时返回原因（例如 Kimi 不能关闭思考、不支持 reasoning_effort） */
export function thinkingSettingError(model: string, thinking: { enabled: boolean; effort: EffortSetting }): string | null {
	const cap = capabilitiesFor(model);
	if (!cap) return null;
	if (cap.thinkingFormat === "none" && thinking.enabled) return `${model} 当前使用非思考模式，不能开启思考`;
	if (cap.thinkingFormat === "always-on" && !thinking.enabled) return `${model} 始终思考，不能关闭`;
	if (cap.thinkingFormat === "zai" && !thinking.enabled) return `${model} 只支持 thinking.type=enabled`;
	if (thinking.effort !== "default" && !cap.effortLevels.includes(thinking.effort)) {
		return cap.effortLevels.length ? `${model} 的 reasoning_effort 只支持 ${cap.effortLevels.join("/")}` : `${model} 不支持 reasoning_effort，effort 须为 "default"`;
	}
	return null;
}

export class ChatCompletionsAdapter implements ModelAdapter {
	readonly id: string;
	private readonly options: ChatCompletionsAdapterOptions;

	constructor(options: ChatCompletionsAdapterOptions & { provider?: ProviderId }) {
		this.options = options;
		this.id = options.provider ?? "deepseek";
	}

	async complete(req: ModelRequest, handlers: ModelStreamHandlers = {}): Promise<ModelResponse> {
		const exact = exactConfigurations.get(this);
		const scope = exactCalls.getStore();
		if (exact && (!handlers.exactInput || !scope || scope.terminal !== this)) throw new ExactLocalError("EXACT_GATE_REQUIRED");
		if (exact && scope) {
			if (!scope.active || scope.entered) throw new ExactLocalError("EXACT_CALL_CLOSED");
			scope.entered = true;
		}
		const startedAt = Date.now();
		let terminalUsed = false;
		let transportAttempted = false;
		let transportFailed = false;
		let localFailure: ExactLocalError | null = null;
		let requestBody: string | null = null;
		let httpStatus: number | null = null;
		let billingTransportRejected = false;
		let retryAfterMs: number | null = null;
		const capture: SseCapture = {
			firstByteAt: null,
			usage: null,
			finishReason: null,
			model: null,
			id: null,
			toolCalls: new Map(),
			complete: false,
			reliable: true,
			protocolError: false,
			done: Promise.resolve(),
		};
		const localResponse = (error: ExactLocalError): ModelResponse => ({
			ok: false, message: { role: "assistant", content: "", reasoning: "", toolCalls: [] }, finishReason: null,
			responseModel: null, responseId: null, rawUsage: null, usage: normalizeUsage(providerFor(req.model), null),
			httpStatus: null, requestBody, startedAt, firstByteAt: null, finishedAt: Date.now(),
			error: { message: error.message, retryable: false }, retryAfterMs: null, aborted: req.signal?.aborted === true,
		});
		if (exact) {
			// Copy only data; the current AbortSignal remains live. Never expose a cloning exception's payload.
			try { const { signal, ...data } = req; req = { ...structuredClone(data), ...(signal ? { signal } : {}) }; }
			catch { return localResponse(new ExactLocalError("REQUEST_SNAPSHOT_FAILED")); }
		}
		const baseFetch = this.options.fetch ?? globalThis.fetch;
		const noteTransportFailure = (error: unknown) => {
			if (!req.signal?.aborted && !(error instanceof Error && error.name === "AbortError")) transportFailed = true;
		};
		const sendFetch: typeof globalThis.fetch = async (input, init) => {
			try { return await baseFetch(input, init); }
			catch (error) { noteTransportFailure(error); throw error; }
		};
		const tapFetch: typeof globalThis.fetch = async (input, init) => {
			if (typeof init?.body === "string") requestBody = init.body;
			let res: Response;
			if (exact) {
				let stage: LocalErrorCode = "SERIALIZED_REQUEST_REJECTED";
				try {
					if (terminalUsed) throw new Error("Exact dispatch may only be attempted once");
					terminalUsed = true;
					if (!scope?.active || exactCalls.getStore() !== scope) throw new ExactLocalError("EXACT_CALL_CLOSED");
					if (req.signal?.aborted) throw new ExactLocalError("REQUEST_CANCELLED");
					if (typeof init?.body !== "string") throw new Error("Exact input requires one serialized HTTP body");
					const body = init.body;
					const fixedInit = Object.freeze({ ...init, body, headers: new Headers(init.headers), redirect: "error" as const });
					if (Buffer.byteLength(body) > (exact.maxBodyBytes ?? EXACT_INPUT_DEFAULTS.maxBodyBytes)) throw new Error("Serialized request exceeds the independent memory byte cap");
					exact.validateSerializedRequest?.(input, fixedInit);
					stage = "INPUT_COUNTER_FAILED";
					const inputTokens = await boundedCount(exact, body, req.signal);
					if (req.signal?.aborted) throw new ExactLocalError("REQUEST_CANCELLED");
					if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new ExactLocalError("INPUT_COUNTER_INVALID");
					const evidence: ExactInputEvidence = Object.freeze({ bodySha256: createHash("sha256").update(body).digest("hex"), bodyBytes: Buffer.byteLength(body),
						model: req.model, maxTokens: req.maxTokens, inputTokens, method: "trusted-final-body", counterIdentity: exact.counterIdentity });
					// Register the terminal's own object before any wrapper can copy or replace it.
					scope.terminalEvidence = evidence;
					stage = "HOST_GATE_REJECTED";
					await handlers.exactInput!.beforeDispatch(evidence);
					if (req.signal?.aborted) throw new ExactLocalError("REQUEST_CANCELLED");
					let invoked = false;
					res = await handlers.exactInput!.dispatch(evidence, () => {
						if (invoked || req.signal?.aborted) throw new Error("Dispatch cancelled or already used");
						if (!scope.active || exactCalls.getStore() !== scope || scope.sending !== evidence) throw new ExactLocalError("EXACT_GATE_REPLACED");
						invoked = true;
						transportAttempted = true;
						return sendFetch(input, fixedInit);
					});
					if (!invoked) throw new Error("Host gate returned without dispatching");
				} catch (error) {
					if (transportAttempted) throw error;
					localFailure = error instanceof ExactLocalError ? error : new ExactLocalError(stage);
					throw localFailure;
				}
			} else res = await sendFetch(input, init);
			// 账单只能归属于这个官方请求；跳转或 SDK 发往别处不能借用预设的身份。
			const receiptProvider = req.model === "openai/gpt-4.1-mini" ? "https://openrouter.ai/api/v1" : req.model === "Qwen/Qwen2.5-7B-Instruct" ? "https://api.siliconflow.cn/v1" : null;
			if (receiptProvider && [receiptProvider, `${receiptProvider}/`].includes(this.options.baseUrl)) {
				const sentUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const expectedUrl = `${receiptProvider}/chat/completions`;
				if (sentUrl !== expectedUrl || res.redirected || res.url !== "" && res.url !== expectedUrl) billingTransportRejected = true;
			}
			httpStatus = res.status;
			if (res.status === 429 || res.status >= 500) retryAfterMs = parseRetryAfter(res.headers);
			if (!res.body) return res;
			const [forPi, forTap] = res.body.tee();
			// Observe errors at the SDK's read boundary, separately from parser or
			// callback failures. The tap may continue draining after Pi rejects JSON.
			const piReader = forPi.getReader();
			const observed = new ReadableStream<Uint8Array>({
				async pull(controller) {
					let next: Awaited<ReturnType<typeof piReader.read>>;
					try { next = await piReader.read(); }
					catch (error) { noteTransportFailure(error); controller.error(error); return; }
					if (next.done) controller.close(); else controller.enqueue(next.value);
				},
				cancel: (reason) => piReader.cancel(reason),
			}, { highWaterMark: 0 });
			const jsonRejection = res.status >= 400 && res.status < 500 && res.headers.get("content-type")?.includes("application/json");
			capture.done = (async () => {
				const dec = new TextDecoder();
				const parse = sseCaptureParser(capture);
				let json = "";
				const reader = forTap.getReader();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (capture.firstByteAt === null) {
						capture.firstByteAt = Date.now();
						handlers.onFirstByte?.();
					}
					const text = dec.decode(value, { stream: true });
					if (jsonRejection) json += text; else parse(text);
				}
				if (jsonRejection) {
					// Error responses can carry usage too. Keep it as evidence instead
					// of treating every non-SSE rejection as an absent invoice.
					captureSseData(capture, json + dec.decode());
				} else parse(dec.decode());
				capture.complete = true;
			})().catch(() => { capture.reliable = false; });
			return new Response(observed, { status: res.status, statusText: res.statusText, headers: res.headers });
		};

		try {
			const rawArgsById = new Map<string, string>();
			for (const m of req.messages) if (m.role === "assistant") for (const tc of m.toolCalls) rawArgsById.set(tc.id, tc.argumentsJson);

			const cap = capabilitiesFor(req.model);
			// Pi 只在 reasoningEffort 为真值时开启思考；"default" 时传 "high" 占位，是否真的发出 reasoning_effort 由 compat 决定
			const piEffort: Effort = req.thinking.effort === "default" ? "high" : req.thinking.effort;
			const s = piStream(piModel(req.model, this.options.baseUrl, req.thinking.effort), normalizeContext(toPiContext(req)), {
				apiKey: this.options.apiKey,
				fetch: tapFetch,
				maxRetries: 0,
				cacheRetention: "short",
				maxTokens: req.maxTokens,
				...(req.thinking.enabled ? { reasoningEffort: piEffort } : {}),
				...(cap?.fixedTemperature !== undefined ? { temperature: cap.fixedTemperature } : {}),
				...(req.signal ? { signal: req.signal } : {}),
				...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
				onPayload: (payload: unknown) => {
					const p = payload as Record<string, unknown> & { messages?: { role: string; tool_calls?: { id: string; function: { arguments: string } }[] }[]; user_id?: string };
					// 兼容服务器可能拒绝别家专属字段；非思考模型也不能收到历史思考内容。
					if (cap?.thinkingFormat === "none" || !cap && providerFor(req.model) === "openai") {
						for (const key of ["thinking", "reasoning_effort", "reasoning", "reasoning_content", "enable_thinking"]) delete p[key];
						for (const msg of p.messages ?? []) for (const key of ["reasoning_content", "reasoning_details"]) delete (msg as unknown as Record<string, unknown>)[key];
					}
					// 固定参数来自能力表。例如 Qwen Plus 必须显式关闭默认思考。
					for (const [key, value] of Object.entries(cap?.requestExtras ?? {})) p[key] = value;
					// 旧三家的回放保留已有参数；通用预设不能继承 DeepSeek user_id。
					if (req.userId && ["deepseek", "zhipu", "moonshot"].includes(providerFor(req.model))) p.user_id = req.userId;
					if (req.verbatimToolArguments && p.messages) {
						for (const msg of p.messages) {
							for (const tc of msg.tool_calls ?? []) {
								const raw = rawArgsById.get(tc.id);
								if (raw !== undefined) tc.function.arguments = raw;
							}
						}
					}
					return p;
				},
			});
			for await (const ev of s) {
				if (ev.type === "text_delta") handlers.onText?.(ev.delta);
				else if (ev.type === "thinking_delta") handlers.onThinking?.(ev.delta);
			}
			const final = await s.result();
			let drainTimer: ReturnType<typeof setTimeout> | undefined;
			try { await Promise.race([capture.done, new Promise((r) => { drainTimer = setTimeout(r, 2000); })]); }
			finally { clearTimeout(drainTimer); }
			const finishedAt = Date.now();

			let text = "";
			let reasoning = "";
			const toolCalls: ToolCall[] = [];
			const rawCalls = capture.complete && capture.reliable ? [...capture.toolCalls.values()] : [];
			for (const block of final.content) {
				if (block.type === "text") text += block.text;
				else if (block.type === "thinking") reasoning += block.thinking;
				else if (block.type === "toolCall") {
					const raw = rawCalls.find((r) => r.id === block.id && r.name === block.name);
					toolCalls.push({ id: block.id, name: block.name, argumentsJson: raw?.args ?? JSON.stringify(block.arguments) });
				}
			}
			const aborted = final.stopReason === "aborted";
			const isError = final.stopReason === "error" || aborted;
			if (exact && !transportAttempted) return localResponse(localFailure ?? new ExactLocalError(aborted ? "REQUEST_CANCELLED" : "REQUEST_BUILD_FAILED"));
			const status: number | null = httpStatus;
			const finishReason = capture.finishReason ?? final.rawStopReason ?? null;
			const permanentStop = finishReason !== null && !["stop", "end", "length", "tool_calls", "function_call", "network_error"].includes(finishReason);
			// A failed error-body read cannot turn a permanent HTTP rejection into a retry.
			const transientStream = (status === null || status >= 200 && status < 300) && !capture.protocolError && (transportFailed || final.rawStopReason === "network_error");
			const retryable = !aborted && !permanentStop && (transientStream || status === 429 || status !== null && status >= 500);
			const usage = normalizeUsage(providerFor(req.model), capture.usage);
			const billingReceipt = !billingTransportRejected && capture.model !== null && responseModelMatches(req.model, capture.model)
				? officialBillingReceipt(req.model, this.options.baseUrl, capture.usage, usage) : undefined;
			// A plain HTTP rejection has no invoice to validate. Keep explicit usage
			// and transport contradictions fail-closed, including on error responses.
			const unbilledHttpRejection = status !== null && status >= 400 && status < 500 && capture.usage === null;
			const billingReceiptRejected = billingTransportRejected || !unbilledHttpRejection && officialBillingReceiptRejected(req.model, this.options.baseUrl, capture.usage, usage, capture.model);
			return {
				ok: !isError,
				message: { role: "assistant", content: text, reasoning, toolCalls },
				finishReason,
				responseModel: capture.model,
				responseId: capture.id,
				rawUsage: capture.usage,
				usage,
				...(billingReceipt ? { billingReceipt } : {}),
				...(billingReceiptRejected ? { billingReceiptRejected: true as const } : {}),
				httpStatus: status,
				requestBody,
				startedAt,
				firstByteAt: capture.firstByteAt,
				finishedAt,
				error: isError ? { message: final.errorMessage ?? final.stopReason, retryable } : null,
				retryAfterMs,
				aborted,
			};
		} catch (error) {
			if (exact && !transportAttempted) return localResponse(localFailure ?? new ExactLocalError("REQUEST_BUILD_FAILED"));
			throw error;
		}
	}
}
