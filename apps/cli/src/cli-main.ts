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
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { USAGE, parseRunArgs, parseReplayArgs } from "./cli-args.ts";
import { cmdSecret } from "./cli-secret.ts";
import { AgentSession, BudgetGuard, DEFAULT_LIMITS, type RunSummary, replayAdapterFromRecording } from "@mountains/engine";
import { billingLabel, currencyOf, type Currency, type ModelAdapter, pricingFor } from "@mountains/providers";
import { expandHome, mountainsHome } from "./paths.ts";
import { eventSink, freshOutDir, prepareRun, requireExternalStorage } from "./run-session.ts";

const EXIT = { completed: 0, failed: 1, usage: 2, limit: 3, cancelled: 130 } as const;

function usage(msg?: string): never {
	if (msg) process.stderr.write(`错误：${msg}\n`);
	process.stderr.write(USAGE);
	process.exit(EXIT.usage);
}

function help(): never {
	process.stdout.write(USAGE);
	process.exit(0);
}

async function runWithSignals<T extends RunSummary>(session: { run(task: string, signal: AbortSignal): Promise<T> }, task: string, cleanup?: () => Promise<void>, fatalSignal?: AbortSignal): Promise<T> {
	const ac = new AbortController();
	let interrupts = 0;
	const onSig = () => {
		interrupts++;
		if (interrupts === 1) {
			process.stderr.write("\n收到中断，正在取消并关闭辅助进程\n");
			ac.abort();
		} else { ac.abort(); process.stderr.write("取消已经开始，正在等辅助进程结束。\n"); }
	};
	process.on("SIGINT", onSig);
	process.on("SIGTERM", onSig);
	try {
		return await session.run(task, fatalSignal ? AbortSignal.any([ac.signal, fatalSignal]) : ac.signal);
	} finally {
		try { await cleanup?.(); } finally {
			process.off("SIGINT", onSig);
			process.off("SIGTERM", onSig);
		}
	}
}

/** Exit only after stdout and stderr have passed everything on: a slow pipe must receive the whole result. */
async function exitWhenFlushed(code: number): Promise<never> {
	process.exitCode = code;
	await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((done) => {
		stream.once("error", () => done());
		stream.write("", () => done());
	})));
	process.exit(code);
}

async function finish(summary: RunSummary, outDir: string, json: boolean, extra: Record<string, unknown>, model = ""): Promise<never> {
	const out = { ...summary, ...extra, outDir };
	writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
	const costText = billingLabel(model) ? "未计费" : `估算 ${summary.totals.cost.toFixed(5)} ${summary.totals.currency}`;
	if (json) process.stdout.write(`${JSON.stringify(out)}\n`);
	else {
		process.stdout.write(`${summary.finalText}\n`);
		process.stderr.write(
			`\n[${summary.status}] ${summary.reason}；${summary.turns} 轮，${summary.totals.requests} 次请求，命中 ${summary.totals.cacheRead} / 未命中 ${summary.totals.input} / 输出 ${summary.totals.output}，${costText}；结果目录 ${outDir}\n`,
		);
	}
	return exitWhenFlushed(EXIT[summary.status]);
}

async function cmdRun(argv: string[]): Promise<void> {
	const { values } = parseRunArgs(argv);
	if (values.help) help();
	const prepared = await prepareRun(values, usage);
	let summary: RunSummary;
	const cleanupErrors: string[] = [];
	try {
		summary = await runWithSignals(prepared.session, prepared.task, async () => {
			try { await prepared.cleanup(); }
			catch (error) { cleanupErrors.push(String(error)); }
		}, prepared.fatalSignal);
	} catch (error) {
		prepared.toolObserver?.dispose();
		throw error;
	}
	if (cleanupErrors.length) summary = { ...summary, status: summary.status === "completed" ? "failed" : summary.status, reason: summary.reason + "; resource cleanup failed: " + cleanupErrors.join("; ") };
	if (prepared.toolObserver) {
		// Team may return a successful lead after a member's observer failed. Channel health is global.
		try { if (!prepared.toolObserver.healthy) throw null; await prepared.toolObserver.finish(summary); }
		catch { summary = { ...summary, status: "failed", reason: summary.reason + "; 工具执行控制器未完成核对，已有结果已保留" }; }
		finally { prepared.toolObserver.dispose(); }
	}
	await finish(summary, prepared.outDir, values.json, {
		cleanupErrors, configSha256: prepared.configSha256,
		approvalRules: prepared.approvalRuleIds,
		budget: { globalLimit: prepared.budget.globalLimit, globalSpent: prepared.budget.globalSpent, currency: prepared.budget.currency },
		...(billingLabel(prepared.model) ? { billingLabel: "未计费" } : {}),
	}, prepared.model);
}

async function cmdReplay(argv: string[]): Promise<void> {
	const { values } = parseReplayArgs(argv);
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
	const outDir = requireExternalStorage(values.out ?? join(mountainsHome(), "replays", `replay_${randomUUID().slice(0, 8)}`), resolve(values.workspace));
	freshOutDir(outDir);
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
	await finish(summary, outDir, values.json, { replayOf: resolve(values.recording), note: "离线回放只模拟模型输出，不能作为成功率或缓存证据" });
}

const [cmd, ...rest] = process.argv.slice(2);
try {
	if ((cmd === "--help" || cmd === "-h") && rest.length === 0) help();
	else if (cmd === "--version" && rest.length === 0) {
		const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
		process.stdout.write(`mountains ${version}\n`);
	} else if (cmd === "run") await cmdRun(rest);
	else if (cmd === "replay") await cmdReplay(rest);
	else if (cmd === "secret") await cmdSecret(rest);
	else usage(cmd ? `未知命令 ${cmd}` : undefined);
} catch (err) {
	process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(EXIT.failed);
}
