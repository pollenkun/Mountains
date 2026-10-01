import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

/**
 * Pure bounded archive search; no filesystem, shell, model, or summarizer.
 * Ported from the independently checked 2026-09-27 research prototype.
 *
 * createVerifiedLog(Buffer, metadata, options?) -> opaque handle | short error
 * searchVerifiedLog(handle, query) -> JSON-serializable result | short error
 *
 * The HOST must authorize workspace/session access BEFORE calling this API.
 * `authorized: true` is its assertion, NOT a permission check and MUST NOT be a
 * model-controlled argument. The host must supply expectedBytes and a trusted
 * expectedSha256 for the WHOLE archive. SHA-256 checks content, not authenticity.
 * It does not authenticate ref, toolCallId, or command state. The host must bind
 * metadata.ref <-> commandState.toolCallId <-> state from the actual invocation;
 * identical content refs can belong to different invocations with different exits.
 * Optional commandState: toolCallId, exitCode, timedOut, captureComplete,
 * cancelled and signal. Missing facts stay null/unknown. For signal, explicit
 * null means known absent; omission/undefined means unknown. The output's
 * signalKnown records this distinction. An exit status requires cancelled=false,
 * timedOut=false and an explicitly absent signal. Nothing is inferred from
 * text. Cancellation, timeout and a termination signal take precedence over
 * the numeric exit code.
 * Even exit zero does not prove a test suite passed (e.g. a pipeline without
 * pipefail). suiteStatus is always not_evaluated.
 *
 * A complete PRIVATE COPY is hashed and checked for UTF-8 before search. The
 * caller cannot mutate it through the handle. maxArchiveBytes bounds this copy
 * and full validation; it does NOT bound the caller's earlier IO/decompression.
 * maxScanBytes only bounds bytes considered by matching/line traversal, NOT IO,
 * the copy, the full SHA pass, or the full UTF-8 pass. No gzip support is implied.
 * verifiedBytes describes the whole hash check; scannedBytes describes search.
 *
 * query.needle is a nonempty single-line string, never a regex. One first match
 * per LF-delimited line is returned. CRLF/BOM are preserved. Ranges are original
 * zero-based bytes [start,end), line numbers are one-based. ascii-insensitive
 * folds A-Z only; all other UTF-8 bytes remain exact, with NO normalization.
 * A prefix cut inside a line/character is explicitly partial. Invalid UTF-8
 * snippets use base64 so replacement decoding never silently changes bytes.
 * No-match describes scanned bytes only, never whether a test ran.
 *
 * maxOutputBytes bounds Buffer.byteLength(JSON.stringify(result)), including
 * metadata, escaping, base64 and errors. Valid configuration is 64..1MiB. An
 * impossible/invalid budget throws a fixed RangeError BEFORE any operation;
 * exceptions are API configuration errors, not serializable search responses.
 * All other failures are short bounded JSON objects with no log text or stack.
 */

