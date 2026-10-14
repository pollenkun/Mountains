import type { VerifiedBlobSnapshot } from "./workspace.ts";
import type { ToolDefinition, ToolResult } from "./types.ts";

export const EXPAND_MAX_LINES = 400;
export const EXPAND_MAX_BYTES = 12_000;
const EXPAND_DEFAULT_LINES = 200;
const EXPAND_DEFAULT_BYTES = 4096;

function fail(message: string): ToolResult {
	return { ok: false, modelContent: `错误：${message}`, summary: `失败：${message}`, details: { error: message } };
}
function integer(v: unknown, fallback: number, name: string, minimum = 1): number {
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < minimum) throw new Error(`${name} 必须是至少 ${minimum} 的安全整数`);
	return v;
}
function boundary(view: VerifiedBlobSnapshot, offset: number): boolean {
	return offset === 0 || offset === view.totalBytes || ((view.byteAt(offset) ?? 0) & 0xc0) !== 0x80;
}

/** Recovery only uses immutable archives; it never reads a current source or reruns a command. */
export function createExpandTool(): ToolDefinition {
	// Continuation pages of one archive reuse its verified snapshot until the store expires it, so a long archive
	// is checked once; a read from the start verifies again.
	const handles = new WeakMap<object, Map<string, string>>();
	return {
		name: "context_expand",
		logicalName: "context.expand",
		description:
			"Recover immutable archived evidence by ref (fullOutputRef is raw output; shown refs are earlier model text). " +
			"Use offset/limit for 1-based lines, or offsetBytes for 0-based raw byte paging. " +
			`Every reply is bounded by maxBytes (default ${EXPAND_DEFAULT_BYTES}, max ${EXPAND_MAX_BYTES}) and at most ${EXPAND_MAX_LINES} lines. ` +
			"Follow nextOffsetBytes for long lines. UTF-8 pages preserve original BOM/CRLF. Invalid UTF-8 returns base64 original bytes; no encoding is guessed.",
		parameters: {
			type: "object",
			properties: {
				ref: { type: "string", description: "Exact immutable fullOutputRef or shown ref" },
				offset: { type: "integer", minimum: 1, description: "First line, 1-based (default 1); cannot combine with offsetBytes" },
				limit: { type: "integer", minimum: 1, maximum: EXPAND_MAX_LINES, description: "Number of lines (default 200)" },
				offsetBytes: { type: "integer", minimum: 0, description: "0-based byte offset into this archived version; cannot combine with offset/limit" },
				maxBytes: { type: "integer", minimum: 1, maximum: EXPAND_MAX_BYTES, description: "Maximum original bytes per page" },
				encoding: { type: "string", enum: ["auto", "utf8", "base64"], description: "auto returns UTF-8 text or base64 if the archive is invalid UTF-8" },
			},
			required: ["ref"],
			additionalProperties: false,
		},
		readOnly: true,
		async execute(args, ctx) {
			try {
				if (Object.keys(args).some((key) => !["ref", "snapshot", "offset", "limit", "offsetBytes", "maxBytes", "encoding"].includes(key))) return fail("未知参数");
				const ref = typeof args.ref === "string" ? args.ref.trim() : "";
				if (!ref || ref.length > 256) return fail("无效 ref");
				const byteMode = args.offsetBytes !== undefined;
				if (byteMode && (args.offset !== undefined || args.limit !== undefined)) return fail("offsetBytes 不能与 offset/limit 同时使用");
				const offset = integer(args.offset, 1, "offset");
				const limit = Math.min(integer(args.limit, EXPAND_DEFAULT_LINES, "limit"), EXPAND_MAX_LINES);
				const maxBytes = Math.min(integer(args.maxBytes, EXPAND_DEFAULT_BYTES, "maxBytes"), EXPAND_MAX_BYTES);
				const requestedByte = integer(args.offsetBytes, 0, "offsetBytes", 0);
				const requestedEncoding = args.encoding ?? "auto";
				if (!["auto", "utf8", "base64"].includes(requestedEncoding as string)) return fail("encoding 无效");
				if (!ctx.blobs?.matchesWorkspace(ctx.workspace.root)) return fail("找不到或无权读取该引用");
				if (args.snapshot !== undefined && (typeof args.snapshot !== "string" || !/^page_v1_[0-9a-f]{32}$/.test(args.snapshot))) return fail("无效 snapshot");
				let known = handles.get(ctx.blobs);
				if (!known) handles.set(ctx.blobs, known = new Map());
				const continuing = byteMode ? requestedByte > 0 : offset > 1;
				const cached = args.snapshot === undefined && continuing ? known.get(ref) : undefined;
				const paging = (cached !== undefined ? ctx.blobs.pagingSnapshot(ref, cached) : null) ?? ctx.blobs.pagingSnapshot(ref, args.snapshot as string | undefined);
				if (paging && args.snapshot === undefined) {
					known.delete(ref);
					known.set(ref, paging.handle);
					if (known.size > 256) known.delete(known.keys().next().value!);
				}
				if (!paging) return fail(args.snapshot === undefined ? "找不到、无权读取或归档校验失败" : "分页快照无效、已过期或已被回收；请省略 snapshot 重新校验归档");
				const { view, handle } = paging;
				const { invalidUtf8, kind, hash, totalBytes, totalLines } = view;
				if (invalidUtf8 && requestedEncoding === "utf8") return fail("归档不是有效 UTF-8；请用 encoding=base64 取回原始字节");
				const encoding = requestedEncoding === "base64" || invalidUtf8 ? "base64" : "utf8";
				if (invalidUtf8 && (args.offset !== undefined || args.limit !== undefined)) return fail("非 UTF-8 原始字节不支持行号；请用 offsetBytes 分页");
				const start = byteMode ? requestedByte : view.lineStart(offset);
				const lineEnd = byteMode ? totalBytes : view.lineStart(offset + limit) ?? totalBytes;
				if (start === undefined || start > totalBytes) return fail("请求范围超出归档");
				const startLine = byteMode ? view.lineAt(start) : offset;
				if (encoding === "utf8" && !boundary(view, start)) return fail("offsetBytes 切开了 UTF-8 字符；请使用上一页的 nextOffsetBytes");
				let end = Math.min(lineEnd, totalBytes, start + maxBytes);
				// Byte pages also cap newline count, so tiny-line logs cannot bypass the line ceiling.
				let newlines = 0;
				for (let i = start; i < end; i++) if (view.byteAt(i) === 10 && ++newlines >= EXPAND_MAX_LINES) { end = i + 1; break; }
				if (encoding === "utf8") while (end > start && !boundary(view, end)) end--;
				if (end === start && end < totalBytes) return fail("maxBytes 太小，装不下一个完整 UTF-8 字符");
				const page = view.read(start, end);
				let endLine = startLine;
				for (let i = 0; i < page.length; i++) if (page[i] === 10 && i + 1 < page.length) endLine++;
				const more = end < totalBytes;
				const nextOffsetLine = more && end > start && view.byteAt(end - 1) === 10 ? endLine + 1 : undefined;
				// Preserve old small shown-text replies; raw replies expose the exact byte range.
				const legacyDisplay = kind === "shown" && !byteMode && encoding === "utf8" && end === lineEnd && args.maxBytes === undefined;
				const bodyBytes = legacyDisplay && more && page.at(-1) === 10 ? page.subarray(0, -1) : page;
				const body = encoding === "base64" ? bodyBytes.toString("base64") : bodyBytes.toString("utf8");
				const label = kind === "shown" ? "as shown earlier" : "original archived bytes";
				const range = legacyDisplay ? `lines ${offset}-${Math.min(totalLines, offset + limit - 1)} of ${totalLines}` : `bytes ${start}-${end} of ${totalBytes} (end exclusive) | encoding=${encoding}${invalidUtf8 ? " | invalid UTF-8" : ""}`;
				const next = more ? legacyDisplay ? ` | more: offset=${offset + limit}` : ` | more: offsetBytes=${end}` : "";
				return {
					ok: true,
					modelContent: `[ref=${ref} | ${range} | ${label}${next}]\n${body}`,
					summary: `取回归档第 ${start}-${end} 字节`,
					details: { ref, snapshot: handle, snapshotSemantics: "verified-immutable-view", kind, sha256: hash, encoding, invalidUtf8, offset: startLine, end: endLine, totalLines, offsetBytes: start, endBytes: end, totalBytes, more, ...(more ? { nextOffsetBytes: end } : {}), ...(nextOffsetLine !== undefined ? { nextOffsetLine } : {}) },
				};
			} catch (error) { return fail((error as Error).message); }
		},
	};
}
