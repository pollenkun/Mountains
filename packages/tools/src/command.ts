import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { Risk, ToolDefinition, ToolResult } from "./types.ts";
import { truncateUtf16, truncateUtf16Tail } from "./text.ts";
import { waitForApproval } from "./approval-wait.ts";
import { isValidUtf8, sha256, ToolError } from "./workspace.ts";
import { findWindowsGitBash, nativeWindowsCommandHost, type WindowsCommandHost } from "./windows-command.ts";
import { probeLinuxScope, spawnLinuxScope, type LinuxScopeHost, type LinuxScopeProcess } from "./linux-scope.ts";
import type { WindowsJobCleanup as WindowsCleanupResult, WindowsJobProcess, spawnWindowsJob } from "./windows-job.ts";

/** Trusted host/testing options. Existing callers need not provide them. */
export interface CommandExecutionHost {
	platform?: NodeJS.Platform;
	environment?: NodeJS.ProcessEnv;
	spawn?: typeof spawn;
	windows?: WindowsCommandHost;
	spawnWindowsJob?: typeof spawnWindowsJob;
	linuxScope?: LinuxScopeHost;
	probeLinuxScope?: typeof probeLinuxScope;
	spawnLinuxScope?: typeof spawnLinuxScope;
}

export interface CommandLimits {
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	headLines: number;
	tailLines: number;
	maxChars: number;
	/** Optional host-side capture ceiling. Omitted retains the core/CLI capture behavior. */
	captureMaxBytes?: number;
	/** Explicit credential variable names, including names which do not look sensitive. */
	omitEnv?: readonly string[];
}

export const DEFAULT_COMMAND_LIMITS: CommandLimits = { defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000, headLines: 60, tailLines: 80, maxChars: 12_000 };

const SENSITIVE_ENV = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)($|_)|^DEEPSEEK_|^ANTHROPIC_|^OPENAI_|^AWS_|^GH_|^GITHUB_TOKEN$/i;

/** 子进程环境：剔除 Key、令牌等敏感变量 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!SENSITIVE_ENV.test(k)) out[k] = v;
	return out;
}

/** Only options whose behavior we understand may inherit read-only approval. Unknown
 * programs/options stay conservative. In particular git may run configured helpers,
 * rg may load a config with --pre, find can execute/delete, and file can compile magic.
 * This is an approval hint, not a sandbox or a guarantee about a replaced executable. */
