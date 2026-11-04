/**
 * Read-only facts the page shows around the conversation (model, context window, thinking tiers, spend, balance),
 * and the model/effort choice. This is the desktop shell's own channel: engine commands and events stay on the protocol.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { addedConfig, approvalEffortsFor, approvalSettingsFor, clippedAgents, describeModel, keyEnvFor, modelPresets, modelWire, PLATFORMS, previewRun, REASONING_TIERS, reviewModels, selectableModels, setAddedModels, summarizeAgents, userSkills, type AddedModel, type ModelProtocol } from "@mountains/cli/run-session";
import { defaultWorkspace, type ApprovalMode, type HostOptions } from "./engine-host.ts";
import { checkedTheme, savedThemes, saveTheme } from "./appearance.ts";
import { isGitRepo, matchFiles, savePasted, workspaceFiles } from "./files.ts";
import type { Desk } from "./desk.ts";
import { spentToday } from "./spend.ts";
import { deleteKey, hasKey, loadKey, mask, saveKey } from "./keys.ts";
import { agentsWriteAllowed, globalAgentsPath, readGlobalAgents, webChoice, writeGlobalAgents, type Settings } from "./settings.ts";
import { fetchModelIds } from "./remote-models.ts";
import { ownSearch, SEARCH_SERVICES, webRun } from "./web.ts";
import { installSkillSources } from "@mountains/tools";

export const SHELL_CHANNEL = "mountains:shell";

import { APP_LABEL } from "./version.ts";
import type { Updates } from "./updates.ts";

export interface ShellInfo {
	model: string;
	displayName: string;
	contextWindow: number | null;
	currency: string;
	/** The model's thinking tiers, mildest first; empty when it always or never thinks. */
	tiers: { id: string; label: string }[];
	thinking: "off" | "always" | "tiers";
	ultraCode: boolean;
	effort: string;
	defaultEffort: string;
	/** What can run, each with the key it runs on. */
	models: { id: string; displayName: string; env?: string }[];
	todaySpend: Record<string, number>;
	approval: ApprovalMode;
	/** 自动审批 can run: a model that can review, with its key. */
	autoApproval: boolean;
	/** 自动审批's model, and whether it follows the run's model; null for the config's own approval model. */
	approvalModel: { id: string; displayName: string; follows: boolean } | null;
	/** 自动审批's thinking effort; null means default lowest. */
	approvalEffort: string | null;
	/** Selectable thinking tiers for 自动审批's active model; empty when that model has a single fixed mode. */
	approvalTiers: { id: string; label: string }[];
	/** Label of 自动审批's default-lowest thinking mode (e.g. 禁用思考 or 低). */
	approvalDefaultLabel: string;
	/** The models that can review this run's tool calls. */
	reviewModels: { id: string; displayName: string }[];
	/** Super Intelligent UI: replies with components (the model is told how to write them). */
	siui?: boolean;
	/** 概括标题: on or off, and the model that writes the titles. */
	titles?: { enabled: boolean; model: { id: string; displayName: string; follows: boolean } };
	/** The model's key: where it was found and a masked form; never the key itself. */
	key: { env: string; source: "environment" | "keychain" | null; masked: string | null };
	/** 模式: the system's light or dark, or one the user chose. */
	mode: "system" | "light" | "dark";
	/** The run's model has what it needs to run. */
	ready: boolean;
	setupSkipped?: boolean;
	/** Every key the user saved, by where it is used. */
	keys: { env: string; name: string; masked: string }[];
	/** UltraCode is on, and how many agents may work at once; null is no limit. */
	team: boolean;
	maxAgents: number | null;
	/** Models the user added, which they can also remove. */
	addedModels: string[];
	/** 联网搜索和读网页: on or off, the service chosen (null follows the platform), what can be chosen, and whose own search that is. */
	web: { enabled: boolean; service: string | null; services: { id: string; name: string; env: string; needsKey: boolean }[]; own: { name: string; hasSearch: boolean } | null };
	/** Where a model can be added, and whether a key is at hand there. */
	platforms: { id: string; name: string; hasKey: boolean }[];
}

function keyStatus(env: string): ShellInfo["key"] {
	const source = loadKey(env);
	const value = env ? process.env[env] : undefined;
	return { env, source, masked: value ? mask(value) : null };
}

