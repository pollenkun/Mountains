import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ContextBuilder, SKILL_NOTICE, toolTarget, type ContextHistoryItemV1, type ContextPolicy, type FoldReason, type ToolResultMeta } from "../src/index.ts";

const policy: ContextPolicy = { triggerTokens: 1, hardLimitTokens: 10_000_000, compactTokens: 9_000_000, compactTailTokens: 100, minBatchTokens: 0 };
const builder = () => new ContextBuilder({ system: "fixture", tools: [{ name: "context_expand", description: "restore", parameters: {} }], expandTool: "context_expand", publicationGuard: {
	verifyReference: () => true,
	archiveInteraction: content => {
		const hash = createHash("sha256").update(content).digest("hex");
		return `blob_v2_${hash}_${"0".repeat(32)}_raw_${hash}`;
	},
} });
const finish = (b: ContextBuilder) => b.appendAssistant({ role: "assistant", content: "done", reasoning: "", toolCalls: [] });
function append(b: ContextBuilder, id: string, name: string, argumentsJson: string, meta: Partial<ToolResultMeta> = {}): void {
	b.appendAssistant({ role: "assistant", content: "", reasoning: "", toolCalls: [{ id, name, argumentsJson }] });
	b.appendToolResult(id, name, "output", { kind: name === "file_read" ? "file_content" : "tool_output", ref: `shown_${id}`, target: id, ...meta });
}

// Compare selection directly so small fixtures need not meet the archive-size savings threshold.
const candidates = (b: ContextBuilder, cfg = policy): Map<number, FoldReason> =>
	(b as unknown as { losslessCandidates: (cfg: ContextPolicy) => Map<number, FoldReason> }).losslessCandidates(cfg);
function selected(b: ContextBuilder, cfg = policy): [string, FoldReason][] {
	const messages = b.plan().messages;
	return [...candidates(b, cfg)].map(([index, reason]) => {
		const message = messages[index]!;
		assert.equal(message.role, "tool");
		return [message.role === "tool" ? message.toolCallId : "", reason];
	});
}

test("public lossless checks serialize each call's arguments once, including repeated no-op checks", t => {
	const stringify = JSON.stringify;
	let serializations = 0;
	t.mock.method(JSON, "stringify", (value: unknown, ...args: unknown[]) => {
		if (value && typeof value === "object" && "argv" in value) serializations++;
		return Reflect.apply(stringify, JSON, [value, ...args]);
	});
	for (const count of [128, 1024]) {
		const b = builder();
		b.appendUser("independent commands");
		for (let i = 0; i < count; i++) append(b, `c${i}`, "command_run", stringify({ argv: ["git", "show", `ref-${i}`] }));
		finish(b);
		const before = b.plan();
		for (let attempt = 0; attempt < 2; attempt++) {
			serializations = 0;
			assert.equal(b.losslessRevision(policy, 0, before.totalTokensEst, true), null);
			assert.equal(serializations, count);
		}
		assert.deepEqual(b.plan(), before);
	}
});

test("disjoint reads on one path do not scan every later range", () => {
	const b = builder(), count = 1024;
	let rangeAccesses = 0;
	b.appendUser("independent ranges");
	for (let i = 0; i < count; i++) {
		append(b, `r${i}`, "file_read", JSON.stringify({ path: "same.txt", startLine: i + 1 }), { lines: {
			get start() { rangeAccesses++; return i + 1; },
			get end() { rangeAccesses++; return i + 1; },
		} });
	}
	finish(b);
	const before = b.plan();
	rangeAccesses = 0;
	assert.equal(b.losslessRevision(policy, 0, before.totalTokensEst, true), null);
	assert.ok(rangeAccesses <= count * 40, `range field accesses must stay bounded: ${rangeAccesses}`);
	assert.deepEqual(b.plan(), before);
});

