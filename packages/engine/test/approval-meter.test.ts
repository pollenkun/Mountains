import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SpendLedger } from "@mountains/telemetry";
import { ApprovalMeter, type ApprovalMeterOptions } from "../src/approval-meter.ts";
import { BudgetExceeded, BudgetGuard } from "../src/policy.ts";

function fixture(globalLimit = 10) {
	const dir = mkdtempSync(join(tmpdir(), "mountains-approval-meter-"));
	const file = join(dir, "spend.jsonl");
	const guard = () => new BudgetGuard({ globalLimit, currency: "USD", ledgerPath: file });
	const budget = guard();
	const meter = (over: Partial<ApprovalMeterOptions> = {}) => new ApprovalMeter({ budget, taskLimit: 10, maxCost: 4, maxRequests: 4, currency: "USD", runId: "run-a", ...over });
	return { dir, file, guard, budget, meter, rows: () => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("首次启动永久落盘但不计请求或费用；未发请求就退出也不能重启同一运行", () => {
	const f = fixture();
	try {
		f.budget.claimRun("run-a");
		assert.deepEqual(f.budget.snapshot({ runId: "run-a" }), { spent: 0, reserved: 0, requests: 0, unknownCost: 0 });
		assert.equal(new SpendLedger(f.file).total("USD"), 0);
		assert.equal(f.rows()[0].kind, "budget.run-claim");
		assert.throws(() => f.budget.claimRun("run-a"), BudgetExceeded);
		assert.throws(() => f.guard().claimRun("run-a"), /不能从零重新启动/);
		f.meter().reserve({ requestId: "first", worstCost: 1 });
		f.meter().settle({ requestId: "first", actualCost: 0.25 });
		assert.deepEqual(f.guard().snapshot({ runId: "run-a" }), { spent: 0.25, reserved: 0, requests: 1, unknownCost: 0 });
		assert.doesNotThrow(() => f.guard().claimRun("run-b"));
	} finally { f.close(); }
});

test("已有旧请求、未结预留或零费用结算的运行都不能补登记为新启动", () => {
	const f = fixture();
	try {
		f.budget.record({ runId: "legacy", requestId: "old", amount: 0, partial: false });
		f.budget.reserve({ runId: "pending", requestId: "pending", amount: 1 }, 10);
		f.budget.reserve({ runId: "settled", requestId: "settled", amount: 1 }, 10);
		f.budget.settleReservation({ runId: "settled", requestId: "settled", amount: 0 });
		const before = readFileSync(f.file, "utf8");
		for (const runId of ["legacy", "pending", "settled"]) assert.throws(() => f.guard().claimRun(runId), BudgetExceeded);
		assert.equal(readFileSync(f.file, "utf8"), before);
		assert.throws(() => f.budget.claimRun("  "), /不能为空/);
	} finally { f.close(); }
});

test("两个已就绪进程同时启动同一运行，只有一个能登记且进程退出后登记仍在", async () => {
	const f = fixture();
	const policy = new URL("../src/policy.ts", import.meta.url).href;
	try {
		const child = () => {
			const code = `import { BudgetGuard } from ${JSON.stringify(policy)};
const budget = new BudgetGuard({ globalLimit: 10, ledgerPath: ${JSON.stringify(f.file)} });
process.once("message", () => {
  try { budget.claimRun("run-a"); console.log(JSON.stringify({ok:true})); }
  catch (error) { console.log(JSON.stringify({ok:false,error:String(error)})); }
  process.disconnect();
});
process.send("ready");`;
			const processHandle = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
			const ready = new Promise<void>((resolve, reject) => {
				processHandle.once("message", () => resolve());
				processHandle.once("error", reject);
			});
			const outcome = new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
				let out = ""; let err = "";
				processHandle.stdout!.on("data", (chunk) => { out += String(chunk); });
				processHandle.stderr!.on("data", (chunk) => { err += String(chunk); });
				processHandle.once("error", reject);
				processHandle.once("close", (exit) => { if (exit !== 0) reject(new Error(err)); else resolve(JSON.parse(out)); });
			});
			return { processHandle, ready, outcome };
		};
		const children = [child(), child()];
		await Promise.all(children.map((c) => c.ready));
		for (const c of children) c.processHandle.send("start");
		const outcomes = await Promise.all(children.map((c) => c.outcome));
		assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
		assert.equal(f.rows().length, 1);
		assert.throws(() => f.guard().claimRun("run-a"), /不能从零重新启动/);
		assert.deepEqual(f.guard().snapshot({ runId: "run-a" }), { spent: 0, reserved: 0, requests: 0, unknownCost: 0 });
	} finally { f.close(); }
});

