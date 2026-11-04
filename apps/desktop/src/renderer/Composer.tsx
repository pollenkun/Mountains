/**
 * The composer: what the user writes, the files that go with it, and the menus that help write it —
 * `/` for commands and skills, `@` to cite a skill for the model, ↑ for an earlier message, + for files and modes.
 * Attachments go into the message as their paths; the model reads them with its own tools.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Popover } from "./Bar.tsx";
import { Cross, Folder, Plan, Plus, Send, TextFile, Image as ImageIcon } from "./icons.tsx";
import { Reveal, useLeaving } from "./Motion.tsx";
import { useI18n } from "./i18n.tsx";

export interface Attachment { kind: "text" | "image" | "file"; path: string; lines?: number }

type Ask = (request: { type: string; [key: string]: unknown }) => Promise<unknown>;

interface MenuItem { key: string; label: string; note: string; run: () => void }

const BUILT_IN = [
	{ name: "plan" }, { name: "goal" }, { name: "new" }, { name: "compact" }, { name: "export" },
] as const;

/** Paste this long or longer becomes a file, shown as one chip instead of filling the box. */
const LONG_PASTE = { lines: 40, chars: 4000 };

const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
const quoted = (path: string) => /\s/.test(path) ? `"${path}"` : path;

export function shortPath(path: string, home: string | null): string {
	return home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) ? `~${path.slice(home.length)}` : path;
}

/** The message as sent: the user's words, then each attachment's path on its own line. */
export function withAttachments(text: string, attachments: readonly Attachment[]): string {
	const paths = attachments.map((a) => quoted(a.path));
	return [text.trim(), paths.join("\n")].filter(Boolean).join("\n\n");
}

export interface ComposerProps {
	text: string;
	setText: (update: string | ((current: string) => string)) => void;
	attachments: Attachment[];
	setAttachments: (update: Attachment[] | ((current: Attachment[]) => Attachment[])) => void;
	running: boolean;
	/** The conversation, or null for a new one (which may still choose its folder). */
	conversation: string | null;
	plan: boolean;
	/** Earlier messages of this conversation, oldest first, for ↑. */
	history: string[];
	/** For a new conversation: the folder it will work in, and changing it. */
	folder: string | null;
	onFolder: (path: string | null) => void;
	ask: Ask;
	onSend: (task: string) => void;
	onStop: () => void;
	onPlan: (on: boolean) => void;
	onGoal: (goal: string) => void;
	/** Whether the next conversation is saved into memory. */
	save: boolean;
	onSave: (save: boolean) => void;
	onNew: () => void;
	onCompact: () => void;
	onExport: () => void;
	pathForFile: (file: File) => string;
	/** Approval requests, drawn at the top of the composer. */
	top?: ReactNode;
	/** Quiet facts at the end of the composer: the context gauge and this conversation's spend. */
	bar: ReactNode;
}

