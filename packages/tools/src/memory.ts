import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.ts";
import { sha256, type Workspace } from "./workspace.ts";

export const MEMORY_LIMITS = {
	maxNoteChars: 500, maxEvidence: 3, maxEvidenceLines: 60, maxDependencies: 12,
	maxFileBytes: 2 * 1024 * 1024, maxSourceBytes: 2 * 1024 * 1024,
	maxEntries: 2000, maxEventBytes: 32 * 1024, maxPromptChars: 6000, maxEvidenceScanLines: 10000,
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface MemoryEvidence { path: string; startLine: number; endLine: number; sha256: string }
export type MemoryDependency =
	| { kind: "file"; path: string; sha256: string }
	| { kind: "json-field"; path: string; selector: string; sha256: string };
export interface MemoryScope { workspace: string; module: string; environment: string; branch: string | null }
export interface MemoryFact {
	kind: "json-field" | "package-script";
	path: string;
	selector: string;
	/** Generated from the canonical source, never supplied by the model. */
	key: string;
	value: JsonValue;
}
export interface MemoryEntry {
	id: string;
	text: string;
	evidence: MemoryEvidence[];
	createdAt: string;
	commit: string | null;
	fact?: MemoryFact;
	scope?: MemoryScope;
	dependencies?: MemoryDependency[];
	coverage?: "source-only" | "declared-complete" | "incomplete";
	supersededBy?: string;
	removedAt?: string;
}

type NewEntry = Omit<MemoryEntry, "id" | "supersededBy" | "removedAt">;
interface Transaction { id: string; digest: string; result: string | boolean }
interface Snapshot {
	format: "mountains-memory";
	version: 2;
	revision: number;
	entries: MemoryEntry[];
	retiredIds: string[];
	transactions: Transaction[];
}
interface Loaded { snapshot: Snapshot; raw: string; legacy: boolean; tail?: string }
export interface MemoryWriteOptions { expectedRevision?: number; transactionId?: string }
export class MemoryStoreError extends Error {
	constructor(message: string) { super(message); this.name = "MemoryStoreError"; }
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const identifier = (v: unknown): v is string => bounded(v, 80) && /^m(?:[1-9]\d*|-[a-f0-9-]{36})$/.test(v);
const timestamp = (v: unknown): v is string => bounded(v, 40) && Number.isFinite(Date.parse(v));
function localPath(v: unknown): v is string {
	return bounded(v, 2048) && !isAbsolute(v) && !v.includes("\\") && !v.includes("\0") && !v.split("/").some((p) => p === ".." || p === "" || p === ".");
}
function selectorParts(selector: string): string[] {
	if (!selector.startsWith("/") || /~(?:[^01]|$)/.test(selector)) throw new MemoryStoreError("JSON 字段位置无效");
	return selector.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}
function canonical(value: JsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k]!)}`).join(",")}}`;
}
function jsonValue(v: unknown, depth = 0): v is JsonValue {
	if (depth > 12) return false;
	if (v === null || typeof v === "string" || typeof v === "boolean") return true;
	if (typeof v === "number") return Number.isFinite(v);
	return Array.isArray(v) ? v.every((x) => jsonValue(x, depth + 1)) : record(v) && Object.values(v).every((x) => jsonValue(x, depth + 1));
}
function factKey(path: string, selector: string): string { return `json:${path}#${selector}`; }
function scopeKey(scope: MemoryScope | undefined): string { return scope ? JSON.stringify([scope.workspace, scope.module, scope.environment, scope.branch]) : "unscoped"; }
function validEvidence(v: unknown): v is MemoryEvidence {
	return record(v) && localPath(v.path) && Number.isSafeInteger(v.startLine) && Number.isSafeInteger(v.endLine)
		&& (v.startLine as number) >= 1 && (v.endLine as number) >= (v.startLine as number)
		&& (v.endLine as number) - (v.startLine as number) < MEMORY_LIMITS.maxEvidenceLines && digest(v.sha256);
}
function validDependency(v: unknown): v is MemoryDependency {
	if (!record(v) || !localPath(v.path) || !digest(v.sha256)) return false;
	if (v.kind === "file") return v.selector === undefined;
	if (v.kind !== "json-field" || !bounded(v.selector, 1024)) return false;
	try { selectorParts(v.selector); return true; } catch { return false; }
}
function validScope(v: unknown): v is MemoryScope {
	return record(v) && bounded(v.workspace, 4096) && isAbsolute(v.workspace)
		&& (v.module === "." || localPath(v.module)) && bounded(v.environment, 256)
		&& (v.branch === null || bounded(v.branch, 512));
}
function validFact(v: unknown): v is MemoryFact {
	if (!record(v) || !["json-field", "package-script"].includes(String(v.kind)) || !localPath(v.path)
		|| !bounded(v.selector, 1024) || v.key !== factKey(v.path, v.selector) || !jsonValue(v.value)
		|| canonical(v.value).length > MEMORY_LIMITS.maxNoteChars) return false;
	try {
		const parts = selectorParts(v.selector);
		return v.kind !== "package-script" || (basename(v.path) === "package.json" && parts.length === 2 && parts[0] === "scripts" && !!parts[1] && typeof v.value === "string");
	} catch { return false; }
}
function validateEntry(v: unknown): asserts v is MemoryEntry {
	if (!record(v) || !identifier(v.id) || !bounded(v.text, MEMORY_LIMITS.maxNoteChars) || !v.text.trim()
		|| !timestamp(v.createdAt) || !(v.commit === null || (typeof v.commit === "string" && /^[a-f0-9]{40,64}$/.test(v.commit)))
		|| !Array.isArray(v.evidence) || v.evidence.length > MEMORY_LIMITS.maxEvidence || !v.evidence.every(validEvidence)
		|| (v.scope !== undefined && !validScope(v.scope)) || (v.fact !== undefined && !validFact(v.fact))
		|| (v.dependencies !== undefined && (!Array.isArray(v.dependencies) || v.dependencies.length > MEMORY_LIMITS.maxDependencies || !v.dependencies.every(validDependency)))
		|| (v.coverage !== undefined && !["source-only", "declared-complete", "incomplete"].includes(String(v.coverage)))
		|| (v.supersededBy !== undefined && !identifier(v.supersededBy)) || (v.removedAt !== undefined && !timestamp(v.removedAt))
		|| Buffer.byteLength(JSON.stringify(v)) > MEMORY_LIMITS.maxEventBytes) throw new MemoryStoreError("记忆条目格式或大小无效，已停用该库");
}
function emptySnapshot(): Snapshot { return { format: "mountains-memory", version: 2, revision: 0, entries: [], retiredIds: [], transactions: [] }; }
function validateSnapshot(value: unknown): asserts value is Snapshot {
	if (!record(value) || value.format !== "mountains-memory" || value.version !== 2 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
		|| !Array.isArray(value.entries) || value.entries.length > MEMORY_LIMITS.maxEntries || !Array.isArray(value.retiredIds)
		|| value.retiredIds.length > MEMORY_LIMITS.maxEntries || !value.retiredIds.every(identifier)
		|| !Array.isArray(value.transactions) || value.transactions.length > 64) throw new MemoryStoreError("记忆快照格式无效，已停用该库");
	value.entries.forEach(validateEntry);
	const ids = new Set(value.entries.map((e) => e.id));
	const retired = new Set(value.retiredIds);
	if (ids.size !== value.entries.length || retired.size !== value.retiredIds.length) throw new MemoryStoreError("记忆编号重复，已停用该库");
	for (const entry of value.entries) {
		if ((entry.supersededBy || entry.removedAt) && !retired.has(entry.id)) throw new MemoryStoreError("记忆历史状态不完整，已停用该库");
		if (retired.has(entry.id) && !entry.supersededBy && !entry.removedAt) throw new MemoryStoreError("记忆撤销状态不完整，已停用该库");
		if (entry.supersededBy && (!ids.has(entry.supersededBy) || entry.supersededBy === entry.id)) throw new MemoryStoreError("记忆替代关系无效，已停用该库");
	}
	const txIds = new Set<string>();
	for (const tx of value.transactions) {
		if (!record(tx) || !bounded(tx.id, 200) || !digest(tx.digest) || !(typeof tx.result === "boolean" || identifier(tx.result)) || txIds.has(tx.id)) throw new MemoryStoreError("记忆事务记录无效，已停用该库");
		txIds.add(tx.id);
	}
}
function readBounded(file: string, max = MEMORY_LIMITS.maxFileBytes): string {
	const fd = fs.openSync(file, "r");
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > max) throw new MemoryStoreError(`文件类型或大小超过限制：${file}`);
		const buffer = Buffer.alloc(max + 1);
		let size = 0;
		while (size < buffer.length) { const n = fs.readSync(fd, buffer, size, buffer.length - size, null); if (!n) break; size += n; }
		if (size > max) throw new MemoryStoreError(`文件超过 ${max} 字节：${file}`);
		// Keep a UTF-8 BOM in the decoded string so its digest still covers every byte.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
	} finally { fs.closeSync(fd); }
}

