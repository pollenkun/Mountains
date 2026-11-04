import { useRef, useState } from "react";
import { Chevron } from "./icons.tsx";
import { newClock, Reveal, RollingNumber, Swap, useSeconds, type RevealClock } from "./Motion.tsx";
import { Markdown } from "./siui/markdown.tsx";
import { useI18n } from "./i18n.tsx";

/** How long the row takes to open. New words wait this out so they do not rise while the row is still moving. */
const OPEN_MS = 200;
const stillMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reasoning as Markdown. Words already there when it opens stay put. Words that arrive after the open has finished rise like a reply. */
function ThinkingText({ text, live, holdUntil }: { text: string; live: boolean; holdUntil: number }) {
	const clock = useRef<RevealClock | null>(null);
	if (!clock.current) {
		const next = newClock();
		next.settledUntil = text.length;
		next.last = holdUntil;
		clock.current = next;
	}
	return <div className="thinking-text"><Markdown text={text} offset={0} clock={clock.current} live={live} /></div>;
}

/** Reasoning has its own row, apart from tool calls: how long it took, and the text when opened. */
export function ThinkingRow({ text, startedAt, endedAt }: { text: string; startedAt: number; endedAt?: number }) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const holdUntil = useRef(0);
	if (!open) holdUntil.current = 0;
	else if (!holdUntil.current) holdUntil.current = performance.now() + (stillMotion() ? 0 : OPEN_MS);
	const live = endedAt === undefined;
	const seconds = useSeconds(startedAt, live, endedAt);
	return (
		<div className={live ? "thinking live" : "thinking"}>
			<button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Swap id={live ? "live" : "done"}>{live
					? <><span className="verb shimmer">{t("thinkingNow")}</span><span className="elapsed">{t("elapsedPrefix")} <RollingNumber value={seconds} /> {t("seconds")}</span></>
					: <span className="verb">{t("thoughtLead")}<RollingNumber value={Math.max(1, seconds)} />{t("thoughtTail")}</span>}</Swap>
				<Chevron open={open} />
			</button>
			<Reveal open={open} ms={OPEN_MS} pace={OPEN_MS}><ThinkingText text={text} live={live} holdUntil={holdUntil.current} /></Reveal>
		</div>
	);
}
