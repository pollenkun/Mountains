/**
 * The first screen, when nothing can run yet: pick a platform, paste a key, and Mountains adds a model.
 * A platform with a known model uses that one. Any other address asks for the model id.
 */
import { useState, type FormEvent } from "react";
import type { ShellInfo } from "./Bar.tsx";
import { Star } from "./icons.tsx";
import { useI18n } from "./i18n.tsx";

type Ask = (request: { type: string; [key: string]: unknown }) => Promise<unknown>;

const CUSTOM = "custom";
const DEFAULT_MODEL: Record<string, string> = {
	deepseek: "deepseek-flash",
	zhipu: "glm-5.3-flash",
	moonshot: "kimi-k2.7-code",
};
const SITE: Record<string, { label: string; url: string }> = {
	deepseek: { label: "前往 DeepSeek 开放平台", url: "https://platform.deepseek.com/api_keys" },
	zhipu: { label: "前往智谱开放平台", url: "https://open.bigmodel.cn/usercenter/apikeys" },
	moonshot: { label: "前往 Moonshot 开放平台", url: "https://platform.moonshot.cn/console/api-keys" },
	openai: { label: "前往 OpenAI", url: "https://platform.openai.com/api-keys" },
	gemini: { label: "前往 Google AI Studio", url: "https://aistudio.google.com/apikey" },
	qwen: { label: "前往阿里云百炼", url: "https://bailian.console.aliyun.com/" },
	siliconflow: { label: "前往硅基流动", url: "https://cloud.siliconflow.cn/account/ak" },
	openrouter: { label: "前往 OpenRouter", url: "https://openrouter.ai/keys" },
	xai: { label: "前往 xAI", url: "https://console.x.ai/" },
	anthropic: { label: "前往 Anthropic Console", url: "https://console.anthropic.com/settings/keys" },
};

const reason = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);

const ENV_SITE: Record<string, { name: string; url: string }> = {
	DEEPSEEK_API_KEY: { name: "DeepSeek", url: SITE.deepseek!.url },
	ZHIPU_API_KEY: { name: "智谱", url: SITE.zhipu!.url },
	MOONSHOT_API_KEY: { name: "Moonshot", url: SITE.moonshot!.url },
	OPENAI_API_KEY: { name: "OpenAI", url: SITE.openai!.url },
	GEMINI_API_KEY: { name: "Google", url: SITE.gemini!.url },
	QWEN_API_KEY: { name: "阿里云百炼", url: SITE.qwen!.url },
	SILICONFLOW_API_KEY: { name: "硅基流动", url: SITE.siliconflow!.url },
	OPENROUTER_API_KEY: { name: "OpenRouter", url: SITE.openrouter!.url },
	XAI_API_KEY: { name: "xAI", url: SITE.xai!.url },
	ANTHROPIC_API_KEY: { name: "Anthropic", url: SITE.anthropic!.url },
};

/** Where to add credit for the key this run is using. */
export function billingLink(env: string): { name: string; url: string } | null {
	return ENV_SITE[env] ?? null;
}

export function FirstRun({ info, ask, onInfo }: { info: ShellInfo; ask: Ask; onInfo: (info: ShellInfo) => void }) {
	const { t } = useI18n();
	const [platform, setPlatform] = useState(info.platforms[0]?.id ?? CUSTOM);
	const [key, setKey] = useState("");
	const [modelId, setModelId] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [error, setError] = useState("");
	const custom = platform === CUSTOM;
	const known = DEFAULT_MODEL[platform];
	const site = SITE[platform];
	const ready = key.trim() && (custom ? baseUrl.trim() && modelId.trim() : known || modelId.trim());
	const open = (url: string) => { void ask({ type: "open", url }); };
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!ready) return;
		setError("");
		const id = known || modelId.trim();
		void ask({ type: "addModel", id, key, ...(custom ? { baseUrl, protocol: "openai" } : { platform }), thinking: known ? "tiers" : "off" })
			.then((next) => onInfo(next as ShellInfo), (failure: unknown) => setError(reason(failure)));
	};
	const skip = () => {
		setError("");
		void ask({ type: "skipSetup" }).then((next) => onInfo(next as ShellInfo), (failure: unknown) => setError(reason(failure)));
	};
	return (
		<div className="first-run">
			<div className="first-mark"><Star size={48} /><h1>Mountains</h1><p>{t("connect")}</p></div>
			<form onSubmit={submit}>
				<label className="first-field"><span>{t("provider")}</span>
					<select className="select" value={platform} onChange={(event) => setPlatform(event.target.value)}>
						{info.platforms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
						<option value={CUSTOM}>{t("custom")}</option>
					</select>
				</label>
				{custom || !known ? (
					<label className="first-field"><span>{t("modelName")}</span>
						<input value={modelId} spellCheck={false} onChange={(event) => setModelId(event.target.value)} />
					</label>
				) : null}
				{custom ? (
					<label className="first-field"><span>{t("baseUrl")}</span>
						<input value={baseUrl} placeholder="https://example.com/v1" spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} />
					</label>
				) : null}
				<label className="first-field"><span>{t("apiKey")}</span>
					<input type="password" placeholder="sk-…" value={key} onChange={(event) => setKey(event.target.value)} />
					{site ? <button type="button" className="link" onClick={() => open(site.url)}>{site.label}</button> : null}
				</label>
				{error ? <p className="setting-error">{error}</p> : null}
				<button type="submit" className="allow" disabled={!ready}>{t("continue")}</button>
				<button type="button" className="first-skip" onClick={skip}>{t("skip")}</button>
			</form>
		</div>
	);
}
