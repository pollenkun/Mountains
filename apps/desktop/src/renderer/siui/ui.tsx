/**
 * SIUI components, drawn with the page's own elements and styles. A reply's sliders, inputs, toggles and
 * selects hold its state; `{expression}` in any component line is worked out from that state as it changes.
 * Buttons can set state, reset it, or put text in the composer for the user to send. Nothing runs code.
 */
import { createContext, createElement, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { evaluate, interpolate, show, type Value } from "./expr.ts";
import { PLAIN, setAction, type UiNode } from "./parse.ts";
import { defaults, problems, styleOf as safeStyle, withDerived } from "./state.ts";
import { Code, Expand } from "../icons.tsx";
import { Reveal } from "../Motion.tsx";

/** What a reply's components share: their state, how to change it, and how to hand text to the composer. */
interface Scope {
	vars: Record<string, Value>;
	set: (name: string, value: Value) => void;
	reset: () => void;
	draft: (text: string) => void;
}
const ScopeContext = createContext<Scope | null>(null);
/** The composer, for `-> send`: the app provides it. */
export const DraftContext = createContext<(text: string) => void>(() => {});
/** Asks the model to repair a reply's components. */
export const FixContext = createContext<(errors: string[]) => void>(() => {});
/** The local record of how components get used (shown, used, fullscreen, fixed). Nothing leaves the machine. */
export const UsageContext = createContext<(what: string) => void>(() => {});

/** The state shared by a reply's components; controls that appear while it streams start at their defaults. */
export function UiScope({ nodes, children }: { nodes: UiNode[]; children: ReactNode }) {
	const draft = useContext(DraftContext);
	const report = useContext(UsageContext);
	const used = useRef(false);
	const start = defaults(nodes);
	const [changed, setChanged] = useState<Record<string, Value>>({});
	const vars = withDerived(start, changed);
	const set = (name: string, value: Value) => {
		if (!used.current) { used.current = true; report("used"); }
		setChanged((c) => ({ ...c, [name]: value }));
	};
	return <ScopeContext.Provider value={{ vars, set, reset: () => setChanged({}), draft }}>{children}</ScopeContext.Provider>;
}

function useScope(): Scope {
	const scope = useContext(ScopeContext);
	if (!scope) throw new Error("SIUI component outside a reply");
	return scope;
}

const styleOf = (source: string | undefined, vars: Record<string, Value>) => safeStyle(source, vars) as CSSProperties | undefined;
const classes = (node: UiNode, base: string) => [base, ...node.styles.map((s) => `ui-${s}`)].join(" ");

/** A component's own text with its expressions worked out; a failed expression is marked and explained. */
function Text({ value }: { value: string }) {
	const { vars } = useScope();
	const { text, errors } = interpolate(value, vars);
	return <>{text}{errors.length ? <span className="ui-error" title={errors.join("\n")}> {errors.join("；")}</span> : null}</>;
}

function run(action: string, scope: Scope): void {
	const send = /^send\s+"([\s\S]*)"$/.exec(action);
	if (send) { scope.draft(interpolate(send[1]!, scope.vars).text); return; }
	if (action.startsWith("set ")) {
		// Several changes run in order, each seeing the one before.
		const vars = { ...scope.vars };
		for (const one of action.split("\n")) {
			const set = /^set\s+([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+)$/u.exec(one);
			if (!set) continue;
			try { vars[set[1]!] = evaluate(set[2]!, vars); scope.set(set[1]!, vars[set[1]!]!); } catch { /* the button shows nothing new */ }
		}
		return;
	}
	if (action === "reset") scope.reset();
}

function Chart({ node }: { node: UiNode }) {
	const type = node.attrs.type ?? "bar", title = node.attrs.title ?? "";
	const { vars } = useScope();
	const rows = node.data.map((line) => /^(.+?)\s*[:：]\s*(.+)$/.exec(line)).filter(Boolean).map((m) => {
		let value = Number.NaN;
		try { value = Number(evaluate(m![2]!.replace(/^\{|\}$/g, ""), vars)); } catch { /* shown as missing */ }
		return { label: m![1]!, value };
	});
	const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value) || 0));
	const W = 320, H = 140;
	return (
		<figure className={classes(node, "ui-chart")} style={styleOf(node.attrs.style, vars)}>
			{title ? <figcaption><Text value={title} /></figcaption> : null}
			{type === "line" ? (
				<svg viewBox={`0 0 ${W} ${H + 20}`} role="img" aria-label={title}>
					<polyline fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
						points={rows.map((r, i) => `${rows.length > 1 ? i * W / (rows.length - 1) : W / 2},${H - (Number.isFinite(r.value) ? r.value / max * (H - 10) : 0)}`).join(" ")} />
					{rows.map((r, i) => <text key={i} x={rows.length > 1 ? i * W / (rows.length - 1) : W / 2} y={H + 16} textAnchor="middle" className="ui-chart-label">{r.label}</text>)}
				</svg>
			) : type === "pie" ? (
				<div className="ui-pie">
					{rows.map((r, i) => <div key={i} className="ui-pie-row"><span className="ui-pie-dot" style={{ opacity: 1 - i * 0.15 }} />{r.label}<span className="ui-chart-value">{pctOf(r.value, rows)}</span></div>)}
				</div>
			) : (
				<div className="ui-bars">
					{rows.map((r, i) => (
						<div key={i} className="ui-bar-row">
							<span className="ui-chart-label">{r.label}</span>
							<span className="ui-bar"><span style={{ width: `${Number.isFinite(r.value) ? Math.max(2, Math.abs(r.value) / max * 100) : 0}%` }} /></span>
							<span className="ui-chart-value">{Number.isFinite(r.value) ? show(r.value) : "—"}</span>
						</div>
					))}
				</div>
			)}
		</figure>
	);
}
const pctOf = (v: number, rows: { value: number }[]) => { const sum = rows.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0); return sum ? `${Math.round(v / sum * 100)}%` : "—"; };

