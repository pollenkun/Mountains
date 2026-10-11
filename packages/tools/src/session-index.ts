import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { BlobStore } from "./workspace.ts";

export const SESSION_SEARCH_LIMITS = {
	maxRecordBytes: 8 * 1024 * 1024, maxIndexBytes: 64 * 1024 * 1024, maxEntries: 20_000,
	defaultScanBytes: 256 * 1024, maxScanBytes: 8 * 1024 * 1024, maxCheckedRecords: 8,
	defaultMatches: 8, maxMatches: 20, defaultSnippetBytes: 384, maxSnippetBytes: 2048,
	defaultOutputBytes: 6144, minOutputBytes: 1024, maxOutputBytes: 12_000, maxNeedleBytes: 256,
} as const;

export interface SessionRecordMetadata {
	role: "user" | "assistant" | "tool";
	toolCallId?: string;
	name?: string;
	target?: string;
	/** Only a display label is shortened; the archived body remains complete. */
	targetTruncated?: boolean;
	ref?: string;
}
interface Entry { ref: string; bytes: Buffer; metadata: Omit<SessionRecordMetadata, "ref"> }
export interface SessionMatch extends Omit<SessionRecordMetadata, "ref"> {
	ordinal: number;
	ref: string;
	byteStart: number;
	byteEnd: number;
	text: string;
	truncated: boolean;
}
export interface SessionSearchSuccess {
	ok: true;
	matches: SessionMatch[];
	scannedBytes: number;
	checkedRecords: number;
	unavailableRecords: number;
	complete: boolean;
	limits: string[];
	nextCursor?: string;
}
export type SessionSearchResult = SessionSearchSuccess | { ok: false; error: string };
interface SearchContext { blobs?: BlobStore; workspaceRoot: string; signal: AbortSignal }
interface Query {
	needle?: string; ref?: string; cursor?: string;
	maxScanBytes: number; maxMatches: number; maxSnippetBytes: number; maxOutputBytes: number;
}
interface Position { snapshot: number; entry: number; offset: number }
const shownRef = /^blob_v2_[0-9a-f]{64}_[0-9a-f]{32}_shown_[0-9a-f]{64}$/;
const queryKeys = new Set(["needle", "ref", "cursor", "maxScanBytes", "maxMatches", "maxSnippetBytes", "maxOutputBytes"]);
const metadataKeys = new Set(["role", "toolCallId", "name", "target", "ref"]);
function utf8(value: string): boolean { return Buffer.from(value, "utf8").toString("utf8") === value; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function boundary(bytes: Buffer, at: number): boolean { return at === 0 || at === bytes.length || (bytes[at]! & 0xc0) !== 0x80; }
function size(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function integer(value: unknown, fallback: number, min: number, max: number): number {
	const number = value === undefined ? fallback : value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) throw new Error("INVALID_LIMIT");
	return number;
}
function parseQuery(args: Record<string, unknown>): Query {
	if (!args || Object.keys(args).some((key) => !queryKeys.has(key))) throw new Error("INVALID_ARGUMENTS");
	const { needle, ref, cursor } = args;
	if (needle !== undefined && (typeof needle !== "string" || !needle || !utf8(needle) || Buffer.byteLength(needle) > SESSION_SEARCH_LIMITS.maxNeedleBytes)) throw new Error("INVALID_LITERAL");
	if (ref !== undefined && (typeof ref !== "string" || !shownRef.test(ref))) throw new Error("INVALID_REF");
	if (needle === undefined && ref === undefined) throw new Error("NEEDLE_REQUIRED");
	if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 512)) throw new Error("INVALID_CURSOR");
	const needleBytes = typeof needle === "string" ? Buffer.byteLength(needle) : 1;
	return {
		...(typeof needle === "string" ? { needle } : {}), ...(typeof ref === "string" ? { ref } : {}), ...(typeof cursor === "string" ? { cursor } : {}),
		maxScanBytes: integer(args.maxScanBytes, SESSION_SEARCH_LIMITS.defaultScanBytes, needle === undefined ? 4 : needleBytes, SESSION_SEARCH_LIMITS.maxScanBytes),
		maxMatches: integer(args.maxMatches, SESSION_SEARCH_LIMITS.defaultMatches, 1, SESSION_SEARCH_LIMITS.maxMatches),
		maxSnippetBytes: integer(args.maxSnippetBytes, SESSION_SEARCH_LIMITS.defaultSnippetBytes, Math.max(4, needleBytes), SESSION_SEARCH_LIMITS.maxSnippetBytes),
		maxOutputBytes: integer(args.maxOutputBytes, SESSION_SEARCH_LIMITS.defaultOutputBytes, SESSION_SEARCH_LIMITS.minOutputBytes, SESSION_SEARCH_LIMITS.maxOutputBytes),
	};
}