test("candidate reasons and ordering preserve argument, target, range and success semantics", () => {
	const b = builder();
	b.appendUser("first request");
	append(b, "retry", "command_run", '{"argv":["make"],"cwd":"old"}', { preserve: "error" });
	append(b, "elsewhere", "command_run", '{"argv":["lint"],"cwd":"a"}', { preserve: "error" });
	append(b, "same", "command_run", '{ "argv" : ["test"], "cwd" : "x" }');
	append(b, "different-order", "command_run", '{"cwd":"x","argv":["test"]}');
	append(b, "union", "file_read", '{"path":"union"}', { lines: { start: 1, end: 10 } });
	append(b, "covered", "file_read", '{"path":"covered"}', { lines: { start: 3, end: 8 } });
	append(b, "edited", "file_read", '{"path":"edited"}');
	append(b, "failed-edit", "file_read", '{"path":"failed"}');
	append(b, "missing-lines", "file_read", '{"path":"missing"}');
	append(b, "empty-range", "file_read", '{"path":"empty"}', { lines: { start: 3, end: 2 } });
	append(b, "unresolved", "command_run", '{"argv":["test"],"cwd":"x"}', { preserve: "unresolved" });
	append(b, "invalidated", "command_run", '{"argv":["test"],"cwd":"x"}', { preserve: "memory-invalidation" });
	append(b, "task-note", "task_note", '{"note":"keep"}');
	append(b, "retry-success", "command_run", '{"argv":["make"],"cwd":"old"}');
	// The same command succeeding in another directory says nothing about the failure (review B11).
	append(b, "elsewhere-success", "command_run", '{"argv":["lint"],"cwd":"b"}');
	append(b, "same-success", "command_run", '{"argv":["test"],"cwd":"x"}');
	append(b, "left", "file_read", '{"path":"union"}', { lines: { start: 1, end: 5 } });
	append(b, "right", "file_read", '{"path":"union"}', { lines: { start: 6, end: 10 } });
	append(b, "cover-success", "file_read", '{"path":"covered"}', { lines: { start: 1, end: 8 }, preserve: "unresolved" });
	append(b, "edit-success", "file_write", '{"path":"edited"}');
	append(b, "edit-error", "file_edit", '{"path":"failed"}', { preserve: "error" });
	append(b, "missing-success", "file_read", '{"path":"missing"}', { lines: { start: 1, end: 20 } });
	append(b, "empty-success", "file_read", '{"path":"empty"}', { lines: { start: 2, end: 2 } });
	append(b, "note-again", "task_note", '{"note":"keep"}');
	append(b, "unseen-original", "command_run", '{"argv":["unseen"]}');
	append(b, "unseen-success", "command_run", '{"argv":["unseen"]}');
	assert.deepEqual(selected(b), [["retry", "retried"], ["same", "repeated"], ["covered", "superseded"], ["edited", "superseded"], ["empty-range", "superseded"], ["unseen-original", "repeated"]]);
	finish(b);
	b.appendUser("second request");
	b.appendUser("third request");
	const settled = selected(b);
	assert.equal(settled.find(([id]) => id === "retry")?.[1], "retried", "specific reasons take precedence over settled");
	assert.equal(settled.find(([id]) => id === "union")?.[1], "settled");
	assert.equal(settled.find(([id]) => id === "edit-error")?.[1], "settled");
	assert.ok(!settled.some(([id]) => id === "unresolved" || id === "invalidated"));
});

/** Deliberately simple suffix-scan reference for small deterministic fixtures. */
function reference(history: ContextHistoryItemV1[], cfg: ContextPolicy): Map<number, FoldReason> {
	const calls = new Map<string, { name: string; args: Record<string, unknown>; target: string }>();
	let unseen = history.length;
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i]!.message;
		if (message.role === "assistant") { if (message.toolCalls.length) unseen = i; break; }
	}
	const users = history.flatMap((item, index) => item.message.role === "user" && !item.message.content.startsWith("[Runtime ") && !item.message.content.startsWith("[Context checkpoint generated by the program") && !item.message.content.startsWith("[Skill loaded at the user's request") ? [index] : []);
	const keep = cfg.settledUserTurns ?? 2;
	const settled = keep >= 1 && Number.isInteger(keep) ? users.at(-keep) ?? -1 : -1;
	for (const item of history) {
		if (item.message.role !== "assistant") continue;
		for (const call of item.message.toolCalls) {
			let args: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(call.argumentsJson);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
			} catch { /* Invalid argument JSON uses an empty object. */ }
			const target = toolTarget(call.name, call.argumentsJson);
			calls.set(call.id, { name: call.name, args, target: call.name === "command_run" ? JSON.stringify([args.cwd ?? ".", args.argv ?? args.command ?? args.shellScript ?? null, args.env ?? null])
				: target === call.name ? `${call.name}:${JSON.stringify(args)}` : target });
		}
	}
	const results = history.flatMap((h, i) => {
		const call = h.message.role === "tool" ? calls.get(h.message.toolCallId) : undefined;
		return call && h.meta ? [{ h, i, call, meta: h.meta }] : [];
	});
	const out = new Map<number, FoldReason>();
	results.forEach(({ h, i, call, meta }, k) => {
		if (i >= unseen || h.maskedContent !== undefined || meta.preserve === "unresolved" || meta.preserve === "memory-invalidation") return;
		const later = results.slice(k + 1).filter(result => result.meta.preserve !== "error");
		if (meta.preserve === "error") {
			if (later.some(result => result.call.name === call.name && result.call.target === call.target)) out.set(i, "retried");
		} else if (call.name === "file_read" && typeof call.args.path === "string") {
			if (later.some(result => (result.call.name === "file_edit" || result.call.name === "file_write") && result.call.args.path === call.args.path) || meta.lines !== undefined && later.some(result => result.call.name === "file_read" && result.call.args.path === call.args.path && result.meta.lines !== undefined && result.meta.lines.start <= meta.lines!.start && result.meta.lines.end >= meta.lines!.end)) out.set(i, "superseded");
		} else if (call.name !== "file_edit" && call.name !== "file_write" && call.name !== "task_note") {
			if (later.some(result => result.call.name === call.name && JSON.stringify(result.call.args) === JSON.stringify(call.args))) out.set(i, "repeated");
		}
		if (!out.has(i) && settled >= 0 && i < settled) out.set(i, "settled");
	});
	return out;
}

