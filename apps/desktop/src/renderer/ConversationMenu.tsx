/** The right-click menu of a conversation, the same in the sidebar and in 所有对话 (the Conversations board). */
import { useEffect, useState } from "react";
import type { Conversation } from "./Conversations.tsx";
import { useI18n } from "./i18n.tsx";

type Ask = (request: { type: string; [key: string]: unknown }) => Promise<unknown>;

export interface MenuAt { id: string; x: number; y: number }

export function ConversationMenu({ at, list, ask, onClose, onChanged, onRename, onDelete }: {
	at: MenuAt; list: Conversation[]; ask: Ask; onClose: () => void; onChanged: (list: Conversation[]) => void;
	onRename: (id: string) => void; onDelete: (id: string) => void;
}) {
	const { t } = useI18n();
	const win = document.documentElement.dataset.platform === "win";
	const [grouping, setGrouping] = useState(false);
	const [naming, setNaming] = useState(false);
	const target = list.find((c) => c.id === at.id);
	useEffect(() => {
		const close = () => onClose();
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		window.addEventListener("pointerdown", close);
		window.addEventListener("blur", close);
		window.addEventListener("keydown", key);
		return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); window.removeEventListener("keydown", key); };
	}, [onClose]);
	if (!target) return null;
	const change = (request: { type: string; [key: string]: unknown }) => { onClose(); void ask(request).then((next) => { if (Array.isArray(next)) onChanged(next as Conversation[]); }, () => {}); };
	const groups = [...new Set(list.map((c) => c.group).filter((g): g is string => !!g))];
	// Kept on screen near the pointer.
	const style = { left: Math.min(at.x, window.innerWidth - 230), top: Math.min(at.y, window.innerHeight - 300) };
	return (
		<div className="context-menu" role="menu" style={style} onPointerDown={(event) => event.stopPropagation()}>
			{grouping ? (
				<>
					{groups.map((group) => <button key={group} type="button" role="menuitemradio" aria-checked={target.group === group} onClick={() => change({ type: "update", id: target.id, change: { group } })}>{target.group === group ? "✓ " : ""}{group}</button>)}
					{naming
						? <input className="rename" autoFocus placeholder={t("groupName")} aria-label={t("newGroup")} onKeyDown={(event) => {
							if (event.key === "Enter" && event.currentTarget.value.trim()) change({ type: "update", id: target.id, change: { group: event.currentTarget.value } });
							if (event.key === "Escape") { event.stopPropagation(); setNaming(false); }
						}} />
						: <button type="button" role="menuitem" onClick={() => setNaming(true)}>{t("newGroupEllipsis")}</button>}
					{target.group ? <><hr /><button type="button" role="menuitem" onClick={() => change({ type: "update", id: target.id, change: { group: null } })}>{t("leaveGroup")}</button></> : null}
				</>
			) : (
				<>
					<button type="button" role="menuitem" onClick={() => { onClose(); onRename(target.id); }}>{t("rename")}</button>
					<button type="button" role="menuitem" onClick={() => change({ type: "update", id: target.id, change: { pinned: !target.pinned } })}>{target.pinned ? t("unpin") : t("pin")}</button>
					<button type="button" role="menuitem" onClick={() => setGrouping(true)}>{t("moveGroup")}</button>
					<button type="button" role="menuitem" onClick={() => { onClose(); void ask({ type: "reveal", id: target.id }); }}>{win ? t("showInExplorer") : t("revealFinder")}</button>
					<button type="button" role="menuitem" onClick={() => { onClose(); void ask({ type: "export", id: target.id }); }}>{t("exportMarkdown")}</button>
					<hr />
					<button type="button" role="menuitem" onClick={() => change({ type: "update", id: target.id, change: { archived: !target.archived } })}>{target.archived ? t("unarchive") : t("archive")}</button>
					<button type="button" role="menuitem" className="danger" disabled={target.status !== "idle"} onClick={() => { onClose(); onDelete(target.id); }}>{t("deleteEllipsis")}</button>
				</>
			)}
		</div>
	);
}
