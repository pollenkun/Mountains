/** Small, non-streaming approval transport. It never executes tools or retries. */
import type { AssistantMessage, ToolCall, Usage } from "@mountains/protocol";
import { capabilitiesFor, type Effort } from "./capabilities.ts";
import type { EffortSetting, ModelAdapter, ModelRequest, ModelResponse, ModelStreamHandlers } from "./chat-completions.ts";
import { normalizeUsage, usageInconsistency, type RawUsage } from "./usage.ts";

export type ApprovalChatProfile = "openai" | "deepseek" | "zhipu" | "moonshot";
export interface ApprovalChatAdapterOptions {
	baseUrl: string;
	apiKey: string;
	/** Required protocol choice. Model names and hostnames never choose a fallback. */
	profile: ApprovalChatProfile;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
	/** Unknown models accept only default unless their supported levels are declared. */
	supportedEfforts?: readonly EffortSetting[];
	/** Explicit provider wire values. OpenAI max requires an explicit mapping. */
	effortMapping?: Partial<Record<Effort, string>>;
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	/** OpenAI has no universal disable switch; e.g. explicitly configure "none". */
	disabledReasoningEffort?: string;
}

class ApprovalTransportError extends Error {}

const UNKNOWN_USAGE: Usage = { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total: null, partial: true };
const EMPTY_MESSAGE = (): AssistantMessage => ({ role: "assistant", content: "", reasoning: "", toolCalls: [] });
const PROFILES = new Set(["openai", "deepseek", "zhipu", "moonshot"]);
const EFFORTS = new Set(["default", "low", "high", "max"]);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const token = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function boundedInteger(value: number, label: string, max: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new ApprovalTransportError(`Invalid approval ${label}`);
	return value;
}

function wireValue(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

/** Keep only documented accounting fields; malformed counts are unknown, never zero. */
function rawUsage(value: unknown): RawUsage | null {
	if (!isRecord(value)) return null;
	const raw: Record<string, unknown> = {};
	for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "cached_tokens"]) {
		if (value[key] === undefined) continue;
		if (!token(value[key])) return null;
		raw[key] = value[key];
	}
	for (const [key, fields] of [["prompt_tokens_details", ["cached_tokens", "cache_write_tokens"]], ["completion_tokens_details", ["reasoning_tokens"]]] as const) {
		const details = value[key];
		if (details === undefined || details === null) continue;
		if (!isRecord(details)) return null;
		const picked: Record<string, number> = {};
		for (const field of fields) {
			if (details[field] === undefined) continue;
			if (!token(details[field])) return null;
			picked[field] = details[field];
		}
		raw[key] = picked;
	}
	return raw as RawUsage;
}

function usageFor(profile: ApprovalChatProfile, raw: RawUsage | null): Usage {
	if (!raw) return { ...UNKNOWN_USAGE };
	const u = profile === "openai"
		? (() => {
			const prompt = raw.prompt_tokens;
			const hit = raw.prompt_tokens_details?.cached_tokens ?? (prompt !== undefined ? 0 : null);
			return { input: prompt !== undefined && hit !== null ? prompt - hit : null, cacheRead: hit, cacheWrite: null,
				output: raw.completion_tokens ?? null, reasoning: raw.completion_tokens_details?.reasoning_tokens ?? null,
				total: raw.total_tokens ?? (prompt !== undefined && raw.completion_tokens !== undefined ? prompt + raw.completion_tokens : null), partial: false };
		})()
		: normalizeUsage(profile, raw);
	if (Object.entries(u).some(([key, value]) => key !== "partial" && value !== null && !token(value))) return { ...UNKNOWN_USAGE };
	u.partial = u.partial || u.input === null || u.cacheRead === null || u.output === null || usageInconsistency(u) !== null
		|| (u.reasoning !== null && u.output !== null && u.reasoning > u.output);
	return u;
}

function parseTools(value: unknown): ToolCall[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new ApprovalTransportError("Invalid approval response tool calls");
	return value.map((call): ToolCall => {
		if (!isRecord(call) || call.type !== "function" || typeof call.id !== "string" || !isRecord(call.function)
			|| typeof call.function.name !== "string" || typeof call.function.arguments !== "string") throw new ApprovalTransportError("Invalid approval response tool call");
		// Never parse/re-serialize arguments: the caller must see and reject the tool request.
		return { id: call.id, name: call.function.name, argumentsJson: call.function.arguments };
	});
}

export class ApprovalChatAdapter implements ModelAdapter {
	readonly id: string;
	private readonly options: ApprovalChatAdapterOptions;
	private readonly endpoint: string;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;

