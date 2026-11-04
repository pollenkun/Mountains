/** Turns engine events into what the conversation shows. No DOM here, so tests can drive it directly. */
import type { EngineEvent } from "@mountains/protocol";

export type ToolKind = "command" | "read" | "edit" | "web" | "screen" | "note" | "image" | "recall" | "skill" | "look" | "search" | "agent" | "message" | "team";

export interface FileDiff {
	path: string;
	oldText: string;
	newText: string;
}

export interface ToolNote {
	next?: string;
	requirements?: string[];
	facts?: string[];
}

export interface ToolCall {
	id: string;
	tool: string;
	kind: ToolKind;
	/** What the call acted on: a command line, a path, an app, a skill name. */
	target: string;
	/** Original model arguments, including invalid or missing command fields. */
	input?: Record<string, unknown>;
	status: "running" | "done" | "failed";
	startedAt: number;
	durationMs?: number;
	added?: number;
	removed?: number;
	diffs?: FileDiff[];
	exitCode?: number | null;
	failure?: string;
	/** Auto-approval lifecycle on this tool call: reviewing, fetching extra context, or rejected by approval. */
	approvalState?: "reviewing" | "fetching_context" | "denied";
	/** What an agent was told, or what was sent to it. */
	message?: string;
	/** What an agent is for. */
	purpose?: string;
	/** The risk 自动审批 gave this call. */
	level?: RiskLevel;
	/** Structured progress summary recorded by `task_note`. */
	note?: ToolNote;
	/** How old the earliest conversation a recall actually read is, in days. */
	recallDays?: number;
	/** Titles of the conversations a recall read, oldest not required. */
	recallReads?: { days: number; asked: string }[];
}

export type Item =
	/** `start`: the message began a run (one sent mid-run joins the run that was going). */
	| { type: "user"; id: string; text: string; at: number; start?: boolean }
	| { type: "assistant"; id: string; text: string; at: number }
	| { type: "error"; id: string; text: string; reconnecting?: boolean; attempt?: number }
	| { type: "thinking"; id: string; text: string; startedAt: number; endedAt?: number }
	| { type: "tool"; id: string; call: ToolCall }
	/** The context changed: a summary is being made or was made, or tool results were folded without loss. */
	| { type: "revision"; id: string; state: "compacting" | "compacted" | "folded"; count: number };

export type RiskLevel = "low" | "medium" | "high";
export const RISK_LABEL: Record<RiskLevel, string> = { low: "低风险", medium: "中风险", high: "高风险" };

export interface Approval {
	toolCallId: string;
	command: string;
	explanation: string;
	risk: string;
	level?: RiskLevel;
	/** The team member asking; the lead's own requests have none. */
	agent?: string;
}

export interface Transcript {
	items: Item[];
	approvals: Approval[];
	running: boolean;
	title: string;
	/** The assistant item that streamed text joins; a tool call closes it. */
	open: string | null;
	/** The thinking item reasoning joins; any other output ends it. */
	thinking: string | null;
	/** This conversation's requests, summed from usage events. */
	spend: Spend;
	/** Prompt size of the latest request, for the context gauge. */
	context: number | null;
	/** What the latest request's fixed parts come to, estimated, for the gauge's details. */
	contextParts: { system: number; tools: number } | null;
	/** The model this conversation's requests actually went to: a started conversation keeps its model. */
	model: string | null;
	/** File tool calls the model is still writing, by their place in the reply: the arguments so far. */
	writing: { tool: string; raw: string }[];
	/** UltraCode: each team member's own transcript, by name, and what the lead said it is for. */
	agents: Record<string, Transcript>;
	purposes: Record<string, string>;
}

export interface Spend {
	cost: number;
	currency: string;
	input: number;
	cacheRead: number;
	output: number;
	requests: number;
}

export const EMPTY: Transcript = { items: [], approvals: [], running: false, title: "", open: null, thinking: null, spend: { cost: 0, currency: "", input: 0, cacheRead: 0, output: 0, requests: 0 }, context: null, contextParts: null, model: null, writing: [], agents: {}, purposes: {} };