/** Memory lives outside the checkout, including when MOUNTAINS_HOME is customized. */
export function memoryFileFor(workspaceRoot: string, home = process.env.MOUNTAINS_HOME ?? join(homedir(), ".mountains")): string {
	const root = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : resolve(workspaceRoot);
	const file = join(resolve(home), "projects", sha256(root).slice(0, 16), "memory.jsonl");
	assertOutsideWorkspace(file, root);
	return file;
}
function assertOutsideWorkspace(file: string, root: string): void {
	let ancestor = resolve(file);
	while (!fs.existsSync(ancestor)) ancestor = dirname(ancestor);
	const actual = resolve(fs.realpathSync(ancestor), relative(ancestor, resolve(file)));
	if (actual === root || actual.startsWith(root + sep)) throw new MemoryStoreError("记忆文件必须放在任务工作区外");
}

/** Checksummed snapshots; the original JSONL is backed up on migration. */
export class MemoryStore {
	readonly file: string;
	readonly diagnostics: string[] = [];
	constructor(file: string) { this.file = resolve(file); }

	private load(): Loaded {
		if (!fs.existsSync(this.file)) return { snapshot: emptySnapshot(), raw: "", legacy: false };
		const raw = readBounded(this.file);
		if (!raw.trim()) return { snapshot: emptySnapshot(), raw, legacy: true };
		let whole: unknown;
		try { whole = JSON.parse(raw); } catch { /* May be legacy JSONL. */ }
		if (record(whole) && whole.format !== undefined) {
			const { checksum, ...body } = whole;
			validateSnapshot(body);
			if (!digest(checksum) || sha256(JSON.stringify(body)) !== checksum) throw new MemoryStoreError("记忆快照校验和错误，已停用该库");
			return { snapshot: body, raw, legacy: false };
		}
		if (raw.trimStart().startsWith('{"format"')) throw new MemoryStoreError("记忆快照不完整，已停用该库");
		const snapshot = emptySnapshot();
		const byId = new Map<string, MemoryEntry>();
		const retired = new Set<string>();
		const lines = raw.split("\n");
		let tail: string | undefined;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (!line.trim()) continue;
			if (Buffer.byteLength(line) > MEMORY_LIMITS.maxEventBytes) throw new MemoryStoreError("记忆日志行超过大小限制，已停用该库");
			let event: unknown;
			try { event = JSON.parse(line); } catch {
				if (index === lines.length - 1 && !raw.endsWith("\n") && line.trimStart().startsWith('{"type"')) { tail = line; break; }
				throw new MemoryStoreError(`记忆日志第 ${index + 1} 行损坏，已停用该库`);
			}
			if (!record(event)) throw new MemoryStoreError("记忆事件格式无效，已停用该库");
			if (event.type === "add") {
				validateEntry(event.entry);
				if (byId.has(event.entry.id) || retired.has(event.entry.id)) throw new MemoryStoreError("记忆编号重复或已撤销，已停用该库");
				byId.set(event.entry.id, event.entry);
			} else if (event.type === "remove" && identifier(event.id) && timestamp(event.at)) {
				retired.add(event.id);
				const entry = byId.get(event.id);
				if (entry) entry.removedAt = event.at;
			} else throw new MemoryStoreError("记忆事件类型或内容无效，已停用该库");
			snapshot.revision++;
			if (byId.size > MEMORY_LIMITS.maxEntries || retired.size > MEMORY_LIMITS.maxEntries) throw new MemoryStoreError("记忆条目数超过限制");
		}
		snapshot.entries = [...byId.values()];
		snapshot.retiredIds = [...retired];
		return { snapshot, raw, legacy: true, ...(tail === undefined ? {} : { tail }) };
	}

	private locked<T>(fn: () => T): T {
		fs.mkdirSync(dirname(this.file), { recursive: true });
		const lock = `${this.file}.lock`;
		let fd: number;
		try { fd = fs.openSync(lock, "wx", 0o600); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryStoreError("记忆库已有写入者或遗留锁；请核实写入进程后处理锁文件");
			throw error;
		}
		try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return fn(); }
		finally { fs.closeSync(fd); fs.unlinkSync(lock); }
	}

	private commit(loaded: Loaded): void {
		validateSnapshot(loaded.snapshot);
		const body = JSON.stringify(loaded.snapshot);
		const text = JSON.stringify({ ...loaded.snapshot, checksum: sha256(body) }) + "\n";
		if (Buffer.byteLength(text) > MEMORY_LIMITS.maxFileBytes) throw new MemoryStoreError("记忆快照超过大小限制");
		// Retain original bytes before migrating/recovering. Never use a backup as live facts.
		if (loaded.legacy && loaded.raw) this.backup(`${this.file}.legacy-${sha256(loaded.raw).slice(0, 16)}.bak`, loaded.raw);
		if (loaded.tail !== undefined) this.backup(`${this.file}.tail-${sha256(loaded.tail).slice(0, 16)}.corrupt`, loaded.tail);
		const temp = `${this.file}.tmp-${randomUUID()}`;
		try {
			const fd = fs.openSync(temp, "wx", 0o600);
			try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			if (readBounded(temp) !== text) throw new MemoryStoreError("记忆临时快照校验失败");
			const current = fs.existsSync(this.file) ? readBounded(this.file) : "";
			if (current !== loaded.raw) throw new MemoryStoreError("记忆库在提交前被其他写入者修改，请重新读取");
			fs.renameSync(temp, this.file);
			try {
				const dir = fs.openSync(dirname(this.file), "r");
				try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
			} catch (error) {
				// Some platforms do not support directory fsync. The rename has committed.
				this.diagnostics.push(`记忆已提交，但目录刷新未完成：${(error as Error).message}`);
			}
		} finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
	}
	private backup(path: string, content: string): void {
		if (fs.existsSync(path)) { if (readBounded(path) !== content) throw new MemoryStoreError("记忆备份内容不匹配"); return; }
		const temp = `${path}.tmp-${randomUUID()}`;
		try {
			const fd = fs.openSync(temp, "wx", 0o600);
			try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			if (readBounded(temp) !== content) throw new MemoryStoreError("记忆备份校验失败");
			fs.renameSync(temp, path);
		} finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
	}
	private readable(): Loaded {
		const loaded = this.load();
		if (loaded.tail === undefined) return loaded;
		return this.locked(() => {
			const current = this.load();
			if (current.tail !== undefined) {
				this.commit(current);
				this.diagnostics.push("记忆日志未写完的末行已隔离；保留此前完整记录");
			}
			return this.load();
		});
	}
	entries(options: { includeHistory?: boolean } = {}): MemoryEntry[] {
		const { snapshot } = this.readable();
		const retired = new Set(snapshot.retiredIds);
		return snapshot.entries.filter((e) => options.includeHistory || !retired.has(e.id));
	}
	revision(): number { return this.readable().snapshot.revision; }

	private write(action: "add" | "replace" | "remove", input: NewEntry | null, id: string | null, options: MemoryWriteOptions): MemoryEntry | boolean {
		if (input !== null) validateEntry({ ...input, id: "m1" });
		if (id !== null && !identifier(id)) throw new MemoryStoreError("记忆编号无效");
		if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) throw new MemoryStoreError("记忆库版本无效");
		const txId = options.transactionId ?? randomUUID();
		if (!bounded(txId, 200)) throw new MemoryStoreError("记忆事务编号无效");
		const requestDigest = sha256(JSON.stringify({ action, input, id }));
		return this.locked(() => {
			const loaded = this.load();
			const state = loaded.snapshot;
			const previous = state.transactions.find((t) => t.id === txId);
			if (previous) {
				if (previous.digest !== requestDigest) throw new MemoryStoreError("同一记忆事务编号被用于不同内容");
				if (typeof previous.result === "boolean") return previous.result;
				const result = state.entries.find((e) => e.id === previous.result);
				if (!result) throw new MemoryStoreError("记忆事务结果缺失");
				return result;
			}
			// A bounded retry table cannot identify evicted transactions. A caller-supplied
			// transaction must also carry its original revision, so an expired retry fails.
			if (options.transactionId !== undefined && options.expectedRevision === undefined) throw new MemoryStoreError("指定记忆事务编号时必须同时提供原库版本");
			if (options.expectedRevision !== undefined && options.expectedRevision !== state.revision) throw new MemoryStoreError("记忆库版本已变化，请重新读取后再更新");
			const retired = new Set(state.retiredIds);
			const old = id === null ? undefined : state.entries.find((e) => e.id === id && !retired.has(e.id));
			if (action === "remove" && !old) return false;
			if (action === "replace" && !old) throw new MemoryStoreError(`没有编号为 ${id} 的当前笔记`);
			if (action === "replace" && old && input && (old.fact || input.fact)
				&& (old.fact?.key !== input.fact?.key || scopeKey(old.scope) !== scopeKey(input.scope))) throw new MemoryStoreError("只能替换同一范围、同一事项的事实");
			let result: MemoryEntry | boolean = true;
			if (input) {
				const numbers = [...state.entries.map((e) => e.id), ...state.retiredIds].map((x) => /^m(\d+)$/.exec(x)?.[1]).filter((x) => x !== undefined).map(Number);
				const next = Math.max(0, ...numbers) + 1;
				const newId = Number.isSafeInteger(next) ? `m${next}` : `m-${randomUUID()}`;
				result = { ...input, id: newId };
				state.entries.push(result);
				if (old) old.supersededBy = newId;
			} else if (old) old.removedAt = new Date().toISOString();
			if (old) state.retiredIds.push(old.id);
			state.revision++;
			state.transactions = [...state.transactions, { id: txId, digest: requestDigest, result: typeof result === "boolean" ? result : result.id }].slice(-64);
			this.commit(loaded);
			return result;
		});
	}
	add(entry: NewEntry, options: MemoryWriteOptions = {}): MemoryEntry { return this.write("add", entry, null, options) as MemoryEntry; }
	replace(id: string, entry: NewEntry, options: MemoryWriteOptions = {}): MemoryEntry { return this.write("replace", entry, id, options) as MemoryEntry; }
	remove(id: string, options: MemoryWriteOptions = {}): boolean { return this.write("remove", null, id, options) as boolean; }
}

