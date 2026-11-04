import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { boundedStep, runWindowsLive, sameProcessIdentity, samplingVerified, semanticPassed, startedDuringLaunch, StepTimeoutError, witnessImageStats, witnessLookChecks } from './windows-live.ts';

test('Windows live cleanup refuses a reused process ID or an incomplete identity', () => {
 const expected = { name: 'Notepad', path: 'C:\\Windows\\Notepad.exe', start: '2026-10-22T12:00:00.0000000Z' };
 assert.equal(sameProcessIdentity(expected, { ...expected }), true);
 assert.equal(sameProcessIdentity(expected, { ...expected, path: expected.path.toLowerCase() }), true);
 for (const actual of [undefined, {}, { ...expected, start: '2026-10-22T12:00:01.0000000Z' }, { ...expected, path: 'C:\\Other\\Notepad.exe' }, { ...expected, name: 'NotepadHelper' }]) {
  assert.equal(sameProcessIdentity(expected, actual), false);
 }
 assert.equal(sameProcessIdentity(undefined, expected), false);
 assert.equal(sameProcessIdentity({ name: '', path: '', start: '' }, { name: '', path: '', start: '' }), false);
});

test('a Notepad process already running without a window is not owned by this launch', () => {
 const identity = { name: 'Notepad', path: 'C:\\Windows\\Notepad.exe', start: '2026-10-22T12:00:00.0000000Z' };
 assert.equal(startedDuringLaunch(identity, Date.parse('2026-10-22T12:00:01Z')), false);
 assert.equal(startedDuringLaunch(identity, Date.parse('2026-10-22T11:59:59Z')), true);
 assert.equal(startedDuringLaunch({ ...identity, start: 'unreadable' }, 0), false);
});

test('Windows live acceptance requires both tool success and independent state', () => {
 const good = { ok: true, outcome: 'confirmed', dispatched: true, confirmedByApp: true, frontStillNotepad: true, witnessActivated: false };
 assert.equal(semanticPassed(good), true);
 assert.equal(semanticPassed({ ...good, outcome: 'unconfirmed' }), true);
 for (const change of [{ ok: false }, { outcome: 'failed' }, { outcome: 'not_executed' }, { dispatched: false }, { confirmedByApp: false }, { frontStillNotepad: false }, { witnessActivated: true }]) {
  assert.equal(semanticPassed({ ...good, ...change }), false);
 }
});

test('Windows live foreground gaps and observation errors cannot pass', () => {
 assert.equal(samplingVerified([{ at: 20 }, { at: 40 }, { at: 60 }], [], 0, 80).verified, true);
 assert.equal(samplingVerified([{ at: 20 }, { at: 300 }], [], 0, 320).verified, false);
 assert.equal(samplingVerified([{ at: 20 }, { at: 40 }], [{ at: 30 }], 0, 60).verified, false);
 assert.equal(samplingVerified([], [], 0, 80).verified, false);
 assert.equal(samplingVerified([{ at: 40 }, { at: 20 }], [], 0, 80).verified, false);
 assert.equal(samplingVerified([{ at: 20 }], [], Number.NaN, 80).verified, false);
});

test('a timed-out action cannot escape as an ordinary abort error and continue the sequence', async () => {
 let marked = false;
 await assert.rejects(boundedStep('UIA action', signal => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new Error('underlying abort arrived first')), { once: true });
 }), 2, () => { marked = true; }), StepTimeoutError);
 assert.equal(marked, true);
 await assert.rejects(boundedStep('ordinary failure', async () => { throw new Error('actual failure'); }, 50, () => assert.fail('unexpected timeout')), /actual failure/);
});

test('screen_look must return the covered witness itself, not rely on a second correct capture', () => {
 const back = [230, 217, 242], pixels = Buffer.from([...back, 255, 255, 255, 255, 255]);
 const image = witnessImageStats({ width: 2, height: 1, pixels }, back);
 const coverage = { notepadAboveWitness: true, notepadContainsWitness: true };
 const good = { ok: true, returnedImages: 1, returnedImage: image, capture: image, coverage, coverageAfter: coverage };
 const passes = (value: Record<string, unknown>) => Object.values(witnessLookChecks(value)).every(Boolean);
 assert.equal(passes(good), true);
 for (const bad of [
  { returnedImages: 0, returnedImage: undefined },
  { returnedImage: { ...image, witnessBackgroundShare: 0 } },
  { returnedImage: { ...image, nonBlank: false } },
  { coverage: { ...coverage, notepadAboveWitness: false } },
  { coverageAfter: { ...coverage, notepadContainsWitness: false } },
 ]) assert.equal(passes({ ...good, ...bad }), false);
 pixels[3] = 0;
 assert.equal(witnessImageStats({ width: 2, height: 1, pixels }, back).witnessBackgroundShare, 0, 'transparent background does not prove captured content');
});

test('measurement helper cleanup errors remain in the actual live report', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'mountains-windows-harness-'));
 const exe = join(dir, 'witness.exe'), out = join(dir, 'report.json'), binary = Buffer.from('not executed');
 const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
 writeFileSync(exe, binary);
 writeFileSync(exe + '.json', JSON.stringify({ format: 1, binarySha256: sha(binary),
  sourceSha256: sha(readFileSync(new URL('./fixtures/windows-witness/Program.cs', import.meta.url))),
  projectSha256: sha(readFileSync(new URL('./fixtures/windows-witness/windows-witness.csproj', import.meta.url))) }));
 try {
  const result = await runWindowsLive({ witnessExe: exe, out }, {
   openHelper: () => ({ pid: null, send: async command => command.op === 'windows' ? { windows: [] } : { hwnd: 1, pid: 1 }, dispose: async () => { throw new Error('helper still alive'); } }),
   openDesktop: async () => { throw new Error('must not open a desktop'); },
   spawn: () => { throw new Error('must not spawn an app'); },
   activate: async () => { throw new Error('must not activate'); },
   kill: async () => { throw new Error('must not terminate an app'); },
  });
  assert.equal(result.accepted, false);
  const cleanup = result.report.cleanup as { errors: string[] };
  assert.deepEqual(cleanup.errors, ['probe: helper still alive', 'watcher: helper still alive']);
  assert.equal((result.report.acceptance as { checks: Record<string, boolean> }).checks.cleanupCompleted, false);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