const READ_ONLY_OPTIONS: Record<string, { short: string; flags?: string; values?: string }> = {
	pwd: { short: "LP", flags: "--logical --physical --help --version" },
	ls: { short: "aAbBcCdDfFgGhHiIklLmNnOpqQrRsStTuUvwxX1", flags: "--all --almost-all --author --classify --directory --file-type --full-time --group-directories-first --human-readable --inode --literal --numeric-uid-gid --quote-name --recursive --reverse --size --help --version", values: "--block-size --color --format --hide --ignore --indicator-style --quoting-style --sort --tabsize --time --time-style --width -I -T -w" },
	cat: { short: "AbEnsTuvet", flags: "--show-all --number-nonblank --show-ends --number --squeeze-blank --show-tabs --show-nonprinting --help --version" },
	head: { short: "qvz", flags: "--quiet --silent --verbose --zero-terminated --help --version", values: "-c -n --bytes --lines" },
	tail: { short: "fFqvz", flags: "--retry --quiet --silent --verbose --zero-terminated --help --version", values: "-c -n -s --bytes --lines --follow --pid --sleep-interval --max-unchanged-stats" },
	wc: { short: "clLmw", flags: "--bytes --chars --lines --max-line-length --words --help --version", values: "--files0-from" },
	grep: { short: "aAbBcEFGHhiILlnoPqRrsUVvwxyzZ", flags: "--extended-regexp --fixed-strings --basic-regexp --perl-regexp --ignore-case --no-ignore-case --invert-match --word-regexp --line-regexp --null-data --no-messages --no-filename --with-filename --line-number --byte-offset --text --binary --recursive --dereference-recursive --files-without-match --files-with-matches --count --only-matching --quiet --silent --line-buffered --null --help --version", values: "-e -f -m -A -B -C -D --regexp --file --max-count --after-context --before-context --context --binary-files --devices --directories --exclude --exclude-from --exclude-dir --include --label --color --colour --group-separator" },
	rg: { short: "abcFhiIlLnNoPqsSUuvwx0", flags: "--no-config --fixed-strings --ignore-case --case-sensitive --smart-case --invert-match --word-regexp --line-regexp --text --binary --no-ignore --hidden --files --files-with-matches --files-without-match --count --count-matches --only-matching --quiet --line-number --no-line-number --with-filename --no-filename --heading --no-heading --line-buffered --null --null-data --multiline --multiline-dotall --no-unicode --help --version", values: "-e -f -g -t -T -m -A -B -C -E -M -r --max-columns --regexp --file --glob --iglob --type --type-not --max-count --after-context --before-context --context --max-depth --max-filesize --color --colors --sort --sortr --encoding --replace" },
	find: { short: "", flags: "-H -L -P -O0 -O1 -O2 -O3 -print -print0 -ls -true -false -empty -readable -writable -executable -nouser -nogroup -prune -quit -a -and -o -or -not -xdev -mount -depth -daystart -follow -noleaf -warn -nowarn --help --version", values: "-name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -maxdepth -mindepth -mtime -mmin -atime -amin -ctime -cmin -size -user -group -uid -gid -perm -newer -anewer -cnewer -inum -links" },
	stat: { short: "fLt", flags: "--dereference --file-system --terse --help --version", values: "-c --format --printf --cached" },
	file: { short: "bEhikLNnrsv0", flags: "--brief --dereference --no-dereference --keep-going --mime --mime-type --mime-encoding --no-buffer --raw --special-files --help --version", values: "-e -f -F -m --exclude --files-from --separator --magic-file --parameter" },
	tree: { short: "aCdDfFgilnNpqrsuX", flags: "--dirsfirst --inodes --noreport --prune --help --version", values: "-H -L -P -I --charset --sort --filelimit" },
	diff: { short: "abBcdeEfHinpqrsStTuUwy", flags: "--brief --context --ed --expand-tabs --ignore-all-space --ignore-blank-lines --ignore-case --ignore-space-change --ignore-tab-expansion --minimal --new-file --normal --recursive --report-identical-files --side-by-side --speed-large-files --strip-trailing-cr --suppress-common-lines --text --unidirectional-new-file --unified --help --version", values: "-C -D -F -I -S -U -W -x -X --exclude --exclude-from --ignore-matching-lines --label --starting-file --width" },
};

function readOnlyArgv(argv: readonly string[]): boolean {
	const [program, ...args] = argv;
	if (program === "echo") return true; // argv literals never undergo shell expansion.
	const spec = program === undefined || !Object.hasOwn(READ_ONLY_OPTIONS, program) ? undefined : READ_ONLY_OPTIONS[program];
	if (!spec) return false;
	let noConfig = false;
	const flags = new Set((spec.flags ?? "").split(" "));
	const values = new Set((spec.values ?? "").split(" "));
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") return program !== "find" && (program !== "rg" || noConfig);
		if (!arg.startsWith("-") || arg === "-") continue;
		if (values.has(arg)) { if (++i >= args.length) return false; continue; }
		if (flags.has(arg)) { if (arg === "--no-config") noConfig = true; continue; }
		if (arg.startsWith("--")) {
			const equal = arg.indexOf("=");
			if (equal > 2 && values.has(arg.slice(0, equal))) continue;
			return false;
		}
		let known = arg.length > 1;
		for (let j = 1; j < arg.length; j++) {
			const flag = arg[j]!;
			if (values.has(`-${flag}`)) { if (j === arg.length - 1 && ++i >= args.length) known = false; break; }
			if (!spec.short.includes(flag)) { known = false; break; }
		}
		if (!known) return false;
	}
	return program !== "rg" || noConfig;
}
const NETWORK = /\b(curl|wget|pip3?\s+install|npm\s+(install|i|ci)\b|pnpm\s+(install|add)|yarn\s+(install|add)|apt(-get)?\s+install|git\s+(clone|fetch|pull|push))\b/;
const DANGEROUS = /(\brm\s+-[a-z]*r[a-z]*f?\b.*(\/|~)(\s|$)|\bsudo\b|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bchmod\s+-R\s+777\b|\bgit\s+push\s+.*--force\b|>\s*\/dev\/sd)/;

