import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVerifiedLog, searchVerifiedLog, type BoundedSearchResult, type SearchQuery, type VerifiedLogHandle, type VerifiedLogMetadata } from '../src/bounded-log-search.ts';

// All inputs are synthetic. These tests verify deterministic byte handling;
// they do not measure model accuracy, task success, time, tokens, or money saved.
type SuccessfulSearchResult = Extract<BoundedSearchResult, { ok: true }>;
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function verified(input: string | Buffer, metadata: Partial<VerifiedLogMetadata> = {}, options: { maxArchiveBytes?: number; maxOutputBytes?: number } = {}): VerifiedLogHandle {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const handle = createVerifiedLog(bytes, { ref: 'synthetic-ref', authorized: true, expectedSha256: sha(bytes), expectedBytes: bytes.length, ...metadata }, options);
  assert.ok('type' in handle, JSON.stringify(handle));
  assert.equal(handle.type, 'VerifiedLog');
  return handle;
}
const state = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ toolCallId: 'call-1', exitCode: 0, timedOut: false, captureComplete: true, cancelled: false, signal: null, ...patch });
function search(handle: VerifiedLogHandle, patch: Partial<SearchQuery> = {}): SuccessfulSearchResult {
  const result = searchVerifiedLog(handle, { needle: 'target', maxOutputBytes: 16384, ...patch });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= (patch.maxOutputBytes ?? 16384));
  return result;
}
function originalSnippet(result: SuccessfulSearchResult, input: string | Buffer, index = 0): void {
  const { snippet, match } = result.matches[index]!;
  const original = Buffer.isBuffer(input) ? input : Buffer.from(input);
  assert.deepEqual(Buffer.from(snippet.text, snippet.encoding), original.subarray(snippet.byteStart, snippet.byteEnd));
  assert.ok(snippet.byteStart <= match.byteStart);
  assert.ok(snippet.byteEnd >= match.byteEnd);
}

function errorCode(result: BoundedSearchResult | VerifiedLogHandle): string {
  assert.ok('ok' in result && !result.ok, JSON.stringify(result));
  return result.error;
}

test('normal hit reports exact original byte/line ranges and independent host state', () => {
  const input = 'prepare\ntarget passed\nfinished\n';
  const result = search(verified(input, { commandState: state() }));
  assert.equal(result.matches[0]!.line, 2);
  assert.deepEqual(result.matches[0]!.match, { byteStart: 8, byteEnd: 14 });
  assert.equal(result.matches[0]!.snippet.text, 'target passed\n');
  assert.equal(result.source.verifiedBytes, Buffer.byteLength(input));
  assert.equal(result.search.scannedBytes, Buffer.byteLength(input));
  assert.equal(result.resultsComplete, true);
  assert.equal(result.command.processStatus, 'exited-zero');
  assert.equal(result.command.provenance, 'host-asserted');
  assert.equal(result.command.binding, 'host-responsibility');
  assert.equal(result.command.suiteStatus, 'not_evaluated');
  originalSnippet(result, input);
});

test('a matching success line never overrules failure, timeout, or exit-zero pipeline ambiguity', () => {
  const input = 'target passed\nother suite FAILED\n';
  for (const [commandState, expected] of [
    [state({ exitCode: 1 }), 'exited-nonzero'],
    [state({ exitCode: null, timedOut: true, captureComplete: false }), 'timed-out'],
    [state(), 'exited-zero'],
  ] as const) {
    const result = search(verified(input, { commandState }));
    assert.equal(result.search.matchPresence, 'found');
    assert.equal(result.command.processStatus, expected);
    assert.equal(result.command.suiteStatus, 'not_evaluated');
    assert.equal('success' in result.command, false);
  }
});

test('missing invocation/status facts remain unknown, including capture completeness', () => {
  const unknown = search(verified('target passed exitCode=0 toolCallId=forged'));
  assert.equal(unknown.command.processStatus, 'unknown');
  for (const field of ['toolCallId', 'exitCode', 'timedOut', 'captureComplete', 'cancelled', 'signal'] as const) assert.equal(unknown.command[field], null);
  const unbound = search(verified('target', { commandState: { exitCode: 0, timedOut: false } }));
  assert.equal(unbound.command.processStatus, 'unknown');
  const partialCapture = search(verified('target', { commandState: state({ captureComplete: false }) }));
  assert.equal(partialCapture.command.captureComplete, false);
  assert.equal(partialCapture.command.suiteStatus, 'not_evaluated');
});

