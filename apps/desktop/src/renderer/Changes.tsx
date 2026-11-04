/**
 * The files this conversation changed (the Changes board): a pill over the composer, and a panel beside the
 * conversation with each file's diff, 撤销全部, and the points before each run that files can go back to.
 */
import { useCallback, useEffect, useState } from "react";
import { Cross, Folder } from "./icons.tsx";
import { RollingNumber } from "./Motion.tsx";
import type { LiveEdit } from "./transcript.ts";

export interface ChangedFile { path: string; added: number | null; removed: number | null }
export interface Changes { files: ChangedFile[]; points: { run: string; task: string; at: number }[]; canRedo?: boolean }

type Ask = (request: { type: string; [key: string]: unknown }) => Promise<unknown>;

const sum = (files: ChangedFile[], key: "added" | "removed") => files.reduce((n, f) => n + (f[key] ?? 0), 0);

/** The files as they stand, with what the running reply has added to them so far. */
export function withLive(files: ChangedFile[], live: LiveEdit[]): ChangedFile[] {
	const out = files.map((file) => ({ ...file }));
	for (const edit of live) {
		const path = edit.path.replace(/^\.\//, "");
		const file = out.find((f) => f.path === path || path.endsWith(`/${f.path}`));
		if (file) { file.added = (file.added ?? 0) + edit.added; file.removed = (file.removed ?? 0) + edit.removed; }
		else out.push({ path, added: edit.added, removed: edit.removed });
	}
	return out;
}

/** Stays once the conversation has changed a file; its numbers roll as the model writes. */
export function ChangesPill({ files, onOpen }: { files: ChangedFile[]; onOpen: () => void }) {
	return (
		<button type="button" className="changes-pill" onClick={onOpen}>
			<RollingNumber value={files.length} /> 个文件已修改 <span className="plus">+<RollingNumber value={sum(files, "added")} /></span> <span className="minus">−<RollingNumber value={sum(files, "removed")} /></span>
		</button>
	);
}

function ago(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
}

const clip = (text: string, n = 24) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > n ? `${flat.slice(0, n)}…` : flat; };

/** A unified diff, line by line; the file headers are left out, the panel already names the file. */
function Diff({ patch }: { patch: string }) {
	const lines = patch.split("\n").filter((line) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(line));
	if (!lines.some(Boolean)) return <p className="changes-empty">和原来一样</p>;
	return (
		<pre className="changes-diff">
			{lines.map((line, i) => {
				const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "plus" : line.startsWith("-") ? "minus" : "same";
				return <div key={i} className={`diff-line ${kind}`}>{line || " "}</div>;
			})}
		</pre>
	);
}

export function ChangesPanel({ conversation, changes, running, ask, onClose, onChanged }: { conversation: string; changes: Changes; running: boolean; ask: Ask; onClose: () => void; onChanged: (message: string | null) => void }) {
	const [selected, setSelected] = useState<string | null>(changes.files[0]?.path ?? null);
	const [patch, setPatch] = useState("");
	const [confirm, setConfirm] = useState<string | null | undefined>(undefined);
	const path = selected && changes.files.some((f) => f.path === selected) ? selected : changes.files[0]?.path ?? null;
	useEffect(() => {
		if (!path) { setPatch(""); return; }
		let live = true;
		void ask({ type: "diff", id: conversation, path }).then((text) => { if (live) setPatch(text as string); }, () => {});
		return () => { live = false; };
	}, [ask, conversation, path, changes]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => { if (event.key === "Escape" && confirm === undefined) onClose(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose, confirm]);
	const restore = useCallback((run: string | null) => {
		setConfirm(undefined);
		void ask({ type: "restore", id: conversation, run }).then((result) => {
			const { restored, conflicts } = result as { restored: string[]; conflicts: string[] };
			onChanged(conflicts.length ? `撤回了 ${restored.length} 个文件；${conflicts.length} 个文件之后又被改过，没有动：${conflicts.join("、")}` : `撤回了 ${restored.length} 个文件`);
		}, (error: unknown) => onChanged(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)));
	}, [ask, conversation, onChanged]);

	const redo = () => void ask({ type: "redo", id: conversation }).then((result) => {
		const { restored, conflicts } = result as { restored: string[]; conflicts: string[] };
		onChanged(conflicts.length ? `恢复了 ${restored.length} 个文件；${conflicts.length} 个文件之后又被改过，没有动：${conflicts.join("、")}` : `恢复了 ${restored.length} 个文件`);
	}, (error: unknown) => onChanged(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)));

	return (
		<aside className="changes" aria-label="改动">
			<header className="changes-head drag">
				<span className="changes-title">改动 <span className="plus">+{sum(changes.files, "added")}</span> <span className="minus">−{sum(changes.files, "removed")}</span></span>
				<span className="grow" />
				{changes.canRedo ? <button type="button" className="ghost" disabled={running} onClick={redo}>恢复撤回</button> : null}
				{changes.files.length ? (confirm === null
					? <span className="confirm"><button type="button" className="danger" onClick={() => restore(null)}>撤销全部</button><button type="button" onClick={() => setConfirm(undefined)}>取消</button></span>
					: <button type="button" className="ghost" disabled={running} onClick={() => setConfirm(null)}>撤销全部</button>) : null}
				<button type="button" className="act" aria-label="关闭" onClick={onClose}><Cross /></button>
			</header>
			<div className="changes-files">
				{changes.files.length ? changes.files.map((file) => (
					<div key={file.path} className={file.path === path ? "changes-file on" : "changes-file"}>
						<button type="button" className="changes-pick" onClick={() => setSelected(file.path)}>
							<span className="mono">{file.path}</span>
							<span className="counts">{file.added === null ? <span>二进制</span> : <><span className="plus">+{file.added}</span><span className="minus">−{file.removed}</span></>}</span>
						</button>
						<button type="button" className="act" aria-label="在访达中显示" title="在访达中显示" onClick={() => void ask({ type: "reveal", id: conversation, path: file.path })}><Folder /></button>
					</div>
				)) : <p className="changes-empty">文件都和对话开始前一样</p>}
			</div>
			<div className="changes-body">{path ? <Diff patch={patch} /> : null}</div>
			{changes.points.length ? (
				<footer className="changes-points">
					<div className="changes-label">检查点</div>
					{[...changes.points].reverse().map((point) => (
						<div key={point.run} className="point">
							<span className="point-name">「{clip(point.task)}」之前</span>
							<span className="point-when"> · {ago(point.at)}</span>
							<span className="grow" />
							{confirm === point.run
								? <span className="confirm"><button type="button" className="danger" onClick={() => restore(point.run)}>恢复</button><button type="button" onClick={() => setConfirm(undefined)}>取消</button></span>
								: <button type="button" className="link" disabled={running} onClick={() => setConfirm(point.run)}>恢复到此处</button>}
						</div>
					))}
				</footer>
			) : null}
		</aside>
	);
}