/** A host-populated, current-instance index. It never discovers files, old sessions, or reasoning. */
export class SessionArchiveIndex {
	private readonly blobs: BlobStore;
	private readonly entries: Entry[] = [];
	private readonly secret = randomBytes(32);
	private totalBytes = 0;
	constructor(blobs: BlobStore) { this.blobs = blobs; }

	/** Call only for visible message bodies. Unknown/hidden-reasoning fields are rejected. */
	record(content: string, metadata: SessionRecordMetadata): string {
		if (typeof content !== "string" || !utf8(content) || !metadata || typeof metadata !== "object" ||
			Object.keys(metadata).some((key) => !metadataKeys.has(key)) || !["user", "assistant", "tool"].includes(metadata.role)) throw new Error("INVALID_SESSION_RECORD");
		for (const [key, limit] of [["toolCallId", 256], ["name", 128]] as const) {
			const value = metadata[key];
			if (value !== undefined && (typeof value !== "string" || !value || !utf8(value) || Buffer.byteLength(value) > limit)) throw new Error("INVALID_SESSION_RECORD");
		}
		if (metadata.target !== undefined && (typeof metadata.target !== "string" || !metadata.target || !utf8(metadata.target))) throw new Error("INVALID_SESSION_RECORD");
		if (metadata.ref !== undefined && (typeof metadata.ref !== "string" || !shownRef.test(metadata.ref))) throw new Error("INVALID_SESSION_REF");
		const bytes = Buffer.from(content, "utf8");
		if (bytes.length > SESSION_SEARCH_LIMITS.maxRecordBytes || this.totalBytes + bytes.length > SESSION_SEARCH_LIMITS.maxIndexBytes || this.entries.length >= SESSION_SEARCH_LIMITS.maxEntries) throw new Error("SESSION_INDEX_FULL");
		// Always use this store's current-session reference, even when it permits workspace history.
		const ref = this.blobs.put(content, { kind: "shown" });
		if (metadata.ref !== undefined && metadata.ref !== ref) throw new Error("SESSION_REF_MISMATCH");
		const archived = this.blobs.inspect(ref);
		if (!archived || archived.kind !== "shown" || archived.invalidUtf8 || !archived.bytes.equals(bytes)) throw new Error("SESSION_ARCHIVE_UNAVAILABLE");
		const { ref: _ref, ...visibleMetadata } = metadata;
		if (visibleMetadata.target && Buffer.byteLength(visibleMetadata.target) > 512) {
			const label = Buffer.from(visibleMetadata.target); let end = 480;
			while (end > 0 && !boundary(label, end)) end--;
			visibleMetadata.target = label.subarray(0, end).toString("utf8") + " [label truncated]";
			visibleMetadata.targetTruncated = true;
		}
		this.entries.push({ ref, bytes, metadata: { ...visibleMetadata } });
		this.totalBytes += bytes.length;
		return ref;
	}

