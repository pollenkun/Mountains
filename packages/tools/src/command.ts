import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { Risk, ToolDefinition, ToolResult } from "./types.ts";
import { isValidUtf8, sha256, ToolError } from "./workspace.ts";

export interface CommandLimits {
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	headLines: number;
	tailLines: number;
	maxChars: number;
}

export const DEFAULT_COMMAND_LIMITS: CommandLimits = { defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000, headLines: 60, tailLines: 80, maxChars: 12_000 };

const SENSITIVE_ENV = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)($|_)|^DEEPSEEK_|^ANTHROPIC_|^OPENAI_|^AWS_|^GH_|^GITHUB_TOKEN$/i;

/** 子进程环境：剔除 Key、令牌等敏感变量 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!SENSITIVE_ENV.test(k)) out[k] = v;
	return out;
}

const READ_ONLY = /^(ls|cat|head|tail|wc|grep|rg|find|pwd|echo|tree|stat|file|diff|git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame))\b/;
const NETWORK = /\b(curl|wget|pip3?\s+install|npm\s+(install|i|ci)\b|pnpm\s+(install|add)|yarn\s+(install|add)|apt(-get)?\s+install|git\s+(clone|fetch|pull|push))\b/;
const DANGEROUS = /(\brm\s+-[a-z]*r[a-z]*f?\b.*(\/|~)(\s|$)|\bsudo\b|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bchmod\s+-R\s+777\b|\bgit\s+push\s+.*--force\b|>\s*\/dev\/sd)/;

export function classifyRisk(command: string): Risk {
	const c = command.trim();
	if (DANGEROUS.test(c)) return "dangerous";
	if (NETWORK.test(c)) return "network";
	if (READ_ONLY.test(c) && !/[>|;&]/.test(c)) return "read-only";
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
			return `可能修改工作区文件：${command.slice(0, 80)}`;
	}
}

function shape(output: string, limits: CommandLimits): { text: string; truncated: boolean } {
	const lines = output.split("\n");
	if (lines.length <= limits.headLines + limits.tailLines && output.length <= limits.maxChars) return { text: output, truncated: false };
	if (lines.length <= limits.headLines + limits.tailLines) return { text: `${output.slice(0, limits.maxChars / 2)}\n... [truncated] ...\n${output.slice(-limits.maxChars / 2)}`, truncated: true };
	const head = lines.slice(0, limits.headLines);
	const tail = lines.slice(-limits.tailLines);
	const omitted = lines.length - head.length - tail.length;
	let text = [...head, `... [${omitted} lines omitted] ...`, ...tail].join("\n");
	if (text.length > limits.maxChars) text = `${text.slice(0, limits.maxChars / 2)}\n... [truncated] ...\n${text.slice(-limits.maxChars / 2)}`;
	return { text, truncated: true };
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// 进程已退出
		}
	}
}

function fail(message: string, details: Record<string, unknown> = {}): ToolResult {
	return { ok: false, modelContent: `错误：${message}`, summary: `失败：${message}`, details: { error: message, ...details } };
}

/** Only advertise recovery when the caller also registers context_expand. Archival is independent. */
export function createCommandTool(limits: CommandLimits = DEFAULT_COMMAND_LIMITS, recovery: { contextExpand?: boolean; archiveSearch?: boolean; lean?: boolean } = {}): ToolDefinition {
	return {
		name: "command_run",
		logicalName: "command.run",
		readOnly: false,
		description:
			"Run a command in the workspace (not sandboxed; subject to approval). Provide either argv (preferred) or shellScript (run with bash -c). " +
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
				if (!statSync(cwd).isDirectory()) return fail(`cwd 不是目录：${rel}`);
				const timeout = Math.min(typeof args.timeoutMs === "number" ? args.timeoutMs : limits.defaultTimeoutMs, limits.maxTimeoutMs);
				const display = script ?? (argv ?? []).map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
				const risk = classifyRisk(display);
				const decision = await ctx.approve({ toolCallId: ctx.toolCallId, command: display, cwd: rel, risk, explanation: explain(display, risk) });
				if (ctx.signal.aborted) return fail("命令已取消，未启动进程", { command: display, cwd: rel, risk, cancelled: true });
				if (decision !== "allow") {
					return fail(`命令未获批准：${display}`, { command: display, cwd: rel, risk, approved: false });
				}
				const started = Date.now();
				const [prog, ...rest] = script ? ["bash", "-c", script] : (argv as string[]);
				const child = spawn(prog as string, rest, { cwd, detached: true, env: scrubEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
				const chunks: Buffer[] = [];
				child.stdout.on("data", (c: Buffer) => chunks.push(c));
				child.stderr.on("data", (c: Buffer) => chunks.push(c));
				let timedOut = false;
				let cancelled = false;
				const timer = setTimeout(() => {
					timedOut = true;
					killTree(child.pid, "SIGTERM");
					setTimeout(() => killTree(child.pid, "SIGKILL"), 2000).unref();
				}, timeout);
				const onAbort = () => {
					cancelled = true;
					killTree(child.pid, "SIGTERM");
					setTimeout(() => killTree(child.pid, "SIGKILL"), 1000).unref();
				};
				ctx.signal.addEventListener("abort", onAbort, { once: true });
				const exit: { code: number | null; signal: NodeJS.Signals | null; spawnError?: string } = await new Promise((resolve) => {
					child.on("error", (e) => resolve({ code: null, signal: null, spawnError: String(e) }));
					child.on("close", (code, signal) => resolve({ code, signal }));
				});
				clearTimeout(timer);
				ctx.signal.removeEventListener("abort", onAbort);
				// 进程组里可能还有后台子进程：统一清理
				killTree(child.pid, "SIGKILL");
				const raw = Buffer.concat(chunks);
				// Preserve bytes before deriving any display text. stdout/stderr are combined
				// in observed data-event order, not claimed to be an OS-wide total order.
				let ref: string | undefined;
				let archiveError: string | undefined;
				try {
					ref = ctx.blobs?.put(raw, { kind: "raw", source: { tool: "command_run", toolCallId: ctx.toolCallId, commandSha256: sha256(display), commandPreview: display.slice(0, 512), cwd: rel, exitCode: exit.code, signal: exit.signal, timedOut, cancelled, streamOrder: "observed-data-events" } });
					if (!ref) archiveError = "archive storage unavailable";
				} catch { archiveError = "archive write or verification failed"; }
				const invalidUtf8 = !isValidUtf8(raw);
				const output = raw.toString("utf8");
				const { text, truncated } = shape(output, limits);
				const durationMs = Date.now() - started;
				const status = exit.spawnError
					? `failed to start: ${exit.spawnError}`
					: timedOut
						? `timed out after ${timeout}ms`
						: cancelled
							? "cancelled"
							: `exit code ${exit.code ?? `signal ${exit.signal}`}`;
				const recoveryHint = (truncated || invalidUtf8)
					? ref ? (recovery.lean && !recovery.contextExpand ? "" : `; fullOutputRef=${ref}; ${recovery.contextExpand ? "recover with context_expand" : "audit only"}`) : `; full output unavailable: ${archiveError}`
					: "";
				const decoding = invalidUtf8 ? "; invalid UTF-8: display uses replacement characters" + (ref && recovery.contextExpand ? "; archived original bytes can be recovered as base64" : "") : "";
				const searchHint = ref && recovery.contextExpand && recovery.archiveSearch && (truncated || invalidUtf8)
					? `; search archived lines with context_search ref=${ref} toolCallId=${JSON.stringify(ctx.toolCallId)}` : "";
				const modelContent = `$ ${display}\n[${status}; ${durationMs}ms${truncated ? `; output truncated, full ${output.length} chars` : ""}${decoding}${recoveryHint}${searchHint}]\n${text}`;
				return {
					ok: !exit.spawnError && !timedOut && !cancelled && exit.code === 0,
					modelContent,
					summary: `运行 ${display.slice(0, 60)}（${status}）`,
					details: { command: display, cwd: rel, risk, exitCode: exit.code, signal: exit.signal, timedOut, cancelled, durationMs, outputChars: output.length, outputBytes: raw.length, outputSha256: sha256(raw), invalidUtf8, archiveError, streamOrder: "observed-data-events", toolCallId: ctx.toolCallId, truncated },
					...(ref ? { fullOutputRef: ref } : {}),
				};
			} catch (err) {
				return fail(err instanceof ToolError ? err.message : String(err));
			}
		},
	};
}
