/**
 * The models in Settings and the keys they run on, and adding one: a preset platform or an address of your own. A
 * name that is recognized offers the settings that come with that model; without them, the user says what it can do.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ShellInfo } from "./Bar.tsx";
import { useI18n } from "./i18n.tsx";
import { Reveal, useLeaving } from "./Motion.tsx";

interface Preset { id: string; displayName: string; platform: string | null; contextWindow: number; maxOutput: number; thinking: "off" | "always" | "tiers"; tiers: { id: string; label: string }[]; priced: boolean }
type Ask = (request: { type: string; [key: string]: unknown }) => Promise<unknown>;

const CUSTOM = "custom";
const THINKING = { off: "不支持思考", always: "支持思考", tiers: "可调强度" } as const;
type Wire = "openai" | "anthropic";
const WIRE = { openai: "OpenAI 兼容", anthropic: "Anthropic" } as const;
const size = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`;
const reason = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);

/** A window over the page, for one task: the browser's own modal dialog keeps focus inside and Esc closes it. */
function Sheet({ title, leaving, onClose, children }: { title: string; leaving: boolean; onClose: () => void; children: ReactNode }) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const node = dialog.current!;
		node.showModal();
		node.querySelector("input")?.focus();
		return () => node.close();
	}, []);
	return (
		<dialog ref={dialog} className="sheet" aria-label={title} data-leaving={leaving || undefined} onCancel={(event) => { event.preventDefault(); onClose(); }}>
			<h2>{title}</h2>
			{children}
		</dialog>
	);
}

function WireField({ value, onChange }: { value: Wire; onChange: (value: Wire) => void }) {
	return (
		<label className="setting"><span className="setting-name">接口协议</span>
			<select className="select" value={value} onChange={(event) => onChange(event.target.value as Wire)}>
				<option value="openai">{WIRE.openai}</option>
				<option value="anthropic">{WIRE.anthropic}</option>
			</select>
		</label>
	);
}

