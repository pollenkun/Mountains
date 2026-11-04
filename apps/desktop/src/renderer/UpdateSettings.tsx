import { useEffect, useState } from "react";
import { useI18n } from "./i18n.tsx";
import type { UpdatePreferences, UpdateState } from "../update-types.ts";

type Ask = (request: { type: string; [key: string]: unknown }) => Promise<unknown>;
export function updateMessage(state: UpdateState, en: boolean): string {
	const version = state.version ?? "";
	switch (state.phase) {
		case "idle": return "";
		case "checking": return en ? "Checking…" : "正在检查…";
		case "latest": return en ? "Up to date" : "已是最新版本";
		case "unpublished": return en ? "No update has been published yet" : "还没有发布更新";
		case "available": return en ? `${version} is available` : `${version} 可更新`;
		case "downloading": return en ? `Downloading ${state.percent ?? 0}%` : `正在下载 ${state.percent ?? 0}%`;
		case "ready": return state.installMode === "manual" ? (en ? "Downloaded. Open the installer to replace the app." : "已下载，打开安装包后手动替换应用。") : state.busy ? (en ? "Downloaded. Finish running tasks before restarting." : "已下载，任务结束后可以重启更新。") : (en ? "Ready to install" : "已下载，可以重启更新");
		case "error": return state.error === "TASKS_RUNNING" ? (en ? "Finish running tasks first" : "请先结束正在运行的任务") : (en ? "Update failed. Try again." : "更新失败，请重试");
	}
}
export function UpdateSettings({ ask, version }: { ask: Ask; version: string }) {
	const { lang, t } = useI18n(); const en = lang === "en";
	const [prefs, setPrefs] = useState<UpdatePreferences>({ channel: "preview", source: "auto", automatic: false });
	const [status, setStatus] = useState<UpdateState>({ phase: "idle", installMode: "manual", busy: false });
	const [error, setError] = useState("");
	useEffect(() => {
		void ask({ type: "about" }).then(value => {
			const info = value as { updateChannel: UpdatePreferences["channel"]; updateSource: UpdatePreferences["source"]; autoUpdate: boolean };
			setPrefs({ channel: info.updateChannel, source: info.updateSource, automatic: info.autoUpdate });
		});
		const poll = () => { void ask({ type: "updateState" }).then(value => { if (value) setStatus(value as UpdateState); }); };
		poll(); const timer = setInterval(poll, 1500); return () => clearInterval(timer);
	}, [ask]);
	const run = async (type: string) => {
		setError("");
		try { const next = await ask({ type }); if (next) setStatus(next as UpdateState); }
		catch (error) { setError(String(error).includes("TASKS_RUNNING") ? (en ? "Finish running tasks first" : "请先结束正在运行的任务") : (en ? "Could not complete the update" : "更新没有完成，请重试")); }
	};
	const change = async (next: UpdatePreferences, request: { type: string; [key: string]: unknown }) => {
		try { await ask(request); setPrefs(next); setError(""); if (request.type !== "setAutoUpdate") setStatus({ phase: "idle", installMode: status.installMode, busy: status.busy }); }
		catch (error) { setError(String(error).includes("UPDATE_IN_PROGRESS") ? (en ? "Wait for the current download to finish" : "请等当前下载结束后再修改") : (en ? "Could not save settings" : "设置没有保存，请重试")); }
	};
	const working = status.phase === "checking" || status.phase === "downloading";
	return <>
		<label className="setting"><span className="setting-name">{t("autoUpdate")}</span><input type="checkbox" role="switch" className="switch" checked={prefs.automatic} onChange={event => void change({ ...prefs, automatic: event.target.checked }, { type: "setAutoUpdate", enabled: event.target.checked })} /></label>
		<div className="setting"><span className="setting-name">{t("updateChannel")}</span><div className="segmented" role="radiogroup" aria-label={t("updateChannel")}>
			{(["stable", "preview"] as const).map(channel => <button key={channel} type="button" role="radio" disabled={working} aria-checked={prefs.channel === channel} className={prefs.channel === channel ? "on" : undefined} onClick={() => void change({ ...prefs, channel }, { type: "setUpdateChannel", channel })}>{t(channel === "stable" ? "channelStable" : "channelPreview")}</button>)}
		</div></div>
		<label className="setting"><span className="setting-name">{en ? "Download source" : "下载源"}</span><select className="select" disabled={working} value={prefs.source} onChange={event => { const source = event.target.value as UpdatePreferences["source"]; void change({ ...prefs, source }, { type: "setUpdateSource", source }); }}>
			<option value="auto">{en ? "Automatic" : "自动"}</option><option value="hk">CDN</option><option value="github">GitHub</option>
		</select></label>
		<div className="setting"><span><span className="setting-name">Mountains {version}</span><span className="setting-note" role="status">{error || updateMessage(status, en)}</span></span>
			<div className="key-acts">
				{status.phase === "ready" ? <button type="button" className="link" disabled={status.busy} onClick={() => void run("installUpdate")}>{status.installMode === "manual" ? (en ? "Open installer" : "打开安装包") : (en ? "Restart and update" : "重启并更新")}</button> : status.phase === "available" || (status.phase === "error" && status.version) ? <button type="button" className="link" onClick={() => void run("downloadUpdate")}>{en ? "Download update" : "下载更新"}</button> : null}
				<button type="button" className="link" disabled={working} onClick={() => void run("checkUpdate")}>{t("checkUpdate")}</button>
			</div>
		</div>
	</>;
}