test("重复或缺少币种的启动记录拒绝恢复，不能忽略损坏记录", () => {
	const f = fixture();
	try {
		f.budget.claimRun("run-a");
		const row = f.rows()[0];
		appendFileSync(f.file, `${JSON.stringify(row)}\n`);
		assert.throws(() => f.guard(), /启动记录重复/);
		delete row.currency;
		writeFileSync(f.file, `${JSON.stringify(row)}\n`);
		assert.throws(() => f.guard(), /台账币种/);
	} finally { f.close(); }
});

test("审批预留先落盘，主请求 check 也看见；已知结算只计实际费用", () => {
	const f = fixture();
	try {
		const meter = f.meter({ taskLimit: 3 });
		meter.reserve({ requestId: "approval-1", worstCost: 2 });
		assert.equal(f.rows()[0].kind, "budget.reserve");
		assert.deepEqual(meter.snapshot, { spent: 0, reserved: 2, requests: 1, unknownCost: 0 });
		assert.throws(() => f.budget.check(2, 3), BudgetExceeded);
		assert.deepEqual(meter.settle({ requestId: "approval-1", actualCost: 0.5 }), { amount: 0.5, partial: false });
		assert.equal(f.budget.globalSpent, 0.5);
		assert.equal(f.budget.spentThisRun, 0.5);
		assert.equal(new SpendLedger(f.file).total("USD"), 0.5, "旧读者也不会把预留重复算成已花");
		assert.doesNotThrow(() => f.budget.check(2, 3));
		assert.deepEqual(meter.snapshot, { spent: 0.5, reserved: 0, requests: 1, unknownCost: 0 });
	} finally { f.close(); }
});

test("未知费用按整份预留结算，重启和重复提交都不会变成零或重复收费", () => {
	const f = fixture();
	try {
		const meter = f.meter();
		meter.reserve({ requestId: "timeout", worstCost: 2 });
		assert.deepEqual(meter.settle({ requestId: "timeout" }), { amount: 2, partial: true });
		const before = readFileSync(f.file, "utf8");
		const restarted = f.meter({ budget: f.guard() });
		restarted.reserve({ requestId: "timeout", worstCost: 2 });
		assert.deepEqual(restarted.settle({ requestId: "timeout" }), { amount: 2, partial: true });
		assert.deepEqual(restarted.snapshot, { spent: 2, reserved: 0, requests: 1, unknownCost: 2 });
		assert.equal(readFileSync(f.file, "utf8"), before);
		assert.equal(f.budget.globalSpent, 2);
		assert.throws(() => restarted.settle({ requestId: "timeout", actualCost: 0 }), /结算结果发生变化/);
	} finally { f.close(); }
});

test("未结算预留在新 BudgetGuard 和新 meter 中恢复，仍同时挡住次数和总预算", () => {
	const f = fixture(3);
	try {
		f.meter({ maxRequests: 1 }).reserve({ requestId: "crashed", worstCost: 2 });
		const budget = f.guard();
		const meter = f.meter({ budget, maxRequests: 1 });
		assert.deepEqual(meter.snapshot, { spent: 0, reserved: 2, requests: 1, unknownCost: 0 });
		assert.throws(() => budget.check(2, 10), /全局预算不足/);
		assert.throws(() => meter.reserve({ requestId: "next", worstCost: 0.1 }), /次数/);
		meter.settle({ requestId: "crashed" });
		assert.equal(budget.spentThisRun, 2);
		assert.equal(f.budget.globalSpent, 2, "早创建的guard也读到新实例结算");
	} finally { f.close(); }
});