const KINDS: Record<string, ToolKind> = {
	command_run: "command",
	file_read: "read",
	file_outline: "read",
	context_expand: "read",
	file_edit: "edit",
	file_write: "edit",
	web_read: "web",
	web_search: "web",
	web_fetch: "web",
	web_search_setup: "web",
	web_act: "web",
	screen_read: "screen",
	screen_act: "screen",
	screen_look: "image",
	web_look: "image",
	session_search: "recall",
	memory_search: "recall",
	skill: "skill",
	task_note: "note",
	set_appearance: "look",
	spawn_agent: "agent",
	send_message: "message",
	wait_agent: "team",
	read_messages: "team",
	list_agents: "team",
	interrupt_agent: "team",
};

const DEPRECATED_PARTIAL_USAGE_RE = /请求用量不完整，已保守计费并停止后续操作/;

/** Talk between agents stands on its own line, however the rest is folded. */
export const OWN_LINE: ReadonlySet<ToolKind> = new Set(["agent", "message"]);
/** These never merge with other calls, folded or not. */
export const ALONE: ReadonlySet<ToolKind> = new Set(["image", "recall", "skill"]);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function lines(value: string): number {
	return value ? value.split("\n").length : 0;
}

function targetOf(kind: ToolKind, args: Record<string, unknown>): string {
	if (kind === "command") {
		const argv = Array.isArray(args.argv) ? args.argv.filter((part): part is string => typeof part === "string") : [];
		return argv.length ? argv.join(" ") : text(args.shellScript) || text(args.command);
	}
	if (kind === "agent") return text(args.name);
	if (kind === "message") return text(args.to);
	if (kind === "team") return text(args.to);
	if (kind === "read" || kind === "edit") return text(args.path);
	if (kind === "web") return text(args.url) || text(args.name) || (Array.isArray(args.queries) ? args.queries.map(text).filter(Boolean).join("、") : "");
	if (kind === "screen" || kind === "image") return text(args.app);
	if (kind === "recall") return text(args.query);
	if (kind === "skill") return text(args.name);
	return "";
}

function classifyCall(tool: string, args: Record<string, unknown>): { kind: ToolKind; target: string; note?: ToolNote } {
	if (tool === "query_plan") {
		const steps = Array.isArray(args.steps) ? args.steps.map(record) : [];
		const paths: string[] = [];
		const queries: string[] = [];
		const globs: string[] = [];
		for (const step of steps) {
			const op = text(step.op);
			if (op === "read") {
				const reads = Array.isArray(step.reads) ? step.reads.map(record) : [];
				for (const r of reads) { const p = text(r.path); if (p && !paths.includes(p)) paths.push(p); }
				const single = text(step.path);
				if (single && !paths.includes(single)) paths.push(single);
			} else if (op === "outline" || op === "json_field") {
				const p = text(step.path);
				if (p && !paths.includes(p)) paths.push(p);
			} else if (op === "search") {
				const q = text(step.query) || text(step.pattern);
				if (q && !queries.includes(q)) queries.push(q);
			} else if (op === "glob") {
				const scope = text(step.path);
				const patterns = Array.isArray(step.patterns) ? step.patterns.filter((x): x is string => typeof x === "string") : [];
				const label = scope ? (patterns.length ? `${scope} (${patterns.join(", ")})` : scope) : patterns.join(", ");
				if (label && !globs.includes(label)) globs.push(label);
			}
		}
		if (paths.length) return { kind: "read", target: paths.length > 1 ? `${paths[0]} 等 ${paths.length} 个文件` : paths[0]! };
		if (queries.length) return { kind: "search", target: queries.length > 1 ? `「${queries[0]}」等 ${queries.length} 项` : `「${queries[0]}」` };
		if (globs.length) return { kind: "search", target: globs[0]! };
		return { kind: "read", target: "" };
	}
	if (tool === "task_note") {
		const rawNext = Array.isArray(args.next) ? args.next.filter((x): x is string => typeof x === "string" && x.trim().length > 0).join("；") : text(args.next);
		const next = (rawNext || text(args.status)).trim();
		const requirements = Array.isArray(args.requirements) ? args.requirements.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
		const facts = Array.isArray(args.facts) ? args.facts.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
		const hasNote = Boolean(next || requirements.length || facts.length);
		return {
			kind: "note",
			target: next,
			...(hasNote ? { note: { ...(next ? { next } : {}), ...(requirements.length ? { requirements } : {}), ...(facts.length ? { facts } : {}) } } : {}),
		};
	}
	const kind = KINDS[tool] ?? "note";
	return { kind, target: targetOf(kind, args) };
}