export interface VerifiedLogHandle { readonly type: "VerifiedLog" }
export interface BoundedSearchError { ok: false; error: string }
export interface VerifiedLogMetadata {
  ref: string;
  authorized: true;
  expectedSha256: string;
  expectedBytes: number;
  commandState?: unknown;
}
export interface SearchQuery {
  needle: string;
  caseMode?: "exact" | "ascii-insensitive";
  maxScanBytes?: number;
  maxMatches?: number;
  maxLineBytes?: number;
  maxOutputBytes?: number;
}
interface CommandState {
  toolCallId: string | null;
  exitCode: number | null;
  timedOut: boolean | null;
  captureComplete: boolean | null;
  cancelled: boolean | null;
  signal: string | null;
  signalKnown: boolean;
}
interface VerifiedLogSnapshot {
  bytes: Buffer;
  sha256: string;
  ref: string;
  state: Readonly<CommandState>;
  utf8: boolean;
}
export interface LogMatch {
  line: number;
  lineByteStart: number;
  observedLineByteEnd: number;
  lineComplete: boolean;
  match: { byteStart: number; byteEnd: number };
  snippet: { byteStart: number; byteEnd: number; encoding: "utf8" | "base64"; text: string; truncatedBefore: boolean; truncatedAfter: boolean };
}
export interface BoundedSearchSuccess {
  ok: true;
  source: { ref: string; sha256: string; totalBytes: number; verifiedBytes: number; utf8: boolean };
  command: CommandState & { provenance: "host-asserted"; binding: "host-responsibility"; processStatus: string; suiteStatus: "not_evaluated" };
  search: { caseMode: "exact" | "ascii-insensitive"; scannedBytes: number; scanComplete: boolean; matchingLinesInScannedPrefix: number; matchPresence: "found" | "absent-in-archive" | "unknown" };
  returnedMatches: number;
  resultsComplete: boolean;
  snippetsComplete: boolean;
  limits: string[];
  matches: LogMatch[];
}
export type BoundedSearchResult = BoundedSearchSuccess | BoundedSearchError;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const HARD_ARCHIVE_BYTES = 64 * 1024 * 1024;
const HARD_OUTPUT_BYTES = 1024 * 1024;
const privateLogs = new WeakMap<VerifiedLogHandle, VerifiedLogSnapshot>();
const err = (error: string): BoundedSearchError => ({ ok: false, error });
const integerIn = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function outputBudget(value: unknown = 16 * 1024): number {
  if (!integerIn(value, 64, HARD_OUTPUT_BYTES)) {
    throw new RangeError('maxOutputBytes must be 64..1048576');
  }
  return value;
}

function normalizeState(value: unknown): CommandState | null {
  if (value === undefined) return { toolCallId: null, exitCode: null, timedOut: null, captureComplete: null, cancelled: null, signal: null, signalKnown: false };
  if (!record(value)) return null;
  const { toolCallId = null, exitCode = null, timedOut = null, captureComplete = null, cancelled = null } = value;
  const suppliedSignal = Object.hasOwn(value, 'signal') ? value.signal : undefined;
  const signalKnown = suppliedSignal !== undefined;
  const signal = signalKnown ? suppliedSignal : null;
  if (toolCallId !== null && (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 256)) return null;
  if (exitCode !== null && !integerIn(exitCode, 0, 0x7fffffff)) return null;
  if (timedOut !== null && typeof timedOut !== 'boolean') return null;
  if (captureComplete !== null && typeof captureComplete !== 'boolean') return null;
  if (cancelled !== null && typeof cancelled !== 'boolean') return null;
  if (signal !== null && (typeof signal !== 'string' || !signal || signal.length > 64)) return null;
  return { toolCallId, exitCode, timedOut, captureComplete, cancelled, signal, signalKnown };
}

export function createVerifiedLog(input: unknown, metadata: unknown, options: unknown = {}): VerifiedLogHandle | BoundedSearchError {
  if (!record(options)) return err("INVALID_OPTIONS");
  outputBudget(options.maxOutputBytes);
  const maxArchiveBytes = options.maxArchiveBytes ?? HARD_ARCHIVE_BYTES;
  if (!integerIn(maxArchiveBytes, 0, HARD_ARCHIVE_BYTES)) return err('INVALID_ARCHIVE_LIMIT');
  if (!Buffer.isBuffer(input)) return err('BUFFER_REQUIRED');
  if (!record(metadata) || metadata.authorized !== true) return err('HOST_AUTHORIZATION_REQUIRED');
  if (typeof metadata.ref !== 'string' || !metadata.ref || metadata.ref.length > 256) return err('INVALID_REF');
  if (input.length > maxArchiveBytes) return err('ARCHIVE_LIMIT');
  if (!integerIn(metadata.expectedBytes, 0, HARD_ARCHIVE_BYTES) || metadata.expectedBytes !== input.length) return err('BYTE_LENGTH_MISMATCH');
  const expected = metadata.expectedSha256;
  if (typeof expected !== 'string' || expected.length !== 64 || [...expected].some((c) => !'0123456789abcdef'.includes(c))) return err('INVALID_SHA256');
  const state = normalizeState(metadata.commandState);
  if (!state) return err('INVALID_COMMAND_STATE');
  // A concurrently writable SharedArrayBuffer cannot supply a stable snapshot.
  if (input.buffer instanceof SharedArrayBuffer) return err('SHARED_BUFFER_UNSUPPORTED');
  const bytes = Buffer.from(input);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) return err('SHA256_MISMATCH');
  const handle: VerifiedLogHandle = Object.freeze({ type: 'VerifiedLog' });
  privateLogs.set(handle, { bytes, sha256, ref: metadata.ref, state: Object.freeze(state), utf8: isUtf8(bytes) });
  return handle;
}