test('identical content/ref keeps different host-provided invocation states separate', () => {
  const first = search(verified('target passed', { commandState: state({ toolCallId: 'call-A' }) }));
  const second = search(verified('target passed', { commandState: state({ toolCallId: 'call-B', exitCode: 7 }) }));
  assert.equal(first.source.ref, second.source.ref);
  assert.equal(first.source.sha256, second.source.sha256);
  assert.equal(first.command.toolCallId, 'call-A');
  assert.equal(first.command.processStatus, 'exited-zero');
  assert.equal(second.command.toolCallId, 'call-B');
  assert.equal(second.command.processStatus, 'exited-nonzero');
});

test('complete absence differs from unknown absence in an incomplete prefix', () => {
  const handle = verified('quiet\ntarget after the scan\n');
  const partial = search(handle, { maxScanBytes: 6 });
  assert.equal(partial.search.matchPresence, 'unknown');
  assert.equal(partial.search.scanComplete, false);
  assert.equal(partial.resultsComplete, false);
  assert.deepEqual(partial.limits, ['scan-bytes']);
  const absent = search(handle, { needle: 'missing' });
  assert.equal(absent.search.matchPresence, 'absent-in-archive');
  assert.equal(absent.resultsComplete, true);
  assert.equal(search(handle, { maxScanBytes: 0 }).search.matchPresence, 'unknown');
  assert.equal(search(verified(''), { maxScanBytes: 0 }).search.matchPresence, 'absent-in-archive');
});

test('a match crossing the scan boundary is not claimed; partial matching line is labelled', () => {
  const handle = verified('target rest\n');
  assert.equal(search(handle, { maxScanBytes: 5 }).search.matchPresence, 'unknown');
  const partial = search(handle, { maxScanBytes: 6 });
  assert.equal(partial.search.matchPresence, 'found');
  assert.equal(partial.matches[0]!.lineComplete, false);
  assert.equal(partial.matches[0]!.observedLineByteEnd, 6);
  assert.equal(partial.matches[0]!.snippet.truncatedAfter, true);
  assert.equal(partial.source.verifiedBytes, 12);
  assert.equal(partial.search.scannedBytes, 6);
});

test('whole-buffer hash detects corruption outside any later search prefix', () => {
  const bytes = Buffer.from('target\nverified tail');
  const expectedSha256 = sha(bytes);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  assert.deepEqual(createVerifiedLog(bytes, { ref: 'r', authorized: true, expectedBytes: bytes.length, expectedSha256 }), { ok: false, error: 'SHA256_MISMATCH' });
});

test('verified snapshot is private and independent of later caller mutations', () => {
  const bytes = Buffer.from('target\n');
  const metadata = { commandState: state() };
  const handle = verified(bytes, metadata);
  assert.equal(Object.isFrozen(handle), true);
  bytes.fill(0);
  metadata.commandState.exitCode = 99;
  const result = search(handle);
  assert.equal(result.matches[0]!.snippet.text, 'target\n');
  assert.equal(result.command.exitCode, 0);
  assert.deepEqual(searchVerifiedLog({ type: 'VerifiedLog' }, { needle: 'target' }), { ok: false, error: 'VERIFIED_HANDLE_REQUIRED' });
});

test('host authorization assertion, trusted length/hash and archive ceiling are required', () => {
  const bytes = Buffer.from('target');
  const metadata = { ref: 'r', authorized: true, expectedBytes: bytes.length, expectedSha256: sha(bytes) };
  assert.equal(errorCode(createVerifiedLog(bytes, { ...metadata, authorized: false })), 'HOST_AUTHORIZATION_REQUIRED');
  assert.equal(errorCode(createVerifiedLog(bytes, { ...metadata, expectedBytes: undefined })), 'BYTE_LENGTH_MISMATCH');
  assert.equal(errorCode(createVerifiedLog(bytes, { ...metadata, expectedSha256: undefined })), 'INVALID_SHA256');
  assert.equal(errorCode(createVerifiedLog(bytes, metadata, { maxArchiveBytes: 5 })), 'ARCHIVE_LIMIT');
  const shared = Buffer.from(new SharedArrayBuffer(6));
  assert.equal(errorCode(createVerifiedLog(shared, { ...metadata, expectedSha256: sha(shared) })), 'SHARED_BUFFER_UNSUPPORTED');
});

