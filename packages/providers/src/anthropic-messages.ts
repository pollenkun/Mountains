/**
 * Anthropic Messages API。思考用 budget_tokens：档位或调用方给出的 token 数。
 * cache_control 断点打在系统提示、最后一个工具和最后一条用户内容上。
 */
import type { AssistantMessage, Message, ToolCall, ToolSpec } from "@mountains/protocol";
import type { ModelAdapter, ModelRequest, ModelResponse, ModelStreamHandlers } from "./chat-completions.ts";
import { normalizeUsage, type RawUsage } from "./usage.ts";

const BUDGET_BY_EFFORT = { low: 1024, high: 8192, max: 32768 } as const;

export interface AnthropicAdapterOptions {
	baseUrl: string;
	apiKey: string;
	fetch?: typeof globalThis.fetch;
}

interface AnthropicBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: string;
	cache_control?: { type: "ephemeral" };
}

function cache(value: AnthropicBlock): AnthropicBlock {
	return { ...value, cache_control: { type: "ephemeral" } };
}

function toolSchema(tool: ToolSpec, last: boolean): Record<string, unknown> {
	const body = { name: tool.name, description: tool.description, input_schema: tool.parameters };
	return last ? { ...body, cache_control: { type: "ephemeral" as const } } : body;
}

function blocksFromMessage(message: Message): AnthropicBlock[] {
	if (message.role === "tool") return [];
	if (message.role === "user") return [{ type: "text", text: message.content }];
	const blocks: AnthropicBlock[] = [];
	if (message.reasoning) blocks.push({ type: "thinking", thinking: message.reasoning });
	if (message.content) blocks.push({ type: "text", text: message.content });
	for (const call of message.toolCalls) {
		let input: unknown = {};
		try { input = JSON.parse(call.argumentsJson); } catch { input = { raw: call.argumentsJson }; }
		blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
	}
	return blocks.length ? blocks : [{ type: "text", text: "" }];
}

export function anthropicRequestBody(req: ModelRequest): Record<string, unknown> {
	const messages: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];
	for (const message of req.messages) {
		if (message.role === "tool") {
			messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] });
			continue;
		}
		const role = message.role === "assistant" ? "assistant" : "user";
		const content = blocksFromMessage(message);
		const previous = messages.at(-1);
		if (previous && previous.role === role) previous.content.push(...content);
		else messages.push({ role, content });
	}
	const last = messages.at(-1);
	if (last && last.content.length) last.content[last.content.length - 1] = cache(last.content[last.content.length - 1]!);
	const budget = req.thinking.budgetTokens ?? (req.thinking.effort === "default" ? BUDGET_BY_EFFORT.high : BUDGET_BY_EFFORT[req.thinking.effort]);
	return {
		model: req.model,
		max_tokens: req.maxTokens,
		stream: true,
		system: [cache({ type: "text", text: req.system })],
		tools: req.tools.map((tool, index) => toolSchema(tool, index === req.tools.length - 1)),
		messages,
		thinking: req.thinking.enabled ? { type: "enabled", budget_tokens: budget } : { type: "disabled" },
	};
}