export function classifyRisk(command: string | readonly string[]): Risk {
	const c = typeof command === "string" ? command.trim() : command.join(" ");
	if (DANGEROUS.test(c)) return "dangerous";
	if (NETWORK.test(c)) return "network";
	// Shell parsing is deliberately narrow: quotes, escapes, expansions, redirects,
	// command separators, newlines and unknown syntax require write approval.
	const argv = typeof command === "string" ? /^[\w./@%+,:= -]+$/.test(c) ? c.split(/ +/) : undefined : command;
	if (argv && readOnlyArgv(argv)) return "read-only";
	return "workspace-write";
}

function explain(command: string, risk: Risk): string {
	switch (risk) {
		case "read-only":
			return "只读命令：查看信息，不修改文件";
		case "network":
			return "会访问网络（下载或上传）";
		case "dangerous":
			return "危险命令：可能删除或破坏工作区外的数据";
		default:
			return `可能修改工作区文件：${truncateUtf16(command, 80)}`;
	}
}

function shape(output: string, limits: CommandLimits): { text: string; truncated: boolean } {
	const lines = output.split("\n");
	if (lines.length <= limits.headLines + limits.tailLines && output.length <= limits.maxChars) return { text: output, truncated: false };
	if (lines.length <= limits.headLines + limits.tailLines) return { text: `${truncateUtf16(output, Math.floor(limits.maxChars / 2))}\n... [truncated] ...\n${truncateUtf16Tail(output, Math.floor(limits.maxChars / 2))}`, truncated: true };
	const head = lines.slice(0, limits.headLines);
	const tail = lines.slice(-limits.tailLines);
	const omitted = lines.length - head.length - tail.length;
	let text = [...head, `... [${omitted} lines omitted] ...`, ...tail].join("\n");
	if (text.length > limits.maxChars) text = `${truncateUtf16(text, Math.floor(limits.maxChars / 2))}\n... [truncated] ...\n${truncateUtf16Tail(text, Math.floor(limits.maxChars / 2))}`;
	return { text, truncated: true };
}

interface ProcessIdentity {
	pid: number;
	ppid: number;
	pgid: number;
	birth: string;
	executable?: string;
	state: string;
}

/** Read identity metadata only: do not collect command arguments or environment. */
async function processSnapshot(environment: NodeJS.ProcessEnv): Promise<Map<number, ProcessIdentity> | undefined> {
	const found = new Map<number, ProcessIdentity>();
	if (process.platform === "linux") {
		let entries: string[];
		try { entries = readdirSync("/proc"); } catch { return undefined; }
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
				// comm can contain spaces and parentheses; fields after its last ')' start at state.
				const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
				if (!/^\d+$/.test(fields[19] ?? "")) continue;
				const pid = Number(entry), ppid = Number(fields[1]), pgid = Number(fields[2]);
				if (pid > 1 && Number.isInteger(ppid) && Number.isInteger(pgid)) {
					found.set(pid, { pid, ppid, pgid, birth: fields[19]!, state: fields[0]! });
				}
			} catch { /* A process can exit during the snapshot. */ }
		}
		return found;
	}
	if (process.platform !== "darwin") return undefined;
	const output = await new Promise<string | undefined>(resolve => {
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true; clearTimeout(deadline); resolve(value);
		};
		// A denied spawn can throw before execFile installs its error callback.
		// Also bound this observation itself: it must never block command termination.
		const deadline = setTimeout(() => finish(undefined), 1100);
		try {
			execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,comm="], {
				encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
				env: { ...environment, LC_ALL: "C" },
			}, (error, stdout) => finish(error ? undefined : stdout));
		} catch { finish(undefined); }
	});
	if (output === undefined) return undefined;
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid > 1) found.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), state: match[4]!, birth: match[5]!.replace(/\s+/g, " "), executable: match[6]! });
	}
	return found;
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
	return a.birth === b.birth && a.executable === b.executable && !b.state.startsWith("Z");
}

