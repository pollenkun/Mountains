import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { buildIncrementalReadText, DEFAULT_READ_LIMITS, findSymbol, splitLines, type ReadLimits } from "./files.ts";
import { outlineLines } from "./outline.ts";
import type { ToolContext, ToolDefinition, ToolResult, ReadRecord } from "./types.ts";
import { FileStateTracker, sha256, ToolError } from "./workspace.ts";

/** Bump whenever query semantics, parsing or applicability checks change. */
export const QUERY_PLAN_VERSION = "bounded-query-v1";
export interface PlanLimits {
	maxSteps: number;
	maxFiles: number;
	maxScanBytes: number;
	maxFileBytes: number;
	maxOutputBytes: number;
	maxProcessBytes: number;
	maxPaths: number;
	maxMatches: number;
	maxDurationMs: number;
}
export const DEFAULT_PLAN_LIMITS: PlanLimits = {
	maxSteps: 8, maxFiles: 2000, maxScanBytes: 32 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024,
	maxOutputBytes: 64 * 1024, maxProcessBytes: 512 * 1024, maxPaths: 40, maxMatches: 200, maxDurationMs: 15000,
};
const HARD_LIMITS: PlanLimits = {
	maxSteps: 20, maxFiles: 20000, maxScanBytes: 256 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024,
	maxOutputBytes: 1024 * 1024, maxProcessBytes: 4 * 1024 * 1024, maxPaths: 200, maxMatches: 1000, maxDurationMs: 60000,
};
export type PlanPath = string | { from: string; expect: "one" | "all" };
export type QueryStep = { id: string } & (
	{ op: "search"; pattern: string; glob?: string; path?: string; caseSensitive?: boolean } |
	{ op: "glob"; patterns: string[]; exclude?: string[] } |
	{ op: "read"; path: PlanPath; startLine?: number; endLine?: number; symbol?: string; force?: boolean } |
	{ op: "outline"; path: PlanPath } |
	{ op: "json_field"; path: PlanPath; field: string[] }
);
export interface QueryPlan { steps: QueryStep[] }
export interface PlanOptions { read?: Partial<ReadLimits>; limits?: Partial<PlanLimits>; lean?: boolean }
interface StepResult { id: string; op: string; paths: string[]; results: Record<string, unknown>[]; status?: "complete" | "failed" | "skipped"; error?: string }
interface LiteralScope { path: string; directory: boolean }
interface RunState {
	limits: PlanLimits; started: number; deadline: number; scanBytes: number; files: number; outputBytes: number; processBytes: number;
	dependencies: Map<string, string>; inventories: { patterns: string[]; exclude: string[]; paths: string[]; scope?: LiteralScope }[];
	steps: StepResult[]; reads: ReadRecord[]; output: string[];
}
const resultStates = new WeakMap<ToolResult, RunState>();
/** Only explicitly classified operation failures may leave independent evidence usable. */
class LocalQueryError extends ToolError {}
/** Recheck synchronously after any later awaited applicability checks. */
export function verifyQueryResultCurrent(result: ToolResult, ctx: ToolContext): void {
	const state = resultStates.get(result);
	if (!state) throw new ToolError("Query result lacks current source observations");
	check(state, ctx);
	for (const [path, before] of state.dependencies) {
		if (fingerprint(ctx.workspace.resolve(path).abs) !== before) throw new ToolError(`Source changed during plan: ${path}`);
	}
}
/** Publish read permissions only when the complete tool call is returning evidence. */
export function publishQueryResult(result: ToolResult, ctx: ToolContext): ToolResult {
	if (result.ok || (result.details.partial === true && result.details.receiptsVerified === true)) {
		verifyQueryResultCurrent(result, ctx);
		const outputBytes = Buffer.byteLength(result.modelContent);
		if (outputBytes > resultStates.get(result)!.limits.maxOutputBytes) throw new ToolError("Cumulative output limit exceeded before publication");
		result.details.outputBytes = outputBytes;
		for (const read of result.reads ?? []) {
			ctx.files.record(read.path, read.hash);
			if (!ctx.deferReadPublication) ctx.files.markDelivered(read.path, read.hash, read.startLine, read.endLine);
		}
	}
	return result;
}
function fail(message: string, details: Record<string, unknown> = {}): ToolResult {
	return { ok: false, modelContent: `Query stopped: ${message}`, summary: `查询已停止：${message}`, details: { complete: false, status: "stopped", error: message, ...details } };
}
function object(v: unknown): Record<string, unknown> {
	if (v === null || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new ToolError("Expected a JSON object");
	return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(v).some((k) => !allowed.includes(k))) throw new ToolError("Unknown plan field; only whitelisted JSON steps are allowed");
}
function text(v: unknown, label: string, max = 2000): string {
	if (typeof v !== "string" || !v || v.length > max || v.includes("\0")) throw new ToolError(`Invalid ${label}`);
	return v;
}
function strings(v: unknown, label: string): string[] {
	if (!Array.isArray(v) || v.length < 1 || v.length > 30) throw new ToolError(`Invalid ${label}`);
	return v.map((s) => text(s, label));
}
function limitsOf(given: Partial<PlanLimits> = {}): PlanLimits {
	const result = { ...DEFAULT_PLAN_LIMITS, ...given };
	for (const k of Object.keys(HARD_LIMITS) as (keyof PlanLimits)[]) {
		if (!Number.isInteger(result[k]) || result[k] < 1 || result[k] > HARD_LIMITS[k]) throw new ToolError(`Invalid limit ${k}; maximum ${HARD_LIMITS[k]}`);
	}
	return result;
}
/** Strict runtime validation, including references to preceding steps only. */
export function validateQueryPlan(value: unknown, maxSteps = DEFAULT_PLAN_LIMITS.maxSteps, allowLiteralSearchPath = false): QueryPlan {
	const plan = object(value); keys(plan, ["steps"]);
	if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > maxSteps) throw new ToolError(`steps must contain 1-${maxSteps} entries`);
	const ids = new Set<string>();
	for (const raw of plan.steps) {
		const s = object(raw); const id = text(s.id, "step id", 40);
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new ToolError("Step IDs must be unique identifiers");
		if (s.op === "search") {
			keys(s, ["id", "op", "pattern", "glob", "caseSensitive", ...(allowLiteralSearchPath ? ["path"] : [])]); text(s.pattern, "pattern");
			if (s.glob !== undefined) text(s.glob, "glob");
			if (s.path !== undefined) {
				text(s.path, "search.path");
				if (s.glob !== undefined) throw new ToolError("Conflicting search fields: use either glob or a literal path");
			}
			if (s.caseSensitive !== undefined && typeof s.caseSensitive !== "boolean") throw new ToolError("Invalid caseSensitive");
		} else if (s.op === "glob") {
			keys(s, ["id", "op", "patterns", "exclude"]); strings(s.patterns, "patterns");
			if (s.exclude !== undefined) strings(s.exclude, "exclude");
		} else if (["read", "outline", "json_field"].includes(String(s.op))) {
			keys(s, ["id", "op", "path", ...(s.op === "read" ? ["startLine", "endLine", "symbol", "force"] : s.op === "json_field" ? ["field"] : [])]);
			if (typeof s.path === "string") text(s.path, "path");
			else {
				const ref = object(s.path); keys(ref, ["from", "expect"]);
				if (!ids.has(text(ref.from, "reference")) || !["one", "all"].includes(String(ref.expect))) throw new ToolError("Path references require a preceding step and expect=one|all");
			}
			if (s.op === "json_field") strings(s.field, "field");
			if (s.op === "read") {
				if (s.force !== undefined && typeof s.force !== "boolean") throw new ToolError("Invalid force");
				for (const k of ["startLine", "endLine"]) if (s[k] !== undefined && (typeof s[k] !== "number" || !Number.isInteger(s[k]) || s[k] < 1)) throw new ToolError(`Invalid ${k}`);
				if (s.symbol !== undefined) { text(s.symbol, "symbol", 200); if (s.startLine !== undefined || s.endLine !== undefined) throw new ToolError("symbol cannot be combined with line ranges"); }
				if (typeof s.startLine === "number" && typeof s.endLine === "number" && s.endLine < s.startLine) throw new ToolError("Reversed line range");
			}
		} else throw new ToolError("Only search, glob, read, outline and json_field are allowed");
		ids.add(id);
	}
	// A JSON clone prevents later caller mutation and rejects executable values.
	return JSON.parse(JSON.stringify(plan)) as QueryPlan;
}
/** These aliases have exactly the same glob semantics; conflicting names are never guessed. */
function normalizePlanAliases(value: unknown, ctx: ToolContext): unknown {
	const plan = object(value);
	if (!Array.isArray(plan.steps)) return value;
	return { ...plan, steps: plan.steps.map(raw => {
		const step = { ...object(raw) };
		if (step.op === "search" && Object.hasOwn(step, "path")) {
			if (Object.hasOwn(step, "glob")) throw new ToolError("Conflicting search fields: use either glob or a literal path");
			const target = ctx.workspace.resolve(text(step.path, "search.path"));
			const stat = statSync(target.abs);
			if (!stat.isFile() && !stat.isDirectory()) throw new ToolError("search.path must be a regular file or directory");
			// A literal scope is not a glob: gitignore syntax trims trailing whitespace
			// and has other interpretation rules even after metacharacter escaping.
			step.path = target.rel;
		}
		if (step.op !== "glob") return step;
		const names = ["patterns", "pattern", "glob"].filter(name => Object.hasOwn(step, name));
		if (names.length > 1) throw new ToolError("Conflicting glob fields: use only patterns (or one singular alias pattern/glob)");
		const alias = names[0];
		if (alias === "pattern" || alias === "glob") {
			step.patterns = [text(step[alias], `glob.${alias}`)]; delete step[alias];
		}
		return step;
	}) };
}
function parsePlan(value: unknown, maxSteps: number, ctx: ToolContext): QueryPlan {
	return validateQueryPlan(normalizePlanAliases(value, ctx), maxSteps, true);
}
function check(state: RunState, ctx: ToolContext): void {
	if (ctx.signal.aborted) throw new ToolError("Query cancelled");
	if (Date.now() >= state.deadline) throw new ToolError("Query time limit exceeded");
}
/** No shell, bounded stdout+stderr, and the deadline also covers hung children. */
export function runQueryProcess(command: string, args: string[], ctx: ToolContext, deadline: number, maxBytes: number, input?: Buffer): Promise<{ code: number; stdout: string; bytes: number }> {
	return new Promise((resolve, reject) => {
		if (ctx.signal.aborted || Date.now() >= deadline) { reject(new ToolError("Query cancelled or timed out")); return; }
		const child = spawn(command, args, { cwd: ctx.workspace.root, stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true });
		const chunks: Buffer[] = []; let count = 0; let settled = false; let stderr = "";
		const cleanup = () => { clearTimeout(timer); ctx.signal.removeEventListener("abort", abort); };
		const stop = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.kill("SIGKILL");
			// A wrapper's descendants can keep inherited pipes open after it exits.
			// Failed output is unusable: release our pipes and settle without waiting
			// for close or attempting to manage processes outside the direct child.
			child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
			child.unref();
			reject(error);
		};
		const abort = () => stop(new ToolError("Query cancelled"));
		const timer = setTimeout(() => stop(new ToolError("Query time limit exceeded")), Math.max(1, deadline - Date.now()));
		ctx.signal.addEventListener("abort", abort, { once: true });
		const collect = (b: Buffer, out: boolean) => {
			if (settled) return;
			count += b.length;
			if (count > maxBytes) { stop(new ToolError("Query process output limit exceeded; incomplete result")); return; }
			if (out) chunks.push(b); else stderr += b.toString("utf8");
		};
		child.stdout.on("data", (b: Buffer) => collect(b, true)); child.stderr.on("data", (b: Buffer) => collect(b, false));
		child.stdout.on("error", stop); child.stderr.on("error", stop);
		child.stdin.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") stop(err); });
		child.on("error", stop);
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (code === null || code > 1 || stderr.trim()) reject(new ToolError(`Query process failed or incomplete: ${stderr.slice(0, 300) || code}`));
			else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), bytes: count });
		});
		// Cover cancellation during spawn before the abort listener was installed.
		if (ctx.signal.aborted) abort();
		else child.stdin.end(input);
	});
}
const rgCommand = () => process.env.MOUNTAINS_RG ?? "rg";
async function runInState(args: string[], ctx: ToolContext, state: RunState, input?: Buffer) {
	check(state, ctx);
	const remaining = state.limits.maxProcessBytes - state.processBytes;
	if (remaining < 1) throw new ToolError("Cumulative process output limit exceeded");
	const result = await runQueryProcess(rgCommand(), args, ctx, state.deadline, remaining, input);
	state.processBytes += result.bytes;
	return result;
}
function fingerprint(abs: string): string {
	const s = statSync(abs, { bigint: true });
	return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(":");
}
function boundedRead(path: string, ctx: ToolContext, state: RunState, skipBinary = false): { path: string; text: string; hash: string; binary?: boolean } {
	check(state, ctx);
	const r = ctx.workspace.resolve(path); const before = fingerprint(r.abs);
	if (state.dependencies.has(r.rel) && state.dependencies.get(r.rel) !== before) throw new ToolError(`Source changed during plan: ${r.rel}`);
	if (!statSync(r.abs).isFile()) throw new ToolError(`Not a regular file: ${r.rel}`);
	const fd = openSync(r.abs, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new ToolError(`Not a regular file: ${r.rel}`);
		const opened = fstatSync(fd, { bigint: true });
		if ([opened.dev, opened.ino, opened.size, opened.mtimeNs, opened.ctimeNs, opened.mode].join(":") !== before) throw new ToolError(`Source replaced before read: ${r.rel}`);
		const budget = Math.min(state.limits.maxFileBytes, state.limits.maxScanBytes - state.scanBytes);
		if (stat.size > budget || budget < 1 || ++state.files > state.limits.maxFiles) throw new ToolError("Cumulative file/scan limit exceeded; narrow the query");
		const chunks: Buffer[] = []; let size = 0;
		while (size < budget) {
			check(state, ctx); const b = Buffer.alloc(Math.min(64 * 1024, budget - size)); const count = readSync(fd, b);
			if (!count) break;
			size += count; state.scanBytes += count;
			chunks.push(b.subarray(0, count));
		}
		if (fstatSync(fd).size !== size) throw new ToolError("File changed or grew beyond the scan limit; incomplete result");
		if (fingerprint(r.abs) !== before) throw new ToolError(`Source changed while reading: ${r.rel}`);
		const data = Buffer.concat(chunks);
		state.dependencies.set(r.rel, before);
		if (data.includes(0)) {
			if (skipBinary) return { path: r.rel, text: "", hash: sha256(data), binary: true };
			throw new ToolError(`Binary file cannot be queried: ${r.rel}`);
		}
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true }).decode(data); }
		catch { if (skipBinary) return { path: r.rel, text: "", hash: sha256(data), binary: true }; throw new ToolError(`File is not UTF-8: ${r.rel}`); }
		return { path: r.rel, text: content, hash: sha256(data) };
	} finally { closeSync(fd); }
}
/** A type filter narrows rg's emitted inventory without overriding ignore rules.
 * Complex glob syntax falls back to the full baseline rather than risking omission.
 * Types match basenames; the original positive globs still determine the exact set.
 */
