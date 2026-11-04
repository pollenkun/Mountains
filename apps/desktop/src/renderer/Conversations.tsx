/** 所有对话: filters, date groups, search by title, and a right-click menu per row (the Conversations board). */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n, type Lang } from "./i18n.tsx";
import type { DeskRequest } from "./App.tsx";
import { ConversationMenu, type MenuAt } from "./ConversationMenu.tsx";
import type { Goal } from "../main/modes.ts";

export interface Conversation {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	status: "idle" | "running" | "waiting";
	pinned: boolean;
	archived: boolean;
	workspace: string;
	group?: string;
	plan?: boolean;
	goal?: Goal;
	/** When the last run finished. */
	finishedAt?: number;
}

type Filter = "all" | "running" | "archived";

export function day(at: number, now = new Date(), lang: Lang = "zh"): string {
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (at >= midnight) return lang === "en" ? "Today" : "今天";
	if (at >= midnight - 86_400_000) return lang === "en" ? "Yesterday" : "昨天";
	return lang === "en" ? "Earlier" : "更早";
}

export function when(at: number, lang: Lang = "zh"): string {
	const d = new Date(at);
	const bucket = day(at, new Date(), lang);
	const today = lang === "en" ? "Today" : "今天";
	const yesterday = lang === "en" ? "Yesterday" : "昨天";
	if (bucket === today) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	if (bucket === yesterday) return yesterday;
	return lang === "en" ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function shortPath(path: string): string {
	const home = /^\/Users\/[^/]+/.exec(path)?.[0] ?? /^C:\\Users\\[^\\]+/i.exec(path)?.[0];
	return home ? `~${path.slice(home.length)}` : path;
}

/** The folder's own name; the whole path is in its tooltip. */
function folderName(path: string): string {
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

export function AllConversations({ list, ask, onOpen, onChanged }: { list: Conversation[]; ask: (request: DeskRequest) => Promise<unknown>; onOpen: (id: string) => void; onChanged: (list: Conversation[]) => void }) {
	const { t, lang } = useI18n();
	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const [menu, setMenu] = useState<MenuAt | null>(null);
	const [group, setGroup] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const search = useRef<HTMLInputElement>(null);
	useEffect(() => { search.current?.focus(); }, []);

	const change = (request: DeskRequest) => void ask(request).then((next) => onChanged(next as Conversation[]));
	const runningCount = list.filter((c) => c.status !== "idle").length;
	const needle = query.trim().toLowerCase();
	const named = [...new Set(list.filter((c) => !c.archived && c.group).map((c) => c.group!))];
	const shown = list.filter((c) => (filter === "archived" ? c.archived : !c.archived) && (filter !== "running" || c.status !== "idle") && (!group || c.group === group) && (!needle || (c.title || t("newChat")).toLowerCase().includes(needle)));
	const groups = new Map<string, Conversation[]>();
	for (const c of shown) groups.set(day(c.updatedAt, new Date(), lang), [...(groups.get(day(c.updatedAt, new Date(), lang)) ?? []), c]);

	return (
		<div className="all">
			<header className="all-head drag">
				<h1>{t("allConversations")}</h1>
				<input ref={search} className="all-search" type="search" placeholder={t("search")} aria-label={t("searchAll")} value={query} onChange={(event) => setQuery(event.target.value)} />
				<div className="segmented" role="tablist">
					{([["all", "allFilter"], ["running", "runningFilter"], ["archived", "archivedFilter"]] as const).map(([id, label]) => (
						<button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "on" : undefined} onClick={() => setFilter(id)}>
							{t(label)}{id === "running" && runningCount ? <span className="count">{runningCount}</span> : null}
						</button>
					))}
				</div>
				{named.length ? (
					<div className="groups">
						{named.map((name) => (
							<button key={name} type="button" className={group === name ? "group on" : "group"} aria-pressed={group === name} onClick={() => setGroup(group === name ? null : name)}>
								{name} <span className="count">{list.filter((c) => !c.archived && c.group === name).length}</span>
							</button>
						))}
					</div>
				) : null}
			</header>
			<div className="all-list">
				{[...groups].map(([label, rows]) => (
					<section key={label}>
						<h2>{label}</h2>
						{rows.map((c, index) => (
							<div key={c.id} className={menu?.id === c.id ? "row menu-open" : "row"} role="button" tabIndex={0} style={{ "--i": Math.min(index, 10) } as CSSProperties}
								onClick={() => { if (renaming !== c.id) onOpen(c.id); }}
								onKeyDown={(event) => { if (event.key === "Enter" && renaming !== c.id) onOpen(c.id); }}
								onContextMenu={(event) => { event.preventDefault(); setConfirming(null); setMenu({ id: c.id, x: event.clientX, y: event.clientY }); }}>
								{renaming === c.id ? (
									<input className="rename" autoFocus defaultValue={c.title} aria-label={t("newName")}
										onClick={(event) => event.stopPropagation()}
										onKeyDown={(event) => {
											event.stopPropagation();
											if (event.key === "Enter") { change({ type: "update", id: c.id, change: { title: event.currentTarget.value } }); setRenaming(null); }
											if (event.key === "Escape") setRenaming(null);
										}}
										onBlur={(event) => { change({ type: "update", id: c.id, change: { title: event.currentTarget.value } }); setRenaming(null); }} />
								) : <span className={c.status === "idle" ? "row-title" : "row-title shimmer"}>{c.pinned ? t("pinnedPrefix") : ""}{c.title || t("newChat")}</span>}
								<span className="row-path" title={shortPath(c.workspace)}>{folderName(c.workspace)}</span>
								<span className={c.status === "idle" ? "row-state idle" : `row-state ${c.status} shimmer`}>{c.status === "running" ? t("runningMark") : c.status === "waiting" ? t("waitingMark") : when(c.updatedAt, lang)}</span>
								{confirming === c.id ? (
									<span className="confirm" onClick={(event) => event.stopPropagation()}>
										<button type="button" className="danger" onClick={() => { setConfirming(null); change({ type: "remove", id: c.id }); }}>{t("delete")}</button>
										<button type="button" onClick={() => setConfirming(null)}>{t("cancel")}</button>
									</span>
								) : null}
							</div>
						))}
					</section>
				))}
			</div>
			{menu ? <ConversationMenu at={menu} list={list} ask={ask as never} onClose={() => setMenu(null)} onChanged={onChanged} onRename={setRenaming} onDelete={setConfirming} /> : null}
		</div>
	);
}