const linesOf = (text: string): string[] => text.split("\n");
const hashLines = (lines: string[], start: number, end: number): string => sha256(lines.slice(start - 1, end).join("\n"));
export interface EvidenceCheck { evidence: MemoryEvidence; status: "same" | "moved" | "changed" | "missing"; now?: { startLine: number; endLine: number } }
export function checkEvidence(ws: Workspace, ev: MemoryEvidence): EvidenceCheck {
	if (!validEvidence(ev)) return { evidence: ev, status: "changed" };
	let text: string;
	try { text = readBounded(ws.resolve(ev.path).abs, MEMORY_LIMITS.maxSourceBytes); } catch { return { evidence: ev, status: "missing" }; }
	return checkEvidenceText(ev, text);
}
function checkEvidenceText(ev: MemoryEvidence, text: string, allowMove = true): EvidenceCheck {
	const lines = linesOf(text);
	const len = ev.endLine - ev.startLine + 1;
	if (ev.endLine <= lines.length && hashLines(lines, ev.startLine, ev.endLine) === ev.sha256) return { evidence: ev, status: "same" };
	for (let s = 1; allowMove && s + len - 1 <= Math.min(lines.length, MEMORY_LIMITS.maxEvidenceScanLines); s++) {
		if (hashLines(lines, s, s + len - 1) === ev.sha256) return { evidence: ev, status: "moved", now: { startLine: s, endLine: s + len - 1 } };
	}
	return { evidence: ev, status: "changed" };
}
function gitValue(root: string, args: string[]): string | null {
	try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() || null; } catch { return null; }
}
function branchOf(root: string): string | null {
	return gitValue(root, ["symbolic-ref", "--quiet", "HEAD"]) ?? (gitValue(root, ["rev-parse", "HEAD"]) ? `detached:${gitValue(root, ["rev-parse", "HEAD"])}` : null);
}
export function memoryEnvironment(): string { return `node${process.versions.node}/${process.platform}/${process.arch}`; }
function field(text: string, selector: string): JsonValue {
	let value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
	for (const part of selectorParts(selector)) {
		if (Array.isArray(value) && /^(0|[1-9]\d*)$/.test(part) && Object.hasOwn(value, part)) value = value[Number(part)];
		else if (record(value) && Object.hasOwn(value, part)) value = value[part];
		else throw new MemoryStoreError(`找不到 JSON 字段 ${selector}`);
	}
	if (!jsonValue(value)) throw new MemoryStoreError("JSON 字段值过深或无效");
	return value;
}
export interface DependencyCheck { dependency: MemoryDependency; status: "same" | "changed" | "missing" }
interface CheckedMemory {
	entry: MemoryEntry;
	checks: EvidenceCheck[];
	dependencies?: DependencyCheck[];
	reasons?: string[];
	kind?: "fact" | "lead";
	/** Source identity is refreshed even if the literal field's value is unchanged. */
	source?: { path: string; selector: string; sha256: string };
}
export interface VerifiedMemory { valid: CheckedMemory[]; stale: CheckedMemory[] }
export interface VerifyMemoryOptions { strict?: boolean; environment?: string; module?: string }
/** A matching excerpt supports only provenance. Strict mode admits program-read literal fields. */
export function verifyMemory(ws: Workspace, entries: MemoryEntry[], options: VerifyMemoryOptions = {}): VerifiedMemory {
	const out: VerifiedMemory = { valid: [], stale: [] };
	const groups = new Map<string, Set<string>>();
	for (const entry of entries) {
		if (entry.fact && !entry.supersededBy && !entry.removedAt && validFact(entry.fact) && validScope(entry.scope)) {
			const group = JSON.stringify([scopeKey(entry.scope), entry.fact.key]);
			const values = groups.get(group) ?? new Set<string>();
			values.add(canonical(entry.fact.value)); groups.set(group, values);
		}
	}
	const branch = branchOf(ws.root);
	const environment = options.environment ?? memoryEnvironment();
	const sourceCache = new Map<string, string | null>();
	const evidenceCache = new Map<string, EvidenceCheck>();
	const source = (path: string): string | null => {
		if (!sourceCache.has(path)) { try { sourceCache.set(path, readBounded(ws.resolve(path).abs, MEMORY_LIMITS.maxSourceBytes)); } catch { sourceCache.set(path, null); } }
		return sourceCache.get(path) ?? null;
	};
	for (const entry of entries) {
		const reasons: string[] = [];
		try { validateEntry(entry); } catch { out.stale.push({ entry, checks: [], reasons: ["invalid-entry"] }); continue; }
		if (!entry.evidence.length) reasons.push("no-evidence");
		if (entry.supersededBy || entry.removedAt) reasons.push("historical");
		if (entry.scope) {
			if (entry.scope.workspace !== ws.root) reasons.push("workspace-mismatch");
			if (entry.scope.branch !== branch) reasons.push("branch-mismatch");
			if (entry.scope.environment !== environment) reasons.push("environment-mismatch");
			if (entry.scope.module !== (options.module ?? ".")) reasons.push("module-mismatch");
		}
		if (options.strict && !entry.fact) reasons.push("unverified-lead");
		// These records cannot be injected, so do not reread/search their files each turn.
		if (reasons.length > 0) { out.stale.push({ entry, checks: [], reasons, kind: entry.fact ? "fact" : "lead" }); continue; }
		const checks = entry.evidence.map((ev) => {
			const key = JSON.stringify([!!entry.fact, ev]);
			let check = evidenceCache.get(key);
			if (!check) {
				const text = source(ev.path);
				check = text === null ? { evidence: ev, status: "missing" } : checkEvidenceText(ev, text, !entry.fact);
				evidenceCache.set(key, check);
			}
			return check;
		});
		// Literal facts get a fresh JSON-field citation; old excerpts are only provenance.
		if (!entry.fact && checks.some((c) => c.status === "changed" || c.status === "missing")) reasons.push("evidence-changed");
		const dependencies: DependencyCheck[] = (entry.dependencies ?? []).map((dependency) => {
			const text = source(dependency.path);
			if (text === null) return { dependency, status: "missing" };
			try {
				const actual = dependency.kind === "file" ? sha256(text) : sha256(canonical(field(text, dependency.selector)));
				return { dependency, status: actual === dependency.sha256 ? "same" : "changed" };
			} catch { return { dependency, status: "changed" }; }
		});
		if (dependencies.some((d) => d.status !== "same")) reasons.push("dependency-changed");
		if (entry.coverage === "incomplete") reasons.push("incomplete-dependencies");
		let currentSource: CheckedMemory["source"];
		if (entry.fact) {
			if (!entry.scope || !entry.coverage) reasons.push("missing-fact-scope");
			if (entry.scope?.module !== dirname(entry.fact.path).split(sep).join("/")) reasons.push("source-module-mismatch");
			if (!entry.dependencies?.some((d) => d.kind === "json-field" && d.path === entry.fact!.path && d.selector === entry.fact!.selector && d.sha256 === sha256(canonical(entry.fact!.value)))) reasons.push("missing-source-dependency");
			try {
				const text = source(entry.fact.path);
				if (text === null || canonical(field(text, entry.fact.selector)) !== canonical(entry.fact.value)) reasons.push("field-changed");
				if (text !== null) currentSource = { path: entry.fact.path, selector: entry.fact.selector, sha256: sha256(text) };
			} catch { reasons.push("field-missing"); }
			if ((groups.get(JSON.stringify([scopeKey(entry.scope), entry.fact.key]))?.size ?? 0) > 1) reasons.push("conflicting-values");
		}
		const item: CheckedMemory = { entry, checks, dependencies, reasons, kind: entry.fact ? "fact" : "lead", ...(currentSource ? { source: currentSource } : {}) };
		(reasons.length === 0 ? out.valid : out.stale).push(item);
	}
	return out;
}
function where(c: EvidenceCheck): string { const r = c.now ?? c.evidence; return `${c.evidence.path}:${r.startLine}-${r.endLine}`; }
/** The complete injected section, including stale/conflict notices, shares one budget. */
export function renderMemory(v: VerifiedMemory, opts: { maxNotes: number; maxChars?: number; includeOutOfScope?: boolean } = { maxNotes: 30 }): string | null {
	const count = Number.isSafeInteger(opts.maxNotes) ? Math.max(0, opts.maxNotes) : 0;
	const max = Math.max(0, Math.min(MEMORY_LIMITS.maxPromptChars, Math.floor(opts.maxChars ?? MEMORY_LIMITS.maxPromptChars)));
	const stale = opts.includeOutOfScope ? v.stale : v.stale.filter((x) => !x.reasons?.some((r) => ["workspace-mismatch", "module-mismatch", "environment-mismatch", "branch-mismatch"].includes(r)));
	if (v.valid.length + stale.length === 0 || count === 0 || !max) return null;
	const parts = ["## Project notes from earlier sessions", "Only explicit source-field values are checked facts. Other notes are unverified leads: matching source excerpts do not prove their claims. Recheck before use."];
	const candidates: string[] = [];
	for (const { entry, checks, reasons } of stale) {
		const changed = checks.filter((c) => c.status === "changed" || c.status === "missing").map((c) => `${where(c)} (${c.status})`);
		candidates.push(`- [${entry.id}] ${changed.join(", ") || "Needs recheck"}${reasons?.length ? `; ${reasons.join(", ")}` : ""}`);
	}
	for (const { entry, checks, source } of v.valid.slice(-count)) {
		const text = entry.fact ? `${entry.fact.path} ${entry.fact.selector} = ${canonical(entry.fact.value)}` : entry.text;
		const citation = source ? `current source: ${source.path}#${source.selector}, sha256=${source.sha256}` : `evidence: ${checks.map(where).join(", ")}`;
		candidates.push(`- [${entry.id}] ${text} (${citation})`);
	}
	const omitted = "Additional notes omitted; use memory_query to recheck the relevant scope.";
	let used = 0;
	for (const line of candidates) {
		if (used >= count || [...parts, line, omitted].join("\n").length > max) break;
		parts.push(line); used++;
	}
	if (used < candidates.length || v.valid.length > count) parts.push(omitted);
	const text = parts.join("\n");
	return text.length <= max ? text : "Memory omitted: budget too small to include reliable context.".slice(0, max);
}
function fail(message: string): ToolResult { return { ok: false, modelContent: `错误：${message}`, summary: `失败：${message}`, details: { error: message } }; }

