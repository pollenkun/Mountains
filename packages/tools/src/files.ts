import { waitForApproval } from "./approval-wait.ts";
import { isUtf8 } from "node:buffer";
import { readRegularFile } from "./regular-file.ts";
import { truncateUtf16 } from "./text.ts";
import { outlineLines } from "./outline.ts";
import { buildEditFeedback } from "./edit-feedback.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.ts";
import { sha256, ToolError } from "./workspace.ts";

export interface ReadLimits {
	defaultLines: number;
	maxLines: number;
	maxLineChars: number;
	/** 同一文件同一版本的同一行范围已发送过时，只返回简短说明（可用 force 强制重读） */
	dedupe?: boolean;
	/** With dedupe: partial overlap sends only unseen source ranges when that is shorter. Default off. */
	dedupeRanges?: boolean;
	/**
	 * 行号格式：all（默认）每行都带行号；sparse 只在首行和行号为 10 的倍数的行带行号，其余行原样输出。
	 * sparse 可减少行号的输入开销。编辑按原文匹配，不依赖行号。
	 */
	lineNumbers?: "all" | "sparse";
	/** 可选配置：允许用 symbol（函数或类名，可写 Class.method）代替行范围，只返回这一个定义 */
	symbols?: boolean;
	/**
	 * 可选配置：不带行范围（也不带 symbol）读一个超过这么多行的源文件时，先返回它的定义大纲（类、函数及行号），
	 * 由模型再按行范围或 symbol 精确读取。0 或不设为关闭；认不出定义的文件类型照常返回开头几行。
	 */
	outlineFirst?: number;
	/**
	 * 可选配置：用 symbol 读一个超过这么多行的类时，默认只返回类的结构（方法及行号），
	 * 由模型再用 symbol=Class.method 或行范围读需要的部分。0 或不设为关闭。方法、函数照常完整返回。
	 */
	classOutlineOver?: number;
}

const OUTLINE_MAX = 120;