	private cursor(position: Position, queryHash: string): string {
		const body = Buffer.from(JSON.stringify([1, position.snapshot, position.entry, position.offset, queryHash])).toString("base64url");
		return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
	}
	private position(cursor: string | undefined, queryHash: string): Position {
		if (!cursor) return { snapshot: this.entries.length, entry: 0, offset: 0 };
		const parts = cursor.split(".");
		if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error("INVALID_CURSOR");
		const body = parts[0]!, signature = Buffer.from(parts[1]!, "base64url");
		const expected = createHmac("sha256", this.secret).update(body).digest();
		if (signature.length !== expected.length || !timingSafeEqual(signature, expected) || signature.toString("base64url") !== parts[1]) throw new Error("INVALID_CURSOR");
		let value: unknown;
		try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new Error("INVALID_CURSOR"); }
		if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1 || value[4] !== queryHash) throw new Error("INVALID_CURSOR");
		const [, snapshot, entry, offset] = value;
		if (![snapshot, entry, offset].every((v) => Number.isSafeInteger(v) && v >= 0) || snapshot > this.entries.length || entry > snapshot ||
			(entry === snapshot ? offset !== 0 : offset > this.entries[entry]!.bytes.length)) throw new Error("INVALID_CURSOR");
		return { snapshot, entry, offset };
	}

	async search(args: Record<string, unknown>, ctx: SearchContext): Promise<SessionSearchResult> {
		let query: Query, position: Position, queryHash: string;
		try {
			query = parseQuery(args);
			queryHash = digest(JSON.stringify([query.ref ?? null, query.needle ?? null]));
			position = this.position(query.cursor, queryHash);
		} catch (error) { return { ok: false, error: (error as Error).message }; }
		if (ctx.signal.aborted) return { ok: false, error: "CANCELLED" };
		if (ctx.blobs !== this.blobs || !this.blobs.matchesWorkspace(ctx.workspaceRoot)) return { ok: false, error: "SESSION_UNAVAILABLE" };
		if (query.ref && !this.entries.some((entry, i) => i < position.snapshot && entry.ref === query.ref)) return { ok: false, error: "REF_NOT_IN_SESSION" };
		const needle = query.needle === undefined ? undefined : Buffer.from(query.needle, "utf8");
		const matches: SessionMatch[] = [], matchPositions: Position[] = [], limits = new Set<string>(), verified = new Map<number, boolean>();
		let scannedBytes = 0, checkedRecords = 0, unavailableRecords = 0, iterations = 0;
		const advance = () => { position.entry++; position.offset = 0; };
		const result = (): SessionSearchSuccess => ({
			ok: true, matches, scannedBytes, checkedRecords, unavailableRecords,
			complete: position.entry >= position.snapshot && unavailableRecords === 0, limits: [...limits],
			...(position.entry < position.snapshot ? { nextCursor: this.cursor(position, queryHash) } : {}),
		});
		while (position.entry < position.snapshot) {
			if (++iterations % 32 === 0) await setImmediate();
			if (ctx.signal.aborted) return { ok: false, error: "CANCELLED" };
			const entry = this.entries[position.entry]!;
			if (query.ref && entry.ref !== query.ref || position.offset >= entry.bytes.length) { advance(); continue; }
			if (matches.length >= query.maxMatches) { limits.add("matches"); break; }
			const remaining = query.maxScanBytes - scannedBytes;
			if (remaining < (needle?.length ?? 1)) { limits.add("scan-bytes"); break; }
			const scanEnd = Math.min(entry.bytes.length, position.offset + remaining);
			const relative = needle ? entry.bytes.subarray(position.offset, scanEnd).indexOf(needle) : 0;
			if (relative < 0) {
				scannedBytes += scanEnd - position.offset;
				if (scanEnd === entry.bytes.length) advance();
				else { position.offset = scanEnd - (needle!.length - 1); limits.add("scan-bytes"); break; }
				continue;
			}
			const found = position.offset + relative;
			const matchEnd = found + (needle?.length ?? 0);
			// Charge bytes already searched even if recovery fails or this hit cannot be emitted.
			if (needle) scannedBytes += matchEnd - position.offset;
			if (!verified.has(position.entry)) {
				if (checkedRecords >= SESSION_SEARCH_LIMITS.maxCheckedRecords) { limits.add("archive-checks"); break; }
				checkedRecords++;
				let intact = false;
				try {
					const archive = this.blobs.inspect(entry.ref);
					intact = !!archive && archive.kind === "shown" && !archive.invalidUtf8 && archive.bytes.equals(entry.bytes);
				} catch { /* Do not expose storage paths or errors. */ }
				if (ctx.signal.aborted) return { ok: false, error: "CANCELLED" };
				verified.set(position.entry, intact);
			}
			if (!verified.get(position.entry)) { unavailableRecords++; limits.add("archive-unavailable"); advance(); continue; }
			let start = needle ? Math.max(0, found - Math.floor((query.maxSnippetBytes - needle.length) / 2)) : found;
			while (!boundary(entry.bytes, start)) start++;
			let end = Math.min(entry.bytes.length, start + query.maxSnippetBytes);
			if (!needle) end = Math.min(end, scanEnd);
			while (end > start && !boundary(entry.bytes, end)) end--;
			if (end <= start || end < matchEnd) { limits.add("scan-bytes"); break; }
			const hit: SessionMatch = { ordinal: position.entry + 1, ref: entry.ref, ...entry.metadata,
				byteStart: start, byteEnd: end, text: entry.bytes.subarray(start, end).toString("utf8"), truncated: start > 0 || end < entry.bytes.length };
			const previous = { ...position };
			if (!needle) scannedBytes += end - position.offset;
			position.offset = needle ? matchEnd : end;
			if (position.offset >= entry.bytes.length) advance();
			matches.push(hit);
			// Reserve enough bytes for a stop reason and a cursor, even if this hit reached the snapshot end.
			const reserve = { ...result(), limits: [...limits, "output-bytes"], nextCursor: this.cursor(previous, queryHash) };
			if (size(reserve) > query.maxOutputBytes) {
				matches.pop(); position = previous;
				if (!matches.length) return { ok: false, error: "OUTPUT_LIMIT_TOO_SMALL" };
				limits.add("output-bytes"); break;
			}
			matchPositions.push(previous);
		}
		if (ctx.signal.aborted) return { ok: false, error: "CANCELLED" };
		// Later failures/stop reasons can add metadata after the last successful hit.
		// Rewind omitted hits so exact final JSON accounting never loses results.
		while (size(result()) > query.maxOutputBytes) {
			const previous = matchPositions.pop();
			if (!previous) return { ok: false, error: "OUTPUT_LIMIT_TOO_SMALL" };
			matches.pop(); position = previous; limits.add("output-bytes");
		}
		return result();
	}
}
