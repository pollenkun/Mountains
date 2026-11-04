/** The quiet row under a message: copy it, and for the user's own messages edit and resend, for a reply run it again. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "./icons.tsx";
import { useI18n } from "./i18n.tsx";

/** Copies `text`; the icon turns into a tick for a moment, so the copy is seen to have happened. */
export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
	const { t } = useI18n();
	const name = label ?? t("copy");
	const [done, setDone] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
	const copy = () => {
		void navigator.clipboard.writeText(text).then(() => {
			setDone(true);
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setDone(false), 1400);
		}, () => {});
	};
	return (
		<button type="button" className={["act", className].filter(Boolean).join(" ")} aria-label={done ? t("copied") : name} title={done ? t("copied") : name} onClick={copy}>
			<span key={done ? "done" : "copy"} className="act-icon">{done ? <Check /> : <Copy />}</span>
		</button>
	);
}

export function Act({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
	return <button type="button" className="act" aria-label={label} title={label} disabled={disabled} onClick={onClick}><span className="act-icon">{children}</span></button>;
}

/** The row under a message; its time shows with the buttons. Today's messages give the hour, older ones the date too. */
export function Actions({ side, at, children }: { side: "start" | "end"; at: number; children: ReactNode }) {
	const { t, lang } = useI18n();
	const date = new Date(at), today = date.toDateString() === new Date().toDateString();
	const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const time = today ? clock : lang === "en" ? `${date.getMonth() + 1}/${date.getDate()} ${clock}` : `${t("monthDay", { m: date.getMonth() + 1, d: date.getDate() })} ${clock}`;
	return <div className={`acts ${side}`}>{side === "end" ? <span className="act-time">{time}</span> : null}{children}{side === "start" ? <span className="act-time">{time}</span> : null}</div>;
}
