import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LINUX_SCOPE_RUNNER } from "./linux-scope-runner.ts";

export interface ScopeQueryResult { status: number | null; stdout: string }
export interface LinuxScopeHost {
	spawn?: typeof spawn;
	run?: (command: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<ScopeQueryResult>;
	runSync?: typeof spawnSync;
	systemdRun?: string;
	systemctl?: string;
	environment?: NodeJS.ProcessEnv;
	cleanupMs?: number;
}
export interface LinuxScopeCleanup { confirmed: boolean; error?: string }
export interface LinuxScopeProcess extends ChildProcessWithoutNullStreams {
	linuxScope: {
		stop(graceMs?: number): Promise<LinuxScopeCleanup>;
		finish(): Promise<LinuxScopeCleanup>;
		startupError(): string | undefined;
		outcome(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
	};
}

/** Manager/runner metadata only. The payload receives the separate scrubbed env. */
function managerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LC_ALL: "C", SYSTEMD_LOG_TARGET: "null" };
	for (const key of ["HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (source[key] !== undefined) out[key] = source[key];
	return out;
}
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ScopeQueryResult> {
	return new Promise(resolve => {
		let settled = false;
		let child: ReturnType<typeof execFile> | undefined;
		const finish = (result: ScopeQueryResult) => {
			if (settled) return;
			settled = true; clearTimeout(deadline); resolve(result);
		};
		// execFile's timeout alone can still wait for a helper descendant which
		// inherited its pipes. Observation must have its own wall-clock bound.
		const deadline = setTimeout(() => {
			try { child?.kill("SIGKILL"); } catch {}
			child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
			finish({ status: null, stdout: "" });
		}, 1800);
		try {
			child = execFile(command, args, { env, encoding: "utf8", timeout: 1500, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout) => {
				finish({ status: error ? null : 0, stdout });
			});
		} catch { finish({ status: null, stdout: "" }); }
	});
}
const systemdRun = (host: LinuxScopeHost) => host.systemdRun ?? "/usr/bin/systemd-run";
const systemctl = (host: LinuxScopeHost) => host.systemctl ?? "/usr/bin/systemctl";
const unitName = () => `mountains-command-${process.pid}-${randomUUID()}.scope`;
function scopeArgs(unit: string): string[] {
	return ["--user", "--scope", "--quiet", "--collect", "--expand-environment=no", `--unit=${unit}`,
		"--property=TasksAccounting=yes", "--property=KillMode=control-group", "--"];
}

/** No payload is involved in this bounded capability probe. Unsupported hosts
 * select the explicit best-effort owner before any user command is launched. */
export async function probeLinuxScope(host: LinuxScopeHost = {}): Promise<boolean> {
	if (process.platform !== "linux") return false;
	const unit = unitName();
	const code = `const fs=require('node:fs');if(process.argv[1]!== '$MOUNTAINS_LITERAL' || !fs.readFileSync('/proc/self/cgroup','utf8').split('\\n').some(l=>l.startsWith('0::')&&l.endsWith('/'+process.argv[2])))process.exit(1);const r=require('node:child_process').spawnSync(${JSON.stringify(systemctl(host))},['--user','show',process.argv[2],'--property=TasksCurrent','--value'],{encoding:'utf8',timeout:1000,killSignal:'SIGKILL',maxBuffer:4096});if(r.stdout)process.stdout.write(r.stdout);process.exit(r.status===0?0:1);`;
	try {
		const result = await (host.run ?? run)(systemdRun(host), [...scopeArgs(unit), process.execPath, "--no-warnings", "-e", code, "$MOUNTAINS_LITERAL", unit], managerEnvironment(host.environment ?? process.env));
		return result.status === 0 && /^\d+\s*$/.test(result.stdout) && Number(result.stdout.trim()) > 0;
	} catch { return false; }
	finally {
		// A timed-out capability probe can itself have left a trusted helper in
		// its scope. Clear only this fresh probe unit, never a user-selected unit.
		try { await (host.run ?? run)(systemctl(host), ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit], managerEnvironment(host.environment ?? process.env)); } catch {}
	}
}

interface UnitState { load: string; active: string; tasks?: number }
export function parseLinuxScopeState(output: string): UnitState | undefined {
	const values = new Map<string, string>();
	for (const line of output.trim().split("\n")) {
		const index = line.indexOf("=");
		if (index < 1 || values.has(line.slice(0, index))) return undefined;
		values.set(line.slice(0, index), line.slice(index + 1).trim());
	}
	const load = values.get("LoadState"), active = values.get("ActiveState"), tasks = values.get("TasksCurrent");
	if (!load || !active || !["active", "inactive", "failed", "activating", "deactivating", "reloading", "refreshing"].includes(active)) return undefined;
	// systemctl can omit a type-specific property for an unloaded unit.
	if (values.size === 2 && load === "not-found" && active === "inactive") return { load, active };
	if (values.size !== 3 || tasks === undefined || !["loaded", "not-found"].includes(load)) return undefined;
	if (tasks !== "[not set]" && !/^\d+$/.test(tasks)) return undefined;
	const count = tasks === "[not set]" ? undefined : Number(tasks);
	if (count !== undefined && !Number.isSafeInteger(count)) return undefined;
	return { load, active, ...(count !== undefined ? { tasks: count } : {}) };
}

/** Tiny private protocol records are never a second, uncapped output channel. */
function readProtocol(path: string): string | undefined {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > 4096) throw new Error("invalid protocol file");
		const bytes = Buffer.alloc(4097), length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length > 4096) throw new Error("oversized protocol file");
		return bytes.subarray(0, length).toString("utf8");
	} finally { closeSync(fd); }
}