function indentOf(line: string): number {
	return (/^[ \t]*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
}

const PY_DEF_RE = /^[ \t]*(?:async\s+)?(def|class)\s+([_\p{ID_Start}][_\p{ID_Continue}]*)/u;
interface PythonSymbolRange { start: number; end: number; declaration: number; kind: "def" | "class" }

/**
 * Python 逻辑行：starts[i] 为 true 表示第 i 行开始一个新的逻辑行。
 * 块边界扫描结合短字符串反斜杠续行状态；不是完整的 Python 解析器。
 * 无法确认字符串/括号闭合时拒绝按名字读取，调用者可改用行范围。
 */
export function pythonLogicalStarts(lines: string[]): boolean[] {
	const starts: boolean[] = [];
	let depth = 0;
	let triple: string | null = null;
	let formattedTriple = false;
	let quote: string | null = null;
	let cont = false;
	for (const line of lines) {
		starts.push(depth === 0 && triple === null && quote === null && !cont);
		cont = false;
		for (let i = 0; i < line.length; ) {
			const ch = line[i] ?? "";
			if (triple !== null) {
				// 插值表达式可能复用外层引号，轻量扫描无法可靠区分。双花括号是字面量。
				if (formattedTriple && (ch === "{" || ch === "}")) {
					if (line[i + 1] !== ch) throw new ToolError("格式化三引号字符串包含插值，symbol 暂不支持，请用 startLine/endLine 读取");
					i += 2;
					continue;
				}
				// f-string 中反斜杠不能转义花括号，必须留给上面的插值检查。
				if (ch === "\\") i += formattedTriple && (line[i + 1] === "{" || line[i + 1] === "}") ? 1 : 2;
				else if (line.startsWith(triple, i)) {
					triple = null;
					formattedTriple = false;
					i += 3;
				} else i++;
				continue;
			}
			if (quote !== null) {
				if (ch === "\\") {
					if (i === line.length - 1) cont = true;
					i += 2;
				} else {
					if (ch === quote) quote = null;
					i++;
				}
				continue;
			}
			if (ch === "#") break;
			if (line.startsWith('"""', i) || line.startsWith("\'\'\'", i)) {
				triple = line.slice(i, i + 3);
				formattedTriple = /(?:^|[^\w])(?:f|fr|rf)$/i.test(line.slice(0, i));
				i += 3;
				continue;
			}
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
			else if (ch === "\\" && i === line.length - 1) cont = true;
			i++;
		}
		if (quote !== null && !cont) throw new ToolError("无法确认 Python 字符串范围，请用 startLine/endLine 读取");
	}
	if (quote !== null || triple !== null || depth !== 0 || cont) throw new ToolError("无法确认 Python 逻辑行范围，请用 startLine/endLine 读取");
	return starts;
}

/**
 * 按名字找 Python 定义：返回每个匹配定义的行范围（1 起，含装饰器，多行装饰器与多行签名也算）。
 * symbol 可写成 Outer.Inner.name，此时要求匹配完整的父定义后缀。
 * 块在第一个缩进不大于定义行的逻辑行之前结束；括号内和字符串内的续行不论缩进都属于当前块。
 */
function findPythonSymbols(lines: string[], symbol: string): PythonSymbolRange[] {
	const parts = symbol.split(".").filter(Boolean);
	const name = parts[parts.length - 1];
	const parents = parts.slice(0, -1);
	if (!name) return [];
	const starts = pythonLogicalStarts(lines);
	const at = (k: number) => lines[k] ?? "";
	const blankOrComment = (l: string) => l.trim() === "" || /^[ \t]*#/.test(l);
	const out: PythonSymbolRange[] = [];
	lines.forEach((line, i) => {
		const declaration = PY_DEF_RE.exec(line);
		if (!starts[i] || declaration?.[2] !== name) return;
		const ind = indentOf(line);
		if (parents.length > 0) {
			let cur = ind;
			const ancestors: string[] = [];
			for (let j = i - 1; j >= 0 && cur > 0; j--) {
				if (!starts[j] || blankOrComment(at(j)) || indentOf(at(j)) >= cur) continue;
				const m = PY_DEF_RE.exec(at(j));
				if (m?.[2]) ancestors.unshift(m[2]);
				cur = indentOf(at(j));
			}
			if (parents.length > ancestors.length || parents.some((p, k) => p !== ancestors[ancestors.length - parents.length + k])) return;
		}
		// 装饰器：向上逐个逻辑行（跳过续行、空行与注释），同缩进的 @ 行都属于这个定义
		let start = i;
		for (let j = i - 1; j >= 0; ) {
			let k = j;
			while (k >= 0 && (!starts[k] || blankOrComment(at(k)))) k--;
			if (k < 0 || !/^[ \t]*@/.test(at(k)) || indentOf(at(k)) !== ind) break;
			start = k;
			j = k - 1;
		}
		let end = i;
		for (let k = i + 1; k < lines.length; k++) {
			const l = at(k);
			if (!starts[k]) {
				if (l.trim() !== "") end = k;
				continue;
			}
			if (l.trim() === "") continue;
			if (indentOf(l) <= ind) {
				if (/^[ \t]*#/.test(l)) continue;
				break;
			}
			end = k;
		}
		out.push({ start: start + 1, end: end + 1, declaration: i + 1, kind: declaration[1] as "def" | "class" });
	});
	return out;
}

export function findSymbol(lines: string[], symbol: string): { start: number; end: number }[] {
	return findPythonSymbols(lines, symbol).map(({ start, end }) => ({ start, end }));
}

/** Keep ordinary read responses below the session archive's 8 MiB record ceiling. */
export const MAX_READ_OUTPUT_BYTES = 1024 * 1024;

export const DEFAULT_READ_LIMITS: ReadLimits = { defaultLines: 2000, maxLines: 2000, maxLineChars: 2000, dedupe: false };

/** Shared production formatter, also usable by offline trace replay. Old history is never edited. */
export function buildIncrementalReadText(options: {
	label: string; header: string; rows: readonly string[]; startLine: number;
	missing: readonly { start: number; end: number }[]; sparse?: boolean;
}): string {
	const prefix = `${options.label} | lines `;
	if (!options.header.startsWith(prefix)) throw new ToolError("Invalid incremental read header");
	const header = `${options.label} | requested lines ${options.header.slice(prefix.length)}` +
		" | unchanged lines already shown are omitted; force=true re-sends this range";
	const blocks = options.missing.map(range => {
		if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < options.startLine || range.end < range.start || range.end >= options.startLine + options.rows.length) throw new ToolError("Invalid incremental read range");
		const rows: string[] = [];
		for (let i = range.start; i <= range.end; i++) {
			const text = options.rows[i - options.startLine]!;
			// Each disjoint sparse block needs its own first-line address.
			rows.push(options.sparse && i === range.start && i !== options.startLine && i % 10 !== 0 ? `${i}\t${text}` : text);
		}
		return `lines ${range.start}-${range.end}\n${rows.join("\n")}`;
	});
	return [header, ...blocks].join("\n");
}

function isBinary(buf: Buffer): boolean {
	return buf.includes(0);
}

/** 按行切分并记录换行风格；最后一行没有换行符时不产生空行 */
export function splitLines(text: string): { lines: string[]; eol: "\n" | "\r\n" } {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return { lines, eol };
}

function num(v: unknown, name: string): number | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ToolError(`${name} 必须是正整数`);
	return v;
}

