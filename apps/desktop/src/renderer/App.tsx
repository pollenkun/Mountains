import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { PROTOCOL_VERSION, type EngineCommand, type EngineEvent } from "@mountains/protocol";
import { ArrowDown, DockIcons, Edit, Plan, Redo, Target } from "./icons.tsx";
import { ApprovalPanel, approvalLabel, ContextGauge, ModelPanel, type ShellInfo, type ShellRequest } from "./Bar.tsx";
import { Dock, type DockItem, type DockSide } from "./Dock.tsx";
import { Field } from "./Field.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { pickTitle } from "./titles.ts";
import { applyTheme, type Looks } from "./theme.ts";
import { AllConversations, type Conversation } from "./Conversations.tsx";
import { ConversationMenu, type MenuAt } from "./ConversationMenu.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { RollingNumber, useLeavingList } from "./Motion.tsx";
import { UpdateNotice } from "./UpdateNotice.tsx";
import { Reply } from "./siui/Reply.tsx";
import { DraftContext, FixContext, UsageContext } from "./siui/ui.tsx";
import { parse } from "./siui/parse.ts";
import { problems } from "./siui/state.ts";
import { ThinkingRow } from "./Thinking.tsx";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { OpenAgent, ToolBlock, ToolOutput } from "./Tools.tsx";
import { Act, Actions, CopyButton } from "./Actions.tsx";
import { Composer, type Attachment } from "./Composer.tsx";
import { ChangesPanel, ChangesPill, withLive, type ChangedFile, type Changes } from "./Changes.tsx";
import { FindBar } from "./FindBar.tsx";
import { billingLink, FirstRun } from "./FirstRun.tsx";
import { AskCard, type UserQuestion } from "./AskCard.tsx";
import { useI18n } from "./i18n.tsx";
import { answered, blocks, EMPTY, liveEdits, reduce, type Approval, type Item, type Transcript } from "./transcript.ts";
import { splitNote } from "../main/modes.ts";

interface Bridge {
	send(payload: { conversation: string; command: EngineCommand }): void;
	shell(request: ShellRequest | DeskRequest): Promise<unknown>;
	onEvent(listener: (payload: { conversation: string; event: EngineEvent }) => void): void;
	onOpen(listener: (conversation: unknown) => void): void;
	pathForFile(file: File): string;
	onAsk(listener: (question: UserQuestion) => void): void;
}

export type DeskRequest =
	| { type: "saveKey"; key: string }
	| { type: "memory" } | { type: "setMemory"; enabled: boolean } | { type: "setAgents"; text: string }
	| { type: "list" } | { type: "create"; workspace?: string; memory?: { save: boolean; read: boolean } } | { type: "history"; id: string } | { type: "remove"; id: string } | { type: "search"; query: string }
	| { type: "toolOutput"; id: string; toolCallId: string }
	| { type: "update"; id: string; change: { title?: string; pinned?: boolean; archived?: boolean; group?: string | null } }
	| { type: "rewind"; id: string; run: string; files: boolean } | { type: "changes"; id: string } | { type: "diff"; id: string; path: string } | { type: "restore"; id: string; run: string | null }
	| { type: "plan"; id: string; enabled: boolean } | { type: "approvePlan"; id: string } | { type: "goal"; id: string; text: string } | { type: "stopGoal"; id: string }
	| { type: "reveal"; id: string } | { type: "export"; id: string }
	| { type: string; [key: string]: unknown };

const bridge = (window as unknown as { mountains: Bridge }).mountains;

interface Desk {
	view: "chat" | "all" | "settings";
	active: string | null;
	transcripts: Record<string, Transcript>;
}

type Action =
	| { conversation: string; event: EngineEvent }
	| { conversation: string; history: EngineEvent[] }
	| { conversation: string; answered: string }
	| { open: string | null; view?: Desk["view"] };

function step(desk: Desk, action: Action): Desk {
	if ("open" in action) return { ...desk, active: action.open, view: action.view ?? "chat" };
	const current = desk.transcripts[action.conversation] ?? EMPTY;
	let next: Transcript;
	if ("event" in action) next = reduce(current, action.event);
	// History replays at once and settles: the last run is over and nothing in it streams.
	else if ("history" in action) {
		const replayed = action.history.reduce((state, event) => reduce(state, event, Date.parse(event.time) || 0), EMPTY);
		const agents = Object.fromEntries(Object.entries(replayed.agents).map(([k, v]) => [k, { ...v, running: false, open: null, thinking: null, approvals: [] }]));
		next = { ...replayed, agents, running: false, open: null, thinking: null, approvals: [] };
	}
	else next = answered(current, action.answered);
	// A run that starts while nothing is open is the one the user just sent, or one started elsewhere: show it.
	const adopt = desk.active === null && desk.view === "chat" && "event" in action && action.event.type === "run.started";
	return { ...desk, active: adopt ? action.conversation : desk.active, transcripts: { ...desk.transcripts, [action.conversation]: next } };
}

/** Folding is a setting; until Settings exists it lives in this window's storage. */
function foldedSetting(): boolean {
	try { return localStorage.getItem("mountains.tools.folded") !== "false"; }
	catch { return true; }
}

function dockSideSetting(): DockSide {
	try { const saved = localStorage.getItem("mountains.dock.side"); return saved === "right" || saved === "top" || saved === "bottom" ? saved : "left"; }
	catch { return "left"; }
}
const NO_CHANGES: Changes = { files: [], points: [] };
const REVISION = { compacting: "正在压缩上下文", compacted: "上下文已压缩", folded: "已自动折叠 {n} 个工具调用" };

let listening = false;
let listeningOpen = false;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function ApprovalCard({ approval, onAnswer, leaving }: { approval: Approval; onAnswer: (decision: "allow" | "deny") => void; leaving: boolean }) {
	const { t } = useI18n();
	return (
		<section className="approval" aria-label={t("approve")} data-leaving={leaving || undefined}>
			<h2>{t("approve")}{approval.agent ? <span className="risk-line">{approval.agent}</span> : null}{approval.level ? <span className={`risk-line ${approval.level}`}>{t(approval.level === "low" ? "riskLow" : approval.level === "medium" ? "riskMedium" : "riskHigh")}</span> : null}</h2>
			<pre>{approval.command}</pre>
			{approval.explanation ? <p>{approval.explanation}</p> : null}
			<div className="approval-actions">
				<button type="button" className="allow" onClick={() => onAnswer("allow")}>{t("allow")}</button>
				<button type="button" className="deny" onClick={() => onAnswer("deny")}>{t("deny")}</button>
			</div>
		</section>
	);
}