test('match count cap reports omitted lines while completing bounded prefix traversal', () => {
  const result = search(verified('target\ntarget target\nquiet\ntarget\n'), { maxMatches: 1 });
  assert.equal(result.returnedMatches, 1);
  assert.equal(result.search.matchingLinesInScannedPrefix, 3);
  assert.equal(result.search.scanComplete, true);
  assert.equal(result.resultsComplete, false);
  assert.deepEqual(result.limits, ['match-count']);
});

test('full JSON output cap accounts for escaped text, metadata and error objects', () => {
  const handle = verified(('target "quoted" \\ path\t\u0000\n').repeat(20), { ref: '"'.repeat(150), commandState: state({ toolCallId: '\\'.repeat(150) }) });
  const full = search(handle);
  const cap = Buffer.byteLength(JSON.stringify(full)) - 1;
  const limited = search(handle, { maxOutputBytes: cap });
  assert.ok(limited.returnedMatches < full.returnedMatches);
  assert.ok(limited.limits.includes('output-bytes'));
  assert.equal(limited.resultsComplete, false);
  for (const budget of [64, 100, 256, 512, 1024, 2048]) {
    const result = searchVerifiedLog(handle, { needle: 'target', maxOutputBytes: budget });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= budget);
  }
  const error = searchVerifiedLog(handle, { needle: 'target', maxOutputBytes: 64 });
  assert.deepEqual(error, { ok: false, error: 'OUTPUT_LIMIT_TOO_SMALL' });
  const invalid = searchVerifiedLog(handle, { needle: /target/, maxOutputBytes: 64 });
  assert.ok(Buffer.byteLength(JSON.stringify(invalid)) <= 64);
  assert.throws(() => searchVerifiedLog(handle, { needle: 'target', maxOutputBytes: 0 }), /maxOutputBytes/);
  assert.throws(() => searchVerifiedLog(handle, { needle: 'target', maxOutputBytes: 63 }), /maxOutputBytes/);
});

test('malformed UTF-8 is reported and its snippet is byte-exact base64', () => {
  const input = Buffer.concat([Buffer.from('target '), Buffer.from([0xff, 0xc3, 0x28, 10])]);
  const result = search(verified(input));
  assert.equal(result.source.utf8, false);
  assert.equal(result.matches[0]!.snippet.encoding, 'base64');
  originalSnippet(result, input);
  const cap = 64;
  assert.ok(Buffer.byteLength(JSON.stringify(searchVerifiedLog(verified(input), { needle: 'target', maxOutputBytes: cap }))) <= cap);
});

test('Unicode, emoji, BOM and CRLF keep exact byte offsets without normalization', () => {
  const input = '\ufeff标题\r\n前缀🙂目标 e\u0301\r\n目标尾';
  const bytes = Buffer.from(input);
  const result = search(verified(bytes), { needle: '目标' });
  assert.deepEqual(result.matches.map((match) => match.line), [2, 3]);
  assert.deepEqual(result.matches[0]!.match, { byteStart: bytes.indexOf(Buffer.from('目标')), byteEnd: bytes.indexOf(Buffer.from('目标')) + 6 });
  assert.equal(result.matches[0]!.snippet.text, '前缀🙂目标 e\u0301\r\n');
  assert.equal(result.matches[1]!.lineComplete, true);
  originalSnippet(result, bytes, 0);
  originalSnippet(result, bytes, 1);
  assert.equal(search(verified(bytes), { needle: 'é' }).search.matchPresence, 'absent-in-archive');
  assert.equal(search(verified(bytes), { needle: '\ufeff' }).matches[0]!.match.byteStart, 0);
});

