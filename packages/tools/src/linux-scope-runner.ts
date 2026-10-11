/** Trusted Node bootstrap, evaluated with an isolated helper environment.
 * systemd-run establishes the scope before entering this code. Target data is
 * private JSON, never evaluated as source. Root status is separate from stdio.
 */
export const LINUX_SCOPE_RUNNER = String.raw`
const fs = require('node:fs');
const {spawn} = require('node:child_process');
// TERM is delivered to the entire scope. Keep the trusted wrapper alive long
// enough to record the target's real outcome; SIGKILL still ends the scope.
process.on('SIGTERM', () => {});
const [request, entered, failure, outcome, cancelled, unit] = process.argv.slice(1);
const fail = () => {
  try { fs.writeFileSync(failure, 'Linux scope bootstrap failed before target startup\n', {flag:'wx',mode:0o600}); } catch {}
  process.exit(127);
};
try {
  const membership = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n');
  if (!membership.some(line => line.startsWith('0::') && line.endsWith('/' + unit)))
    throw new Error('Linux scope membership was not established');
  const input = JSON.parse(fs.readFileSync(request, 'utf8'));
  if (fs.existsSync(cancelled)) process.exit(125);
  fs.writeFileSync(entered, 'entered\n', {flag:'wx',mode:0o600});
  fs.unlinkSync(request);
  // Last prelaunch gate. A cancellation racing the spawn is handled by the
  // already-established scope, which owns the child from its first instruction.
  if (fs.existsSync(cancelled)) process.exit(125);
  const child = spawn(input.program, input.args, {
    cwd:input.cwd, env:input.env, detached:true, stdio:['ignore','inherit','inherit']
  });
  child.once('error', fail);
  child.once('exit', (code, signal) => {
    try { fs.writeFileSync(outcome, JSON.stringify({code,signal}), {flag:'wx',mode:0o600}); }
    catch { fail(); }
    // This process has produced no stdout/stderr to flush. Descendants may
    // still hold target pipes; the host's exit listener now clears the scope.
    process.exit(0);
  });
} catch { fail(); }
`;