/** Context this small is cheaper to read again than to summarize. */
const WORTH_COMPACTING = 20_000;
/** How long a provider can be expected to keep a prompt in its cache. */
const CACHE_MINUTES = 10;

/** Before something that will miss the cache: offer to make the context smaller first (the Cache board). */
/** Only 模式 (light or dark) is offered: there are no themes, so no look is previewed or applied. */
const LOOKS = false as boolean;

/** Ten automatic retries after the first attempt, then the run stops. */
const RETRIES = 10;
const BALANCE_RE = /余额不足|欠费|insufficient[\s_-]*quota|insufficient balance|exceeded your current quota|payment required/i;
const CONTEXT_RE = /context[\s_-]*length|maximum context|context window|上下文长度|context_length_exceeded/i;

function Reconnect({ attempt }: { attempt: number }) {
	const { t } = useI18n();
	return (
		<div className="reconnect" role="status">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h.01" /><path d="M8.5 16.43a5 5 0 0 1 7 0" /><path d="M5 12.86a10 10 0 0 1 5.17-2.69" /><path d="M19 12.86a10 10 0 0 0-2-1.52" /><path d="M2 8.82a15 15 0 0 1 4.18-2.64" /><path d="M22 8.82a15 15 0 0 0-11.29-3.76" /><path d="m2 2 20 20" /></svg>
			<span>{t("reconnect")} <RollingNumber value={Math.min(attempt, RETRIES)} />/{RETRIES}</span>
		</div>
	);
}

function Fault({ text, onCompact, onCopy }: { text: string; onCompact: () => void; onCopy: () => void }) {
	const { t } = useI18n();
	return (
		<div className="fault" role="alert">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>
			<div>
				<code>{text}</code>
				<div className="fault-acts">
					<button type="button" className="link" onClick={onCompact}>{t("compactRetry")}</button>
					<button type="button" className="link" onClick={onCopy}>{t("copyError")}</button>
				</div>
			</div>
		</div>
	);
}

function NoModel({ onAdd }: { onAdd: () => void }) {
	const { t } = useI18n();
	return (
		<section className="approval" aria-label={t("noModel")}>
			<h2>{t("noModel")}</h2>
			<div className="approval-actions"><button type="button" className="allow" onClick={onAdd}>{t("addModel")}</button></div>
		</section>
	);
}

function AgentsLarge({ busy, onEdit, onSummarize, onTruncate, onCancel }: { busy: boolean; onEdit: () => void; onSummarize: () => void; onTruncate: () => void; onCancel: () => void }) {
	const { t } = useI18n();
	return (
		<section className="need" aria-label={t("agentsTooBig")}>
			<h2>{t("agentsTooBig")}</h2>
			<div className="need-acts">
				<button type="button" className="allow" onClick={onEdit}>{t("agentsChange")}</button>
				<button type="button" className="deny" disabled={busy} onClick={onSummarize}>{t("agentsSummarize")}</button>
				<button type="button" className="deny" disabled={busy} onClick={onTruncate}>{t("agentsTruncate")}</button>
				<button type="button" className="deny" onClick={onCancel}>{t("agentsCancel")}</button>
			</div>
		</section>
	);
}

function CompactOffer({ text, onAnswer }: { text: string; onAnswer: (yes: boolean) => void }) {
	const { t } = useI18n();
	return (
		<section className="approval" aria-label={t("saveCredit")}>
			<h2>{t("saveCredit")}</h2>
			<p>{text}</p>
			<div className="approval-actions">
				<button type="button" className="allow" onClick={() => onAnswer(true)}>{t("yes")}</button>
				<button type="button" className="deny" onClick={() => onAnswer(false)}>{t("no")}</button>
			</div>
		</section>
	);
}

/** The user's message: their words, and the mode note the program added, shown as it was sent but quieter. */
function UserText({ text }: { text: string }) {
	const { t } = useI18n();
	const { text: words, note } = splitNote(text);
	return <>{words}{note ? <span className="mode-note-sent">{note === "goal" ? t("goalMode") : text.slice(words.length).trimStart()}</span> : null}</>;
}

/** Editing a message that began a run: send it again from there; files the later runs changed can go back too. */
function EditBox({ text, filesChanged, onCancel, onSend }: { text: string; filesChanged: boolean; onCancel: () => void; onSend: (text: string, files: boolean) => void }) {
	const { t } = useI18n();
	const [value, setValue] = useState(splitNote(text).text);
	const [files, setFiles] = useState(true);
	const box = useRef<HTMLTextAreaElement>(null);
	useEffect(() => { const node = box.current; if (node) { node.focus(); node.setSelectionRange(node.value.length, node.value.length); } }, []);
	return (
		<div className="edit-box">
			<textarea ref={box} aria-label={t("editMessage")} value={value} rows={Math.min(12, value.split("\n").length + 1)} onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") { event.preventDefault(); onCancel(); }
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (value.trim()) onSend(value, files && filesChanged); }
				}} />
			<div className="edit-bar">
				{filesChanged ? <label className="edit-files"><input type="checkbox" checked={files} onChange={(event) => setFiles(event.target.checked)} />{t("rewindFiles")}</label> : null}
				<span className="grow" />
				<button type="button" className="deny" onClick={onCancel}>{t("cancel")}</button>
				<button type="button" className="allow" disabled={!value.trim()} onClick={() => onSend(value, files && filesChanged)}>{t("send")}</button>
			</div>
		</div>
	);
}

