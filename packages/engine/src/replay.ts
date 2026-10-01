import type { AssistantMessage } from "@mountains/protocol";
import { type ModelAdapter, type ModelRequest, type ModelResponse, type ModelStreamHandlers, normalizeUsage, providerOf, type RawUsage } from "@mountains/providers";
import { readRecording } from "@mountains/telemetry";

export interface RecordedResponse {
	ok: boolean;
	message: AssistantMessage;
	finishReason: string | null;
	responseModel: string | null;
	rawUsage: RawUsage | null;
	httpStatus: number | null;
	error: { message: string; retryable: boolean } | null;
	aborted: boolean;
}

/**
 * 按顺序返回预先给定的模型响应（离线回放与测试用）。
 * 离线回放只模拟模型输出，用于测界面、协议、统计；不能作为成功率或缓存的证据。
 */
export class ScriptedModelAdapter implements ModelAdapter {
	readonly id = "scripted";
	readonly requests: ModelRequest[] = [];
	private readonly responses: RecordedResponse[];
	private i = 0;

	constructor(responses: RecordedResponse[]) {
		this.responses = responses;
	}

	async complete(req: ModelRequest, handlers: ModelStreamHandlers = {}): Promise<ModelResponse> {
		this.requests.push(req);
		const r = this.responses[this.i++];
		const now = Date.now();
		if (!r) {
			return {
				ok: false,
				message: { role: "assistant", content: "", reasoning: "", toolCalls: [] },
				finishReason: null,
				responseModel: null,
				responseId: null,
				rawUsage: null,
				usage: normalizeUsage("deepseek", null),
				httpStatus: null,
				requestBody: null,
				startedAt: now,
				firstByteAt: null,
				finishedAt: now,
				error: { message: "回放脚本已用完", retryable: false },
				retryAfterMs: null,
				aborted: false,
			};
		}
		if (r.message.reasoning) handlers.onThinking?.(r.message.reasoning);
		if (r.message.content) handlers.onText?.(r.message.content);
		return {
			ok: r.ok,
			message: r.message,
			finishReason: r.finishReason,
			responseModel: r.responseModel,
			responseId: null,
			rawUsage: r.rawUsage,
			usage: normalizeUsage(providerOf(r.responseModel ?? req.model) ?? "deepseek", r.rawUsage),
			httpStatus: r.httpStatus,
			requestBody: JSON.stringify({ messages: req.messages.length }),
			startedAt: now,
			firstByteAt: now,
			finishedAt: now,
			error: r.error,
			retryAfterMs: null,
			aborted: r.aborted,
		};
	}

	get remaining(): number {
		return this.responses.length - this.i;
	}
}

/** 从录制文件构造离线回放适配器 */
export function replayAdapterFromRecording(path: string): ScriptedModelAdapter {
	const responses = readRecording(path)
		.filter((l) => l.kind === "model.response")
		.map((l) => l.data as RecordedResponse);
	return new ScriptedModelAdapter(responses);
}
