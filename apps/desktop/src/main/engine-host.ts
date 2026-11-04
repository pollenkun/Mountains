/**
 * Holds one engine session and speaks only the existing protocol.
 * Setup (config, adapter, keychain, budget) is the CLI `mountains run` path.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { eventErrors, isValidCommand, isValidEvent, type EngineEvent } from "@mountains/protocol";
import { addedConfig, approvalSettingsFor, fixedThinking, keyEnvFor, prepareRun, previewRun, type PreparedRun, type RunHooks, type RunValues } from "@mountains/cli/run-session";
import { answerQuestion, createAgentsTool, createAskTool, type UserQuestion } from "./ask-tool.ts";
import { readGlobalAgents, writeGlobalAgents } from "./settings.ts";
import { webRun, webTools, type SearchService, type WebChoice } from "./web.ts";
import { loadKey } from "./keys.ts";

/**
 * The composer's approval modes, strictest first. 请求批准: reads run, the rest asks the user. 自动审批: the same,
 * with the configured approval model answering first (it asks the user when unsure). 完全访问: everything runs.
 */
export type ApprovalMode = "ask" | "auto" | "full";
/** One task on Kimi may cost this much, in CNY. */
const KIMI_MAX_COST = 5;
export const APPROVAL_POLICIES = {
	ask: { rules: [{ id: "desktop-allow-reads", decision: "allow", risks: ["read-only"] }], fallback: "ask" },
	auto: { rules: [{ id: "desktop-allow-reads", decision: "allow", risks: ["read-only"] }], fallback: "ask" },
	full: { rules: [{ id: "desktop-full-access", decision: "allow", risks: ["read-only", "workspace-write", "network", "dangerous"] }], fallback: "ask" },
} as const satisfies Record<ApprovalMode, { rules: { id: string; decision: "allow"; risks: string[] }[]; fallback: "ask" }>;

export interface HostOptions {
	workspace?: string;
	configPath?: string;
	outDir?: string;
	runId?: string;
	spendLedger?: string;
	fetch?: typeof globalThis.fetch;
	/** A conversation's own session id and the file its context is kept in, so reopening it continues where it left off. */
	session?: { id: string; file: string };
	/** After each run: where it recorded, how it ended, and the files it changed with the snapshot taken before it. */
	onRun?: (run: RunRecord) => void;
	/** This conversation does not read memory, whatever the setting says. */
	memoryOff?: boolean;
	/** Conversations memory search must not find. */
	memoryExclude?: () => string[];
	/** Desktop's web tools: the transport, the user's choice, and where a connected service is kept. */
	web?: { fetch: typeof globalThis.fetch; choice: () => WebChoice; connect: (service: SearchService) => void };
	/** Desktop conversations allow explicit paths outside the default workspace folder; CLI parity tests omit this. */
	allowOutside?: boolean;
	/** A question from ask_user, shown on the page until the user answers. */
	onAsk?: (question: UserQuestion) => void;
	/** Whether the model may replace AGENTS.md. Read at the moment it tries. */
	agentsWrite?: () => boolean;
	/** 允许 / 询问 for skills, read when a run starts. */
	skillModes?: () => Record<string, "allow" | "ask">;
}

export interface RunRecord {
	outDir: string;
	status: string;
	checkpoint: { tree: string; changed: { status: string; path: string }[] } | null;
}

/** Plan mode refuses these before anything else is asked: no file changes, nothing dangerous. */
const PLAN_REFUSES: ReadonlySet<"workspace-write" | "dangerous"> = new Set(["workspace-write", "dangerous"]);

interface Snapshots { exportSnapshot(): unknown; restoreSnapshot(raw: unknown, options?: { acrossModels?: boolean }): void }
/** A session, or an UltraCode team through its lead's own session. */
const snapshots = (run: unknown): Snapshots | null => {
	const session = (run as { session?: unknown } | undefined)?.session ?? run;
	return session && typeof (session as Snapshots).exportSnapshot === "function" && typeof (session as Snapshots).restoreSnapshot === "function" ? session as Snapshots : null;
};

/** Each engine session records into a folder of its own: run, then run-1, run-2… A reopened conversation gets the next one. */
function freshOut(base: string): string {
	for (let n = 0; ; n++) {
		const dir = n === 0 ? base : `${base}-${n}`;
		if (!existsSync(join(dir, "recording.jsonl"))) return dir;
	}
}