test('ASCII-only case folding leaves other Unicode code points exact', () => {
  const handle = verified('TARGET Ä\ntarget ä\n');
  assert.equal(search(handle).returnedMatches, 1);
  assert.equal(search(handle, { caseMode: 'ascii-insensitive' }).returnedMatches, 2);
  const result = search(handle, { needle: 'TARGET ä', caseMode: 'ascii-insensitive' });
  assert.equal(result.returnedMatches, 1);
  assert.equal(result.matches[0]!.line, 2);
  assert.equal(result.matches[0]!.snippet.text, 'target ä\n');
});

test('regex syntax remains literal, and regex/multiline/empty/surrogate queries fail', () => {
  const handle = verified('a.*b\naxxxb\n');
  assert.equal(search(handle, { needle: 'a.*b' }).returnedMatches, 1);
  for (const needle of [/a.*b/, '', 'a\nb', 'a\rb', '\ud800']) {
    assert.equal(errorCode(searchVerifiedLog(handle, { needle })), 'INVALID_LITERAL');
  }
});

test('a very long line returns a bounded original snippet containing the distant match', () => {
  const input = 'a'.repeat(200000) + 'target' + '🙂'.repeat(100) + '\n';
  const bytes = Buffer.from(input);
  const result = search(verified(bytes), { maxLineBytes: 47 });
  assert.equal(result.matches[0]!.match.byteStart, 200000);
  assert.equal(result.matches[0]!.line, 1);
  assert.equal(result.matches[0]!.lineComplete, true);
  assert.equal(result.matches[0]!.snippet.encoding, 'utf8');
  assert.equal(result.matches[0]!.snippet.truncatedBefore, true);
  assert.equal(result.matches[0]!.snippet.truncatedAfter, true);
  assert.ok(Buffer.byteLength(result.matches[0]!.snippet.text) <= 47);
  assert.ok(result.limits.includes('line-preview'));
  assert.equal(result.resultsComplete, true);
  assert.equal(result.snippetsComplete, false);
  originalSnippet(result, bytes);
});

test('a prefix cut within an emoji never emits replacement text or claims a complete line', () => {
  const input = Buffer.from('target🙂 tail\n');
  const result = search(verified(input), { maxScanBytes: 8 });
  assert.equal(result.source.utf8, true);
  assert.equal(result.source.verifiedBytes, input.length);
  assert.equal(result.search.scannedBytes, 8);
  assert.equal(result.matches[0]!.snippet.text, 'target');
  assert.equal(result.matches[0]!.snippet.byteEnd, 6);
  assert.equal(result.matches[0]!.snippet.encoding, 'utf8');
  assert.equal(result.matches[0]!.lineComplete, false);
  assert.equal(result.search.scanComplete, false);
  originalSnippet(result, input);
});

test('known command exit and complete archive scan still do not prove full capture or suite outcome', () => {
  const result = search(verified('target passed', { commandState: { toolCallId: 'call-unknown-capture', exitCode: 0, timedOut: false, cancelled: false, signal: null } }));
  assert.equal(result.resultsComplete, true);
  assert.equal(result.command.processStatus, 'exited-zero');
  assert.equal(result.command.captureComplete, null);
  assert.equal(result.command.suiteStatus, 'not_evaluated');
});

test('omitted cancellation and signal leave the exit-zero counterexample unknown', () => {
  const result = search(verified('target passed', { commandState: { toolCallId: 'call-partial-state', exitCode: 0, timedOut: false } }));
  assert.equal(result.command.processStatus, 'unknown');
  assert.equal(result.command.cancelled, null);
  assert.equal(result.command.signal, null);
  assert.equal(result.command.signalKnown, false);
});

test('zero and nonzero exits require known uncancelled, untimed-out, unsignalled state', () => {
  for (const exitCode of [0, 7]) {
    for (const missing of ['toolCallId', 'exitCode', 'timedOut', 'cancelled', 'signal']) {
      const commandState = state({ exitCode });
      delete commandState[missing];
      const result = search(verified('target passed', { commandState }));
      assert.equal(result.command.processStatus, 'unknown', `exit ${exitCode}; missing ${missing}`);
    }
    const result = search(verified('target passed', { commandState: state({ exitCode }) }));
    assert.equal(result.command.processStatus, exitCode === 0 ? 'exited-zero' : 'exited-nonzero');
    assert.equal(result.command.signalKnown, true);
    assert.equal(result.command.signal, null);
  }
});

