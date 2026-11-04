/**
 * Many conversations, each with its own engine session. Their events are kept on disk so the list and the
 * transcripts survive a restart; a reopened conversation shows its history and continues its saved context.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type EngineEvent } from "@mountains/protocol";
import { createEngineHost, defaultWorkspace, type EngineHost, type HostOptions, type RunRecord } from "./engine-host.ts";
import { changedFiles, fileDiff, hashesAfter, keepFiles, restoreFiles, type ChangedFile, type RunChanges } from "./changes.ts";
import { GOAL_NOTE, nextRound, PLAN_GO, PLAN_NOTE, splitNote, type Goal } from "./modes.ts";

export type ConversationStatus = "idle" | "running" | "waiting";

export interface Conversation {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	status: ConversationStatus;
	pinned: boolean;
	archived: boolean;
	workspace: string;
	/** When the last run finished, for 刚刚完成 in the menu bar. */
	finishedAt?: number;
	/** Who named it, if anyone did: the user, or the title summary. Until then the title is the first request. */
	named?: "user" | "auto";
	/** The group the user moved it to. */
	group?: string;
	/** Chosen before the first message: kept out of memory search, and whether it reads memory itself. */
	memory?: { save: boolean; read: boolean };
	/** Plan mode: its runs may read but not change anything, until the user approves the plan. */
	plan?: boolean;
	/** Goal mode: the goal and how far it has got. */
	goal?: Goal;
}

export interface SearchHit {
	id: string;
	title: string;
	updatedAt: number;
	/** The hit is in something the user asked (shown as 你：…). */
	byUser: boolean;
	before: string;
	match: string;
	after: string;
}

export interface DeskOptions extends HostOptions {
	/** Where the list and each conversation's events live: ~/.mountains/desktop by default. */
	dataDir: string;
	/** Tests replace the engine host. */
	createHost?: (options: HostOptions) => EngineHost;
}

const ID = /^c_[0-9a-f]{12}$/;
/** How many of the latest messages keep their context for 修改 and 重新生成. */
const POINTS_KEPT = 40;

