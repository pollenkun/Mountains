import { createContext, useContext, useEffect, useState } from "react";
import { Reveal, RollingNumber, Swap, useSeconds } from "./Motion.tsx";
import { Check, Chevron, Cross, KindIcon } from "./icons.tsx";
import { OWN_LINE, blockLabel, callLabel, leadingKind, riskLabel, type FileDiff, type ToolCall } from "./transcript.ts";
import { useI18n } from "./i18n.tsx";

function Counts({ call }: { call: ToolCall }) {
	if (call.added === undefined && call.removed === undefined) return null;
	return (
		<span className="counts">
			{call.added ? <span className="plus">+{call.added}</span> : null}
			{call.removed ? <span className="minus">−{call.removed}</span> : null}
		</span>
	);
}

/** Fetches what a finished call returned; the events carry only its size. */
export const ToolOutput = createContext<((toolCallId: string) => Promise<string | null>) | null>(null);

const MAX_OUTPUT_LINES = 200;

function TerminalCard({ call }: { call: ToolCall }) {
	const ok = call.status === "done" && (call.exitCode === undefined || call.exitCode === 0);
	const fetchOutput = useContext(ToolOutput);
	const [output, setOutput] = useState<string | null>(null);
	useEffect(() => {
		if (call.status === "running" || !fetchOutput) return;
		let live = true;
		fetchOutput(call.id).then((text) => { if (live) setOutput(text); }, () => {});
		return () => { live = false; };
	}, [call.id, call.status, fetchOutput]);
	// The model's copy starts with the command and its exit code, which the card already shows.
	const lines = output ? output.replace(/\s+$/, "").split("\n") : [];
	while (lines.length && (/^\$ /.test(lines[0]!) || /^\[exit code [^\]]*\]$/.test(lines[0]!))) lines.shift();
	return (
		<div className="card terminal">
			<div className="card-head">终端</div>
			<pre><span className="prompt">$ </span>{call.target}</pre>
			{lines.length ? <pre className="output">{lines.slice(0, MAX_OUTPUT_LINES).join("\n")}</pre> : null}
			{lines.length > MAX_OUTPUT_LINES ? <div className="card-foot">还有 {lines.length - MAX_OUTPUT_LINES} 行没有显示</div> : null}
			{call.status === "running" ? null : (
				<div className={ok ? "card-foot ok" : "card-foot bad"}>
					{ok ? <><Check />成功</> : <><Cross />{call.approvalState === "denied" ? (call.failure || "未通过审批") : call.exitCode !== undefined && call.exitCode !== null ? `退出码 ${call.exitCode}` : call.failure || "失败"}</>}
				</div>
			)}
		</div>
	);
}

function NoteCard({ call }: { call: ToolCall }) {
	const note = call.note;
	if (!note) return null;
	return (
		<div className="card note-card">
			<div className="card-head">任务进度备忘</div>
			{note.next ? <div className="note-section"><span className="note-label">下一步</span><span>{note.next}</span></div> : null}
			{note.requirements?.length ? <div className="note-section"><span className="note-label">待满足要求</span><ul>{note.requirements.map((item, i) => <li key={i}>{item}</li>)}</ul></div> : null}
			{note.facts?.length ? <div className="note-section"><span className="note-label">已确认事实</span><ul>{note.facts.map((item, i) => <li key={i}>{item}</li>)}</ul></div> : null}
		</div>
	);
}

function when(days: number): string {
	return days <= 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
}

function RecallCard({ call }: { call: ToolCall }) {
	const { lang } = useI18n();
	const searchLabel = call.status === "running" ? (lang === "en" ? "Searching" : "正在搜索") : call.status === "done" ? (lang === "en" ? "Searched" : "搜索了") : (lang === "en" ? "Search" : "搜索");
	return (
		<div className="card">
			<div className="card-head">{call.tool === "session_search" ? "这次对话" : "以前的对话"}</div>
			{call.target ? <div className="note-section"><span className="note-label">{searchLabel}</span><span>{call.target}</span></div> : null}
			{call.recallReads?.map((read, index) => (
				<div key={index} className="note-section"><span className="note-label">{when(read.days)}</span><span>{read.asked}</span></div>
			))}
		</div>
	);
}

