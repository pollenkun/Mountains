/**
 * Mountains 引擎协议：引擎与界面（CLI，以后的桌面端）之间唯一的通信格式。
 * - 分层：session → run（一次用户任务）→ turn（一次模型请求）→ message / tool
 * - 每个事件带 protocolVersion、sessionId、runId、seq、eventId
 * - toolCallId 贯穿审批、执行、结果与 usage
 * - 工具结果区分"发给模型的内容"（modelContent 摘要统计）与"给界面的详情"（details）
 * - 取消、审批请求、完成等事件标记 priority: "high"，界面与传输层不得把它们与文本流批量合并延迟
 * 这里不得出现任何 Pi 的类型。
 */
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const PROTOCOL_VERSION = "0.1.0";

// ───────────── 会话内容（供应商无关） ─────────────

export const ToolCallSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	/** 模型生成的原始参数 JSON 文本，逐字保存 */
	argumentsJson: Type.String(),
});
export type ToolCall = Static<typeof ToolCallSchema>;

export const MessageSchema = Type.Union([
	Type.Object({ role: Type.Literal("user"), content: Type.String() }),
	Type.Object({
		role: Type.Literal("assistant"),
		content: Type.String(),
		/** 思考内容，必须原样回传（DeepSeek 带 tools 时的硬性要求） */
		reasoning: Type.String(),
		toolCalls: Type.Array(ToolCallSchema),
	}),
	Type.Object({
		role: Type.Literal("tool"),
		toolCallId: Type.String(),
		name: Type.String(),
		content: Type.String(),
	}),
]);
export type Message = Static<typeof MessageSchema>;
export type UserMessage = Extract<Message, { role: "user" }>;
export type AssistantMessage = Extract<Message, { role: "assistant" }>;
export type ToolMessage = Extract<Message, { role: "tool" }>;

export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** 账本四项互斥：普通输入 / 缓存读取 / 缓存写入 / 输出。缺失字段为 null，不得当作 0。 */
export const UsageSchema = Type.Object({
	input: Type.Union([Type.Integer(), Type.Null()]),
	cacheRead: Type.Union([Type.Integer(), Type.Null()]),
	cacheWrite: Type.Union([Type.Integer(), Type.Null()]),
	output: Type.Union([Type.Integer(), Type.Null()]),
	reasoning: Type.Union([Type.Integer(), Type.Null()]),
	total: Type.Union([Type.Integer(), Type.Null()]),
	partial: Type.Boolean(),
});
export type Usage = Static<typeof UsageSchema>;

/** 适配器从精确官方接口附加的账单证据；不是模型文本或调用方任意报价。 */
export interface ModelBillingReceipt {
	kind: "openrouter-usage-cost" | "siliconflow-free";
	endpoint: string;
	model: string;
	currency: "CNY" | "USD";
	amount: number;
	/** prompt_tokens 总输入，已经包含缓存命中的部分。 */
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}
export const ModelBillingReceiptSchema = Type.Object({
	kind: Type.Union([Type.Literal("openrouter-usage-cost"), Type.Literal("siliconflow-free")]),
	endpoint: Type.String(), model: Type.String(),
	currency: Type.Union([Type.Literal("CNY"), Type.Literal("USD")]),
	amount: Type.Number({ minimum: 0 }),
	inputTokens: Type.Integer({ minimum: 0 }), outputTokens: Type.Integer({ minimum: 0 }), totalTokens: Type.Integer({ minimum: 0 }),
});

// ───────────── 事件 ─────────────

const Base = {
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	sessionId: Type.String(),
	runId: Type.String(),
	seq: Type.Integer({ minimum: 1 }),
	eventId: Type.String(),
	time: Type.String(),
	priority: Type.Optional(Type.Literal("high")),
};

function event<K extends string, P extends Record<string, TSchema>>(type: K, payload: P) {
	return Type.Object({ ...Base, type: Type.Literal(type), ...payload });
}

const SegmentSchema = Type.Object({
	kind: Type.String(),
	tokensEst: Type.Integer(),
	hash: Type.String(),
	masked: Type.Optional(Type.Boolean()),
});

