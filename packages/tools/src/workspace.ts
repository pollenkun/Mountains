import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasPathAncestor, pathAncestry } from "./path-identity.ts";

export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function existingAncestor(path: string): string {
	let ancestor = path;
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) throw new ToolError(`路径没有可访问的祖先：${path}`);
		ancestor = parent;
	}
	return ancestor;
}

/** Native filesystem spelling, including Windows short names; missing suffixes stay exact. */
export function canonicalPath(path: string, allowMissing = false): string {
	const absolute = resolve(path);
	const ancestor = allowMissing ? existingAncestor(absolute) : absolute;
	// JavaScript realpath may preserve aliases on case-insensitive filesystems.
	// Never case-fold: Windows and macOS can also have case-sensitive paths.
	const real = process.platform === "win32" || process.platform === "darwin" ? realpathSync.native(ancestor) : realpathSync(ancestor);
	return resolve(real, relative(ancestor, absolute));
}

/** 工作区边界：所有路径必须落在根目录内，符号链接也不能越界。 */
export class Workspace {
	readonly root: string;

	constructor(root: string) {
		this.root = canonicalPath(root);
	}

	private inside(abs: string): boolean {
		const path = relative(this.root, abs);
		return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
	}

	private insideExisting(real: string): boolean {
		return this.inside(real) && (process.platform !== "win32" || hasPathAncestor(this.root, real));
	}

	/** Physical containment also accepts aliases and checks parents of missing paths. */
	contains(path: string): boolean {
		const real = canonicalPath(path, true);
		if (!this.inside(real)) return false;
		if (process.platform !== "win32") return true;
		const ancestry = pathAncestry(this.root, existingAncestor(real));
		if (ancestry === "unknown") throw new ToolError("无法确认路径是否位于工作区内");
		return ancestry === "inside";
	}

	/** 把模型给出的路径解析为绝对路径并校验边界。forWrite 时允许文件不存在（但父目录必须在工作区内）。 */
	resolve(p: string, opts: { forWrite?: boolean } = {}): { abs: string; rel: string } {
		if (typeof p !== "string" || !p.trim()) throw new ToolError("路径不能为空");
		const candidate = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
		let real: string;
		if (existsSync(candidate)) {
			real = canonicalPath(candidate);
			if (!this.insideExisting(real)) throw new ToolError(`路径经符号链接越出工作区：${p}`);
		} else {
			// 找到最近的已存在祖先，校验它的真实路径
			const parent = existingAncestor(candidate);
			const realParent = canonicalPath(parent);
			if (!this.insideExisting(realParent)) throw new ToolError(`路径越出工作区：${p}`);
			real = join(realParent, relative(parent, candidate));
			if (!opts.forWrite) throw new ToolError(`文件不存在：${this.rel(real)}`);
		}
		if (!this.inside(real)) throw new ToolError(`路径经符号链接越出工作区：${p}`);
		return { abs: real, rel: this.rel(real) };
	}

	rel(abs: string): string {
		const r = relative(this.root, canonicalPath(abs, true));
		return r === "" ? "." : r.split(sep).join("/");
	}
}

/** 记录 agent 最近一次看到的文件哈希，用于编辑时检测"文件已被改动"。 */
export class FileStateTracker {
	private readonly seen = new Map<string, string>();
	/** 已完整发给模型的行范围，按“路径 + 内容哈希”记录（内容一变，旧记录自然失效） */
	private readonly delivered = new Map<string, [number, number][]>();

	record(rel: string, hash: string): void {
		this.seen.set(rel, hash);
	}

	get(rel: string): string | undefined {
		return this.seen.get(rel);
	}

	markDelivered(rel: string, hash: string, start: number, end: number): void {
		const key = `${rel}\0${hash}`;
		const list = this.delivered.get(key) ?? [];
		list.push([start, end]);
		this.delivered.set(key, list);
	}

	/** [start, end] 是否已被此前发送的范围完整覆盖（同一内容版本） */
	isDelivered(rel: string, hash: string, start: number, end: number): boolean {
		const ranges = [...(this.delivered.get(`${rel}\0${hash}`) ?? [])].sort((a, b) => a[0] - b[0]);
		let covered = start - 1;
		for (const [s, e] of ranges) {
			if (s > covered + 1) break;
			covered = Math.max(covered, e);
			if (covered >= end) return true;
		}
		return covered >= end;
	}

	/** Only ranges not yet published from this exact file version; no old-version inference. */
	undeliveredRanges(rel: string, hash: string, start: number, end: number): { start: number; end: number }[] {
		const known = [...(this.delivered.get(`${rel}\0${hash}`) ?? [])].sort((a, b) => a[0] - b[0]);
		const missing: { start: number; end: number }[] = [];
		let next = start;
		for (const [seenStart, seenEnd] of known) {
			if (seenEnd < next) continue;
			if (seenStart > end) break;
			if (seenStart > next) missing.push({ start: next, end: Math.min(end, seenStart - 1) });
			next = Math.max(next, seenEnd + 1);
			if (next > end) break;
		}
		if (next <= end) missing.push({ start: next, end });
		return missing;
	}