function AddModel({ info, ask, onInfo, onDone, onto }: { info: ShellInfo; ask: Ask; onInfo: (info: ShellInfo) => void; onDone: () => void; onto?: { env: string; name: string; custom: boolean; protocol: Wire } }) {
	const [platform, setPlatform] = useState(info.platforms[0]?.id ?? CUSTOM);
	const [wire, setWire] = useState<Wire>(onto?.protocol ?? "openai");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [key, setKey] = useState("");
	const [presets, setPresets] = useState<Preset[]>([]);
	// The preset taken, or false when the user declined to use one.
	const [chosen, setChosen] = useState<Preset | false | null>(null);
	const [context, setContext] = useState("128000");
	const [thinking, setThinking] = useState<keyof typeof THINKING>("off");
	const [error, setError] = useState("");
	useEffect(() => {
		setChosen((taken) => taken && taken.id === name ? taken : null);
		if (!name.trim()) { setPresets([]); return; }
		let live = true;
		const timer = setTimeout(() => void ask({ type: "modelPresets", query: name }).then((found) => { if (live) setPresets(found as Preset[]); }, () => {}), 160);
		return () => { live = false; clearTimeout(timer); };
	}, [ask, name]);
	const take = (preset: Preset) => {
		setChosen(preset);
		setName(preset.id);
		if (!onto && preset.platform && platform !== CUSTOM) setPlatform(preset.platform);
		setPresets([]);
	};
	const custom = !onto && platform === CUSTOM;
	const showWire = custom || onto?.custom === true;
	const needsKey = !onto && !custom && !info.platforms.find((p) => p.id === platform)?.hasKey;
	const ready = name.trim() && (!custom || baseUrl.trim()) && (!needsKey || key.trim());
	const add = (event: FormEvent) => {
		event.preventDefault();
		if (!ready) return;
		setError("");
		const preset = chosen || null;
		void ask({ type: "addModel", id: name, displayName: preset?.displayName, ...(onto ? { env: onto.env } : custom ? { baseUrl } : { platform }), ...(onto ? {} : { key }), ...(showWire ? { protocol: wire } : {}),
			contextWindow: preset?.contextWindow ?? Number(context), thinking: preset?.thinking ?? thinking, tiers: preset?.tiers ?? [] })
			.then((next) => { onInfo(next as ShellInfo); onDone(); }, (failure: unknown) => setError(reason(failure)));
	};
	const offer = chosen === null ? presets : [];
	return (
		<form className="add-model" onSubmit={add}>
			<div className="add-fields">
			{onto ? <p className="setting-note add-onto">沿用 {onto.name} 的地址和密钥</p> : (
			<label className="setting"><span className="setting-name">平台</span>
				<select className="select" value={platform} onChange={(event) => setPlatform(event.target.value)}>
					{info.platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
					<option value={CUSTOM}>自定义</option>
				</select>
			</label>
			)}
			{showWire ? <WireField value={wire} onChange={setWire} /> : null}
			<label className="setting"><span className="setting-name">模型名称</span>
				<input className="add-input" value={name} spellCheck={false} onChange={(event) => setName(event.target.value)} />
			</label>
			{offer.map((preset) => (
				<div key={preset.id} className="add-preset">
					<span><span className="setting-name">是 {preset.displayName} 吗？</span>
						<span className="setting-note">上下文 {size(preset.contextWindow)} · {preset.tiers.length ? preset.tiers.map((t) => t.label).join(" / ") : THINKING[preset.thinking]}{preset.priced ? "" : " · 未计费"}</span></span>
					<button type="button" className="link" onClick={() => take(preset)}>使用预设</button>
				</div>
			))}
			{offer.length ? <button type="button" className="link add-decline" onClick={() => setChosen(false)}>不用预设</button> : null}
			{chosen ? <p className="setting-note">已用 {chosen.displayName} 的预设：上下文 {size(chosen.contextWindow)}，{chosen.tiers.length ? chosen.tiers.map((t) => t.label).join(" / ") : THINKING[chosen.thinking]}</p> : null}
			{custom ? <label className="setting"><span className="setting-name">接口地址</span><input className="add-input" placeholder="https://example.com/v1" value={baseUrl} spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} /></label> : null}
			{needsKey || custom ? <label className="setting"><span className="setting-name">密钥</span><input className="add-input" type="password" placeholder={custom ? "本机模型可不填" : undefined} value={key} onChange={(event) => setKey(event.target.value)} /></label> : null}
			{chosen ? null : (
				<>
					<label className="setting"><span className="setting-name">上下文</span><input className="add-input" inputMode="numeric" value={context} onChange={(event) => setContext(event.target.value.replace(/\D/g, ""))} /></label>
						<label className="setting"><span className="setting-name">支持思考</span>
							<input type="checkbox" role="switch" className="switch" checked={thinking === "tiers"} onChange={(event) => setThinking(event.target.checked ? "tiers" : "off")} />
						</label>
				</>
			)}
			{error ? <p className="setting-error">{error}</p> : null}
			</div>
			<div className="add-actions"><button type="button" className="ghost" onClick={onDone}>取消</button><button type="submit" className="allow" disabled={!ready}>添加</button></div>
		</form>
	);
}

function EditModel({ model, ask, onInfo, onDone }: { model: { id: string; contextWindow: number; thinking: "off" | "always" | "tiers"; protocol?: Wire }; ask: Ask; onInfo: (info: ShellInfo) => void; onDone: () => void }) {
	const [name, setName] = useState(model.id);
	const [context, setContext] = useState(String(model.contextWindow));
	const [thinking, setThinking] = useState(model.thinking === "off" ? "off" : "tiers");
	const [wire, setWire] = useState<Wire>(model.protocol ?? "openai");
	const [error, setError] = useState("");
	const save = (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setError("");
		void ask({ type: "updateModel", from: model.id, id: name, contextWindow: Number(context), thinking, ...(model.protocol ? { protocol: wire } : {}) })
			.then((next) => { onInfo(next as ShellInfo); onDone(); }, (failure: unknown) => setError(reason(failure)));
	};
	return (
		<form className="add-model" onSubmit={save}>
			<div className="add-fields">
				{model.protocol ? <WireField value={wire} onChange={setWire} /> : null}
				<label className="setting"><span className="setting-name">模型名称</span><input className="add-input" value={name} spellCheck={false} onChange={(event) => setName(event.target.value)} /></label>
				<label className="setting"><span className="setting-name">上下文</span><input className="add-input" inputMode="numeric" value={context} onChange={(event) => setContext(event.target.value.replace(/\D/g, ""))} /></label>
				<label className="setting"><span className="setting-name">支持思考</span>
					<input type="checkbox" role="switch" className="switch" checked={thinking === "tiers"} onChange={(event) => setThinking(event.target.checked ? "tiers" : "off")} />
				</label>
				{error ? <p className="setting-error">{error}</p> : null}
			</div>
			<div className="add-actions"><button type="button" className="ghost" onClick={onDone}>取消</button><button type="submit" className="allow" disabled={!name.trim()}>保存</button></div>
		</form>
	);
}

