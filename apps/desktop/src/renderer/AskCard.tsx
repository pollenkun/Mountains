/** The question card: A–D, or the user's own words. Esc skips. */
import { useEffect, useState } from "react";
import { useI18n } from "./i18n.tsx";

export interface UserQuestion {
	id: string;
	conversation?: string;
	question: string;
	choices: { label: string; detail: string }[];
	body?: string;
}

const LETTERS = ["A", "B", "C", "D"];

export function AskCard({ question, onAnswer }: { question: UserQuestion; onAnswer: (text: string) => void }) {
	const { t } = useI18n();
	const [other, setOther] = useState("");
	useEffect(() => {
		const skip = (event: KeyboardEvent) => { if (event.key === "Escape") onAnswer("用户跳过了这个问题。"); };
		window.addEventListener("keydown", skip);
		return () => window.removeEventListener("keydown", skip);
	}, [onAnswer]);
	return (
		<section className="need ask" aria-label="Mountains 的提问">
			<h2>{question.question}</h2>
			{question.body ? <pre className="ask-body">{question.body}</pre> : null}
			{question.choices.map((choice, index) => (
				<button key={`${choice.label}-${index}`} type="button" className="ask-choice" onClick={() => onAnswer(choice.detail ? `${LETTERS[index] ?? ""}. ${choice.label}（${choice.detail}）` : `${LETTERS[index] ?? ""}. ${choice.label}`)}>
					<span className="ask-letter">{LETTERS[index]}</span>
					<span className="ask-copy"><span>{choice.label}</span>{choice.detail ? <span className="setting-note">{choice.detail}</span> : null}</span>
				</button>
			))}
			<label className="ask-other">
				<span>{t("other")}</span>
				<input value={other} placeholder={t("otherPlaceholder")} onChange={(event) => setOther(event.target.value)}
					onKeyDown={(event) => { if (event.key === "Enter" && other.trim()) onAnswer(`其他：${other.trim()}`); }} />
			</label>
			<span className="setting-note">{t("askSkip")}</span>
		</section>
	);
}
