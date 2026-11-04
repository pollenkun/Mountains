/**
 * Plan mode and goal mode: the few English words they add to the user's message, and how a reply is read.
 * Nothing here is sent while both modes are off, so a conversation without them is byte-for-byte Preview 1.
 */

/** Appended to a message sent in plan mode. The program also refuses every change while the mode is on. */
export const PLAN_NOTE = "\n\n[Plan mode: read only. Investigate, then reply with a step-by-step plan. Change nothing until the user approves it.]";
/** Sent when the user approves the plan; plan mode is off from then on. */
export const PLAN_GO = "Go ahead with the plan.";

/** Appended to the goal itself, once, when the goal starts. */
export const GOAL_NOTE = "\n\n[Goal mode: keep working until this goal is met and verified. Then end your reply with GOAL MET. If you cannot go on without the user, end with GOAL BLOCKED: <reason>.]";
/** Each further round, while the goal is not met. */
export const GOAL_CONTINUE = "Continue toward the goal.";
/** Once the model says the goal is met: one more round that checks it before the program stops. */
export const GOAL_VERIFY = "Check that the goal is really met: rerun the checks and look at the results. End with GOAL MET only if all of it holds; otherwise keep working.";

/** A message's own words and the mode note the program added to it, for showing them apart. */
export function splitNote(text: string): { text: string; note: "plan" | "goal" | null } {
	if (text.endsWith(PLAN_NOTE)) return { text: text.slice(0, -PLAN_NOTE.length), note: "plan" };
	if (text.endsWith(GOAL_NOTE)) return { text: text.slice(0, -GOAL_NOTE.length), note: "goal" };
	return { text, note: null };
}

export type GoalVerdict = { kind: "met" } | { kind: "blocked"; reason: string } | { kind: "working" };

/** Reads the last line of a goal round's reply; Markdown emphasis and code marks around the marker are ignored. */
export function goalVerdict(reply: string): GoalVerdict {
	const lines = reply.trim().split("\n").map((line) => line.replace(/[*_`#>]/g, "").trim()).filter(Boolean);
	const last = lines[lines.length - 1] ?? "";
	if (/^GOAL MET[.!。]?$/i.test(last)) return { kind: "met" };
	const blocked = /^GOAL BLOCKED\s*[:：]?\s*(.*)$/i.exec(last);
	if (blocked) return { kind: "blocked", reason: blocked[1]!.trim() };
	return { kind: "working" };
}

export interface Goal {
	text: string;
	/** active: rounds go on; verifying: the model said it is met and one round checks; then met, blocked or stopped. Paused goals never start another round. */
	status: "active" | "verifying" | "met" | "blocked" | "stopped" | "paused";
	/** Send an edited goal next round instead of accepting the old verdict. */
	revised?: boolean;
	rounds: number;
	startedAt: number;
	/** Why it stopped or is blocked, in the model's or the run's own words. */
	reason?: string;
	/** Rounds in a row that used no tool: the model is only talking. */
	idle?: number;
}

/** A goal has no limit on rounds, but this many in a row with nothing done stop it and hand it back to the user. */
export const IDLE_ROUNDS = 3;

/** What the program does when a goal round ends: the next round's message, or the goal's end. */
export function nextRound(goal: Goal, run: { status: string; reason: string; reply: string; acted?: boolean }): { goal: Goal; send: string | null } {
	if (goal.status === "paused") return { goal, send: null };
	if (run.status === "cancelled") return { goal: { ...goal, status: "stopped" }, send: null };
	if (run.status !== "completed") return { goal: { ...goal, status: "stopped", reason: run.reason }, send: null };
	if (goal.revised) return { goal: { ...goal, status: "active", revised: false, idle: 0, reason: "", rounds: goal.rounds + 1 }, send: goal.text + GOAL_NOTE };
	const verdict = goalVerdict(run.reply);
	if (verdict.kind === "blocked") return { goal: { ...goal, status: "blocked", reason: verdict.reason }, send: null };
	if (verdict.kind === "met") {
		if (goal.status === "verifying") return { goal: { ...goal, status: "met" }, send: null };
		return { goal: { ...goal, status: "verifying", rounds: goal.rounds + 1 }, send: GOAL_VERIFY };
	}
	const idle = run.acted ? 0 : (goal.idle ?? 0) + 1;
	if (idle >= IDLE_ROUNDS) return { goal: { ...goal, status: "blocked", idle, reason: `连续 ${idle} 轮没有动作，停下来等你` }, send: null };
	return { goal: { ...goal, status: "active", rounds: goal.rounds + 1, idle }, send: GOAL_CONTINUE };
}