export function shellInfo(options: HostOptions, prefs: { model?: string; effort?: string; approval?: ApprovalMode; approvalModel?: string; approvalEffort?: string }, added?: ReadonlySet<string>): ShellInfo {
	const { config, spendLedger } = previewRun(options.configPath, prefs.model ? { model: prefs.model } : {}, options.spendLedger);
	const configured = !prefs.approvalModel && config.modelApproval !== null;
	const reviewer = configured ? null : prefs.approvalModel ?? config.model;
	const activeReviewModel = reviewer ?? config.modelApproval?.model ?? config.model;
	const efforts = approvalEffortsFor(activeReviewModel);
	const validEffort = prefs.approvalEffort && efforts.tiers.some((tier) => tier.id === prefs.approvalEffort) ? prefs.approvalEffort : null;
	const settings = reviewer ? approvalSettingsFor(reviewer, config, validEffort) : null;
	const names = new Map(selectableModels().map((m) => [m.id, m.displayName]));
	// Only what the user added and can run: a model on this machine, or one whose provider has a key.
	const usable = (id: string) => {
		if (added && !added.has(id)) return false;
		const env = keyEnvFor(id, config);
		return /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(addedConfig(id).baseUrl ?? (id === config.model ? config.baseUrl : "")) || (!!env && hasKey(env));
	};
	return {
		model: config.model,
		...describeModel(config.model, config.billingCurrency),
		effort: prefs.effort ?? String(config.thinking.effort),
		models: selectableModels().filter((m) => usable(m.id)),
		todaySpend: spentToday(spendLedger),
		approval: prefs.approval ?? "ask",
		autoApproval: configured || (!!settings && !!loadKey(String(settings.apiKeyEnv))),
		approvalModel: reviewer ? { id: reviewer, displayName: names.get(reviewer) ?? reviewer, follows: !prefs.approvalModel } : null,
		approvalEffort: validEffort,
		approvalTiers: efforts.tiers,
		approvalDefaultLabel: efforts.defaultLabel,
		reviewModels: reviewModels(config).filter((m) => usable(m.id)),
		key: keyStatus(config.apiKeyEnv),
		mode: "system",
		ready: usable(config.model),
		keys: [],
		web: { enabled: true, service: null, services: [], own: null },
		addedModels: [],
		team: false,
		maxAgents: null,
		platforms: PLATFORMS.map((p) => ({ id: p.id, name: p.displayName, hasKey: hasKey(p.apiKeyEnv) })),
	};
}

