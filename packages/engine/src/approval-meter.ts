import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BudgetGuard, type BudgetReservationScope, type BudgetSnapshot } from "./policy.ts";

export interface ApprovalMeterOptions {
	/** 可省略；如提供，必须就是总预算账本，审批不另建一套余额。 */
	file?: string;
	budget: BudgetGuard;
	taskLimit: number;
	maxCost: number;
	maxRequests: number;
	currency: string;
	runId: string;
}

/** 审批子额度是任务总预算的一部分；所有持久操作由同一 BudgetGuard 完成。 */
export class ApprovalMeter {
	private readonly budget: BudgetGuard;
	private readonly taskLimit: number;
	private readonly runId: string;
	private readonly scope: BudgetReservationScope;

	constructor(options: ApprovalMeterOptions) {
		if (options.currency !== options.budget.currency) throw new Error("审批金额必须与主任务使用同一币种");
		if (!Number.isFinite(options.taskLimit) || options.taskLimit < 0) throw new Error("任务预算上限必须是有限非负数");
		if (options.file !== undefined) {
			const file = resolve(options.file);
			const canonical = existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file));
			if (canonical !== options.budget.ledgerPath) throw new Error("审批账本必须与总预算账本一致");
		}
		this.budget = options.budget;
		this.taskLimit = options.taskLimit;
		this.runId = options.runId;
		this.scope = { key: `approval:${options.runId}`, maxCost: options.maxCost, maxRequests: options.maxRequests };
		this.budget.snapshot({ runId: this.runId, scope: this.scope });
	}

	get snapshot(): BudgetSnapshot {
		return this.budget.snapshot({ runId: this.runId, scope: this.scope });
	}

	reserve(entry: { requestId: string; worstCost: number }): void {
		this.budget.reserve({ runId: this.runId, requestId: entry.requestId, amount: entry.worstCost, scope: this.scope }, this.taskLimit);
	}

	settle(entry: { requestId: string; actualCost?: number }): { amount: number; partial: boolean } {
		return this.budget.settleReservation({ runId: this.runId, requestId: entry.requestId, ...(entry.actualCost === undefined ? {} : { amount: entry.actualCost }) });
	}
}