function diffsOf(tool: string, details: Record<string, unknown>): FileDiff[] {
	const path = text(details.path);
	if (tool === "file_write") return [{ path, oldText: "", newText: text(details.content) }];
	if (tool !== "file_edit") return [];
	const edits = Array.isArray(details.edits) ? details.edits.map(record) : [details];
	return edits.map((edit) => ({ path, oldText: text(edit.oldText), newText: text(edit.newText) }));
}

/** Line breaks in each string field `key` of partly written JSON, counting the one line a field starts with. */
function linesIn(raw: string, key: string): number {
	let total = 0;
	for (const field of raw.matchAll(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "g"))) {
		if (field[1]) total += 1 + (field[1].match(/\\n/g)?.length ?? 0);
	}
	return total;
}

export interface LiveEdit { path: string; added: number; removed: number }

/** What the running reply has changed so far: finished file calls (lead and team), then those still being written. */
export function liveEdits(state: Transcript): LiveEdit[] {
	if (!state.running) return [];
	const out: LiveEdit[] = [];
	let since = 0;
	for (let i = state.items.length - 1; i >= 0; i--) {
		const item = state.items[i]!;
		if (item.type === "user" && item.start) { since = item.at; break; }
		if (item.type === "tool" && item.call.diffs?.length) out.unshift({ path: item.call.diffs[0]!.path, added: item.call.added ?? 0, removed: item.call.removed ?? 0 });
	}
	for (const agent of Object.values(state.agents)) {
		let inRun = since === 0;
		for (const item of agent.items) {
			if (item.type === "user" && item.at >= since) inRun = true;
			if (inRun && item.type === "tool" && item.call.diffs?.length) out.push({ path: item.call.diffs[0]!.path, added: item.call.added ?? 0, removed: item.call.removed ?? 0 });
		}
	}
	for (const { tool, raw } of state.writing) {
		if (!raw) continue;
		const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? "";
		out.push(tool === "file_write" ? { path, added: linesIn(raw, "content"), removed: 0 } : { path, added: linesIn(raw, "newText"), removed: linesIn(raw, "oldText") });
	}
	return out;
}

function update(state: Transcript, id: string, change: (call: ToolCall) => ToolCall): Transcript {
	return {
		...state,
		items: state.items.map((item) => item.type === "tool" && item.call.id === id ? { ...item, call: change(item.call) } : item),
	};
}

/** A summary that never arrived leaves no line saying it is still being made. */
const withoutPending = (items: Item[]) => items.filter((item) => item.type !== "revision" || item.state !== "compacting");
/** A retry that then succeeds should not leave "正在尝试重新连接" in the transcript. */
const settled = (items: Item[]) => items.filter((item) => item.type !== "error" || !item.reconnecting);

/** Ends the open thinking item at `now`; every kind of output except more reasoning does this. */
function settle(state: Transcript, now: number): Transcript {
	if (!state.thinking) return state;
	const id = state.thinking;
	return { ...state, thinking: null, items: state.items.map((item) => item.type === "thinking" && item.id === id ? { ...item, endedAt: now } : item) };
}

/** Strips `<agent_message>` wrappers when comparing an interjected agent message against a started run. */
function plainAgentMessage(value: string): string {
	const found = [...value.matchAll(/<agent_message[^>]*>\n?([\s\S]*?)\n?<\/agent_message>/g)];
	return found.length ? found.map((m) => m[1]!).join("\n\n") : value;
}