test("indexed selection matches suffix semantics across mixed histories and restored snapshots", () => {
	let seed = 42;
	const random = (maximum: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
	const names = ["file_read", "file_edit", "file_write", "command_run", "task_note", "content_search"];
	const argumentsJson = ['{"path":"a"}', '{"path":"b"}', '{"path":"a","startLine":2}', '{ "path" : "a" }', '{"argv":["make"],"cwd":"a"}', '{"cwd":"a","argv":["make"]}', "null", "[]", "{invalid"];
	const preserves = [undefined, undefined, undefined, "error", "unresolved", "memory-invalidation"] as const;
	for (let fixture = 0; fixture < 40; fixture++) {
		const b = builder();
		b.appendUser("first request");
		for (let i = 0; i < 80; i++) {
			if (random(10) === 0) b.appendUser(`request ${i}`);
			if (random(10) === 0) b.appendRuntimeNotice(`notice ${i}`);
			const meta: Partial<ToolResultMeta> = {};
			const preserve = preserves[random(preserves.length)];
			if (preserve) meta.preserve = preserve;
			if (random(3)) { const start = random(8) + 1; meta.lines = { start, end: start + random(8) - 1 }; }
			append(b, `f${fixture}_${i}`, names[random(names.length)]!, argumentsJson[random(argumentsJson.length)]!, meta);
		}
		if (random(2)) finish(b);
		const state = b.exportState();
		const restored = builder();
		restored.restoreState(state);
		for (const settledUserTurns of [0, 1, 2, 4, 100]) {
			const cfg = { ...policy, settledUserTurns };
			const expected = [...reference(state.history, cfg)];
			assert.deepEqual([...candidates(b, cfg)], expected, `fixture ${fixture}, keep ${settledUserTurns}`);
			assert.deepEqual([...candidates(restored, cfg)], expected, `restored fixture ${fixture}, keep ${settledUserTurns}`);
		}
	}
});

test("a tool with nothing to name its target folds a failure only after the same call succeeds", () => {
	const b = builder();
	b.appendUser("request");
	append(b, "click-failed", "computer_act", '{"action":"click","id":"e12"}', { preserve: "error" });
	append(b, "other-click", "computer_act", '{"action":"click","id":"e40"}');
	append(b, "search-failed", "session_search", '{"needle":"missing"}', { preserve: "error" });
	append(b, "same-search", "session_search", '{"needle":"missing"}');
	append(b, "last", "file_read", '{"path":"later.md"}');
	finish(b);
	const reasons = new Map(selected(b));
	assert.equal(reasons.get("click-failed"), undefined, "a different click succeeding does not make the failed click a retry");
	assert.equal(reasons.get("search-failed"), "retried", "the same call succeeding is a retry");
});

test("B12: a skill notice is not a user turn, so it does not settle the previous request's evidence", () => {
	const b = builder();
	b.appendUser("first request");
	append(b, "read-1", "file_read", '{"path":"notes.md"}', { lines: { start: 1, end: 5 } });
	finish(b);
	b.appendUser(`${SKILL_NOTICE}changelog skill text`);
	const settledOne = { ...policy, settledUserTurns: 1 };
	assert.ok(!selected(b, settledOne).some(([id]) => id === "read-1"), "only real user requests count as turns");
	b.appendUser("second real request");
	assert.deepEqual(selected(b, settledOne).find(([id]) => id === "read-1")?.[1], "settled", "a real later request still settles it");
});