	/** 上下文被修订（遮蔽）后，已发送的内容不再可见：清空记录 */
	forgetDelivered(): void {
		this.delivered.clear();
	}
}

export type BlobKind = "raw" | "shown";
export interface BlobScope {
	workspaceRoot: string;
	sessionId: string;
	/** Host explicitly permits historical sessions from this workspace and this archive root. */
	allowWorkspaceHistory?: boolean;
}
export interface BlobPutOptions {
	kind?: BlobKind;
	source?: Record<string, unknown>;
}
export interface BlobExpectation {
	sha256?: string;
	toolCallId?: string;
}
export interface BlobRange {
	kind: BlobKind;
	hash: string;
	bytes: Buffer;
	totalBytes: number;
	invalidUtf8: boolean;
}
/** Only execution facts from the selected invocation; absence is not a false/null fact. */
export interface CommandArchiveState {
	toolCallId: string;
	exitCode?: number | null;
	timedOut?: boolean | null;
	cancelled?: boolean | null;
	signal?: string | null;
	captureComplete?: boolean | null;
}
export interface CommandArchive extends BlobRange {
	commandState: CommandArchiveState;
}
/** Both verification and recovery have a finite input ceiling. Pages have a separate smaller limit. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const NEW_REF = /^blob_v2_([0-9a-f]{64})_([0-9a-f]{32})_(raw|shown)_([0-9a-f]{64})$/;
const OLD_REF = /^blob_([0-9a-f]{16})$/;

export function isValidUtf8(bytes: Uint8Array): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/** Immutable byte archives. A reference is resolved only inside the host-selected scope. */
export class BlobStore {
	readonly dir: string;
	private readonly workspaceId: string;
	private readonly sessionId: string;
	private readonly scope: BlobScope | undefined;

	constructor(dir: string, scope?: BlobScope) {
		mkdirSync(dir, { recursive: true });
		this.dir = canonicalPath(dir);
		this.scope = scope ? { ...scope, workspaceRoot: canonicalPath(scope.workspaceRoot) } : undefined;
		this.workspaceId = sha256(this.scope?.workspaceRoot ?? this.dir);
		this.sessionId = sha256(this.scope?.sessionId ?? this.dir).slice(0, 32);
	}

	matchesWorkspace(root: string): boolean {
		try { return !this.scope || canonicalPath(root) === this.scope.workspaceRoot; }
		catch { return false; }
	}

	/** Reject symlinks in every archive-owned component, including the final file. */
	private checkedPath(parts: string[], create = false): string {
		if (canonicalPath(this.dir) !== this.dir || lstatSync(this.dir).isSymbolicLink()) throw new ToolError("归档目录已改变");
		let at = this.dir;
		for (let i = 0; i < parts.length; i++) {
			at = join(at, parts[i] as string);
			const directory = i < parts.length - 1;
			if (create && directory && !existsSync(at)) mkdirSync(at, { mode: 0o700 });
			if (existsSync(at) || !create) {
				const stat = lstatSync(at);
				if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new ToolError("归档路径无效");
			}
		}
		return at;
	}