/** Official Anthropic is `https://api.anthropic.com` and the path is `/v1/messages`. A relay base that already ends in `/v1` must not gain a second one. */
export function anthropicMessagesUrl(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

function emptyMessage(): AssistantMessage {
	return { role: "assistant", content: "", reasoning: "", toolCalls: [] };
}

export class AnthropicMessagesAdapter implements ModelAdapter {
	readonly id = "anthropic";
	private readonly options: AnthropicAdapterOptions;
	constructor(options: AnthropicAdapterOptions) { this.options = options; }

	async complete(req: ModelRequest, handlers: ModelStreamHandlers = {}): Promise<ModelResponse> {
		const startedAt = Date.now();
		const body = anthropicRequestBody(req);
		const requestBody = JSON.stringify(body);
		let response: Response;
		try {
			response = await (this.options.fetch ?? globalThis.fetch)(anthropicMessagesUrl(this.options.baseUrl), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": this.options.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: requestBody,
				...(req.signal ? { signal: req.signal } : {}),
			});
		} catch (error) {
			return { ok: false, message: emptyMessage(), finishReason: null, responseModel: null, responseId: null, rawUsage: null, usage: normalizeUsage("anthropic", null), httpStatus: null, requestBody, startedAt, firstByteAt: null, finishedAt: Date.now(), error: { message: error instanceof Error ? error.message : String(error), retryable: true }, retryAfterMs: null, aborted: req.signal?.aborted === true };
		}
		const message = emptyMessage();
		const tools = new Map<number, ToolCall>();
		let finishReason: string | null = null;
		let responseModel: string | null = null;
		let responseId: string | null = null;
		let rawUsage: RawUsage | null = null;
		let firstByteAt: number | null = null;
		const text = await response.text();
		if (response.ok) {
			for (const line of text.split("\n")) {
				if (!line.startsWith("data:")) continue;
				if (firstByteAt === null) { firstByteAt = Date.now(); handlers.onFirstByte?.(); }
				const event = JSON.parse(line.slice(5).trim()) as { type?: string; message?: { id?: string; model?: string; usage?: Record<string, number> }; index?: number; content_block?: AnthropicBlock; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string }; usage?: Record<string, number> };
				if (event.type === "message_start" && event.message) {
					responseId = event.message.id ?? null;
					responseModel = event.message.model ?? null;
					rawUsage = anthropicUsage(event.message.usage);
				} else if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && event.index !== undefined) {
					tools.set(event.index, { id: event.content_block.id ?? "", name: event.content_block.name ?? "", argumentsJson: "" });
				} else if (event.type === "content_block_delta" && event.delta && event.index !== undefined) {
					if (event.delta.type === "text_delta" && event.delta.text) { message.content += event.delta.text; handlers.onText?.(event.delta.text); }
					if (event.delta.type === "thinking_delta" && event.delta.thinking) { message.reasoning += event.delta.thinking; handlers.onThinking?.(event.delta.thinking); }
					if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
						const call = tools.get(event.index);
						if (call) call.argumentsJson += event.delta.partial_json;
					}
				} else if (event.type === "message_delta") {
					finishReason = event.delta?.stop_reason ?? finishReason;
					if (event.usage?.output_tokens !== undefined && rawUsage) rawUsage.completion_tokens = event.usage.output_tokens;
				}
			}
		}
		message.toolCalls = [...tools.values()];
		if (rawUsage?.prompt_tokens !== undefined && rawUsage.completion_tokens !== undefined) {
			rawUsage.total_tokens = rawUsage.prompt_tokens + (rawUsage.cache_read_input_tokens ?? 0) + (rawUsage.cache_creation_input_tokens ?? 0) + rawUsage.completion_tokens;
		}
		return {
			ok: response.ok, message, finishReason, responseModel, responseId, rawUsage, usage: normalizeUsage("anthropic", rawUsage),
			httpStatus: response.status, requestBody, startedAt, firstByteAt, finishedAt: Date.now(),
			error: response.ok ? null : { message: text.slice(0, 300), retryable: response.status >= 500 }, retryAfterMs: null, aborted: false,
		};
	}
}

function anthropicUsage(usage: Record<string, number> | undefined): RawUsage | null {
	if (!usage) return null;
	const raw: RawUsage = {};
	if (usage.input_tokens !== undefined) raw.prompt_tokens = usage.input_tokens;
	if (usage.output_tokens !== undefined) raw.completion_tokens = usage.output_tokens;
	if (usage.cache_read_input_tokens !== undefined) raw.cache_read_input_tokens = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens !== undefined) raw.cache_creation_input_tokens = usage.cache_creation_input_tokens;
	return raw;
}
