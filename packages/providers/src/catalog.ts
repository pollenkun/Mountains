/**
 * models.dev 快照映射成 Mountains 的模型条目。
 * 手写的 8 个模型（capabilities.ts）编号相同时以手写为准。
 * 每天把合并结果写到 ~/.mountains/catalog.json；测试传入别的目录。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, type ModelCapabilities } from "./capabilities.ts";

export interface SnapshotModel {
	name: string;
	reasoning: boolean;
	context: number;
	output: number;
	input: string[];
	interleaved: boolean;
	cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
}

export interface SnapshotFile {
	source: string;
	license: string;
	fetchedAt: string;
	providers: Record<string, { name: string; models: Record<string, SnapshotModel> }>;
}

export interface CatalogEntry {
	provider: string;
	id: string;
	displayName: string;
	contextWindow: number;
	maxOutputTokens: number;
	inputModalities: readonly ("text" | "image")[];
	requiresReasoningPassback: boolean;
	canThink: boolean;
	priced: boolean;
	handwritten: boolean;
	costUsd?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** Source checkout keeps the files beside src/. A bundle keeps copies in dist/catalog/. */
function catalogFile(name: string): string {
	const source = fileURLToPath(new URL(`../catalog/${name}`, import.meta.url));
	return existsSync(source) ? source : fileURLToPath(new URL(`./catalog/${name}`, import.meta.url));
}

const SNAPSHOT_URL = catalogFile("models.dev.snapshot.json");

export function readSnapshot(text?: string): SnapshotFile {
	return JSON.parse(text ?? readFileSync(SNAPSHOT_URL, "utf8")) as SnapshotFile;
}

export function mapSnapshot(snapshot: SnapshotFile): CatalogEntry[] {
	const out: CatalogEntry[] = [];
	for (const [provider, block] of Object.entries(snapshot.providers)) {
		for (const [id, model] of Object.entries(block.models)) {
			const modalities = model.input.filter((item): item is "text" | "image" => item === "text" || item === "image");
			const entry: CatalogEntry = {
				provider,
				id,
				displayName: model.name,
				contextWindow: model.context,
				maxOutputTokens: model.output,
				inputModalities: modalities.length ? modalities : ["text"],
				requiresReasoningPassback: model.interleaved,
				canThink: model.reasoning,
				priced: model.cost !== undefined,
				handwritten: false,
			};
			if (model.cost) {
				entry.costUsd = {
					input: model.cost.input,
					output: model.cost.output,
					...(model.cost.cache_read !== undefined ? { cacheRead: model.cost.cache_read } : {}),
					...(model.cost.cache_write !== undefined ? { cacheWrite: model.cost.cache_write } : {}),
				};
			}
			out.push(entry);
		}
	}
	return out;
}

/** 同一编号只留一条。手写表覆盖快照里的名字、窗口、模态和是否回传思考。 */
export function applyHandwritten(entries: readonly CatalogEntry[], handwritten: Readonly<Record<string, ModelCapabilities>> = CAPABILITIES): CatalogEntry[] {
	const byId = new Map<string, CatalogEntry>();
	for (const entry of entries) {
		if (!byId.has(entry.id)) byId.set(entry.id, entry);
	}
	for (const cap of Object.values(handwritten)) {
		byId.set(cap.id, {
			provider: cap.provider,
			id: cap.id,
			displayName: cap.displayName,
			contextWindow: cap.contextWindow,
			maxOutputTokens: cap.maxOutputTokens,
			inputModalities: [...cap.inputModalities],
			requiresReasoningPassback: cap.requiresReasoningPassback,
			canThink: cap.thinkingFormat !== "none",
			priced: true,
			handwritten: true,
		});
	}
	return [...byId.values()];
}

export function loadCatalog(): CatalogEntry[] {
	return applyHandwritten(mapSnapshot(readSnapshot()));
}

let unbilledIds: Set<string> | undefined;

