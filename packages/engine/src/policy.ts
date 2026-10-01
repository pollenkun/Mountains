import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ApprovalRequest, Risk } from "@mountains/tools";

/** 静态审批规则：按风险等级与命令模式自动允许或拒绝，决策写入运行记录。 */
export interface ApprovalRule {
	id: string;
	decision: "allow" | "deny";
	risks?: Risk[];
	/** 对命令展示文本的正则 */
	pattern?: string;
}

export interface ApprovalPolicy {
	rules: ApprovalRule[];
	/** 没有规则命中时的决定；交互模式下由界面询问 */
	fallback: "deny" | "ask";
}

export function matchRule(policy: ApprovalPolicy, req: ApprovalRequest): ApprovalRule | null {
	for (const r of policy.rules) {
		if (r.risks && !r.risks.includes(req.risk)) continue;
		if (r.pattern && !new RegExp(r.pattern).test(req.command)) continue;
		return r;
	}
	return null;
}

/** 默认静态规则：自动批准未被显式拒绝的操作，只拒绝危险命令 */
export const BENCH_APPROVAL: ApprovalPolicy = {
	rules: [
		{ id: "deny-dangerous", decision: "deny", risks: ["dangerous"] },
		{ id: "allow-non-dangerous", decision: "allow", risks: ["read-only", "workspace-write", "network"] },
	],
	fallback: "deny",
};

export class BudgetExceeded extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BudgetExceeded";
	}
}

export interface BudgetReservationScope {
	key: string;
	maxCost: number;
	maxRequests: number;
}

export interface BudgetReservation {
	runId: string;
	requestId: string;
	amount: number;
	scope?: BudgetReservationScope;
}

export interface BudgetSnapshot {
	spent: number;
	reserved: number;
	requests: number;
	unknownCost: number;
}

interface SavedReservation extends BudgetReservation {
	currency: string;
	taskLimit: number;
	settlement?: { amount: number; partial: boolean; overrun: boolean };
}

interface BudgetState {
	spent: Map<string, number>;
	runSpent: Map<string, number>;
	legacyRequests: Map<string, number>;
	reservations: Map<string, SavedReservation>;
	scopes: Map<string, BudgetReservationScope>;
	taskLimits: Map<string, number>;
	overruns: Set<string>;
	claimedRuns: Set<string>;
}

const keyOf = (...parts: string[]): string => JSON.stringify(parts);
const money = (value: unknown, label: string): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是有限非负数`);
	return value;
};
const nameOf = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空`);
	return value;
};
function scopeOf(value: unknown): BudgetReservationScope | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") throw new Error("预算分组无效");
	const s = value as BudgetReservationScope;
	if (!Number.isSafeInteger(s.maxRequests) || s.maxRequests < 0) throw new Error("审批次数上限必须是非负安全整数");
	return { key: nameOf(s.key, "预算分组"), maxCost: money(s.maxCost, "审批费用上限"), maxRequests: s.maxRequests };
}
function add(map: Map<string, number>, key: string, amount: number): void {
	const total = (map.get(key) ?? 0) + amount;
	if (!Number.isFinite(total)) throw new Error("累计费用超出范围");
	map.set(key, total);
}

/**
 * 主模型与审批模型共用的预算账本。新请求先持久预留，再结算；旧 check/record 调用仍可用。
 * 所有操作短暂独占同一真实路径的锁，锁内重读，锁不会跨越网络等待。
 * 进程崩溃留下的锁需在确认进程结束后由操作者清理，不能自动抢占。
 */
export class BudgetGuard {
	readonly globalLimit: number;
	readonly currency: string;
	readonly ledgerPath: string;
	private readonly trackedRuns = new Set<string>();