function GoalBar({ goal, running, onAction }: { goal: NonNullable<Conversation["goal"]>; running: boolean; onAction: (type: string, text?: string) => Promise<void> }) {
	const { t } = useI18n();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(goal.text);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => setText(goal.text), [goal.text]);
	const live = goal.status === "active" || goal.status === "verifying";
	const status = goal.status === "paused" ? t(running ? "goalPausing" : "goalPaused") : goal.status === "verifying" ? t("goalVerifying") : goal.status === "active" ? (goal.revised ? t("goalNextRound") : "") : goal.status === "met" ? t("goalMet") : goal.status === "blocked" ? t("goalBlocked") : t("goalStopped");
	const act = async (type: string, value?: string) => {
		setPending(true); setError("");
		try { await onAction(type, value); setEditing(false); }
		catch (error) { setError(reason(error)); }
		finally { setPending(false); }
	};
	return <div className={`goal-bar ${goal.status}`}>
		<div className="goal-summary" role="status"><Target /><span className="goal-text" title={goal.text}>{live ? t("goalActive") : `${t("goalLabel")}： `}{goal.text}</span>{status ? <span className="goal-state">{status}</span> : null}</div>
		{editing ? <form className="goal-editor" onSubmit={event => { event.preventDefault(); if (text.trim()) void act("updateGoal", text); }}>
			<textarea autoFocus aria-label={t("editGoal")} value={text} maxLength={65_536} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); setText(goal.text); } }} />
			<button type="submit" className="link" disabled={pending || !text.trim()}>{t("save")}</button><button type="button" className="link" disabled={pending} onClick={() => { setEditing(false); setText(goal.text); }}>{t("cancel")}</button>
		</form> : <div className="goal-actions">
			{goal.status !== "met" ? <button type="button" className="link" disabled={pending} onClick={() => void act(live ? "pauseGoal" : "resumeGoal")}>{t(live ? "pauseGoal" : "resumeGoal")}</button> : null}
			<button type="button" className="link" disabled={pending} onClick={() => setEditing(true)}>{t("editGoal")}</button>
			<button type="button" className="link" disabled={pending} onClick={() => void act("deleteGoal")}>{t("deleteGoal")}</button>
		</div>}
		{goal.reason ? <span className="goal-detail">{goal.reason}</span> : null}
		{error ? <span className="goal-detail" role="alert">{error}</span> : null}
	</div>;
}

