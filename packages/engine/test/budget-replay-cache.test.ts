import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BudgetGuard } from "../src/policy.ts";
function fixture(t: TestContext) { const root = mkdtempSync(join(tmpdir(), "mountains-replay-cache-")); t.after(() => rmSync(root, { recursive: true, force: true })); const path = join(root, "spend.jsonl"); const guard = new BudgetGuard({ globalLimit: 100, ledgerPath: path }); return { path, guard }; }
const row = (amount: number) => JSON.stringify({ runId: "run", requestId: "legacy", amount, currency: "USD" }) + "\n";
test("replay cache detects changed prefixes, same-size rewrites and truncation", t => {
 const { path, guard } = fixture(t); writeFileSync(path, row(1)); assert.equal(guard.globalSpent, 1); assert.equal(guard.globalSpent, 1);
 writeFileSync(path, row(9)); assert.equal(guard.globalSpent, 9);
 writeFileSync(path, ""); assert.equal(guard.globalSpent, 0);
 writeFileSync(path, row(2)); assert.equal(guard.globalSpent, 2);
});
test("a bad appended tail cannot poison cached state after repair", t => {
 const { path, guard } = fixture(t); writeFileSync(path, row(1)); assert.equal(guard.globalSpent, 1);
 appendFileSync(path, row(2) + "not JSON\n"); assert.throws(() => guard.globalSpent);
 writeFileSync(path, row(1) + row(2)); assert.equal(guard.globalSpent, 3); assert.equal(guard.globalSpent, 3);
});
test("another guard's reservations and settlements remain visible", t => {
 const { path, guard } = fixture(t); guard.claimRun("a"); guard.reserve({ runId: "a", requestId: "q", amount: 5 }, 10);
 const other = new BudgetGuard({ globalLimit: 100, ledgerPath: path }); assert.equal(other.snapshot({ runId: "a" }).reserved, 5);
 other.settleReservation({ runId: "a", requestId: "q", amount: 2 }); assert.equal(guard.snapshot({ runId: "a" }).spent, 2);
 assert.equal(guard.snapshot({ runId: "a" }).reserved, 0);
 const saved = readFileSync(path, "utf8"); appendFileSync(path, JSON.stringify({ kind: "budget.run-claim", version: 1, currency: "USD", runId: "a" }) + "\n");
 assert.throws(() => guard.globalSpent, /启动记录重复/); writeFileSync(path, saved); assert.equal(guard.globalSpent, 2);
});