function RemoteModels({ env, have, wire: initial, custom, ask, onInfo, onClose }: { env: string; have: ReadonlySet<string>; wire: Wire; custom: boolean; ask: Ask; onInfo: (info: ShellInfo) => void; onClose: () => void }) {
	const [ids, setIds] = useState<string[] | null>(null);
	const [wire, setWire] = useState<Wire>(initial);
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	useEffect(() => {
		let live = true;
		void ask({ type: "listModels", env }).then((found) => { if (live) setIds(found as string[]); }, (failure: unknown) => { if (live) setError(reason(failure)); });
		return () => { live = false; };
	}, [ask, env]);
	const shown = (ids ?? []).filter((id) => id.toLowerCase().includes(filter.trim().toLowerCase()));
	const add = (id: string) => {
		setBusy(id);
		setError("");
		void (async () => {
			const found = await ask({ type: "modelPresets", query: id }) as Preset[];
			const preset = found.find((item) => item.id === id) ?? null;
			const next = await ask({ type: "addModel", id, displayName: preset?.displayName, env, ...(custom ? { protocol: wire } : {}), contextWindow: preset?.contextWindow ?? 128000, thinking: preset?.thinking ?? "off", tiers: preset?.tiers ?? [] });
			onInfo(next as ShellInfo);
		})().catch((failure: unknown) => setError(reason(failure))).finally(() => setBusy(""));
	};
	return (
		<div className="add-model">
			<div className="add-fields">
				{custom ? <WireField value={wire} onChange={setWire} /> : null}
				{ids === null && !error ? <p className="setting-note add-onto">正在获取</p> : null}
				{ids ? <input className="add-input model-filter" placeholder="筛选" value={filter} spellCheck={false} onChange={(event) => setFilter(event.target.value)} /> : null}
				<div className="model-picks">
					{shown.map((id) => (
						<div key={id} className="model-pick">
							<span className="mono">{id}</span>
							{have.has(id) ? <span className="setting-note">已添加</span> : <button type="button" className="link" disabled={busy === id} onClick={() => add(id)}>添加</button>}
						</div>
					))}
				</div>
				{ids && !shown.length ? <p className="setting-note">没有匹配的模型</p> : null}
				{error ? <p className="setting-error">{error}</p> : null}
			</div>
			<div className="add-actions"><button type="button" className="ghost" onClick={onClose}>关闭</button></div>
		</div>
	);
}