// An observable JS host exit can request cleanup, but cannot claim quiescence.
// SIGKILL, native crashes and power loss still require an external supervisor.
const liveOwners = new Set<() => void>();
let exitHook = false;
function registerOwner(finalize: () => void) {
	if (!exitHook) { exitHook = true; process.once("exit", () => { for (const finish of liveOwners) { try { finish(); } catch {} } }); }
	liveOwners.add(finalize);
}

/** Once selected, every launch/startup/cleanup failure stays with this owner.
 * Never replay the payload through the process-group fallback. Scope membership
 * survives double-fork/setsid; this is lifecycle ownership, not a hostile-code sandbox. */
export function spawnLinuxScope(program: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, host: LinuxScopeHost = {}): LinuxScopeProcess {
	const directory = mkdtempSync(join(tmpdir(), "mountains-scope-"));
	const request = join(directory, "request.json"), entered = join(directory, "entered"), failure = join(directory, "failure"), outcome = join(directory, "outcome.json"), cancelled = join(directory, "cancelled");
	const unit = unitName(), environment = managerEnvironment(host.environment ?? process.env);
	const query = host.run ?? run;
	let child: LinuxScopeProcess;
	try {
		writeFileSync(request, JSON.stringify({ program, args, cwd: options.cwd, env: options.env }), { flag: "wx", mode: 0o600 });
		child = (host.spawn ?? spawn)(systemdRun(host), [...scopeArgs(unit), process.execPath, "--no-warnings", "-e", LINUX_SCOPE_RUNNER, request, entered, failure, outcome, cancelled, unit], {
			cwd: options.cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
		}) as unknown as LinuxScopeProcess;
	} catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
	let startupFailure: string | undefined;
	let startupChecked = false;
	let rootOutcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let established = false;
	let finished: Promise<LinuxScopeCleanup> | undefined;
	let requested = false;
	let directExited = false;
	let resolveDirectExit!: () => void;
	const directExit = new Promise<void>(resolve => { resolveDirectExit = resolve; });
	const killArgs = ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit];
	const finalize = () => {
		(host.runSync ?? spawnSync)(systemctl(host), killArgs, { env: environment, stdio: "ignore", timeout: 1500, killSignal: "SIGKILL" });
	};
	registerOwner(finalize);
	child.once("error", () => { if (child.pid === undefined) { directExited = true; resolveDirectExit(); } });
	child.once("exit", () => { directExited = true; resolveDirectExit(); });
	const startupError = () => {
		if (startupChecked) return startupFailure;
		startupChecked = true;
		try {
			if (readProtocol(failure) !== undefined) return startupFailure = "Linux scope bootstrap failed before target startup";
			const record = readProtocol(outcome);
			if (record !== undefined) {
				const value: unknown = JSON.parse(record);
				if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "code,signal") throw new Error("invalid outcome");
				const result = value as { code: unknown; signal: unknown };
				if (typeof result.code === "number" && Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 && result.signal === null)
					rootOutcome = { code: result.code, signal: null };
				else if (result.code === null && typeof result.signal === "string" && Object.hasOwn(osConstants.signals, result.signal))
					rootOutcome = { code: null, signal: result.signal as NodeJS.Signals };
				else throw new Error("invalid outcome");
			} else if (!requested) return startupFailure = "Linux scope exited without a target outcome";
		} catch { return startupFailure = "Linux scope target outcome is invalid"; }
		return undefined;
	};
	const cleanup = (cancel: boolean, graceMs = 0) => finished ??= (async (): Promise<LinuxScopeCleanup> => {
		// Mark request cancellation before signalling: an unconsumed request is an
		// expected cancellation, not evidence that the payload ran successfully.
		requested = cancel;
		if (cancel) { try { writeFileSync(cancelled, "cancelled\n", { flag: "wx", mode: 0o600 }); } catch {} }
		established ||= existsSync(entered);
		if (!established && !directExited) { try { child.kill("SIGKILL"); } catch {} }
		if (cancel && established && !directExited && graceMs > 0) {
			let graceTimer: NodeJS.Timeout | undefined;
			const elapsed = new Promise<void>(resolve => { graceTimer = setTimeout(resolve, graceMs); });
			// Do not await a slow/denied TERM helper before starting the KILL clock.
			// This cleanup promise is shared, so later aborts cannot reset the grace.
			void Promise.resolve().then(() => query(systemctl(host), ["--user", "kill", "--kill-whom=all", "--signal=SIGTERM", unit], environment)).catch(() => {});
			await Promise.race([elapsed, directExit]);
			clearTimeout(graceTimer);
		}
		const deadline = Date.now() + (host.cleanupMs ?? 2500);
		try { await query(systemctl(host), killArgs, environment); } catch { /* Query below must independently prove empty. */ }
		while (Date.now() <= deadline) {
			established ||= existsSync(entered);
			let state: UnitState | undefined;
			try {
				const result = await query(systemctl(host), ["--user", "show", unit, "--property=LoadState", "--property=ActiveState", "--property=TasksCurrent"], environment);
				if (result.status === 0) state = parseLinuxScopeState(result.stdout);
			} catch { /* Unreadable state cannot prove cleanup. */ }
			// No future launch is possible after the direct process exits. A missing
			// scope then means either an established range was collected or startup
			// never created one. Active-zero is insufficient while launch is pending.
			const absent = state?.load === "not-found" && state.active === "inactive" && directExited;
			const empty = state?.load === "loaded" && state.tasks === 0 && (established || directExited);
			if (absent || empty) {
				startupError();
				if (empty) { try { await query(systemctl(host), ["--user", "stop", unit], environment); } catch {} }
				liveOwners.delete(finalize);
				try { rmSync(directory, { recursive: true, force: true }); } catch { /* Range is empty even if a private file cannot be removed. */ }
				return { confirmed: true };
			}
			// Reissue only to this unique scope, never guess a reparented PID.
			try { await query(systemctl(host), killArgs, environment); } catch {}
			await delay(25);
		}
		// Retain the owner and request files for the exit hook; a deadline does
		// not turn an unknown or nonempty range into confirmed cleanup.
		return { confirmed: false, error: "Linux systemd scope cleanup could not be confirmed" };
	})();
	child.linuxScope = { stop: (graceMs = 0) => cleanup(true, graceMs), finish: () => cleanup(false), startupError, outcome: () => { startupError(); return rootOutcome; } };
	return child;
}