function deliverToAgent(agents: Record<string, Transcript>, to: string, message: string, id: string, now: number): Record<string, Transcript> {
	const target = agents[to];
	if (!to || to === "lead" || !target?.running || !message) return agents;
	const last = target.items[target.items.length - 1];
	if (last?.type === "user" && plainAgentMessage(last.text) === message) return agents;
	return { ...agents, [to]: { ...target, items: [...target.items, { type: "user", id, text: message, at: now }] } };
}

export function reduce(state: Transcript, event: EngineEvent, now = Date.now()): Transcript {
	if (event.agent) {
		const { agent: name, ...own } = event;
		let purposes = state.purposes;
		if (event.type === "tool.requested" && event.tool === "spawn_agent") {
			const args = record(event.args), child = text(args.name);
			if (child) purposes = { ...purposes, [child]: text(args.purpose) };
		}
		const prev = state.agents[name] ?? EMPTY;
		const nextAgent = reduce(prev, own as EngineEvent, now);
		let agents: Record<string, Transcript> = { ...state.agents, [name]: nextAgent };
		if (event.type === "tool.completed" && event.tool === "send_message" && event.ok) {
			const sent = prev.items.find((item): item is Extract<Item, { type: "tool" }> => item.type === "tool" && item.call.id === event.toolCallId)?.call;
			if (sent?.target && sent.message) agents = deliverToAgent(agents, sent.target, sent.message, `${event.eventId}:msg`, now);
		}
		// An agent's request for approval comes to the user like the lead's, saying whose it is.
		if (event.type === "approval.requested" && event.source !== "model" && !state.approvals.some((a) => a.toolCallId === event.toolCallId)) {
			return { ...state, purposes, agents, approvals: [...state.approvals, { toolCallId: event.toolCallId, command: event.command, explanation: event.explanation, risk: event.risk, agent: name, ...(event.level ? { level: event.level } : {}) }] };
		}
		if (event.type === "approval.resolved") return { ...state, purposes, agents, approvals: state.approvals.filter((a) => a.toolCallId !== event.toolCallId) };
		return { ...state, purposes, agents };
	}
	if (event.type === "message.delta" && event.kind === "thinking") {
		if (state.thinking) {
			const id = state.thinking;
			return { ...state, items: state.items.map((item) => item.type === "thinking" && item.id === id ? { ...item, text: item.text + event.text } : item) };
		}
		return { ...state, open: null, thinking: event.eventId, items: [...state.items, { type: "thinking", id: event.eventId, text: event.text, startedAt: now }] };
	}
	if (event.type === "tool.writing") {
		const writing = [...state.writing];
		writing[event.index] = { tool: event.tool, raw: (writing[event.index]?.raw ?? "") + event.text };
		return { ...state, writing };
	}
	if (event.type !== "approval.requested" && event.type !== "approval.resolved" && event.type !== "usage" && event.type !== "model.request") state = settle(state, now);
	switch (event.type) {
		case "model.request":
			if (event.purpose === "agent-turn") {
				const sum = (kind: string) => event.segments.reduce((n, s) => s.kind === kind ? n + s.tokensEst : n, 0);
				return { ...state, contextParts: { system: sum("system"), tools: sum("tools") } };
			}
			if (event.purpose !== "compaction") return state;
			return { ...state, open: null, items: [...state.items, { type: "revision", id: event.eventId, state: "compacting", count: 0 }] };
		case "context.revision": {
			const items = withoutPending(state.items);
			if (event.reason === "compaction") return { ...state, open: null, context: event.tokensAfter || state.context, items: [...items, { type: "revision", id: event.eventId, state: "compacted", count: 0 }] };
			const count = event.maskedRefs.length, last = items[items.length - 1];
			if (!count) return state;
			// Folds in a row read as one line.
			if (last?.type === "revision" && last.state === "folded") return { ...state, items: [...items.slice(0, -1), { ...last, count: last.count + count }] };
			return { ...state, open: null, items: [...items, { type: "revision", id: event.eventId, state: "folded", count }] };
		}
		case "usage": {
			const u = event.usage;
			const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			return {
				...state,
				context: prompt || state.context,
				model: event.model ?? state.model,
				spend: {
					cost: state.spend.cost + (event.cost ?? 0),
					currency: event.currency,
					input: state.spend.input + (u.input ?? 0) + (u.cacheWrite ?? 0),
					cacheRead: state.spend.cacheRead + (u.cacheRead ?? 0),
					output: state.spend.output + (u.output ?? 0),
					requests: state.spend.requests + 1,
				},
			};
		}
		case "run.started":
			return {
				...state,
				running: true,
				title: state.title || event.task.replace(/\s+/g, " ").trim(),
				open: null,
				items: [...state.items, { type: "user", id: event.eventId, text: event.task, at: now, start: true }],
			};
		// A message sent while the run goes on, shown where it was sent. A reply already streaming finishes in place:
		// the model reads the message with its next request.
		case "run.interjected":
			return { ...state, items: [...state.items, { type: "user", id: event.eventId, text: event.text, at: now }] };
		case "message.delta": {
			const items = settled(state.items);
			if (state.open) {
				const open = state.open;
				return { ...state, items: items.map((item) => item.type === "assistant" && item.id === open ? { ...item, text: item.text + event.text } : item) };
			}
			return { ...state, open: event.eventId, items: [...items, { type: "assistant", id: event.eventId, text: event.text, at: now }] };
		}
		case "message.completed": {
			if (!event.text) return { ...state, open: null };
			if (state.open) {
				const open = state.open;
				return { ...state, open: null, items: state.items.map((item) => item.type === "assistant" && item.id === open ? { ...item, text: event.text } : item) };
			}
			return { ...state, items: [...state.items, { type: "assistant", id: event.eventId, text: event.text, at: now }] };
		}
		case "tool.requested": {
			if (state.items.some((item) => item.type === "tool" && item.call.id === event.toolCallId)) return state;
			const args = record(event.args), classified = classifyCall(event.tool, args);
			const named = classified.kind === "agent" ? text(args.name) : "";
			if (named) state = { ...state, purposes: { ...state.purposes, [named]: text(args.purpose) } };
			const call: ToolCall = {
				...(classified.kind === "message" ? { message: text(args.message) } : classified.kind === "agent" ? { message: text(args.task), purpose: text(args.purpose) } : {}),
				id: event.toolCallId,
				tool: event.tool,
				kind: classified.kind,
				target: classified.target,
				input: args,
				status: "running",
				startedAt: now,
				...(classified.note ? { note: classified.note } : {}),
			};
			return { ...state, open: null, items: [...settled(state.items), { type: "tool", id: event.toolCallId, call }] };
		}
		case "tool.completed": {
			const details = record(event.details);
			const diffs = diffsOf(event.tool, details);
			const sent = event.tool === "send_message" && event.ok
				? state.items.find((item): item is Extract<Item, { type: "tool" }> => item.type === "tool" && item.call.id === event.toolCallId)?.call
				: undefined;
			const agents = sent?.target && sent.message ? deliverToAgent(state.agents, sent.target, sent.message, `${event.eventId}:msg`, now) : state.agents;
			// Calls finish in the order they were written; this one's numbers now come from its result.
			const done = event.tool === "file_write" || event.tool === "file_edit" ? state.writing.findIndex((w) => w) : -1;
			const base = done < 0 ? { ...state, agents } : { ...state, agents, writing: state.writing.filter((_, i) => i !== done) };
			return update(base, event.toolCallId, (call) => {
				const denied = !event.ok && (details.approved === false || call.approvalState === "denied");
				const { approvalState: _prevApproval, ...rest } = call;
				return {
					...rest,
					status: event.ok ? "done" : "failed",
					durationMs: event.durationMs,
					...(denied ? { approvalState: "denied" as const } : {}),
					...(diffs.length ? {
						diffs,
						added: diffs.reduce((n, d) => n + lines(d.newText), 0),
						removed: diffs.reduce((n, d) => n + lines(d.oldText), 0),
					} : {}),
					...(event.tool === "memory_search" ? recallFacts(details) : {}),
					...(typeof details.exitCode === "number" || details.exitCode === null ? { exitCode: details.exitCode as number | null } : {}),
					...(event.ok ? {} : { failure: text(details.reason) || text(details.error) || event.summary }),
				};
			});
		}
		case "approval.requested":
			if (event.source === "model") {
				const nextState = event.explanation.includes("获取更多上下文") ? "fetching_context" as const : "reviewing" as const;
				return update(state, event.toolCallId, (call) => ({ ...call, approvalState: nextState }));
			}
			if (state.approvals.some((a) => a.toolCallId === event.toolCallId)) return state;
			return {
				...update(state, event.toolCallId, ({ approvalState: _cleared, ...call }) => call),
				approvals: [...state.approvals, { toolCallId: event.toolCallId, command: event.command, explanation: event.explanation, risk: event.risk, ...(event.level ? { level: event.level } : {}) }],
			};
		case "approval.resolved":
			return {
				...update(state, event.toolCallId, (call) => {
					const level = event.level ? { level: event.level } : {};
					if (event.decision === "deny") return { ...call, ...level, approvalState: "denied" };
					const { approvalState: _cleared, ...rest } = call;
					return { ...rest, ...level };
				}),
				approvals: state.approvals.filter((a) => a.toolCallId !== event.toolCallId),
			};
		case "error": {
			if (DEPRECATED_PARTIAL_USAGE_RE.test(event.message)) return state;
			const items = withoutPending(settled(state.items));
			if (!event.retryable) return { ...state, open: null, items: [...items, { type: "error", id: event.eventId, text: event.message }] };
			const previous = state.items.find((item) => item.type === "error" && item.reconnecting);
			const attempt = Math.min(10, (previous?.type === "error" ? previous.attempt ?? 0 : 0) + 1);
			return { ...state, open: null, items: [...items, { type: "error", id: "reconnecting", text: event.message, reconnecting: true, attempt }] };
		}
		case "run.completed": {
			const items = withoutPending(settled(state.items)).map((item) => item.type === "tool" && item.call.status === "running" ? { ...item, call: { ...item.call, status: "failed" as const } } : item);
			const showFailure = (event.status === "failed" || event.status === "limit") && !DEPRECATED_PARTIAL_USAGE_RE.test(event.reason);
			const shown = showFailure ? [...items, { type: "error" as const, id: event.eventId, text: event.reason }] : items;
			return { ...state, running: false, open: null, approvals: [], items: shown, writing: [] };
		}
		default:
			return state;
	}
}

