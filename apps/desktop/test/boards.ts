/** Event scripts that reproduce the design boards (ToolsFolded, ToolsLoose, Approval) in the real page. */
import type { EngineEvent } from "@mountains/protocol";

let seq = 1;
function base(): { protocolVersion: "0.1.0"; sessionId: string; runId: string; seq: number; eventId: string; time: string } {
	const n = seq++;
	return { protocolVersion: "0.1.0", sessionId: "ses_board", runId: "run_board", seq: n, eventId: `e${n}`, time: "2026-10-27T12:00:00.000Z" };
}

const say = (text: string): EngineEvent[] => [
	{ ...base(), type: "message.delta", turnId: "t", kind: "text", text },
	{ ...base(), type: "message.completed", turnId: "t", text, reasoningChars: 0, toolCalls: [] },
];

function used(input: number, cacheRead: number, output: number, cost: number): EngineEvent {
	return { ...base(), type: "usage", turnId: "t", requestId: `r${seq}`, model: "deepseek-flash", usage: { input, cacheRead, cacheWrite: 0, output, reasoning: 0, total: input + cacheRead + output, partial: false }, rawUsage: null, cost, currency: "CNY", costEstimated: true, priceVersion: "board", pricePeriod: "standard", durationMs: 900, firstTokenMs: 300 };
}

function call(id: string, tool: string, args: Record<string, unknown>, details: Record<string, unknown> = {}, ok = true): EngineEvent[] {
	return [
		used(4_000, 42_000 + seq * 900, 600, 0.0062),
		{ ...base(), type: "tool.requested", turnId: "t", toolCallId: id, tool, args, summary: tool },
		{ ...base(), type: "tool.completed", turnId: "t", toolCallId: id, tool, ok, summary: tool, modelContentChars: 10, durationMs: 120, details },
	];
}

const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join("\n");

/** 修复支付测试: run, read, skill, two looks, recall, edit, run. */
export function paymentsBoard(): EngineEvent[] {
	seq = 1;
	return [
		{ ...base(), type: "run.started", task: "把支付的测试跑一遍，失败的修掉。" },
		...call("c1", "command_run", { argv: ["npm", "test", "--", "payments"] }, { exitCode: 1 }),
		...say("有 2 个测试失败，都卡在签名过期的判断上。"),
		...call("c2", "file_read", { path: "src/webhook.ts" }),
		...call("c3", "file_read", { path: "src/stripe.ts" }),
		...call("c4", "command_run", { argv: ["rg", "tolerance", "src"] }, { exitCode: 0 }),
		...call("c5", "skill", { name: "Computer-use" }),
		...call("c6", "screen_look", { app: "Chrome" }),
		...call("c7", "screen_look", { app: "Chrome" }),
		...call("c8", "session_search", { query: "签名容差" }),
		...call("c9", "file_edit", { path: "src/webhook.ts" }, { path: "src/webhook.ts", oldText: lines(42, "old line"), newText: lines(18, "new line") }),
		...say("按 10 月 21 日定的 300 秒容差改好了，41 个测试全部通过。"),
		...call("c10", "command_run", { argv: ["npm", "test", "--", "payments"] }, { exitCode: 0 }),
		{ ...base(), type: "run.completed", status: "completed", reason: "done", turns: 4, totals: { requests: 4, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } },
	];
}

/** 整理提交并推送: two commands, a summary, a read in progress, then the approval card. */
export function approvalBoard(): EngineEvent[] {
	seq = 1;
	return [
		{ ...base(), type: "run.started", task: "把这几个零碎的提交整理一下，然后推上去。" },
		...call("a1", "command_run", { argv: ["git", "log", "--oneline", "-8"] }, { exitCode: 0 }),
		...call("a2", "command_run", { shellScript: "git reset --soft HEAD~5 && git commit" }, { exitCode: 0 }),
		...say("5 个提交已经合成 1 个：「支付回调统一为 handleWebhook」。接下来推送到远端。"),
		{ ...base(), type: "tool.requested", turnId: "t", toolCallId: "a3", tool: "file_read", args: { path: ".github/pull_request_template.md" }, summary: "file_read" },
		{ ...base(), type: "approval.requested", toolCallId: "a4", command: "git push --force origin main", cwd: ".", risk: "dangerous", explanation: "你说的是「推上去」，没说要强制推送。这会覆盖远端 main 的历史，所以自动审批交给你决定。" },
	];
}