function str(v: unknown, name: string): string {
	if (typeof v !== "string") throw new ToolError(`${name} 必须是字符串`);
	return v;
}

function fail(message: string, details: Record<string, unknown> = {}): ToolResult {
	return { ok: false, modelContent: `错误：${message}`, summary: `失败：${message}`, details: { error: message, ...details } };
}

/** 原子写入：同目录临时文件 + rename，保留原权限；expectedHash=null 要求目标仍不存在。 */
export function atomicWrite(abs: string, data: string | Buffer, expectedHash?: string | null): void {
	mkdirSync(dirname(abs), { recursive: true });
	// A valid destination basename may already be near the filesystem's length limit.
	// Keep the atomic rename on the same filesystem without lengthening that basename.
	const tmp = join(dirname(abs), `.mountains-${process.pid}-${randomUUID()}.tmp`);
	let created = false;
	try {
		const fd = openSync(tmp, "wx", 0o600);
		created = true;
		try { writeFileSync(fd, data); }
		finally { closeSync(fd); }
		// Recheck after checkpoint/temporary-file work, immediately before the only commit.
		// Portable filesystems do not offer compare-and-swap rename against arbitrary external writers.
		if (expectedHash === null && lstatSync(abs, { throwIfNoEntry: false }) !== undefined) {
			throw new ToolError("文件在验证后、提交前已出现，拒绝覆盖，请重新读取");
		}
		if (expectedHash !== undefined && expectedHash !== null && (lstatSync(abs).isSymbolicLink() || sha256(readRegularFile(abs)) !== expectedHash)) {
			throw new ToolError("文件在验证后、提交前已改变，请重新读取");
		}
		chmodSync(tmp, existsSync(abs) ? statSync(abs).mode : 0o666 & ~process.umask());
		renameSync(tmp, abs);
	} finally {
		if (created && existsSync(tmp)) unlinkSync(tmp);
	}
}