export function createDesk(options: DeskOptions) {
	mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
	const indexPath = join(options.dataDir, "conversations.json");
	const list = new Map<string, Conversation>();
	if (existsSync(indexPath)) {
		try {
			for (const entry of JSON.parse(readFileSync(indexPath, "utf8")) as Conversation[]) {
				// A run cannot outlive the app, so nothing is still running after a restart.
				if (ID.test(entry.id)) list.set(entry.id, { ...entry, status: "idle" });
			}
		} catch { /* an unreadable list starts empty; the event files stay on disk */ }
	}
	const hosts = new Map<string, EngineHost>();
	const listeners = new Set<(id: string, event: EngineEvent) => void>();
	const changes = new Set<() => void>();

	const save = () => writeFileSync(indexPath, `${JSON.stringify([...list.values()], null, 1)}\n`, { mode: 0o600 });
	const changed = () => { save(); for (const listener of changes) listener(); };
	const eventsPath = (id: string) => join(options.dataDir, id, "events.jsonl");
	const sessionPath = (id: string) => join(options.dataDir, id, "session.json");
	// Before each run, the context as it then was: from there an earlier message can be edited and sent again.
	const pointPath = (id: string, run: string) => join(options.dataDir, id, "points", `${run.replace(/[^\w-]/g, "_")}.json`);
	const runsPath = (id: string) => join(options.dataDir, id, "runs.jsonl");
	// The files as they were before the last 恢复/撤销, for taking it back. A new message clears it.
	const redoPath = (id: string) => join(options.dataDir, id, "redo.json");
	const workspaceOf = (conversation: Conversation) => conversation.workspace || options.workspace || defaultWorkspace();
	// The run each conversation is on (its run.started event), the last reply it gave, and whether it used a tool.
	const current = new Map<string, { run: string; task: string; reply: string; acted: boolean }>();
	// Streamed pieces wait here and go to disk as one line: stored one by one, a single reply took megabytes.
	const pieces = new Map<string, Extract<EngineEvent, { type: "message.delta" }>>();
	const writePieces = (id: string) => {
		const held = pieces.get(id);
		if (!held) return;
		pieces.delete(id);
		appendFileSync(eventsPath(id), `${JSON.stringify(held)}\n`, { mode: 0o600 });
	};

	function lines(path: string): string[] {
		return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
	}

	function runs(id: string): RunChanges[] {
		const out: RunChanges[] = [];
		for (const line of lines(runsPath(id))) { try { out.push(JSON.parse(line) as RunChanges); } catch { /* a torn last line */ } }
		return out;
	}

	/** After a run: the files it changed, with the snapshot from before it, so they can be shown and put back. */
	function noteRun(id: string, record: RunRecord): void {
		const conversation = list.get(id), run = current.get(id);
		if (!conversation || !run || !record.checkpoint?.changed.length) return;
		try {
			const entry: RunChanges = { run: run.run, outDir: record.outDir, tree: record.checkpoint.tree, changed: record.checkpoint.changed, after: hashesAfter(workspaceOf(conversation), record.checkpoint.changed), at: Date.now(), task: splitNote(run.task).text };
			appendFileSync(runsPath(id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch (error) { console.error(`mountains: the run's file changes were not kept: ${error instanceof Error ? error.message : String(error)}`); }
	}

	/** A goal round ended: start the next one, or end the goal. */
	function goalRound(id: string, event: Extract<EngineEvent, { type: "run.completed" }>): void {
		const conversation = list.get(id);
		if (!conversation?.goal || (conversation.goal.status !== "active" && conversation.goal.status !== "verifying")) return;
		const run = current.get(id);
		const { goal, send } = nextRound(conversation.goal, { status: event.status, reason: event.reason, reply: run?.reply ?? "", acted: run?.acted ?? false });
		conversation.goal = goal;
		changed();
		if (send) hostFor(id).handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: send });
	}

	function record(id: string, event: EngineEvent): void {
		const conversation = list.get(id);
		if (!conversation) return;
		// A team member's events are kept and shown, but its runs are not the conversation's.
		if (event.agent) {
			if (event.type !== "tool.writing" && event.type !== "message.delta") appendFileSync(eventsPath(id), `${JSON.stringify(event)}\n`, { mode: 0o600 });
			const before = conversation.status;
			if (event.type === "approval.requested" && event.source !== "model") conversation.status = "waiting";
			else if (event.type === "approval.resolved" && conversation.status === "waiting") conversation.status = "running";
			conversation.updatedAt = Date.now();
			for (const listener of listeners) listener(id, event);
			if (before !== conversation.status) changed();
			return;
		}
		if (event.type === "tool.writing") { /* for the page only: not kept */ }
		else if (event.type === "message.delta") {
			const held = pieces.get(id);
			if (held && held.kind !== event.kind) writePieces(id);
			const same = pieces.get(id);
			pieces.set(id, same ? { ...same, text: same.text + event.text } : event);
		} else {
			writePieces(id);
			appendFileSync(eventsPath(id), `${JSON.stringify(event)}\n`, { mode: 0o600 });
		}
		const before = conversation.status;
		if (event.type === "run.started") {
			conversation.status = "running";
			if (!conversation.title) conversation.title = splitNote(event.task).text.replace(/\s+/g, " ").trim().slice(0, 60);
			current.set(id, { run: event.eventId, task: event.task, reply: "", acted: false });
			rmSync(redoPath(id), { force: true });
			try {
				mkdirSync(join(options.dataDir, id, "points"), { recursive: true, mode: 0o700 });
				if (existsSync(sessionPath(id))) copyFileSync(sessionPath(id), pointPath(id, event.eventId));
				else writeFileSync(pointPath(id, event.eventId), "null\n", { mode: 0o600 });
				// Only the latest messages can be gone back to; each point is a copy of the whole context.
				const dir = join(options.dataDir, id, "points");
				const old = readdirSync(dir).map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at).slice(POINTS_KEPT);
				for (const { name } of old) rmSync(join(dir, name), { force: true });
			} catch (error) { console.error(`mountains: the context before this run was not kept: ${error instanceof Error ? error.message : String(error)}`); }
		} else if (event.type === "tool.completed") {
			const run = current.get(id);
			if (run) run.acted = true;
		} else if (event.type === "message.completed" && event.text) {
			const run = current.get(id);
			if (run) run.reply = event.text;
		} else if (event.type === "approval.requested" && event.source !== "model") conversation.status = "waiting";
		else if (event.type === "approval.resolved" && conversation.status === "waiting") conversation.status = "running";
		else if (event.type === "run.completed") { conversation.status = "idle"; conversation.finishedAt = Date.now(); }
		conversation.updatedAt = Date.now();
		for (const listener of listeners) listener(id, event);
		if (before !== conversation.status || event.type === "run.started") changed();
		if (event.type === "run.completed") goalRound(id, event);
	}

	function hostFor(id: string): EngineHost {
		let host = hosts.get(id);
		if (!host) {
			const make = options.createHost ?? createEngineHost;
			const conversation = list.get(id)!;
			host = make({ allowOutside: true, ...options, ...(conversation.memory?.read === false ? { memoryOff: true } : {}), memoryExclude: () => [...list.values()].filter((c) => c.memory?.save === false).map((c) => join(options.dataDir, c.id)), workspace: workspaceOf(conversation), outDir: join(options.dataDir, id, "run"), session: { id: `ses_${id}`, file: sessionPath(id) }, onRun: (run) => noteRun(id, run) });
			host.onEvent((event) => record(id, event));
			if (conversation.plan) host.setPlan?.(true);
			hosts.set(id, host);
		}
		return host;
	}

	return {
		dataDir: options.dataDir,
		onEvent(listener: (id: string, event: EngineEvent) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onChange(listener: () => void): () => void {
			changes.add(listener);
			return () => changes.delete(listener);
		},
		answerAsk(id: string, askId: string, text: string): boolean {
			if (!list.has(id)) return false;
			return hostFor(id).answerAsk(askId, text);
		},
		list(): Conversation[] {
			return [...list.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
		},
		/** A new conversation, in the folder the user chose or the default one. */
		create(workspace?: string, memory?: { save: boolean; read: boolean }): Conversation {
			const now = Date.now();
			const conversation: Conversation = { id: `c_${randomUUID().replace(/-/g, "").slice(0, 12)}`, title: "", createdAt: now, updatedAt: now, status: "idle", pinned: false, archived: false, workspace: workspace || options.workspace || "" };
			if (memory && !memory.save) conversation.memory = memory;
			mkdirSync(join(options.dataDir, conversation.id), { recursive: true, mode: 0o700 });
			list.set(conversation.id, conversation);
			changed();
			return conversation;
		},
		history(id: string): EngineEvent[] {
			writePieces(id);
			if (!list.has(id) || !existsSync(eventsPath(id))) return [];
			const events: EngineEvent[] = [];
			for (const line of readFileSync(eventsPath(id), "utf8").split("\n")) {
				if (!line) continue;
				try { events.push(JSON.parse(line) as EngineEvent); } catch { /* a torn last line is skipped */ }
			}
			return events;
		},
		/** Commands for an unknown conversation are dropped. A message sent in plan mode carries the plan note. */
		command(id: string, command: unknown): boolean {
			const conversation = list.get(id);
			if (!conversation) return false;
			const start = command && typeof command === "object" && (command as { type?: unknown }).type === "run.start" ? command as { task?: unknown } : null;
			if (start && conversation.plan && typeof start.task === "string") command = { ...start, task: start.task + PLAN_NOTE };
			hostFor(id).handleCommand(command);
			return true;
		},
		/** Plan mode on or off for this conversation's next messages. */
		setPlan(id: string, on: boolean): void {
			const conversation = list.get(id);
			if (!conversation) return;
			if (on) conversation.plan = true; else delete conversation.plan;
			hosts.get(id)?.setPlan(on);
			changed();
		},
		/** The user approves the plan: plan mode ends and the model is told to go ahead. */
		approvePlan(id: string): void {
			if (!list.has(id)) return;
			this.setPlan(id, false);
			hostFor(id).handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: PLAN_GO });
		},
		/** Starts a goal: its rounds go on until the model says it is met and one more round confirms it. */
		startGoal(id: string, text: string): void {
			const conversation = list.get(id);
			const goal = text.trim();
			if (!conversation || !goal) return;
			if (conversation.status !== "idle") throw new Error("这个对话正在运行，等它停下再定目标");
			if (conversation.plan) this.setPlan(id, false);
			conversation.goal = { text: goal, status: "active", rounds: 1, startedAt: Date.now() };
			changed();
			hostFor(id).handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: goal + GOAL_NOTE });
		},
		/** Pause future rounds without cancelling the current run. */
		pauseGoal(id: string): void {
			const c = list.get(id);
			if (!c?.goal || !["active", "verifying"].includes(c.goal.status)) return;
			c.goal = { ...c.goal, status: "paused" };
			changed();
		},
		resumeGoal(id: string): void {
			const c = list.get(id);
			if (!c?.goal || !["paused", "blocked", "stopped"].includes(c.goal.status)) return;
			const running = c.status !== "idle";
			c.goal = { ...c.goal, status: "active", reason: "", idle: 0, revised: running, rounds: c.goal.rounds + (running ? 0 : 1) };
			changed();
			if (!running) hostFor(id).handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: c.goal.text + GOAL_NOTE });
		},
		updateGoal(id: string, text: string): void {
			const c = list.get(id), goal = text.trim();
			if (!c?.goal || !goal) return;
			c.goal = { ...c.goal, text: goal, revised: true, idle: 0, reason: "", status: ["active", "verifying"].includes(c.goal.status) ? "active" : "paused" };
			changed();
		},
		/** Delete only the goal, leaving the current run and chat intact. */
		deleteGoal(id: string): void {
			const c = list.get(id);
			if (!c?.goal) return;
			delete c.goal;
			changed();
		},
		/** Ends the goal; a round still going is stopped. */
		stopGoal(id: string): void {
			const conversation = list.get(id);
			if (!conversation?.goal) return;
			if (conversation.goal.status === "active" || conversation.goal.status === "verifying") conversation.goal = { ...conversation.goal, status: "stopped" };
			changed();
			hosts.get(id)?.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.cancel" });
		},
		/** Another working folder, for a conversation that has not started. */
		setWorkspace(id: string, workspace: string): void {
			const conversation = list.get(id);
			if (!conversation || hosts.has(id) || existsSync(eventsPath(id))) throw new Error("对话开始后不能换文件夹");
			conversation.workspace = workspace;
			changed();
		},
		workspace(id: string): string | null {
			const conversation = list.get(id);
			return conversation ? workspaceOf(conversation) : null;
		},
		/**
		 * Goes back to just before a message that started a run: the transcript from it on is set aside (kept in
		 * branches/), the context returns to how it was then, and with `files` the files those runs changed are put back.
		 * The caller then sends the message again, as it was or edited.
		 */
		async rewind(id: string, run: string, { files }: { files: boolean }): Promise<{ events: EngineEvent[]; conflicts: string[] }> {
			const conversation = list.get(id);
			if (!conversation) throw new Error("没有这个对话");
			if (conversation.status !== "idle") throw new Error("这个对话正在运行，先停下再改");
			const raw = lines(eventsPath(id));
			const parsed = raw.map((line) => { try { return JSON.parse(line) as EngineEvent; } catch { return null; } });
			const at = parsed.findIndex((event) => !event?.agent && event?.type === "run.started" && event.eventId === run);
			if (at < 0) throw new Error("找不到这条消息");
			let point: unknown;
			try { point = JSON.parse(readFileSync(pointPath(id, run), "utf8")); }
			catch { throw new Error("这条消息之前的上下文没有保存，不能从这里重来"); }
			const later = runs(id), from = later.findIndex((entry) => entry.run === run || parsed.slice(at).some((event) => !event?.agent && event?.type === "run.started" && event.eventId === entry.run));
			const undone = from < 0 ? [] : later.slice(from);
			const conflicts = files && undone.length ? restoreFiles(workspaceOf(conversation), undone).conflicts : [];
			await hosts.get(id)?.reload();
			const dir = join(options.dataDir, id);
			mkdirSync(join(dir, "branches"), { recursive: true, mode: 0o700 });
			writeFileSync(join(dir, "branches", `${Date.now()}.jsonl`), raw.slice(at).map((line) => `${line}\n`).join(""), { mode: 0o600 });
			writeFileSync(eventsPath(id), raw.slice(0, at).map((line) => `${line}\n`).join(""), { mode: 0o600 });
			if (point === null) rmSync(sessionPath(id), { force: true });
			else writeFileSync(sessionPath(id), `${JSON.stringify(point)}\n`, { mode: 0o600 });
			if (from >= 0) writeFileSync(runsPath(id), later.slice(0, from).map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
			if (conversation.goal && (conversation.goal.status === "active" || conversation.goal.status === "verifying")) conversation.goal = { ...conversation.goal, status: "stopped", reason: "已从前面的消息重来" };
			current.delete(id);
			conversation.updatedAt = Date.now();
			changed();
			return { events: parsed.slice(0, at).filter((event): event is EngineEvent => event !== null), conflicts };
		},
		/** The files this conversation's runs changed and still differ, and the points they can be put back to. */
		changes(id: string): { files: ChangedFile[]; points: { run: string; task: string; at: number }[]; canRedo: boolean } {
			const conversation = list.get(id);
			if (!conversation) return { files: [], points: [], canRedo: false };
			const all = runs(id);
			let files: ChangedFile[] = [];
			try { files = changedFiles(workspaceOf(conversation), all); }
			catch (error) { console.error(`mountains: changes not read: ${error instanceof Error ? error.message : String(error)}`); }
			return { files, points: all.map(({ run, task, at }) => ({ run, task, at })), canRedo: existsSync(redoPath(id)) };
		},
		diff(id: string, path: string): string {
			const conversation = list.get(id);
			return conversation ? fileDiff(workspaceOf(conversation), runs(id), path) : "";
		},
		/** Puts files back as they were before a run (or before all of them); the conversation itself stays. */
		restore(id: string, run: string | null): { restored: string[]; conflicts: string[] } {
			const conversation = list.get(id);
			if (!conversation) throw new Error("没有这个对话");
			if (conversation.status !== "idle") throw new Error("这个对话正在运行，先停下再撤回");
			const all = runs(id), from = run === null ? 0 : all.findIndex((entry) => entry.run === run);
			if (from < 0) return { restored: [], conflicts: [] };
			const undone = all.slice(from), workspace = workspaceOf(conversation);
			const kept = keepFiles(workspace, undone);
			const result = restoreFiles(workspace, undone);
			if (kept && result.restored.length) writeFileSync(redoPath(id), JSON.stringify({ ...kept, after: hashesAfter(workspace, kept.changed) }), { mode: 0o600 });
			return result;
		},
		/** Compacts the context now, for /compact. */
		compact(id: string): Promise<{ before: number; after: number } | null> {
			const conversation = list.get(id);
			if (!conversation || !existsSync(sessionPath(id))) return Promise.reject(new Error("这个对话还没有可压缩的内容"));
			if (conversation.status !== "idle") return Promise.reject(new Error("这个对话正在运行，先停下再压缩"));
			return hostFor(id).compact();
		},
		/** Takes back the last restore: the files return to how they were just before it. */
		redo(id: string): { restored: string[]; conflicts: string[] } {
			const conversation = list.get(id);
			if (!conversation || !existsSync(redoPath(id))) return { restored: [], conflicts: [] };
			if (conversation.status !== "idle") throw new Error("这个对话正在运行，先停下再恢复");
			const kept = JSON.parse(readFileSync(redoPath(id), "utf8")) as RunChanges;
			const result = restoreFiles(workspaceOf(conversation), [kept]);
			rmSync(redoPath(id), { force: true });
			return result;
		},
		/** The workspace file a conversation changed, for 在访达中显示; null for a path outside it. */
		filePath(id: string, path: string): string | null {
			const conversation = list.get(id);
			if (!conversation || !runs(id).some((run) => run.changed.some((change) => change.path === path))) return null;
			return join(workspaceOf(conversation), path);
		},
		/** The conversation as Markdown: every message, reply and tool call, in order. */
		markdown(id: string): string {
			const conversation = list.get(id);
			if (!conversation) return "";
			const out: string[] = [`# ${conversation.title || "新对话"}`, ""];
			for (const event of this.history(id)) {
				if (event.agent && event.type === "run.started") continue;
				const who = event.agent ? `Mountains (${event.agent})` : "Mountains";
				if (!event.agent && (event.type === "run.started" || event.type === "run.interjected")) out.push("## 你", "", event.type === "run.started" ? event.task : event.text, "");
				else if (event.type === "message.completed" && event.text) out.push(`## ${who}`, "", event.text, "");
				else if (event.type === "tool.requested") { const args = typeof event.args === "string" ? event.args : JSON.stringify(event.args); out.push(`> ${event.agent ? `[${event.agent}] ` : ""}${event.tool} ${args.length > 300 ? `${args.slice(0, 300)}…` : args}`, ""); }
				else if (event.type === "error") out.push(`> 出错：${event.message}`, "");
			}
			return out.join("\n");
		},
		host(id: string): EngineHost | undefined {
			return list.has(id) ? hostFor(id) : undefined;
		},
		update(id: string, change: Partial<Pick<Conversation, "title" | "pinned" | "archived">> & { group?: string | null }): void {
			const conversation = list.get(id);
			if (!conversation) return;
			if (typeof change.title === "string") { conversation.title = change.title.replace(/\s+/g, " ").trim().slice(0, 60) || conversation.title; conversation.named = "user"; }
			if (typeof change.pinned === "boolean") conversation.pinned = change.pinned;
			if (typeof change.archived === "boolean") conversation.archived = change.archived;
			if (change.group === null) delete conversation.group;
			else if (typeof change.group === "string" && change.group.trim()) conversation.group = change.group.replace(/\s+/g, " ").trim().slice(0, 24);
			changed();
		},
		/** A summarized title, unless the user has named the conversation since it was asked for. */
		nameAuto(id: string, title: string): void {
			const conversation = list.get(id);
			const clean = title.replace(/\s+/g, " ").trim().slice(0, 60);
			if (!conversation || conversation.named || !clean) return;
			conversation.title = clean;
			conversation.named = "auto";
			changed();
		},
		async remove(id: string): Promise<void> {
			if (!ID.test(id) || !list.has(id)) return;
			await hosts.get(id)?.dispose();
			hosts.delete(id);
			list.delete(id);
			rmSync(join(options.dataDir, id), { recursive: true, force: true });
			changed();
		},
		/** What a tool call returned, as the model saw it, from the run records of this conversation. */
		toolOutput(id: string, toolCallId: string): string | null {
			if (!list.has(id) || !toolCallId || toolCallId.length > 200) return null;
			const dir = join(options.dataDir, id);
			const runs = existsSync(dir) ? readdirSync(dir).filter((name) => /^run(-\d+)?$/.test(name)) : [];
			const needle = JSON.stringify(toolCallId);
			for (const run of runs) {
				const agentsDir = join(dir, run, "agents");
				const files = [
					join(dir, run, "recording.jsonl"),
					...(existsSync(agentsDir) ? readdirSync(agentsDir).map((agent) => join(agentsDir, agent, "recording.jsonl")) : []),
				];
				for (const file of files) {
					if (!existsSync(file)) continue;
					for (const line of readFileSync(file, "utf8").split("\n")) {
						if (!line.includes('"tool.output"') || !line.includes(needle)) continue;
						try {
							const record = JSON.parse(line) as { kind?: string; data?: { toolCallId?: string; modelContent?: unknown } };
							if (record.kind === "tool.output" && record.data?.toolCallId === toolCallId && typeof record.data.modelContent === "string") return record.data.modelContent.slice(0, 64 * 1024);
						} catch { /* a torn last line */ }
					}
				}
			}
			return null;
		},
		/** Conversations whose title, requests or replies contain the query; the first hit gives the snippet. */
		search(query: string): SearchHit[] {
			const needle = query.trim().toLowerCase();
			if (!needle) return [];
			const hits: SearchHit[] = [];
			for (const conversation of [...list.values()].sort((x, y) => y.updatedAt - x.updatedAt)) {
				let hit: SearchHit | undefined;
				for (const event of this.history(conversation.id)) {
					const text = !event.agent && event.type === "run.started" ? event.task : event.type === "message.completed" ? event.text : "";
					const at = text.toLowerCase().indexOf(needle);
					if (at < 0) continue;
					const flat = (part: string) => part.replace(/\s+/g, " ");
					hit = {
						id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, byUser: !event.agent && event.type === "run.started",
						before: (at > 18 ? "…" : "") + flat(text.slice(Math.max(0, at - 18), at)),
						match: text.slice(at, at + needle.length),
						after: flat(text.slice(at + needle.length, at + needle.length + 28)) + (at + needle.length + 28 < text.length ? "…" : ""),
					};
					break;
				}
				if (!hit && conversation.title.toLowerCase().includes(needle)) hit = { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, byUser: false, before: "", match: "", after: "" };
				if (hit) hits.push(hit);
			}
			return hits;
		},
		/** Hosts already made; a conversation gets one on its first command. */
		liveHosts(): EngineHost[] {
			return [...hosts.values()];
		},
		running(): Conversation[] {
			return [...list.values()].filter((c) => c.status !== "idle");
		},
		async dispose(): Promise<void> {
			await Promise.all([...hosts.values()].map((host) => host.dispose()));
		},
	};
}

export type Desk = ReturnType<typeof createDesk>;
