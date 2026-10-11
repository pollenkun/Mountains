import type { ToolDefinition, ToolResult } from "./types.ts";

/** Bounds keep one note well under the space a fold frees; the host never folds a note. */
export const TASK_NOTE_LIMITS = Object.freeze({ items: 12, itemChars: 400, nextChars: 600 });

const FIELDS = ["requirements", "facts", "ruledOut"] as const;

function fail(message: string): ToolResult {
	return { ok: false, modelContent: `Task note rejected: ${message}`, summary: "工作笔记被拒绝", details: { error: message } };
}

/**
 * Working note: the model can record its state before older context folds. The note is the model's own claim, never proof of a passing check.
 */
export function createTaskNoteTool(): ToolDefinition {
	const list = (what: string) => ({ type: "array", maxItems: TASK_NOTE_LIMITS.items, items: { type: "string", minLength: 1, maxLength: TASK_NOTE_LIMITS.itemChars }, description: what });
	return {
		name: "task_note", logicalName: "task.note", readOnly: true,
		description: "Record your working state when a runtime notice asks, before older context folds. The note stays in context verbatim; it is your own record, not proof that checks passed.",
		parameters: {
			type: "object", additionalProperties: false,
			properties: {
				requirements: list("Every task requirement and user correction still in force"),
				facts: list("Facts confirmed by code or observations, with file paths"),
				ruledOut: list("Directions already ruled out, with the reason"),
				next: { type: "string", minLength: 1, maxLength: TASK_NOTE_LIMITS.nextChars, description: "Your next step" },
			},
			required: ["requirements", "next"],
		},
		async execute(args) {
			const keys = Object.keys(args);
			const unknown = keys.filter(k => !["requirements", "facts", "ruledOut", "next"].includes(k));
			if (unknown.length) return fail(`unknown fields ${unknown.join(", ")}`);
			const note: Record<string, string[]> = {};
			for (const field of FIELDS) {
				const value = args[field];
				if (value === undefined && field !== "requirements") { note[field] = []; continue; }
				if (!Array.isArray(value) || value.length > TASK_NOTE_LIMITS.items || value.some(v => typeof v !== "string" || v.length === 0 || v.length > TASK_NOTE_LIMITS.itemChars)) {
					return fail(`${field} must be a list of at most ${TASK_NOTE_LIMITS.items} non-empty strings of at most ${TASK_NOTE_LIMITS.itemChars} characters`);
				}
				note[field] = value as string[];
			}
			const next = args.next;
			if (typeof next !== "string" || next.length === 0 || next.length > TASK_NOTE_LIMITS.nextChars) return fail(`next must be a non-empty string of at most ${TASK_NOTE_LIMITS.nextChars} characters`);
			// The arguments already hold the note in the assistant message; the result only confirms it.
			return { ok: true, modelContent: "Task note recorded.", summary: "已记录工作笔记", details: { note: { ...note, next } } };
		},
	};
}