	constructor(options: ApprovalChatAdapterOptions) {
		if (!PROFILES.has(options.profile)) throw new ApprovalTransportError("An explicit approval protocol profile is required");
		let url: URL;
		try { url = new URL(options.baseUrl); } catch { throw new ApprovalTransportError("Invalid approval base URL"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApprovalTransportError("Invalid approval base URL");
		if (typeof options.apiKey !== "string" || !options.apiKey || /[\r\n]/.test(options.apiKey)) throw new ApprovalTransportError("Invalid approval API key");
		if (options.supportedEfforts?.some((effort) => !EFFORTS.has(effort))) throw new ApprovalTransportError("Invalid approval supported efforts");
		for (const [key, value] of Object.entries(options.effortMapping ?? {})) {
			if (!["low", "high", "max"].includes(key) || !wireValue(value)) throw new ApprovalTransportError("Invalid approval effort mapping");
		}
		if (options.disabledReasoningEffort !== undefined && !wireValue(options.disabledReasoningEffort)) throw new ApprovalTransportError("Invalid approval disabled reasoning value");
		if (options.maxTokensField !== undefined && !["max_tokens", "max_completion_tokens"].includes(options.maxTokensField)) throw new ApprovalTransportError("Invalid approval output limit field");
		this.timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, "timeout", 600_000);
		this.maxResponseBytes = boundedInteger(options.maxResponseBytes ?? 1024 * 1024, "response bound", 16 * 1024 * 1024);
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
		this.endpoint = url.href;
		this.options = { ...options,
			...(options.supportedEfforts ? { supportedEfforts: [...options.supportedEfforts] } : {}),
			...(options.effortMapping ? { effortMapping: { ...options.effortMapping } } : {}) };
		this.id = `approval:${options.profile}`;
	}

	private body(req: ModelRequest): string {
		if (typeof req.model !== "string" || !req.model.trim() || typeof req.system !== "string") throw new ApprovalTransportError("Invalid approval request");
		boundedInteger(req.maxTokens, "output bound", 1_000_000);
		if (!Array.isArray(req.tools) || req.tools.length || !Array.isArray(req.messages)) throw new ApprovalTransportError("Approval requests cannot advertise tools");
		if (!req.thinking || typeof req.thinking.enabled !== "boolean" || !EFFORTS.has(req.thinking.effort)) throw new ApprovalTransportError("Invalid approval thinking setting");
		const profile = this.options.profile;
		const cap = capabilitiesFor(req.model);
		if (cap && cap.provider !== profile) throw new ApprovalTransportError("Approval protocol profile does not match the registered model");
		const effort = req.thinking.effort;
		const declared = this.options.supportedEfforts;
		const supported = cap ? cap.effortLevels : declared ?? [];
		if (effort !== "default" && (!supported.includes(effort) || (declared && !declared.includes(effort)))) throw new ApprovalTransportError("Approval effort is not explicitly supported");
		if (!req.thinking.enabled && effort !== "default") throw new ApprovalTransportError("Disabled approval thinking cannot specify effort");
		if ((profile === "zhipu" || profile === "moonshot") && !req.thinking.enabled) throw new ApprovalTransportError("This approval profile requires thinking enabled");
		if (profile === "moonshot" && effort !== "default") throw new ApprovalTransportError("Moonshot approval effort must be default");
		const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];
		for (const message of req.messages) {
			if (typeof message.content !== "string" || !["user", "assistant"].includes(message.role)) throw new ApprovalTransportError("Approval history must contain only text conversation");
			if (message.role === "assistant" && message.toolCalls.length) throw new ApprovalTransportError("Approval history cannot contain tool calls");
			messages.push({ role: message.role, content: message.content,
				...(message.role === "assistant" && message.reasoning ? { reasoning_content: message.reasoning } : {}) });
		}
		const body: Record<string, unknown> = { model: req.model, messages, stream: false,
			[this.options.maxTokensField ?? "max_tokens"]: req.maxTokens };
		if (profile === "deepseek") body.thinking = { type: req.thinking.enabled ? "enabled" : "disabled" };
		if (profile === "zhipu") body.thinking = { type: "enabled", clear_thinking: false };
		if (profile === "moonshot") body.temperature = 1;
		if (profile === "openai" && !req.thinking.enabled) {
			if (!this.options.disabledReasoningEffort) throw new ApprovalTransportError("OpenAI approval thinking disable needs an explicit wire value");
			body.reasoning_effort = this.options.disabledReasoningEffort;
		} else if (effort !== "default") {
			if (profile === "openai" && effort === "max" && !this.options.effortMapping?.max) throw new ApprovalTransportError("OpenAI max effort needs an explicit wire mapping");
			const mapped = this.options.effortMapping?.[effort] ?? effort;
			if (cap && !cap.effortLevels.includes(mapped as Effort)) throw new ApprovalTransportError("Approval effort mapping is unsupported by the registered model");
			body.reasoning_effort = mapped;
		}
		if (req.userId !== undefined) body[profile === "openai" ? "user" : "user_id"] = req.userId;
		return JSON.stringify(body);
	}