export function answered(state: Transcript, toolCallId: string): Transcript {
	return { ...state, approvals: state.approvals.filter((a) => a.toolCallId !== toolCallId) };
}

export type Block =
	| { type: "item"; item: Exclude<Item, { type: "tool" }> }
	| { type: "tools"; id: string; calls: ToolCall[] };

/**
 * Consecutive calls between two messages form blocks. Folded, the ordinary ones share one block;
 * loose, each gets its own. Pictures, recall and skills stay apart either way, one block per run of the same kind.
 */
export function blocks(items: readonly Item[], folded: boolean): Block[] {
	const out: Block[] = [];
	for (const item of items) {
		if (item.type !== "tool") {
			out.push({ type: "item", item });
			continue;
		}
		const call = item.call;
		const last = out[out.length - 1];
		if (last?.type === "tools") {
			const head = last.calls[0]!;
			const alone = ALONE.has(call.kind);
			// Recall stays on its own line when folding is off. Pictures and skills still share a line.
			const joins = alone ? head.kind === call.kind && (folded || call.kind !== "recall") : folded && !ALONE.has(head.kind);
			if (joins && !OWN_LINE.has(call.kind) && !OWN_LINE.has(head.kind)) {
				last.calls.push(call);
				continue;
			}
		}
		out.push({ type: "tools", id: call.id, calls: [call] });
	}
	return out;
}