function Tabs({ node }: { node: UiNode }) {
	const tabs = node.children.filter((c) => c.name === "tab");
	const [current, setCurrent] = useState(0);
	const shown = tabs[Math.min(current, tabs.length - 1)];
	return (
		<div className={classes(node, "ui-tabs")}>
			<div className="ui-tab-row" role="tablist">{tabs.map((t, i) => <button key={i} type="button" role="tab" aria-selected={t === shown} className={t === shown ? "on" : undefined} onClick={() => setCurrent(i)}><Text value={t.attrs.name ?? ""} /></button>)}</div>
			{shown ? <div key={tabs.indexOf(shown)} className="ui-tab-body">{shown.children.map((c, i) => <UiView key={i} node={c} />)}</div> : null}
		</div>
	);
}

function Control({ node }: { node: UiNode }) {
	const scope = useScope();
	const name = node.attrs.name;
	if (!name) return <Unknown node={node} reason="缺少 name" />;
	const value = scope.vars[name];
	const style = styleOf(node.attrs.style, scope.vars);
	const label = <span className="ui-control-label"><Text value={node.attrs.label ?? node.text ?? name} /></span>;
	if (node.name === "slider") {
		const min = Number(node.attrs.min ?? 0), max = Number(node.attrs.max ?? 100);
		const step = Number(node.attrs.step ?? (max - min > 20 ? 1 : 0.1));
		return (
			<label className={classes(node, "ui-control ui-slider")} style={style}>
				{label}
				<input type="range" min={min} max={max} step={step} value={Number(value)} onChange={(e) => scope.set(name, Number(e.target.value))} />
				<span className="ui-control-value">{show(Number(value))}{node.attrs.unit ? ` ${node.attrs.unit}` : ""}</span>
			</label>
		);
	}
	if (node.name === "toggle") return <label className={classes(node, "ui-control")} style={style}>{label}<input type="checkbox" role="switch" className="switch" checked={value === true} onChange={(e) => scope.set(name, e.target.checked)} /></label>;
	if (node.name === "select") {
		const options = node.attrs.options?.split("|") ?? [];
		return <label className={classes(node, "ui-control")} style={style}>{label}<select className="select" value={String(value)} onChange={(e) => scope.set(name, e.target.value)}>{options.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>;
	}
	return <label className={classes(node, "ui-control")} style={style}>{label}<input className="ui-input" placeholder={node.attrs.placeholder} value={String(value)} onChange={(e) => scope.set(name, e.target.value)} /></label>;
}

function Unknown({ node, reason }: { node: UiNode; reason?: string }) {
	return <div className="ui-unknown">&lt;{node.name}&gt; {node.text}<span className="ui-error"> {reason ?? "不认识的部件"}</span></div>;
}

const SAFE_COLOR = /^[#\w(),.\s%-]+$/;

/**
 * A small picture that moves by itself: every `every` ms it runs `set`, while `run` holds and it has the keyboard.
 * Space or a click runs `press`, a <key> runs its own `set`, and <box>es are drawn from the variables.
 */
function Scene({ node }: { node: UiNode }) {
	const scope = useScope();
	const latest = useRef(scope);
	latest.current = scope;
	const [playing, setPlaying] = useState(false);
	const width = Number(node.attrs.w) || 320, height = Number(node.attrs.h) || 240;
	const every = Math.max(16, Number(node.attrs.every) || 33);
	const { action: step, attrs: { run: when, press } } = node;
	useEffect(() => {
		if (!playing || !step) return;
		const timer = setInterval(() => {
			const now = latest.current;
			try { if (when && !evaluate(when.replace(/^\{|\}$/g, ""), now.vars)) return; } catch { return; }
			run(step, now);
		}, every);
		return () => clearInterval(timer);
	}, [playing, step, when, every]);
	const number = (value: string | undefined, fallback = 0) => {
		if (value === undefined) return fallback;
		try { return Number(evaluate(value.replace(/^\{|\}$/g, ""), scope.vars)) || 0; } catch { return fallback; }
	};
	const shows = (box: UiNode) => {
		if (box.attrs.if === undefined) return true;
		try { return !!evaluate(box.attrs.if.replace(/^\{|\}$/g, ""), scope.vars); } catch { return false; }
	};
	const paint = (value: string | undefined) => {
		const color = value === undefined ? "" : interpolate(value, scope.vars).text.trim();
		return SAFE_COLOR.test(color) ? color : undefined;
	};
	const hit = () => { if (press) run(setAction(press), latest.current); };
	return (
		<div className={classes(node, "ui-scene")} tabIndex={0} role="application" aria-label={node.attrs.label ?? "互动画面"}
			style={{ width: `min(100%, ${width}px)`, aspectRatio: `${width} / ${height}`, ...(paint(node.attrs.bg) ? { background: paint(node.attrs.bg) } : {}) }}
			onFocus={() => setPlaying(true)} onBlur={() => setPlaying(false)} onPointerDown={hit}
			onKeyDown={(event) => {
				const code = event.code.replace(/^(Key|Arrow)/, "").toLowerCase();
				const own = node.children.find((c) => c.name === "key" && c.attrs.code?.toLowerCase() === code);
				if (own?.action) run(own.action, latest.current);
				else if (code === "space") hit();
				else return;
				event.preventDefault();
				event.stopPropagation();
			}}>
			{node.children.filter((c) => c.name === "box" && shows(c)).map((box, i) => (
				<span key={i} className="ui-box" style={{
					left: `${number(box.attrs.x) / width * 100}%`, top: `${number(box.attrs.y) / height * 100}%`,
					width: `${number(box.attrs.w, 10) / width * 100}%`, height: `${number(box.attrs.h, 10) / height * 100}%`,
					borderRadius: number(box.attrs.round), fontSize: number(box.attrs.size, 14),
					...(paint(box.attrs.color) ? { background: paint(box.attrs.color) } : {}),
					...(paint(box.attrs.ink) ? { color: paint(box.attrs.ink) } : {}),
				}}>{box.attrs.text ? <Text value={box.attrs.text} /> : null}</span>
			))}
			{playing ? null : <span className="ui-scene-hint">点一下开始</span>}
		</div>
	);
}

/**
 * Components that follow one another, drawn together. Above them, 查看代码 and 全屏 in their own non-overlapping bar;
 * under them, raw SIUI source when toggled and any repair prompt. Full screen portals to `document.body` so Dock,
 * FindBar, Composer and macOS traffic lights never bleed through, while keeping the reply's shared state.
 */
export function UiGroup({ nodes, source, live }: { nodes: UiNode[]; source: string; live: boolean }) {
	const [code, setCode] = useState(false);
	const [full, setFull] = useState(false);
	const [fullCode, setFullCode] = useState(false);
	const fix = useContext(FixContext), report = useContext(UsageContext);
	const errors = live ? [] : problems(nodes);
	useEffect(() => {
		if (!full) return;
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setFull(false); } };
		window.addEventListener("keydown", key, true);
		return () => window.removeEventListener("keydown", key, true);
	}, [full]);
	const title = nodes.find((n) => n.attrs.title)?.attrs.title;
	// Buttons written one after another stand side by side.
	const runs = nodes.filter((n) => n.name !== "var").reduce<UiNode[][]>((out, n) => {
		const last = out[out.length - 1];
		if (n.name === "button" && last?.[0]!.name === "button") last.push(n); else out.push([n]);
		return out;
	}, []);
	const renderNodes = (prefix: string) => runs.map((run) => (
		<div key={`${prefix}-${run[0]!.offset}`} className={run[0]!.name === "button" ? "ui-node ui-buttons" : "ui-node"}>
			{run.map((n) => <UiView key={n.offset} node={n} />)}
		</div>
	));
	return (
		<div className={code ? "ui-group code-open" : "ui-group"}>
			{live ? null : (
				<div className="ui-tools">
					<button type="button" className={code ? "act on" : "act"} aria-label="查看代码" title="查看原始输出" aria-pressed={code} onClick={() => setCode(!code)}><Code /></button>
					<button type="button" className="act" aria-label="全屏" title="全屏" onClick={() => { setFullCode(false); setFull(true); report("fullscreen"); }}><Expand /></button>
				</div>
			)}
			{renderNodes("inline")}
			<Reveal open={code}>
				<div className="ui-source-wrap">
					<div className="ui-source-head">原始输出</div>
					<pre className="md-code ui-source"><code>{source}</code></pre>
				</div>
			</Reveal>
			{errors.length ? (
				<div className="ui-problem">
					<span className="ui-problem-text"><i />{errors[0]}{errors.length > 1 ? `（还有 ${errors.length - 1} 处）` : ""}</span>
					<button type="button" className="ghost" onClick={() => { report("fixed"); fix(errors); }}>让 Mountains 修复</button>
				</div>
			) : null}
			{full ? createPortal(
				<div className="ui-full" role="dialog" aria-modal="true" aria-label={title ?? "全屏"}>
					<header className="ui-full-head drag">
						<span className="ui-full-title">{title ? <Text value={title} /> : "互动视图"}</span>
						<div className="ui-full-actions">
							<button type="button" className={fullCode ? "ghost on" : "ghost"} aria-pressed={fullCode} onClick={() => setFullCode(!fullCode)}>
								{fullCode ? "隐藏原始输出" : "查看原始输出"}
							</button>
							<button type="button" className="ghost" onClick={() => setFull(false)}>退出全屏 <kbd>Esc</kbd></button>
						</div>
					</header>
					<div className="ui-full-body">
						<div className="ui-full-inner">
							{renderNodes("full")}
							<Reveal open={fullCode}>
								<div className="ui-source-wrap">
									<div className="ui-source-head">原始输出</div>
									<pre className="md-code ui-source"><code>{source}</code></pre>
								</div>
							</Reveal>
						</div>
					</div>
				</div>, document.body) : null}
		</div>
	);
}