export const EngineEventSchema = Type.Union([
	event("session.started", { workspace: Type.String(), model: Type.String() }),
	event("run.started", { task: Type.String() }),
	event("turn.started", { turnId: Type.String(), turnIndex: Type.Integer() }),
	event("model.request", {
		turnId: Type.String(),
		requestId: Type.String(),
		attempt: Type.Integer(),
		isRetry: Type.Boolean(),
		purpose: Type.String(),
		segments: Type.Array(SegmentSchema),
		prefixHash: Type.String(),
		firstChangedSegment: Type.Union([Type.String(), Type.Null()]),
		/** Opt-in runtime inputs actually included in this request. */
		interjectionIds: Type.Optional(Type.Array(Type.String())),
	}),
	event("message.delta", { turnId: Type.String(), kind: Type.Union([Type.Literal("text"), Type.Literal("thinking")]), text: Type.String() }),
	event("message.completed", {
		turnId: Type.String(),
		text: Type.String(),
		reasoningChars: Type.Integer(),
		toolCalls: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
	}),
	event("tool.requested", {
		turnId: Type.String(),
		toolCallId: Type.String(),
		tool: Type.String(),
		args: Type.Unknown(),
		summary: Type.String(),
	}),
	event("approval.requested", {
		toolCallId: Type.String(),
		command: Type.String(),
		cwd: Type.String(),
		risk: Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write"), Type.Literal("network"), Type.Literal("dangerous")]),
		explanation: Type.String(),
		source: Type.Optional(Type.Union([Type.Literal("model"), Type.Literal("human")])),
	}),
	event("approval.resolved", {
		toolCallId: Type.String(),
		decision: Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("ask")]),
		rule: Type.Union([Type.String(), Type.Null()]),
		reason: Type.Optional(Type.String()),
		actionHash: Type.Optional(Type.String()),
	}),
	event("tool.completed", {
		turnId: Type.String(),
		toolCallId: Type.String(),
		tool: Type.String(),
		ok: Type.Boolean(),
		summary: Type.String(),
		modelContentChars: Type.Integer(),
		durationMs: Type.Number(),
		details: Type.Unknown(),
	}),
	event("usage", {
		turnId: Type.String(),
		requestId: Type.String(),
		model: Type.String(),
		usage: UsageSchema,
		rawUsage: Type.Unknown(),
		billingReceipt: Type.Optional(ModelBillingReceiptSchema),
		/** 官方账单字段明确矛盾，不能退回目录估算当成已知费用。 */
		billingReceiptRejected: Type.Optional(Type.Literal(true)),
		/** 估算费用（原币种，见 currency） */
		cost: Type.Union([Type.Number(), Type.Null()]),
		currency: Type.String(),
		/** 官方费用凭证为 false；目录价计算保持 true。 */
		costEstimated: Type.Boolean(),
		priceVersion: Type.String(),
		pricePeriod: Type.String(),
		durationMs: Type.Number(),
		firstTokenMs: Type.Union([Type.Number(), Type.Null()]),
	}),
	event("context.revision", {
		reason: Type.String(),
		maskedRefs: Type.Array(Type.String()),
		tokensBefore: Type.Integer(),
		tokensAfter: Type.Integer(),
	}),
	event("turn.completed", { turnId: Type.String(), stopReason: Type.String() }),
	event("run.completed", {
		status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("limit")]),
		reason: Type.String(),
		turns: Type.Integer(),
		totals: Type.Object({
			requests: Type.Integer(),
			input: Type.Integer(),
			cacheRead: Type.Integer(),
			output: Type.Integer(),
			cost: Type.Number(),
			currency: Type.String(),
		}),
	}),
	event("error", { message: Type.String(), retryable: Type.Boolean() }),
]);
export type EngineEvent = Static<typeof EngineEventSchema>;
export type EngineEventType = EngineEvent["type"];

/** 必须立即送达、不能被文本批量合并延迟的事件类型 */
export const HIGH_PRIORITY_EVENTS: ReadonlySet<EngineEventType> = new Set([
	"approval.requested",
	"approval.resolved",
	"run.completed",
	"error",
]);

// ───────────── 命令 ─────────────

export const EngineCommandSchema = Type.Union([
	Type.Object({ protocolVersion: Type.Literal(PROTOCOL_VERSION), type: Type.Literal("run.start"), task: Type.String() }),
	Type.Object({ protocolVersion: Type.Literal(PROTOCOL_VERSION), type: Type.Literal("run.cancel") }),
	Type.Object({
		protocolVersion: Type.Literal(PROTOCOL_VERSION),
		type: Type.Literal("approval.respond"),
		toolCallId: Type.String(),
		decision: Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("always")]),
	}),
	Type.Object({ protocolVersion: Type.Literal(PROTOCOL_VERSION), type: Type.Literal("session.clear") }),
	Type.Object({ protocolVersion: Type.Literal(PROTOCOL_VERSION), type: Type.Literal("model.set"), model: Type.String() }),
]);
export type EngineCommand = Static<typeof EngineCommandSchema>;

export function isValidEvent(e: unknown): e is EngineEvent {
	return Value.Check(EngineEventSchema, e);
}

export function eventErrors(e: unknown): string[] {
	return [...Value.Errors(EngineEventSchema, e)].slice(0, 5).map((x) => `${x.instancePath} ${x.message}`);
}

export function isValidCommand(c: unknown): c is EngineCommand {
	return Value.Check(EngineCommandSchema, c);
}

/** 事件的 payload 部分（去掉公共字段），供引擎构造事件使用 */
export type EventPayload<T extends EngineEventType> = Omit<
	Extract<EngineEvent, { type: T }>,
	"protocolVersion" | "sessionId" | "runId" | "seq" | "eventId" | "time" | "priority" | "type"
>;