	async complete(req: ModelRequest, handlers: ModelStreamHandlers = {}): Promise<ModelResponse> {
		const startedAt = Date.now();
		const result: ModelResponse = { ok: false, message: EMPTY_MESSAGE(), finishReason: null, responseModel: null, responseId: null,
			rawUsage: null, usage: { ...UNKNOWN_USAGE }, httpStatus: null, requestBody: null, startedAt, firstByteAt: null,
			finishedAt: startedAt, error: null, retryAfterMs: null, aborted: false };
		const controller = new AbortController();
		let timedOut = false;
		let phase: "validation" | "network" | "response" = "validation";
		const abort = () => controller.abort();
		req.signal?.addEventListener("abort", abort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			if (req.signal?.aborted) { controller.abort(); throw new ApprovalTransportError("aborted"); }
			result.requestBody = this.body(req);
			timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
			phase = "network";
			const response = await (this.options.fetch ?? globalThis.fetch)(this.endpoint, {
				method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
				body: result.requestBody, signal: controller.signal,
			});
			result.httpStatus = response.status;
			phase = "response";
			if (!response.body) throw new ApprovalTransportError("Invalid approval response body");
			reader = response.body.getReader();
			const declaredLength = response.headers.get("content-length");
			if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > this.maxResponseBytes) throw new ApprovalTransportError("Approval response exceeds size bound");
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (result.firstByteAt === null) { result.firstByteAt = Date.now(); handlers.onFirstByte?.(); }
				bytes += value.byteLength;
				if (bytes > this.maxResponseBytes) throw new ApprovalTransportError("Approval response exceeds size bound");
				chunks.push(value);
			}
			const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
			if (!isRecord(data)) throw new ApprovalTransportError("Invalid approval JSON response");
			result.rawUsage = rawUsage(data.usage);
			result.usage = usageFor(this.options.profile, result.rawUsage);
			result.responseModel = typeof data.model === "string" ? data.model : null;
			result.responseId = typeof data.id === "string" ? data.id : null;
			if (!response.ok) { result.error = { message: `Approval endpoint returned HTTP ${response.status}`, retryable: false }; return result; }
			if (!Array.isArray(data.choices) || data.choices.length !== 1 || !isRecord(data.choices[0])) throw new ApprovalTransportError("Invalid approval response choices");
			const choice = data.choices[0];
			const message = choice.message;
			if (!isRecord(message) || message.role !== "assistant" || (message.content !== null && typeof message.content !== "string")) throw new ApprovalTransportError("Invalid approval assistant message");
			const toolCalls = parseTools(message.tool_calls);
			if (message.function_call !== undefined) {
				const legacy = message.function_call;
				if (!isRecord(legacy) || typeof legacy.name !== "string" || typeof legacy.arguments !== "string") throw new ApprovalTransportError("Invalid approval legacy tool request");
				toolCalls.push({ id: "legacy-function-call", name: legacy.name, argumentsJson: legacy.arguments });
			}
			if (message.reasoning_content !== undefined && message.reasoning_content !== null && typeof message.reasoning_content !== "string") throw new ApprovalTransportError("Invalid approval reasoning content");
			result.message = { role: "assistant", content: message.content ?? "", reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "", toolCalls };
			result.finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
			if (result.finishReason === "tool_calls" && !toolCalls.length) throw new ApprovalTransportError("Invalid approval tool request");
			if (controller.signal.aborted) throw new ApprovalTransportError("aborted");
			result.ok = true;
			if (result.message.content) handlers.onText?.(result.message.content);
			if (result.message.reasoning) handlers.onThinking?.(result.message.reasoning);
			return result;
		} catch (error) {
			result.ok = false;
			result.message = EMPTY_MESSAGE();
			result.aborted = controller.signal.aborted;
			// Never echo endpoint URLs, fetch exceptions, response errors, credentials or abort reasons.
			const message = result.aborted ? (timedOut ? "Approval request timed out" : "Approval request cancelled")
				: phase === "network" ? "Approval connection failed"
					: error instanceof ApprovalTransportError
						? error.message.replaceAll(this.options.apiKey, "[REDACTED]") : "Invalid approval response";
			result.error = { message, retryable: false };
			return result;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			req.signal?.removeEventListener("abort", abort);
			try { await reader?.cancel(); } catch { /* transport already ended */ }
			result.finishedAt = Date.now();
		}
	}
}