/** A timed stream for watching the motion in a real window: reasoning, a running command, then the reply. */
export function demoScript(): Array<[number, EngineEvent]> {
	seq = 1;
	const out: Array<[number, EngineEvent]> = [[0, { ...base(), type: "run.started", task: "把支付的测试跑一遍，失败的修掉。" }]];
	const thought = "先跑一遍 payments 的测试，看看失败的是哪几个。如果是签名校验的问题，多半和时间容差有关；Stripe 的默认容差是 300 秒，我们的代码里可能写成了 30。";
	for (const piece of thought.match(/.{1,3}/gu) ?? []) out.push([45, { ...base(), type: "message.delta", turnId: "t", kind: "thinking", text: piece }]);
	out.push([600, { ...base(), type: "tool.requested", turnId: "t", toolCallId: "d1", tool: "command_run", args: { argv: ["npm", "test", "--", "payments"] }, summary: "command_run" }]);
	out.push([3200, { ...base(), type: "tool.completed", turnId: "t", toolCallId: "d1", tool: "command_run", ok: true, summary: "command_run", modelContentChars: 10, durationMs: 3200, details: { exitCode: 1 } }]);
	const reply = "有 2 个测试失败，都卡在签名过期的判断上。webhook.ts 里把容差写成了 30 秒，Stripe 建议的是 300 秒。我把它改成 300，再跑一遍确认。";
	for (const piece of reply.match(/.{1,2}/gu) ?? []) out.push([38, { ...base(), type: "message.delta", turnId: "t", kind: "text", text: piece }]);
	out.push([300, { ...base(), type: "message.completed", turnId: "t", text: reply, reasoningChars: 0, toolCalls: [] }]);
	out.push([200, { ...base(), type: "run.completed", status: "completed", reason: "done", turns: 2, totals: { requests: 2, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } }]);
	return out;
}

/** A reply in Markdown and SIUI components: a mortgage calculator the user can play with. */
export function siuiBoard(): EngineEvent[] {
	seq = 1;
	const reply = [
		"按 **30 年等额本息**、首付三成算，月供主要看总价和利率：",
		"",
		"::slider 总价 price 100..1000 =300 万",
		"::slider 年利率 rate 2..6 =3.5 % step=0.05",
		"::grid 3",
		"  ::stat 贷款 {round(price*0.7)} 万",
		"  ::stat 月供 {fixed(price*0.7*10000*(rate/1200)*(1+rate/1200)**360/((1+rate/1200)**360-1), 0)} 元 · green huge",
		"  ::stat 总利息 {round(price*0.7*(rate/1200)*360*(1+rate/1200)**360/((1+rate/1200)**360-1)-price*0.7, 1)} 万",
		"::chart bar 三种总价的月供（元）",
		"  200 万: 6287",
		"  300 万: 9430",
		"  500 万: 15717",
		"::note 利率每降 0.5%，300 万的月供少大约 600 元。 · info",
		"::row",
		"  ::button 就按这个算 -> send \"按总价 {price} 万、利率 {rate}% 再算一下提前还款\"",
		"  ::button 重置 -> reset",
		"",
		"| 方案 | 首付 | 月供 |",
		"|---|---|---|",
		"| 甲 | 90 万 | [9430 元]{green bold} |",
		"| 乙 | 150 万 | 6287 元 |",
	].join("\n");
	return [
		{ ...base(), type: "run.started", task: "300 万的房子，月供大概多少？" },
		used(3_000, 0, 500, 0.004),
		...say(reply),
		{ ...base(), type: "run.completed", status: "completed", reason: "done", turns: 1, totals: { requests: 1, input: 0, cacheRead: 0, output: 0, cost: 0, currency: "CNY" } },
	];
}
