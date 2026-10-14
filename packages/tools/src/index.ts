import { createCommandTool } from "./command.ts";
import { createEditTool, createReadTool, createWriteTool, DEFAULT_READ_LIMITS, type ReadLimits } from "./files.ts";
import { createPlanTool } from "./plan.ts";
import { createExpandTool } from "./recall.ts";
import type { ToolDefinition } from "./types.ts";

export * from "./command.ts";
export * from "./files.ts";
export * from "./edit-feedback.ts";
export * from "./outline.ts";
export * from "./plan.ts";
export * from "./recall.ts";
export * from "./types.ts";
export * from "./workspace.ts";
export * from "./session-index.ts";
export * from "./session-search.ts";
export * from "./task-note.ts";
export * from "./skills.ts";

/** Tool options. The tool list itself is fixed for a session (tool definitions are part of the stable prefix). */
export interface ToolOptions {
	read?: Partial<ReadLimits>;
	batchEdit?: boolean;
	/** A bounded source snapshot around successfully applied edits. */
	editFeedback?: boolean;
	/** file_edit (including batch edits) and file_write need approval before they write. */
	approveFileWrites?: boolean;
	/** Tool receipts leave out hashes and audit refs (they stay in details and the archive). */
	leanOutput?: boolean;
}

/** Effective options are explicit so the engine records the actual tool surface. */
export function normalizeToolOptions(options: ToolOptions = {}): ToolOptions {
	if (options.editFeedback !== undefined && typeof options.editFeedback !== "boolean") throw new Error("editFeedback 必须为布尔值");
	return {
		read: { ...DEFAULT_READ_LIMITS, ...options.read, dedupe: true, dedupeRanges: true },
		leanOutput: true,
		batchEdit: options.batchEdit ?? true, editFeedback: options.editFeedback ?? false, approveFileWrites: options.approveFileWrites === true,
	};
}

/** The tools: query_plan, file_read, file_edit, file_write, command_run and context_expand (the engine adds session_search and task_note). */
export function generalTools(given: ToolOptions = {}): ToolDefinition[] {
	const options = normalizeToolOptions(given);
	const read = { ...DEFAULT_READ_LIMITS, ...options.read };
	const recovery = { contextExpand: true, lean: true, queryPlan: true };
	return [
		createPlanTool({ read, lean: true }),
		createReadTool(read, recovery),
		createEditTool({ batch: options.batchEdit ?? false, lean: true, approveFileWrites: options.approveFileWrites === true, feedback: options.editFeedback === true }),
		createWriteTool({ lean: true, approveFileWrites: options.approveFileWrites === true }),
		createCommandTool(undefined, recovery),
		createExpandTool(),
	];
}