function FailureCard({ call }: { call: ToolCall }) {
	if (!call.failure) return null;
	return (
		<div className="card">
			<div className="card-head">{call.approvalState === "denied" ? "审批说明" : "错误详情"}</div>
			<pre className="output">{call.failure}</pre>
			<div className="card-foot bad"><Cross />{call.approvalState === "denied" ? "未通过审批" : "失败"}</div>
		</div>
	);
}

const MAX_DIFF_LINES = 400;

function DiffCard({ diffs }: { diffs: FileDiff[] }) {
	let budget = MAX_DIFF_LINES;
	return (
		<div className="card diff">
			{diffs.map((diff, index) => {
				const old = diff.oldText ? diff.oldText.split("\n") : [];
				const fresh = diff.newText ? diff.newText.split("\n") : [];
				const rows = [...old.map((line) => ["minus", line] as const), ...fresh.map((line) => ["plus", line] as const)];
				const shown = rows.slice(0, Math.max(0, budget));
				budget -= shown.length;
				return (
					<div key={index} className="diff-file">
						<div className="card-head">{diff.path}</div>
						<pre>
							{shown.map(([sign, line], row) => (
								<div key={row} className={`diff-line ${sign}`}><span className="sign">{sign === "plus" ? "+" : "−"}</span>{line || " "}</div>
							))}
						</pre>
						{shown.length < rows.length ? <div className="card-foot">还有 {rows.length - shown.length} 行没有显示</div> : null}
					</div>
				);
			})}
		</div>
	);
}

function detailBody(call: ToolCall) {
	if (call.kind === "message" && call.message) {
		return (
			<div className="card">
				<pre className="agent-text">{call.message}</pre>
				{call.status === "failed" ? (
					<div className="card-foot bad"><Cross />{call.approvalState === "denied" ? (call.failure || "未通过审批") : (call.failure || "失败")}</div>
				) : null}
			</div>
		);
	}
	if (call.kind === "command" && call.target) return <TerminalCard call={call} />;
	if (call.kind === "recall" && (call.target || call.recallReads?.length)) return <RecallCard call={call} />;
	if (call.diffs?.length) return <DiffCard diffs={call.diffs} />;
	if (call.note) return <NoteCard call={call} />;
	if (call.status === "failed" && call.failure) return <FailureCard call={call} />;
	return null;
}

/** What opens under a call, with the risk 自动审批 gave it. */
function detailOf(call: ToolCall) {
	const body = detailBody(call);
	const { lang } = useI18n();
	const input = call.status === "failed" && call.input !== undefined ? (
		<div className="card tool-input">
			<div className="card-head">{lang === "en" ? "Model input" : "模型输入"} · {call.tool}</div>
			<pre className="output">{JSON.stringify(call.input, null, 2)}</pre>
		</div>
	) : null;
	if (!body && !input) return null;
	return <>{input}{body}{call.level ? <p className={`risk-line ${call.level}`}>{riskLabel(call.level, lang)}</p> : null}</>;
}

function approvalStatusText(state: ToolCall["approvalState"], t: (key: "approvingContext" | "autoApproving") => string): string | null {
	if (state === "fetching_context") return t("approvingContext");
	if (state === "reviewing") return t("autoApproving");
	return null;
}

/** Opens a team member in the side panel. */
export const OpenAgent = createContext<(name: string) => void>(() => {});