/** The kind that shows the block's icon: the most frequent, earliest on a tie. */
export function leadingKind(calls: readonly ToolCall[]): ToolKind {
	const counts = new Map<ToolKind, number>();
	for (const call of calls) counts.set(call.kind, (counts.get(call.kind) ?? 0) + 1);
	let best = calls[0]!.kind;
	for (const [kind, count] of counts) if (count > (counts.get(best) ?? 0)) best = kind;
	return best;
}

type UiLang = "zh" | "en";

const DONE: Record<UiLang, Record<ToolKind, string>> = {
	zh: { command: "运行了命令", read: "读取了文件", search: "查找了内容", edit: "修改了文件", web: "读取了网页", screen: "操作了窗口", note: "整理了任务进度", image: "查看了图片", recall: "回忆了以前的对话", skill: "读取了技能", look: "改了外观", agent: "启动了 Agent", message: "发送了消息", team: "查看了 Agent" },
	en: { command: "Ran a command", read: "Read a file", search: "Searched", edit: "Edited a file", web: "Read a page", screen: "Used a window", note: "Updated the task note", image: "Viewed an image", recall: "Recalled an earlier chat", skill: "Read a skill", look: "Changed the appearance", agent: "Started an agent", message: "Sent a message", team: "Checked an agent" },
};

