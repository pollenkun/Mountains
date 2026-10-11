#!/usr/bin/env node
/**
 * Mountains CLI implementation; the lightweight main.ts initializes the optional compile cache first.
 *   mountains run --task <描述> | --task-file <路径> --workspace <路径> [--config <json>] [--json] [--out <目录>]
 *                 [--run-id <id>] [--base-url <url>] [--spend-ledger <路径>]
 *   mountains replay --recording <recording.jsonl> --workspace <路径> [--out <目录>] [--json]
 *
 * 退出码：0 完成；1 失败；2 用法错误；3 达到限制（轮数/预算/token）；130 用户取消。
 * Key 只从环境变量读取（按模型的供应商：DEEPSEEK_API_KEY、ZHIPU_API_KEY、MOONSHOT_API_KEY）。base URL 指向本机兼容代理时，
 * 代理负责注入鉴权，本进程不需要 Key。
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { EngineEvent } from "@mountains/protocol";
import { AgentSession, BudgetGuard, DEFAULT_LIMITS, type RunSummary, replayAdapterFromRecording } from "@mountains/engine";
import { ApprovalChatAdapter, ChatCompletionsAdapter, currencyOf, type Currency, type ModelAdapter, pricingFor, providerOf } from "@mountains/providers";
import { Workspace } from "@mountains/tools";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { expandHome, mountainsHome } from "./paths.ts";

const EXIT = { completed: 0, failed: 1, usage: 2, limit: 3, cancelled: 130 } as const;

const USAGE = "用法：\n  mountains run --task <描述> | --task-file <路径> --workspace <路径> [--config <json>] [--json] [--out <目录>] [--run-id <id>] [--base-url <url>] [--spend-ledger <路径>]\n" +
	"  mountains replay --recording <recording.jsonl> --workspace <路径> [--out <目录>] [--json]\n";

function usage(msg?: string): never {
	if (msg) process.stderr.write(`错误：${msg}\n`);
	process.stderr.write(USAGE);
	process.exit(EXIT.usage);
}

function help(): never {
	process.stdout.write(USAGE);
	process.exit(0);
}

/** Per-project data outside the workspace: ~/.mountains/projects/<hash of the real workspace path>. */
function projectDir(workspaceRoot: string, home = mountainsHome()): string {
	const root = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);
	return join(resolve(home), "projects", createHash("sha256").update(root).digest("hex").slice(0, 16));
}

function requireExternalStorage(path: string, workspace: string): string {
	const dest = resolve(path);
	if (new Workspace(workspace).contains(dest)) throw new Error("项目记忆与原文档案必须存放在任务工作区之外");
	return dest;
}

function isLoopback(url: string): boolean {
	try {
		const h = new URL(url).hostname;
		return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
	} catch {
		return false;
	}
}

interface Common {
	workspace: string;
	outDir: string;
	json: boolean;
}

function eventSink(outDir: string, json: boolean): (e: EngineEvent) => void {
	const eventsPath = join(outDir, "events.jsonl");
	return (e) => {
		if (e.type !== "message.delta") appendFileSync(eventsPath, `${JSON.stringify(e)}\n`);
		if (json) return;
		// 人类可读的进度（stderr），不影响 stdout 的最终结果
		if (e.type === "tool.requested") process.stderr.write(`· ${e.tool} ${typeof e.args === "string" ? e.args : JSON.stringify(e.args).slice(0, 160)}\n`);
		else if (e.type === "tool.completed") process.stderr.write(`  ${e.ok ? "✓" : "✗"} ${e.summary.slice(0, 160)} (${e.durationMs}ms)\n`);
		else if (e.type === "usage") process.stderr.write(`  [usage] 命中 ${e.usage.cacheRead ?? "?"} 未命中 ${e.usage.input ?? "?"} 输出 ${e.usage.output ?? "?"} ≈${e.cost?.toFixed(5) ?? "?"} ${e.currency}\n`);
		else if (e.type === "error") process.stderr.write(`! ${e.message}\n`);
	};
}

async function runWithSignals(session: AgentSession, task: string): Promise<RunSummary> {
	const ac = new AbortController();
	let interrupts = 0;
	const onSig = () => {
		interrupts++;
		if (interrupts === 1) {
			process.stderr.write("\n收到中断，正在取消（再按一次强制退出）\n");
			ac.abort();
		} else process.exit(EXIT.cancelled);
	};
	process.on("SIGINT", onSig);
	process.on("SIGTERM", onSig);
	try {
		return await session.run(task, ac.signal);
	} finally {
		process.off("SIGINT", onSig);
		process.off("SIGTERM", onSig);
	}
}