const evidenceSchema = {
	type: "array", description: `1-${MEMORY_LIMITS.maxEvidence} source ranges, at most ${MEMORY_LIMITS.maxEvidenceLines} lines each`,
	items: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path", "start_line", "end_line"], additionalProperties: false },
};
export function createMemoryTool(store: MemoryStore, options: { verifiedFacts?: boolean } = {}): ToolDefinition {
	return {
		name: "memory_record", logicalName: "memory.record", readOnly: false,
		description: "Record a short project note with source evidence for future sessions. Excerpt matches establish provenance, not truth. Use replaces for an atomic update." +
			(options.verifiedFacts ? " For checked narrow facts provide fact (a literal JSON field or package script); its value and canonical identity are read by the tool. Add file/JSON dependencies for configuration it relies on. This never proves that a command succeeds." : ""),
		parameters: {
			type: "object", properties: {
				note: { type: "string", description: `Short note, max ${MEMORY_LIMITS.maxNoteChars} characters` }, evidence: evidenceSchema,
				replaces: { type: "string", description: "Id of the current note to replace atomically" },
				...(options.verifiedFacts ? {
					fact: { type: "object", properties: { kind: { type: "string", enum: ["json-field", "package-script"] }, path: { type: "string" }, selector: { type: "string", description: "JSON pointer, e.g. /scripts/test" } }, required: ["kind", "path", "selector"], additionalProperties: false },
					dependencies: { type: "array", maxItems: MEMORY_LIMITS.maxDependencies - 1, items: { type: "object", properties: { kind: { type: "string", enum: ["file", "json-field"] }, path: { type: "string" }, selector: { type: "string" } }, required: ["kind", "path"], additionalProperties: false } },
					coverage: { type: "string", enum: ["source-only", "declared-complete", "incomplete"], description: "Source-only means only this literal source value, not effective runtime behavior. Unknown dependencies must use incomplete." },
				} : {}),
			}, required: ["note", "evidence"], additionalProperties: false,
		},
		async execute(args, ctx) {
			try {
				assertOutsideWorkspace(store.file, ctx.workspace.root);
				const allowed = new Set(["note", "evidence", "replaces", ...(options.verifiedFacts ? ["fact", "dependencies", "coverage"] : [])]);
				if (Object.keys(args).some((k) => !allowed.has(k))) return fail("存在不支持的记忆参数");
				const note = typeof args.note === "string" ? args.note.trim() : "";
				if (!note || note.length > MEMORY_LIMITS.maxNoteChars) return fail(`note 需要 1-${MEMORY_LIMITS.maxNoteChars} 个字符`);
				if (!Array.isArray(args.evidence) || args.evidence.length < 1 || args.evidence.length > MEMORY_LIMITS.maxEvidence) return fail(`evidence 需要 1-${MEMORY_LIMITS.maxEvidence} 项`);
				const evidence: MemoryEvidence[] = [];
				for (const raw of args.evidence) {
					if (!record(raw) || typeof raw.path !== "string" || !Number.isSafeInteger(raw.start_line) || !Number.isSafeInteger(raw.end_line)) return fail("证据范围无效");
					const { abs, rel } = ctx.workspace.resolve(raw.path);
					const lines = linesOf(readBounded(abs, MEMORY_LIMITS.maxSourceBytes));
					const start = raw.start_line as number; const end = raw.end_line as number;
					if (start < 1 || end < start || end > lines.length || end - start >= MEMORY_LIMITS.maxEvidenceLines) return fail(`证据范围超出限制：${rel}`);
					evidence.push({ path: rel, startLine: start, endLine: end, sha256: hashLines(lines, start, end) });
				}
				if (args.replaces !== undefined && !identifier(args.replaces)) return fail("replaces 编号无效");
				const entry: NewEntry = { text: note, evidence, createdAt: new Date().toISOString(), commit: gitValue(ctx.workspace.root, ["rev-parse", "HEAD"]) };
				if (options.verifiedFacts) {
					const dependencies: MemoryDependency[] = [];
					if (args.dependencies !== undefined && (!Array.isArray(args.dependencies) || args.dependencies.length >= MEMORY_LIMITS.maxDependencies)) return fail("dependencies 数量无效");
					for (const raw of (args.dependencies ?? []) as unknown[]) {
						if (!record(raw) || typeof raw.path !== "string" || !["file", "json-field"].includes(String(raw.kind))) return fail("依赖格式无效");
						const { abs, rel } = ctx.workspace.resolve(raw.path); const text = readBounded(abs, MEMORY_LIMITS.maxSourceBytes);
						if (raw.kind === "file") dependencies.push({ kind: "file", path: rel, sha256: sha256(text) });
						else { if (typeof raw.selector !== "string") return fail("JSON 依赖需要 selector"); dependencies.push({ kind: "json-field", path: rel, selector: raw.selector, sha256: sha256(canonical(field(text, raw.selector))) }); }
					}
					if (args.fact !== undefined) {
						const raw = args.fact;
						if (!record(raw) || typeof raw.path !== "string" || typeof raw.selector !== "string" || !["json-field", "package-script"].includes(String(raw.kind))) return fail("fact 格式无效");
						const { abs, rel } = ctx.workspace.resolve(raw.path);
						const value = field(readBounded(abs, MEMORY_LIMITS.maxSourceBytes), raw.selector);
						const fact: MemoryFact = { kind: raw.kind as MemoryFact["kind"], path: rel, selector: raw.selector, key: factKey(rel, raw.selector), value };
						if (!validFact(fact)) return fail("只支持有限 JSON 字段值或 package.json 的脚本字段");
						entry.fact = fact;
						dependencies.unshift({ kind: "json-field", path: rel, selector: raw.selector, sha256: sha256(canonical(value)) });
					}
					if (args.coverage !== undefined && !["source-only", "declared-complete", "incomplete"].includes(String(args.coverage))) return fail("coverage 无效");
					entry.coverage = (args.coverage ?? "source-only") as NonNullable<NewEntry["coverage"]>;
					entry.dependencies = dependencies;
					entry.scope = { workspace: ctx.workspace.root, module: entry.fact ? dirname(entry.fact.path).split(sep).join("/") : ".", environment: memoryEnvironment(), branch: branchOf(ctx.workspace.root) };
				}
				const replaces = args.replaces as string | undefined;
				const stored = replaces ? store.replace(replaces, entry) : store.add(entry);
				const at = evidence.map((e) => `${e.path}:${e.startLine}-${e.endLine}`).join(", ");
				return { ok: true, modelContent: `Recorded note ${stored.id}${replaces ? ` (replaces ${replaces})` : ""} with evidence ${at}.`, summary: `记录笔记 ${stored.id}`, details: { id: stored.id, replaces: replaces ?? null, evidence, ...(stored.fact ? { fact: stored.fact } : {}) } };
			} catch (error) { return fail((error as Error).message); }
		},
	};
}