export function App() {
	const { t, lang } = useI18n();
	const [desk, dispatch] = useReducer(step, { view: "chat", active: null, transcripts: {} });
	const [list, setList] = useState<Conversation[]>([]);
	const [text, setText] = useState("");
	const [agentsChars, setAgentsChars] = useState(0);
	const [agentsGone, setAgentsGone] = useState(false);
	const [agentsBusy, setAgentsBusy] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [folder, setFolder] = useState<string | null>(null);
	// The next conversation's memory, chosen before its first message.
	const [memory, setMemory] = useState({ save: true, read: true });
	const [changes, setChanges] = useState<Changes>(NO_CHANGES);
	const [changesOpen, setChangesOpen] = useState(false);
	// The side panel on the team: false shut, null the list, a name that member.
	const [agentView, setAgentView] = useState<string | null | false>(false);
	// Waiting for an answer to CompactOffer; `then` is what goes on after it.
	const [offer, setOffer] = useState<{ text: string; then: () => void } | null>(null);
	// Between a run's end and its real numbers, the pill holds what it shows rather than dipping.
	const settling = useRef(false);
	const pillFiles = useRef<ChangedFile[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [finding, setFinding] = useState(false);
	const [menu, setMenu] = useState<MenuAt | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [away, setAway] = useState(false);
	// Plan mode chosen before a new conversation exists; it goes with the first message.
	const [planDraft, setPlanDraft] = useState(false);
	const folded = desk.view === "chat" ? foldedSetting() : true;
	const [info, setInfo] = useState<ShellInfo | null>(null);
	const [dockSide, setDockSide] = useState(dockSideSetting);
	const [greeting, setGreeting] = useState(() => pickTitle(lang === "zh" ? "zh" : "en"));
	const ask = useCallback((request: ShellRequest | DeskRequest) => bridge.shell(request), []);
	const state = (desk.active && desk.transcripts[desk.active]) || EMPTY;
	const toolOutput = useCallback((toolCallId: string) => desk.active ? ask({ type: "toolOutput", id: desk.active, toolCallId }) as Promise<string | null> : Promise.resolve(null), [ask, desk.active]);
	const draft = useRef<{ text: string; attachments: Attachment[] } | null>(null);
	const transcript = useRef<HTMLDivElement>(null);
	const active = useRef<string | null>(null);
	active.current = desk.active;
	const running = useRef(false);
	running.current = state.running;

	const refresh = useCallback(() => { void ask({ type: "list" }).then((next) => setList(next as Conversation[])).catch(() => {}); }, [ask]);
	const loadChanges = useCallback((id: string | null) => {
		if (!id) { setChanges(NO_CHANGES); return; }
		void ask({ type: "changes", id }).then((next) => { if (active.current === id) { settling.current = false; setChanges(next as Changes); } }, () => { settling.current = false; });
	}, [ask]);
	// A new model starts with an empty cache: the moment to offer a smaller context, while the old model can still write it.
	const lastModel = useRef<string | null>(null);
	useEffect(() => {
		const model = info?.model ?? null, before = lastModel.current;
		lastModel.current = model;
		if (!before || !model || before === model || !desk.active || state.running || !state.model) return;
		if (state.model === model) setOffer(null);
		else if ((state.context ?? 0) >= WORTH_COMPACTING) setOffer({ text: t("modelCache"), then: () => {} });
	}, [info?.model]);
	const pill = settling.current ? pillFiles.current : withLive(changes.files, liveEdits(state));
	pillFiles.current = pill;
	const finished = state.items.length && !state.running;
	useEffect(() => { void ask({ type: "info" }).then((next) => setInfo(next as ShellInfo)).catch(() => {}); }, [ask, finished]);
	useEffect(() => { void ask({ type: "memory" }).then((value) => setAgentsChars(((value as { agents?: string }).agents ?? "").length)).catch(() => {}); }, [ask, desk.view]);
	useEffect(() => { loadChanges(desk.active); setEditing(null); }, [desk.active, loadChanges]);
	useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 8000); return () => clearTimeout(timer); }, [notice]);

	useEffect(() => {
		refresh();
		// The bridge has no unsubscribe, so the page listens once for its whole life.
		if (listening) return;
		listening = true;
		// Streamed text arrives in many small pieces; the page takes them together, about 25 times a second.
		const held = new Map<string, { conversation: string; event: Extract<EngineEvent, { type: "message.delta" }> }>();
		const writing = new Map<string, { conversation: string; event: Extract<EngineEvent, { type: "tool.writing" }> }>();
		let timer: ReturnType<typeof setTimeout> | null = null;
		const flush = () => {
			if (timer) clearTimeout(timer);
			timer = null;
			for (const item of held.values()) dispatch(item);
			held.clear();
			for (const item of writing.values()) dispatch(item);
			writing.clear();
		};
		bridge.onEvent(({ conversation, event }) => {
			if (event.type === "tool.writing") {
				const key = `${conversation}\n${event.index}`, same = writing.get(key);
				writing.set(key, { conversation, event: same ? { ...same.event, text: same.event.text + event.text } : event });
				timer ??= setTimeout(flush, 40);
				return;
			}
			if (event.type === "message.delta") {
				const key = `${conversation}\n${event.agent ?? ""}`;
				const waiting = held.get(key);
				if (waiting && waiting.event.kind !== event.kind) flush();
				const same = held.get(key);
				held.set(key, { conversation, event: same ? { ...same.event, text: same.event.text + event.text } : event });
				timer ??= setTimeout(flush, 40);
				return;
			}
			flush();
			// A team member's events go to its own transcript and touch nothing else here.
			if (event.agent) {
				dispatch({ conversation, event });
				if (event.type === "approval.requested" || event.type === "approval.resolved") refresh();
				return;
			}
			if (conversation === active.current || active.current === null) {
				if (event.type === "run.started" || event.type === "run.interjected") { setText(""); setAttachments([]); draft.current = null; }
				if (event.type === "error" && !running.current && draft.current) { const { text: back, attachments: files } = draft.current; setText(back); setAttachments(files); draft.current = null; }
			}
			if (conversation === active.current && event.type === "run.completed") { settling.current = true; loadChanges(conversation); }
			if (LOOKS && event.type === "tool.completed" && event.tool === "set_appearance" && event.ok) {
				const theme = (event.details as { theme?: unknown }).theme;
				if (typeof theme === "string") { applyTheme(theme); setPreview(theme); }
			}
			dispatch({ conversation, event });
			if (event.type === "run.started" || event.type === "run.completed" || event.type === "approval.requested" || event.type === "approval.resolved") refresh();
		});
	}, [refresh, loadChanges]);

	// The view stays at the newest unless the user has scrolled up to read; then a button brings them back.
	const pinned = useRef(true);
	const programmaticScroll = useRef(false);
	const lastTop = useRef(0);
	const syncToBottom = useCallback((force = false) => {
		const node = transcript.current;
		if (!node || !pinned.current) return;
		const target = Math.max(0, node.scrollHeight - node.clientHeight);
		// While streaming, never nudge scrollTop upward on transient height dips; only advance monotonically downward.
		if (!force && running.current && target <= node.scrollTop) return;
		if (Math.abs(target - node.scrollTop) < 2) return;
		programmaticScroll.current = true;
		node.scrollTop = target;
		lastTop.current = node.scrollTop;
		requestAnimationFrame(() => { programmaticScroll.current = false; });
	}, []);
	useEffect(() => {
		syncToBottom(!running.current);
	}, [state.items, desk.active, syncToBottom]);
	useEffect(() => { pinned.current = true; lastTop.current = 0; setAway(false); }, [desk.active]);
	// Words arrive on their own beat, after the state that holds them: the view follows the page, not the state.
	useEffect(() => {
		const node = transcript.current;
		if (!node) return;
		let raf = 0;
		const follow = new MutationObserver(() => {
			if (!pinned.current || raf) return;
			raf = requestAnimationFrame(() => { raf = 0; syncToBottom(false); });
		});
		follow.observe(node, { childList: true, subtree: true, characterData: true });
		return () => { if (raf) cancelAnimationFrame(raf); follow.disconnect(); };
	}, [desk.active, state.items.length > 0, syncToBottom]);
	const onWheel = (event: { deltaY: number }) => {
		if (event.deltaY < -1 && pinned.current) {
			const node = transcript.current;
			if (node && node.scrollHeight > node.clientHeight + 4) {
				pinned.current = false;
				setAway(true);
			}
		}
	};
	const onScroll = () => {
		const node = transcript.current;
		if (!node) return;
		const top = node.scrollTop;
		const gap = node.scrollHeight - top - node.clientHeight;
		if (programmaticScroll.current) {
			lastTop.current = top;
			return;
		}
		if (top < lastTop.current - 2 && gap > 12) {
			pinned.current = false;
			setAway(true);
		} else if (gap < 28) {
			pinned.current = true;
			setAway(false);
		} else if (!pinned.current) {
			setAway(gap >= 40);
		}
		lastTop.current = top;
	};
	const toBottom = () => {
		const node = transcript.current;
		pinned.current = true;
		setAway(false);
		if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
	};

	const current = list.find((conversation) => conversation.id === desk.active);
	const title = current?.title || splitNote(state.title).text;
	useEffect(() => { document.title = title ? `Mountains — ${title}` : "Mountains"; }, [title]);

	const send = useCallback((command: EngineCommand) => {
		if (active.current) bridge.send({ conversation: active.current, command });
	}, []);

	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape" || !running.current || event.defaultPrevented) return;
			event.preventDefault();
			send({ protocolVersion: PROTOCOL_VERSION, type: "run.cancel" });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [send]);

	const open = useCallback((id: string | null, view: Desk["view"] = "chat") => {
		dispatch({ open: id, view });
		setChangesOpen(false);
		setAgentView(false);
		setFinding(false);
		if (id && !desk.transcripts[id]) void ask({ type: "history", id }).then((history) => dispatch({ conversation: id, history: history as EngineEvent[] }));
	}, [ask, desk.transcripts]);

	/** Makes the conversation a new message goes to, in the folder chosen for it. */
	const ensure = async (): Promise<string> => {
		if (desk.active) return desk.active;
		const created = await ask({ type: "create", ...(folder ? { workspace: folder } : {}), ...(memory.save ? {} : { memory }) }) as Conversation;
		dispatch({ open: created.id });
		active.current = created.id;
		setFolder(null);
		setMemory({ save: true, read: true });
		return created.id;
	};

	const compact = (id: string) => ask({ type: "compact", id }).then((result) => {
		if (!result) setNotice(t("noCompactNeeded"));
	}, (error: unknown) => setNotice(reason(error)));

	const sendTask = async (task: string, asked = false) => {
		if (info && !info.ready) { addModel(); return; }
		const pack = await ask({ type: "installSkills", text: task, paths: attachments.map((item) => item.path) }).then((value) => value as { installed: { name: string; source: string }[]; failed: { source: string; error: string }[] }, (error: unknown) => { setNotice(reason(error)); return { installed: [], failed: [] }; });
		let next = task;
		for (const source of pack.installed.map((item) => item.source)) next = next.split(source).join(" ");
		next = next.replace(/[ \t]{2,}/g, " ").replace(/ *\n */g, "\n").trim();
		const cited = pack.installed.filter((item) => !new RegExp(`(^|[\\s([{])@${item.name}\\b`).test(next)).map((item) => `@${item.name}`);
		if (cited.length && next) next = `${cited.join(" ")} ${next}`;
		const notes = [
			...(pack.installed.length ? [t("installedSkills", { names: pack.installed.map((item) => item.name).join(lang === "en" ? ", " : "、") })] : []),
			...pack.failed.map((item) => item.error),
		];
		if (notes.length) setNotice(notes.join("\n"));
		if (!next) { setText(""); setAttachments([]); return; }
		// While a run goes on, a message joins it; the box clears once the run has taken it.
		if (state.running) { send({ protocolVersion: PROTOCOL_VERSION, type: "run.interject", text: next }); return; }
		const idle = current?.finishedAt ? Math.floor((Date.now() - current.finishedAt) / 60_000) : 0;
		if (!asked && current && idle >= CACHE_MINUTES && (state.context ?? 0) >= WORTH_COMPACTING) {
			setOffer({ text: t("cacheIdle", { n: idle }), then: () => void sendTask(next, true) });
			return;
		}
		draft.current = { text, attachments };
		const fresh = !desk.active;
		const id = await ensure();
		if (fresh && planDraft) { setPlanDraft(false); setList(await ask({ type: "plan", id, enabled: true }) as Conversation[]); }
		bridge.send({ conversation: id, command: { protocolVersion: PROTOCOL_VERSION, type: "run.start", task: next } });
	};
	const setPlan = (on: boolean) => {
		if (!desk.active) { setPlanDraft(on); return; }
		void ask({ type: "plan", id: desk.active, enabled: on }).then((next) => setList(next as Conversation[]), (error: unknown) => setNotice(reason(error)));
	};
	const startGoal = async (goal: string) => {
		const id = await ensure();
		void ask({ type: "goal", id, text: goal }).then((next) => { setList(next as Conversation[]); setText(""); setAttachments([]); }, (error: unknown) => setNotice(reason(error)));
	};
	const answer = (toolCallId: string, decision: "allow" | "deny") => {
		send({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId, decision });
		if (desk.active) dispatch({ conversation: desk.active, answered: toolCallId });
	};

	/** Back to just before a message, then the message again (edited, or as it was for 重新生成). */
	const resend = useCallback(async (run: string, task: string, files: boolean) => {
		const id = active.current;
		if (!id) return;
		try {
			const result = await ask({ type: "rewind", id, run, files }) as { events: EngineEvent[]; conflicts: string[] };
			setEditing(null);
			dispatch({ conversation: id, history: result.events });
			pinned.current = true;
			if (result.conflicts.length) setNotice(t("filesConflict", { n: result.conflicts.length, names: result.conflicts.join(lang === "en" ? ", " : "、") }));
			// Should the run not start, the message comes back to the composer instead of being lost.
			draft.current = { text: splitNote(task).text, attachments: [] };
			bridge.send({ conversation: id, command: { protocolVersion: PROTOCOL_VERSION, type: "run.start", task } });
			loadChanges(id);
		} catch (error) { setNotice(reason(error)); }
	}, [ask, loadChanges, t, lang]);

	const runs = useMemo(() => state.items.filter((item): item is Extract<Item, { type: "user" }> => item.type === "user" && !!item.start), [state.items]);
	const lastRun = runs[runs.length - 1];
	const failure = [...state.items].reverse().find((item): item is Extract<Item, { type: "error" }> => item.type === "error" && !item.reconnecting);
	const balance = failure && !state.running && BALANCE_RE.test(failure.text) ? failure.text : null;
	const bill = billingLink(info?.key.env ?? "");
	const regenerate = useCallback(() => {
		if (lastRun && !running.current) void resend(lastRun.id, lastRun.text, true);
	}, [lastRun, resend]);

	// The menu bar and notifications ask to open a conversation or a page, or to run a command here.
	const commands = useRef<Record<string, () => void>>({});
	commands.current = {
		find: () => { if (desk.view === "chat" && state.items.length) setFinding(true); },
		export: () => { if (desk.active) void ask({ type: "export", id: desk.active }); },
		regenerate,
		changes: () => { if (changes.files.length || changes.points.length) { setAgentView(false); setChangesOpen((now) => !now); } },
		attach: () => void ask({ type: "chooseFiles" }).then((paths) => setAttachments((now) => [...now, ...(paths as string[]).filter((p) => !now.some((a) => a.path === p)).map((path): Attachment => ({ kind: /\.(png|jpe?g|gif|webp|heic)$/i.test(path) ? "image" : "file", path }))]), () => {}),
		new: () => openRef.current(null),
		settings: () => openRef.current(null, "settings"),
	};
	// Windows has no menu bar, so the page takes the menu's shortcuts itself.
	useEffect(() => {
		if (/Mac/.test(navigator.platform)) return;
		const keys: Record<string, string> = { f: "find", r: "regenerate", u: "attach", n: "new", ",": "settings", E: "export", D: "changes" };
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (!event.ctrlKey || event.altKey || event.metaKey) return;
			const command = keys[event.shiftKey ? event.key.toUpperCase() : event.key.toLowerCase()];
			if (!command || (event.shiftKey !== (command === "export" || command === "changes"))) return;
			event.preventDefault();
			commands.current[command]?.();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const openRef = useRef(open);
	openRef.current = open;
	useEffect(() => {
		if (listeningOpen) return;
		listeningOpen = true;
		bridge.onOpen((target) => {
			const request = typeof target === "object" && target !== null ? target as { view?: unknown; command?: unknown } : {};
			if (typeof request.command === "string") { commands.current[request.command]?.(); return; }
			const view = request.view;
			// Searching lives in 聊天记录.
			if (view === "search") {
				if (!document.querySelector(".dock-panel.open[data-panel=history]")) document.querySelector<HTMLElement>(".di[data-k=history]")?.click();
				setTimeout(() => document.querySelector<HTMLInputElement>(".history-search input")?.focus(), 80);
			} else if (view === "all" || view === "settings") openRef.current(null, view);
			else openRef.current(typeof target === "string" ? target : null);
		});
	}, []);

	const empty = desk.view === "chat" && !state.items.length;
	const firstRun = empty && info?.ready === false && !info.setupSkipped;
	// Each new conversation opens on a line of its own.
	const welcomed = useRef(true);
	useEffect(() => {
		if (empty) setGreeting(pickTitle(lang === "zh" ? "zh" : "en"));
		welcomed.current = empty;
	}, [empty, lang]);
	const plan = desk.active ? !!current?.plan : planDraft;

	// A reply's `-> send` button puts its text in the composer; the user sends it, the reply cannot.
	const draftFromReply = useCallback((line: string) => {
		setText((now) => now.trim() ? `${now.replace(/\s+$/, "")}\n${line}` : line);
		document.getElementById("composer")?.focus();
	}, []);
	// A reply whose components failed gets one more round on its own, once; the user can still ask with the button.
	const fix = useCallback((errors: string[]) => {
		const id = active.current;
		if (id) bridge.send({ conversation: id, command: { protocolVersion: PROTOCOL_VERSION, type: "run.start", task: `The SIUI in your last reply failed: ${errors.slice(0, 5).join("; ")}. Send the corrected reply.` } });
	}, []);
	const report = useCallback((what: string) => { void ask({ type: "siuiUse", what }).catch(() => {}); }, [ask]);
	const repaired = useRef(new Set<string>());
	const wasRunning = useRef(false);
	useEffect(() => {
		const ended = wasRunning.current && !state.running;
		wasRunning.current = state.running;
		if (!ended || current?.plan || current?.goal?.status === "active" || current?.goal?.status === "verifying") return;
		const reply = state.items[state.items.length - 1], asked = [...state.items].reverse().find((item) => item.type === "user");
		if (reply?.type !== "assistant" || repaired.current.has(reply.id) || asked?.type === "user" && asked.text.startsWith("The SIUI in your last reply failed:")) return;
		const nodes = parse(reply.text).flatMap((block) => block.kind === "ui" ? [block.node] : []);
		if (nodes.length) report("shown");
		const errors = problems(nodes);
		repaired.current.add(reply.id);
		if (errors.length) { report("repair"); fix(errors); }
	}, [state.running, state.items, current, fix, report]);

	// The look: what the user kept, and a change the model proposed, previewed until the user decides.
	const [looks, setLooks] = useState<Looks | null>(null);
	const [addingModel, setAddingModel] = useState(false);
	const [question, setQuestion] = useState<UserQuestion | null>(null);
	useEffect(() => { bridge.onAsk((next) => setQuestion(next)); }, []);
	const answerQuestion = (text: string) => {
		const current = question;
		if (!current?.conversation) { setQuestion(null); return; }
		setQuestion(null);
		void ask({ type: "answerAsk", id: current.conversation, askId: current.id, text });
	};
	const addModel = () => { setAddingModel(true); open(null, "settings"); };
	const [preview, setPreview] = useState<string | null>(null);
	const [naming, setNaming] = useState(false);
	useEffect(() => { if (LOOKS) void ask({ type: "appearance" }).then((next) => { setLooks(next as Looks); applyTheme((next as Looks).current); }, () => {}); }, [ask]);
	const keepLook = useCallback((theme: string | null) => { applyTheme(theme); void ask({ type: "keepTheme", theme }).then((next) => setLooks(next as Looks), () => {}); }, [ask]);
	useEffect(() => {
		const again = () => applyTheme(preview ?? looks?.current ?? null);
		const scheme = matchMedia("(prefers-color-scheme: light)");
		scheme.addEventListener("change", again);
		return () => scheme.removeEventListener("change", again);
	}, [preview, looks]);
	const decide = (keep: boolean) => {
		if (keep && preview) keepLook(preview); else applyTheme(looks?.current ?? null);
		setPreview(null);
		setNaming(false);
	};

	// An answered request leaves the way it came, instead of vanishing from under the pointer.
	const approvals = useLeavingList(state.approvals, (approval) => approval.toolCallId);
	const history = useMemo(() => state.items.filter((item) => item.type === "user").map((item) => splitNote((item as { text: string }).text).text), [state.items]);
	const agentsTooBig = !agentsGone && agentsChars > 0 && Math.ceil(agentsChars / 2) > (info?.contextWindow ?? 128_000);
	const refreshAgents = () => { void ask({ type: "memory" }).then((value) => setAgentsChars(((value as { agents?: string }).agents ?? "").length)); };
	const composer = (
		<Composer text={text} setText={setText} attachments={attachments} setAttachments={setAttachments} running={state.running}
			conversation={desk.active} plan={plan} history={history} folder={folder} onFolder={setFolder} save={memory.save} onSave={(save) => setMemory({ save, read: true })} ask={ask as never}
			onSend={(task) => void sendTask(task)} onStop={() => send({ protocolVersion: PROTOCOL_VERSION, type: "run.cancel" })}
			onPlan={setPlan}
			onGoal={(goal) => void startGoal(goal)} onNew={() => open(null)} onCompact={() => { if (desk.active) void compact(desk.active); }} onExport={() => commands.current.export?.()}
			pathForFile={(file) => bridge.pathForFile(file)}
			top={approvals.length || offer || question || info?.ready === false || balance || agentsTooBig ? (
				<div className="approvals">
					{agentsTooBig ? <AgentsLarge busy={agentsBusy} onEdit={() => { open(desk.active, "settings"); setTimeout(() => document.getElementById("agents-md")?.focus(), 40); }} onSummarize={() => { setAgentsBusy(true); void ask({ type: "summarizeAgents" }).then(refreshAgents, (error: unknown) => setNotice(reason(error))).finally(() => setAgentsBusy(false)); }} onTruncate={() => { setAgentsBusy(true); void ask({ type: "truncateAgents" }).then(refreshAgents, (error: unknown) => setNotice(reason(error))).finally(() => setAgentsBusy(false)); }} onCancel={() => setAgentsGone(true)} /> : null}
					{question ? <AskCard question={question} onAnswer={answerQuestion} /> : null}
					{balance ? (
							<section className="need" aria-label={t("needsAttention")}>
							<h2>{bill ? `${bill.name} ${t("lowBalance")}` : t("lowBalance")}</h2>
							<div className="need-acts">
								{bill ? <button type="button" className="allow" onClick={() => void ask({ type: "open", url: bill.url })}>{t("openPlatform")}</button> : null}
								<button type="button" className="deny" onClick={regenerate}>{t("retry")}</button>
								<button type="button" className="deny" onClick={addModel}>{t("switchModel")}</button>
							</div>
						</section>
					) : null}
					{info?.ready === false && !firstRun ? <NoModel onAdd={addModel} /> : null}
					{offer ? <CompactOffer text={offer.text} onAnswer={(yes) => {
						const id = desk.active;
						setOffer(null);
						if (yes && id) void compact(id).then(offer.then); else offer.then();
					}} /> : null}
					{approvals.map(({ item: approval, leaving }) => <ApprovalCard key={approval.toolCallId} approval={approval} leaving={leaving} onAnswer={(decision) => { if (!leaving) answer(approval.toolCallId, decision); }} />)}
				</div>
			) : null}
			bar={<ContextGauge used={state.context} window={info?.contextWindow ?? null} parts={state.contextParts} />} />
	);
	// A plan written in plan mode, with nothing after it yet: the user can approve it here.
	const planReady = plan && !state.running && state.items[state.items.length - 1]?.type === "assistant" && !!desk.active;

	const approvalState = approvalLabel(info);
	const dockItems: Record<string, DockItem> = {
		new: { key: "new", label: t("newChat"), icon: DockIcons.new, current: desk.view === "chat" && !desk.active, onClick: () => open(null) },
		history: { key: "history", label: t("history"), icon: DockIcons.history, current: desk.view === "all", panel: (close) => (
			<HistoryPanel ask={ask as never} list={list} active={desk.view === "chat" ? desk.active : null} renaming={renaming} deleting={deleting}
				onOpen={(id) => { close(); open(id); }} onAll={() => { close(); open(null, "all"); }}
				onMenu={(id, x, y) => setMenu({ id, x, y })}
				onRename={(id, title) => { setRenaming(null); if (title) void ask({ type: "update", id, change: { title } }).then((next) => setList(next as Conversation[])); }}
				onDelete={(id) => { setDeleting(null); if (desk.active === id) open(null); void ask({ type: "remove", id }).then((next) => setList(next as Conversation[])); }}
				onCancelDelete={() => setDeleting(null)} />
		) },
		model: { key: "model", label: info?.ready ? info.displayName : t("model"), icon: DockIcons.model, panel: (close) => <ModelPanel info={info} ask={ask} onInfo={setInfo} onAdd={() => { close(); addModel(); }} /> },
		approval: { key: "approval", label: t(info?.approval === "auto" ? "autoMode" : info?.approval === "full" ? "fullMode" : "askMode"), icon: info?.approval === "auto" ? DockIcons.approvalCheck : DockIcons.approval, danger: approvalState.full, panel: (close) => <ApprovalPanel info={info} ask={ask} onInfo={setInfo} onDone={close} /> },
		settings: { key: "settings", label: t("settings"), icon: DockIcons.settings, current: desk.view === "settings", onClick: () => open(null, "settings") },
	};

	const showAgent = useCallback((name: string | null) => { setChangesOpen(false); setAgentView(name); }, []);
	const agentNames = [...new Set([...Object.keys(state.purposes), ...Object.keys(state.agents)])];
	const workingAgents = Object.values(state.agents).filter((a) => a.running).length;
	const shownBlocks = blocks(state.items, folded);
	const lastAssistant = [...shownBlocks].reverse().find((block) => block.type === "item" && block.item.type === "assistant");
	const runOrder = new Map(runs.map((run, index) => [run.id, index]));
	const changedAfter = (run: string) => { const from = runOrder.get(run) ?? Infinity; return changes.points.some((point) => (runOrder.get(point.run) ?? -1) >= from); };

	return (
		<>
			<div className="titlebar drag">{title ? `Mountains — ${title}` : "Mountains"}</div>
			<div className="shell">
				<Field working={desk.view === "chat" && state.running} />
				<div className="drag-strip drag" />
				<Dock side={dockSide} items={dockItems} groups={[["new", "history"], ["model", "approval"], ["settings"]]} />
				{menu ? <ConversationMenu at={menu} list={list} ask={ask as never} onClose={() => setMenu(null)} onChanged={setList} onRename={setRenaming} onDelete={setDeleting} /> : null}
				<main className={dockSide === "bottom" ? "dock-bottom" : undefined}>
					{desk.view !== "settings" ? <UpdateNotice ask={ask} onShow={() => open(desk.active, "settings")} /> : null}
					{desk.view === "all" ? (
						<AllConversations list={list} ask={ask} onOpen={(id) => open(id)} onChanged={setList} />
					) : desk.view === "settings" ? (
						<SettingsView info={info} ask={ask} onInfo={setInfo} themes={LOOKS ? looks : null} onTheme={keepLook} adding={addingModel} onAdding={setAddingModel} onConfigureSearch={() => { setText(t("searchDraft")); open(desk.active, "chat"); setTimeout(() => document.getElementById("composer")?.focus(), 40); }} dockSide={dockSide} onDockSide={(side) => {
							setDockSide(side);
							try { localStorage.setItem("mountains.dock.side", side); } catch { /* the setting stays for this window only */ }
						}} />
					) : (
						<div className="chat">
							<div className="chat-main">
								{empty ? null : <header className="topbar drag">{title || t("newChat")}</header>}
								{finding ? <FindBar onClose={() => setFinding(false)} /> : null}
								{firstRun && info ? <FirstRun info={info} ask={ask as never} onInfo={setInfo} /> : empty ? (
									<div className="welcome">
										{memory.save ? null : (
											<div className="memory-read" role="radiogroup" aria-label={t("personalize")}>
												<button type="button" role="radio" aria-checked={memory.read} onClick={() => setMemory({ save: false, read: true })}>{t("personalizeOn")}</button>
												<button type="button" role="radio" aria-checked={!memory.read} onClick={() => setMemory({ save: false, read: false })}>{t("personalizeOff")}</button>
											</div>
										)}
										<h1>{greeting}</h1>
										{composer}
									</div>
								) : (
									<>
										<OpenAgent.Provider value={showAgent}><ToolOutput.Provider value={toolOutput}><DraftContext.Provider value={draftFromReply}><FixContext.Provider value={fix}><UsageContext.Provider value={report}>
										<div className="transcript" ref={transcript} key={desk.active ?? "new"} onScroll={onScroll} onWheel={onWheel}>
											{shownBlocks.map((block) => {
												if (block.type === "tools") return <ToolBlock key={block.id} calls={block.calls} folded={folded} />;
												const item = block.item;
												if (item.type === "thinking") return <ThinkingRow key={item.id} text={item.text} startedAt={item.startedAt} {...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {})} />;
												if (item.type === "assistant") {
													const isLast = block === lastAssistant && !state.running;
													return (
														<div key={item.id} className={isLast ? "msg assistant last" : "msg assistant"}>
															<div className="bubble assistant"><Reply text={item.text} live={state.open === item.id} /></div>
															<Actions side="start" at={item.at}>
																<CopyButton text={item.text} />
																{isLast && lastRun ? <Act label={t("regenerate", { mod: document.documentElement.dataset.platform === "win" ? "Ctrl+" : "⌘" })} onClick={regenerate}><Redo /></Act> : null}
															</Actions>
														</div>
													);
												}
												if (item.type === "user") {
													if (editing === item.id) return <EditBox key={item.id} text={item.text} filesChanged={changedAfter(item.id)} onCancel={() => setEditing(null)} onSend={(value, files) => void resend(item.id, value, files)} />;
													return (
														<div key={item.id} className="msg user">
															<p className="bubble user"><UserText text={item.text} /></p>
															<Actions side="end" at={item.at}>
																<CopyButton text={splitNote(item.text).text} />
																{item.start ? <Act label={state.running ? t("stopBeforeEdit") : t("editResend")} disabled={state.running} onClick={() => setEditing(item.id)}><Edit /></Act> : null}
															</Actions>
														</div>
													);
												}
												if (item.type === "revision") return <div key={item.id} className="revision" role="status"><span className={item.state === "compacting" ? "shimmer" : undefined}>{t(item.state === "folded" ? "folded" : item.state, item.state === "folded" ? { n: item.count ?? 0 } : undefined)}</span></div>;
												if (item.type === "error" && item.reconnecting) return <Reconnect key={item.id} attempt={item.attempt ?? 1} />;
												if (item.type === "error" && CONTEXT_RE.test(item.text)) return <Fault key={item.id} text={item.text} onCopy={() => void navigator.clipboard.writeText(item.text)} onCompact={() => {
													const id = desk.active, task = lastRun?.text;
													if (id && task) void compact(id).then(() => bridge.send({ conversation: id, command: { protocolVersion: PROTOCOL_VERSION, type: "run.start", task } }));
												}} />;
				return <p key={item.id} className={`bubble ${item.type}`}>{item.text}</p>;
											})}
											{planReady ? (
												<div className="plan-ready">
													<button type="button" className="allow" onClick={() => { if (desk.active) void ask({ type: "approvePlan", id: desk.active }).then((next) => setList(next as Conversation[])); }}><Plan />{t("runPlan")}</button>
													<span>{t("orSay")}</span>
												</div>
											) : null}
										</div>
										</UsageContext.Provider></FixContext.Provider></DraftContext.Provider></ToolOutput.Provider></OpenAgent.Provider>
										<div className="composer-wrap">
											{current?.goal ? <GoalBar key={current.id} goal={current.goal} running={current.status !== "idle"} onAction={async (type, text) => { const next = await ask({ type, id: current.id, ...(text === undefined ? {} : { text }) }); setList(next as Conversation[]); }} /> : null}
											<div className="above-composer">
												{away ? <button type="button" className="to-bottom" aria-label={t("backToLatest")} onClick={toBottom}><ArrowDown /></button> : null}
												{preview ? (
													<div className="look-bar" role="status">
														<span>{t("lookChanged")}</span>
														{naming ? (
															<input className="rename" autoFocus placeholder={t("themeName")} aria-label={t("themeName")} onKeyDown={(event) => {
																if (event.key === "Escape") { event.stopPropagation(); setNaming(false); }
																if (event.key === "Enter" && event.currentTarget.value.trim()) void ask({ type: "saveTheme", theme: preview, name: event.currentTarget.value }).then((next) => { setLooks(next as Looks); setPreview(null); setNaming(false); }, (error: unknown) => setNotice(reason(error)));
															}} />
														) : (
															<>
																<button type="button" className="allow" onClick={() => decide(true)}>{t("keep")}</button>
																<button type="button" className="deny" onClick={() => decide(false)}>{t("undo")}</button>
																<button type="button" className="deny" onClick={() => setNaming(true)}>{t("saveTheme")}</button>
															</>
														)}
													</div>
												) : null}
												{agentNames.length && agentView === false ? <button type="button" className="changes-pill" onClick={() => showAgent(null)}>{workingAgents ? t("agentsWorking", { n: workingAgents }) : t("agentsCount", { n: agentNames.length })}</button> : null}
												{notice ? <p className="notice" role="status">{notice}</p> : !changesOpen && (pill.length || changes.points.length) ? <ChangesPill files={pill} onOpen={() => { setAgentView(false); setChangesOpen(true); }} /> : null}
											</div>
											{composer}
										</div>
									</>
								)}
							</div>
							{agentView !== false ? <OpenAgent.Provider value={showAgent}><ToolOutput.Provider value={toolOutput}><DraftContext.Provider value={draftFromReply}><UsageContext.Provider value={report}><AgentsPanel state={state} name={agentView} folded={folded} onOpen={showAgent} onClose={() => setAgentView(false)} /></UsageContext.Provider></DraftContext.Provider></ToolOutput.Provider></OpenAgent.Provider> : changesOpen && desk.active ? (
								<ChangesPanel conversation={desk.active} changes={changes} running={state.running} ask={ask as never} onClose={() => setChangesOpen(false)}
									onChanged={(message) => { setNotice(message); loadChanges(desk.active); }} />
							) : null}
						</div>
					)}
				</main>
			</div>
		</>
	);
}