test('explicit absent signal differs from omitted or undefined signal after JSON serialization', () => {
  const omitted = state();
  delete omitted.signal;
  for (const commandState of [omitted, state({ signal: undefined }), { ...omitted, signalKnown: true }, Object.assign(Object.create({ signal: null }), omitted)]) {
    const command = JSON.parse(JSON.stringify(search(verified('target', { commandState })))).command;
    assert.equal(command.signal, null);
    assert.equal(command.signalKnown, false);
    assert.equal(command.processStatus, 'unknown');
  }
  const known = JSON.parse(JSON.stringify(search(verified('target', { commandState: state() })))).command;
  assert.equal(known.signal, null);
  assert.equal(known.signalKnown, true);
  assert.equal(known.processStatus, 'exited-zero');
});

test('known cancellation, timeout or signal remains reportable when other facts are unknown', () => {
  for (const [partial, expected] of [
    [{ cancelled: true }, 'cancelled'],
    [{ timedOut: true }, 'timed-out'],
    [{ signal: 'SIGTERM' }, 'terminated-by-signal'],
    [{ cancelled: true, timedOut: true, signal: 'SIGTERM' }, 'cancelled'],
    [{ timedOut: true, signal: 'SIGTERM' }, 'timed-out'],
  ] as const) {
    const result = search(verified('target', { commandState: { toolCallId: 'call-partial-state', exitCode: 0, ...partial } }));
    assert.equal(result.command.processStatus, expected);
    assert.equal(result.command.suiteStatus, 'not_evaluated');
  }
});

test('host cancellation and signals survive serialization and override exit zero', () => {
  const cancelled = search(verified('target passed', { commandState: state({ cancelled: true, signal: 'SIGTERM' }) }));
  assert.equal(cancelled.command.cancelled, true);
  assert.equal(cancelled.command.signal, 'SIGTERM');
  assert.equal(cancelled.command.exitCode, 0);
  assert.equal(cancelled.command.processStatus, 'cancelled');
  const signalled = search(verified('target passed', { commandState: state({ signal: 'SIGKILL' }) }));
  assert.equal(signalled.command.signal, 'SIGKILL');
  assert.equal(signalled.command.processStatus, 'terminated-by-signal');
  assert.equal(signalled.command.suiteStatus, 'not_evaluated');
});

test('many large matches obey whole-response cap and retain the largest fitting prefix', () => {
  const handle = verified(('target ' + '"\\'.repeat(1000) + '\n').repeat(300));
  const result = search(handle, { maxMatches: 300, maxLineBytes: 2048, maxOutputBytes: 16384 });
  assert.equal(result.search.matchingLinesInScannedPrefix, 300);
  assert.ok(result.returnedMatches > 0 && result.returnedMatches < 300);
  assert.ok(result.limits.includes('output-bytes'));
  const exactBytes = Buffer.byteLength(JSON.stringify(result));
  const exact = search(handle, { maxMatches: 300, maxLineBytes: 2048, maxOutputBytes: exactBytes });
  assert.equal(exact.returnedMatches, result.returnedMatches);
  const smaller = search(handle, { maxMatches: 300, maxLineBytes: 2048, maxOutputBytes: exactBytes - 1 });
  assert.equal(smaller.returnedMatches, result.returnedMatches - 1);
});

test('signal getter is read once and its first value stays bound to the verified snapshot', () => {
  let reads = 0;
  const commandState = state();
  Object.defineProperty(commandState, 'signal', {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? 'SIGTERM' : null;
    },
  });
  const handle = verified('target passed', { commandState });
  assert.equal(reads, 1);
  const result = search(handle);
  assert.equal(reads, 1);
  assert.equal(result.command.signalKnown, true);
  assert.equal(result.command.signal, 'SIGTERM');
  assert.equal(result.command.processStatus, 'terminated-by-signal');
  assert.equal(result.command.suiteStatus, 'not_evaluated');
  assert.equal(search(handle).command.signal, 'SIGTERM');
  assert.equal(reads, 1);
});