/** Track only ancestry observed while each recorded parent still has its identity. */
function commandProcesses(child: ChildProcess, environment: NodeJS.ProcessEnv) {
	const known = new Map<number, ProcessIdentity>();
	const retired = new Set<number>();
	let anchored = false;
	let stopping: NodeJS.Signals | undefined;
	let finishing = false;
	let closed = false;
	let active: Promise<void> | undefined;
	const childAlive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
	const refresh = async () => {
		const snapshot = await processSnapshot(environment);
		if (!snapshot) return undefined;
		const root = child.pid === undefined ? undefined : snapshot.get(child.pid);
		if (!anchored && childAlive() && root?.ppid === process.pid && root.pgid === child.pid && !root.state.startsWith("Z")) {
			known.set(root.pid, root); anchored = true;
		}
		const live = new Map<number, ProcessIdentity>();
		for (const [pid, prior] of known) {
			if (retired.has(pid)) continue;
			// A ps request may have started before the child's exit event arrived.
			if (pid === child.pid && !childAlive()) { retired.add(pid); continue; }
			const current = snapshot.get(pid);
			// A direct child may exec another program without becoming a new process.
			if (pid === child.pid && childAlive() && current?.birth === prior.birth && current.ppid === process.pid) {
				if (current.executable === undefined) delete prior.executable; else prior.executable = current.executable;
			}
			if (!current || !sameProcess(prior, current)) { retired.add(pid); continue; }
			live.set(pid, current);
		}
		let changed = true;
		while (changed) {
			changed = false;
			for (const current of snapshot.values()) {
				if (known.has(current.pid) || current.pid === process.pid || current.state.startsWith("Z") || !live.has(current.ppid)) continue;
				known.set(current.pid, current); live.set(current.pid, current); changed = true;
			}
		}
		return live;
	};
	const send = (live: Map<number, ProcessIdentity> | undefined, value: NodeJS.Signals) => {
		// The original detached group is a fallback only while the actual child is live.
		// After close, never signal its old PID or PGID without a surviving identity.
		let groupSignalled = false;
		if (childAlive() && (!live || live.has(child.pid!))) {
			try { process.kill(-child.pid!, value); groupSignalled = true; } catch { try { child.kill(value); } catch { /* Already exited. */ } }
		}
		if (live) for (const current of live.values()) {
			// Root signalling uses its live ChildProcess/group above, never a snapshot's old PID.
			if (current.pid === child.pid) continue;
			if (groupSignalled && current.pgid === child.pid) continue;
			try { process.kill(current.pid, value); } catch { /* Already exited. */ }
		}
	};
	const observe = (value?: NodeJS.Signals) => {
		// Cancel/close requests queue behind the one active snapshot. Periodic scans do not queue.
		const next = (active ?? Promise.resolve()).then(async () => {
			if (closed) return;
			const requested = value ?? stopping;
			const live = await refresh();
			if (closed) return;
			if (requested) send(live, requested);
		});
		active = next.catch(() => { /* Failed identity reads cannot authorize descendant signals. */ });
		const current = active;
		void current.then(() => { if (active === current) active = undefined; });
		return current;
	};
	void observe();
	const scan = setInterval(() => { if (!finishing && !active) void observe(); }, 200);
	scan.unref();
	return {
		signal(value: NodeJS.Signals) {
			if (closed) return Promise.resolve();
			stopping = value;
			// Preserve ancestry by observing before TERM. At the escalation deadline,
			// the live ChildProcess itself is sufficient to stop its original group;
			// a slow process-table read must not delay that last attempt.
			if (value === "SIGKILL") send(undefined, value);
			return observe(value);
		},
		async close() { finishing = true; clearInterval(scan); await observe("SIGKILL"); closed = true; },
		dispose() { finishing = true; closed = true; clearInterval(scan); },
	};
}

function fail(message: string, details: Record<string, unknown> = {}): ToolResult {
	return { ok: false, modelContent: `错误：${message}`, summary: `失败：${message}`, details: { error: message, ...details } };
}