test("两个 meter 共享审批子额度，两个 guard 也共享主任务和全局余额", () => {
	const f = fixture(5);
	try {
		const first = f.meter({ maxCost: 2, taskLimit: 4 });
		const other = f.meter({ budget: f.guard(), maxCost: 2, taskLimit: 4 });
		first.reserve({ requestId: "a", worstCost: 1.5 });
		assert.throws(() => other.reserve({ requestId: "b", worstCost: 1 }), /审批费用/);
		first.settle({ requestId: "a", actualCost: 0.5 });
		other.reserve({ requestId: "b", worstCost: 1 });
		f.budget.reserve({ runId: "run-a", requestId: "main", amount: 2 }, 4);
		assert.throws(() => other.reserve({ requestId: "c", worstCost: 0.6 }), /单任务费用/);
		const separateTask = f.meter({ budget: f.guard(), runId: "run-b" });
		assert.throws(() => separateTask.reserve({ requestId: "c", worstCost: 2 }), /全局预算/);
		assert.equal(f.rows().filter((row) => row.kind === "budget.reserve").length, 3);
	} finally { f.close(); }
});

test("并发进程只能有一个占到最后余额，独占锁从不跨网络等待", async () => {
	const f = fixture(1);
	const policy = new URL("../src/policy.ts", import.meta.url).href;
	try {
		const child = (id: string) => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
			const code = `import { BudgetGuard } from ${JSON.stringify(policy)};
const b = new BudgetGuard({ globalLimit: 1, ledgerPath: ${JSON.stringify(f.file)} });
try { b.reserve({ runId: "run-a", requestId: ${JSON.stringify(id)}, amount: 0.75 }, 1); console.log(JSON.stringify({ok:true})); }
catch(e) { console.log(JSON.stringify({ok:false,error:String(e)})); }`;
			const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
			let out = ""; let err = "";
			p.stdout.on("data", (chunk) => { out += String(chunk); });
			p.stderr.on("data", (chunk) => { err += String(chunk); });
			p.once("error", reject);
			p.once("close", (exit) => { if (exit !== 0) reject(new Error(err)); else resolve(JSON.parse(out)); });
		});
		const outcomes = await Promise.all([child("one"), child("two")]);
		assert.equal(outcomes.filter((r) => r.ok).length, 1);
		assert.equal(f.budget.snapshot({ runId: "run-a" }).reserved, 0.75);
		assert.throws(() => f.budget.check(0.5, 1), /预算不足|费用上限/);
	} finally { f.close(); }
});

test("费用为零的失败仍消耗一次审批请求，子额度不会扩大总预算", () => {
	const f = fixture(1);
	try {
		const meter = f.meter({ maxRequests: 1, maxCost: 100 });
		assert.throws(() => meter.reserve({ requestId: "too-costly", worstCost: 2 }), /全局预算/);
		assert.equal(meter.snapshot.requests, 0);
		meter.reserve({ requestId: "no-forward", worstCost: 0.5 });
		meter.settle({ requestId: "no-forward", actualCost: 0 });
		assert.equal(meter.snapshot.spent, 0);
		assert.throws(() => meter.reserve({ requestId: "another", worstCost: 0 }), /次数/);
	} finally { f.close(); }
});

test("同一编号预留与结算幂等，冲突结果不写账；旧 record 不重复结算预留请求", () => {
	const f = fixture();
	try {
		const meter = f.meter();
		meter.reserve({ requestId: "one", worstCost: 1 });
		meter.reserve({ requestId: "one", worstCost: 1 });
		assert.equal(meter.snapshot.requests, 1);
		assert.throws(() => meter.reserve({ requestId: "one", worstCost: 2 }), /预留发生变化/);
		assert.throws(() => f.budget.record({ runId: "run-a", requestId: "one", amount: 1, partial: false }), /settleReservation/);
		meter.settle({ requestId: "one", actualCost: 0.5 });
		meter.settle({ requestId: "one", actualCost: 0.5 });
		assert.throws(() => meter.settle({ requestId: "one", actualCost: 0.7 }), /结算结果发生变化/);
		assert.equal(f.rows().length, 2);
		assert.throws(() => meter.settle({ requestId: "absent", actualCost: 0 }), /没有预算预留/);
	} finally { f.close(); }
});

