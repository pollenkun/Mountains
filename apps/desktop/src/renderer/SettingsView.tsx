/** 设置 (the Settings board): 通用, 模型, 审批 and 记忆. Sections the app cannot act on yet are left out. */
import { useEffect, useState } from "react";
import type { ShellInfo, ShellRequest } from "./Bar.tsx";
import type { DockSide } from "./Dock.tsx";
import { UpdateSettings } from "./UpdateSettings.tsx";
import { MemorySection } from "./MemoryView.tsx";
import { ModelsPart, WebPart } from "./ModelsPart.tsx";
import type { Looks } from "./theme.ts";
import { Reveal } from "./Motion.tsx";
import { useI18n, type LangChoice } from "./i18n.tsx";

function folded(): boolean {
	try { return localStorage.getItem("mountains.tools.folded") !== "false"; } catch { return true; }
}

const SIDES: { id: DockSide; label: string }[] = [{ id: "left", label: "左" }, { id: "right", label: "右" }, { id: "top", label: "上" }, { id: "bottom", label: "下" }];

const MODES: { id: ShellInfo["mode"]; label: string }[] = [{ id: "system", label: "跟随系统" }, { id: "light", label: "浅色" }, { id: "dark", label: "深色" }];

type Ask = (request: ShellRequest | { type: string; [key: string]: unknown }) => Promise<unknown>;