/** Query all competing records before filtering by id, so conflicts cannot be hidden. */
export function createMemoryQueryTool(store: MemoryStore): ToolDefinition {
	return {
		name: "memory_query", logicalName: "memory.query", readOnly: true,
		description: "Recheck project notes against current sources, dependencies and scope. Query a module (default root) or one id. Conflicts and superseded records are never returned as current facts.",
		parameters: { type: "object", properties: { id: { type: "string" }, module: { type: "string", description: "Exact module directory; no implicit inheritance" } }, additionalProperties: false },
		async execute(args, ctx) {
			try {
				assertOutsideWorkspace(store.file, ctx.workspace.root);
				if (Object.keys(args).some((k) => !["id", "module"].includes(k)) || (args.id !== undefined && !identifier(args.id))) return fail("查询参数无效");
				let module = args.module ?? ".";
				if (module !== "." && !localPath(module)) return fail("模块路径无效");
				const entries = store.entries({ includeHistory: true });
				if (args.id) {
					const target = entries.find((e) => e.id === args.id);
					if (!target) return fail(`没有编号为 ${args.id} 的笔记`);
					if (args.module === undefined) module = target.scope?.module ?? ".";
				}
				const verified = verifyMemory(ctx.workspace, entries, { strict: true, module: module as string });
				const selected: VerifiedMemory = {
					valid: verified.valid.filter((v) => args.id ? v.entry.id === args.id : (v.entry.scope?.module ?? ".") === module),
					stale: verified.stale.filter((v) => args.id ? v.entry.id === args.id : (v.entry.scope?.module ?? ".") === module),
				};
				return { ok: true, modelContent: renderMemory(selected, { maxNotes: 10, includeOutOfScope: !!args.id }) ?? "No applicable project notes.", summary: `查询记忆：${selected.valid.length} 条字段事实，${selected.stale.length} 条需复核`, details: { valid: selected.valid.map((x) => x.entry.id), stale: selected.stale.map((x) => ({ id: x.entry.id, reasons: x.reasons })), revision: store.revision() } };
			} catch (error) { return fail((error as Error).message); }
		},
	};
}
