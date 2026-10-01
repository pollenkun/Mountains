import { createVerifiedLog, searchVerifiedLog, type BoundedSearchResult, type SearchQuery } from "./bounded-log-search.ts";
import type { ToolDefinition, ToolResult } from "./types.ts";

export const ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const ARCHIVE_SEARCH_DEFAULT_SCAN_BYTES = 1024 * 1024;
export const ARCHIVE_SEARCH_MAX_SCAN_BYTES = ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES;
export const ARCHIVE_SEARCH_DEFAULT_OUTPUT_BYTES = 8192;
export const ARCHIVE_SEARCH_MAX_OUTPUT_BYTES = 12_000;
export const ARCHIVE_SEARCH_MIN_OUTPUT_BYTES = 64;
export const ARCHIVE_SEARCH_DEFAULT_MATCHES = 20;
export const ARCHIVE_SEARCH_MAX_MATCHES = 100;
export const ARCHIVE_SEARCH_DEFAULT_LINE_BYTES = 1024;
export const ARCHIVE_SEARCH_MAX_LINE_BYTES = 4096;
export const ARCHIVE_SEARCH_MAX_NEEDLE_BYTES = 4096;

const allowed = new Set(["ref", "toolCallId", "needle", "caseMode", "maxScanBytes", "maxMatches", "maxLineBytes", "maxOutputBytes"]);

function finish(value: BoundedSearchResult): ToolResult {
	const modelContent = JSON.stringify(value);
	return {
		ok: value.ok,
		// No prefix/suffix may be added: search has bounded the complete JSON.
		modelContent,
		summary: value.ok ? `找到 ${value.returnedMatches} 条归档原文` : "归档查找失败",
		details: { ...value, outputBytes: Buffer.byteLength(modelContent, "utf8") },
	};
}

function fail(error: string): ToolResult {
	// Fixed codes are all shorter than the smallest supported 64-byte response.
	return finish({ ok: false, error });
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
	const selected = value === undefined ? fallback : value;
	return typeof selected === "number" && Number.isSafeInteger(selected) && selected >= minimum && selected <= maximum ? selected : null;
}

