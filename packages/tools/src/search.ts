import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { splitLines } from "./files.ts";
import { symbolHints } from "./code-lookup.ts";
import type { ReadRecord, ToolDefinition, ToolResult } from "./types.ts";
import { sha256, ToolError } from "./workspace.ts";

const RG = process.env.MOUNTAINS_RG ?? "rg";
const MAX_COLLECT = 2000;
const MAX_TEXT = 300;
const MAX_RG_OUTPUT = 2 * 1024 * 1024;

export interface SearchLimits {
	contextLines: number;
	maxOutputChars: number;
	maxScanBytes: number;
	maxFileBytes: number;
	maxFiles: number;
	timeoutMs: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
	contextLines: 0, maxOutputChars: 30000, maxScanBytes: 8 * 1024 * 1024,
	maxFileBytes: 2 * 1024 * 1024, maxFiles: 2000, timeoutMs: 10000,
};

/** Bound collection before buffering, including stderr and a single enormous JSON line. */
function runRg(args: string[], cwd: string, signal: AbortSignal, timeoutMs: number, input?: Buffer): Promise<{
	code: number | null; stdout: string; stderr: string; limited: boolean; timedOut: boolean;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(RG, ["--no-config", ...args], { cwd, signal, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let bytes = 0;
		let errBytes = 0;
		let limited = false;
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.max(1, timeoutMs));
		child.stdout!.on("data", (c: Buffer) => {
			const left = MAX_RG_OUTPUT - bytes;
			if (left > 0) out.push(c.subarray(0, left));
			bytes += Math.min(c.length, Math.max(0, left));
			if (c.length > left) { limited = true; child.kill("SIGKILL"); }
		});
		child.stderr!.on("data", (c: Buffer) => {
			const left = 16384 - errBytes;
			if (left > 0) { err.push(c.subarray(0, left)); errBytes += Math.min(c.length, left); }
		});
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), limited, timedOut });
		});
		if (input) {
			child.stdin!.on("error", () => { /* A killed/failed rg may close stdin early. close/error determines the result. */ });
			child.stdin!.end(input);
		}
	});
}

function cursorOf(v: unknown): number {
	if (v === undefined || v === null || v === "") return 0;
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n < 0) throw new ToolError("cursor 无效");
	return n;
}

function integer(v: unknown, name: string, fallback: number, min: number, max: number): number {
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new ToolError(`${name} 必须在 ${min}-${max} 之间`);
	return v;
}

function fail(message: string): ToolResult {
	return { ok: false, modelContent: `错误：${message}`, summary: `失败：${message}`, details: { error: message, complete: false } };
}

function limitsOf(options: Partial<SearchLimits>): SearchLimits {
	const limits = { ...DEFAULT_SEARCH_LIMITS, ...options };
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < (key === "contextLines" ? 0 : 1)) throw new ToolError(`${key} 限额无效`);
	}
	if (limits.contextLines > 20 || limits.maxOutputChars < 1000) throw new ToolError("contextLines 最多 20；maxOutputChars 至少 1000");
	return limits;
}

/** Read at most the declared budget even if a file grows after stat. */
function snapshot(abs: string, maxBytes: number): Buffer {
	const fd = openSync(abs, "r");
	try {
		const before = fstatSync(fd);
		if (!before.isFile()) throw new ToolError("搜索路径不是普通文件");
		if (before.size > maxBytes) throw new ToolError("文件超过剩余扫描上限");
		const buf = Buffer.alloc(before.size);
		let read = 0;
		while (read < buf.length) {
			const n = readSync(fd, buf, read, buf.length - read, read);
			if (n === 0) break;
			read += n;
		}
		const after = fstatSync(fd);
		if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
			throw new ToolError("读取期间文件已改变，请重新搜索");
		}
		return buf;
	} finally { closeSync(fd); }
}

interface Match { path: string; line: number; col: number; text: string; hash?: string; textTruncated?: boolean }
interface Snapshot { lines: string[]; hash: string }

