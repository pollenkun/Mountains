/**
 * ⌘F: find words in the conversation. Matches are marked with CSS highlights over the transcript's own text,
 * so the field itself never counts; Enter goes to the next, ⇧Enter back, Esc closes.
 */
import { useEffect, useRef, useState } from "react";
import { Chevron, Cross } from "./icons.tsx";
import { useI18n } from "./i18n.tsx";

type Registry = { set(name: string, value: unknown): void; delete(name: string): void };
const highlights = (): Registry | null => (globalThis.CSS as unknown as { highlights?: Registry }).highlights ?? null;
const HighlightClass = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

/** Every place the text of `root` contains `query`, ignoring case. */
function ranges(root: Element, query: string): Range[] {
	const out: Range[] = [];
	const needle = query.toLowerCase();
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.textContent?.toLowerCase() ?? "";
		for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + needle.length);
			out.push(range);
		}
	}
	return out;
}

export function FindBar({ onClose }: { onClose: () => void }) {
	const { t } = useI18n();
	const [query, setQuery] = useState("");
	const [found, setFound] = useState<Range[]>([]);
	const [active, setActive] = useState(0);
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => { field.current?.focus(); return () => { highlights()?.delete("find"); highlights()?.delete("find-active"); }; }, []);
	useEffect(() => {
		const root = document.querySelector(".transcript");
		const next = root && query ? ranges(root, query) : [];
		setFound(next);
		setActive(0);
	}, [query]);
	useEffect(() => {
		const registry = highlights();
		if (!registry || !HighlightClass) return;
		registry.set("find", new HighlightClass(...found));
		const current = found[active];
		if (current) {
			registry.set("find-active", new HighlightClass(current));
			current.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
		} else registry.delete("find-active");
	}, [found, active]);
	const step = (forward: boolean) => { if (found.length) setActive((n) => (n + (forward ? 1 : found.length - 1)) % found.length); };
	return (
		<div className="find-bar" role="search">
			<input ref={field} aria-label={t("findInChat")} placeholder={t("find")} value={query} onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") { event.preventDefault(); step(!event.shiftKey); }
					if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
				}} />
			<span className="find-count">{query ? (found.length ? `${active + 1}/${found.length}` : t("notFound")) : ""}</span>
			<button type="button" className="act flip" aria-label={t("previous")} disabled={!found.length} onClick={() => step(false)}><Chevron open={true} /></button>
			<button type="button" className="act" aria-label={t("next")} disabled={!found.length} onClick={() => step(true)}><Chevron open={false} /></button>
			<button type="button" className="act" aria-label={t("closeFind")} onClick={onClose}><Cross /></button>
		</div>
	);
}
