import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DEFAULT_READ_LIMITS, findSymbol, splitLines, type ReadLimits } from "./files.ts";
import { outlineLines } from "./outline.ts";
import type { ToolContext, ToolDefinition, ToolResult, ReadRecord } from "./types.ts";
import { sha256, ToolError } from "./workspace.ts";
import type { QueryRecipeStore } from "./recipes.ts";

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
	{ op: "search"; pattern: string; glob?: string; caseSensitive?: boolean } |
	{ op: "glob"; patterns: string[]; exclude?: string[] } |
	{ op: "read"; path: PlanPath; startLine?: number; endLine?: number; symbol?: string } |
	{ op: "outline"; path: PlanPath } |
	{ op: "json_field"; path: PlanPath; field: string[] }
);
export interface QueryPlan { steps: QueryStep[] }
export interface PlanOptions { read?: Partial<ReadLimits>; limits?: Partial<PlanLimits>; recipes?: QueryRecipeStore }
export interface QueryEnvironment {
	version: string; workspace: string; platform: string; node: string; identity: string;
	rootMode: number; rg: string; rgVersion: string; pathHash: string; gitHead: string | null; gitBranch: string | null;
}
interface StepResult { id: string; op: string; paths: string[]; results: Record<string, unknown>[] }
interface RunState {
	limits: PlanLimits; started: number; deadline: number; scanBytes: number; files: number; outputBytes: number; processBytes: number;
	dependencies: Map<string, string>; inventories: { patterns: string[]; exclude: string[]; paths: string[] }[];
	steps: StepResult[]; reads: ReadRecord[]; output: string[];
}
const resultStates = new WeakMap<ToolResult, RunState>();
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
	if (result.ok) {
		verifyQueryResultCurrent(result, ctx);
		const outputBytes = Buffer.byteLength(result.modelContent);
		if (outputBytes > resultStates.get(result)!.limits.maxOutputBytes) throw new ToolError("Cumulative output limit exceeded before publication");
		result.details.outputBytes = outputBytes;
		for (const read of result.reads ?? []) ctx.files.record(read.path, read.hash);
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
export function validateQueryPlan(value: unknown, maxSteps = DEFAULT_PLAN_LIMITS.maxSteps): QueryPlan {
	const plan = object(value); keys(plan, ["steps"]);
	if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > maxSteps) throw new ToolError(`steps must contain 1-${maxSteps} entries`);
	const ids = new Set<string>();
	for (const raw of plan.steps) {
		const s = object(raw); const id = text(s.id, "step id", 40);
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new ToolError("Step IDs must be unique identifiers");
		if (s.op === "search") {
			keys(s, ["id", "op", "pattern", "glob", "caseSensitive"]); text(s.pattern, "pattern");
			if (s.glob !== undefined) text(s.glob, "glob");
			if (s.caseSensitive !== undefined && typeof s.caseSensitive !== "boolean") throw new ToolError("Invalid caseSensitive");
		} else if (s.op === "glob") {
			keys(s, ["id", "op", "patterns", "exclude"]); strings(s.patterns, "patterns");
			if (s.exclude !== undefined) strings(s.exclude, "exclude");
		} else if (["read", "outline", "json_field"].includes(String(s.op))) {
			keys(s, ["id", "op", "path", ...(s.op === "read" ? ["startLine", "endLine", "symbol"] : s.op === "json_field" ? ["field"] : [])]);
			if (typeof s.path === "string") text(s.path, "path");
			else {
				const ref = object(s.path); keys(ref, ["from", "expect"]);
				if (!ids.has(text(ref.from, "reference")) || !["one", "all"].includes(String(ref.expect))) throw new ToolError("Path references require a preceding step and expect=one|all");
			}
			if (s.op === "json_field") strings(s.field, "field");
			if (s.op === "read") {
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
function check(state: RunState, ctx: ToolContext): void {
	if (ctx.signal.aborted) throw new ToolError("Query cancelled");
	if (Date.now() >= state.deadline) throw new ToolError("Query time limit exceeded");
}
/** No shell, bounded stdout+stderr, and the deadline also covers hung children. */
export function runQueryProcess(command: string, args: string[], ctx: ToolContext, deadline: number, maxBytes: number, input?: Buffer): Promise<{ code: number; stdout: string; bytes: number }> {
	return new Promise((resolve, reject) => {
		if (ctx.signal.aborted || Date.now() >= deadline) { reject(new ToolError("Query cancelled or timed out")); return; }
		const child = spawn(command, args, { cwd: ctx.workspace.root, stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true });
		const chunks: Buffer[] = []; let count = 0; let failure: Error | undefined; let stderr = "";
		const stop = (reason: string) => { failure ??= new ToolError(reason); child.kill("SIGKILL"); };
		const abort = () => stop("Query cancelled");
		ctx.signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => stop("Query time limit exceeded"), Math.max(1, deadline - Date.now()));
		const collect = (b: Buffer, out: boolean) => {
			count += b.length;
			if (count > maxBytes) { stop("Query process output limit exceeded; incomplete result"); return; }
			if (out) chunks.push(b); else stderr += b.toString("utf8");
		};
		child.stdout.on("data", (b: Buffer) => collect(b, true)); child.stderr.on("data", (b: Buffer) => collect(b, false));
		child.stdin.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") failure ??= err; });
		child.on("error", (err) => { failure ??= err; });
		child.on("close", (code) => {
			clearTimeout(timer); ctx.signal.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code === null || code > 1 || stderr.trim()) reject(new ToolError(`Query process failed or incomplete: ${stderr.slice(0, 300) || code}`));
			else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), bytes: count });
		});
		child.stdin.end(input);
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
export async function queryEnvironment(ctx: ToolContext, deadline = Date.now() + 5000): Promise<QueryEnvironment> {
	const rg = rgCommand();
	const version = await runQueryProcess(rg, ["--no-config", "--version"], ctx, deadline, 4096);
	let gitHead: string | null = null; let gitBranch: string | null = null;
	try { gitBranch = (await runQueryProcess("git", ["symbolic-ref", "--quiet", "HEAD"], ctx, deadline, 4096)).stdout.trim() || "DETACHED"; } catch { /* Not a repository. */ }
	try { gitHead = (await runQueryProcess("git", ["rev-parse", "HEAD"], ctx, deadline, 4096)).stdout.trim(); } catch { /* No commit yet, or not a repository. */ }
	return { version: QUERY_PLAN_VERSION, workspace: sha256(ctx.workspace.root), platform: `${process.platform}/${process.arch}`, node: process.version,
		identity: `${process.getuid?.() ?? "unknown"}:${process.getgid?.() ?? "unknown"}`, rootMode: statSync(ctx.workspace.root).mode,
		rg, rgVersion: version.stdout.trim(), pathHash: sha256(process.env.PATH ?? ""), gitHead, gitBranch };
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
async function enumerate(patterns: string[], exclude: string[], ctx: ToolContext, state: RunState): Promise<string[]> {
	check(state, ctx);
	const base = ["--no-config", "--files", "--null", "--sort", "path"];
	// A positive rg -g overrides .gitignore. Intersect it with the unfiltered,
	// ignore-respecting inventory so the plan cannot silently widen its scope.
	const baseline = await runInState([...base, "--", "."], ctx, state);
	const allowed = new Set(baseline.stdout.split("\0").filter(Boolean));
	const args = [...base];
	for (const p of patterns) args.push("-g", p);
	for (const p of exclude) args.push("-g", `!${p}`);
	args.push("--", ".");
	const result = await runInState(args, ctx, state);
	const raw = result.stdout.split("\0").filter((path) => path && allowed.has(path));
	if (raw.length > state.limits.maxFiles) throw new ToolError("File enumeration limit exceeded; narrow the query");
	const paths = [...new Set(raw.map((p) => ctx.workspace.resolve(p).rel))].sort();
	return paths;
}
function pathValues(path: PlanPath, ctx: ToolContext, state: RunState): string[] {
	if (typeof path === "string") return [ctx.workspace.resolve(path).rel];
	const step = state.steps.find((s) => s.id === path.from);
	const paths = [...new Set(step?.paths ?? [])];
	if (!paths.length) throw new ToolError(`No paths from ${path.from}; no assumption of absence is saved`);
	if (path.expect === "one" && paths.length !== 1) throw new ToolError(`Ambiguous path: ${path.from} returned ${paths.length}; choose explicitly or request all`);
	if (paths.length > state.limits.maxPaths) throw new ToolError("Path fan-out limit exceeded");
	return paths;
}
function appendOutput(state: RunState, value: string): void {
	const bytes = Buffer.byteLength(value) + 1;
	if (state.outputBytes + bytes > state.limits.maxOutputBytes) throw new ToolError("Cumulative output limit exceeded; incomplete result");
	state.outputBytes += bytes; state.output.push(value);
}
function portablePlan(plan: QueryPlan, ctx: ToolContext): QueryPlan {
	const copy = validateQueryPlan(plan, HARD_LIMITS.maxSteps);
	for (const step of copy.steps) {
		if ("path" in step && typeof step.path === "string") step.path = ctx.workspace.resolve(step.path).rel;
		// Absolute filter roots cannot be rebound safely to another session.
		for (const filter of step.op === "glob" ? [...step.patterns, ...(step.exclude ?? [])] : step.op === "search" && step.glob ? [step.glob] : []) {
			if (isAbsolute(filter) || filter.split(/[\\/]/).includes("..")) throw new ToolError("Recipe filters must be workspace-relative");
		}
	}
	return copy;
}

/** Execute only built-in deterministic reads. All results are freshly observed. */
export async function executeQueryPlan(value: unknown, ctx: ToolContext, options: PlanOptions = {}, deadline?: number): Promise<ToolResult> {
	let state: RunState | undefined;
	try {
		const limits = limitsOf(options.limits); const plan = validateQueryPlan(value, limits.maxSteps); const started = Date.now();
		state = { limits, started, deadline: Math.min(started + limits.maxDurationMs, deadline ?? Infinity), scanBytes: 0, files: 0, outputBytes: 0, processBytes: 0, dependencies: new Map(), inventories: [], steps: [], reads: [], output: [] };
		const readLimits = { ...DEFAULT_READ_LIMITS, ...options.read };
		for (const step of plan.steps) {
			check(state, ctx); const result: StepResult = { id: step.id, op: step.op, paths: [], results: [] };
			if (step.op === "glob" || step.op === "search") {
				const patterns = step.op === "glob" ? step.patterns : [step.glob ?? "**/*"];
				const exclude = step.op === "glob" ? step.exclude ?? [] : [];
				const paths = await enumerate(patterns, exclude, ctx, state);
				state.inventories.push({ patterns, exclude, paths });
				if (step.op === "glob") {
					state.files += paths.length;
					if (state.files > limits.maxFiles) throw new ToolError("Cumulative file limit exceeded");
					if (paths.length > limits.maxPaths) throw new ToolError("Glob result exceeds path limit; narrow the query");
					result.paths = paths; appendOutput(state, `[${step.id}] ${paths.length} paths\n${paths.join("\n")}`);
				} else {
					for (const path of paths) {
						const source = boundedRead(path, ctx, state, true);
						if (source.binary) continue;
						const args = ["--no-config", "--json", "--text", ...(step.caseSensitive === false ? ["-i"] : []), "-e", step.pattern, "--", "-"];
						const rg = await runInState(args, ctx, state, Buffer.from(source.text));
						for (const line of rg.stdout.split("\n").filter(Boolean)) {
							const event = JSON.parse(line) as { type: string; data: { line_number: number; lines: { text?: string }; submatches: { start: number }[] } };
							if (event.type !== "match") continue;
							if (result.results.length >= limits.maxMatches) throw new ToolError("Match limit exceeded; incomplete search");
							const lineText = event.data.lines.text;
							if (typeof lineText !== "string") throw new ToolError("Unrepresentable search result; incomplete search");
							const col = Buffer.from(lineText).subarray(0, event.data.submatches[0]?.start ?? 0).toString("utf8").length + 1;
							const match = { path, line: event.data.line_number, col, text: lineText.replace(/\r?\n$/, ""), hash: source.hash };
							result.results.push(match); result.paths.push(path);
							appendOutput(state, `[${step.id}] ${path}:${match.line}:${col}: ${match.text} | sha256:${source.hash}`);
						}
					}
					result.paths = [...new Set(result.paths)];
				}
				if (!result.paths.length) throw new ToolError(`No results for ${step.id}; stop and reassess (absence is not cached)`);
			} else {
				for (const path of pathValues(step.path, ctx, state)) {
					const source = boundedRead(path, ctx, state); const { lines } = splitLines(source.text); const total = lines.length;
					result.paths.push(source.path);
					if (step.op === "json_field") {
						let value: unknown = JSON.parse(source.text);
						for (const key of step.field) {
							if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new ToolError(`Missing JSON field ${step.field.join(".")} in ${path}`);
							value = (value as Record<string, unknown>)[key];
						}
						result.results.push({ path, field: step.field, value, hash: source.hash });
						appendOutput(state, `[${step.id}] ${path} ${JSON.stringify(step.field)} = ${JSON.stringify(value)} | sha256:${source.hash}`);
					} else if (step.op === "outline") {
						const entries = outlineLines(path, source.text);
						if (!entries.length) throw new ToolError(`No definitions recognised in ${path}; read the source explicitly`);
						if (entries.some((e) => e.text.endsWith("…"))) throw new ToolError(`Outline line truncated in ${path}; read the source explicitly`);
						result.results.push({ path, entries, hash: source.hash, heuristic: true });
						appendOutput(state, `[${step.id}] ${path} definitions (lexical outline, not a complete syntax parse) | sha256:${source.hash}\n${entries.map((e) => `${e.line}\t${e.text}`).join("\n")}`);
					} else {
						let start = step.startLine ?? 1; let requestedEnd = step.endLine;
						if (step.symbol) {
							if (!/\.pyi?$/.test(path)) throw new ToolError("Symbol queries currently support Python only");
							const found = findSymbol(lines, step.symbol);
							if (found.length !== 1) throw new ToolError(`Symbol ${step.symbol} is missing or ambiguous (${found.length} definitions)`);
							start = found[0]!.start; requestedEnd = found[0]!.end;
						}
						const end = Math.min(requestedEnd ?? total, total);
						if (total && start > total) throw new ToolError(`Read starts beyond ${path}`);
						if (end - start + 1 > readLimits.maxLines) throw new ToolError(`Requested read exceeds ${readLimits.maxLines} lines; specify a smaller range`);
						const selected = lines.slice(start - 1, end);
						if (selected.some((l) => l.length > readLimits.maxLineChars)) throw new ToolError(`Read line exceeds ${readLimits.maxLineChars} characters; no truncated result is passed onward`);
						const record = { path, startLine: total ? start : 0, endLine: end, totalLines: total, hash: source.hash };
						state.reads.push(record); result.results.push(record);
						appendOutput(state, `[${step.id}] ${path} | lines ${record.startLine}-${end} of ${total} | sha256:${source.hash}\n${selected.map((l, i) => `${start + i}\t${l}`).join("\n")}`);
					}
				}
			}
			state.steps.push(result);
		}
		// Recheck both positive evidence and search scope before publishing any result.
		for (const inventory of state.inventories) {
			const current = await enumerate(inventory.patterns, inventory.exclude, ctx, state);
			if (JSON.stringify(current) !== JSON.stringify(inventory.paths)) throw new ToolError("Search scope changed during plan; rerun against current files");
		}
		check(state, ctx);
		const result: ToolResult = { ok: true, modelContent: state.output.join("\n"), summary: `完成 ${state.steps.length} 步只读查询`, reads: state.reads,
			details: { complete: true, status: "complete", version: QUERY_PLAN_VERSION, steps: state.steps, scanBytes: state.scanBytes, scannedFiles: state.files, outputBytes: state.outputBytes, processBytes: state.processBytes, durationMs: Date.now() - started } };
		resultStates.set(result, state); verifyQueryResultCurrent(result, ctx);
		return result;
	} catch (e) {
		return fail(e instanceof Error ? e.message : String(e), state ? { completedSteps: state.steps.map((s) => s.id), scanBytes: state.scanBytes, scannedFiles: state.files, durationMs: Date.now() - state.started } : {});
	}
}

export function createPlanTool(options: PlanOptions = {}): ToolDefinition {
	return { name: "query_plan", logicalName: "query.plan", readOnly: !options.recipes,
		description: "Run a bounded JSON plan of search/glob/read/outline/json_field steps in one call. Path may reference a preceding step via {from: id, expect: one|all}; duplicates are removed. No shell or JavaScript. Stops on ambiguity, missing results, source changes or limits. Optional saveAs stores only a workspace-relative replay method, never old results.",
		parameters: { type: "object", properties: { steps: { type: "array", minItems: 1, maxItems: options.limits?.maxSteps ?? DEFAULT_PLAN_LIMITS.maxSteps,
			items: { type: "object", properties: { id: { type: "string" }, op: { type: "string", enum: ["search", "glob", "read", "outline", "json_field"] },
				pattern: { type: "string" }, glob: { type: "string" }, caseSensitive: { type: "boolean" }, patterns: { type: "array", items: { type: "string" } }, exclude: { type: "array", items: { type: "string" } },
				path: { oneOf: [{ type: "string" }, { type: "object", properties: { from: { type: "string" }, expect: { type: "string", enum: ["one", "all"] } }, required: ["from", "expect"], additionalProperties: false }] },
				startLine: { type: "integer" }, endLine: { type: "integer" }, symbol: { type: "string" }, field: { type: "array", items: { type: "string" }, description: "Own-property JSON path, e.g. [scripts,test]" } }, required: ["id", "op"], additionalProperties: false } },
			...(options.recipes ? { saveAs: { type: "string", description: "Short label for the replayable method" } } : {}) }, required: ["steps"], additionalProperties: false },
		async execute(args, ctx) {
			try {
				const deadline = Date.now() + limitsOf(options.limits).maxDurationMs;
				keys(args, ["steps", ...(options.recipes ? ["saveAs"] : [])]);
				const name = args.saveAs === undefined ? undefined : text(args.saveAs, "saveAs", 120);
				const plan = validateQueryPlan({ steps: args.steps }, options.limits?.maxSteps ?? DEFAULT_PLAN_LIMITS.maxSteps);
				const portable = name ? portablePlan(plan, ctx) : undefined;
				const environment = name ? await queryEnvironment(ctx, deadline) : undefined;
				const result = await executeQueryPlan(plan, ctx, options, deadline);
				if (result.ok && name && portable && environment && options.recipes) {
					const suffix = `\nSaved method q_0000000000000000 (${name}); replay always queries current files.`;
					if (Buffer.byteLength(result.modelContent + suffix) > limitsOf(options.limits).maxOutputBytes) return fail("Cumulative output limit exceeded; recipe was not saved");
					const current = await queryEnvironment(ctx, deadline);
					if (JSON.stringify(current) !== JSON.stringify(environment)) return fail("Environment changed; recipe was not saved");
					verifyQueryResultCurrent(result, ctx);
					const recipe = options.recipes.save(name, portable, environment, ctx.workspace.root);
					verifyQueryResultCurrent(result, ctx);
					result.details.recipeId = recipe.id; result.modelContent += `\nSaved method ${recipe.id} (${name}); replay always queries current files.`;
				}
				return publishQueryResult(result, ctx);
			} catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
		} };
}