/** 联网: the switch, the search service, and the key one of them still needs. */
export function WebPart({ info, ask, onInfo, onConfigureSearch }: { info: ShellInfo; ask: Ask; onInfo: (info: ShellInfo) => void; onConfigureSearch: () => void }) {
	const { t } = useI18n();
	const [key, setKey] = useState("");
	const [error, setError] = useState("");
	const [compat, setCompat] = useState(false);
	const web = info.web;
	const chosen = web.services.find((service) => service.id === web.service);
	const chosenKey = info.keys.find((saved) => saved.env === chosen?.env);
	const change = (request: Record<string, unknown>) => {
		setError("");
		void ask({ type: "web", ...request }).then((next) => { onInfo(next as ShellInfo); setKey(""); }, (failure: unknown) => setError(reason(failure)));
	};
	const follow = t("followProvider");
	return (
		<>
			<label className="setting">
				<span className="setting-name">{t("webSearch")}</span>
				<input type="checkbox" role="switch" className="switch" checked={web.enabled} onChange={(event) => change({ enabled: event.target.checked })} />
			</label>
			<Reveal open={web.enabled}>
				<label className="setting"><span className="setting-name">{t("searchService")}</span>
					<select className="select" value={web.service ?? ""} onChange={(event) => {
						if (event.target.value === "custom") { onConfigureSearch(); return; }
						change({ service: event.target.value || null });
					}}>
						<option value="">{follow}</option>
						{web.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
						<option value="custom">{t("searchCustom")}</option>
					</select>
				</label>
				{chosenKey ? <div className="model-group"><KeyRow saved={chosenKey} balance={null} ask={ask} onInfo={onInfo} /></div> : null}
				{chosen?.needsKey ? (
					<label className="setting"><span className="setting-name">{chosen.name} {t("key")}</span>
						<span className="key-edit">
							<input type="password" value={key} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && key.trim()) change({ service: chosen.id, key }); }} />
							<button type="button" className="link" disabled={!key.trim()} onClick={() => change({ service: chosen.id, key })}>{t("save")}</button>
						</span>
					</label>
				) : null}
				<p className="setting-note web-hint"><button type="button" className="link" onClick={() => setCompat(true)}>{t("supportedSearch")}</button></p>
				{error ? <p className="setting-error">{error}</p> : null}
			</Reveal>
			{compat ? <Sheet title={t("supportedSearch")} leaving={false} onClose={() => setCompat(false)}>
				<div className="search-compat">
					<p className="setting-name">{t("withModel")}</p>
					<p className="setting-note">{t("withModelList")}</p>
					<p className="setting-name">{t("searchApis")}</p>
					<p className="setting-note">{t("searchApiList")}</p>
					<p className="setting-name">{t("noOwnSearch")}</p>
					<p className="setting-note">{t("noOwnList")}</p>
				</div>
				<div className="add-actions"><button type="button" className="ghost" onClick={() => setCompat(false)}>{t("close")}</button></div>
			</Sheet> : null}
		</>
	);
}

function KeyRow({ saved, balance, ask, onInfo }: { saved: ShellInfo["keys"][number]; balance: string | null; ask: Ask; onInfo: (info: ShellInfo) => void }) {
	const [editing, setEditing] = useState(false);
	const [key, setKey] = useState("");
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState("");
	const save = () => {
		setError("");
		void ask({ type: "saveKey", env: saved.env, key }).then((next) => { onInfo(next as ShellInfo); setEditing(false); setKey(""); }, (failure: unknown) => setError(reason(failure)));
	};
	return (
		<>
			<div className="group-head">
				<span>
					<span className="setting-name">{saved.name}</span>
					<span className="setting-note mono">{saved.masked}{balance ? ` · 余额 ${balance}` : ""}</span>
				</span>
				{editing ? (
					<span className="key-edit">
						<input type="password" autoFocus placeholder="粘贴新密钥" aria-label="新密钥" value={key} onChange={(event) => setKey(event.target.value)}
							onKeyDown={(event) => { if (event.key === "Enter" && key.trim()) save(); if (event.key === "Escape") { setEditing(false); setKey(""); setError(""); } }} />
						<button type="button" className="link" disabled={!key.trim()} onClick={save}>保存</button>
					</span>
				) : (
					<span className="key-acts">
						<button type="button" className="link" onClick={() => { setRemoving(false); setEditing(true); }}>更换密钥</button>
						<button type="button" className="link" onBlur={() => setRemoving(false)}
							onClick={() => { if (removing) void ask({ type: "removeKey", env: saved.env }).then((next) => onInfo(next as ShellInfo)); else setRemoving(true); }}>{removing ? "确认移除" : "移除密钥"}</button>
					</span>
				)}
			</div>
			{error ? <p className="setting-error">{error}</p> : null}
		</>
	);
}