function foldAscii(bytes: Buffer): Buffer {
  const folded = Buffer.from(bytes);
  for (let i = 0; i < folded.length; i++) {
    const byte = folded[i]!;
    if (byte >= 65 && byte <= 90) folded[i] = byte + 32;
  }
  return folded;
}

function commandFacts(state: CommandState): BoundedSearchSuccess["command"] {
  let processStatus = 'unknown';
  // toolCallId is necessary to attribute status to a particular invocation.
  // Its authenticity and association remain the host's responsibility.
  if (state.toolCallId) {
    if (state.cancelled === true) processStatus = 'cancelled';
    else if (state.timedOut === true) processStatus = 'timed-out';
    else if (state.signal !== null) processStatus = 'terminated-by-signal';
    else if (state.cancelled === false && state.timedOut === false && state.signalKnown && state.signal === null && state.exitCode !== null) processStatus = state.exitCode === 0 ? 'exited-zero' : 'exited-nonzero';
  }
  return { ...state, provenance: 'host-asserted', binding: 'host-responsibility', processStatus, suiteStatus: 'not_evaluated' };
}

function preview(log: VerifiedLogSnapshot, scan: Buffer, lineStart: number, lineEnd: number, lineNumber: number, lineComplete: boolean, hit: number, needleBytes: number, maxLineBytes: number): LogMatch {
  const hitEnd = hit + needleBytes;
  let start = Math.max(lineStart, hit - Math.min(80, Math.floor((maxLineBytes - needleBytes) / 2)));
  let end = Math.min(lineEnd, start + maxLineBytes);
  if (end < hitEnd) { end = hitEnd; start = Math.max(lineStart, end - maxLineBytes); }
  if (log.utf8) {
    // Remove incomplete UTF-8 edge characters, without changing matched bytes.
    while (start < hit && ((scan[start] ?? 0) & 0xc0) === 0x80) start++;
    // Inspect only the chosen prefix; never peek at bytes beyond maxScanBytes.
    while (end > hitEnd && !isUtf8(scan.subarray(start, end))) end--;
  }
  const slice = scan.subarray(start, end);
  const encoding = isUtf8(slice) ? 'utf8' : 'base64';
  return {
    line: lineNumber,
    lineByteStart: lineStart,
    observedLineByteEnd: lineEnd,
    lineComplete,
    match: { byteStart: hit, byteEnd: hitEnd },
    snippet: {
      byteStart: start, byteEnd: end, encoding,
      text: slice.toString(encoding),
      truncatedBefore: start > lineStart,
      truncatedAfter: end < lineEnd || !lineComplete,
    },
  };
}