function inventoryTypeGlobs(patterns: string[], scope?: LiteralScope): string[] {
	if (scope && !scope.directory) {
		const name = basename(scope.path);
		// rg type definitions reserve colons and trim surrounding whitespace.
		if (name.includes(":") || name.trim() !== name || /[\r\n]/.test(name)) return [];
		// Type globs disable backslash escaping on Windows, where \\ is a separator.
		// Singleton classes are literal under both globset platform defaults.
		return [name.replace(/[\\*?{}[\]]/g, character => `[${character}]`)];
	}
	if (scope) return [];
	const globs: string[] = [];
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) continue;
		// Gitignore and type-glob syntax agree for these simple basename patterns.
		if (!/^[\p{L}\p{N}_./*? -]+$/u.test(pattern) || pattern.endsWith("/") || pattern.endsWith(" ")) return [];
		const leaf = pattern.slice(pattern.lastIndexOf("/") + 1);
		if (!leaf || leaf === "**" || leaf === "*") return [];
		globs.push(leaf);
	}
	return globs;
}
/** Only negative overrides: prune sibling paths without re-including ignored files.
 * Keep argument growth bounded; unusual spellings retain the type-filter fallback.
 */
function inventoryScopeExclusions(scope?: LiteralScope): string[] {
	if (!scope || scope.path === "." || !/^[\p{L}\p{N}_./]+$/u.test(scope.path)) return [];
	const exclusions: string[] = [];
	let prefix = "", bytes = 0;
	for (const component of scope.path.split("/")) {
		const chars = [...component];
		for (let i = 0; i < chars.length; i++) {
			const head = chars.slice(0, i).join("");
			exclusions.push(`!/${prefix}${head}[!${chars[i]}]*`);
			if (i > 0) exclusions.push(`!/${prefix}${head}`);
		}
		exclusions.push(`!/${prefix}${component}?*`);
		prefix += `${component}/`;
	}
	for (const exclusion of exclusions) bytes += Buffer.byteLength(exclusion) + 4;
	return bytes <= 24 * 1024 ? exclusions : [];
}
async function enumerate(patterns: string[], exclude: string[], ctx: ToolContext, state: RunState, scope?: LiteralScope): Promise<string[]> {
	check(state, ctx);
	if (scope) {
		const target = ctx.workspace.resolve(scope.path); const stat = statSync(target.abs);
		if (target.rel !== scope.path || (scope.directory ? !stat.isDirectory() : !stat.isFile())) throw new ToolError("Search scope changed during plan; rerun against current files");
	}
	const base = ["--no-config", "--files", "--null", "--sort", "path"];
	// A positive rg -g overrides .gitignore. Intersect it with a conservatively
	// type-filtered, ignore-respecting inventory so the plan cannot widen its scope.
	const typeGlobs = inventoryTypeGlobs(patterns, scope);
	const typeArgs = typeGlobs.length ? ["--type-clear", "mountainsquery", ...typeGlobs.flatMap(glob => ["--type-add", `mountainsquery:${glob}`]), "--type", "mountainsquery"] : [];
	const scopeArgs = inventoryScopeExclusions(scope).flatMap(pattern => ["-g", pattern]);
	const baseline = await runInState([...base, ...typeArgs, ...scopeArgs, "--", "."], ctx, state);
	const allowed = new Set(baseline.stdout.split("\0").filter(Boolean));
	const args = [...base];
	for (const p of patterns) args.push("-g", p);
	for (const p of exclude) args.push("-g", `!${p}`);
	args.push("--", ".");
	const result = scope ? baseline : await runInState(args, ctx, state);
	const raw = result.stdout.split("\0").filter((path) => {
		if (!path || !allowed.has(path)) return false;
		if (!scope) return true;
		const rel = ctx.workspace.rel(isAbsolute(path) ? path : join(ctx.workspace.root, path));
		return rel === scope.path || (scope.directory && (scope.path === "." || rel.startsWith(`${scope.path}/`)));
	});
	if (raw.length > state.limits.maxFiles) throw new ToolError("File enumeration limit exceeded; narrow the query");
	const paths = [...new Set(raw.map((p) => ctx.workspace.resolve(p).rel))].sort();
	return paths;
}
function pathValues(path: PlanPath, ctx: ToolContext, state: RunState, partialIndependent = false): string[] {
	if (typeof path === "string") {
		if (!partialIndependent) return [ctx.workspace.resolve(path).rel];
		// Check the boundary even for a missing path. Only an initially missing direct
		// input is local; a disappearing observed source remains a global failure.
		const candidate = ctx.workspace.resolve(path, { forWrite: true });
		try { return [ctx.workspace.resolve(path).rel]; }
		catch (error) {
			if (error instanceof ToolError && error.message.startsWith("文件不存在：") && !state.dependencies.has(candidate.rel)) throw new LocalQueryError(error.message);
			throw error;
		}
	}
	const step = state.steps.find((s) => s.id === path.from);
	const paths = [...new Set(step?.paths ?? [])];
	if (!paths.length) throw new LocalQueryError(`No paths from ${path.from}; no assumption of absence is saved`);
	if (path.expect === "one" && paths.length !== 1) throw new LocalQueryError(`Ambiguous path: ${path.from} returned ${paths.length}; choose explicitly or request all`);
	if (paths.length > state.limits.maxPaths) throw new ToolError("Path fan-out limit exceeded");
	return paths;
}
/** Output kept free after a truncated read so later steps can still report SKIPPED or FAILED. */
const READ_OUTPUT_RESERVE = 2048;
function appendOutput(state: RunState, value: string): void {
	const bytes = Buffer.byteLength(value) + 1;
	if (state.outputBytes + bytes > state.limits.maxOutputBytes) throw new ToolError("Cumulative output limit exceeded; incomplete result");
	state.outputBytes += bytes; state.output.push(value);
}
type SearchEvent = { type: string; data: { path?: { text?: string }; line_number: number; lines: { text?: string }; submatches: { start: number }[] } };
function appendSearchMatch(event: SearchEvent, path: string, hash: string, result: StepResult, state: RunState, lean: boolean): void {
	if (result.results.length >= state.limits.maxMatches) throw new ToolError("Match limit exceeded; incomplete search");
	const lineText = event.data.lines.text;
	if (typeof lineText !== "string") throw new ToolError("Unrepresentable search result; incomplete search");
	const col = Buffer.from(lineText).subarray(0, event.data.submatches[0]?.start ?? 0).toString("utf8").length + 1;
	const match = { path, line: event.data.line_number, col, text: lineText.replace(/\r?\n$/, ""), hash };
	result.results.push(match); result.paths.push(path);
	appendOutput(state, `[${result.id}] ${path}:${match.line}:${col}: ${match.text}${lean ? "" : ` | sha256:${hash}`}`);
}
/** Search immutable copies of bounded UTF-8 observations, never reopen mutable source paths in rg. */
async function searchBulk(step: Extract<QueryStep, { op: "search" }>, paths: string[], result: StepResult, ctx: ToolContext, state: RunState, lean: boolean): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "mountains-query-"));
	try {
		const sources = new Map<string, { path: string; hash: string }>();
		for (const path of paths) {
			const source = boundedRead(path, ctx, state, true);
			if (source.binary) continue;
			const snapshot = join(directory, String(sources.size));
			// The old implementation searched this same decoded byte sequence on stdin.
			// Private, exclusively created snapshots keep a parent-directory swap from
			// attaching outside text to the original source hash during the rg await.
			writeFileSync(snapshot, source.text, { flag: "wx", mode: 0o600 });
			sources.set(snapshot, { path, hash: source.hash });
		}
		const args = ["--no-config", "--json", "--text", "--encoding", "utf-8", "--threads", "1", ...(step.caseSensitive === false ? ["-i"] : []), "-e", step.pattern, "--"];
		const matches = new Map<string, SearchEvent[]>();
		const names = [...sources.keys()];
		// Empty scopes still validate the regular expression, without creating a result
		// from synthetic stdin or letting rg fall back to searching the workspace.
		if (!names.length) await runInState([...args, "-"], ctx, state, Buffer.alloc(0));
		let matchCount = 0;
		for (let at = 0; at < names.length;) {
			const batch: string[] = []; let argumentBytes = 0;
			while (at < names.length && batch.length < 256) {
				const name = names[at]!; const bytes = Buffer.byteLength(name) + 1;
				if (batch.length && argumentBytes + bytes > 24 * 1024) break;
				batch.push(name); argumentBytes += bytes; at++;
			}
			const rg = await runInState([...args, ...batch], ctx, state);
			const allowed = new Set(batch);
			for (const line of rg.stdout.split("\n").filter(Boolean)) {
				const event = JSON.parse(line) as SearchEvent;
				if (event.type !== "match") continue;
				const name = event.data.path?.text;
				if (typeof name !== "string" || !allowed.has(name)) throw new ToolError("Search returned a path outside its explicit scope");
				if (++matchCount > state.limits.maxMatches) throw new ToolError("Match limit exceeded; incomplete search");
				const found = matches.get(name) ?? []; found.push(event); matches.set(name, found);
			}
		}
		// Preserve the existing canonical JS path ordering, independent of rg's locale
		// and batching. Within each file, return the same line order as the old search.
		for (const [name, source] of sources) {
			for (const event of (matches.get(name) ?? []).sort((a, b) => a.data.line_number - b.data.line_number)) appendSearchMatch(event, source.path, source.hash, result, state, lean);
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Execute only built-in deterministic reads. All results are freshly observed. */
export async function executeQueryPlan(value: unknown, ctx: ToolContext, options: PlanOptions = {}, deadline?: number): Promise<ToolResult> {
	let state: RunState | undefined;
	try {
		const limits = limitsOf(options.limits); const plan = parsePlan(value, limits.maxSteps, ctx); const started = Date.now();
		state = { limits, started, deadline: Math.min(started + limits.maxDurationMs, deadline ?? Infinity), scanBytes: 0, files: 0, outputBytes: 0, processBytes: 0, dependencies: new Map(), inventories: [], steps: [], reads: [], output: [] };
		const readLimits = { ...DEFAULT_READ_LIMITS, ...options.read };
		if (readLimits.dedupeRanges !== undefined && typeof readLimits.dedupeRanges !== "boolean") throw new ToolError("dedupeRanges must be boolean");
		if (readLimits.dedupeRanges && readLimits.dedupe !== true) throw new ToolError("dedupeRanges requires dedupe=true");
		const stagedReads = new FileStateTracker();
		const hashNote = (hash: string) => options.lean ? "" : ` | sha256:${hash}`;
		for (const step of plan.steps) {
			check(state, ctx); const result: StepResult = { id: step.id, op: step.op, paths: [], results: [] };
			const outputStart = state.output.length; const bytesStart = state.outputBytes; const readsStart = state.reads.length;
			if ("path" in step && typeof step.path === "object") {
				const from = step.path.from;
				const dependency = state.steps.find(previous => previous.id === from);
				if (dependency?.status === "failed" || dependency?.status === "skipped") {
					const error = `Dependency ${step.path.from} did not complete; no source was read`;
					state.steps.push({ ...result, status: "skipped", error });
					appendOutput(state, `[${step.id}] SKIPPED: ${error}`); continue;
				}
			}
			try {
				if (step.op === "glob" || step.op === "search") {
					const patterns = step.op === "glob" ? step.patterns : [step.glob ?? "**/*"];
					const exclude = step.op === "glob" ? step.exclude ?? [] : [];
					const scope = step.op === "search" && step.path !== undefined ? { path: step.path, directory: statSync(ctx.workspace.resolve(step.path).abs).isDirectory() } : undefined;
					const paths = await enumerate(patterns, exclude, ctx, state, scope);
					state.inventories.push({ patterns, exclude, paths, ...(scope ? { scope } : {}) });
					if (step.op === "glob") {
						state.files += paths.length;
						if (state.files > limits.maxFiles) throw new ToolError("Cumulative file limit exceeded");
						if (paths.length > limits.maxPaths) throw new ToolError("Glob result exceeds path limit; narrow the query");
						result.paths = paths; appendOutput(state, `[${step.id}] ${paths.length} paths\n${paths.join("\n")}`);
					} else {
						await searchBulk(step, paths, result, ctx, state, options.lean === true);
						result.paths = [...new Set(result.paths)];
					}
					if (!result.paths.length) {
						if (step.op === "search") appendOutput(state, `[${step.id}] 0 matches in the current search scope; this is not a cached absence claim`);
					}
				} else {
					for (const path of pathValues(step.path, ctx, state, true)) {
						const source = boundedRead(path, ctx, state); const { lines } = splitLines(source.text); const total = lines.length;
						result.paths.push(source.path);
						if (step.op === "json_field") {
							let value: unknown;
							try { value = JSON.parse(source.text); }
							catch (error) { throw new LocalQueryError(error instanceof Error ? error.message : String(error)); }
							for (const key of step.field) {
								if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new LocalQueryError(`Missing JSON field ${step.field.join(".")} in ${path}`);
								value = (value as Record<string, unknown>)[key];
							}
							result.results.push({ path, field: step.field, value, hash: source.hash });
							appendOutput(state, `[${step.id}] ${path} ${JSON.stringify(step.field)} = ${JSON.stringify(value)}${hashNote(source.hash)}`);
						} else if (step.op === "outline") {
							const entries = outlineLines(path, source.text);
							if (!entries.length) throw new LocalQueryError(`No definitions recognised in ${path}; read the source explicitly`);
							if (entries.some((e) => e.text.endsWith("…"))) throw new LocalQueryError(`Outline line truncated in ${path}; read the source explicitly`);
							result.results.push({ path, entries, hash: source.hash, heuristic: true });
							appendOutput(state, `[${step.id}] ${path} definitions (lexical outline, not a complete syntax parse)${hashNote(source.hash)}\n${entries.map((e) => `${e.line}\t${e.text}`).join("\n")}`);
						} else {
							let start = step.startLine ?? 1; let requestedEnd = step.endLine;
							if (step.symbol) {
								if (!/\.pyi?$/.test(path)) throw new LocalQueryError("Symbol queries currently support Python only");
								let found: ReturnType<typeof findSymbol>;
								try { found = findSymbol(lines, step.symbol); }
								catch (error) { if (error instanceof ToolError) throw new LocalQueryError(error.message); throw error; }
								if (found.length !== 1) throw new LocalQueryError(`Symbol ${step.symbol} is missing or ambiguous (${found.length} definitions)`);
								start = found[0]!.start; requestedEnd = found[0]!.end;
							}
							const end = Math.min(requestedEnd ?? total, total);
							if (total && start > total) throw new LocalQueryError(`Read starts beyond ${path}`);
							if (end - start + 1 > readLimits.maxLines) throw new LocalQueryError(`Requested read exceeds ${readLimits.maxLines} lines; specify a smaller range`);
							const selected = lines.slice(start - 1, end);
							if (selected.some((l) => l.length > readLimits.maxLineChars)) throw new LocalQueryError(`Read line exceeds ${readLimits.maxLineChars} characters; no truncated result is passed onward`);
							const record = { path, startLine: total ? start : 0, endLine: end, totalLines: total, hash: source.hash };
							let ranges = total ? [{ start, end }] : [];
							const header = `[${step.id}] ${path} | lines ${record.startLine}-${end} of ${total}${hashNote(source.hash)}`;
							const rows = selected.map((l, i) => `${start + i}\t${l}`);
							let output = `${header}\n${rows.join("\n")}`;
							let deduped = false;
							if (readLimits.dedupe && step.force !== true && total) {
								const missing = ctx.files.undeliveredRanges(path, source.hash, start, end)
									.flatMap(range => stagedReads.undeliveredRanges(path, source.hash, range.start, range.end));
								if (!missing.length) {
									output = `[${step.id}] ${path} | requested lines ${start}-${end}${hashNote(source.hash)} | unchanged and already shown earlier or in this query; force=true re-sends this range`;
									ranges = []; deduped = true;
								} else if (readLimits.dedupeRanges && (missing.length !== 1 || missing[0]!.start !== start || missing[0]!.end !== end)) {
									const compact = buildIncrementalReadText({ label: `[${step.id}] ${path}`, header, rows, startLine: start, missing });
									if (Buffer.byteLength(compact) < Buffer.byteLength(output)) { output = compact; ranges = missing; deduped = true; }
								}
							}
							// A read larger than the query's remaining output returns the lines that fit and an exact
							// continuation, instead of failing the whole query with nothing shown (seen 2026-10-10:
							// three wasted requests on a 100 KB file). A small reserve keeps room for later step notes.
							const room = state.limits.maxOutputBytes - state.outputBytes - 1 - READ_OUTPUT_RESERVE;
							if (!deduped && total && Buffer.byteLength(output) > room) {
								const cutHeader = (cut: number) => `[${step.id}] ${path} | lines ${start}-${cut} of ${total}${hashNote(source.hash)} | output limit reached; continue with startLine=${cut + 1}`;
								let used = Buffer.byteLength(cutHeader(end)), fit = 0;
								while (fit < rows.length && used + Buffer.byteLength(rows[fit]!) + 1 <= room) used += Buffer.byteLength(rows[fit++]!) + 1;
								if (!fit) throw new LocalQueryError(`Query output limit reached before ${path}; read it in a separate call`);
								const cut = start + fit - 1;
								output = `${cutHeader(cut)}\n${rows.slice(0, fit).join("\n")}`;
								ranges = [{ start, end: cut }]; record.endLine = cut;
							}
							appendOutput(state, output);
							const published = ranges.map(range => ({ path, startLine: range.start, endLine: range.end, totalLines: total, hash: source.hash }));
							state.reads.push(...published);
							result.results.push(deduped ? { path, requestedStartLine: start, requestedEndLine: end, totalLines: total, hash: source.hash, deduped: true, ranges: published } : record);
						}
					}
				}
				result.status = "complete";
				state.steps.push(result);
				for (const read of state.reads.slice(readsStart)) stagedReads.markDelivered(read.path, read.hash, read.startLine, read.endLine);
			} catch (error) {
				if (!(error instanceof LocalQueryError)) throw error;
				// A step commits all of its output and permissions together. Never retain
				// an early file from a failed fan-out or let it suppress a later read.
				state.output.length = outputStart; state.outputBytes = bytesStart; state.reads.length = readsStart;
				state.steps.push({ id: step.id, op: step.op, paths: [], results: [], status: "failed", error: error.message });
				appendOutput(state, `[${step.id}] FAILED: ${error.message}`);
			}
		}
		// Recheck both positive evidence and search scope before publishing any result.
		for (const inventory of state.inventories) {
			const current = await enumerate(inventory.patterns, inventory.exclude, ctx, state, inventory.scope);
			if (JSON.stringify(current) !== JSON.stringify(inventory.paths)) throw new ToolError("Search scope changed during plan; rerun against current files");
		}
		check(state, ctx);
		const incomplete = state.steps.some(step => step.status === "failed" || step.status === "skipped");
		const completed = state.steps.filter(step => step.status !== "failed" && step.status !== "skipped").length;
		const result: ToolResult = { ok: !incomplete, modelContent: state.output.join("\n"), summary: incomplete ? `完成 ${completed}/${state.steps.length} 步查询；失败步骤已明确列出` : `完成 ${state.steps.length} 步只读查询`, reads: state.reads,
			details: { complete: !incomplete, status: incomplete ? "partial" : "complete", version: QUERY_PLAN_VERSION, steps: state.steps, scanBytes: state.scanBytes, scannedFiles: state.files, outputBytes: state.outputBytes, processBytes: state.processBytes, durationMs: Date.now() - started } };
		resultStates.set(result, state); verifyQueryResultCurrent(result, ctx);
		if (incomplete) { result.details.partial = true; result.details.receiptsVerified = true; }
		return result;
	} catch (e) {
		return fail(e instanceof Error ? e.message : String(e), state ? { completedSteps: state.steps.filter(s => s.status !== "failed" && s.status !== "skipped").map(s => s.id), scanBytes: state.scanBytes, scannedFiles: state.files, durationMs: Date.now() - state.started } : {});
	}
}

export function createPlanTool(options: PlanOptions = {}): ToolDefinition {
	return { name: "query_plan", logicalName: "query.plan", readOnly: true,
		description: "Run a bounded JSON plan of search/glob/read/outline/json_field steps in one call. Path may reference a preceding step via {from: id, expect: one|all}; duplicates are removed. No shell or JavaScript. Independent steps retain verified results when another step fails locally; dependent steps are skipped. Empty searches are valid current observations. Source/scope changes, cancellation or resource limits invalidate the whole call." +
			" Search path is a literal workspace file/directory scope, mutually exclusive with glob. For glob steps, singular pattern or glob is accepted as one patterns entry; conflicting field names are rejected." +
			(options.read?.dedupe ? " Already shown source lines may be omitted; read force=true re-sends them." : "") +
			' Example: {"steps":[{"id":"f","op":"glob","patterns":["src/*.ts"]},{"id":"r","op":"read","path":{"from":"f","expect":"all"}}]}',
		parameters: { type: "object", properties: { steps: { type: "array", minItems: 1, maxItems: options.limits?.maxSteps ?? DEFAULT_PLAN_LIMITS.maxSteps,
			items: { type: "object", properties: { id: { type: "string" }, op: { type: "string", enum: ["search", "glob", "read", "outline", "json_field"] },
				pattern: { type: "string" }, glob: { type: "string" }, caseSensitive: { type: "boolean" }, patterns: { type: "array", items: { type: "string" } }, exclude: { type: "array", items: { type: "string" } },
				path: { oneOf: [{ type: "string" }, { type: "object", properties: { from: { type: "string" }, expect: { type: "string", enum: ["one", "all"] } }, required: ["from", "expect"], additionalProperties: false }] },
				startLine: { type: "integer" }, endLine: { type: "integer" }, symbol: { type: "string" }, ...(options.read?.dedupe ? { force: { type: "boolean", description: "With read: re-send already shown source" } } : {}), field: { type: "array", items: { type: "string" }, description: "Own-property JSON path, e.g. [scripts,test]" } }, required: ["id", "op"], additionalProperties: false } },
			}, required: ["steps"], additionalProperties: false },
		async execute(args, ctx) {
			try {
				const deadline = Date.now() + limitsOf(options.limits).maxDurationMs;
				keys(args, ["steps"]);
				const plan = parsePlan({ steps: args.steps }, options.limits?.maxSteps ?? DEFAULT_PLAN_LIMITS.maxSteps, ctx);
				return publishQueryResult(await executeQueryPlan(plan, ctx, options, deadline), ctx);
			} catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
		} };
}
