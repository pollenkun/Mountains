import type { ReadRecord } from "./types.ts";
import { sha256, ToolError } from "./workspace.ts";

/** An opt-in source preview, not test execution or a fresh filesystem read. */
export const EDIT_FEEDBACK_LIMITS = Object.freeze({ contextLines: 12, maxOutputBytes: 8 * 1024 });
export interface EditFeedbackSpan { start: number; end: number; text: string; }
interface LineRange { startLine: number; endLine: number; }
export interface EditFeedback {
	modelContent: string;
	reads: ReadRecord[];
	details: { contextLines: number; maxOutputBytes: number; outputBytes: number; sourceHash: string; requestedRanges: LineRange[]; omittedRanges: LineRange[]; truncated: boolean };
}

const newlineCount = (text: string) => text.split("\n").length - 1;

/** Both the tool and offline replay use this exact byte-bounded format. */
export function buildEditFeedback(options: {
	path: string; original: string; updated: string; spans: readonly EditFeedbackSpan[]; receipt: string;
}): EditFeedback {
	const { path, original, updated, spans, receipt } = options;
	const lines = updated.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	const total = lines.length, hash = sha256(updated);
	const requested: LineRange[] = [];
	let originalCursor = 0, currentLine = 1;
	for (const span of spans) {
		if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < originalCursor || span.end < span.start || span.end > original.length) throw new ToolError("Invalid edit feedback span");
		currentLine += newlineCount(original.slice(originalCursor, span.start));
		const insertedNewlines = newlineCount(span.text);
		if (total) {
			const first = Math.min(currentLine, total);
			const last = Math.min(total, Math.max(first, currentLine + insertedNewlines - (span.text.endsWith("\n") ? 1 : 0)));
			const range = { startLine: Math.max(1, first - EDIT_FEEDBACK_LIMITS.contextLines), endLine: Math.min(total, last + EDIT_FEEDBACK_LIMITS.contextLines) };
			const prior = requested.at(-1);
			if (prior && range.startLine <= prior.endLine + 1) prior.endLine = Math.max(prior.endLine, range.endLine);
			else requested.push(range);
		}
		currentLine += insertedNewlines;
		originalCursor = span.end;
	}
	const prefix = `${receipt}\n[Source snapshot written by this edit; sha256:${hash}; context +/-${EDIT_FEEDBACK_LIMITS.contextLines} lines]`;
	const footerReserve = 192;
	let bytes = Buffer.byteLength(prefix);
	if (bytes > EDIT_FEEDBACK_LIMITS.maxOutputBytes - footerReserve) throw new ToolError("Edit feedback receipt exceeds its output limit");
	const output = [prefix], reads: ReadRecord[] = [], omitted: LineRange[] = [];
	for (const range of requested) {
		const rows: string[] = [];
		let end = range.startLine - 1, rowBytes = 0;
		const headerReserve = Buffer.byteLength(`\n${path} | lines ${range.startLine}-${range.endLine} of ${total}\n`);
		for (let line = range.startLine; line <= range.endLine; line++) {
			const row = `${line}\t${lines[line - 1]!}`;
			const nextBytes = Buffer.byteLength(row) + 1;
			if (bytes + headerReserve + rowBytes + nextBytes + footerReserve > EDIT_FEEDBACK_LIMITS.maxOutputBytes) break;
			rows.push(row); rowBytes += nextBytes; end = line;
		}
		if (rows.length) {
			const block = `${path} | lines ${range.startLine}-${end} of ${total}\n${rows.join("\n")}`;
			output.push(block); bytes += Buffer.byteLength(block) + 1;
			reads.push({ path, startLine: range.startLine, endLine: end, totalLines: total, hash });
		}
		if (end < range.endLine) omitted.push({ startLine: end + 1, endLine: range.endLine });
	}
	if (!total) output.push("The written file is empty.");
	if (omitted.length) {
		const count = omitted.reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0);
		output.push(`Preview incomplete: ${count} source lines omitted by the byte limit. Use file_read for complete ranges.`);
	}
	const modelContent = output.join("\n");
	const outputBytes = Buffer.byteLength(modelContent);
	if (outputBytes > EDIT_FEEDBACK_LIMITS.maxOutputBytes) throw new ToolError("Edit feedback exceeds its output limit");
	return { modelContent, reads, details: { contextLines: EDIT_FEEDBACK_LIMITS.contextLines, maxOutputBytes: EDIT_FEEDBACK_LIMITS.maxOutputBytes,
		outputBytes, sourceHash: hash, requestedRanges: requested, omittedRanges: omitted, truncated: omitted.length > 0 } };
}