export function Composer(props: ComposerProps) {
	const { t } = useI18n();
	const { text, setText, attachments, setAttachments, running, ask } = props;
	const box = useRef<HTMLTextAreaElement>(null);
	const [dropping, setDropping] = useState(false);
	const [selected, setSelected] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
	const [recall, setRecall] = useState<number | null>(null);
	const [caret, setCaret] = useState(0);

	// What the menus answer to: "/word" alone at the start, or "@word" citing a skill right before the caret.
	const slash = /^\/([\w-]*)$/.exec(text);
	const at = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
	const trigger = slash ? `/${slash[1]}` : at ? `@${at[2]}` : null;
	const open = trigger !== null && trigger !== dismissed;

	useEffect(() => {
		if ((!slash && !at) || !open) return;
		let live = true;
		void ask({ type: "skills", id: props.conversation ?? "" }).then((list) => { if (live) setSkills(list as typeof skills); }, () => {});
		return () => { live = false; };
		// Skills are read once each time the menu opens.
	}, [!!slash && open, !!at && open, props.conversation]);

	// The box grows with what is written; past one line the pill's ends soften into corners.
	const [tall, setTall] = useState(false);
	const planChip = useLeaving(props.plan);
	useEffect(() => {
		const node = box.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(220, node.scrollHeight)}px`;
		setTall(node.scrollHeight > 40);
	}, [text]);

	const focus = () => box.current?.focus();
	const putCaret = (position: number) => requestAnimationFrame(() => { box.current?.setSelectionRange(position, position); setCaret(position); });

	const items: MenuItem[] = useMemo(() => {
		if (!open) return [];
		if (slash) {
			const word = slash[1]!.toLowerCase();
			const builtIn: MenuItem[] = BUILT_IN.filter((c) => c.name.startsWith(word)).map((c) => ({
				key: c.name, label: `/${c.name}`, note: "",
				run: () => {
					if (c.name === "plan") { props.onPlan(true); setText(""); }
					else if (c.name === "goal") { setText("/goal "); putCaret(6); }
					else if (c.name === "new") { setText(""); props.onNew(); }
					else if (c.name === "compact") { setText(""); props.onCompact(); }
					else { setText(""); props.onExport(); }
				},
			}));
			const own: MenuItem[] = skills.filter((s) => s.name.includes(word)).map((s) => ({ key: `skill:${s.name}`, label: `/${s.name}`, note: "", run: () => { setText(`/${s.name} `); putCaret(s.name.length + 2); } }));
			return [...builtIn, ...own];
		}
		if (at) {
			const word = at[2]!.toLowerCase();
			const start = caret - at[2]!.length - 1;
			return skills.filter((skill) => skill.name.includes(word)).map((skill) => ({
				key: skill.name, label: `@${skill.name}`, note: skill.description,
				run: () => {
					const insert = `@${skill.name} `;
					setText((current) => current.slice(0, start) + insert + current.slice(caret));
					putCaret(start + insert.length);
				},
			}));
		}
		return [];
	}, [open, slash?.[1], at?.[2], skills, caret]);
	useEffect(() => { setSelected(0); }, [trigger]);

	const submit = () => {
		const raw = text.trim();
		const goal = /^\/goal(?:\s+([\s\S]*))?$/.exec(raw);
		if (goal) { if (goal[1]?.trim()) { props.onGoal(withAttachments(goal[1], attachments)); } return; }
		const plan = /^\/plan(?:\s+([\s\S]*))?$/.exec(raw);
		if (plan) {
			props.onPlan(true);
			if (plan[1]?.trim() || attachments.length) props.onSend(withAttachments(plan[1] ?? "", attachments));
			else setText("");
			return;
		}
		if (raw === "/new") { setText(""); props.onNew(); return; }
		if (raw === "/compact") { setText(""); props.onCompact(); return; }
		if (raw === "/export") { setText(""); props.onExport(); return; }
		const task = withAttachments(text, attachments);
		if (task) props.onSend(task);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (open && items.length) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setSelected((n) => (n + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); items[Math.min(selected, items.length - 1)]!.run(); return; }
		}
		if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(trigger); return; }
		if (event.key === "Tab" && event.shiftKey) { event.preventDefault(); props.onPlan(!props.plan); return; }
		// ↑ at the very start brings back earlier messages; ↓ goes forward again, and past the newest clears the box.
		const target = event.currentTarget;
		if (event.key === "ArrowUp" && target.selectionStart === 0 && target.selectionEnd === 0 && props.history.length && (text === "" || recall !== null)) {
			event.preventDefault();
			const next = recall === null ? props.history.length - 1 : Math.max(0, recall - 1);
			setRecall(next);
			setText(props.history[next]!);
			return;
		}
		if (event.key === "ArrowDown" && recall !== null && target.selectionStart === text.length) {
			event.preventDefault();
			const next = recall + 1;
			if (next >= props.history.length) { setRecall(null); setText(""); }
			else { setRecall(next); setText(props.history[next]!); }
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
	};

	const addPaths = useCallback((paths: string[]) => {
		const fresh = paths.filter(Boolean).map((path): Attachment => ({ kind: /\.(png|jpe?g|gif|webp|heic)$/i.test(path) ? "image" : "file", path }));
		if (fresh.length) setAttachments((current) => [...current, ...fresh.filter((a) => !current.some((c) => c.path === a.path))]);
		focus();
	}, [setAttachments]);

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const data = event.clipboardData;
		const pasted = Array.from(data.files);
		if (pasted.length) {
			event.preventDefault();
			// Files copied in Finder have a path; a picture copied from a page or a screenshot does not and is saved.
			const onDisk = pasted.map((file) => props.pathForFile(file)).filter(Boolean);
			if (onDisk.length) { addPaths(onDisk); return; }
			for (const file of pasted.filter((f) => f.type.startsWith("image/"))) {
				void file.arrayBuffer().then((buffer) => ask({ type: "paste", kind: file.type === "image/jpeg" ? "jpg" : "png", data: new Uint8Array(buffer) }))
					.then((path) => setAttachments((current) => [...current, { kind: "image", path: path as string }]), () => {});
			}
			return;
		}
		const plain = data.getData("text/plain");
		const lines = plain.split("\n").length;
		if (lines >= LONG_PASTE.lines || plain.length >= LONG_PASTE.chars) {
			event.preventDefault();
			void ask({ type: "paste", kind: "txt", data: plain }).then((path) => setAttachments((current) => [...current, { kind: "text", path: path as string, lines }]), () => {});
		}
	};

	const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
	const onDrop = (event: DragEvent<HTMLFormElement>) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		setDropping(false);
		addPaths(Array.from(event.dataTransfer.files, (file) => props.pathForFile(file)));
	};
	const chooseFiles = () => void ask({ type: "chooseFiles" }).then((paths) => addPaths(paths as string[]), () => {});

	const empty = !text.trim() && !attachments.length;
	const onSubmit = (event: FormEvent) => { event.preventDefault(); if (running && empty) props.onStop(); else submit(); };

	return (
		<div className="composer-box">
			{open && items.length ? (
				<div className="menu-panel" role="listbox" aria-label={slash ? t("commandsSkills") : t("skills")}>
					{items.slice(0, 40).map((item, index) => (
						<button key={item.key} type="button" role="option" aria-selected={index === selected} className={index === selected ? "on" : undefined}
							onPointerDown={(event) => event.preventDefault()} onPointerEnter={() => setSelected(index)} onClick={() => item.run()}>
							<span className="menu-label">{item.label}</span>
							{item.note ? <span className="menu-note">{item.note}</span> : null}
						</button>
					))}
					<span className="menu-foot">{t("escClose")}</span>
				</div>
			) : null}
			{props.top}
			<Reveal open={attachments.length > 0 || props.plan || !!props.folder}>
				<div className="chips">
					{planChip.shown ? <button type="button" className="chip-mode" data-leaving={planChip.leaving || undefined} title={t("planModeTitle")} onClick={() => props.onPlan(false)}><Plan />{t("planChip")}<Cross /></button> : null}
					{props.folder ? <button type="button" className="chip-mode" title={props.folder} onClick={() => props.onFolder(null)}><Folder /><span className="mono">{baseName(props.folder)}</span><Cross /></button> : null}
					{attachments.map((a) => (
						<span key={a.path} className="attach" title={a.path}>
							{a.kind === "image" ? <ImageIcon /> : <TextFile />}
							<span className="attach-text">
								<span className="attach-name">{a.kind === "text" ? t("pastedText") : a.kind === "image" && /粘贴的图片|Pasted image/.test(a.path) ? t("pastedImage") : baseName(a.path)}</span>
								{a.kind === "text" && a.lines ? <span className="attach-note">{t("lineCount", { n: a.lines.toLocaleString("en-US") })}</span> : null}
							</span>
							<button type="button" className="attach-x" aria-label={t("remove")} onClick={() => setAttachments((current) => current.filter((c) => c.path !== a.path))}><Cross /></button>
						</span>
					))}
				</div>
			</Reveal>
			<form className={["composer", tall ? "tall" : "", dropping ? "dropping" : ""].filter(Boolean).join(" ")} onSubmit={onSubmit}
				onDragOver={(event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropping(true); }}
				onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
				onDrop={onDrop}>
				<PlusMenu newConversation={props.conversation === null} folder={props.folder} plan={props.plan} ask={ask} onFiles={chooseFiles} onPlan={props.onPlan} onGoal={() => { setText("/goal "); putCaret(6); }} save={props.save} onSave={props.onSave} onFolder={props.onFolder} />
				<label className="sr" htmlFor="composer">{t("messageTo")}</label>
				<textarea id="composer" ref={box} rows={1} placeholder={running ? t("followUp") : props.plan ? t("planPlaceholder") : t("placeholder")} value={text}
					onChange={(event) => { setText(event.target.value); setCaret(event.target.selectionStart); setRecall(null); setDismissed(null); }}
					onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
					onKeyDown={onKeyDown} onPaste={onPaste} />
				{props.bar}
				<button id="go" type="submit" className={running || !empty ? "on" : undefined} aria-label={running && empty ? t("stop") : t("send")} tabIndex={running || !empty ? 0 : -1}>
					{running && empty ? <span key="stop" className="go-icon"><span className="icon-stop" /></span> : <span key="send" className="go-icon"><Send /></span>}
				</button>
			</form>
		</div>
	);
}

function PlusMenu({ newConversation, folder, plan, ask, onFiles, onFolder, onPlan, onGoal, save, onSave }: { newConversation: boolean; folder: string | null; plan: boolean; ask: Ask; onFiles: () => void; onGoal: () => void; save: boolean; onSave: (save: boolean) => void; onFolder: (path: string | null) => void; onPlan: (on: boolean) => void }) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [recent, setRecent] = useState<{ home: string; folders: { path: string; git: boolean; isDefault: boolean }[] } | null>(null);
	useEffect(() => { if (open && newConversation) void ask({ type: "folders" }).then((value) => setRecent(value as typeof recent), () => {}); }, [ask, open, newConversation]);
	const close = useCallback(() => setOpen(false), []);
	const shown = folder ?? recent?.folders.find((f) => f.isDefault)?.path;
	return (
		<span className="anchor">
			<button type="button" className="ib" aria-label={t("add")} aria-expanded={open} onClick={() => setOpen(!open)}><Plus /></button>
			<Popover open={open} onClose={close} className="plus-menu">
				<button type="button" className="menu-row" onClick={() => { close(); onFiles(); }}>{t("addFiles")}<span className="kbd">{document.documentElement.dataset.platform === "win" ? "Ctrl+U" : "⌘U"}</span></button>
				<label className="menu-row switch-row">{t("planChip")}<span className="kbd">⇧⇥</span><input type="checkbox" className="switch" checked={plan} onChange={(event) => { onPlan(event.target.checked); close(); }} /></label>
				<button type="button" className="menu-row" onClick={() => { close(); onGoal(); }}>{t("goalMode")}</button>
				{newConversation ? (
					<>
						<hr />
						<div className="menu-head">{t("workFolder")}</div>
						{recent?.folders.map((f) => (
							<button key={f.path} type="button" className={f.path === shown ? "menu-row on" : "menu-row"} title={f.path} onClick={() => { close(); onFolder(f.isDefault ? null : f.path); }}>
								<span className="mono">{shortPath(f.path, recent.home)}</span><span className="kbd">{f.isDefault ? t("defaultWord") : f.git ? t("gitRepo") : ""}</span>
							</button>
						))}
						<button type="button" className="menu-row" onClick={() => { close(); void ask({ type: "chooseFolder" }).then((path) => { if (path) onFolder(path as string); }, () => {}); }}>{t("chooseFolder")}</button>
						<hr />
						<label className="menu-row switch-row">{t("saveToMemory")}<input type="checkbox" className="switch" checked={save} onChange={(event) => onSave(event.target.checked)} /></label>
					</>
				) : null}
			</Popover>
		</span>
	);
}
