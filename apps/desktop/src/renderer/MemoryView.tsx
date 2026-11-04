/** The 记忆 section of Settings: whether the model may read earlier conversations, and the user's own AGENTS.md. */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n.tsx";

type Ask = (request: { type: string; [key: string]: unknown }) => Promise<unknown>;

export function MemorySection({ ask }: { ask: Ask }) {
	const { t } = useI18n();
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [agentsWrite, setAgentsWrite] = useState(true);
	const [agentsNext, setAgentsNext] = useState(false);
	const [choosing, setChoosing] = useState(false);
	const [arming, setArming] = useState(false);
	const [text, setText] = useState("");
	const saved = useRef("");
	useEffect(() => {
		void ask({ type: "memory" }).then((value) => {
			const memory = value as { enabled: boolean; agents: string; agentsWrite?: boolean; agentsNext?: boolean };
			setEnabled(memory.enabled);
			setAgentsWrite(memory.agentsWrite !== false);
			setAgentsNext(memory.agentsNext === true);
			setText(memory.agents);
			saved.current = memory.agents;
		});
	}, [ask]);
	// Edits are saved shortly after typing stops, and when the field loses focus.
	useEffect(() => {
		if (text === saved.current) return;
		const timer = setTimeout(() => { saved.current = text; void ask({ type: "setAgents", text }); }, 600);
		return () => clearTimeout(timer);
	}, [text, ask]);
	return (
		<section>
			<h2>{t("memory")}</h2>
			<label className="setting">
				<span><span className="setting-name">{t("memoryOn")}</span><span className="setting-note">{t("memoryOnNote")}</span></span>
				<input type="checkbox" role="switch" className="switch" checked={enabled ?? false} disabled={enabled === null}
					onChange={(event) => { const next = event.target.checked; setEnabled(next); void ask({ type: "setMemory", enabled: next }); }} />
			</label>
			<div className="setting agents-when">
				<span><span className="setting-name">{t("agentsWrite")}</span>{agentsNext ? <span className="setting-note">{t("agentsNext")}</span> : null}</span>
				<input type="checkbox" role="switch" className="switch" checked={agentsWrite || agentsNext || arming}
					onChange={(event) => {
						if (!event.target.checked) { setArming(false); setChoosing(false); setAgentsWrite(false); setAgentsNext(false); void ask({ type: "agentsWrite", enabled: false }); return; }
						setArming(true);
						setChoosing(true);
					}} />
				{choosing ? (
					<span className="when-menu">
						<button type="button" className="allow" onClick={() => { setArming(false); setAgentsWrite(true); setAgentsNext(false); setChoosing(false); void ask({ type: "agentsWrite", enabled: true, when: "now" }); }}>{t("agentsNow")}</button>
						<button type="button" className="deny" onClick={() => { setArming(false); setAgentsWrite(false); setAgentsNext(true); setChoosing(false); void ask({ type: "agentsWrite", enabled: true, when: "next" }); }}>{t("agentsNextButton")}</button>
					</span>
				) : null}
			</div>
			<label className="agents">
				<span className="setting-name">AGENTS.md</span>
				<textarea id="agents-md" placeholder={t("agentsPlaceholder")} value={text} onChange={(event) => setText(event.target.value)}
					onBlur={() => { if (text !== saved.current) { saved.current = text; void ask({ type: "setAgents", text }); } }} />
				{text.length > 8_000 ? <span className="setting-note">{t("agentsLong")}</span> : null}
			</label>
		</section>
	);
}
