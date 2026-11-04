import { existsSync, readFileSync } from "node:fs";

/** Spend in the ledger since local midnight, per currency: settled requests, and plain spent rows (titles). */
export function spentToday(ledger: string, now = new Date()): Record<string, number> {
	const totals: Record<string, number> = {};
	if (!existsSync(ledger)) return totals;
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	for (const line of readFileSync(ledger, "utf8").split("\n")) {
		if (!line.includes("\"amount\"")) continue;
		try {
			const entry = JSON.parse(line) as { kind?: string; at?: string; amount?: number; currency?: string };
			if ((entry.kind === "budget.settle" || entry.kind === undefined) && typeof entry.amount === "number" && entry.currency && Date.parse(entry.at ?? "") >= midnight) totals[entry.currency] = (totals[entry.currency] ?? 0) + entry.amount;
		} catch { /* a torn last line is skipped */ }
	}
	return totals;
}