/** Only advertise recovery when the caller also registers context_expand. Archival is independent. */
export function createReadTool(limits: ReadLimits = DEFAULT_READ_LIMITS, recovery: { contextExpand?: boolean; lean?: boolean; queryPlan?: boolean } = {}): ToolDefinition {
	if (limits.dedupeRanges !== undefined && typeof limits.dedupeRanges !== "boolean") throw new ToolError("dedupeRanges must be boolean");
	if (limits.dedupeRanges && limits.dedupe !== true) throw new ToolError("dedupeRanges requires dedupe=true");
	// lean：模型看到的回执里不放哈希和审计引用（它们照旧记在 details 和归档里）
	const hashNote = (hash: string) => (recovery.lean ? "" : ` | sha256:${hash.slice(0, 12)}`);
	return {
		name: "file_read",
		logicalName: "file.read",
		readOnly: true,
		description:
			`Read a UTF-8 text file in the workspace. Returns ${limits.lineNumbers === "sparse" ? "lines with a line number on the first line and every 10th line" : "numbered lines"}. You decide how much to read: without startLine/endLine it returns ${limits.defaultLines >= limits.maxLines ? "the whole file" : `the first ${limits.defaultLines} lines`} (at most ${limits.maxLines} lines per call). Read small files whole; for a large file, locate the code first (${recovery.queryPlan ? "query_plan search" : "content_search"}), then read the part you need with startLine/endLine. ` +
			(limits.outlineFirst ? `Called without startLine/endLine on a source file longer than ${limits.outlineFirst} lines, it returns the file's outline (definitions with line numbers) instead of its first lines; then read just the range you need. ` : "") +
			(limits.symbols && limits.classOutlineOver ? `A class longer than ${limits.classOutlineOver} lines read by symbol returns its structure (methods with line numbers); pass full=true for the whole class. ` : "") +
			(limits.symbols ? "To read a Python function or class, pass symbol (e.g. parse or MyClass.method) instead of a line range. Uses lexical boundaries, not a full Python parser; if unsupported, use startLine/endLine. The same size limits apply; incomplete definitions include a continuation range. " : "") +
			(limits.dedupeRanges ? "Previously shown lines of the same file version may be omitted; force=true re-sends the requested range. " : "") +
			(recovery.lean ? "The header shows the line range and total lines." : "The header shows total lines and the file's sha256 (pass it as expectedHash when editing)."),
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative path" },
				startLine: { type: "integer", minimum: 1, description: "First line (1-based), default 1" },
				endLine: { type: "integer", minimum: 1, description: "Last line (inclusive)" },
				...(limits.symbols ? { symbol: { type: "string", description: "Python function or class name (Outer.name for nested); reads just that definition" } } : {}),
				...(limits.symbols && limits.classOutlineOver ? { full: { type: "boolean", description: `With symbol: return the whole class even if it is longer than ${limits.classOutlineOver} lines` } } : {}),
				...(limits.dedupe ? { force: { type: "boolean", description: "Re-send lines that are already in the conversation" } } : {}),
			},
			required: ["path"],
			additionalProperties: false,
		},
		async execute(args, ctx: ToolContext): Promise<ToolResult> {
			try {
				const { abs, rel } = ctx.workspace.resolve(str(args.path, "path"));
				if (statSync(abs).isDirectory()) return fail(`${rel} 是目录，请用 ${recovery.queryPlan ? "query_plan 的 glob 步骤" : "file_glob"} 列出文件`);
				const buf = readRegularFile(abs);
				if (isBinary(buf)) return fail(`${rel} 是二进制文件，拒绝读取`, { path: rel, bytes: buf.length });
				const hash = sha256(buf);
				ctx.files.record(rel, hash);
				const { lines, eol } = splitLines(buf.toString("utf8"));
				const total = lines.length;
				let symbolRange: PythonSymbolRange | null = null;
				if (limits.symbols && typeof args.symbol === "string" && args.symbol.trim() && args.startLine === undefined && args.endLine === undefined) {
					if (!/\.pyi?$/.test(rel)) return fail(`symbol 只支持 Python 文件（.py、.pyi）；读取 ${rel} 请用 startLine/endLine`);
					const found = findPythonSymbols(lines, args.symbol.trim());
					if (found.length === 0) return fail(`${rel} 中没有名为 ${args.symbol} 的函数或类定义`);
					if (found.length > 1) return fail(`${rel} 中有 ${found.length} 处 ${args.symbol} 定义（第 ${found.map((f) => f.start).join("、")} 行）：用 Outer.name 或 startLine/endLine 指定`);
					symbolRange = found[0] ?? null;
				}
				if (limits.outlineFirst && limits.outlineFirst > 0 && symbolRange === null && args.startLine === undefined && args.endLine === undefined && total > limits.outlineFirst) {
					const entries = outlineLines(rel, lines.join("\n"));
					if (entries.length > 0) {
						const shown = entries.slice(0, OUTLINE_MAX);
						const how = limits.symbols && /\.pyi?$/.test(rel) ? "read a definition with symbol=Name or a range with startLine/endLine" : "read a range with startLine/endLine";
						return {
							ok: true,
							modelContent: [`${rel} | ${total} lines | outline of definitions (no range given and the file is longer than ${limits.outlineFirst} lines); ${how}`, ...shown.map((e) => `${e.line}\t${e.text}`), ...(entries.length > shown.length ? [`… ${entries.length - shown.length} more definitions; read a range to see them`] : [])].join("\n"),
							summary: `${rel} 共 ${total} 行，返回定义大纲 ${shown.length} 条`,
							details: { path: rel, totalLines: total, hash, outline: true, definitions: entries.length },
						};
					}
				}
				if (symbolRange && limits.classOutlineOver && limits.classOutlineOver > 0 && args.full !== true && symbolRange.kind === "class" && symbolRange.end - symbolRange.start + 1 > limits.classOutlineOver) {
					const indent = indentOf(lines[symbolRange.declaration - 1] ?? "");
					const members = outlineLines(rel, lines.join("\n")).filter((e) => e.line > symbolRange!.declaration && e.line <= symbolRange!.end && indentOf(e.text) > indent);
					const shown = members.slice(0, OUTLINE_MAX);
					const declaration = lines[symbolRange.declaration - 1] ?? "";
					const declarationText = declaration.length > 160 ? `${truncateUtf16(declaration, 160)}…` : declaration;
					return {
						ok: true,
						modelContent: [`${rel} | class ${String(args.symbol)} lines ${symbolRange.start}-${symbolRange.end} (${symbolRange.end - symbolRange.start + 1} lines) | structure only; read a method with symbol=${String(args.symbol)}.name, a range with startLine/endLine, or the whole class with full=true`, `${symbolRange.declaration}\t${declarationText}`, ...shown.map((e) => `${e.line}\t${e.text}`), ...(members.length > shown.length ? [`… ${members.length - shown.length} more members; read a range to see them`] : [])].join("\n"),
						summary: `${rel} 类 ${String(args.symbol)} 共 ${symbolRange.end - symbolRange.start + 1} 行，返回结构 ${members.length} 项`,
						details: { path: rel, totalLines: total, hash, classOutline: true, symbolStart: symbolRange.start, symbolEnd: symbolRange.end, members: members.length },
					};
				}
				const start = symbolRange?.start ?? num(args.startLine, "startLine") ?? 1;
				if (total > 0 && start > total) return fail(`startLine=${start} 超过总行数 ${total}`);
				let end = symbolRange?.end ?? num(args.endLine, "endLine") ?? start + limits.defaultLines - 1;
				if (end < start) return fail("endLine 不能小于 startLine");
				end = Math.min(end, start + limits.maxLines - 1, total);
				let symbolTruncated = symbolRange !== null && end < symbolRange.end;
				let symbolContinuation = symbolTruncated ? ` | symbol incomplete: startLine=${end + 1} endLine=${symbolRange?.end}` : "";
				if (limits.dedupe && args.force !== true && total > 0 && ctx.files.isDelivered(rel, hash, start, end)) {
					return {
						ok: true,
						modelContent: `${rel} | lines ${start}-${end}${hashNote(hash)}${symbolContinuation} | unchanged and already shown earlier in this conversation; use that output (pass force=true to re-send)`,
						summary: `${rel} 第 ${start}-${end} 行已在上下文中（未重复发送）`,
						details: { path: rel, startLine: start, endLine: end, totalLines: total, hash, deduped: true, ...(symbolRange ? { symbolEndLine: symbolRange.end, symbolTruncated } : {}) },
					};
				}
				const out: string[] = [];
				let longLines = 0;
				const invalidUtf8 = !isUtf8(buf);
				// Leave bounded room for the header, archive reference and recovery/error notes.
				// Only complete formatted source rows enter the response and its read receipt.
				const rowBudget = MAX_READ_OUTPUT_BYTES - Buffer.byteLength(rel) - 8192;
				let rowBytes = 0;
				let outputTruncated = false;
				for (let i = start; i <= end; i++) {
					let line = lines[i - 1] ?? "";
					const clipped = line.length > limits.maxLineChars;
					if (clipped) line = `${truncateUtf16(line, limits.maxLineChars)}…[此行共 ${line.length} 字符，已截断]`;
					const row = limits.lineNumbers === "sparse" && i !== start && i % 10 !== 0 ? line : `${i}\t${line}`;
					const bytes = Buffer.byteLength(row) + 1;
					if (rowBytes + bytes > rowBudget) {
						if (!out.length) return fail("此行超过单次读取输出字节上限，请使用更小的 maxLineChars 配置", { path: rel });
						end = i - 1; outputTruncated = true; break;
					}
					rowBytes += bytes; out.push(row);
					if (clipped) longLines++;
				}
				symbolTruncated = symbolRange !== null && end < symbolRange.end;
				symbolContinuation = symbolTruncated ? ` | symbol incomplete: startLine=${end + 1} endLine=${symbolRange?.end}` : "";
				const needsArchive = start > 1 || end < total || invalidUtf8 || longLines > 0;
				let fullOutputRef: string | undefined;
				let archiveError: string | undefined;
				if (needsArchive) {
					try {
						if (!ctx.blobs) throw new ToolError("未配置原文存储");
						fullOutputRef = ctx.blobs.put(buf, { kind: "raw", source: { tool: "file_read", path: rel, toolCallId: ctx.toolCallId } });
					} catch (err) { archiveError = truncateUtf16(String(err), 200); }
				}
				const truncated = start > 1 || end < total || longLines > 0;
				const header =
					`${rel} | lines ${total === 0 ? 0 : start}-${end} of ${total}${hashNote(hash)}` +
					(eol === "\r\n" ? " | CRLF" : "") +
					(outputTruncated ? " | output byte limit reached" : "") +
					(symbolContinuation || (end < total ? ` | more: startLine=${end + 1}` : "")) +
					(invalidUtf8 ? " | invalid UTF-8: displayed text is lossy" : "") +
					(fullOutputRef && !(recovery.lean && !recovery.contextExpand) ? ` | fullOutputRef=${fullOutputRef} (${recovery.contextExpand ? "context_expand can recover this exact version" : "audit only"})` : "") +
					(archiveError ? ` | archive unavailable: ${archiveError}` : "");
				let modelContent = [header, ...out].join("\n");
				let publishedRanges = total > 0 && longLines === 0 && !invalidUtf8 ? [{ start, end }] : [];
				let partialDedupe = false;
				if (limits.dedupeRanges && args.force !== true && publishedRanges.length) {
					const missing = ctx.files.undeliveredRanges(rel, hash, start, end);
					if (missing.length && (missing.length !== 1 || missing[0]!.start !== start || missing[0]!.end !== end)) {
						const compact = buildIncrementalReadText({ label: rel, header, rows: out, startLine: start, missing, sparse: limits.lineNumbers === "sparse" });
						if (Buffer.byteLength(compact) < Buffer.byteLength(modelContent)) {
							modelContent = compact; publishedRanges = missing; partialDedupe = true;
						}
					}
				}
				if (Buffer.byteLength(modelContent) > MAX_READ_OUTPUT_BYTES) throw new ToolError("File read output exceeds byte limit");
				if (!ctx.deferReadPublication) for (const range of publishedRanges) ctx.files.markDelivered(rel, hash, range.start, range.end);
				return {
					ok: true,
					modelContent,
					summary: partialDedupe ? `查看 ${rel} 第 ${start}-${end} 行中尚未展示的部分（共 ${total} 行）` : `查看 ${rel} 第 ${start}-${end} 行（共 ${total} 行）`,
					details: { path: rel, ...(partialDedupe ? { requestedStartLine: start, requestedEndLine: end, partialDedupe: true } : { startLine: start, endLine: end }), totalLines: total, hash, truncated, outputTruncated, longLines, eol, invalidUtf8, ...(archiveError ? { archiveError } : {}), ...(symbolRange ? { symbolEndLine: symbolRange.end, symbolTruncated } : {}) },
					reads: publishedRanges.map(range => ({ path: rel, startLine: range.start, endLine: range.end, totalLines: total, hash })),
					...(fullOutputRef ? { fullOutputRef } : {}),
				};
			} catch (err) {
				return fail(err instanceof ToolError ? err.message : String(err));
			}
		},
	};
}