export function defaultWorkspace(): string {
	const dir = join(homedir(), "Mountains");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function createEngineHost(options: HostOptions = {}) {
	const listeners = new Set<(event: EngineEvent) => void>();
	const pending = new Map<string, (decision: "allow" | "deny") => void>();
	// An answer can arrive before askApproval is awaited, but only for a request the host announced.
	const requested = new Set<string>();
	const early = new Map<string, "allow" | "deny">();
	const held = new Map<string, EngineEvent>();
	let prepared: PreparedRun | null = null;
	/** What `prepared` was built for; see chosen. */
	let built = "";
	let generation = 0;
	let running = false;
	let abort: AbortController | null = null;
	let modelOverride: string | undefined;
	let effortOverride: string | undefined;
	let memoryOverride: boolean | undefined = options.memoryOff ? false : undefined;
	// UltraCode: a team at the chosen thinking tier; `maxAgents` absent is no limit.
	let team: { maxAgents?: number } | undefined;
	let maxAgentsPref: number | undefined;
	let approvalOverride: ApprovalMode | undefined;
	// 自动审批's model and thinking tier: undefined follows the run's own model / uses its lowest thinking.
	let approvalModel: string | undefined;
	let approvalEffort: string | undefined;
	// SIUI: replies with components; off unless the app turns it on.
	let siui = false;
	// Desktop conversations let tools resolve ~/... and absolute paths outside the default workspace folder.
	let allowOutside = options.allowOutside === true;
	// Plan mode: this conversation's runs may read but not change anything.
	let plan = false;
	let localSeq = 1;
	let chain: Promise<void> = Promise.resolve();
	let droppedCommands = 0;
	let runsStarted = 0;

	function publish(event: EngineEvent): void {
		if (!isValidEvent(event)) {
			console.error(`mountains: dropped invalid event ${eventErrors(event).join("; ")}`);
			return;
		}
		// Model auto-approval progress goes straight to the page for inline status badges; human/rule approvals are
		// held until askApproval actually asks the user, so a rule-settled call never flashes a card or notification.
		if (event.type === "approval.requested") {
			if (event.source === "model") {
				for (const listener of listeners) listener(event);
				return;
			}
			held.set(event.toolCallId, event);
			return;
		}
		if (event.type === "approval.resolved" && held.delete(event.toolCallId)) return;
		send(event);
	}

	function send(event: EngineEvent): void {
		if (event.type === "approval.requested") requested.add(event.toolCallId);
		for (const listener of listeners) listener(event);
	}

	function emitError(message: string): void {
		const event: EngineEvent = {
			protocolVersion: "0.1.0",
			sessionId: prepared?.sessionId ?? "ses_desktop",
			runId: "run_setup",
			seq: localSeq++,
			eventId: randomUUID(),
			time: new Date().toISOString(),
			priority: "high",
			type: "error",
			message,
			retryable: false,
		};
		publish(event);
	}

	function valuesFor(task: string): RunValues {
		const workspace = options.workspace ?? defaultWorkspace();
		const out = options.outDir ? freshOut(options.outDir) : undefined;
		return {
			task,
			workspace,
			json: true,
			help: false,
			"tool-observer-ipc": false,
			...(options.configPath ? { config: options.configPath } : {}),
			...(out ? { out } : {}),
			...(options.runId && generation === 0 ? { "run-id": options.runId } : {}),
			...(options.spendLedger ? { "spend-ledger": options.spendLedger } : {}),
		};
	}

	/** The model, tier and (when backed by a saved session) approval mode asked for now; a session built for others reloads at the next run. */
	const chosen = () => `${JSON.stringify(team ?? null)}\n${modelOverride ?? ""}\n${effortOverride ?? ""}${options.session ? `\n${approvalOverride ?? ""}\n${approvalModel ?? ""}\n${approvalEffort ?? ""}\n${allowOutside ? "1" : ""}` : ""}`;
	/** The model the saved context was last run on, if that is not the one chosen. */
	function savedModel(): string | undefined {
		const file = generation === 0 ? options.session?.file : undefined;
		if (!file || !existsSync(file)) return undefined;
		try {
			const { model } = JSON.parse(readFileSync(file, "utf8")) as { model?: unknown };
			return typeof model === "string" && model !== modelOverride ? model : undefined;
		} catch { return undefined; }
	}

	/** `older`: the model a conversation was on, for compacting it with the model that wrote it. */
	function hooks(older?: string): RunHooks {
		const hooks: RunHooks = {
			onEvent: (event) => publish(event),
			askApproval: (req) => {
				const announced = held.get(req.toolCallId);
				if (announced) {
					held.delete(req.toolCallId);
					send(announced);
				}
				const queued = early.get(req.toolCallId);
				if (queued) {
					early.delete(req.toolCallId);
					requested.delete(req.toolCallId);
					return Promise.resolve(queued);
				}
				return new Promise((resolve) => {
					pending.set(req.toolCallId, (decision) => {
						requested.delete(req.toolCallId);
						resolve(decision);
					});
				});
			},
		};
		if (options.fetch) hooks.fetch = options.fetch;
		if (options.session && generation === 0) hooks.sessionId = options.session.id;
		hooks.interjections = true;
		hooks.noTotalBudget = true;
		hooks.noComputerUse = true;
		hooks.allowPartialUsage = true;
		const kept = options.memoryExclude?.() ?? [];
		if (kept.length) hooks.memoryExclude = kept;
		if (allowOutside) hooks.allowOutside = true;
		if (approvalOverride === "auto") hooks.lenientApproval = true;
		if (team) hooks.team = team;
		if (allowOutside || approvalOverride !== undefined) hooks.approveFileWrites = true;
		if (siui) hooks.siui = true;
		const web = options.web?.choice().enabled ? options.web : null;
		const tools = [
			...(web ? webTools({ ...web, run: () => webRun(previewRun(options.configPath, modelOverride ? { model: modelOverride } : {}).config) }) : []),
			...(options.onAsk ? [
				createAskTool(options.onAsk),
				createAgentsTool({ allowed: () => options.agentsWrite?.() === true, read: readGlobalAgents, write: writeGlobalAgents, notify: options.onAsk }),
			] : []),
		];
		hooks.tools = tools;
		const model = older ?? modelOverride, effort = older ? undefined : effortOverride;
		const run = previewRun(options.configPath, model ? { model } : {}).config;
		// The default cap stops Kimi at its second message; the user set this one.
		const kimiCap = keyEnvFor(run.model, run) === "MOONSHOT_API_KEY" ? { limits: { ...run.limits, maxCost: KIMI_MAX_COST } } : {};
		const skillModes = options.skillModes?.() ?? {};
		if (model || effort || memoryOverride !== undefined || approvalOverride || "limits" in kimiCap || Object.keys(skillModes).length) hooks.configOverrides = {
			// Only 自动审批 has an approval model; the other two leave every answer to the policy or the user.
			...(approvalOverride ? { approval: APPROVAL_POLICIES[approvalOverride], modelApproval: approvalOverride === "auto" ? reviewer() : null } : {}),
			...(model ? { model } : {}),
			...(memoryOverride !== undefined ? { memory: memoryOverride } : {}),
			...fixedThinking(model),
			...addedConfig(model),
			...(effort ? { thinking: { enabled: true, effort: effort as "default" } } : {}),
			...kimiCap,
			...(Object.keys(skillModes).length ? { skills: { ...run.skills, permissions: { ...run.skills.permissions, ...skillModes } } } : {}),
		};
		return hooks;
	}

	const INTERJECT_REFUSED: Record<string, string> = {
		idle: "这一轮已经结束，直接发送会开始新的一轮",
		closing: "这一轮正在收尾，等它结束再发",
		"queue-full": "跟进太多了，等模型先读完再发",
		"invalid-input": "跟进不能为空，也不能超过 65536 个字",
		disabled: "这个对话不能跟进",
	};

	/** A message for the run that is going; the page hears back as run.interjected, or as an error saying why not. */
	function interject(text: string): void {
		type Interjecting = { interject?: (text: string) => { accepted: boolean; id?: string; runId?: string; reason?: string }; session?: Interjecting };
		// An UltraCode team takes the message through its lead's own session.
		const run = prepared?.session as Interjecting | undefined, session = run?.interject ? run : run?.session;
		const receipt = !running ? { accepted: false, reason: "idle" } : session?.interject ? session.interject(text) : { accepted: false, reason: "disabled" };
		if (!receipt.accepted || !receipt.id || !receipt.runId) {
			emitError(`没有跟进：${INTERJECT_REFUSED[receipt.reason ?? ""] ?? receipt.reason ?? "原因不明"}`);
			return;
		}
		publish({ protocolVersion: "0.1.0", sessionId: prepared!.sessionId, runId: receipt.runId, seq: localSeq++, eventId: randomUUID(), time: new Date().toISOString(), type: "run.interjected", id: receipt.id, text });
	}

	/** 自动审批's settings: the chosen model (or the run's own) with the chosen or lowest thinking; the config's own when nothing was chosen. */
	function reviewer(): never {
		const { config } = previewRun(options.configPath, modelOverride ? { model: modelOverride } : {});
		if (!approvalModel && !approvalEffort && config.modelApproval) return config.modelApproval as never;
		const target = approvalModel ?? config.modelApproval?.model ?? config.model;
		const settings = approvalSettingsFor(target, config, approvalEffort) ?? (approvalEffort ? approvalSettingsFor(target, config) : null);
		return (settings && loadKey(String(settings.apiKeyEnv)) ? settings : null) as never;
	}

	function cancel(): void {
		abort?.abort();
		for (const resolve of pending.values()) resolve("deny");
		pending.clear();
		early.clear();
	}

	async function start(task: string): Promise<void> {
		if (running) {
			emitError("同一会话正在运行");
			return;
		}
		running = true;
		// Another model or tier was chosen: the conversation goes on from its saved context.
		if (prepared && built !== chosen()) await reload();
		const controller = new AbortController();
		abort = controller;
		try {
			if (!prepared) {
				runsStarted++;
				prepared = await prepareRun(valuesFor(task), (msg) => {
					throw new Error(msg ?? "用法错误");
				}, hooks());
				built = chosen();
				restore(prepared);
			}
			const lead = (prepared.session as { session?: unknown }).session ?? prepared.session;
			(lead as { refuseRisks: ReadonlySet<string> | null }).refuseRisks = plan ? PLAN_REFUSES : null;
			const summary = await prepared.session.run(task, controller.signal);
			save(prepared);
			options.onRun?.({ outDir: prepared.outDir, status: summary.status, checkpoint: (summary as { checkpoint?: RunRecord["checkpoint"] }).checkpoint ?? null });
		} catch (error) {
			emitError(error instanceof Error ? error.message : String(error));
		} finally {
			running = false;
			if (abort === controller) abort = null;
		}
	}

	/** The saved context goes back into a fresh session; one that no longer fits (another model, other settings) is left alone and the conversation starts over. */
	function restore(run: PreparedRun): void {
		const file = generation === 0 ? options.session?.file : undefined, session = snapshots(run.session);
		if (!file || !session || !existsSync(file)) return;
		try { session.restoreSnapshot(JSON.parse(readFileSync(file, "utf8")), { acrossModels: true }); }
		catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error(`mountains: the conversation's saved context was not restored: ${reason}`);
			emitError(`没有接上这个对话之前的上下文，这一轮从头开始：${reason}`);
		}
	}

	function save(run: PreparedRun): void {
		const file = generation === 0 ? options.session?.file : undefined, session = snapshots(run.session);
		if (!file || !session) return;
		try {
			const body = `${JSON.stringify(session.exportSnapshot())}\n`;
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
			renameSync(`${file}.tmp`, file);
		} catch (error) { console.error(`mountains: the conversation's context was not saved: ${error instanceof Error ? error.message : String(error)}`); }
	}

	async function clear(): Promise<void> {
		cancel();
		const current = prepared;
		prepared = null;
		generation++;
		early.clear();
		requested.clear();
		if (!current) return;
		current.toolObserver?.dispose();
		try { await current.cleanup(); }
		catch (error) { console.error(`mountains: session cleanup failed ${error instanceof Error ? error.message : String(error)}`); }
	}

	/** Drops the live session but keeps the conversation's id, so the next run starts from the saved context as it now is. */
	async function reload(): Promise<void> {
		cancel();
		const current = prepared;
		prepared = null;
		early.clear();
		requested.clear();
		if (!current) return;
		current.toolObserver?.dispose();
		try { await current.cleanup(); }
		catch (error) { console.error(`mountains: session cleanup failed ${error instanceof Error ? error.message : String(error)}`); }
	}

	function enqueue(work: () => Promise<void>): void {
		chain = chain.then(work, work);
	}

	return {
		get droppedCommands() { return droppedCommands; },
		get runsStarted() { return runsStarted; },
		onEvent(listener: (event: EngineEvent) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		handleCommand(command: unknown): void {
			if (!isValidCommand(command)) {
				droppedCommands++;
				const kind = command && typeof command === "object" && "type" in command ? String(command.type) : "unrecognized";
				console.error(`mountains: dropped invalid command ${kind}`);
				return;
			}
			switch (command.type) {
				case "run.start":
					enqueue(() => start(command.task));
					return;
				case "run.cancel":
					cancel();
					return;
				case "run.interject":
					interject(command.text);
					return;
				case "approval.respond":
					if (command.decision === "always") console.error("mountains: approval.respond always is allow for this call; the engine has no API to store an always rule");
					{
						const answer = command.decision === "deny" ? "deny" : "allow";
						const resolve = pending.get(command.toolCallId);
						if (resolve) {
							pending.delete(command.toolCallId);
							resolve(answer);
						} else if (requested.has(command.toolCallId)) early.set(command.toolCallId, answer);
						else {
							droppedCommands++;
							console.error("mountains: dropped approval.respond for a call that is not awaiting approval");
						}
					}
					return;
				case "session.clear":
					cancel();
					// Starting over drops the saved context; closing the app keeps it.
					if (options.session) rmSync(options.session.file, { force: true });
					enqueue(() => clear());
					return;
				case "model.set":
					modelOverride = command.model;
					if (prepared) console.error("mountains: model.set applies after session.clear; a live session cannot change models");
					return;
			}
		},
		/** The model and thinking tier chosen in the page; a live session keeps its own until session.clear. */
		preferences(): { model?: string; effort?: string; memory?: boolean; approval?: ApprovalMode; approvalModel?: string; approvalEffort?: string; siui?: boolean; team?: boolean; maxAgents?: number | null } {
			return { ...(team ? { team: true, maxAgents: team.maxAgents ?? null } : {}), ...(modelOverride ? { model: modelOverride } : {}), ...(effortOverride ? { effort: effortOverride } : {}), ...(memoryOverride !== undefined ? { memory: memoryOverride } : {}), ...(approvalOverride ? { approval: approvalOverride } : {}), ...(approvalModel ? { approvalModel } : {}), ...(approvalEffort ? { approvalEffort } : {}), ...(siui ? { siui } : {}) };
		},
		choose(next: { model?: string; effort?: string; memory?: boolean; approval?: ApprovalMode; approvalModel?: string | null; approvalEffort?: string | null; siui?: boolean; allowOutside?: boolean; team?: boolean; maxAgents?: number | null }): void {
			if (next.maxAgents !== undefined) maxAgentsPref = next.maxAgents ?? undefined;
			if (next.team !== undefined) team = next.team ? (maxAgentsPref !== undefined ? { maxAgents: maxAgentsPref } : {}) : undefined;
			else if (next.maxAgents !== undefined && team) team = maxAgentsPref !== undefined ? { maxAgents: maxAgentsPref } : {};
			if (next.allowOutside !== undefined) allowOutside = next.allowOutside;
			if (next.siui !== undefined) siui = next.siui;
			if (next.approvalModel !== undefined) approvalModel = next.approvalModel ?? undefined;
			if (next.approvalEffort !== undefined) approvalEffort = next.approvalEffort ?? undefined;
			if (next.memory !== undefined && !options.memoryOff) memoryOverride = next.memory;
			if (next.approval) approvalOverride = next.approval;
			if (next.model) modelOverride = next.model;
			// "default" means the config's own setting.
			if (next.effort) effortOverride = next.effort === "default" ? undefined : next.effort;
		},
		whenIdle(): Promise<void> {
			return chain;
		},
		get running(): boolean { return running; },
		answerAsk(id: string, text: string): boolean { return answerQuestion(id, text); },
		get plan(): boolean { return plan; },
		/** Plan mode for this conversation's next runs. */
		setPlan(on: boolean): void { plan = on; },
		/** Compacts the conversation's context now. It waits its turn in the queue, like a run. */
		compact(): Promise<{ before: number; after: number } | null> {
			const work = async () => {
				if (!prepared) {
					// Compacting is the old model's last job: it wrote this context, and it has the cache.
					const older = savedModel();
					prepared = await prepareRun(valuesFor("compact"), (msg) => { throw new Error(msg ?? "用法错误"); }, hooks(older));
					built = older ? "" : chosen();
					restore(prepared);
				}
				const lead = ((prepared.session as { session?: unknown }).session ?? prepared.session) as { compactNow?: () => Promise<{ revision: { tokensBefore: number; tokensAfter: number } | null }> };
				if (!lead.compactNow) throw new Error("这个对话不能手动压缩");
				const { revision } = await lead.compactNow();
				save(prepared);
				return revision ? { before: revision.tokensBefore, after: revision.tokensAfter } : null;
			};
			const done = chain.then(work, work);
			chain = done.then(() => {}, () => {});
			return done;
		},
		/** Waits for the queue, then drops the live session; see reload. */
		reload(): Promise<void> {
			const done = chain.then(reload, reload);
			chain = done;
			return done;
		},
		async dispose(): Promise<void> {
			cancel();
			await chain;
			await clear();
		},
	};
}

export type EngineHost = ReturnType<typeof createEngineHost>;
