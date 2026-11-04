import assert from "node:assert/strict";
import { test } from "node:test";
import { appearanceTool } from "../src/main/appearance.ts";
import { GOAL_CONTINUE, GOAL_NOTE, GOAL_VERIFY, goalVerdict, nextRound, PLAN_NOTE, splitNote, type Goal } from "../src/main/modes.ts";

test("a goal reply is read by its last line, with Markdown marks ignored", () => {
	assert.deepEqual(goalVerdict("改好了。\n\n**GOAL MET**"), { kind: "met" });
	assert.deepEqual(goalVerdict("还差一步\nGOAL BLOCKED: 需要你的 API key"), { kind: "blocked", reason: "需要你的 API key" });
	assert.deepEqual(goalVerdict("GOAL MET 之前还要跑测试\n接着做"), { kind: "working" });
});

test("a goal goes on until it is met, then one round checks it before it stops", () => {
	const goal: Goal = { text: "x", status: "active", rounds: 1, startedAt: 0 };
	const working = nextRound(goal, { status: "completed", reason: "", reply: "做了一半" });
	assert.equal(working.send, GOAL_CONTINUE);
	const said = nextRound(working.goal, { status: "completed", reason: "", reply: "GOAL MET" });
	assert.deepEqual([said.goal.status, said.send], ["verifying", GOAL_VERIFY]);
	const checked = nextRound(said.goal, { status: "completed", reason: "", reply: "重跑通过\nGOAL MET" });
	assert.deepEqual([checked.goal.status, checked.send, checked.goal.rounds], ["met", null, 3]);
	const doubted = nextRound(said.goal, { status: "completed", reason: "", reply: "有一项没过，继续修" });
	assert.deepEqual([doubted.goal.status, doubted.send], ["active", GOAL_CONTINUE]);
	assert.equal(nextRound(goal, { status: "cancelled", reason: "", reply: "" }).goal.status, "stopped");
	assert.equal(nextRound(goal, { status: "failed", reason: "网络断了", reply: "" }).goal.reason, "网络断了");
});

test("a goal has no round limit, but rounds that only talk stop it", () => {
	let goal: Goal = { text: "x", status: "active", rounds: 1, startedAt: 0 };
	for (let i = 0; i < 500; i++) goal = nextRound(goal, { status: "completed", reason: "", reply: "接着做", acted: true }).goal;
	assert.equal(goal.status, "active", "work goes on as long as it takes");
	for (const expected of ["active", "active", "blocked"]) goal = nextRound(goal, { status: "completed", reason: "", reply: "我再想想", acted: false }).goal;
	assert.equal(goal.status, "blocked");
	assert.match(goal.reason!, /连续 3 轮/);
	const back = nextRound({ ...goal, status: "active", idle: 2 }, { status: "completed", reason: "", reply: "改好一处", acted: true });
	assert.equal(back.goal.idle, 0, "a round that does something starts the count again");
});

test("the note a mode added is told apart from the user's words", () => {
	assert.deepEqual(splitNote(`做个计划${PLAN_NOTE}`), { text: "做个计划", note: "plan" });
	assert.deepEqual(splitNote(`修好测试${GOAL_NOTE}`), { text: "修好测试", note: "goal" });
	assert.deepEqual(splitNote("普通消息"), { text: "普通消息", note: null });
});

test("the model can change colours, but not into something unreadable", async () => {
	const tool = appearanceTool();
	const ok = await tool.execute({ name: "海", dark: { background: "#001020", panel: "#0A2030" } }, {} as never);
	assert.equal(ok.ok, true);
	const theme = JSON.parse((ok.details as { theme: string }).theme) as { name: string; dark: { background: string; text: string } };
	assert.deepEqual([theme.name, theme.dark.background, theme.dark.text], ["海", "#001020", "#EDEDED"]);
	const hidden = await tool.execute({ dark: { panel: "#EDEDED" } }, {} as never);
	assert.equal(hidden.ok, false);
	assert.match(hidden.modelContent, /approval card/);
	const bad = await tool.execute({ dark: { text: "url(x)" } }, {} as never);
	assert.equal(bad.ok, false);
});