const RUNNING: Record<UiLang, Record<ToolKind, string>> = {
	zh: { command: "正在运行", read: "正在读取", search: "正在查找", edit: "正在修改", web: "正在读取网页", screen: "正在操作", note: "正在整理任务进度", image: "正在查看图片", recall: "正在回忆", skill: "正在读取", look: "正在改外观", agent: "正在启动 Agent", message: "正在发送消息", team: "正在等待 Agent" },
	en: { command: "Running", read: "Reading", search: "Searching", edit: "Editing", web: "Reading a page", screen: "Using a window", note: "Updating the task note", image: "Viewing an image", recall: "Recalling", skill: "Reading", look: "Changing the appearance", agent: "Starting an agent", message: "Sending a message", team: "Waiting for an agent" },
};

const VERB: Record<UiLang, Record<ToolKind, string>> = {
	zh: { command: "运行了", read: "读取了", search: "查找了", edit: "修改了", web: "读取了", screen: "操作了", note: "整理了任务进度", image: "查看了", recall: "回忆了", skill: "读取了", look: "改了外观", agent: "启动了", message: "发送了", team: "查看了" },
	en: { command: "Ran", read: "Read", search: "Searched", edit: "Edited", web: "Read", screen: "Used", note: "Updated the task note", image: "Viewed", recall: "Recalled", skill: "Read", look: "Changed the appearance", agent: "Started", message: "Sent", team: "Checked" },
};

const RUN_OBJECT: Record<UiLang, Partial<Record<ToolKind, string>>> = {
	zh: { command: "命令", read: "文件", edit: "文件", search: "内容" },
	en: { command: " a command", read: " a file", edit: " a file", search: "" },
};

function dayPhrase(days: number, lang: UiLang): string {
	if (lang === "en") return days <= 0 ? "today's chat" : days === 1 ? "yesterday's chat" : `a chat from ${days} days ago`;
	return days <= 0 ? "今天的对话" : days === 1 ? "昨天的对话" : `${days} 天前的对话`;
}

/** The row shows how old the earliest conversation read was, not the search words. */
function recallLabel(call: ToolCall, lang: UiLang): { verb: string; target: string } {
	const recalled = lang === "en" ? "Recalled" : "回忆了";
	if (call.status === "running") return { verb: RUNNING[lang].recall, target: "" };
	if (call.tool === "session_search") return { verb: lang === "en" ? "Recalled this chat" : "回忆了这次对话", target: "" };
	if (typeof call.recallDays === "number") return { verb: lang === "en" ? `${recalled} ${dayPhrase(call.recallDays, lang)}` : `${recalled} ${dayPhrase(call.recallDays, lang)}`, target: "" };
	return { verb: DONE[lang].recall, target: "" };
}

function recallBlock(calls: readonly ToolCall[], lang: UiLang): string {
	if (calls.every((call) => call.tool === "session_search")) return lang === "en" ? "Recalled this chat" : "回忆了这次对话";
	const days = calls.flatMap((call) => typeof call.recallDays === "number" ? [call.recallDays] : []);
	if (!days.length) return DONE[lang].recall;
	const phrase = dayPhrase(Math.max(...days), lang);
	return lang === "en" ? `Recalled ${phrase}` : `回忆了 ${phrase}`;
}