function snippets(matches: Match[], snapshots: Map<string, Snapshot>, context: number): { text: string; ranges: ReadRecord[]; longLines: number } {
	const ranges: ReadRecord[] = [];
	for (const match of matches) {
		const snap = snapshots.get(match.path)!;
		const start = Math.max(1, match.line - context);
		const end = Math.min(snap.lines.length, match.line + context);
		const last = ranges[ranges.length - 1];
		if (last?.path === match.path && start <= last.endLine + 1) last.endLine = Math.max(end, last.endLine);
		else ranges.push({ path: match.path, startLine: start, endLine: end, totalLines: snap.lines.length, hash: snap.hash });
	}
	const rows: string[] = [];
	let longLines = 0;
	for (const range of ranges) {
		rows.push(`${range.path} | lines ${range.startLine}-${range.endLine} of ${range.totalLines} | sha256:${range.hash}`);
		const snap = snapshots.get(range.path)!;
		const hits = new Set(matches.filter((m) => m.path === range.path).map((m) => m.line));
		for (let i = range.startLine; i <= range.endLine; i++) {
			const line = snap.lines[i - 1] ?? "";
			if (line.length > MAX_TEXT) longLines++;
			rows.push(`${i}${hits.has(i) ? ":" : "-"}\t${line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…[line truncated; use file_read]` : line}`);
		}
	}
	return { text: rows.join("\n"), ranges, longLines };
}

export interface SearchToolOptions {
	/** 可选配置：正式支持 path 作用域（文件或目录），并拒绝未知参数；默认关闭以保持旧行为。 */
	pathScope?: boolean;
	/**
	 * 可选配置：搜索词是一个明确的代码标识符（可带 def/class 前缀）时，在结果后附一段"同名定义在哪几处"。
	 * 普通文本、正则、自然语言不触发；查不到定义就不附加；同一个符号一次运行里只附一次；原有搜索结果不变。
	 */
	symbolHints?: boolean;
}

/** `foo`、`Foo.bar`、`def foo`、`class Foo`、`def foo\(` 这类写法取出标识符；其余返回 null。 */
export function symbolOfPattern(pattern: string): string | null {
	const m = /^\s*(?:(?:async\s+)?def\s+|class\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:\\?\()?\s*$/.exec(pattern);
	if (!m) return null;
	const name = m[1]!.split(".").pop()!;
	return name.length >= 3 && name.length <= 80 ? name : null;
}

export function createSearchTool(options: Partial<SearchLimits> = {}, tool: SearchToolOptions = {}): ToolDefinition {
	const limits = limitsOf(options);
	const contextual = limits.contextLines > 0;
	const pathScope = tool.pathScope === true;
	const hinted = new Set<string>();
	const KNOWN = ["pattern", "glob", "caseSensitive", "cursor", "maxResults", "contextLines", ...(pathScope ? ["path"] : [])];
	return {
		name: "content_search", logicalName: "content.search", readOnly: true,
		description: "Search file contents with a regular expression (ripgrep syntax), respecting .gitignore. Returns path:line:column: text, sorted by path. " +
			"Default 50 results per page; use cursor to page. Narrow with glob (e.g. \"src/**/*.py\")" + (pathScope ? " or path (a workspace file or directory; only that file or directory is searched)." : ".") +
			(contextual ? ` Includes ${limits.contextLines} neighboring lines by default, merged ranges and the same snapshot's sha256 for editing. Scanning and output are bounded; incomplete results never prove absence.` : ""),
		parameters: { type: "object", properties: {
			pattern: { type: "string", description: "Regular expression" },
			glob: { type: "string", description: "Optional file glob filter" },
			...(pathScope ? { path: { type: "string", description: "Optional workspace-relative file or directory to search in" } } : {}),
			caseSensitive: { type: "boolean", description: "Default true" },
			cursor: { type: "integer", minimum: 0, description: "Offset of the first result to return" },
			maxResults: { type: "integer", minimum: 1, maximum: 200, description: "Default 50" },
			...(contextual ? { contextLines: { type: "integer", minimum: 0, maximum: 20, description: `Neighboring lines per match, default ${limits.contextLines}` } } : {}),
		}, required: ["pattern"], additionalProperties: false },
		async execute(args, ctx) {
			try {
				if (typeof args.pattern !== "string" || !args.pattern || args.pattern.length > 4096) return fail("pattern 不能为空且最多 4096 字符");
				if (pathScope) {
					const unknown = Object.keys(args).filter((k) => !KNOWN.includes(k));
					if (unknown.length) return fail(`未知参数 ${unknown.join(", ")}；可用参数：${KNOWN.join(", ")}`);
				}
				let scope: string | null = null;
				if (pathScope && args.path !== undefined) {
					if (typeof args.path !== "string" || !args.path) return fail("path 必须是非空字符串");
					let rel: string;
					try { rel = ctx.workspace.resolve(args.path).rel; } catch (error) { return fail(`path 无效：${String(error instanceof Error ? error.message : error).slice(0, 200)}`); }
					scope = rel === "" ? "." : rel;
				}
				const cursor = cursorOf(args.cursor);
				const max = integer(args.maxResults, "maxResults", 50, 1, 200);
				if (!contextual && args.contextLines !== undefined) return fail("当前配置未开启邻近正文");
				const context = integer(args.contextLines, "contextLines", limits.contextLines, 0, 20);
				const deadline = Date.now() + limits.timeoutMs;
				const syntax = await runRg(["--json", "-e", args.pattern], ctx.workspace.root, ctx.signal, deadline - Date.now(), Buffer.alloc(0));
				if (syntax.code !== 0 && syntax.code !== 1) return fail(`搜索表达式无法执行：${syntax.stderr.trim().slice(0, 300) || "已超时"}`);
				const listArgs = ["--files", "-0", "--sort", "path"];
				if (typeof args.glob === "string" && args.glob) listArgs.push("-g", args.glob);
				if (scope) listArgs.push("--", scope);
				const listing = await runRg(listArgs, ctx.workspace.root, ctx.signal, deadline - Date.now());
				const reasons: string[] = [];
				if (listing.limited || listing.timedOut || (listing.code !== 0 && listing.code !== 1)) reasons.push("file enumeration incomplete");
				// Ignore an unterminated final path if stdout was cut mid-record.
				const paths = listing.stdout.split("\0").slice(0, -1);
				if (paths.length > limits.maxFiles) reasons.push("file count limit");
				const matches: Match[] = [];
				const snapshots = new Map<string, Snapshot>();
				let scanBytes = 0;
				let scannedFiles = 0;
				let skippedBinaryFiles = 0;
				for (const p of paths.slice(0, limits.maxFiles)) {
					if (ctx.signal.aborted) throw new ToolError("搜索已取消");
					if (Date.now() >= deadline) { reasons.push("time limit"); break; }
					if (scanBytes >= limits.maxScanBytes) { reasons.push("scan byte limit"); break; }
					const { abs, rel } = ctx.workspace.resolve(p);
					let buf: Buffer;
					try { buf = snapshot(abs, Math.min(limits.maxFileBytes, limits.maxScanBytes - scanBytes)); }
					catch (error) { reasons.push(`${rel}: ${String(error).slice(0, 200)}`); break; }
					scanBytes += buf.length;
					scannedFiles++;
					if (buf.includes(0)) { skippedBinaryFiles++; continue; }
					if (!isUtf8(buf)) { reasons.push(`${rel}: invalid UTF-8; text search cannot establish absence`); break; }
					// Disable BOM/transcoding detection: offsets must address the exact UTF-8 snapshot.
					const rgArgs = ["--json", "--encoding", "none", "-e", args.pattern];
					if (args.caseSensitive === false) rgArgs.push("-i");
					const result = await runRg(rgArgs, ctx.workspace.root, ctx.signal, deadline - Date.now(), buf);
					const previousReasons = reasons.length;
					if (result.limited || result.timedOut || (result.code !== 0 && result.code !== 1)) {
						reasons.push(result.stderr ? result.stderr.trim().slice(0, 300) : "search output or time limit");
					}
					const snap = { lines: splitLines(buf.toString("utf8")).lines, hash: sha256(buf) };
					for (const row of result.stdout.split("\n")) {
						if (!row.startsWith('{"type":"match"')) continue;
						let data: { line_number: number; submatches: { start: number }[] };
						try { data = (JSON.parse(row) as { data: typeof data }).data; }
						catch { reasons.push("incomplete match record"); break; }
						if (matches.length >= MAX_COLLECT) { reasons.push("match collection limit"); break; }
						const line = snap.lines[data.line_number - 1] ?? "";
						const col = Buffer.from(line).subarray(0, data.submatches[0]?.start ?? 0).toString("utf8").length + 1;
						matches.push({ path: rel, line: data.line_number, col, text: (line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…` : line).trim(), ...(line.length > MAX_TEXT ? { textTruncated: true } : {}), ...(contextual ? { hash: snap.hash } : {}) });
						if (contextual) snapshots.set(rel, snap);
					}
					if (reasons.length > previousReasons) break;
				}
				let page: Match[] = [];
				let body = "";
				let ranges: ReadRecord[] = [];
				let longLines = 0;
				for (const match of matches.slice(cursor, cursor + max)) {
					const candidate = [...page, match];
					const render = contextual ? snippets(candidate, snapshots, context) : { text: candidate.map((m) => `${m.path}:${m.line}:${m.col}: ${m.text}`).join("\n"), ranges: [], longLines: candidate.filter((m) => m.textTruncated).length };
					if (render.text.length > limits.maxOutputChars - 700) break;
					page = candidate; body = render.text; ranges = render.ranges; longLines = render.longLines;
				}
				if (page.length === 0 && cursor < matches.length) return fail("单个结果超过输出上限，请缩小 contextLines 或提高配置上限");
				const next = cursor + page.length < matches.length ? cursor + page.length : null;
				const complete = reasons.length === 0;
				const total = matches.length;
				const files = new Set(matches.map((m) => m.path)).size;
				const header = (total === 0 ? (complete ? `No matches for /${args.pattern.slice(0, 300)}/` : "Search incomplete; no matches in the scanned portion") :
					`${complete ? "" : "At least "}${total} matches in ${files} files (showing ${page.length ? cursor + 1 : 0}-${cursor + page.length})` + (next !== null ? `; next cursor: ${next}` : "")) +
					(!complete ? `; incomplete: ${reasons.join("; ").slice(0, 350)}; narrow glob/pattern and retry` : "") +
					(skippedBinaryFiles ? `; skipped ${skippedBinaryFiles} binary files (text search only)` : "");
				for (const range of ranges) ctx.files.record(range.path, range.hash);
				let hint = "";
				let symbolHint: Record<string, unknown> | null = null;
				const symbol = tool.symbolHints === true && cursor === 0 ? symbolOfPattern(args.pattern) : null;
				if (symbol && !hinted.has(symbol)) {
					try {
						const h = await symbolHints(ctx.workspace.root, symbol, ctx.signal);
						symbolHint = { symbol, definitions: h.definitions, shown: h.text.length > 0 };
						if (h.text) {
							hinted.add(symbol);
							hint = `\n\n${h.text}`;
							for (const r of h.records) ctx.files.record(r.path, r.hash);
						}
					} catch (error) { symbolHint = { symbol, error: String(error).slice(0, 200) }; }
				}
				return { ok: true, modelContent: [header, body].filter(Boolean).join("\n") + hint, summary: `搜索 /${args.pattern.slice(0, 100)}/：${files} 个文件 ${total} 处${complete ? "" : "（未完成扫描）"}`,
					details: { pattern: args.pattern, glob: args.glob ?? null, ...(pathScope ? { path: scope } : {}), total, files, cursor, next, matches: page, ranges, complete, truncated: !complete || next !== null || longLines > 0, reasons, scanBytes, scannedFiles, skippedBinaryFiles, longLines, ...(symbolHint ? { symbolHint } : {}) },
					...(ranges.length ? { reads: ranges } : {}) };
			} catch (err) { return fail(err instanceof ToolError ? err.message : String(err)); }
		},
	};
}

export function createGlobTool(): ToolDefinition {
	return {
		name: "file_glob", logicalName: "file.glob", readOnly: true,
		description: "List files matching glob patterns (e.g. [\"**/*.py\"]), respecting .gitignore, sorted by path. Symlinks are not followed. Default 200 paths per page; use cursor to page.",
		parameters: { type: "object", properties: {
			patterns: { type: "array", items: { type: "string" }, description: "Glob patterns; files matching any are listed" },
			exclude: { type: "array", items: { type: "string" }, description: "Glob patterns to exclude" },
			cursor: { type: "integer", minimum: 0 },
		}, required: ["patterns"], additionalProperties: false },
		async execute(args, ctx) {
			try {
				const patterns = Array.isArray(args.patterns) ? args.patterns.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
				if (patterns.length === 0) return fail("patterns 至少需要一项");
				const exclude = Array.isArray(args.exclude) ? args.exclude.filter((p): p is string => typeof p === "string") : [];
				const cursor = cursorOf(args.cursor);
				const rgArgs = ["--files", "-0", "--sort", "path"];
				for (const p of patterns) rgArgs.push("-g", p);
				for (const e of exclude) rgArgs.push("-g", `!${e}`);
				const result = await runRg(rgArgs, ctx.workspace.root, ctx.signal, DEFAULT_SEARCH_LIMITS.timeoutMs);
				const complete = !result.limited && !result.timedOut && (result.code === 0 || result.code === 1);
				const all = result.stdout.split("\0").slice(0, -1).map((p) => p.replace(/^\.\//, ""));
				const page: string[] = [];
				let chars = 0;
				for (const p of all.slice(cursor, cursor + 200)) {
					if (chars + p.length > DEFAULT_SEARCH_LIMITS.maxOutputChars - 500) break;
					ctx.workspace.resolve(p);
					page.push(p); chars += p.length + 1;
				}
				const next = cursor + page.length < all.length ? cursor + page.length : null;
				const header = `${complete ? "" : "At least "}${all.length} files` + (all.length ? ` (showing ${page.length ? cursor + 1 : 0}-${cursor + page.length})` : "") + (next !== null ? `; next cursor: ${next}` : "") + (!complete ? "; incomplete listing; narrow patterns and retry" : "");
				return { ok: complete, modelContent: [header, ...page].join("\n"), summary: `列出 ${all.length} 个文件（${patterns.join(", ")}）`, details: { patterns, exclude, total: all.length, cursor, next, files: page, complete, truncated: !complete || next !== null } };
			} catch (err) { return fail(err instanceof ToolError ? err.message : String(err)); }
		},
	};
}
