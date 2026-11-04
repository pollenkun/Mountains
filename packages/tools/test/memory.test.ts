import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMemorySearchTool } from "../src/memory.ts";

function run(dir: string, time: string, task: string, reply: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), [
		{ type: "run.started", time, task },
		{ type: "message.delta", time, text: "ignored 容差" },
		{ type: "message.completed", time, text: reply },
	].map((event) => JSON.stringify(event)).join("\n") + "\n");
}

test("memory_search finds requests and replies in earlier runs, newest first, without this run or duplicates", async () => {
	const home = mkdtempSync(join(tmpdir(), "mountains-memory-"));
	const runs = join(home, "runs"), desktop = join(home, "desktop");
	run(join(runs, "run_old"), "2026-10-20T08:00:00Z", "给 API 加限流", "突发流量的容差放宽到 20%。");
	run(join(desktop, "c_aaaaaaaaaaaa", "run"), "2026-10-26T08:00:00Z", "重构支付回调", "Stripe 建议的时间容差是 300 秒。");
	run(join(desktop, "c_aaaaaaaaaaaa"), "2026-10-26T08:00:00Z", "重构支付回调", "Stripe 建议的时间容差是 300 秒。");
	run(join(desktop, "c_current0000", "run"), "2026-10-27T08:00:00Z", "上次定的容差是多少？", "");
	run(join(desktop, "c_current0000"), "2026-10-27T08:00:00Z", "上次定的容差是多少？", "");
	const tool = createMemorySearchTool({ roots: [runs, desktop], exclude: [join(desktop, "c_current0000", "run"), join(desktop, "c_current0000")], now: () => Date.parse("2026-10-27T12:00:00Z") });
	const result = await tool.execute({ query: "容差" }, {} as never);
	assert.equal(result.ok, true);
	assert.equal(result.details?.hits, 2, result.modelContent);
	assert.equal(result.details?.oldestDays, 7);
	assert.doesNotMatch(result.modelContent, /上次定的容差/);
	assert.doesNotMatch(result.modelContent, /ignored/);
	assert.match(result.modelContent, /\[yesterday\] asked: 重构支付回调\nassistant: Stripe 建议的时间容差是 300 秒。/);
	assert.match(result.modelContent, /\[7 days ago\] asked: 给 API 加限流/);
	const none = await tool.execute({ query: "不存在" }, {} as never);
	assert.equal(none.modelContent, 'No earlier conversation mentions "不存在".');
});