function recallFacts(details: Record<string, unknown>): { recallDays?: number; recallReads?: { days: number; asked: string }[] } {
	const days = typeof details.oldestDays === "number" && Number.isFinite(details.oldestDays) ? Math.max(0, Math.floor(details.oldestDays)) : undefined;
	const reads = Array.isArray(details.reads) ? details.reads.flatMap((row) => {
		const item = record(row);
		const age = typeof item.days === "number" && Number.isFinite(item.days) ? Math.max(0, Math.floor(item.days)) : null;
		const asked = text(item.asked);
		return age === null || !asked ? [] : [{ days: age, asked }];
	}) : [];
	return { ...(days !== undefined ? { recallDays: days } : {}), ...(reads.length ? { recallReads: reads } : {}) };
}

/** One call on its own row: verb plus what it acted on. Chinese when lang is omitted, so existing tests stay put. */
export function callLabel(call: ToolCall, lang: UiLang = "zh"): { verb: string; target: string } {
	if (call.kind === "message") return { verb: call.status === "running" ? (lang === "en" ? `Messaging ${call.target}` : `正在向 ${call.target} 发送消息`) : (lang === "en" ? `Messaged ${call.target}` : `已向 ${call.target} 发送消息`), target: "" };
	if (call.kind === "agent") return { verb: call.status === "running" ? (lang === "en" ? `Starting ${call.target}` : `正在启动 ${call.target}`) : (lang === "en" ? `Started ${call.target}` : `启动了 ${call.target}`), target: call.purpose ?? "" };
	if (call.tool === "interrupt_agent" && call.target) return { verb: call.status === "running" ? (lang === "en" ? `Stopping ${call.target}` : `正在停止 ${call.target}`) : (lang === "en" ? `Stopped ${call.target}` : `停止了 ${call.target}`), target: "" };
	if (call.tool === "web_search") return { verb: call.status === "running" ? (lang === "en" ? "Searching" : "正在搜索") : (lang === "en" ? "Searched" : "搜索了"), target: call.target };
	if (call.tool === "web_search_setup") return { verb: call.status === "running" ? (lang === "en" ? "Connecting" : "正在接入") : (lang === "en" ? "Connected" : "接入了"), target: call.target };
	if (call.kind === "recall") return recallLabel(call, lang);
	if (call.status === "running") return { verb: RUNNING[lang][call.kind], target: call.kind === "web" ? "" : call.target };
	if (call.kind === "image") return { verb: VERB[lang].image, target: lang === "en" ? "1 image" : "1 张图片" };
	if (call.kind === "note") return { verb: DONE[lang].note, target: call.target };
	if (!call.target) return { verb: DONE[lang][call.kind], target: "" };
	return { verb: VERB[lang][call.kind], target: call.target };
}

/** A folded block: the distinct actions in order, without targets. */
export function blockLabel(calls: readonly ToolCall[], lang: UiLang = "zh"): string {
	const head = calls[0]!;
	if (head.kind === "recall") return recallBlock(calls, lang);
	if (head.kind === "image") return lang === "en" ? `Viewed ${calls.length} ${calls.length === 1 ? "image" : "images"}` : `查看了 ${calls.length} 张图片`;
	if (head.kind === "skill") return calls.length === 1 && head.target ? (lang === "en" ? `Read ${head.target}` : `读取了 ${head.target}`) : (lang === "en" ? `Read ${calls.length} skills` : `读取了 ${calls.length} 个技能`);
	const running = calls.find((call) => call.status === "running");
	if (running) return RUNNING[lang][running.kind] + (RUN_OBJECT[lang][running.kind] ?? "");
	const seen: string[] = [];
	for (const call of calls) if (!seen.includes(DONE[lang][call.kind])) seen.push(DONE[lang][call.kind]);
	return seen.join(lang === "en" ? ", " : "，");
}

export function riskLabel(level: RiskLevel, lang: UiLang = "zh"): string {
	const labels = lang === "en" ? { low: "Low risk", medium: "Medium risk", high: "High risk" } : RISK_LABEL;
	return labels[level];
}
