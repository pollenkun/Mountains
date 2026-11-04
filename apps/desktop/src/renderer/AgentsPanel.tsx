/**
 * The side panel for UltraCode: the team, and any member's own conversation. The conversation in the middle stays
 * the lead's, so a busy team does not crowd it; the side panel is where details are read.
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Cross } from "./icons.tsx";
import { Reply } from "./siui/Reply.tsx";
import { ThinkingRow } from "./Thinking.tsx";
import { ToolBlock } from "./Tools.tsx";
import { blocks, type Transcript } from "./transcript.ts";
import { useI18n } from "./i18n.tsx";

/** A task opens with the note that tells the agent what it is; here only what it was asked shows. */
const taskOf = (text: string) => {
	const found = [...text.matchAll(/<agent_message[^>]*>\n?([\s\S]*?)\n?<\/agent_message>/g)];
	return found.length ? found.map((m) => m[1]!).join("\n\n") : text;
};

function AgentLog({ log, folded }: { log: Transcript; folded: boolean }) {
	return (
		<div className="agent-log">
			{blocks(log.items, folded).map((block) => {
				if (block.type === "tools") return <ToolBlock key={block.id} calls={block.calls} folded={folded} />;
				const item = block.item;
				if (item.type === "thinking") return <ThinkingRow key={item.id} text={item.text} startedAt={item.startedAt} {...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {})} />;
				if (item.type === "assistant") return <div key={item.id} className="msg assistant"><div className="bubble assistant"><Reply text={item.text} live={log.open === item.id} /></div></div>;
				if (item.type === "user") return <div key={item.id} className="msg user"><p className="bubble user">{taskOf(item.text)}</p></div>;
				if (item.type === "revision") return null;
				return <p key={item.id} className={`bubble ${item.type}`}>{item.text}</p>;
			})}
		</div>
	);
}

const WIDTH_KEY = "mountains.agents.width";
const clampWidth = (width: number) => Math.round(Math.min(Math.max(280, width), Math.max(320, window.innerWidth * 0.6)));

/** `name` null lists the team; a name shows that member. */
export function AgentsPanel({ state, name, folded, onOpen, onClose }: { state: Transcript; name: string | null; folded: boolean; onOpen: (name: string | null) => void; onClose: () => void }) {
	const { t } = useI18n();
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				event.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", key, true);
		return () => window.removeEventListener("keydown", key, true);
	}, [onClose]);
	// Narrow by default, and as wide as the user last pulled it.
	const [width, setWidth] = useState(() => {
		try { return clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || 360); } catch { return 360; }
	});
	// Followed on the window: the pointer leaves the thin edge at once.
	const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const fromX = event.clientX, fromWidth = width;
		let last = width;
		const move = (moved: PointerEvent) => { last = clampWidth(fromWidth + fromX - moved.clientX); setWidth(last); };
		const end = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			document.documentElement.classList.remove("resizing");
			try { localStorage.setItem(WIDTH_KEY, String(last)); } catch { /* the width stays for this window only */ }
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
		document.documentElement.classList.add("resizing");
	};
	const names = [...new Set([...Object.keys(state.purposes), ...Object.keys(state.agents)])];
	const log = name ? state.agents[name] : undefined;
	return (
		<aside className="changes agents-panel" aria-label="Agent" style={{ flexBasis: width }}>
			<div className="panel-edge" role="separator" aria-orientation="vertical" aria-label={t("adjustWidth")} onPointerDown={startDrag} />
			<header className="changes-head drag">
				{name ? <button type="button" className="ghost" onClick={() => onOpen(null)}>{t("allAgents")}</button> : null}
				<span className="changes-title">{name ?? "Agent"}</span>
				<span className="grow" />
				<button type="button" className="act" aria-label={t("close")} onClick={onClose}><Cross /></button>
			</header>
			{name ? (
				<div className="agents-body">
					{state.purposes[name] ? <p className="agent-purpose">{state.purposes[name]}</p> : null}
					{log ? <AgentLog log={log} folded={folded} /> : <p className="changes-empty">{t("notStarted")}</p>}
				</div>
			) : (
				<div className="agents-body">
					{names.map((agent) => {
						const working = state.agents[agent]?.running === true;
						return (
							<button key={agent} type="button" className="agent-row" onClick={() => onOpen(agent)}>
								<span className="agent-name">{agent}</span>
								<span className={working ? "agent-state shimmer" : "agent-state"}>{working ? t("working") : t("finished")}</span>
								<span className="agent-purpose">{state.purposes[agent]}</span>
							</button>
						);
					})}
				</div>
			)}
		</aside>
	);
}