export function ModelsPart({ info, ask, onInfo, balance, adding, onAdding }: { info: ShellInfo; ask: Ask; onInfo: (info: ShellInfo) => void; balance: string | null; adding: boolean; onAdding: (adding: boolean) => void }) {
	const sheet = useLeaving(adding);
	const [onto, setOnto] = useState<{ env: string; name: string; custom: boolean; protocol: Wire } | null>(null);
	const ontoSheet = useLeaving(onto !== null);
	const ontoHeld = useRef(onto);
	if (onto) ontoHeld.current = onto;
	const ontoNow = onto ?? ontoHeld.current;
	const [listing, setListing] = useState<{ env: string; name: string; custom: boolean; protocol: Wire } | null>(null);
	const listingSheet = useLeaving(listing !== null);
	const listingHeld = useRef(listing);
	if (listing) listingHeld.current = listing;
	const listingNow = listing ?? listingHeld.current;
	const [editing, setEditing] = useState<{ id: string; contextWindow: number; thinking: "off" | "always" | "tiers"; protocol?: Wire } | null>(null);
	const editingSheet = useLeaving(editing !== null);
	const editingHeld = useRef(editing);
	if (editing) editingHeld.current = editing;
	const editingNow = editing ?? editingHeld.current;
	const searchKeys = new Set(info.web.services.map((service) => service.env));
	const platforms = info.keys.filter((saved) => !searchKeys.has(saved.env));
	const onThisMachine = info.models.filter((model) => !platforms.some((saved) => saved.env === model.env));
	const bound = (saved: { env: string; name: string }) => ({ env: saved.env, name: saved.name, custom: saved.env.startsWith("CUSTOM"), protocol: info.models.find((model) => model.env === saved.env)?.protocol ?? "openai" as const });
	const row = (model: ShellInfo["models"][number]) => (
		<div key={model.id} className="group-model">
			<span>{model.displayName}{model.protocol ? <span className="setting-note"> · {WIRE[model.protocol]}</span> : null}</span>
			<span className="row-acts">
				{model.contextWindow != null && model.thinking ? <button type="button" className="link stay" onClick={() => setEditing({ id: model.id, contextWindow: model.contextWindow!, thinking: model.thinking!, ...(model.protocol ? { protocol: model.protocol } : {}) })}>编辑</button> : null}
				{info.addedModels.includes(model.id) ? <button type="button" className="link" onClick={() => void ask({ type: "removeModel", id: model.id }).then((next) => onInfo(next as ShellInfo))}>移除</button> : null}
			</span>
		</div>
	);
	return (
		<>
			<div className="section-head"><h2>模型</h2><button type="button" className="link" onClick={() => onAdding(true)}>添加模型</button></div>
			{platforms.map((saved) => (
				<div key={saved.env} className="model-group">
					<KeyRow saved={saved} balance={saved.env === info.key.env ? balance : null} ask={ask} onInfo={onInfo} />
					{info.models.filter((model) => model.env === saved.env).map(row)}
					<span className="group-links">
						<button type="button" className="link" onClick={() => setListing(bound(saved))}>获取模型</button>
						<button type="button" className="link" onClick={() => setOnto(bound(saved))}>添加模型</button>
					</span>
				</div>
			))}
			{onThisMachine.length ? <div className="model-group"><div className="group-head"><span className="setting-name">本机</span></div>{onThisMachine.map(row)}</div> : null}
			{sheet.shown ? <Sheet title="添加模型" leaving={sheet.leaving} onClose={() => onAdding(false)}><AddModel info={info} ask={ask} onInfo={onInfo} onDone={() => onAdding(false)} /></Sheet> : null}
			{ontoSheet.shown && ontoNow ? <Sheet title={`添加到 ${ontoNow.name}`} leaving={ontoSheet.leaving} onClose={() => setOnto(null)}><AddModel info={info} ask={ask} onInfo={onInfo} onto={ontoNow} onDone={() => setOnto(null)} /></Sheet> : null}
			{listingSheet.shown && listingNow ? <Sheet title={`${listingNow.name} 的模型`} leaving={listingSheet.leaving} onClose={() => setListing(null)}><RemoteModels env={listingNow.env} custom={listingNow.custom} wire={listingNow.protocol} have={new Set(info.models.filter((model) => model.env === listingNow.env).map((model) => model.id))} ask={ask} onInfo={onInfo} onClose={() => setListing(null)} /></Sheet> : null}
			{editingSheet.shown && editingNow ? <Sheet title="编辑模型" leaving={editingSheet.leaving} onClose={() => setEditing(null)}><EditModel model={editingNow} ask={ask} onInfo={onInfo} onDone={() => setEditing(null)} /></Sheet> : null}
		</>
	);
}