function finish(summary: RunSummary, outDir: string, json: boolean, extra: Record<string, unknown>): never {
	const out = { ...summary, ...extra, outDir };
	writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(out, null, 2)}\n`);
	if (json) process.stdout.write(`${JSON.stringify(out)}\n`);
	else {
		process.stdout.write(`${summary.finalText}\n`);
		process.stderr.write(
			`\n[${summary.status}] ${summary.reason}；${summary.turns} 轮，${summary.totals.requests} 次请求，命中 ${summary.totals.cacheRead} / 未命中 ${summary.totals.input} / 输出 ${summary.totals.output}，估算 ${summary.totals.cost.toFixed(5)} ${summary.totals.currency}；结果目录 ${outDir}\n`,
		);
	}
	process.exit(EXIT[summary.status]);
}

async function cmdRun(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			help: { type: "boolean", short: "h" },
			task: { type: "string" },
			"task-file": { type: "string" },
			workspace: { type: "string" },
			config: { type: "string" },
			json: { type: "boolean", default: false },
			out: { type: "string" },
			"run-id": { type: "string" },
			"base-url": { type: "string" },
			"spend-ledger": { type: "string" },
		},
		strict: true,
	});
	if (values.help) help();
	if (!values.workspace) usage("缺少 --workspace");
	if (!values.task === !values["task-file"]) usage("--task 与 --task-file 必须且只能给一个");
	const task = values.task ?? readFileSync(values["task-file"] as string, "utf8");
	const loaded = loadConfig(values.config ? resolve(values.config) : null, values["base-url"] ? { baseUrl: values["base-url"] } : {});
	const cfg = loaded.config;
	const spendLedger = resolve(expandHome(values["spend-ledger"] ?? (loaded.spendLedgerExplicit ? cfg.spendLedger : join(mountainsHome(), "spend.jsonl"))));
	const legacyLedger = resolve(expandHome(DEFAULT_CONFIG.spendLedger));
	if (values["spend-ledger"] === undefined && !loaded.spendLedgerExplicit && spendLedger !== legacyLedger
		&& !existsSync(spendLedger) && existsSync(legacyLedger)) {
		throw new Error(`检测到旧累计花费台账：${legacyLedger}。请先将其迁移到 ${spendLedger}，或用 --spend-ledger 显式指定原路径；为避免重置累计预算，本次未发出请求。`);
	}
	const runId = values["run-id"] ?? `run_${randomUUID().slice(0, 12)}`;
	const outDir = resolve(values.out ?? join(mountainsHome(), "runs", runId));
	mkdirSync(outDir, { recursive: true });

	let apiKey = process.env[cfg.apiKeyEnv];
	if (!apiKey) {
		if (isLoopback(cfg.baseUrl)) apiKey = "proxy-injected";
		else usage(`环境变量 ${cfg.apiKeyEnv} 未设置（Key 只从环境变量读取）`);
	}
	const provider = providerOf(cfg.model);
	const adapter = new ChatCompletionsAdapter({ baseUrl: cfg.baseUrl, apiKey, ...(provider ? { provider } : {}) });
	let modelApproval;
	if (cfg.modelApproval) {
		const settings = cfg.modelApproval;
		let approvalKey = process.env[settings.apiKeyEnv];
		if (!approvalKey) {
			if (isLoopback(settings.baseUrl)) approvalKey = "proxy-injected";
			else usage(`审批模型环境变量 ${settings.apiKeyEnv} 未设置（不会复用主模型 Key）`);
		}
		modelApproval = { settings, adapter: new ApprovalChatAdapter({
			baseUrl: settings.baseUrl, apiKey: approvalKey, profile: settings.profile, timeoutMs: settings.timeoutMs,
			...(settings.supportedEfforts ? { supportedEfforts: settings.supportedEfforts } : {}),
			...(settings.effortMapping ? { effortMapping: settings.effortMapping } : {}),
			...(settings.maxTokensField ? { maxTokensField: settings.maxTokensField } : {}),
			...(settings.disabledReasoningEffort ? { disabledReasoningEffort: settings.disabledReasoningEffort } : {}),
		}) };
	}
	const userId = cfg.userIdMode === "per-run" ? `mtn-${runId}` : cfg.userIdMode === "fixed" ? cfg.userIdFixed : undefined;
	const budget = BudgetGuard.fromEnv(spendLedger, currencyOf(cfg.model, cfg.billingCurrency) ?? "USD");
	const ws = new Workspace(resolve(values.workspace));
	const session = new AgentSession({
		workspace: resolve(values.workspace),
		dataDir: outDir,
		adapter,
		model: cfg.model,
		...(cfg.billingCurrency !== undefined ? { billingCurrency: cfg.billingCurrency } : {}),
		thinking: cfg.thinking,
		maxTokens: cfg.maxTokens,
		limits: cfg.limits,
		retry: cfg.retry,
		...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
		verbatimToolArguments: cfg.verbatimToolArguments,
		...(userId ? { userId } : {}),
		...(loaded.systemPrompt !== null ? { systemPrompt: loaded.systemPrompt } : {}),
		approval: cfg.approval,
		requestGuard: cfg.requestGuard,
		...(modelApproval ? { modelApproval } : {}),
		budget,
		runId,
		checkpoints: cfg.checkpoints,
		// Folded and compacted originals stay with the project, outside the task checkout.
		archiveDir: requireExternalStorage(join(projectDir(ws.root), "blobs"), ws.root),
		toolOptions: { read: cfg.tools.read, batchEdit: cfg.tools.batchEdit, editFeedback: cfg.tools.editFeedback },
		onEvent: eventSink(outDir, values.json),
	});
	writeFileSync(join(outDir, "config.json"), `${JSON.stringify({ source: loaded.source, sha256: loaded.sha256, config: cfg }, null, 2)}\n`);
	const summary = await runWithSignals(session, task);
	finish(summary, outDir, values.json, {
		configSha256: loaded.sha256,
		approvalRules: cfg.approval.rules.map((r) => r.id),
		budget: { globalLimit: budget.globalLimit, globalSpent: budget.globalSpent, currency: budget.currency },
	});
}

async function cmdReplay(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: { help: { type: "boolean", short: "h" }, recording: { type: "string" }, workspace: { type: "string" }, out: { type: "string" }, json: { type: "boolean", default: false } },
		strict: true,
	});
	if (values.help) help();
	if (!values.recording || !values.workspace) usage("replay 需要 --recording 与 --workspace");
	const lines = readFileSync(values.recording, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
	const meta = lines.find((l) => l.kind === "meta")?.data ?? {};
	const input = lines.find((l) => l.kind === "user.input")?.data;
	if (!input) usage("录制文件中没有 user.input");
	const model = String(meta.model ?? "deepseek-flash");
	let billingCurrency: Currency | undefined;
	if (Object.hasOwn(meta, "billingCurrency")) {
		if (meta.billingCurrency !== "USD" && meta.billingCurrency !== "CNY") throw new Error("录制 meta.billingCurrency 必须为 USD 或 CNY");
		billingCurrency = meta.billingCurrency;
		if (!pricingFor(model, billingCurrency)) throw new Error(`录制模型 ${model} 没有 ${billingCurrency} 官方价格`);
	}
	const outDir = resolve(values.out ?? join(mountainsHome(), "replays", `replay_${randomUUID().slice(0, 8)}`));
	mkdirSync(outDir, { recursive: true });
	const adapter: ModelAdapter = replayAdapterFromRecording(values.recording);
	const session = new AgentSession({
		workspace: resolve(values.workspace),
		dataDir: outDir,
		adapter,
		model,
		...(typeof meta.contextWindow === "number" ? { contextWindow: meta.contextWindow } : {}),
		...(billingCurrency !== undefined ? { billingCurrency, limits: { ...DEFAULT_LIMITS, maxCost: 1e9 } } : {}),
		thinking: (meta.thinking as { enabled: boolean; effort: "high" }) ?? { enabled: true, effort: "high" },
		maxTokens: Number(meta.maxTokens ?? 32000),
		// 回放不花钱：独立的临时台账。显式币种的 1e9 上限只保护回放，不代表原任务预算。
		budget: new BudgetGuard({ globalLimit: 1e9, currency: currencyOf(model, billingCurrency) ?? "USD", ledgerPath: join(outDir, "replay-spend.jsonl") }),
		retry: { maxAttempts: 1, baseDelayMs: 0 },
		onEvent: eventSink(outDir, values.json),
	});
	const summary = await runWithSignals(session, String(input.task));
	finish(summary, outDir, values.json, { replayOf: resolve(values.recording), note: "离线回放只模拟模型输出，不能作为成功率或缓存证据" });
}

const [cmd, ...rest] = process.argv.slice(2);
try {
	if ((cmd === "--help" || cmd === "-h") && rest.length === 0) help();
	else if (cmd === "--version" && rest.length === 0) {
		const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
		process.stdout.write(`mountains ${version}\n`);
	} else if (cmd === "run") await cmdRun(rest);
	else if (cmd === "replay") await cmdReplay(rest);
	else usage(cmd ? `未知命令 ${cmd}` : undefined);
} catch (err) {
	process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(EXIT.failed);
}