/** DeepSeek's own balance, when the run model is DeepSeek's and its key is in the environment. */
async function balance(options: HostOptions, prefs: { model?: string }): Promise<string | null> {
	const { config } = previewRun(options.configPath, prefs.model ? { model: prefs.model } : {}, options.spendLedger);
	if (!config.model.startsWith("deepseek") || !/api\.deepseek\.com/.test(config.baseUrl)) return null;
	const key = process.env[config.apiKeyEnv];
	if (!key) return null;
	const response = await fetch("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
	if (!response.ok) return null;
	const body = await response.json() as { balance_infos?: { currency?: string; total_balance?: string }[] };
	const info = body.balance_infos?.[0];
	return info?.total_balance ? `${info.currency === "CNY" ? "¥" : "$"}${info.total_balance}` : null;
}

export function bindShell(desk: Desk, window: BrowserWindow, options: HostOptions, prefs: { model?: string; effort?: string; memory?: boolean; approval?: ApprovalMode; approvalModel?: string; approvalEffort?: string; siui?: boolean; team?: boolean; maxAgents?: number | null }, settings: Settings, updates?: Updates): void {
	const host = {
		preferences: () => ({ ...prefs }),
		choose(next: { model?: string; effort?: string; memory?: boolean; approval?: ApprovalMode; approvalModel?: string | null; approvalEffort?: string | null; siui?: boolean; team?: boolean; maxAgents?: number | null }) {
			if (next.siui !== undefined) prefs.siui = next.siui;
			if (next.team !== undefined) prefs.team = next.team;
			if (next.maxAgents !== undefined) prefs.maxAgents = next.maxAgents;
			if (next.approvalModel !== undefined) { if (next.approvalModel) prefs.approvalModel = next.approvalModel; else delete prefs.approvalModel; }
			if (next.approvalEffort !== undefined) { if (next.approvalEffort) prefs.approvalEffort = next.approvalEffort; else delete prefs.approvalEffort; }
			if (next.memory !== undefined) prefs.memory = next.memory;
			if (next.approval) prefs.approval = next.approval;
			if (next.model) prefs.model = next.model;
			if (next.effort) { if (next.effort === "default") delete prefs.effort; else prefs.effort = next.effort; }
			for (const live of desk.liveHosts()) live.choose(next);
		},
	};
	// 概括标题: whether it is on, and its model (the run's own unless one was chosen).
	const added = (): ReadonlySet<string> | undefined => {
		if (process.env.MOUNTAINS_TEST_KEYS === "1") return undefined;
		const saved = settings.read();
		return new Set([...(saved.models ?? []).map((m) => m.id), ...(saved.kept ?? [])]);
	};
	const facts = (prefs = host.preferences()) => shellInfo(options, prefs, added());
	const info = (): ShellInfo => {
		const base = facts(), saved = settings.read();
		const names = new Map(base.models.map((m) => [m.id, m.displayName]));
		const model = saved.titleModel ?? base.model;
		const choice = webChoice(saved), services = [...SEARCH_SERVICES, ...choice.custom];
		const sites = [...PLATFORMS.map((p) => ({ env: p.apiKeyEnv, name: p.displayName })), ...(saved.models ?? []).map((m) => ({ env: m.apiKeyEnv, name: new URL(m.baseUrl).host })), ...services.flatMap((s) => s.keyEnv ? [{ env: s.keyEnv, name: s.name }] : [])];
		const { config } = previewRun(options.configPath, host.preferences().model ? { model: host.preferences().model! } : {}, options.spendLedger);
		const run = webRun(config);
		const own = PLATFORMS.find((p) => p.id === run.platform);
		const keys = sites.filter((site, at) => sites.findIndex((other) => other.env === site.env) === at && hasKey(site.env)).map((site) => ({ ...site, masked: mask(process.env[site.env]!) }));
		const web = { enabled: choice.enabled, service: choice.service, services: services.map((s) => ({ id: s.id, name: s.name, env: s.keyEnv ?? "", needsKey: !!s.keyEnv && !hasKey(s.keyEnv) })), own: own ? { name: own.displayName, hasSearch: !!ownSearch(run) } : null };
		const addedById = new Map((saved.models ?? []).map((m) => [m.id, m]));
		const models = base.models.map((m) => {
			const added = addedById.get(m.id);
			const protocol: ModelProtocol = added?.protocol === "openai" || added?.protocol === "anthropic" ? added.protocol : modelWire(added?.id ?? m.id);
			return { ...m, env: keyEnvFor(m.id, config) ?? "", ...(added ? { contextWindow: added.contextWindow, thinking: added.thinking, ...(added.apiKeyEnv.startsWith("CUSTOM") ? { protocol } : {}) } : {}) };
		});
		return { ...base, setupSkipped: saved.setupSkipped === true, mode: saved.mode ?? "system", models, keys, web, addedModels: [...(saved.models ?? []).map((m) => m.id), ...(saved.kept ?? [])], team: host.preferences().team === true, maxAgents: host.preferences().maxAgents ?? null, siui: host.preferences().siui === true, titles: { enabled: saved.titles !== false, model: { id: model, displayName: names.get(model) ?? model, follows: !saved.titleModel } } };
	};
	setAddedModels(settings.read().models ?? []);
	// Before built-in models had to be added, the one in use with a key is the one the user meant.
	if (settings.read().kept === undefined) {
		const saved = settings.read();
		const { config } = previewRun(options.configPath, saved.model ? { model: saved.model } : {}, options.spendLedger);
		const env = keyEnvFor(config.model, config);
		const builtIn = selectableModels().some((m) => m.id === config.model) && !(saved.models ?? []).some((m) => m.id === config.model);
		settings.write({ kept: builtIn && env && hasKey(env) ? [config.model] : [] });
	}
	/** The run's model must be able to run: when it cannot, the first that can. */
	const settle = () => {
		const now = facts();
		if (now.ready || !now.models[0]) return;
		settings.write({ model: now.models[0].id });
		host.choose({ model: now.models[0].id, effort: "default" });
	};
	settle();
	/** The added models from now on; the one in use, if it went, falls back to the configured one first. */
	const keepModels = (models: AddedModel[]) => {
		const before = settings.read().models ?? [];
		const gone = before.some((m) => m.id === host.preferences().model && !models.some((kept) => kept.id === m.id));
		// An address of your own has no use for its key once no model is there.
		for (const m of before) if (m.apiKeyEnv.startsWith("CUSTOM") && !models.some((kept) => kept.apiKeyEnv === m.apiKeyEnv)) deleteKey(m.apiKeyEnv);
		settings.write({ models, ...(gone ? { model: previewRun(options.configPath, {}, options.spendLedger).config.model } : {}) });
		if (gone) host.choose({ model: settings.read().model! });
		setAddedModels(models);
		settle();
	};
	/** A preset platform's own key, a key of its own for a custom address, or another model on an address already saved. */
	const addModel = (req: Record<string, unknown>) => {
		const id = typeof req.id === "string" ? req.id.trim() : "", key = typeof req.key === "string" ? req.key.trim() : "";
		if (!id || id.length > 200) throw new Error("需要模型名称");
		// Adding onto an address already in use keeps its key and URL; the env has to be one a platform or a saved model already uses.
		const bound = typeof req.env === "string" ? req.env : "";
		const existing = bound ? (settings.read().models ?? []).find((m) => m.apiKeyEnv === bound) : undefined;
		const platform = bound ? PLATFORMS.find((p) => p.apiKeyEnv === bound) : PLATFORMS.find((p) => p.id === req.platform);
		if (bound && !platform && !existing) throw new Error("没有这个接口");
		const baseUrl = (platform?.baseUrl || existing?.baseUrl || (typeof req.baseUrl === "string" ? req.baseUrl.trim() : "")).replace(/\/$/, "");
		if (!/^https?:\/\//.test(baseUrl)) throw new Error("接口地址要以 http 或 https 开头");
		const apiKeyEnv = bound || platform?.apiKeyEnv || `CUSTOM${createHash("sha256").update(baseUrl).digest("hex").slice(0, 8).toUpperCase()}_API_KEY`;
		if (key) saveKey(apiKeyEnv, key);
		else if (!hasKey(apiKeyEnv) && !/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(baseUrl)) throw new Error("这个地址需要密钥");
		// A built-in model stays built-in only on its own platform. The same name on another address is that address's model.
		if (selectableModels().some((m) => m.id === id) && !(settings.read().models ?? []).some((m) => m.id === id)) {
			const own = keyEnvFor(id, previewRun(options.configPath, { model: id }, options.spendLedger).config);
			if (own === apiKeyEnv) {
				settings.write({ kept: [...new Set([...(settings.read().kept ?? []), id])] });
				settle();
				return info();
			}
		}
		const thinking = req.thinking === "always" || req.thinking === "tiers" ? req.thinking : "off";
		const protocol: ModelProtocol | undefined = !platform && (req.protocol === "openai" || req.protocol === "anthropic") ? req.protocol : undefined;
		const model: AddedModel = { id, displayName: typeof req.displayName === "string" && req.displayName.trim() ? req.displayName.trim() : id, baseUrl, apiKeyEnv,
			contextWindow: Math.max(32_768, Number(req.contextWindow) || 128_000), thinking, tiers: thinking !== "tiers" ? [] : Array.isArray(req.tiers) && req.tiers.length ? req.tiers as AddedModel["tiers"] : [...REASONING_TIERS], ...(protocol ? { protocol } : {}) };
		keepModels([...(settings.read().models ?? []).filter((m) => m.id !== id), model]);
		return info();
	};
	/** Change a model the user added. The id, the window and whether it thinks can all be wrong after the first save. */
	const updateModel = (req: Record<string, unknown>) => {
		const from = typeof req.from === "string" ? req.from.trim() : "";
		const id = typeof req.id === "string" ? req.id.trim() : "";
		if (!id || id.length > 200) throw new Error("需要模型名称");
		const models = settings.read().models ?? [];
		const current = models.find((m) => m.id === from);
		if (!current) throw new Error("没有这个模型");
		const taken = new Set([...models.map((m) => m.id), ...(settings.read().kept ?? [])]);
		taken.delete(from);
		if (taken.has(id)) throw new Error("已经有这个模型");
		const thinking = req.thinking === "always" || req.thinking === "tiers" ? req.thinking : "off";
		const protocol: ModelProtocol | undefined = req.protocol === "openai" || req.protocol === "anthropic" ? req.protocol : current.protocol;
		const next: AddedModel = { ...current, id, displayName: current.displayName === from ? id : current.displayName,
			contextWindow: Math.max(32_768, Number(req.contextWindow) || current.contextWindow), thinking, tiers: thinking !== "tiers" ? [] : current.tiers.length ? current.tiers : [...REASONING_TIERS], ...(protocol ? { protocol } : {}) };
		const saved = settings.read();
		const point = { ...(saved.model === from ? { model: id } : {}), ...(saved.titleModel === from ? { titleModel: id } : {}), ...(saved.approvalModel === from ? { approvalModel: id } : {}) };
		if (point.model || point.titleModel !== undefined || point.approvalModel !== undefined) settings.write(point);
		if (point.model) host.choose({ model: id });
		if (point.approvalModel !== undefined) host.choose({ approvalModel: point.approvalModel });
		keepModels(models.map((m) => m.id === from ? next : m));
		return info();
	};
	const addressFor = (env: string) => {
		const platform = PLATFORMS.find((p) => p.apiKeyEnv === env);
		const existing = (settings.read().models ?? []).find((m) => m.apiKeyEnv === env);
		if (!platform && !existing) throw new Error("没有这个接口");
		return platform?.baseUrl || existing?.baseUrl || "";
	};
	ipcMain.handle(SHELL_CHANNEL, async (event, request: unknown) => {
		if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("not this window");
		const req = request && typeof request === "object" ? request as Record<string, unknown> : {};
		if (req.type === "info") return info();
		if (req.type === "skipSetup") { settings.write({ setupSkipped: true }); return info(); }
		if (req.type === "open" && typeof req.url === "string") {
			const url = new URL(req.url);
			if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只能打开网页");
			await shell.openExternal(url.href);
			return true;
		}
		if (req.type === "team") {
			const change = { ...(typeof req.enabled === "boolean" ? { team: req.enabled } : {}), ...(req.maxAgents === null || (Number.isSafeInteger(req.maxAgents) && (req.maxAgents as number) >= 1 && (req.maxAgents as number) <= 32) ? { maxAgents: req.maxAgents as number | null } : {}) };
			settings.write(change);
			host.choose({ ...change, ...(change.team ? { maxAgents: change.maxAgents ?? prefs.maxAgents ?? null } : {}) });
			return info();
		}
		if (req.type === "mode" && (req.mode === "system" || req.mode === "light" || req.mode === "dark")) {
			settings.write({ mode: req.mode });
			nativeTheme.themeSource = req.mode;
			return info();
		}
		if (req.type === "web") {
			const service = [...SEARCH_SERVICES, ...webChoice(settings.read()).custom].find((s) => s.id === req.service);
			if (typeof req.key === "string" && service?.keyEnv) saveKey(service.keyEnv, req.key.trim());
			settings.write({ ...(typeof req.enabled === "boolean" ? { web: req.enabled } : {}), ...(req.service === null || service ? { search: service?.id ?? null } : {}) });
			return info();
		}
		if (req.type === "siui" && typeof req.enabled === "boolean") { settings.write({ siui: req.enabled }); host.choose({ siui: req.enabled }); return info(); }
		if (req.type === "titles") {
			if (typeof req.enabled === "boolean") settings.write({ titles: req.enabled });
			if (req.model === null || typeof req.model === "string") {
				if (req.model !== null && !selectableModels().some((m) => m.id === req.model)) throw new Error("unknown model");
				settings.write({ titleModel: req.model });
			}
			return info();
		}
		if (req.type === "balance") return balance(options, host.preferences()).catch(() => null);
		if (req.type === "choose") {
			const model = typeof req.model === "string" ? req.model : undefined;
			const effort = typeof req.effort === "string" ? req.effort : undefined;
			if (model !== undefined && !selectableModels().some((m) => m.id === model)) throw new Error("unknown model");
			const target = facts({ ...host.preferences(), ...(model ? { model } : {}) });
			const allowed = new Set(["default", ...target.tiers.map((tier) => tier.id)]);
			if (effort !== undefined && !allowed.has(effort)) throw new Error("this model has no such thinking tier");
			// A new model keeps the chosen tier only if it has it.
			const kept = effort ?? host.preferences().effort;
			if (model) settings.write({ model });
			host.choose({ ...(model ? { model } : {}), ...(kept && allowed.has(kept) ? { effort: kept } : { effort: "default" }) });
			return info();
		}
		const id = typeof req.id === "string" ? req.id : "";
		if (req.type === "answerAsk" && typeof req.askId === "string" && typeof req.text === "string" && id) return desk.answerAsk(id, req.askId, req.text.slice(0, 2000));
		if (req.type === "memory") { const saved = settings.read(); return { enabled: saved.memory === true, agentsWrite: agentsWriteAllowed(saved), agentsNext: saved.agentsNext === true, agents: readGlobalAgents(), agentsPath: globalAgentsPath(), updateFeed: saved.updateFeed ?? "" }; }
		if (req.type === "setMemory" && typeof req.enabled === "boolean") {
			settings.write({ memory: req.enabled });
			host.choose({ memory: req.enabled });
			return { enabled: req.enabled };
		}
		if (req.type === "setAgents" && typeof req.text === "string") { writeGlobalAgents(req.text.slice(0, 64 * 1024)); return true; }
		if (req.type === "agentsWrite" && typeof req.enabled === "boolean") {
			if (!req.enabled) settings.write({ agentsWrite: false, agentsNext: false });
			else if (req.when === "next") settings.write({ agentsNext: true, agentsWrite: false });
			else settings.write({ agentsWrite: true, agentsNext: false });
			const saved = settings.read();
			return { agentsWrite: agentsWriteAllowed(saved), agentsNext: saved.agentsNext === true };
		}
		if (req.type === "approval" && (req.mode === "ask" || req.mode === "auto" || req.mode === "full")) {
			if (req.mode === "auto" && !facts().autoApproval) throw new Error("no approval model configured");
			settings.write({ approval: req.mode });
			host.choose({ approval: req.mode });
			return info();
		}
		// 自动审批's model: one that can review this run, or null to follow the run's model.
		if (req.type === "approvalModel" && (req.model === null || typeof req.model === "string")) {
			const { config } = previewRun(options.configPath, host.preferences().model ? { model: host.preferences().model! } : {}, options.spendLedger);
			if (req.model !== null && !reviewModels(config).some((m) => m.id === req.model)) throw new Error("this model cannot review approvals");
			settings.write({ approvalModel: req.model });
			host.choose({ approvalModel: req.model });
			const nextInfo = facts();
			if (host.preferences().approvalEffort && !nextInfo.approvalEffort) {
				settings.write({ approvalEffort: null });
				host.choose({ approvalEffort: null });
			}
			return info();
		}
		if (req.type === "approvalEffort" && (req.effort === null || typeof req.effort === "string")) {
			const next = req.effort && req.effort !== "lowest" ? req.effort : null;
			if (next !== null && !facts().approvalTiers.some((tier) => tier.id === next)) throw new Error("unsupported approval effort");
			settings.write({ approvalEffort: next });
			host.choose({ approvalEffort: next });
			return info();
		}
		if (req.type === "modelPresets" && typeof req.query === "string") return modelPresets(req.query);
		if (req.type === "addModel") return addModel(req);
		if (req.type === "updateModel") return updateModel(req);
		if (req.type === "listModels" && typeof req.env === "string") {
			const env = req.env;
			if (!info().keys.some((saved) => saved.env === env) && !(settings.read().models ?? []).some((m) => m.apiKeyEnv === env)) throw new Error("没有这个接口");
			return fetchModelIds(addressFor(env), process.env[env] ?? "");
		}
		if (req.type === "removeModel" && typeof req.id === "string") {
			settings.write({ kept: (settings.read().kept ?? []).filter((id) => id !== req.id) });
			keepModels((settings.read().models ?? []).filter((m) => m.id !== req.id));
			return info();
		}
		if (req.type === "saveKey" && typeof req.env === "string" && typeof req.key === "string" && info().keys.some((saved) => saved.env === req.env)) {
			saveKey(req.env, req.key.trim());
			return info();
		}
		// A key goes with the models that used it.
		if (req.type === "removeKey" && typeof req.env === "string" && info().keys.some((saved) => saved.env === req.env)) {
			deleteKey(req.env);
			const choice = webChoice(settings.read());
			const search = [...SEARCH_SERVICES, ...choice.custom].find((s) => s.id === choice.service);
			const { config } = previewRun(options.configPath, {}, options.spendLedger);
			settings.write({ searchCustom: choice.custom.filter((s) => s.keyEnv !== req.env), kept: (settings.read().kept ?? []).filter((id) => keyEnvFor(id, config) !== req.env), ...(search?.keyEnv === req.env ? { search: null } : {}) });
			keepModels((settings.read().models ?? []).filter((m) => m.apiKeyEnv !== req.env));
			return info();
		}
		if (req.type === "list") return desk.list();
		if (req.type === "create") {
			if (settings.read().agentsNext) settings.write({ agentsWrite: true, agentsNext: false });
			const memory = req.memory as { save?: unknown; read?: unknown } | undefined;
			return desk.create(typeof req.workspace === "string" ? req.workspace : undefined, memory ? { save: memory.save !== false, read: memory.read !== false } : undefined);
		}
		// Recent folders for a new conversation: the default first-time one, then those used, newest first.
		if (req.type === "folders") {
			const seen = new Set<string>(), out: { path: string; git: boolean; isDefault: boolean }[] = [];
			const fallback = options.workspace ?? defaultWorkspace();
			for (const path of [...desk.list().sort((a, b) => b.updatedAt - a.updatedAt).map((c) => c.workspace || fallback), fallback]) {
				if (seen.has(path) || out.length >= 6) continue;
				seen.add(path);
				out.push({ path, git: isGitRepo(path), isDefault: path === fallback });
			}
			return { home: homedir(), folders: out };
		}
		if (req.type === "chooseFolder") {
			const picked = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"], buttonLabel: "选择" });
			return picked.canceled ? null : picked.filePaths[0] ?? null;
		}
		if (req.type === "chooseFiles") {
			const picked = await dialog.showOpenDialog(window, { properties: ["openFile", "multiSelections"], buttonLabel: "添加" });
			return picked.canceled ? [] : picked.filePaths;
		}
		// A pasted picture or long text becomes a file beside the conversations; the message carries its path.
		if (req.type === "paste" && (req.kind === "png" || req.kind === "jpg" || req.kind === "txt") && (typeof req.data === "string" || req.data instanceof Uint8Array)) {
			const size = typeof req.data === "string" ? req.data.length : req.data.byteLength;
			if (size > 32 * 1024 * 1024) throw new Error("粘贴的内容超过 32 MB");
			return savePasted(join(desk.dataDir, "attachments"), req.kind, req.data);
		}
		// The workspace's files matching what follows @, best first.
		if (req.type === "files") {
			const root = (id && desk.workspace(id)) || (typeof req.workspace === "string" && req.workspace) || options.workspace || defaultWorkspace();
			return matchFiles(workspaceFiles(root), typeof req.query === "string" ? req.query.slice(0, 200) : "");
		}
		if (req.type === "reveal" && (req.what === "data" || req.what === "skills")) {
			const dir = req.what === "skills" ? join(homedir(), ".mountains", "skills") : desk.dataDir;
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			shell.showItemInFolder(dir);
			return true;
		}
		if (req.type === "about") { const saved = settings.read(); return { version: APP_LABEL, dataDir: desk.dataDir, updateSource: saved.updateSource ?? "auto", updateChannel: saved.updateChannel === "stable" ? "stable" : "preview", autoUpdate: saved.autoUpdate === true }; }
		if (req.type === "updateState") return updates?.state() ?? { phase: "idle", installMode: "manual", busy: false };
		if (req.type === "checkUpdate") return updates?.check();
		if (req.type === "downloadUpdate") return updates?.download();
		if (req.type === "installUpdate") return updates?.install();
		if (req.type === "setUpdateChannel" && (req.channel === "stable" || req.channel === "preview")) {
			updates?.reset(); settings.write({ updateChannel: req.channel }); return { updateChannel: req.channel };
		}
		if (req.type === "setUpdateSource" && (req.source === "auto" || req.source === "hk" || req.source === "github")) {
			updates?.reset(); settings.write({ updateSource: req.source }); return { updateSource: req.source };
		}
		if (req.type === "setAutoUpdate" && typeof req.enabled === "boolean") {
			settings.write({ autoUpdate: req.enabled }); return { autoUpdate: req.enabled };
		}
		if (req.type === "openPath" && typeof req.path === "string") { await shell.openPath(req.path); return true; }
		if (req.type === "installSkills") {
			const text = typeof req.text === "string" ? req.text.slice(0, 20_000) : "";
			const paths = Array.isArray(req.paths) ? req.paths.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
			const dest = join(process.env.MOUNTAINS_HOME ?? join(homedir(), ".mountains"), "skills");
			return installSkillSources({ text, paths, dest });
		}
		if (req.type === "skills") {
			const root = (id && desk.workspace(id)) || options.workspace || defaultWorkspace();
			const modes = settings.read().skillMode ?? {};
			try {
				return userSkills(root, options.configPath).map((skill) => ({ ...skill, mode: modes[skill.name] ?? (skill.source === "project" ? "ask" : "allow") }));
			} catch { return []; }
		}
		if (req.type === "skillMode" && typeof req.name === "string" && (req.mode === "allow" || req.mode === "ask")) {
			const name = req.name.slice(0, 64);
			settings.write({ skillMode: { ...settings.read().skillMode, [name]: req.mode } });
			return true;
		}
		if (req.type === "summarizeAgents") {
			const text = readGlobalAgents();
			if (!text.trim()) return { agents: "" };
			const { config } = previewRun(options.configPath, prefs.model ? { model: prefs.model } : {}, options.spendLedger);
			const next = await summarizeAgents(config.model, config, text);
			writeGlobalAgents(next);
			return { agents: next };
		}
		if (req.type === "truncateAgents") {
			const text = readGlobalAgents();
			const { config } = previewRun(options.configPath, prefs.model ? { model: prefs.model } : {}, options.spendLedger);
			const next = clippedAgents(text, config.contextWindow ?? 128_000);
			writeGlobalAgents(next);
			return { agents: next };
		}
		if (req.type === "history") return desk.history(id);
		if (req.type === "toolOutput") return desk.toolOutput(id, typeof req.toolCallId === "string" ? req.toolCallId : "");
		if (req.type === "search") return desk.search(typeof req.query === "string" ? req.query.slice(0, 200) : "");
		if (req.type === "setWorkspace" && typeof req.workspace === "string") { desk.setWorkspace(id, req.workspace); return desk.list(); }
		if (req.type === "rewind" && typeof req.run === "string") return desk.rewind(id, req.run, { files: req.files === true });
		if (req.type === "changes") return desk.changes(id);
		if (req.type === "diff" && typeof req.path === "string") return desk.diff(id, req.path);
		if (req.type === "restore" && (req.run === null || typeof req.run === "string")) return desk.restore(id, req.run);
		if (req.type === "plan" && typeof req.enabled === "boolean") { desk.setPlan(id, req.enabled); return desk.list(); }
		if (req.type === "approvePlan") { desk.approvePlan(id); return desk.list(); }
		if (req.type === "goal" && typeof req.text === "string") { desk.startGoal(id, req.text.slice(0, 65_536)); return desk.list(); }
		if (req.type === "pauseGoal") { desk.pauseGoal(id); return desk.list(); }
		if (req.type === "resumeGoal") { desk.resumeGoal(id); return desk.list(); }
		if (req.type === "updateGoal" && typeof req.text === "string") { desk.updateGoal(id, req.text.slice(0, 65_536)); return desk.list(); }
		if (req.type === "deleteGoal") { desk.deleteGoal(id); return desk.list(); }
		if (req.type === "stopGoal") { desk.stopGoal(id); return desk.list(); }
		// How SIUI gets used, kept on this machine to tune the notes by, never sent anywhere.
		if (req.type === "siuiUse" && typeof req.what === "string") { appendFileSync(join(desk.dataDir, "siui-usage.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), what: req.what.slice(0, 20) })}\n`, { mode: 0o600 }); return true; }
		// The look: what was kept and the saved themes; 保留 keeps it, 存成主题 also names it.
		if (req.type === "appearance") return { current: settings.read().theme ?? null, themes: savedThemes(desk.dataDir) };
		if (req.type === "keepTheme" && (req.theme === null || typeof req.theme === "string")) {
			if (req.theme !== null) checkedTheme(req.theme);
			settings.write({ theme: req.theme });
			return { current: req.theme, themes: savedThemes(desk.dataDir) };
		}
		if (req.type === "saveTheme" && typeof req.theme === "string" && typeof req.name === "string") {
			const theme = saveTheme(desk.dataDir, req.theme, req.name);
			settings.write({ theme });
			return { current: theme, themes: savedThemes(desk.dataDir) };
		}
		if (req.type === "redo") return desk.redo(id);
		if (req.type === "compact") return desk.compact(id);
		if (req.type === "reveal") {
			const target = typeof req.path === "string" ? desk.filePath(id, req.path) : desk.workspace(id);
			if (target) shell.showItemInFolder(target);
			return true;
		}
		if (req.type === "export") {
			const conversation = desk.list().find((c) => c.id === id);
			if (!conversation) return false;
			const name = (conversation.title || "对话").replace(/[\\/:*?"<>|\n]/g, " ").trim().slice(0, 60) || "对话";
			const picked = await dialog.showSaveDialog(window, { defaultPath: join(homedir(), "Downloads", `${name}.md`), filters: [{ name: "Markdown", extensions: ["md"] }] });
			if (picked.canceled || !picked.filePath) return false;
			writeFileSync(picked.filePath, desk.markdown(id));
			return true;
		}
		if (req.type === "markdown") return desk.markdown(id);
		if (req.type === "update") {
			const change = req.change && typeof req.change === "object" ? req.change as Record<string, unknown> : {};
			desk.update(id, {
				...(change.group === null || typeof change.group === "string" ? { group: change.group as string | null } : {}),
				...(typeof change.title === "string" ? { title: change.title } : {}),
				...(typeof change.pinned === "boolean" ? { pinned: change.pinned } : {}),
				...(typeof change.archived === "boolean" ? { archived: change.archived } : {}),
			});
			return desk.list();
		}
		if (req.type === "remove") { await desk.remove(id); return desk.list(); }
		throw new Error("unknown request");
	});
}