function CallRow({ call }: { call: ToolCall }) {
	const { t, lang } = useI18n();
	const [open, setOpen] = useState(false);
	const openAgent = useContext(OpenAgent);
	const seconds = useSeconds(call.startedAt, call.status === "running");
	const { verb, target } = callLabel(call, lang);
	const detail = detailOf(call);
	const mono = call.kind === "command" || call.kind === "read" || call.kind === "edit" || call.kind === "search";
	const approving = call.status === "running" ? approvalStatusText(call.approvalState, t) : null;
	const opensPanel = call.kind === "agent" && call.status !== "failed" && Boolean(call.target);
	const label = (
		<>
			<KindIcon kind={call.kind} />
			<Swap id={verb}><span className={call.status === "running" ? "verb shimmer" : "verb"}>{verb}</span></Swap>
			{target ? <span className={[mono ? "target mono" : "target", call.status === "running" ? "shimmer" : ""].filter(Boolean).join(" ")}>{target}</span> : null}
			<Counts call={call} />
			{approving ? <Swap id={approving}><span className="approving shimmer">{approving}</span></Swap> : null}
			{call.status === "running" && !approving && seconds >= 2 ? <span className="elapsed">{t("elapsedPrefix")} <RollingNumber value={seconds} /> {t("seconds")}</span> : null}
			{call.status === "failed" ? <span className="failed">{call.approvalState === "denied" ? t("denied") : t("failed")}</span> : null}
			{call.level && call.status !== "running" ? <span className="approval-note">{t("autoLine")} · <span className={call.level}>{riskLabel(call.level, lang)}</span> · {call.approvalState === "denied" ? t("notPassed") : t("passed")}</span> : null}
			{opensPanel ? <Chevron open={false} side /> : detail ? <Chevron open={open} /> : null}
		</>
	);
	return (
		<div className={`tool ${call.status}`}>
			{opensPanel ? <button type="button" className="tool-row" onClick={() => openAgent(call.target)}>{label}</button>
				: detail ? <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button> : <div className="tool-row">{label}</div>}
			{detail && !opensPanel ? <Reveal open={open}>{detail}</Reveal> : null}
		</div>
	);
}

export function ToolBlock({ calls, folded }: { calls: ToolCall[]; folded: boolean }) {
	const { t, lang } = useI18n();
	const [open, setOpen] = useState(false);
	const head = calls[0]!;
	// A lone call that is still running shows what it is working on, folded or not.
	if (calls.length === 1 && (!folded || head.status === "running" || OWN_LINE.has(head.kind))) return <CallRow call={head} />;
	if (!folded && head.kind !== "image" && head.kind !== "skill") return <>{calls.map((call) => <CallRow key={call.id} call={call} />)}</>;
	const single = calls.length === 1 ? detailOf(head) : null;
	const expandable = calls.length > 1 || !!single;
	const runningApproval = calls.find((call) => call.status === "running" && call.approvalState);
	const approving = runningApproval ? approvalStatusText(runningApproval.approvalState, t) : null;
	const failedCalls = calls.filter((call) => call.status === "failed");
	const failedText = failedCalls.length ? (failedCalls.every((call) => call.approvalState === "denied") ? t("denied") : t("failed")) : null;
	const label = (
		<>
			<KindIcon kind={leadingKind(calls)} />
			<Swap id={blockLabel(calls, lang)}><span className="verb">{blockLabel(calls, lang)}</span></Swap>
			{approving ? <Swap id={approving}><span className="approving shimmer">{approving}</span></Swap> : null}
			{!approving && failedText ? <span className="failed">{failedText}</span> : null}
			{expandable ? <Chevron open={open} /> : null}
		</>
	);
	return (
		<div className="tool">
			{expandable ? <button type="button" className={calls.length > 1 ? "tool-row many" : "tool-row"} aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button> : <div className="tool-row">{label}</div>}
			{expandable ? <Reveal open={open}>{single ?? <div className="tool-list">{calls.map((call) => <CallRow key={call.id} call={call} />)}</div>}</Reveal> : null}
		</div>
	);
}