/** Only advertise recovery when the caller also registers context_expand. Archival is independent. */
export function createCommandTool(limits: CommandLimits = DEFAULT_COMMAND_LIMITS, recovery: { contextExpand?: boolean; archiveSearch?: boolean; lean?: boolean } = {}, execution: CommandExecutionHost = {}): ToolDefinition {
	if (limits.captureMaxBytes !== undefined && (!Number.isSafeInteger(limits.captureMaxBytes) || limits.captureMaxBytes <= 0)) {
		throw new Error("captureMaxBytes 必须是有限正整数");
	}
	if (limits.omitEnv !== undefined && (!Array.isArray(limits.omitEnv) || limits.omitEnv.some(name => typeof name !== "string" || !name || /[\0=]/.test(name)))) {
		throw new Error("omitEnv 必须包含有效的环境变量名");
	}
	// Pin the host setting; changing the caller's object later cannot bypass validation.
	const platform = execution.platform ?? process.platform;
	const captureMaxBytes = limits.captureMaxBytes;
	const omitEnv = new Set((limits.omitEnv ?? []).map(name => platform === "win32" ? name.toUpperCase() : name));
	return {
		name: "command_run",
		logicalName: "command.run",
		readOnly: false,
		description:
			"Run a temporary command in the workspace (not sandboxed; subject to approval). Attempts to clean up background descendants when the command ends; platform ownership strength is reported; persistent user jobs require separate ownership. Provide either argv (preferred) or shellScript (run with bash -c). " +
			(platform === "win32" ? "Windows argv requires a native executable; for .cmd/.bat such as npm.cmd, explicitly use cmd.exe /c or shellScript with Git for Windows Bash. " : "") +
			`Returns exit code and combined stdout/stderr (long output keeps the first ${limits.headLines} and last ${limits.tailLines} lines). Default timeout ${limits.defaultTimeoutMs / 1000}s.`,
		parameters: {
			type: "object",
			properties: {
				argv: { type: "array", items: { type: "string" }, description: "Program and arguments, e.g. [\"python\", \"-m\", \"pytest\", \"-x\"]" },
				shellScript: { type: "string", description: "Shell script run with bash -c (use only when pipes/redirection are needed)" },
				cwd: { type: "string", description: "Workspace-relative working directory, default workspace root" },
				timeoutMs: { type: "integer", minimum: 1000 },
			},
			additionalProperties: false,
		},
		async execute(args, ctx) {
			try {
				if (ctx.signal.aborted) return fail("命令已取消，未启动进程", { cancelled: true });
				const argv = Array.isArray(args.argv) ? args.argv.map(String) : undefined;
				const script = typeof args.shellScript === "string" ? args.shellScript : undefined;
				if ((!argv || argv.length === 0) && !script) return fail("需要 argv 或 shellScript");
				if (argv && argv.length > 0 && script) return fail("argv 与 shellScript 只能提供一个");
				const cwdRel = typeof args.cwd === "string" && args.cwd ? args.cwd : ".";
				const { abs: cwd, rel } = ctx.workspace.resolve(cwdRel);
				const cwdIdentity = statSync(cwd, { bigint: true });
				if (!cwdIdentity.isDirectory()) return fail(`cwd 不是目录：${rel}`);
				const timeout = Math.min(typeof args.timeoutMs === "number" ? args.timeoutMs : limits.defaultTimeoutMs, limits.maxTimeoutMs);
				const display = script ?? (argv ?? []).map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
				const risk = classifyRisk(script ?? argv ?? []);
				const decision = await waitForApproval(ctx, { toolCallId: ctx.toolCallId, command: display, cwd: rel, risk, explanation: explain(display, risk) });
				if (ctx.signal.aborted) return fail("命令已取消，未启动进程", { command: display, cwd: rel, risk, cancelled: true });
				if (decision !== "allow") {
					return fail(`命令未获批准：${display}`, { command: display, cwd: rel, risk, approved: false });
				}
				const started = Date.now();
				const environment = scrubEnv(execution.environment ?? process.env);
				for (const name of Object.keys(environment)) if (omitEnv.has(platform === "win32" ? name.toUpperCase() : name)) delete environment[name];
				const windowsHost = platform === "win32" ? execution.windows ?? nativeWindowsCommandHost() : undefined;
				const bash = script && windowsHost ? findWindowsGitBash(environment, windowsHost) : "bash";
				if (script && !bash) return fail("复杂命令需要 Git for Windows 的 Bash。请安装 Git for Windows 后重试；不会改用 PowerShell。", { command: display, cwd: rel, risk });
				const [prog, ...rest] = script ? [bash!, "-c", script] : (argv as string[]);
				const launchJob = windowsHost ? execution.spawnWindowsJob ?? (await import("./windows-job.ts")).spawnWindowsJob : undefined;
				const useLinuxScope = platform === "linux" && (!execution.spawn || !!execution.spawnLinuxScope)
					&& await (execution.probeLinuxScope ?? probeLinuxScope)(execution.linuxScope);
				if (ctx.signal.aborted) return fail("命令已取消，未启动进程", { command: display, cwd: rel, risk, cancelled: true });
				ctx.assertExecutionAllowed?.();
				const currentCwd = ctx.workspace.resolve(cwdRel).abs;
				const currentIdentity = statSync(currentCwd, { bigint: true });
				if (currentCwd !== cwd || !currentIdentity.isDirectory() || currentIdentity.dev !== cwdIdentity.dev || currentIdentity.ino !== cwdIdentity.ino) {
					return fail("工作目录在审批后已改变，未启动进程", { command: display, cwd: rel, risk });
				}
				const jobChild: WindowsJobProcess | undefined = launchJob?.(prog as string, rest, { cwd, env: environment });
				const scopeChild: LinuxScopeProcess | undefined = useLinuxScope
					? (execution.spawnLinuxScope ?? spawnLinuxScope)(prog as string, rest, { cwd, env: environment }, execution.linuxScope) : undefined;
				const managedChild = jobChild ?? scopeChild;
				const child = managedChild ?? (execution.spawn ?? spawn)(prog as string, rest, { cwd, detached: true, env: environment, stdio: ["ignore", "pipe", "pipe"] });
				const managedResult = async (operation: "stop" | "finish", grace = 0): Promise<WindowsCleanupResult> => {
					try { return await (scopeChild && operation === "stop" ? scopeChild.linuxScope.stop(grace) : (jobChild?.windowsJob ?? scopeChild!.linuxScope)[operation]()); }
					catch { return { confirmed: false, error: "进程清理失败，未确认后台进程已全部结束" }; }
				};
				const processes = managedChild ? { signal(_value: NodeJS.Signals) { return managedResult("stop"); }, close() { return managedResult("finish"); }, dispose() {} } : commandProcesses(child, environment);
				let managedCleanup: WindowsCleanupResult | undefined;
				let forceManagedExit: (() => void) | undefined;
				let posixCleanupError: string | undefined;
				let forcePosixExit: (() => void) | undefined;
				let posixDeadline: NodeJS.Timeout | undefined;
				const chunks: Buffer[] = [];
				let capturedBytes = 0;
				let observedOutputBytes = 0;
				let outputLimited = false;
				let timedOut = false;
				let cancelled = false;
				let managedStopping = false;
				let escalation: NodeJS.Timeout | undefined;
				let timer: NodeJS.Timeout | undefined;
				const stop = (grace: number) => {
					clearTimeout(timer);
					if (managedChild) {
						if (managedStopping) return;
						managedStopping = true;
						// Stop through the selected kernel owner, not a sampled process tree.
						void managedResult("stop", grace).then(result => {
							managedCleanup = result as WindowsCleanupResult;
							if (!managedCleanup.confirmed && child.exitCode === null && child.signalCode === null) {
								// The direct child is still owned. Killing it cannot substitute for
								// an independent whole-range cleanup confirmation.
								try { child.kill("SIGKILL"); } catch { /* Failure remains visible below. */ }
							}
							forceManagedExit?.();
						});
						return;
					}
					if (escalation) return; // A later timeout/abort cannot postpone the first deadline.
					// Signals can be denied, or an escaped descendant can retain the pipes.
					// Returning must not depend on those processes cooperating.
					posixDeadline ??= setTimeout(() => forcePosixExit?.(), grace + 500);
					void processes.signal("SIGTERM");
					escalation = setTimeout(() => { void processes.signal("SIGKILL"); }, grace);
					escalation.unref();
				};
				const capture = (chunk: Buffer) => {
					observedOutputBytes += chunk.length;
					if (outputLimited) return;
					const remaining = captureMaxBytes === undefined ? chunk.length : captureMaxBytes - capturedBytes;
					if (chunk.length <= remaining) {
						chunks.push(chunk); capturedBytes += chunk.length;
						return;
					}
					// Copy only the retained prefix, rather than keeping a large backing buffer alive.
					if (remaining > 0) { chunks.push(Buffer.from(chunk.subarray(0, remaining))); capturedBytes += remaining; }
					outputLimited = true;
					stop(1000);
				};
				child.stdout.on("data", capture);
				child.stderr.on("data", capture);
				timer = setTimeout(() => {
					timedOut = true;
					stop(2000);
				}, timeout);
				const onAbort = () => {
					cancelled = true;
					stop(1000);
				};
				ctx.signal.addEventListener("abort", onAbort, { once: true });
				const exit: { code: number | null; signal: NodeJS.Signals | null; spawnError?: string } = await new Promise((resolve) => {
					let settled = false;
					let drainTimer: NodeJS.Timeout | undefined;
					const settle = (result: { code: number | null; signal: NodeJS.Signals | null; spawnError?: string }) => {
						if (settled) return;
						settled = true; clearTimeout(drainTimer); clearTimeout(posixDeadline); resolve(result);
					};
					child.on("error", (e) => settle({ code: null, signal: null, spawnError: String(e) }));
					child.on("close", (code, signal) => settle({ code, signal }));
					if (managedChild) {
						forceManagedExit = () => {
							if (settled || drainTimer) return;
							// A surviving child can inherit stdout/stderr after its parent exits.
							// Wait briefly for normal draining, then report incomplete cleanup instead of hanging the caller.
							drainTimer = setTimeout(() => {
								managedCleanup = { confirmed: false,
									error: managedCleanup?.error ?? "父进程已结束但输出管道未关闭，未确认后台进程已全部结束" };
								child.stdout.destroy(); child.stderr.destroy(); child.unref();
								settle({ code: child.exitCode, signal: child.signalCode });
							}, 500);
						};
						child.on("exit", () => {
							void processes.close().then(result => { managedCleanup = result as WindowsCleanupResult; forceManagedExit?.(); });
						});
						if (ctx.signal.aborted) onAbort();
					} else {
						forcePosixExit = () => {
							if (settled) return;
							posixCleanupError = "进程清理未确认，输出可能不完整；未对无法确认身份的残留进程发送信号";
							// Invalidate in-flight observations before returning, including a late ps callback.
							processes.dispose(); clearTimeout(escalation);
							child.stdout.destroy(); child.stderr.destroy(); child.unref();
							settle({ code: child.exitCode, signal: child.signalCode });
						};
						child.on("exit", () => {
							// close waits for inherited stdout/stderr, not just the direct child's exit.
							// Clean only verified descendants; never guess that an exited PID still owns its old group.
							void processes.signal("SIGKILL");
							posixDeadline ??= setTimeout(() => forcePosixExit?.(), 500);
						});
						if (ctx.signal.aborted) onAbort();
					}
				});
				clearTimeout(timer);
				clearTimeout(escalation);
				ctx.signal.removeEventListener("abort", onAbort);
				// Recheck captured descendants even when the original parent has already exited.
				if (managedChild) managedCleanup ??= await processes.close() as WindowsCleanupResult;
				else if (!posixCleanupError) {
					let cleanupDeadline: NodeJS.Timeout | undefined;
					const completed = await Promise.race([
						processes.close().then(() => true),
						new Promise<false>(resolve => { cleanupDeadline = setTimeout(() => resolve(false), 1500); }),
					]);
					clearTimeout(cleanupDeadline); processes.dispose();
					if (!completed) posixCleanupError = "进程清理超时，未确认后台进程已全部结束";
				}
				// An unconfirmed native-owner cleanup may have forcibly closed inherited pipes too.
				// Preserve captured bytes for audit, but never advertise them as a full output.
				const cleanupIncomplete = !!posixCleanupError || managedCleanup?.confirmed === false;
				const scopeStartupError = scopeChild?.linuxScope.startupError();
				if (scopeStartupError) exit.spawnError = scopeStartupError;
				const scopeOutcome = scopeChild?.linuxScope.outcome();
				if (scopeOutcome) { exit.code = scopeOutcome.code; exit.signal = scopeOutcome.signal; }
				else if (scopeChild) {
					exit.code = null; // A bootstrap's generic exit is never the target's exit code.
					if (!cancelled && !timedOut && !outputLimited) exit.signal = null;
				}
				const bestEffort = !managedChild;
				const fallbackReason = platform === "linux" ? "usable user-systemd scope unavailable" : "no supported persistent process owner on this platform";
				const raw = Buffer.concat(chunks, capturedBytes);
				// Preserve bytes before deriving any display text. stdout/stderr are combined
				// in observed data-event order, not claimed to be an OS-wide total order.
				let ref: string | undefined;
				let archiveError: string | undefined;
				try {
					ref = ctx.blobs?.put(raw, { kind: "raw", source: { tool: "command_run", toolCallId: ctx.toolCallId, commandSha256: sha256(display), commandPreview: truncateUtf16(display, 512), cwd: rel, exitCode: exit.code, signal: exit.signal, timedOut, cancelled, streamOrder: "observed-data-events", ...(captureMaxBytes !== undefined || cleanupIncomplete ? { captureComplete: !outputLimited && !cleanupIncomplete } : {}) } });
					if (!ref) archiveError = "archive storage unavailable";
				} catch { archiveError = "archive write or verification failed"; }
				const invalidUtf8 = !isValidUtf8(raw);
				const output = raw.toString("utf8");
				const { text, truncated } = shape(output, limits);
				const durationMs = Date.now() - started;
				const status = exit.spawnError
					? `failed to start: ${exit.spawnError}`
					: outputLimited
						? `output capture exceeded ${captureMaxBytes} bytes; command stopped; remaining output discarded`
					: timedOut
						? `timed out after ${timeout}ms`
						: cancelled
							? "cancelled"
							: `exit code ${exit.code ?? `signal ${exit.signal}`}`;
				const recoveryHint = outputLimited || cleanupIncomplete
					? ref ? `; partialOutputRef=${ref}; incomplete capture only` : `; partial output archive unavailable: ${archiveError}`
					: (truncated || invalidUtf8)
					? ref ? (recovery.lean && !recovery.contextExpand ? "" : `; fullOutputRef=${ref}; ${recovery.contextExpand ? "recover with context_expand" : "audit only"}`) : `; full output unavailable: ${archiveError}`
					: "";
				const decoding = invalidUtf8 ? "; invalid UTF-8: display uses replacement characters" + (ref && recovery.contextExpand ? "; archived original bytes can be recovered as base64" : "") : "";
				const searchHint = !outputLimited && !cleanupIncomplete && ref && recovery.contextExpand && recovery.archiveSearch && (truncated || invalidUtf8)
					? `; search archived lines with context_search ref=${ref} toolCallId=${JSON.stringify(ctx.toolCallId)}` : "";
				const cleanupHint = (bestEffort ? `; process cleanup best-effort/unconfirmed (${fallbackReason}); unobserved detached descendants may survive` : "") + (posixCleanupError ? `; ${posixCleanupError}` : managedCleanup && !managedCleanup.confirmed ? `; ${managedCleanup.error ?? "未确认后台进程已全部结束"}` : "");
				const modelContent = `$ ${display}\n[${status}; ${durationMs}ms${truncated ? outputLimited || cleanupIncomplete ? `; display truncated, captured ${output.length} chars` : `; output truncated, full ${output.length} chars` : ""}${decoding}${recoveryHint}${searchHint}${cleanupHint}]\n${text}`;
				return {
					ok: !exit.spawnError && !timedOut && !cancelled && !outputLimited && !cleanupIncomplete && exit.code === 0,
					modelContent,
					summary: `运行 ${truncateUtf16(display, 60)}（${status}${cleanupHint}）`,
					details: { command: display, cwd: rel, risk, exitCode: exit.code, signal: exit.signal, timedOut, cancelled, durationMs, outputChars: output.length, outputBytes: raw.length, outputSha256: sha256(raw), invalidUtf8, archiveError, streamOrder: "observed-data-events", toolCallId: ctx.toolCallId, truncated,
						processTreeCleanupMode: scopeChild ? "systemd-scope" : jobChild ? "windows-job" : "best-effort",
						...(bestEffort ? { processTreeCleanupConfirmed: false, processTreeCleanupReason: fallbackReason } : {}),
						...(managedCleanup ? { processTreeCleanupConfirmed: managedCleanup.confirmed, processTreeCleanupError: managedCleanup.error } : {}),
						...(posixCleanupError ? { processTreeCleanupConfirmed: false, processTreeCleanupError: posixCleanupError } : {}),
						...(cleanupIncomplete ? { captureComplete: false, ...(ref ? { partialOutputRef: ref } : {}) } : {}),
						...(captureMaxBytes !== undefined ? { captureMaxBytes, captureComplete: !outputLimited && !cleanupIncomplete, outputLimited, observedOutputBytes, ...(outputLimited && ref ? { partialOutputRef: ref } : {}) } : {}) },
					...(ref && !outputLimited && !cleanupIncomplete ? { fullOutputRef: ref } : {}),
				};
			} catch (err) {
				return fail(err instanceof ToolError ? err.message : String(err));
			}
		},
	};
}