function hashMatches(expected: string, actual: string): boolean {
	const e = expected.replace(/^sha256:/, "").toLowerCase();
	return e.length >= 8 && actual.startsWith(e);
}

/** 完整原始参数进入审批展示，审批等待期间不会创建文件或调用快照钩子。 */
async function approveFileWrite(tool: string, args: Record<string, unknown>, path: string, explanation: string, ctx: ToolContext): Promise<ToolResult | null> {
	const request = { toolCallId: ctx.toolCallId, command: `${tool} ${JSON.stringify(args, null, 2)}`, cwd: ".", risk: "workspace-write" as const, explanation };
	if (ctx.signal.aborted) return fail("写文件已取消，文件未修改", { path, cancelled: true });
	const decision = await waitForApproval(ctx, request);
	if (ctx.signal.aborted) return fail("写文件已取消，文件未修改", { path, cancelled: true });
	if (decision !== "allow") return fail(`写文件未获批准：${path}`, { path, approved: false });
	return null;
}

export function createEditTool(options: { batch?: boolean; lean?: boolean; approveFileWrites?: boolean; feedback?: boolean } = {}): ToolDefinition {
	if (options.feedback !== undefined && typeof options.feedback !== "boolean") throw new ToolError("feedback must be boolean");
	return {
		name: "file_edit",
		logicalName: "file.edit",
		readOnly: false,
		description:
			"Replace exact text in a file. oldText must match exactly (including indentation); by default it must match exactly once (set expectedMatches otherwise). " +
			"Fails if the file changed since you last read it (or if expectedHash does not match). Read the file before editing." +
			(options.batch ? " Alternatively supply edits, a list of independent replacements in this file. Every edit is matched against the same original version, never a previous replacement. All counts and non-overlap must pass before one atomic commit. Do not mix edits with oldText/newText/expectedMatches." : "") +
			(options.feedback ? " Returns a bounded source preview around the edits, with exact new line ranges." : ""),
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				oldText: { type: "string", description: "Exact existing text to replace" },
				newText: { type: "string", description: "Replacement text" },
				expectedHash: { type: "string", description: options.lean ? "Optional current sha256; last read is tracked automatically" : "sha256 from the last file_read header (optional)" },
				expectedMatches: { type: "integer", minimum: 1, description: "Number of occurrences to replace, default 1" },
				...(options.batch ? { edits: { type: "array", minItems: 1, maxItems: 100, description: "Independent replacements, all against the original file", items: {
					type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" }, expectedMatches: { type: "integer", minimum: 1 } }, required: ["oldText", "newText"], additionalProperties: false,
				} } } : {}),
			},
			required: options.batch ? ["path"] : ["path", "oldText", "newText"],
			additionalProperties: false,
		},
		async execute(args, ctx) {
			try {
				const { abs, rel } = ctx.workspace.resolve(str(args.path, "path"));
				const batch = args.edits !== undefined;
				if (batch && !options.batch) return fail("当前配置未开启批量编辑");
				if (batch && (args.oldText !== undefined || args.newText !== undefined || args.expectedMatches !== undefined)) return fail("edits 不能与 oldText、newText 或 expectedMatches 同时使用");
				if (batch && (!Array.isArray(args.edits) || args.edits.length === 0 || args.edits.length > 100)) return fail("edits 必须包含 1-100 处独立替换");
				const rawEdits = batch ? args.edits as unknown[] : [args];
				const edits = rawEdits.map((raw, index) => {
					if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`edits[${index}] 必须是对象`);
					const entry = raw as Record<string, unknown>;
					if (batch && Object.keys(entry).some((key) => !["oldText", "newText", "expectedMatches"].includes(key))) throw new ToolError(`edits[${index}] 含未知字段`);
					const oldText = str(entry.oldText, "oldText");
					if (!oldText) throw new ToolError("oldText 不能为空；插入请提供相邻原文，新建文件请用 file_write");
					return { oldText, newText: str(entry.newText, "newText"), expectedMatches: num(entry.expectedMatches, "expectedMatches") ?? 1 };
				});
				const buf = readRegularFile(abs);
				if (isBinary(buf)) return fail(`${rel} 是二进制文件`);
				if (!isUtf8(buf)) return fail(`${rel} 不是有效 UTF-8，拒绝修改以免损坏原始字节`);
				const before = sha256(buf);
				const expected = typeof args.expectedHash === "string" ? args.expectedHash : ctx.files.get(rel);
				if (expected === undefined) return fail(`请先用 file_read 读取 ${rel} 再编辑`, { path: rel });
				if (!hashMatches(expected, before)) {
					return fail(`${rel} 自上次读取后已改变（当前 sha256:${before.slice(0, 12)}），请重新读取`, { path: rel, currentHash: before });
				}
				const original = buf.toString("utf8");
				const crlf = original.includes("\r\n");
				const mixedEndings = crlf && /(?<!\r)\n/.test(original);
				const spans: { start: number; end: number; text: string; edit: number }[] = [];
				for (const [index, entry] of edits.entries()) {
					// Uniform CRLF files keep their existing adaptation. In a mixed file,
					// exact bytes take precedence, including their occurrence count; only
					// fall back to CRLF when the supplied range does not exist verbatim.
					if (crlf && (!mixedEndings || !original.includes(entry.oldText))) {
						entry.oldText = entry.oldText.replace(/\r?\n/g, "\r\n");
						entry.newText = entry.newText.replace(/\r?\n/g, "\r\n");
					}
					let count = 0;
					for (let pos = original.indexOf(entry.oldText); pos !== -1; pos = original.indexOf(entry.oldText, pos + (batch ? 1 : entry.oldText.length))) {
						count++;
						spans.push({ start: pos, end: pos + entry.oldText.length, text: entry.newText, edit: index });
					}
					if (count !== entry.expectedMatches) return fail(count === 0 ? `在 ${rel} 中没有找到 oldText（需完全一致，包括缩进）` :
						`oldText 在 ${rel} 中出现 ${count} 次，与 expectedMatches=${entry.expectedMatches} 不符；请提供更多上下文使其唯一`, { path: rel, matches: count, editIndex: index });
				}
				spans.sort((a, b) => a.start - b.start || a.end - b.end);
				for (let i = 1; i < spans.length; i++) if (spans[i]!.start < spans[i - 1]!.end) return fail("替换范围重叠；所有 edits 必须匹配原文件中的独立位置", { path: rel, editIndex: spans[i]!.edit });
				const pieces: string[] = [];
				let cursor = 0;
				for (const span of spans) {
					pieces.push(original.slice(cursor, span.start), span.text);
					cursor = span.end;
				}
				pieces.push(original.slice(cursor));
				const text = pieces.join("");
				const lineAt = original.slice(0, spans[0]!.start).split("\n").length;
				const added = edits.reduce((n, e) => n + e.newText.split("\n").length * e.expectedMatches, 0);
				const removed = edits.reduce((n, e) => n + e.oldText.split("\n").length * e.expectedMatches, 0);
				if (options.approveFileWrites) {
					const rejected = await approveFileWrite("file_edit", args, rel, `修改 ${rel}（${spans.length} 处替换，第 ${lineAt} 行附近，-${removed} +${added} 行）`, ctx);
					if (rejected) return rejected;
				}
				await ctx.beforeWrite?.(abs);
				if (ctx.signal.aborted) return fail("编辑已取消，文件未修改", { path: rel, ...(options.approveFileWrites ? { cancelled: true } : {}) });
				if (ctx.workspace.resolve(rel).abs !== abs) return fail("文件路径在验证后已改变，请重新读取", { path: rel });
				const after = sha256(text);
				const receipt = `edited ${rel}: ${spans.length} replacement(s) at line ${lineAt}` + (options.lean ? "" : `; new sha256:${after.slice(0, 12)}`);
				// Prepare bounded output before committing, so a formatting failure never
				// reports an already-applied edit as failed. Publish only after atomicWrite.
				const feedback = options.feedback ? buildEditFeedback({ path: rel, original, updated: text, spans, receipt }) : undefined;
				ctx.assertExecutionAllowed?.();
				atomicWrite(abs, text, before);
				ctx.files.record(rel, after);
				if (feedback && !ctx.deferReadPublication) for (const read of feedback.reads) ctx.files.markDelivered(read.path, read.hash, read.startLine, read.endLine);
				return {
					ok: true,
					modelContent: feedback?.modelContent ?? receipt,
					summary: `修改 ${rel}（第 ${lineAt} 行附近，-${removed} +${added} 行）`,
					details: { path: rel, line: lineAt, replacements: spans.length, beforeHash: before, afterHash: after, ...(batch ? { edits } : { oldText: edits[0]!.oldText, newText: edits[0]!.newText }), ...(feedback ? { feedback: feedback.details } : {}) },
					...(feedback ? { reads: feedback.reads } : {}),
					writes: [{ path: rel, beforeHash: before, afterHash: after }],
				};
			} catch (err) {
				return fail(err instanceof ToolError ? err.message : String(err));
			}
		},
	};
}