	constructor(opts: { globalLimit: number; currency?: string; ledgerPath: string }) {
		this.globalLimit = money(opts.globalLimit, "全局预算");
		this.currency = nameOf(opts.currency ?? "USD", "币种");
		const file = resolve(opts.ledgerPath);
		mkdirSync(dirname(file), { recursive: true });
		this.ledgerPath = existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file));
		this.readState();
	}

	static fromEnv(ledgerPath: string, currency = "USD", env: NodeJS.ProcessEnv = process.env): BudgetGuard {
		const pick = (v: string | undefined) => {
			const n = Number(v);
			return v !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
		};
		const limit = pick(env.MOUNTAINS_BUDGET) ?? (currency === "USD" ? (pick(env.MOUNTAINS_BUDGET_USD) ?? 5) : undefined);
		if (limit === undefined) throw new Error(`该模型按 ${currency} 计价：请用环境变量 MOUNTAINS_BUDGET 设置全局预算上限（${currency}）`);
		return new BudgetGuard({ globalLimit: limit, currency, ledgerPath });
	}

	private locked<T>(fn: (state: BudgetState) => T): T {
		const lock = `${this.ledgerPath}.lock`;
		try { mkdirSync(lock); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BudgetExceeded("预算账本正在写入或遗留未清理的锁，拒绝继续请求");
			throw error;
		}
		try { return fn(this.readState()); }
		finally { rmSync(lock, { recursive: true }); }
	}

	private append(row: Record<string, unknown>): void {
		appendFileSync(this.ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, { flush: true });
	}

	private readState(): BudgetState {
		const state: BudgetState = { spent: new Map(), runSpent: new Map(), legacyRequests: new Map(), reservations: new Map(), scopes: new Map(), taskLimits: new Map(), overruns: new Set(), claimedRuns: new Set() };
		if (!existsSync(this.ledgerPath)) return state;
		for (const line of readFileSync(this.ledgerPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const row = JSON.parse(line) as Record<string, unknown>;
			if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("预算账本记录无效");
			const currency = nameOf(row.kind === undefined ? row.currency ?? "USD" : row.currency, "台账币种");
			if (row.kind === undefined) {
				const amount = money(row.amount ?? row.usd, "历史台账金额");
				add(state.spent, currency, amount);
				if (typeof row.runId === "string") {
					const run = keyOf(currency, row.runId);
					add(state.runSpent, run, amount);
					add(state.legacyRequests, run, 1);
				}
				continue;
			}
			if (row.version !== 1) throw new Error("预算台账版本无效");
			const runId = nameOf(row.runId, "台账运行编号");
			if (row.kind === "budget.run-claim") {
				const run = keyOf(currency, runId);
				if (state.claimedRuns.has(run) || state.legacyRequests.has(run)
					|| [...state.reservations.values()].some((r) => r.currency === currency && r.runId === runId)) throw new Error("运行启动记录重复或晚于请求");
				state.claimedRuns.add(run);
				continue;
			}
			const requestId = nameOf(row.requestId, "台账请求编号");
			const id = keyOf(currency, runId, requestId);
			if (row.kind === "budget.reserve") {
				if (state.reservations.has(id)) throw new Error("预算预留重复");
				const amount = money(row.worstCost, "预算预留金额");
				const taskLimit = money(row.taskLimit, "任务预算上限");
				if (!Object.hasOwn(row, "scope")) throw new Error("预算预留缺少分组字段");
				const scope = scopeOf(row.scope === null ? undefined : row.scope);
				this.checkScope(state, scope, currency);
				const run = keyOf(currency, runId);
				if (state.taskLimits.has(run) && state.taskLimits.get(run) !== taskLimit) throw new Error("任务预算上限发生变化");
				state.taskLimits.set(run, taskLimit);
				if (scope) state.scopes.set(keyOf(currency, scope.key), scope);
				state.reservations.set(id, { runId, requestId, amount, currency, taskLimit, ...(scope ? { scope } : {}) });
			} else if (row.kind === "budget.settle") {
				const reservation = state.reservations.get(id);
				if (!reservation || reservation.settlement) throw new Error("结算缺少预留或重复结算");
				const amount = money(row.amount, "预算结算金额");
				if (typeof row.partial !== "boolean" || typeof row.overrun !== "boolean") throw new Error("预算结算状态无效");
				if (row.partial && amount < reservation.amount) throw new Error("未知费用不能释放原预留");
				if (row.overrun !== (amount > reservation.amount)) throw new Error("预算结算超额标记无效");
				reservation.settlement = { amount, partial: row.partial, overrun: row.overrun };
				if (row.overrun) state.overruns.add(currency);
				add(state.spent, currency, amount);
				add(state.runSpent, keyOf(currency, runId), amount);
			} else throw new Error("未知预算台账记录类型");
		}
		return state;
	}

	private checkScope(state: BudgetState, scope: BudgetReservationScope | undefined, currency = this.currency): void {
		if (!scope) return;
		const previous = state.scopes.get(keyOf(currency, scope.key));
		if (previous && JSON.stringify(previous) !== JSON.stringify(scope)) throw new Error("审批预算分组配置发生变化");
	}

	private usage(state: BudgetState, runId?: string, scope?: BudgetReservationScope): BudgetSnapshot {
		const entries = [...state.reservations.values()].filter((r) => r.currency === this.currency && (runId === undefined || r.runId === runId) && (!scope || r.scope?.key === scope.key));
		const spent = scope ? entries.reduce((sum, r) => sum + (r.settlement?.amount ?? 0), 0)
			: runId === undefined ? state.spent.get(this.currency) ?? 0 : state.runSpent.get(keyOf(this.currency, runId)) ?? 0;
		return {
			spent,
			reserved: entries.reduce((sum, r) => sum + (r.settlement ? 0 : r.amount), 0),
			requests: entries.length + (scope ? 0 : runId === undefined ? 0 : state.legacyRequests.get(keyOf(this.currency, runId)) ?? 0),
			unknownCost: entries.reduce((sum, r) => sum + (r.settlement?.partial ? r.settlement.amount : 0), 0),
		};
	}

	private checkAmounts(state: BudgetState, amount: number, runLimit: number, runId?: string): void {
		if (state.overruns.has(this.currency)) throw new BudgetExceeded("已报告费用超过预留上界，停止继续请求");
		const global = this.usage(state);
		const spent = runId === undefined ? [...this.trackedRuns].reduce((sum, id) => sum + this.usage(state, id).spent, 0) : this.usage(state, runId).spent;
		// 尚未绑定运行时也不能忽略另一个实例刚写下的预留。
		const reserved = runId === undefined ? (this.trackedRuns.size ? [...this.trackedRuns].reduce((sum, id) => sum + this.usage(state, id).reserved, 0) : global.reserved) : this.usage(state, runId).reserved;
		if (global.spent + global.reserved + amount > this.globalLimit) throw new BudgetExceeded(`全局预算不足：已用 ${global.spent} + 预留 ${global.reserved} + 本次 ${amount} > ${this.globalLimit} ${this.currency}`);
		if (spent + reserved + amount > runLimit) throw new BudgetExceeded(`单任务费用上限：已用 ${spent} + 预留 ${reserved} + 本次 ${amount} > ${runLimit} ${this.currency}`);
	}

	get globalSpent(): number { return this.locked((s) => this.usage(s).spent); }
	get spentThisRun(): number { return this.locked((s) => [...this.trackedRuns].reduce((sum, id) => sum + this.usage(s, id).spent, 0)); }

	/** 原子登记首次启动；永久保留，崩溃或重启不能把同一运行的计数清零。 */
	claimRun(runId: string): void {
		nameOf(runId, "运行编号");
		this.locked((state) => {
			if (state.claimedRuns.has(keyOf(this.currency, runId)) || this.usage(state, runId).requests > 0) {
				throw new BudgetExceeded("该运行已有启动或请求记录；请核对旧账和历史后再恢复，不能从零重新启动");
			}
			this.append({ kind: "budget.run-claim", version: 1, currency: this.currency, runId });
		});
		this.trackedRuns.add(runId);
	}

	check(worstCase: number, runLimit: number): void {
		money(worstCase, "请求预留"); money(runLimit, "任务预算上限");
		this.locked((state) => this.checkAmounts(state, worstCase, runLimit));
	}

	record(entry: { runId: string; requestId: string; amount: number; partial: boolean }): void {
		nameOf(entry.runId, "运行编号"); nameOf(entry.requestId, "请求编号"); money(entry.amount, "请求费用");
		this.locked((state) => {
			if (state.reservations.has(keyOf(this.currency, entry.runId, entry.requestId))) throw new Error("已预留请求必须使用 settleReservation 结算");
			this.append({ ...entry, currency: this.currency });
		});
		this.trackedRuns.add(entry.runId);
	}

	snapshot(options: { runId: string; scope?: BudgetReservationScope }): BudgetSnapshot {
		nameOf(options.runId, "运行编号");
		const scope = scopeOf(options.scope);
		const result = this.locked((state) => { this.checkScope(state, scope); return this.usage(state, options.runId, scope); });
		this.trackedRuns.add(options.runId);
		return result;
	}

	/** 幂等仅供恢复/重复提交同一预留；不表示同一编号可再发一次上游请求。 */
	reserve(entry: BudgetReservation, taskLimit: number): void {
		nameOf(entry.runId, "运行编号"); nameOf(entry.requestId, "请求编号"); money(entry.amount, "请求预留"); money(taskLimit, "任务预算上限");
		const scope = scopeOf(entry.scope);
		this.locked((state) => {
			this.checkScope(state, scope);
			const previous = state.reservations.get(keyOf(this.currency, entry.runId, entry.requestId));
			if (previous) {
				if (previous.amount !== entry.amount || previous.taskLimit !== taskLimit || JSON.stringify(previous.scope) !== JSON.stringify(scope)) throw new Error("同一请求的预算预留发生变化");
				return;
			}
			const savedLimit = state.taskLimits.get(keyOf(this.currency, entry.runId));
			if (savedLimit !== undefined && savedLimit !== taskLimit) throw new Error("任务预算上限发生变化");
			this.checkAmounts(state, entry.amount, taskLimit, entry.runId);
			if (scope) {
				const used = this.usage(state, undefined, scope);
				if (used.spent + used.reserved + entry.amount > scope.maxCost) throw new BudgetExceeded("审批费用额度不足");
				if (used.requests >= scope.maxRequests) throw new BudgetExceeded("审批请求次数已达上限");
			}
			this.append({ kind: "budget.reserve", version: 1, currency: this.currency, runId: entry.runId, requestId: entry.requestId, worstCost: entry.amount, taskLimit, scope: scope ?? null });
		});
		this.trackedRuns.add(entry.runId);
	}

	settleReservation(entry: { runId: string; requestId: string; amount?: number; partial?: boolean }): { amount: number; partial: boolean } {
		nameOf(entry.runId, "运行编号"); nameOf(entry.requestId, "请求编号");
		if (entry.amount !== undefined) money(entry.amount, "请求费用");
		if (entry.partial !== undefined && typeof entry.partial !== "boolean") throw new Error("费用完整性标记无效");
		const result = this.locked((state) => {
			const reservation = state.reservations.get(keyOf(this.currency, entry.runId, entry.requestId));
			if (!reservation) throw new Error("请求没有预算预留");
			const partial = entry.amount === undefined || entry.partial === true;
			const amount = partial ? Math.max(reservation.amount, entry.amount ?? 0) : entry.amount!;
			const overrun = amount > reservation.amount;
			if (reservation.settlement) {
				if (reservation.settlement.amount !== amount || reservation.settlement.partial !== partial) throw new Error("同一请求的结算结果发生变化");
			} else this.append({ kind: "budget.settle", version: 1, currency: this.currency, runId: entry.runId, requestId: entry.requestId, amount, partial, overrun });
			return { amount, partial, overrun };
		});
		this.trackedRuns.add(entry.runId);
		if (result.overrun) throw new BudgetExceeded("已报告费用超过预留上界，费用已记账，停止继续请求");
		return { amount: result.amount, partial: result.partial };
	}
}
