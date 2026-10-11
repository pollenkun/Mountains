import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { knownSecrets, redactValue } from "./redact.ts";

/**
 * 会话录制（JSONL）：用户输入、请求摘要、模型响应、工具输入输出、文件前后哈希、引擎事件。
 * 落盘前全部脱敏。离线回放使用其中的 model.response 记录（离线回放不能作为成功率或缓存的证据）。
 */
export type RecordKind =
	| "environment"
	| "context.revision"
	| "context.compaction-request"
	| "approval.decision"
	| "approval.request"
	| "approval.usage"
	| "meta"
	| "user.input"
	| "model.preflight"
	| "model.dispatch"
	| "model.not-sent"
	| "model.request"
	| "model.response"
	| "tool.input"
	| "tool.output"
	| "file.hashes"
	| "engine.event";

export interface RecordLine {
	kind: RecordKind;
	at: string;
	data: unknown;
}

export class Recorder {
	readonly path: string;
	private readonly secrets = knownSecrets();

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
	}

	write(kind: RecordKind, data: unknown): void {
		const line: RecordLine = { kind, at: new Date().toISOString(), data: redactValue(data, this.secrets) };
		appendFileSync(this.path, `${JSON.stringify(line)}\n`);
	}
}

export function readRecording(path: string): RecordLine[] {
	if (!existsSync(path)) throw new Error(`录制文件不存在：${path}`);
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RecordLine);
}