test("同一作用域配置和任务额度冻结，非法金额和次数拒绝而不写预留", () => {
	const f = fixture();
	try {
		const meter = f.meter();
		for (const worstCost of [-1, NaN, Infinity]) assert.throws(() => meter.reserve({ requestId: "bad", worstCost }), /有限非负/);
		for (const maxCost of [-1, NaN, Infinity]) assert.throws(() => f.meter({ maxCost }), /有限非负/);
		for (const maxRequests of [-1, NaN, Infinity, 1.5]) assert.throws(() => f.meter({ maxRequests }), /安全整数/);
		assert.throws(() => f.meter({ currency: "CNY" }), /币种/);
		assert.throws(() => f.meter({ file: join(f.dir, "other.jsonl") }), /账本一致/);
		meter.reserve({ requestId: "valid", worstCost: 1 });
		assert.throws(() => f.meter({ maxCost: 5 }), /配置发生变化/);
		assert.throws(() => f.meter({ maxRequests: 5 }), /配置发生变化/);
		assert.throws(() => f.meter({ taskLimit: 9 }).reserve({ requestId: "changed", worstCost: 1 }), /任务预算上限发生变化/);
		for (const actualCost of [-1, NaN, Infinity]) assert.throws(() => meter.settle({ requestId: "valid", actualCost }), /有限非负/);
		assert.equal(f.rows().length, 1);
	} finally { f.close(); }
});

test("超过预留的实际费用先落账再阻止请求，重启不丢掉超额", () => {
	const f = fixture();
	try {
		const meter = f.meter();
		meter.reserve({ requestId: "overrun", worstCost: 1 });
		assert.throws(() => meter.settle({ requestId: "overrun", actualCost: 1.5 }), /费用已记账/);
		assert.equal(f.budget.globalSpent, 1.5);
		assert.throws(() => f.guard().check(0, 10), /超过预留/);
		assert.throws(() => f.meter({ budget: f.guard() }).reserve({ requestId: "next", worstCost: 0 }), /超过预留/);
		assert.equal(f.rows().length, 2);
	} finally { f.close(); }
});

test("明确标记 partial 的费用不能用较小 amount 释放预留", () => {
	const f = fixture();
	try {
		f.budget.reserve({ runId: "run-a", requestId: "partial", amount: 2 }, 10);
		assert.deepEqual(f.budget.settleReservation({ runId: "run-a", requestId: "partial", amount: 0, partial: true }), { amount: 2, partial: true });
		assert.equal(f.budget.globalSpent, 2);
	} finally { f.close(); }
});

test("旧金额记录原样累计；新结算可被旧 SpendLedger 读取；不同币种保持独立", () => {
	const f = fixture();
	try {
		const legacy = `${JSON.stringify({ usd: 0.5, runId: "past" })}\n${JSON.stringify({ amount: 2, currency: "CNY", runId: "past" })}\n`;
		writeFileSync(f.file, legacy);
		const meter = f.meter();
		meter.reserve({ requestId: "next", worstCost: 1 });
		meter.settle({ requestId: "next", actualCost: 0.25 });
		assert.equal(f.budget.globalSpent, 0.75);
		assert.equal(new SpendLedger(f.file).total(), 0.75);
		assert.equal(new BudgetGuard({ globalLimit: 10, currency: "CNY", ledgerPath: f.file }).globalSpent, 2);
		assert.ok(readFileSync(f.file, "utf8").startsWith(legacy));
		f.budget.record({ runId: "run-a", requestId: "legacy-main", amount: 0.25, partial: false });
		assert.equal(f.guard().globalSpent, 1);
	} finally { f.close(); }
});

test("锁冲突、损坏账本和缺失预留都阻止请求，不能把恢复失败当零", () => {
	const f = fixture();
	try {
		const meter = f.meter();
		meter.reserve({ requestId: "pending", worstCost: 1 });
		const before = readFileSync(f.file, "utf8");
		mkdirSync(`${f.file}.lock`);
		assert.throws(() => meter.reserve({ requestId: "blocked", worstCost: 1 }), /锁/);
		assert.throws(() => meter.settle({ requestId: "pending", actualCost: 0.5 }), /锁/);
		assert.equal(readFileSync(f.file, "utf8"), before);
		rmSync(`${f.file}.lock`, { recursive: true });
		assert.equal(meter.snapshot.reserved, 1);
		appendFileSync(f.file, '{"kind":');
		assert.throws(() => f.guard());
		assert.throws(() => meter.reserve({ requestId: "after-corrupt", worstCost: 1 }));
		writeFileSync(f.file, `${JSON.stringify({ kind: "budget.settle", version: 1, currency: "USD", runId: "r", requestId: "absent", amount: 1, partial: false, overrun: false })}\n`);
		assert.throws(() => f.guard(), /缺少预留/);
	} finally { f.close(); }
});