export function searchVerifiedLog(handle: unknown, query: unknown = {}): BoundedSearchResult {
  if (!record(query)) return err("INVALID_QUERY");
  const maxOutputBytes = outputBudget(query.maxOutputBytes);
  const log = handle && typeof handle === 'object' ? privateLogs.get(handle as VerifiedLogHandle) : null;
  if (!log) return err('VERIFIED_HANDLE_REQUIRED');
  const { needle, caseMode = 'exact', maxScanBytes = 1024 * 1024, maxMatches = 20, maxLineBytes = 1024 } = query;
  if (typeof needle !== 'string' || !needle || needle.includes('\n') || needle.includes('\r')) return err('INVALID_LITERAL');
  const needleBuffer = Buffer.from(needle, 'utf8');
  if (needleBuffer.length > 4096 || needleBuffer.toString('utf8') !== needle) return err('INVALID_LITERAL');
  if (caseMode !== 'exact' && caseMode !== 'ascii-insensitive') return err('INVALID_CASE_MODE');
  if (!integerIn(maxScanBytes, 0, HARD_ARCHIVE_BYTES) || !integerIn(maxMatches, 1, 1000) || !integerIn(maxLineBytes, needleBuffer.length, 65536)) return err('INVALID_SEARCH_LIMIT');
  const matchLimit = maxMatches;
  const scannedBytes = Math.min(log.bytes.length, maxScanBytes);
  const scan = log.bytes.subarray(0, scannedBytes);
  const searchable = caseMode === 'ascii-insensitive' ? foldAscii(scan) : scan;
  const literal = caseMode === 'ascii-insensitive' ? foldAscii(needleBuffer) : needleBuffer;
  const scanComplete = scannedBytes === log.bytes.length;
  const matches: LogMatch[] = [];
  let matchingLinesInScannedPrefix = 0;
  let lineStart = 0;
  let line = 1;
  while (lineStart < scannedBytes) {
    const newline = scan.indexOf(10, lineStart);
    const lineEnd = newline < 0 ? scannedBytes : newline + 1;
    const lineComplete = newline >= 0 || scanComplete;
    const relativeHit = searchable.subarray(lineStart, lineEnd).indexOf(literal);
    if (relativeHit >= 0) {
      matchingLinesInScannedPrefix++;
      if (matches.length < matchLimit) matches.push(preview(log, scan, lineStart, lineEnd, line, lineComplete, lineStart + relativeHit, literal.length, maxLineBytes));
    }
    lineStart = lineEnd;
    line++;
  }
  const result: BoundedSearchSuccess = {
    ok: true,
    source: { ref: log.ref, sha256: log.sha256, totalBytes: log.bytes.length, verifiedBytes: log.bytes.length, utf8: log.utf8 },
    command: commandFacts(log.state),
    search: { caseMode, scannedBytes, scanComplete, matchingLinesInScannedPrefix, matchPresence: matchingLinesInScannedPrefix > 0 ? 'found' : scanComplete ? 'absent-in-archive' : 'unknown' },
    returnedMatches: matches.length,
    resultsComplete: false,
    snippetsComplete: false,
    limits: [],
    matches,
  };
  // Serialize each entry once for its exact escaped UTF-8 length. The prefix
  // sums avoid repeatedly serializing a potentially 64MiB candidate list while
  // trimming it to a small result. Metadata is counted for each candidate too.
  const matchByteSums = [0];
  const truncatedSums = [0];
  for (const match of matches) {
    matchByteSums.push(matchByteSums.at(-1)! + Buffer.byteLength(JSON.stringify(match), 'utf8'));
    truncatedSums.push(truncatedSums.at(-1)! + Number(match.snippet.truncatedBefore || match.snippet.truncatedAfter));
  }
  function refresh(count: number): void {
    result.returnedMatches = count;
    result.resultsComplete = scanComplete && count === matchingLinesInScannedPrefix;
    result.snippetsComplete = truncatedSums[count] === 0;
    result.limits = [
      ...(!scanComplete ? ['scan-bytes'] : []),
      ...(matchingLinesInScannedPrefix > matchLimit ? ['match-count'] : []),
      ...(count < matches.length ? ['output-bytes'] : []),
      ...(!result.snippetsComplete ? ['line-preview'] : []),
    ];
  }
  function sizeAt(count: number): number {
    refresh(count);
    return Buffer.byteLength(JSON.stringify({ ...result, matches: [] }), 'utf8') + matchByteSums[count]! + Math.max(0, count - 1);
  }
  if (sizeAt(0) > maxOutputBytes) return err('OUTPUT_LIMIT_TOO_SMALL');
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sizeAt(mid) <= maxOutputBytes) low = mid;
    else high = mid - 1;
  }
  refresh(low);
  result.matches = matches.slice(0, low);
  // Verify the whole serialized response rather than relying only on counting.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxOutputBytes) return err('OUTPUT_LIMIT_TOO_SMALL');
  return result;
}
