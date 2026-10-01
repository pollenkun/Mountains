import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Usage } from "@mountains/protocol";
import { redactValue } from "./redact.ts";

/** 账本记录：每一次真实模型请求（包括失败与重试）一条。 */
export interface LedgerRecord {
	sessionId: string;
	runId: string;
	turnId: string;
	requestId: string;
	attempt: number;
	isRetry: boolean;
	purpose: string;
	/** 供应商返回的真实模型名 */
	model: string | null;
	startedAt: string;
	firstTokenAt: string | null;
	finishedAt: string;
	usage: Usage;
	rawUsage: unknown;
	/** 估算费用（原币种）；usage 缺失时为保守估算并标记 partial */
	cost: number;
	currency: string;
	costEstimated: true;
	costPartial: boolean;
	priceVersion: string;
	pricePeriod: string;
	httpStatus: number | null;
	error: string | null;
	/** 发出的请求体哈希（与代理记录对账） */
	requestSha256: string | null;
	contextRevision: number;
	firstChangedSegment: string | null;
}

export class Ledger {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
	}

	append(rec: LedgerRecord): void {
		appendFileSync(this.path, `${JSON.stringify(redactValue(rec))}\n`);
	}

	read(): LedgerRecord[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerRecord);
	}
}

/** 全局累计花费（跨运行、跨会话）：预算守卫的依据 */
export class SpendLedger {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
	}

	/** 指定币种的累计花费；旧记录只有 usd 字段，按美元计 */
	total(currency = "USD"): number {
		if (!existsSync(this.path)) return 0;
		let sum = 0;
		for (const l of readFileSync(this.path, "utf8").split("\n")) {
			if (!l.trim()) continue;
			const e = JSON.parse(l) as { usd?: number; amount?: number; currency?: string };
			if (e.amount !== undefined) {
				if ((e.currency ?? "USD") === currency) sum += e.amount;
			} else if (currency === "USD") sum += e.usd ?? 0;
		}
		return sum;
	}

	add(entry: { at: string; runId: string; requestId: string; amount: number; currency: string; partial: boolean }): void {
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
	}
}