export function createWriteTool(options: { lean?: boolean; approveFileWrites?: boolean } = {}): ToolDefinition {
	return {
		name: "file_write",
		logicalName: "file.write",
		readOnly: false,
		description:
			"Create a new file with the given content. By default refuses to overwrite an existing file; to overwrite set createOnly=false and pass expectedHash of the current content.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
				createOnly: { type: "boolean", description: "Default true" },
				expectedHash: { type: "string", description: "Required when overwriting" },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		async execute(args, ctx) {
			try {
				const { abs, rel } = ctx.workspace.resolve(str(args.path, "path"), { forWrite: true });
				const content = str(args.content, "content");
				const createOnly = args.createOnly !== false;
				let before: string | null = null;
				let beforeLines = 0;
				if (existsSync(abs)) {
					if (statSync(abs).isDirectory()) return fail(`${rel} 是目录`);
					const buf = readRegularFile(abs);
					before = sha256(buf);
					if (createOnly) return fail(`${rel} 已存在；覆盖需设置 createOnly=false 并提供 expectedHash`, { path: rel, currentHash: before });
					const expected = typeof args.expectedHash === "string" ? args.expectedHash : undefined;
					if (!expected || !hashMatches(expected, before)) {
						return fail(`覆盖 ${rel} 需要与当前内容一致的 expectedHash（当前 sha256:${before.slice(0, 12)}）`, { path: rel, currentHash: before });
					}
					if (options.approveFileWrites) beforeLines = splitLines(buf.toString("utf8")).lines.length;
				}
				const lines = splitLines(content).lines.length;
				if (options.approveFileWrites) {
					const explanation = before ? `覆盖 ${rel}（原 ${beforeLines} 行，新 ${lines} 行）` : `新建 ${rel}（${lines} 行）`;
					const rejected = await approveFileWrite("file_write", args, rel, explanation, ctx);
					if (rejected) return rejected;
				}
				await ctx.beforeWrite?.(abs);
				if (ctx.signal.aborted) return fail("写文件已取消，文件未修改", { path: rel, cancelled: true });
				if (ctx.workspace.resolve(rel, { forWrite: true }).abs !== abs) return fail("文件路径在验证后已改变，请重新读取", { path: rel });
				ctx.assertExecutionAllowed?.();
				atomicWrite(abs, content, before);
				const after = sha256(content);
				ctx.files.record(rel, after);
				return {
					ok: true,
					modelContent: `${before ? "overwrote" : "created"} ${rel} (${lines} lines` + (options.lean ? ")" : `, sha256:${after.slice(0, 12)})`),
					summary: `${before ? "覆盖" : "新建"} ${rel}（${lines} 行）`,
					details: { path: rel, lines, beforeHash: before, afterHash: after, content },
					writes: [{ path: rel, beforeHash: before, afterHash: after }],
				};
			} catch (err) {
				return fail(err instanceof ToolError ? err.message : String(err));
			}
		},
	};
}