/** 快照里没有标价、又不是手写价目表里的模型。未知编号返回 false，仍然按原规则停下来。 */
export function isUnbilledCatalogModel(id: string): boolean {
	if (!unbilledIds) unbilledIds = new Set(loadCatalog().filter(entry => !entry.handwritten && !entry.priced).map(entry => entry.id));
	return unbilledIds.has(id);
}

export function billingLabel(id: string): "未计费" | null {
	return isUnbilledCatalogModel(id) ? "未计费" : null;
}

interface ZhNames {
	vendors: { vendorZh: string; modelsDevProviders: string[]; keywords: string[] }[];
	wrongIds: Record<string, string>;
	notInModelsDev: Record<string, unknown>;
}

const NAMES_URL = catalogFile("zh-names.json");
let zhNames: ZhNames | undefined;

function namesFile(): ZhNames {
	if (!zhNames) zhNames = JSON.parse(readFileSync(NAMES_URL, "utf8")) as ZhNames;
	return zhNames;
}

function normalizeQuery(text: string): string {
	return text.toLowerCase()
		.replace(/[_/]+/g, " ")
		.replace(/([a-z\u4e00-\u9fff])(\d)/g, "$1 $2")
		.replace(/(\d)([a-z\u4e00-\u9fff])/g, "$1 $2")
		.replace(/[^a-z0-9.\u4e00-\u9fff]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export interface ModelSuggestion {
	id: string;
	provider: string;
	displayName: string;
	keywordOnly: boolean;
}

const KEYWORD_ONLY = [
	{ id: "ernie-5.1", provider: "baidu", displayName: "百度文心", words: "文心 百度 ernie baidu" },
	{ id: "spark-x2", provider: "iflytek", displayName: "讯飞星火", words: "星火 讯飞 spark iflytek" },
] as const;

/** 最多 3 条。wrongIds 不出现。文心和星火只在关键词命中时出现，不能拿来调用。 */
export function suggestModels(query: string, entries: readonly CatalogEntry[] = loadCatalog(), limit = 3): ModelSuggestion[] {
	const words = normalizeQuery(query).split(" ").filter(Boolean);
	if (!words.length || limit < 1) return [];
	const zh = namesFile();
	const typed = query.trim().toLowerCase();
	// A loose match only checks that each word occurs, so "5" counts twice and hundreds of Opus models tie.
	// Alphabetical order then fills the three slots, and the id the user actually typed never appears.
	const squeeze = (text: string) => text.toLowerCase().replace(/[\s._-]/g, "");
	const squeezedQuery = squeeze(typed);
	const idLike = /[-/]/.test(typed);
	const scored: { suggestion: ModelSuggestion; score: number }[] = [];
	for (const entry of entries) {
		if (zh.wrongIds[`${entry.provider}/${entry.id}`]) continue;
		const vendor = zh.vendors.find(item => item.modelsDevProviders.includes(entry.provider));
		const hay = normalizeQuery([entry.id, entry.displayName, entry.provider, vendor?.vendorZh ?? "", ...(vendor?.keywords ?? [])].join(" "));
		let hits = 0;
		for (const word of words) if (hay.includes(word)) hits += 1;
		if (!hits) continue;
		let score = hits;
		if (hits === words.length) score += 5;
		if (entry.handwritten) score += 1;
		if (entry.id.toLowerCase() === typed) score += 80;
		else if (idLike && squeezedQuery.length >= 4 && squeeze(entry.id) === squeezedQuery) score += 40;
		scored.push({ score, suggestion: { id: entry.id, provider: entry.provider, displayName: entry.displayName, keywordOnly: false } });
	}
	for (const extra of KEYWORD_ONLY) {
		const hay = normalizeQuery(extra.words);
		let hits = 0;
		for (const word of words) if (hay.includes(word)) hits += 1;
		if (!hits) continue;
		scored.push({ score: hits, suggestion: { id: extra.id, provider: extra.provider, displayName: extra.displayName, keywordOnly: true } });
	}
	scored.sort((a, b) => b.score - a.score || a.suggestion.id.localeCompare(b.suggestion.id));
	const seen = new Set<string>();
	const out: ModelSuggestion[] = [];
	for (const row of scored) {
		if (seen.has(row.suggestion.id)) continue;
		seen.add(row.suggestion.id);
		out.push(row.suggestion);
		if (out.length === limit) break;
	}
	return out;
}

export function catalogFilePath(home = join(homedir(), ".mountains")): string {
	return join(home, "catalog.json");
}

export function catalogIsStale(path: string, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000): boolean {
	try {
		return now - statSync(path).mtimeMs >= maxAgeMs;
	} catch {
		return true;
	}
}

export type ReasoningTierId = "off" | "on" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ReasoningTier {
	id: ReasoningTierId;
	label: string;
}

export interface ReasoningProfile {
	canThink: boolean;
	/** effort：目录给出的档位。toggle：只有开关。budget：用 token 预算分成五档。always：一律思考。off：不能思考。 */
	mode: "off" | "always" | "effort" | "toggle" | "budget";
	tiers: readonly ReasoningTier[];
	/** 最高档再加多智能体。模型不能思考时不提供。 */
	ultraCode: boolean;
}

const TIER_BY_EFFORT: Readonly<Record<string, ReasoningTier>> = {
	low: { id: "low", label: "轻度" },
	medium: { id: "medium", label: "均衡" },
	high: { id: "high", label: "高" },
	xhigh: { id: "xhigh", label: "超高" },
	max: { id: "max", label: "Max" },
};

/** Every tier, mildest first: what a model the user added gets when they say it can think. */
export const REASONING_TIERS: readonly ReasoningTier[] = Object.values(TIER_BY_EFFORT);

/** models.dev 只写了会不会思考。这几条档位来自 2026-10-24 的目录任务，不是新编的价格。 */
const EFFORT_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
	"kimi-k3": ["low", "high", "max"],
	"kimi-k3.1-pro": ["low", "high", "max"],
	"kimi-k3.1-pro-highspeed": ["low", "high", "max"],
};

const TOGGLE_IDS = new Set(["kimi-k2.6"]);

const BUDGET_TIERS: readonly ReasoningTier[] = [
	TIER_BY_EFFORT.low!, TIER_BY_EFFORT.medium!, TIER_BY_EFFORT.high!, TIER_BY_EFFORT.xhigh!, TIER_BY_EFFORT.max!,
];

export function reasoningProfile(entry: Pick<CatalogEntry, "id" | "provider" | "canThink">): ReasoningProfile {
	if (!entry.canThink) return { canThink: false, mode: "off", tiers: [], ultraCode: false };
	const handwritten = CAPABILITIES[entry.id];
	if (handwritten) {
		if (handwritten.thinkingFormat === "always-on" || handwritten.effortLevels.length === 0) {
			return { canThink: true, mode: "always", tiers: [], ultraCode: true };
		}
		return {
			canThink: true,
			mode: "effort",
			tiers: handwritten.effortLevels.map(level => TIER_BY_EFFORT[level] ?? { id: "high", label: level }),
			ultraCode: true,
		};
	}
	if (TOGGLE_IDS.has(entry.id)) {
		return { canThink: true, mode: "toggle", tiers: [{ id: "off", label: "关闭" }, { id: "on", label: "开启" }], ultraCode: true };
	}
	const efforts = EFFORT_OVERRIDES[entry.id];
	if (efforts) {
		return { canThink: true, mode: "effort", tiers: efforts.map(level => TIER_BY_EFFORT[level]!), ultraCode: true };
	}
	if (entry.id.startsWith("claude-") || entry.provider === "anthropic" || entry.provider.endsWith("-anthropic")) {
		return { canThink: true, mode: "budget", tiers: BUDGET_TIERS, ultraCode: true };
	}
	return { canThink: true, mode: "always", tiers: [], ultraCode: true };
}

export function writeCatalogFile(dest: string, entries: readonly CatalogEntry[] = loadCatalog(), at = new Date()): void {
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, `${JSON.stringify({ refreshedAt: at.toISOString(), models: entries })}\n`);
}