/** Literal search of host-authorized command archives, never current files. */
export function createArchiveSearchTool(): ToolDefinition {
	return {
		name: "context_search",
		logicalName: "context.search",
		readOnly: true,
		description:
			"Find a single-line literal in an immutable command fullOutputRef, bound to its original toolCallId. " +
			"No regex, current-file reading, command rerun or summary. Returns first match per line with original byte ranges. " +
			"Use context_expand for surrounding bytes. ASCII case folding is optional; other Unicode stays exact. " +
			"Partial scans/omitted matches/truncated lines are explicit. Command state comes from the host; exit zero is not proof a suite passed. " +
			`Archive read limit ${ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES} bytes; scan default ${ARCHIVE_SEARCH_DEFAULT_SCAN_BYTES}. ` +
			`Complete JSON output defaults to ${ARCHIVE_SEARCH_DEFAULT_OUTPUT_BYTES} bytes, valid ${ARCHIVE_SEARCH_MIN_OUTPUT_BYTES}..${ARCHIVE_SEARCH_MAX_OUTPUT_BYTES}.`,
		parameters: {
			type: "object",
			properties: {
				ref: { type: "string", description: "Exact raw command fullOutputRef; no file path" },
				toolCallId: { type: "string", description: "Original command call ID associated with this ref" },
				needle: { type: "string", minLength: 1, description: `Single-line literal UTF-8 text, at most ${ARCHIVE_SEARCH_MAX_NEEDLE_BYTES} bytes; never a regex` },
				caseMode: { type: "string", enum: ["exact", "ascii-insensitive"], description: "Defaults to exact; only ASCII A-Z folds in ascii-insensitive mode" },
				maxScanBytes: { type: "integer", minimum: 0, maximum: ARCHIVE_SEARCH_MAX_SCAN_BYTES, description: `Search prefix size, default ${ARCHIVE_SEARCH_DEFAULT_SCAN_BYTES}; does not limit complete archive validation` },
				maxMatches: { type: "integer", minimum: 1, maximum: ARCHIVE_SEARCH_MAX_MATCHES, description: `Returned matching lines, default ${ARCHIVE_SEARCH_DEFAULT_MATCHES}` },
				maxLineBytes: { type: "integer", minimum: 1, maximum: ARCHIVE_SEARCH_MAX_LINE_BYTES, description: `Original bytes in each preview, default ${ARCHIVE_SEARCH_DEFAULT_LINE_BYTES}; must fit needle` },
				maxOutputBytes: { type: "integer", minimum: ARCHIVE_SEARCH_MIN_OUTPUT_BYTES, maximum: ARCHIVE_SEARCH_MAX_OUTPUT_BYTES, description: "Maximum complete JSON response bytes including metadata and escaped/base64 text" },
			},
			required: ["ref", "toolCallId", "needle"],
			additionalProperties: false,
		},
		async execute(args, ctx) {
			try {
				// Validate every model-controlled query field before touching storage.
				if (Object.keys(args).some((key) => !allowed.has(key))) return fail("INVALID_ARGUMENTS");
				const { ref, toolCallId, needle } = args;
				if (typeof ref !== "string" || !ref || ref.length > 256 || ref.trim() !== ref) return fail("INVALID_ARGUMENTS");
				if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 256 || toolCallId.trim() !== toolCallId) return fail("INVALID_ARGUMENTS");
				if (typeof needle !== "string" || !needle || needle.includes("\n") || needle.includes("\r")) return fail("INVALID_LITERAL");
				const literal = Buffer.from(needle, "utf8");
				if (literal.length > ARCHIVE_SEARCH_MAX_NEEDLE_BYTES || literal.toString("utf8") !== needle) return fail("INVALID_LITERAL");
				const caseMode = args.caseMode === undefined ? "exact" : args.caseMode;
				if (caseMode !== "exact" && caseMode !== "ascii-insensitive") return fail("INVALID_CASE_MODE");
				const maxScanBytes = boundedInteger(args.maxScanBytes, ARCHIVE_SEARCH_DEFAULT_SCAN_BYTES, 0, ARCHIVE_SEARCH_MAX_SCAN_BYTES);
				const maxMatches = boundedInteger(args.maxMatches, ARCHIVE_SEARCH_DEFAULT_MATCHES, 1, ARCHIVE_SEARCH_MAX_MATCHES);
				const maxLineBytes = boundedInteger(args.maxLineBytes, ARCHIVE_SEARCH_DEFAULT_LINE_BYTES, literal.length, ARCHIVE_SEARCH_MAX_LINE_BYTES);
				const maxOutputBytes = boundedInteger(args.maxOutputBytes, ARCHIVE_SEARCH_DEFAULT_OUTPUT_BYTES, ARCHIVE_SEARCH_MIN_OUTPUT_BYTES, ARCHIVE_SEARCH_MAX_OUTPUT_BYTES);
				if (maxScanBytes === null || maxMatches === null || maxLineBytes === null || maxOutputBytes === null) return fail("INVALID_LIMIT");
				const query: SearchQuery = { needle, caseMode, maxScanBytes, maxMatches, maxLineBytes, maxOutputBytes };
				if (ctx.signal.aborted) return fail("CANCELLED");
				if (!ctx.blobs?.matchesWorkspace(ctx.workspace.root)) return fail("ARCHIVE_UNAVAILABLE");
				if (ctx.signal.aborted) return fail("CANCELLED");
				const archive = ctx.blobs.inspectCommand(ref, toolCallId, { maxArchiveBytes: ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES });
				if (ctx.signal.aborted) return fail("CANCELLED");
				if (!archive) return fail("ARCHIVE_UNAVAILABLE");
				const handle = createVerifiedLog(archive.bytes, {
					ref, authorized: true, expectedSha256: archive.hash, expectedBytes: archive.totalBytes,
					commandState: archive.commandState,
				}, { maxArchiveBytes: ARCHIVE_SEARCH_MAX_ARCHIVE_BYTES, maxOutputBytes });
				if (!("type" in handle)) return fail("ARCHIVE_UNAVAILABLE");
				const result = searchVerifiedLog(handle, query);
				if (ctx.signal.aborted) return fail("CANCELLED");
				return finish(result);
			} catch {
				// Storage errors must not disclose the path, source content or stack.
				return fail("ARCHIVE_UNAVAILABLE");
			}
		},
	};
}