export function SettingsView({ info, ask, onInfo, dockSide, onDockSide, themes, onTheme, adding, onAdding, onConfigureSearch }: { adding: boolean; onAdding: (adding: boolean) => void; info: ShellInfo | null; ask: Ask; onInfo: (info: ShellInfo) => void; dockSide: DockSide; onDockSide: (side: DockSide) => void; themes: Looks | null; onTheme: (theme: string | null) => void; onConfigureSearch: () => void }) {
	const [fold, setFold] = useState(folded);
	const [balance, setBalance] = useState<string | null>(null);
	const { t, choice, setLang } = useI18n();
	const [about, setAbout] = useState<{ version: string; dataDir: string; updateFeed?: string; updateChannel?: "stable" | "preview"; autoUpdate?: boolean } | null>(null);
	const [skills, setSkills] = useState<{ name: string; description: string; mode?: "allow" | "ask" }[]>([]);
	useEffect(() => { void ask({ type: "balance" }).then((value) => setBalance(typeof value === "string" ? value : null)); }, [ask, info?.key.masked]);
	useEffect(() => {
		void ask({ type: "about" }).then((value) => {
			const next = value as { version: string; dataDir: string; updateFeed?: string; updateChannel?: "stable" | "preview"; autoUpdate?: boolean };
			setAbout(next);
		});
		void ask({ type: "skills" }).then((value) => setSkills(value as { name: string; description: string; mode?: "allow" | "ask" }[]));
	}, [ask]);
	if (!info) return null;
	return (
		<div className="settings-view">
			<section>
				<h2>{t("general")}</h2>
				{themes ? (
					<div className="setting">
						<span className="setting-name">外观</span>
						<select className="select" aria-label="外观" value={themes.current ?? ""} onChange={(event) => onTheme(event.target.value || null)}>
							<option value="">默认</option>
							{themes.current && !themes.themes.some((t) => t.json === themes.current) ? <option value={themes.current}>已保留的外观</option> : null}
							{themes.themes.map((t) => <option key={t.name} value={t.json}>{t.name}</option>)}
						</select>
					</div>
				) : null}
				<div className="setting">
					<span className="setting-name">{t("mode")}</span>
					<div className="segmented" role="radiogroup" aria-label={t("mode")}>
						{MODES.map((mode) => <button key={mode.id} type="button" role="radio" aria-checked={info.mode === mode.id} className={info.mode === mode.id ? "on" : undefined} onClick={() => void ask({ type: "mode", mode: mode.id }).then((next) => onInfo(next as ShellInfo))}>{t(mode.id === "system" ? "followSystem" : mode.id === "light" ? "light" : "dark")}</button>)}
					</div>
				</div>
				<div className="setting">
					<span className="setting-name">{t("dock")}</span>
					<div className="segmented" role="radiogroup" aria-label={t("dock")}>
						{SIDES.map((side) => <button key={side.id} type="button" role="radio" aria-checked={dockSide === side.id} className={dockSide === side.id ? "on" : undefined} onClick={() => onDockSide(side.id)}>{t(side.id)}</button>)}
					</div>
				</div>
				<label className="setting">
					<span className="setting-name">{t("foldTools")}</span>
					<input type="checkbox" role="switch" className="switch" checked={fold} onChange={(event) => {
						setFold(event.target.checked);
						try { localStorage.setItem("mountains.tools.folded", String(event.target.checked)); } catch { /* the setting stays for this window only */ }
					}} />
				</label>
				{info.siui !== undefined ? (
					<label className="setting">
						<span><span className="setting-name">{t("siui")}</span><span className="setting-note">{t("siuiNote")}</span></span>
						<input type="checkbox" role="switch" className="switch" checked={info.siui}
							onChange={(event) => void ask({ type: "siui", enabled: event.target.checked }).then((next) => onInfo(next as ShellInfo))} />
					</label>
				) : null}
				{info.titles ? (
					<>
						<label className="setting">
							<span className="setting-name">{t("titles")}</span>
							<input type="checkbox" role="switch" className="switch" checked={info.titles.enabled}
								onChange={(event) => void ask({ type: "titles", enabled: event.target.checked }).then((next) => onInfo(next as ShellInfo))} />
						</label>
						<Reveal open={info.titles.enabled}>
							<label className="setting">
								<span className="setting-name">{t("titleModel")}</span>
								<select className="select" value={info.titles.model.follows ? "" : info.titles.model.id}
									onChange={(event) => void ask({ type: "titles", model: event.target.value || null }).then((next) => onInfo(next as ShellInfo))}>
									<option value="">{info.ready ? `${t("followModel")} (${info.displayName})` : t("followModel")}</option>
									{info.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
								</select>
							</label>
						</Reveal>
					</>
				) : null}
				<div className="setting">
					<span className="setting-name">{t("language")}</span>
					<div className="segmented" role="radiogroup" aria-label={t("language")}>
						{([["system", "langSystem"], ["zh", "langZh"], ["en", "langEn"]] as const).map(([id, label]) => (
							<button key={id} type="button" role="radio" aria-checked={choice === id} className={choice === id ? "on" : undefined} onClick={() => setLang(id as LangChoice)}>{t(label)}</button>
						))}
					</div>
				</div>
				<UpdateSettings ask={ask} version={about?.version ?? "0.2.0 Preview 2"} />
				<div className="setting">
					<span><span className="setting-name">{t("dataDir")}</span><span className="setting-note mono">{about?.dataDir ?? "~/.mountains/desktop"}</span></span>
					<button type="button" className="link" onClick={() => void ask({ type: "reveal", what: "data" })}>{document.documentElement.dataset.platform === "win" ? t("showInExplorer") : t("showInFolder")}</button>
				</div>
				<label className="setting"><span className="setting-name">{t("agentLimit")}</span>
					<input className="add-input agents-limit" inputMode="numeric" placeholder={t("noLimit")} aria-label={t("agentLimit")} value={info.maxAgents ?? ""}
						onChange={(event) => { const n = Number(event.target.value.replace(/\D/g, "")); void ask({ type: "team", maxAgents: n ? Math.min(32, n) : null }).then((next) => onInfo(next as ShellInfo)); }} />
				</label>
			</section>
			<section>
				<ModelsPart info={info} ask={ask as never} onInfo={onInfo} balance={balance} adding={adding} onAdding={onAdding} />
			</section>
			<section>
				<div className="section-head"><h2>{t("skills")}</h2><button type="button" className="link" onClick={() => void ask({ type: "reveal", what: "skills" })}>{t("openSkills")}</button></div>
				{skills.length ? <div className="skills-list">{skills.map((skill) => (
					<div key={skill.name} className="skill-row">
						<details className="skill-details">
							<summary className="skill-summary">
								<span className="skill-chevron" aria-hidden="true">›</span>
								<span className="skill-copy">
									<span className="skill-name">{skill.name}</span>
									<span className="skill-preview" aria-hidden="true">{skill.description}</span>
								</span>
							</summary>
							<p className="skill-description">{skill.description}</p>
						</details>
						<select className="select skill-mode" aria-label={`${skill.name} · ${t("skills")}`} value={skill.mode === "ask" ? "ask" : "allow"} onChange={(event) => {
							const mode = event.target.value as "allow" | "ask";
							setSkills((now) => now.map((item) => item.name === skill.name ? { ...item, mode } : item));
							void ask({ type: "skillMode", name: skill.name, mode });
						}}>
							<option value="allow">{t("skillAllow")}</option>
							<option value="ask">{t("skillAsk")}</option>
						</select>
					</div>
				))}</div> : <p className="setting-note">{t("noSkills")}</p>}
			</section>
			<section>
				<h2>{t("web")}</h2>
				<WebPart info={info} ask={ask as never} onInfo={onInfo} onConfigureSearch={onConfigureSearch} />
			</section>
			<section>
				<h2>{t("approvalSection")}</h2>
				{info.approvalModel ? (
					<>
						<label className="setting">
							<span className="setting-name">{t("approvalModel")}</span>
							<select className="select" value={info.approvalModel.follows ? "" : info.approvalModel.id}
								onChange={(event) => void ask({ type: "approvalModel", model: event.target.value || null }).then((next) => onInfo(next as ShellInfo))}>
								<option value="">{info.ready ? `${t("followModel")} (${info.displayName})` : t("followModel")}</option>
								{info.reviewModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
							</select>
						</label>
						<div className="setting">
							<span className="setting-name">{t("approvalEffort")}</span>
							{(info.approvalTiers?.length ?? 0) > 0 ? (
								<div className="segmented" role="radiogroup" aria-label="审批思考强度">
									<button type="button" role="radio" aria-checked={!info.approvalEffort} className={!info.approvalEffort ? "on" : undefined}
										onClick={() => void ask({ type: "approvalEffort", effort: null }).then((next) => onInfo(next as ShellInfo))}>
										{t("defaultLowest")}
									</button>
									{info.approvalTiers!.map((t) => (
										<button key={t.id} type="button" role="radio" aria-checked={info.approvalEffort === t.id} className={info.approvalEffort === t.id ? "on" : undefined}
											onClick={() => void ask({ type: "approvalEffort", effort: t.id }).then((next) => onInfo(next as ShellInfo))}>
											{t.label}
										</button>
									))}
								</div>
							) : (
								<span className="setting-value">{t("fixed")} ({info.approvalDefaultLabel ?? t("defaultLowest")})</span>
							)}
						</div>
					</>
				) : null}
			</section>
			<MemorySection ask={ask as never} />
		</div>
	);
}
