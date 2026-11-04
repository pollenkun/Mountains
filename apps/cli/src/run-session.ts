/**
 * Session setup shared by `mountains run` and the desktop host.
 * The CLI passes no hooks. Optional hooks must not change that path.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { EngineEvent } from "@mountains/protocol";
import { AgentSession, AgentTeam, BudgetGuard, type EngineOptions, type RunSummary, validateApprovalSettings } from "@mountains/engine";
import { computerUseSkill, KeychainSecrets } from "@mountains/computer";
import { AnthropicMessagesAdapter, ApprovalChatAdapter, CAPABILITIES, REASONING_TIERS, type ProviderInfo, suggestModels, ChatCompletionsAdapter, capabilitiesFor, currencyOf, type EffortSetting, estimateCost, loadCatalog, type ModelAdapter, pricingFor, PROVIDERS, providerOf, reasoningProfile } from "@mountains/providers";
import { createMemorySearchTool, discoverSkills, disposeBuiltinSkills, projectSkillRoots, type ApprovalRequest, type BuiltinSkill, type SkillRoot, type ToolDefinition, Workspace } from "@mountains/tools";
import { DEFAULT_CONFIG, engineThinking, loadConfig, type MountainsConfig } from "./config.ts";
import { readInstructions } from "./instructions.ts";
import { expandHome, mountainsHome } from "./paths.ts";
import { ToolObserverIpcClient } from "./tool-observer-ipc.ts";
import { observerHash } from "./tool-observer-protocol.ts";

export interface RunValues {
	help?: boolean;
	task?: string;
	"task-file"?: string;
	workspace?: string;
	config?: string;
	json?: boolean;
	out?: string;
	"run-id"?: string;
	"base-url"?: string;
	"spend-ledger"?: string;
	"tool-observer-ipc"?: boolean;
}

export interface RunHooks {
	/** Folders memory search leaves out: conversations the user kept out of memory. */
	memoryExclude?: string[];
	onEvent?: (event: EngineEvent) => void;
	askApproval?: (req: ApprovalRequest) => Promise<"allow" | "deny">;
	fetch?: typeof globalThis.fetch;
	/** Applied only by the desktop host. The CLI omits this. */
	configOverrides?: Partial<MountainsConfig>;
	/** Desktop only: a conversation keeps one session id, so its context can be saved and restored later. */
	sessionId?: string;
	/** Desktop only: the user can add messages while a run is going (run.interject). */
	interjections?: boolean;
	/** Desktop only: replies are drawn as Markdown with SIUI components, and the model is told how to write them. */
	siui?: boolean;
	/** Desktop only: the task cap is the limit; a total over every run would stop the app for good, with nowhere to raise it. */
	noTotalBudget?: boolean;
	/** Desktop only: Preview 2 ships without computer use, whatever a config file enables. */
	noComputerUse?: boolean;
	/** Desktop only: tools of its own for the lead agent. */
	tools?: ToolDefinition[];
	/** Desktop only: relative paths use the workspace folder, while explicit ~/ or absolute paths elsewhere on this computer are also allowed. */
	allowOutside?: boolean;
	/** Desktop's UltraCode switch: a team at the thinking tier the user chose. No limit means none on the agents. */
	team?: { maxAgents?: number };
	/** Desktop's 自动审批; see EngineOptions.lenientApproval. */
	lenientApproval?: boolean;
	/** Desktop only: file_edit and file_write go through the run's approval policy (ask / auto / full). */
	approveFileWrites?: boolean;
	/** Desktop only: keep conservative worst-case billing on partial usage without halting the conversation. */
	allowPartialUsage?: boolean;
}

export interface PreparedRun {
	task: string;
	model: string;
	outDir: string;
	json: boolean;
	configSha256: string;
	approvalRuleIds: string[];
	budget: BudgetGuard;
	session: AgentSession | AgentTeam;
	sessionId: string;
	toolObserver: ToolObserverIpcClient | null;
	fatalSignal: AbortSignal | undefined;
	cleanup: () => Promise<void>;
}

/** Per-project data outside the workspace: ~/.mountains/projects/<hash of the real workspace path>. */
/** Project skills first, then the configured directories, then the user's own. */
function skillRoots(workspaceRoot: string, dirs: readonly string[], configPath: string | null): SkillRoot[] {
	const base = configPath ? dirname(resolve(configPath)) : process.cwd();
	return [
		...projectSkillRoots(workspaceRoot),
		...dirs.map(dir => ({ dir: resolve(base, expandHome(dir)), source: "user" as const })),
		{ dir: join(mountainsHome(), "skills"), source: "user" },
		{ dir: join(homedir(), ".agents", "skills"), source: "user" },
	];
}

function projectDir(workspaceRoot: string, home = mountainsHome()): string {
	const root = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);
	return join(resolve(home), "projects", createHash("sha256").update(root).digest("hex").slice(0, 16));
}