test("账本目录别名使用同一真实路径和锁，不能绕开共享余额", () => {
	const f = fixture(1);
	try {
		const alias = join(f.dir, "alias");
		symlinkSync(f.dir, alias, "dir");
		const alternate = new BudgetGuard({ globalLimit: 1, ledgerPath: join(alias, "spend.jsonl") });
		assert.equal(alternate.ledgerPath, f.budget.ledgerPath);
		f.meter().reserve({ requestId: "first", worstCost: 0.75 });
		assert.throws(() => f.meter({ budget: alternate }).reserve({ requestId: "second", worstCost: 0.5 }), /全局预算/);
	} finally { f.close(); }
});

test("子进程预留后直接退出，父进程只靠磁盘恢复完整占用", () => {
	const f = fixture(2);
	try {
		const policy = new URL("../src/policy.ts", import.meta.url).href;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { BudgetGuard } from ${JSON.stringify(policy)};
const b = new BudgetGuard({ globalLimit: 2, ledgerPath: ${JSON.stringify(f.file)} });
b.reserve({ runId: "crash", requestId: "in-flight", amount: 1.5 }, 2);
process.exit(0);`], { encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(f.guard().snapshot({ runId: "crash" }), { spent: 0, reserved: 1.5, requests: 1, unknownCost: 0 });
		assert.throws(() => f.budget.check(1, 2), /全局预算/);
		const restarted = f.guard();
		restarted.settleReservation({ runId: "crash", requestId: "in-flight" });
		assert.equal(restarted.globalSpent, 1.5);
	} finally { f.close(); }
});

test("预留写盘失败不返回许可；结算写盘失败不释放额度，恢复写入后只收费一次", (t) => {
	const f = fixture(2);
	const original = fs.appendFileSync;
	let failKind = "budget.reserve";
	const mock = t.mock.method(fs, "appendFileSync", (...args: Parameters<typeof fs.appendFileSync>) => {
		if (String(args[1]).includes(`"kind":"${failKind}"`)) throw new Error("injected durable-write failure");
		return original(...args);
	});
	syncBuiltinESMExports();
	try {
		const meter = f.meter();
		assert.throws(() => meter.reserve({ requestId: "attempt", worstCost: 1.5 }), /durable-write/);
		assert.equal(meter.snapshot.requests, 0);
		failKind = "budget.settle";
		meter.reserve({ requestId: "attempt", worstCost: 1.5 });
		assert.throws(() => meter.settle({ requestId: "attempt", actualCost: 0.5 }), /durable-write/);
		assert.equal(f.guard().snapshot({ runId: "run-a" }).reserved, 1.5);
		assert.equal(f.budget.globalSpent, 0);
		assert.throws(() => f.budget.check(1, 2), /全局预算/);
		failKind = "none";
		meter.settle({ requestId: "attempt", actualCost: 0.5 });
		meter.settle({ requestId: "attempt", actualCost: 0.5 });
		assert.equal(f.budget.globalSpent, 0.5);
		assert.equal(f.rows().length, 2);
	} finally { mock.mock.restore(); syncBuiltinESMExports(); f.close(); }
});

test("同名scope在不同币种有独立配置，重读混合账本不混算", () => {
	const f = fixture(10);
	try {
		f.budget.reserve({ runId: "usd", requestId: "one", amount: 1, scope: { key: "same", maxCost: 2, maxRequests: 1 } }, 10);
		const cny = new BudgetGuard({ globalLimit: 10, currency: "CNY", ledgerPath: f.file });
		cny.reserve({ runId: "cny", requestId: "one", amount: 2, scope: { key: "same", maxCost: 4, maxRequests: 2 } }, 10);
		assert.equal(f.guard().snapshot({ runId: "usd" }).reserved, 1);
		assert.equal(cny.snapshot({ runId: "cny" }).reserved, 2);
	} finally { f.close(); }
});

test("新格式缺失币种或分组字段时拒绝恢复，不能降级为默认币种或无审批上限", () => {
	const f = fixture();
	try {
		f.meter().reserve({ requestId: "one", worstCost: 1 });
		const row = f.rows()[0];
		for (const field of ["currency", "scope", "worstCost", "taskLimit"]) {
			const broken = { ...row }; delete broken[field];
			writeFileSync(f.file, `${JSON.stringify(broken)}\n`);
			assert.throws(() => f.guard());
		}
	} finally { f.close(); }
});
