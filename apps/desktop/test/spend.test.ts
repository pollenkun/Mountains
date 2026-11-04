import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spentToday } from "../src/main/spend.ts";

test("today's spend sums settled amounts since local midnight, per currency", () => {
	const ledger = join(mkdtempSync(join(tmpdir(), "mountains-spend-")), "spend.jsonl");
	const now = new Date(2026, 9, 27, 15, 0, 0);
	const at = (d: Date) => d.toISOString();
	writeFileSync(ledger, [
		{ kind: "budget.settle", at: at(new Date(2026, 9, 27, 9)), amount: 0.5, currency: "CNY" },
		{ kind: "budget.settle", at: at(new Date(2026, 9, 27, 10)), amount: 0.25, currency: "CNY" },
		{ kind: "budget.reserve", at: at(new Date(2026, 9, 27, 10)), worstCost: 9, currency: "CNY" },
		{ kind: "budget.settle", at: at(new Date(2026, 9, 26, 23)), amount: 4, currency: "CNY" },
		{ kind: "budget.settle", at: at(new Date(2026, 9, 27, 11)), amount: 0.1, currency: "USD" },
		{ at: at(new Date(2026, 9, 27, 12)), runId: "title_c1", amount: 0.05, currency: "CNY" },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n{\"kind\":\"budget.settle\",\"am");
	assert.deepEqual(spentToday(ledger, now), { CNY: 0.8, USD: 0.1 });
	assert.deepEqual(spentToday(join(tmpdir(), "no-such-ledger.jsonl"), now), {});
});