export function requireExternalStorage(path: string, workspace: string): string {
	const dest = resolve(path);
	if (new Workspace(workspace).contains(dest)) throw new Error("运行数据、检查点与原文档案必须存放在任务工作区之外");
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

export function eventSink(outDir: string, json: boolean, agent = ""): (e: EngineEvent) => void {
	const eventsPath = join(outDir, "events.jsonl");
	const who = agent ? `[${agent}] ` : "";
	return (e) => {
		if (e.type !== "message.delta" && e.type !== "tool.writing") appendFileSync(eventsPath, `${JSON.stringify(e)}\n`, { mode: 0o600 });
		if (json) return;
		// 人类可读的进度（stderr），不影响 stdout 的最终结果
		if (e.type === "tool.requested") process.stderr.write(`· ${who}${e.tool} ${typeof e.args === "string" ? e.args : JSON.stringify(e.args).slice(0, 160)}\n`);
		else if (e.type === "tool.completed") process.stderr.write(`  ${e.ok ? "✓" : "✗"} ${e.summary.slice(0, 160)} (${e.durationMs}ms)\n`);
		else if (e.type === "usage") process.stderr.write(`  [usage] 命中 ${e.usage.cacheRead ?? "?"} 未命中 ${e.usage.input ?? "?"} 输出 ${e.usage.output ?? "?"} ≈${e.cost?.toFixed(5) ?? "?"} ${e.currency}\n`);
		else if (e.type === "error") process.stderr.write(`! ${e.message}\n`);
	};
}

/** A run directory holds one run: a second run would append to its recording while replacing its summary. */
export function freshOutDir(outDir: string): void {
	const previous = ["recording.jsonl", "events.jsonl", "summary.json"].find((name) => existsSync(join(outDir, name)));
	if (previous) throw new Error(`输出目录 ${outDir} 已有上一次运行的记录（${previous}）；请换一个 --out 目录`);
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
}

/** A model as a picker shows it: name, window, currency and thinking tiers. */
export interface ModelView {
	displayName: string;
	contextWindow: number | null;
	currency: string;
	tiers: { id: string; label: string }[];
	thinking: "off" | "always" | "tiers";
	ultraCode: boolean;
	defaultEffort: string;
}

export function describeModel(model: string, billingCurrency?: MountainsConfig["billingCurrency"]): ModelView {
	const own = addedModel(model);
	if (own) return { displayName: own.displayName, contextWindow: own.contextWindow, currency: currencyOf(model, billingCurrency) ?? "USD", tiers: own.tiers as ModelView["tiers"], thinking: own.thinking, ultraCode: false, defaultEffort: addedEffort(own) } as ModelView;
	const caps = capabilitiesFor(model);
	const entry = loadCatalog().find((candidate) => candidate.id === model);
	const profile = reasoningProfile(entry ?? { id: model, provider: caps?.provider ?? "", canThink: (caps?.effortLevels.length ?? 0) > 0 || caps?.thinkingFormat === "always-on" });
	return {
		displayName: caps?.displayName ?? entry?.displayName ?? model,
		contextWindow: caps?.contextWindow ?? entry?.contextWindow ?? null,
		currency: currencyOf(model, billingCurrency) ?? "USD",
		tiers: [...profile.tiers],
		thinking: !profile.canThink ? "off" : profile.tiers.length ? "tiers" : "always",
		ultraCode: profile.ultraCode,
		defaultEffort: caps?.defaultEffort ?? "default",
	};
}

/** A model the user added in Desktop: where it is, and what they said it can do. */
export interface AddedModel {
	id: string;
	displayName: string;
	baseUrl: string;
	apiKeyEnv: string;
	contextWindow: number;
	thinking: "off" | "always" | "tiers";
	tiers: { id: string; label: string }[];
	/** Set on a custom address. Absent keeps the old guess: a claude id uses Anthropic, anything else uses OpenAI-compatible chat. */
	protocol?: "openai" | "anthropic";
}
export type ModelProtocol = NonNullable<AddedModel["protocol"]>;
let addedModels: readonly AddedModel[] = [];
const UNLIMITED_TOTAL = 1e9;
export function setAddedModels(models: readonly AddedModel[]): void { addedModels = models; }
const addedModel = (id: string | undefined) => addedModels.find((model) => model.id === id);

/** Which wire a run uses. A custom address can say. One that already ends in `/v1` is chat completions unless it says otherwise; a claude id elsewhere is Anthropic. */
export function modelWire(model: string): ModelProtocol {
	const own = addedModel(model);
	if (own?.protocol === "openai" || own?.protocol === "anthropic") return own.protocol;
	if (own?.baseUrl.replace(/\/+$/, "").endsWith("/v1")) return "openai";
	return providerOf(model) === "anthropic" ? "anthropic" : "openai";
}

/** A model the user added starts at 高, or at the tier nearest it. */
const addedEffort = (model: AddedModel) => model.tiers.find((tier) => tier.id === "high")?.id ?? model.tiers.at(-1)?.id ?? "default";

/** The config a model the user added needs; nothing for any other. */
export function addedConfig(model: string | undefined): Partial<MountainsConfig> {
	const added = addedModel(model);
	return added ? { baseUrl: added.baseUrl, apiKeyEnv: added.apiKeyEnv, contextWindow: added.contextWindow } : {};
}

/** Where a model the user can add may live; the keys of PROVIDERS. */
export { REASONING_TIERS };
export const PLATFORMS = (Object.values(PROVIDERS) as ProviderInfo[]).filter((provider) => provider.id !== "openai-compatible");
/** models.dev's names for those platforms. */
const CATALOG_PLATFORMS: Record<string, string> = { deepseek: "deepseek", zhipuai: "zhipu", "zhipuai-coding-plan": "zhipu", moonshotai: "moonshot", "moonshotai-cn": "moonshot", openai: "openai", google: "gemini", "alibaba-cn": "qwen", siliconflow: "siliconflow", "siliconflow-cn": "siliconflow", openrouter: "openrouter", xai: "xai", anthropic: "anthropic" };

/** What a model's name is recognized as, with the settings that come with it. */
export function modelPresets(query: string): { id: string; displayName: string; platform: string | null; contextWindow: number; maxOutput: number; thinking: AddedModel["thinking"]; tiers: { id: string; label: string }[]; priced: boolean }[] {
	const catalog = loadCatalog();
	const squeeze = (text: string) => text.toLowerCase().replace(/[\s._-]/g, "");
	const typed = query.trim().toLowerCase();
	// The search is loose on purpose; a preset is offered only for the name the user is really typing.
	// An id typed in full is that model, not the other spellings that share its display name.
	const matches = suggestModels(query).filter((match) => !match.keywordOnly && (squeeze(match.id).includes(squeeze(query)) || squeeze(match.displayName).includes(squeeze(query))));
	const exact = matches.filter((match) => match.id.toLowerCase() === typed);
	return (exact.length ? exact : matches).flatMap((match) => {
		const entry = catalog.find((candidate) => candidate.id === match.id && candidate.provider === match.provider) ?? catalog.find((candidate) => candidate.id === match.id);
		if (!entry) return [];
		const view = describeModel(entry.id);
		return [{ id: entry.id, displayName: entry.displayName, platform: capabilitiesFor(entry.id)?.provider ?? CATALOG_PLATFORMS[entry.provider] ?? null, contextWindow: entry.contextWindow, maxOutput: entry.maxOutputTokens, thinking: view.thinking, tiers: view.tiers, priced: entry.priced }];
	});
}

/** Models with hand-checked settings, and those the user added: the ones a picker offers. */
export function selectableModels(): { id: string; displayName: string }[] {
	const known = Object.values(CAPABILITIES).map((m) => ({ id: m.id, displayName: m.displayName }));
	return [...known, ...addedModels.filter((m) => !CAPABILITIES[m.id]).map((m) => ({ id: m.id, displayName: m.displayName }))];
}

/** The least thinking a model allows: off where it can be turned off, otherwise its lowest effort. */
export function lowestThinking(model: string): { enabled: boolean; effort: "default" | "low" } {
	const caps = capabilitiesFor(model);
	if (!caps || caps.thinkingFormat === "none" || caps.thinkingFormat === "deepseek") return { enabled: false, effort: "default" };
	return { enabled: true, effort: caps.provider !== "moonshot" && caps.effortLevels.includes("low") ? "low" : "default" };
}

/** Models whose protocol can review a tool call for 自动审批. */
const REVIEW_PROTOCOLS = new Set(["openai", "deepseek", "zhipu", "moonshot"]);
/** The models that can review this run's tool calls (approvalSettingsFor gives settings for them). */
export function reviewModels(run: MountainsConfig): { id: string; displayName: string }[] {
	return Object.values(CAPABILITIES).filter((m) => approvalSettingsFor(m.id, run)).map((m) => ({ id: m.id, displayName: m.displayName }));
}

/** Selectable thinking tiers for 自动审批 on `model`, and the label of its default-lowest setting. */
export function approvalEffortsFor(model: string): { defaultLabel: string; tiers: { id: string; label: string }[] } {
	const caps = capabilitiesFor(model);
	if (!caps || caps.thinkingFormat === "none") return { defaultLabel: "禁用思考", tiers: [] };
	if (caps.thinkingFormat === "always-on") return { defaultLabel: "始终思考", tiers: [] };
	const labels: Record<string, string> = { low: "低", high: "高", max: "最高" };
	const tiers = caps.effortLevels.map((id) => ({ id, label: labels[id] ?? id }));
	if (caps.thinkingFormat === "deepseek") return { defaultLabel: "禁用思考", tiers: [{ id: "off", label: "禁用思考" }, ...tiers] };
	const lowest = lowestThinking(model);
	return { defaultLabel: labels[lowest.effort] ?? "最低", tiers };
}

/**
 * Desktop's 自动审批 on `model` (defaulting to the least thinking when `effort` is omitted/null), within a quarter of
 * the run's budget, as raw modelApproval settings (loadConfig validates them). Null when that model cannot review.
 */
export function approvalSettingsFor(model: string, run: MountainsConfig, effort?: string | null): Record<string, unknown> | null {
	const caps = capabilitiesFor(model);
	if (!caps || !REVIEW_PROTOCOLS.has(caps.provider) || !Number.isFinite(run.limits.maxCost) || run.limits.maxCost <= 0) return null;
	const price = pricingFor(model, currencyOf(run.model, run.billingCurrency) ?? "USD");
	if (!price) return null;
	// The run's own model is reviewed through the run's address and key, relay included.
	const same = model === run.model, provider = PROVIDERS[caps.provider];
	const baseUrl = same ? run.baseUrl : provider.baseUrl, apiKeyEnv = same ? run.apiKeyEnv : provider.apiKeyEnv;
	if (!same && apiKeyEnv === run.apiKeyEnv && new URL(baseUrl).origin !== new URL(run.baseUrl).origin) return null;
	const thinking = !effort ? lowestThinking(model)
		: effort === "off" ? { enabled: false, effort: "default" as const }
		: { enabled: true, effort: effort as EffortSetting };
	const maxTokens = thinking.enabled ? Math.min(caps.maxOutputTokens, thinking.effort === "max" ? 8192 : thinking.effort === "high" ? 4096 : 2048) : 512;
	const timeoutMs = thinking.enabled ? (thinking.effort === "max" || thinking.effort === "high" ? 45_000 : 25_000) : 15_000;
	const settings = {
		model, profile: caps.provider, baseUrl, apiKeyEnv, thinking, maxTokens, timeoutMs, maxInputChars: 32_000, maxRequests: 20, maxCost: run.limits.maxCost / 4,
		pricing: { currency: price.currency, inputPerMillion: Math.max(price.peak.cacheMiss, price.peak.cacheWrite ?? 0), outputPerMillion: price.peak.output, cacheReadPerMillion: price.peak.cacheHit, version: `${price.version}/peak-upper-bound` },
	};
	// Some protocols need more than this to turn thinking off; such a model is not offered rather than half set up.
	try { validateApprovalSettings(settings, price.currency); } catch { return null; }
	return settings;
}

/** One line so the model knows which computer it is on. Static for the process, so the prompt prefix stays cacheable. */
const MACHINE_NOTE = process.platform === "win32"
	? `This computer is Windows (${process.arch}). command_run is PowerShell; do not use bash.`
	: process.platform === "darwin"
		? `This computer is macOS (${process.arch}). command_run is a Unix shell; do not use PowerShell.`
		: `This computer is ${process.platform} (${process.arch}).`;

/** Desktop's default-folder rule: ~/Mountains (or the chosen folder) for relative paths, full computer access when needed. */
export const DESKTOP_WORKSPACE_NOTES = `${MACHINE_NOTE}
# Workspace and Computer Paths
Relative paths resolve from this conversation's workspace folder (shown in the repository brief; ~/Mountains by default). When the user's request involves files or folders elsewhere on this computer, file_read, file_edit, file_write, query_plan (search path, glob, read, outline, json_field) and command_run (cwd) also accept ~/... or absolute paths directly.

# Asking the user
When a choice belongs to the user and you cannot look it up, call ask_user with one question and 2 to 4 choices. Wait for the answer. Do not invent what they would pick.
When they ask you to remember a rule for later conversations, call update_agents with the full new AGENTS.md. It does nothing until they approve.`;

/** How to write SIUI (Super Intelligent UI): only in Desktop, only when it is on. The page draws it; see Mountains-SIUI-语法-v2-2026-10-30.md. */
export const SIUI_NOTES = `# Super Intelligent UI (SIUI)
SIUI (Super Intelligent UI) is Mountains' built-in interactive UI: it lets you draw live UI directly in replies (stats, charts, calculators, interactive tools, small games; users can also open them full-screen).
Replies render Markdown and LaTeX. Nothing to import: short HTML tags at the start of a line draw live UI. No scripts, no CSS files.
Use it unasked whenever the reader gets more from seeing or changing something than from reading about it:
- numbers they would try other values for (cost, loan, split, trade-off): sliders and a computed stat
- choices to weigh: a grid of cards with verdicts in color
- one key result: big, then the reasoning in prose
- a process or plan: steps
- figures: chart
- a decision only they can make: buttons that draft their reply
- a tool or small game they asked for: controls, <var> and buttons, or <scene> if it moves by itself. Never a full HTML page or a file: nothing but SIUI runs here.
Otherwise plain prose. Never decorate.
Tags: <big> <stat label=> <note type=info|warn|success|error> <progress value=0..1 label=> <steps><step status=done|now> <row> <grid cols=> <card title=> <tabs><tab name=> <chart type=bar|line|pie title=> with \`label: value\` lines. div p span h1-h3 ul li table work too.
Controls hold a variable: <slider name= min= max= value= step= unit= label=> <input name= value= label=> <toggle name= value=on label=> (true or false) <select name= options="a|b" value= label=>. <var name= value=> is hidden state; a formula as value stays computed.
<scene w= h= every=ms set="per step" run="cond" press="on space or click" bg=><box x= y= w= h= color= round= text= size= ink= if="cond"><key code=left|right|up|down|a-z set=></scene> is a game field, coordinates in w and h. Expressions only, no loops: one <var> per moving thing.
<button send="text">Label</button> puts text in the user's input box; set="x = x+1; y = rand(1,6)" changes variables; reset restores defaults.
{EXPR} in tag text and attributes, not Markdown, is computed: + - * / % **, comparisons, a ? b : c, round(x,d) fixed(x,d) pct(x,d) min max abs floor ceil sqrt. No other syntax, no {if}.
class= green red yellow blue purple muted big huge giant small bold mono. style= takes plain CSS for color, size, spacing, borders, flex, grid.
<slider name=price min=100 max=1000 value=300 unit=k label=Price>
<stat label=Monthly class="green huge">{fixed(price*7.5,0)}</stat>`;

const TITLE_PROMPT = "Write a title for this conversation: at most 8 words, or 16 characters in Chinese or Japanese, in the conversation's language. Reply with the title only, no quotes or punctuation at the end.";

/**
 * Desktop's conversation titles: a few words for what the conversation is about, by `model` with the least
 * thinking. The run's own model goes through the run's address and key; another through its provider's.
 */
/** The environment variable holding the key a side request on `model` would use. */
export function keyEnvFor(model: string, run: MountainsConfig): string | null {
	const own = addedModel(model);
	if (own) return own.apiKeyEnv;
	if (model === run.model) return run.apiKeyEnv;
	const caps = capabilitiesFor(model);
	return caps ? PROVIDERS[caps.provider].apiKeyEnv : null;
}

export async function summarizeTitle(model: string, run: MountainsConfig, conversation: string, transport?: { fetch?: typeof globalThis.fetch; signal?: AbortSignal }): Promise<{ title: string; cost: number | null; currency: string }> {
	const caps = capabilitiesFor(model), same = model === run.model;
	const provider = caps ? PROVIDERS[caps.provider] : null;
	const baseUrl = same ? run.baseUrl : provider?.baseUrl, apiKeyEnv = same ? run.apiKeyEnv : provider?.apiKeyEnv;
	const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
	if (!baseUrl || !apiKey) throw new Error(`${model} has no key`);
	const adapter = new ChatCompletionsAdapter({ baseUrl, apiKey, timeoutMs: 20_000, ...(caps ? { provider: caps.provider } : {}), ...(transport?.fetch ? { fetch: transport.fetch } : {}) });
	const response = await adapter.complete({ model, system: TITLE_PROMPT, tools: [], messages: [{ role: "user", content: conversation.slice(0, 4000) }], thinking: lowestThinking(model), maxTokens: 64, ...(transport?.signal ? { signal: transport.signal } : {}) });
	if (!response.ok) throw new Error(`the title request failed (${response.httpStatus ?? "no answer"})`);
	const currency = currencyOf(run.model, run.billingCurrency) ?? "USD";
	const title = response.message.content.replace(/\s+/g, " ").trim().replace(/^["'“「《]+|["'”」》。.!！]+$/g, "").slice(0, 40);
	return { title, cost: estimateCost(model, response.rawUsage, new Date(), currency)?.amount ?? null, currency };
}

/** A shorter AGENTS.md, written by the same model the desktop is using. */
export async function summarizeAgents(model: string, run: MountainsConfig, text: string, transport?: { fetch?: typeof globalThis.fetch; signal?: AbortSignal }): Promise<string> {
	const caps = capabilitiesFor(model), same = model === run.model;
	const provider = caps ? PROVIDERS[caps.provider] : null;
	const baseUrl = same ? run.baseUrl : provider?.baseUrl, apiKeyEnv = same ? run.apiKeyEnv : provider?.apiKeyEnv;
	const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
	if (!baseUrl || !apiKey) throw new Error(`${model} has no key`);
	const adapter = new ChatCompletionsAdapter({ baseUrl, apiKey, timeoutMs: 60_000, ...(caps ? { provider: caps.provider } : {}), ...(transport?.fetch ? { fetch: transport.fetch } : {}) });
	const response = await adapter.complete({
		model, tools: [], thinking: lowestThinking(model), maxTokens: 2000,
		system: "Compress this AGENTS.md to the rules that still matter. Keep the user's own wording where you can. Stay under 4000 characters. Return only the new file.",
		messages: [{ role: "user", content: text.slice(0, 80_000) }],
		...(transport?.signal ? { signal: transport.signal } : {}),
	});
	if (!response.ok) throw new Error(`the summary request failed (${response.httpStatus ?? "no answer"})`);
	const next = response.message.content.trim();
	if (!next) throw new Error("the summary was empty");
	return next.slice(0, 16_000);
}

/** Keep the start of AGENTS.md, about a sixth of the context window, so a chat can still begin. */
export function clippedAgents(text: string, contextWindow: number): string {
	const budget = Math.max(2000, Math.floor(contextWindow / 3));
	if (text.length <= budget) return text;
	return text.slice(0, budget).trimEnd();
}

/** What a run with these settings would use, without starting one: for a desktop shell's model and spend display. */
/** The skills a user can call with /name in this workspace, for the desktop's slash menu; none while skills are off. */
export function userSkills(workspace: string, configPath: string | undefined): { name: string; description: string; source: "builtin" | "user" | "project" }[] {
	const loaded = loadConfig(configPath ? resolve(configPath) : null, {});
	if (!loaded.config.skills.enabled) return [];
	const { skills } = discoverSkills(skillRoots(workspace, loaded.config.skills.dirs, loaded.source));
	return skills.filter((skill) => skill.userInvocable).map(({ name, description, source }) => ({ name, description, source }));
}

/** The thinking setting a model with no tiers needs in place of the config's, which may name one it refuses. */
export function fixedThinking(model: string | undefined): Pick<MountainsConfig, "thinking"> | object {
	const own = addedModel(model);
	if (own) return { thinking: { enabled: own.thinking !== "off", effort: addedEffort(own) as "default" } };
	const caps = model ? capabilitiesFor(model) : undefined;
	if (!caps || caps.effortLevels.length) return {};
	return { thinking: { enabled: caps.thinkingFormat !== "none", effort: "default" as const } };
}

export function previewRun(configPath: string | undefined, overrides: Partial<MountainsConfig> = {}, spendLedgerArg?: string): { config: MountainsConfig; spendLedger: string } {
	const loaded = loadConfig(configPath ? resolve(configPath) : null, { ...fixedThinking(overrides.model), ...addedConfig(overrides.model), ...overrides });
	const spendLedger = resolve(expandHome(spendLedgerArg ?? (loaded.spendLedgerExplicit ? loaded.config.spendLedger : join(mountainsHome(), "spend.jsonl"))));
	return { config: loaded.config, spendLedger };
}

export async function prepareRun(values: RunValues, usage: (msg?: string) => never, hooks?: RunHooks): Promise<PreparedRun> {
	if (!values.workspace) usage("缺少 --workspace");
	if (!values.task === !values["task-file"]) usage("--task 与 --task-file 必须且只能给一个");
	const workspaceArg = values.workspace;
	if (!workspaceArg) usage("缺少 --workspace");
	// Validate the inherited channel before config/skills can start work. Ordinary runs stay unchanged.
	const toolObserver = values["tool-observer-ipc"] ? new ToolObserverIpcClient() : null;
	const task = values.task ?? readFileSync(values["task-file"] as string, "utf8");
	const baseOverrides = values["base-url"] ? { baseUrl: values["base-url"] } : {};
	const loaded = loadConfig(values.config ? resolve(values.config) : null, hooks?.configOverrides ? { ...baseOverrides, ...hooks.configOverrides } : baseOverrides);
	const cfg = loaded.config;
	if (toolObserver && !cfg.requestGuard) throw new Error("工具执行控制器需要 requestGuard，必须先预留并结算模型费用");
	const spendLedger = resolve(expandHome(values["spend-ledger"] ?? (loaded.spendLedgerExplicit ? cfg.spendLedger : join(mountainsHome(), "spend.jsonl"))));
	const legacyLedger = resolve(expandHome(DEFAULT_CONFIG.spendLedger));
	if (values["spend-ledger"] === undefined && !loaded.spendLedgerExplicit && spendLedger !== legacyLedger
		&& !existsSync(spendLedger) && existsSync(legacyLedger)) {
		throw new Error(`检测到旧累计花费台账：${legacyLedger}。请先将其迁移到 ${spendLedger}，或用 --spend-ledger 显式指定原路径；为避免重置累计预算，本次未发出请求。`);
	}
	const runId = values["run-id"] ?? `run_${randomUUID().slice(0, 12)}`;
	const outDir = requireExternalStorage(values.out ?? join(mountainsHome(), "runs", runId), resolve(workspaceArg));
	freshOutDir(outDir);

	let apiKey = process.env[cfg.apiKeyEnv];
	if (!apiKey) {
		if (isLoopback(cfg.baseUrl)) apiKey = "proxy-injected";
		else usage(`环境变量 ${cfg.apiKeyEnv} 未设置（Key 只从环境变量读取）`);
	}
	const provider = providerOf(cfg.model);
	const own = addedModel(cfg.model);
	const wire = modelWire(cfg.model);
	const adapter = wire === "anthropic"
		? new AnthropicMessagesAdapter({ baseUrl: cfg.baseUrl, apiKey, ...(hooks?.fetch ? { fetch: hooks.fetch } : {}) })
		: new ChatCompletionsAdapter({ baseUrl: cfg.baseUrl, apiKey, ...(own?.protocol === "openai" ? { provider: "openai-compatible" as const } : provider ? { provider } : {}), ...(own?.tiers.length ? { namedEffort: true } : {}), ...(hooks?.fetch ? { fetch: hooks.fetch } : {}) });
	let modelApproval: EngineOptions["modelApproval"];
	if (cfg.modelApproval) {
		const settings = cfg.modelApproval;
		let approvalKey = process.env[settings.apiKeyEnv];
		if (!approvalKey) {
			if (isLoopback(settings.baseUrl)) approvalKey = "proxy-injected";
			else usage(`审批模型环境变量 ${settings.apiKeyEnv} 未设置（不会复用主模型 Key）`);
		}
		modelApproval = { settings, ...(hooks?.askApproval ? { manualFallback: true } : {}), adapter: new ApprovalChatAdapter({
			baseUrl: settings.baseUrl, apiKey: approvalKey, profile: settings.profile, timeoutMs: settings.timeoutMs,
			// The same transport as the run's own model, so a host that supplies one (Desktop's tests) sees every request.
			...(hooks?.fetch ? { fetch: hooks.fetch } : {}),
			...(settings.supportedEfforts ? { supportedEfforts: settings.supportedEfforts } : {}),
			...(settings.effortMapping ? { effortMapping: settings.effortMapping } : {}),
			...(settings.maxTokensField ? { maxTokensField: settings.maxTokensField } : {}),
			...(settings.disabledReasoningEffort ? { disabledReasoningEffort: settings.disabledReasoningEffort } : {}),
		}) };
	}
	// UltraCode: the lead picks each agent's model and effort. Offered: models billed in the run's currency
	// (one budget) whose key is at hand; the team's own model first, on its own adapter and base URL.
	const runCurrency = currencyOf(cfg.model, cfg.billingCurrency);
	const team = cfg.thinking.effort === "ultracode" || hooks?.team !== undefined;
	const teamModels = !team ? [] : [cfg.model, ...Object.values(CAPABILITIES)
		.filter((m) => m.id !== cfg.model && currencyOf(m.id, cfg.billingCurrency) === runCurrency && PROVIDERS[m.provider].baseUrl && process.env[PROVIDERS[m.provider].apiKeyEnv])
		.map((m) => m.id)];
	const adapters = new Map<string, ModelAdapter>([[cfg.model, adapter]]);
	const adapterFor = (model: string): ModelAdapter => {
		let made = adapters.get(model);
		if (!made) {
			const info = PROVIDERS[capabilitiesFor(model)!.provider];
			made = new ChatCompletionsAdapter({ baseUrl: info.baseUrl, apiKey: process.env[info.apiKeyEnv]!, provider: info.id, ...(hooks?.fetch ? { fetch: hooks.fetch } : {}) });
			adapters.set(model, made);
		}
		return made;
	};
	const userId = cfg.userIdMode === "per-run" ? `mtn-${runId}` : cfg.userIdMode === "fixed" ? cfg.userIdFixed : undefined;
	const budget = BudgetGuard.fromEnv(spendLedger, currencyOf(cfg.model, cfg.billingCurrency) ?? "USD", hooks?.noTotalBudget && !process.env.MOUNTAINS_BUDGET ? { MOUNTAINS_BUDGET: String(UNLIMITED_TOTAL) } : process.env);
	const workspace = resolve(workspaceArg);
	const ws = new Workspace(workspace);
	const instructions = readInstructions(workspace, mountainsHome());
	await toolObserver?.start({ pid: process.pid, runId, workspace, outDir, spendLedger, task, model: cfg.model, effectiveConfigSha256: observerHash(cfg) });
	// Computer use is agreed to once for the whole conversation, whichever agent asks first.
	const computerConsent = { granted: false };
	const builtinResources: BuiltinSkill[] = [];
	const computerSkill = (agent: { name: string }) => {
		const skill = computerUseSkill({ apps: cfg.computerUse.apps, secrets: new KeychainSecrets(mountainsHome()), historyDir: join(mountainsHome(), "computer-history"), ...(cfg.computerUse.grounding ? { grounding: cfg.computerUse.grounding } : {}), ...(cfg.computerUse.cursorColor ? { cursorColor: cfg.computerUse.cursorColor } : {}), ...(cfg.computerUse.web ? { web: cfg.computerUse.web } : {}), consent: computerConsent, excludePids: [process.pid],
			...(team ? { cursorLabel: agent.name } : {}),
			imageInput: cfg.computerUse.screenshots && (capabilitiesFor(cfg.model)?.inputModalities.includes("image") ?? false) });
		builtinResources.push(skill);
		return skill;
	};
	// UltraCode: every agent gets the same model, limits and skills (its own computer-use cursor included); the others keep their records under agents/.
	const options = (agent: { name: string; role: string; model?: string; effort?: string } = { name: "lead", role: "lead" }): EngineOptions => {
		const model = agent.model ?? cfg.model;
		// Another model without a chosen effort thinks at its highest, as UltraCode does for the lead; the same model keeps the lead's, and its cache.
		const thinking: { enabled: boolean; effort: EffortSetting } = agent.effort ? { enabled: true, effort: agent.effort as EffortSetting }
			: model !== cfg.model ? { enabled: true, effort: capabilitiesFor(model)?.effortLevels.at(-1) ?? "default" } : engineThinking(cfg);
		const lead = agent.role === "lead";
		const dataDir = lead ? outDir : join(outDir, "agents", agent.name);
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		const sink = eventSink(dataDir, values.json ?? false, lead ? "" : agent.name);
		const extraNotes = [
			...(hooks?.allowOutside ? [DESKTOP_WORKSPACE_NOTES] : []),
			...((lead || team) && hooks?.siui ? [SIUI_NOTES] : []),
			...(instructions ? [instructions] : []),
		];
		return {
			workspace,
			...(hooks?.allowOutside ? { allowOutsideWorkspace: true } : {}),
			...(hooks?.lenientApproval ? { lenientApproval: true } : {}),
			dataDir,
			adapter: adapterFor(model),
			model,
			...(cfg.billingCurrency !== undefined ? { billingCurrency: cfg.billingCurrency } : {}),
			...((isLoopback(cfg.baseUrl) || addedModel(cfg.model)) && !pricingFor(cfg.model, cfg.billingCurrency) ? { localModel: true } : {}),
			thinking,
			maxTokens: model === cfg.model ? cfg.maxTokens : Math.min(cfg.maxTokens, capabilitiesFor(model)?.maxOutputTokens ?? cfg.maxTokens),
			limits: cfg.limits,
			retry: cfg.retry,
			...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
			verbatimToolArguments: cfg.verbatimToolArguments,
			...(userId ? { userId } : {}),
			...(loaded.systemPrompt !== null ? { systemPrompt: loaded.systemPrompt } : {}),
			// The lead's replies are what the page draws; Desktop notes and SIUI come before AGENTS.md, which stays last.
			...(extraNotes.length ? { instructions: extraNotes.join("\n\n") } : {}),
			...(cfg.memory || ((lead || team) && hooks?.tools?.length) ? { extraTools: [...(lead || team ? hooks?.tools ?? [] : []), ...(cfg.memory ? [createMemorySearchTool({
				roots: [join(mountainsHome(), "runs"), join(mountainsHome(), "desktop")],
				// A desktop conversation keeps its events beside its run folder: leave both out.
				exclude: [outDir, ...(/^run(-\d+)?$/.test(basename(outDir)) ? [dirname(outDir)] : []), ...(hooks?.memoryExclude ?? [])],
			})] : [])] } : {}),
			approval: cfg.approval,
			requestGuard: cfg.requestGuard,
			...(hooks?.allowPartialUsage ? { allowPartialUsage: true } : {}),
			...(modelApproval ? { modelApproval } : {}),
			budget,
			...(toolObserver ? { toolObserver: toolObserver.forAgent({ name: agent.name, role: agent.role, dataDir }) } : {}),
			...(toolObserver ? { onModelLedger: witness => toolObserver.noteModelLedger({ name: agent.name, role: agent.role, dataDir }, witness) } : {}),
			...(lead && hooks?.sessionId && cfg.thinking.effort !== "ultracode" ? { sessionId: hooks.sessionId, allowSessionSnapshots: true } : {}),
			...(lead && hooks?.interjections ? { allowInterjection: true } : {}),
			...(lead ? {
				runId,
				checkpoints: cfg.checkpoints,
				archiveDir: requireExternalStorage(join(projectDir(ws.root), "blobs"), ws.root),
			} : { checkpoints: false }),
			toolOptions: { read: cfg.tools.read, batchEdit: cfg.tools.batchEdit, editFeedback: cfg.tools.editFeedback, ...(hooks?.approveFileWrites ? { approveFileWrites: true } : {}) },
			...(cfg.skills.enabled ? { skills: { roots: skillRoots(ws.root, cfg.skills.dirs, loaded.source), enable: cfg.skills.enable, permissions: cfg.skills.permissions,
				builtin: hooks?.noComputerUse ? [] : [computerSkill(agent)] } } : {}),
			onEvent: hooks?.onEvent ? (event) => { sink(event); hooks.onEvent!(lead ? event : { ...event, agent: agent.name }); } : sink,
			...(hooks?.askApproval ? { askApproval: hooks.askApproval } : {}),
		};
	};
	const session = team ? new AgentTeam({ makeOptions: options, maxCost: cfg.limits.maxCost, ...(hooks?.team ? { maxAgents: hooks.team.maxAgents ?? Infinity, maxGroupSize: Infinity } : {}), choices: teamModels.map((id) => ({ id, efforts: [...(capabilitiesFor(id)?.effortLevels ?? [])] })) }) : new AgentSession(options());
	writeFileSync(join(outDir, "config.json"), `${JSON.stringify({ source: loaded.source, sha256: loaded.sha256, config: cfg }, null, 2)}\n`, { mode: 0o600 });
	return {
		task,
		model: cfg.model,
		outDir,
		json: values.json ?? false,
		configSha256: loaded.sha256,
		approvalRuleIds: cfg.approval.rules.map((rule) => rule.id),
		budget,
		session,
		sessionId: session instanceof AgentTeam ? session.session.sessionId : session.sessionId,
		toolObserver,
		fatalSignal: toolObserver?.fatalSignal,
		cleanup: async () => { await disposeBuiltinSkills(builtinResources); },
	};
}

export type { RunSummary };
