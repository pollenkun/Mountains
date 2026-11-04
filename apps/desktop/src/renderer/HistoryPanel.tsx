/** 聊天记录, as the dock opens it: recent conversations by day, and a field that searches all of them. */
import { useEffect, useState } from "react";
import { day, when, type Conversation } from "./Conversations.tsx";
import { Search } from "./icons.tsx";
import { useI18n } from "./i18n.tsx";

interface Hit { id: string; title: string; updatedAt: number; byUser: boolean; before: string; match: string; after: string }

const LIMIT = 30;

function Mark({ status }: { status: Conversation["status"] }) {
	const { t } = useI18n();
	if (status === "running") return <span className="mark running" aria-label={t("runningMark")} />;
	if (status === "waiting") return <span className="mark waiting" aria-label={t("waitingMark")} />;
	return null;
}

export function HistoryPanel({ ask, list, active, renaming, deleting, onOpen, onAll, onMenu, onRename, onDelete, onCancelDelete }: {
	ask: (request: { type: "search"; query: string }) => Promise<unknown>;
	list: Conversation[]; active: string | null; renaming: string | null; deleting: string | null;
	onOpen: (id: string) => void; onAll: () => void; onMenu: (id: string, x: number, y: number) => void;
	onRename: (id: string, title: string | null) => void; onDelete: (id: string) => void; onCancelDelete: () => void;
}) {
	const { t, lang } = useI18n();
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<Hit[] | null>(null);
	useEffect(() => {
		if (!query.trim()) { setHits(null); return; }
		// Typing settles before the files are read.
		const timer = setTimeout(() => { void ask({ type: "search", query }).then((next) => setHits(next as Hit[])); }, 180);
		return () => clearTimeout(timer);
	}, [query, ask]);
	const shown = list.filter((conversation) => !conversation.archived).slice(0, LIMIT);
	const groups = new Map<string, Conversation[]>();
	for (const conversation of shown) { const label = day(conversation.updatedAt, new Date(), lang); groups.set(label, [...(groups.get(label) ?? []), conversation]); }
	return (
		<div className="history">
			<label className="history-search"><Search /><input type="search" placeholder={t("search")} aria-label={t("searchAll")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
			{hits ? (
				hits.length ? hits.map((hit) => (
					<button key={hit.id} type="button" className="hrow hit" onClick={() => onOpen(hit.id)}>
						<span className="hrow-title">{hit.title || t("newChat")}</span>
						{hit.match ? <span className="hit-snippet">{hit.byUser ? t("youPrefix") : ""}{hit.before}<mark>{hit.match}</mark>{hit.after}</span> : null}
					</button>
				)) : <p className="history-empty">{t("notFound")}</p>
			) : <>
			{!shown.length ? <p className="history-empty">{t("noChatsYet")}</p> : null}
			{[...groups].map(([label, rows]) => (
				<section key={label}>
					<div className="ph">{label}</div>
					{rows.map((conversation) => renaming === conversation.id ? (
						<input key={conversation.id} className="rename history-rename" autoFocus defaultValue={conversation.title} aria-label={t("newName")}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
								if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.value = conversation.title; event.currentTarget.blur(); }
							}}
							onBlur={(event) => { const value = event.currentTarget.value; onRename(conversation.id, value.trim() && value !== conversation.title ? value : null); }} />
					) : deleting === conversation.id ? (
						<span key={conversation.id} className="history-confirm">
							<span>{t("deleteAsk", { name: conversation.title || t("newChat") })}</span>
							<button type="button" className="danger" onClick={() => onDelete(conversation.id)}>{t("delete")}</button>
							<button type="button" onClick={onCancelDelete}>{t("cancel")}</button>
						</span>
					) : (
						<button key={conversation.id} type="button" className={conversation.id === active ? "hrow current" : "hrow"} title={conversation.title || t("newChat")}
							onClick={() => onOpen(conversation.id)} onContextMenu={(event) => { event.preventDefault(); onMenu(conversation.id, event.clientX, event.clientY); }}>
							<span className={conversation.status === "idle" ? "hrow-title" : "hrow-title shimmer"}>{conversation.title || t("newChat")}</span>
							<Mark status={conversation.status} />
							{conversation.status === "idle" ? <small>{when(conversation.updatedAt, lang)}</small> : null}
						</button>
					))}
				</section>
			))}
			<button type="button" className="hrow all" onClick={onAll}>{t("allConversations")}</button>
			</>}
		</div>
	);
}