/** One component and what is inside it. */
export function UiView({ node }: { node: UiNode }): ReactNode {
	const scope = useScope();
	if (node.name === "#text") return <Text value={node.text} />;
	const kids = node.children.map((c, i) => <UiView key={i} node={c} />);
	const style = styleOf(node.attrs.style, scope.vars);
	const label = node.attrs.label;
	switch (node.name) {
		case "big": return <div className={classes(node, "ui-big")} style={style}>{kids}</div>;
		case "stat": return <div className={classes(node, "ui-stat")} style={style}><span className="ui-stat-label"><Text value={label ?? ""} /></span><span className="ui-stat-value">{kids}</span></div>;
		case "note": return <div className={classes(node, "ui-note")} style={style}>{kids}</div>;
		case "progress": {
			let share = 0;
			try { share = Math.max(0, Math.min(1, Number(evaluate((node.attrs.value ?? "0").replace(/^\{|\}$/g, ""), scope.vars)))); } catch { /* empty bar */ }
			return <div className={classes(node, "ui-progress")} style={style}><span className="ui-progress-label"><Text value={label ?? ""} /></span><span className="ui-bar"><span style={{ width: `${share * 100}%` }} /></span><span className="ui-chart-value">{Math.round(share * 100)}%</span></div>;
		}
		case "chart": return <Chart node={node} />;
		case "steps": return <ol className={classes(node, "ui-steps")} style={style}>{kids}</ol>;
		case "step": return <li className={classes(node, "ui-step")} style={style}>{kids}</li>;
		case "row": return <div className={classes(node, "ui-row")} style={style}>{kids}</div>;
		case "grid": return <div className={classes(node, "ui-grid")} style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(6, Number(node.attrs.cols) || 2))}, minmax(0, 1fr))`, ...style }}>{kids}</div>;
		case "card": return <section className={classes(node, "ui-card")} style={style}>{node.attrs.title ? <h4><Text value={node.attrs.title} /></h4> : null}{kids}</section>;
		case "tabs": return <Tabs node={node} />;
		case "slider": case "input": case "toggle": case "select": return <Control node={node} />;
		case "scene": return <Scene node={node} />;
		case "button": return <button type="button" className={classes(node, "ui-button")} style={style} onClick={() => { if (node.action) run(node.action, scope); }}>{kids}</button>;
		case "var": return null;
		default:
			if (!PLAIN.has(node.name)) return <Unknown node={node} />;
			return createElement(node.name, { className: node.styles.map((s) => `ui-${s}`).join(" ") || undefined, style }, ...(node.name === "hr" || node.name === "br" ? [] : [kids]));
	}
}