	private locate(ref: string): { path: string; hash: string; kind: BlobKind } | null {
		const m = NEW_REF.exec(ref);
		if (m) {
			const workspace = m[1] as string;
			const session = m[2] as string;
			const kind = m[3] as BlobKind;
			const hash = m[4] as string;
			if (workspace !== this.workspaceId || (session !== this.sessionId && !this.scope?.allowWorkspaceHistory)) return null;
			return { path: this.checkedPath([workspace, session, kind, hash.slice(0, 2), hash]), hash, kind };
		}
		const old = OLD_REF.exec(ref);
		if (!old?.[1]) return null;
		// Legacy archives carry no workspace/session identity. Scoped production stores never
		// guess which session owned an object from an old shared archive directory.
		if (this.scope) return null;
		const prefix = old[1];
		if (canonicalPath(this.dir) !== this.dir || lstatSync(this.dir).isSymbolicLink()) return null;
		const folder = join(this.dir, prefix.slice(0, 2));
		const folderStat = lstatSync(folder);
		if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) return null;
		const names = readdirSync(folder).filter((name) => /^[0-9a-f]{64}$/.test(name) && name.startsWith(prefix));
		if (names.length !== 1) return null;
		const hash = names[0] as string;
		return { path: this.checkedPath([prefix.slice(0, 2), hash]), hash, kind: "shown" };
	}

	private load(
		ref: string,
		collect: boolean,
		maxBytes = MAX_ARCHIVE_BYTES,
		beforeRead?: (target: { hash: string; kind: BlobKind }, totalBytes: number) => boolean,
	): { bytes: Buffer; hash: string; kind: BlobKind; totalBytes: number } | null {
		let fd: number | undefined;
		try {
			if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ARCHIVE_BYTES) return null;
			const target = this.locate(ref);
			if (!target) return null;
			fd = openSync(target.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const before = fstatSync(fd);
			if (!before.isFile() || before.size > maxBytes) return null;
			// The command reader validates the source binding before any payload allocation/read.
			if (beforeRead && !beforeRead(target, before.size)) return null;
			const hash = createHash("sha256");
			const chunk = Buffer.alloc(64 * 1024);
			const chunks: Buffer[] = [];
			let total = 0;
			while (total < before.size) {
				// Never read past the approved initial size, even if another writer grows it.
				const n = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - total), total);
				if (!n) break;
				total += n;
				if (total > maxBytes || total > before.size) return null;
				hash.update(chunk.subarray(0, n));
				if (collect) chunks.push(Buffer.from(chunk.subarray(0, n)));
			}
			if (total !== before.size || fstatSync(fd).size !== before.size || hash.digest("hex") !== target.hash) return null;
			return { bytes: collect ? Buffer.concat(chunks, total) : Buffer.alloc(0), hash: target.hash, kind: target.kind, totalBytes: total };
		} catch { return null; }
		finally { if (fd !== undefined) closeSync(fd); }
	}

	put(content: string | Uint8Array, options: BlobPutOptions = {}): string {
		const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
		if (bytes.length > MAX_ARCHIVE_BYTES) throw new ToolError(`归档超过 ${MAX_ARCHIVE_BYTES} 字节上限`);
		const kind = options.kind ?? (typeof content === "string" ? "shown" : "raw");
		if (kind !== "raw" && kind !== "shown") throw new ToolError("归档类型无效");
		const hash = sha256(bytes);
		const parts = [this.workspaceId, this.sessionId, kind, hash.slice(0, 2), hash];
		const file = this.checkedPath(parts, true);
		try { writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const ref = `blob_v2_${this.workspaceId}_${this.sessionId}_${kind}_${hash}`;
		if (!this.has(ref, kind)) throw new ToolError("归档读回校验失败");
		if (options.source) {
			const metadata = JSON.stringify({ ref, sha256: hash, bytes: bytes.length, kind, source: options.source });
			if (Buffer.byteLength(metadata) > 8192) throw new ToolError("归档来源说明过长");
			const sourceKey = typeof options.source.toolCallId === "string" ? sha256(options.source.toolCallId) : "unbound";
			const metadataPath = this.checkedPath([...parts.slice(0, -1), `${hash}.sources`, sourceKey, `${sha256(metadata)}.json`], true);
			try { writeFileSync(metadataPath, metadata, { flag: "wx", mode: 0o600 }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			if (!this.readSource(metadataPath)) throw new ToolError("归档来源读回校验失败");
		}
		return ref;
	}

	private readSource(file: string): Record<string, unknown> | null {
		let fd: number | undefined;
		try {
			fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 8192) return null;
			const bytes = Buffer.alloc(stat.size);
			let total = 0;
			while (total < bytes.length) {
				const n = readSync(fd, bytes, total, bytes.length - total, total);
				if (!n) break;
				total += n;
			}
			if (total !== stat.size || fstatSync(fd).size !== stat.size || basename(file) !== `${sha256(bytes.subarray(0, total))}.json`) return null;
			const value: unknown = JSON.parse(bytes.subarray(0, total).toString("utf8"));
			return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
		} catch { return null; }
		finally { if (fd !== undefined) closeSync(fd); }
	}

	private sourceMatches(ref: string, toolCallId: string, hash: string, kind: BlobKind, totalBytes: number): boolean {
		try {
			const m = NEW_REF.exec(ref);
			if (!m) return false;
			const parts = [m[1] as string, m[2] as string, kind, hash.slice(0, 2), `${hash}.sources`, sha256(toolCallId)];
			// Validate every source directory without creating anything during recovery.
			let folder = this.dir;
			for (const part of parts) {
				folder = join(folder, part);
				const stat = lstatSync(folder);
				if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
			}
			const dir = opendirSync(folder);
			try {
				for (let count = 0; count < 256; count++) {
					const entry = dir.readSync();
					if (!entry) return false;
					if (!/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
					const file = this.checkedPath([...parts, entry.name]);
					const record = this.readSource(file);
					const source = record?.source;
					if (record?.ref === ref && record.sha256 === hash && record.kind === kind && record.bytes === totalBytes && source && typeof source === "object" && (source as Record<string, unknown>).toolCallId === toolCallId) return true;
				}
				return false;
			} finally { dir.closeSync(); }
		} catch { return false; }
	}

	private commandSource(ref: string, toolCallId: string, hash: string, totalBytes: number): CommandArchiveState | null {
		try {
			const m = NEW_REF.exec(ref);
			if (!m || m[3] !== "raw") return null;
			const parts = [m[1] as string, m[2] as string, "raw", hash.slice(0, 2), `${hash}.sources`, sha256(toolCallId)];
			let folder = this.dir;
			for (const part of parts) {
				folder = join(folder, part);
				const stat = lstatSync(folder);
				if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
			}
			const dir = opendirSync(folder);
			let selected: CommandArchiveState | null = null;
			let sourceIdentity: string | undefined;
			try {
				// At most 256 records of at most 8192 bytes: bounded source IO <= 2 MiB.
				// Read one more directory entry to reject overflow rather than accepting a prefix.
				for (let count = 0; ; count++) {
					const entry = dir.readSync();
					if (!entry) return selected;
					if (count >= 256 || !/^[0-9a-f]{64}\.json$/.test(entry.name)) return null;
					const record = this.readSource(this.checkedPath([...parts, entry.name]));
					const source = record?.source;
					if (!record || record.ref !== ref || record.sha256 !== hash || record.kind !== "raw" || record.bytes !== totalBytes ||
						!source || typeof source !== "object" || Array.isArray(source)) return null;
					const value = source as Record<string, unknown>;
					if (value.tool !== "command_run" || value.toolCallId !== toolCallId) return null;
					const state: CommandArchiveState = { toolCallId };
					if (Object.hasOwn(value, "exitCode")) {
						const code = value.exitCode;
						if (code !== null && (typeof code !== "number" || !Number.isSafeInteger(code) || code < 0 || code > 0x7fffffff)) return null;
						state.exitCode = code;
					}
					for (const key of ["timedOut", "cancelled", "captureComplete"] as const) {
						if (!Object.hasOwn(value, key)) continue;
						const flag = value[key];
						if (flag !== null && typeof flag !== "boolean") return null;
						state[key] = flag;
					}
					if (Object.hasOwn(value, "signal")) {
						const signal = value.signal;
						if (signal !== null && (typeof signal !== "string" || signal.length === 0 || signal.length > 64)) return null;
						state.signal = signal;
					}
					// Include provenance fields when detecting contradictory duplicate records,
					// but expose only the necessary execution facts to the tool caller.
					const identity = JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
					if (sourceIdentity !== undefined && identity !== sourceIdentity) return null;
					sourceIdentity = identity;
					selected = state;
				}
			} finally { dir.closeSync(); }
		} catch { return null; }
	}

	/** Checks scope, every byte, and optional host-known content/source binding. */
	has(ref: string, expectedKind?: BlobKind, expected: BlobExpectation = {}): boolean {
		const result = this.load(ref, false);
		if (!result || expectedKind && result.kind !== expectedKind || expected.sha256 && result.hash !== expected.sha256) return false;
		return expected.toolCallId === undefined || this.sourceMatches(ref, expected.toolCallId, result.hash, result.kind, result.totalBytes);
	}

	getBytes(ref: string): Buffer | null { return this.load(ref, true)?.bytes ?? null; }

	inspect(ref: string): BlobRange | null {
		const result = this.load(ref, true);
		return result ? { ...result, totalBytes: result.bytes.length, invalidUtf8: !isValidUtf8(result.bytes) } : null;
	}

	/** Authorize, validate one invocation's source, then read/hash the raw payload once. */
	inspectCommand(ref: string, toolCallId: string, options: { maxArchiveBytes: number }): CommandArchive | null {
		if (typeof ref !== "string" || ref.length > 256 || !NEW_REF.test(ref) ||
			typeof toolCallId !== "string" || toolCallId.length === 0 || toolCallId.length > 256 ||
			!options || !Number.isSafeInteger(options.maxArchiveBytes) || options.maxArchiveBytes < 0 || options.maxArchiveBytes > MAX_ARCHIVE_BYTES) return null;
		let commandState: CommandArchiveState | null = null;
		const result = this.load(ref, true, options.maxArchiveBytes, (target, totalBytes) => {
			if (target.kind !== "raw") return false;
			commandState = this.commandSource(ref, toolCallId, target.hash, totalBytes);
			return commandState !== null;
		});
		return result && commandState ? { ...result, invalidUtf8: !isValidUtf8(result.bytes), commandState } : null;
	}

	/** Compatibility text API: binary archives are never silently decoded with replacements. */
	get(ref: string): string | null {
		const result = this.inspect(ref);
		return result && !result.invalidUtf8 ? result.bytes.toString("utf8") : null;
	}
}
