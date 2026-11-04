/** The context gauge, and the model and approval panels the dock opens. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { RollingText, Swap, useLeaving } from "./Motion.tsx";
import { knownLabel, useI18n } from "./i18n.tsx";

export interface ShellInfo {
	model: string;
	displayName: string;
	contextWindow: number | null;
	currency: string;
	tiers: { id: string; label: string }[];
	thinking: "off" | "always" | "tiers";
	ultraCode: boolean;
	effort: string;
	defaultEffort: string;
	models: { id: string; displayName: string; env?: string; contextWindow?: number; thinking?: "off" | "always" | "tiers"; protocol?: "openai" | "anthropic" }[];
	mode: "system" | "light" | "dark";
	ready: boolean;
	setupSkipped?: boolean;
	keys: { env: string; name: string; masked: string }[];
	web: { enabled: boolean; service: string | null; services: { id: string; name: string; env: string; needsKey: boolean }[]; own: { name: string; hasSearch: boolean } | null };
	/** UltraCode is on, and how many agents may work at once; null is no limit. */
	team: boolean;
	maxAgents: number | null;
	/** Models the user added, which they can also remove. */
	addedModels: string[];
	/** Where a model can be added, and whether a key is at hand there. */
	platforms: { id: string; name: string; hasKey: boolean }[];
	todaySpend: Record<string, number>;
	approval: "ask" | "auto" | "full";
	autoApproval: boolean;
	approvalModel: { id: string; displayName: string; follows: boolean } | null;
	approvalEffort?: string | null;
	approvalTiers?: { id: string; label: string }[];
	approvalDefaultLabel?: string;
	reviewModels: { id: string; displayName: string }[];
	titles?: { enabled: boolean; model: { id: string; displayName: string; follows: boolean } };
	siui?: boolean;
	key: { env: string; source: "environment" | "keychain" | null; masked: string | null };
}

export type ShellRequest =
	| { type: "team"; enabled?: boolean; maxAgents?: number | null }
	| { type: "info" }
	| { type: "skipSetup" }
	| { type: "mode"; mode: ShellInfo["mode"] }
	| { type: "balance" }
	| { type: "choose"; model?: string; effort?: string }
	| { type: "approval"; mode: ShellInfo["approval"] }
	| { type: "approvalModel"; model: string | null }
	| { type: "approvalEffort"; effort: string | null }
	| { type: "titles"; enabled?: boolean; model?: string | null }
	| { type: "siui"; enabled: boolean };

const tokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** A popover that closes on Escape or a click elsewhere, and grows from its button. */
export function Popover({ open, onClose, className, children }: { open: boolean; onClose: () => void; className: string; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const away = (event: PointerEvent) => { if (!ref.current?.parentElement?.contains(event.target as Node)) onClose(); };
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
		window.addEventListener("pointerdown", away);
		window.addEventListener("keydown", key, true);
		return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key, true); };
	}, [open, onClose]);
	const { shown, leaving } = useLeaving(open);
	return shown ? <div ref={ref} className={`popover ${className}`} data-leaving={leaving || undefined} role="dialog">{children}</div> : null;
}

export function ContextGauge({ used, window: size, parts }: { used: number | null; window: number | null; parts: { system: number; tools: number } | null }) {
	const { t } = useI18n();
	if (!used || !size) return null;
	const share = Math.min(1, used / size);
	const r = 6, c = 2 * Math.PI * r;
	return (
		<span className="gauge" tabIndex={0} aria-label={`${t("context")} ${tokens(used)} / ${tokens(size)}`}>
			<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
				<circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${c * share} ${c}`} transform="rotate(-90 8 8)" />
			</svg>
			<RollingText text={`${Math.round(share * 100)}%`} />
			<span className="gauge-card" role="tooltip">
				<span className="gauge-line strong"><span>{t("context")}</span><span>{tokens(used)} / {tokens(size)}</span></span>
				{parts ? <>
					<span className="gauge-line"><span>{t("systemPrompt")}</span><span>{tokens(parts.system)}</span></span>
					<span className="gauge-line"><span>{t("toolsWord")}</span><span>{tokens(parts.tools)}</span></span>
					<span className="gauge-line"><span>{t("conversation")}</span><span>{tokens(Math.max(0, used - parts.system - parts.tools))}</span></span>
				</> : null}
			</span>
		</span>
	);
}

/** Positions on the slider: the model's tiers. */
function stops(info: ShellInfo): { id: string; label: string }[] {
	const base = info.thinking === "tiers" ? info.tiers : [{ id: "default", label: info.thinking === "always" ? "思考" : "不支持思考" }];
	return base;
}

/** Where the pointer is along a slider's track, from 0 (first stop) to 1 (last); the stops sit 20px in from each end. */
function along(event: { clientX: number; currentTarget: Element }): number {
	const box = event.currentTarget.getBoundingClientRect();
	return Math.min(1, Math.max(0, (event.clientX - box.left - 20) / Math.max(1, box.width - 40)));
}

interface Spring { x: number; v: number }

function stepSpring(state: Spring, target: number, dt: number, response: number, damping: number, reduce: boolean): number {
	if (reduce) { state.x = target; state.v = 0; return state.x; }
	const w = 2 * Math.PI / response;
	state.v += (w * w * (target - state.x) - 2 * damping * w * state.v) * dt;
	state.x += state.v * dt;
	return state.x;
}

/** Physics-driven tier slider: shares the dock's spring model, moves on the compositor, and never double-jumps on tap or release. */
function TierSlider({ all, currentId, ariaLabel, onChoose }: { all: { id: string; label: string }[]; currentId: string; ariaLabel: string; onChoose: (id: string) => void }) {
	const [pendingId, setPendingId] = useState<string | null>(null);
	if (pendingId !== null && pendingId === currentId) setPendingId(null);
	const effectiveId = pendingId ?? currentId;
	const index = Math.max(0, all.findIndex((stop) => stop.id === effectiveId));
	const last = all.length - 1;
	const restAt = last ? index / last : 0.5;
	const [near, setNear] = useState(index);
	const [dragging, setDragging] = useState(false);

	const trackRef = useRef<HTMLDivElement>(null);
	const fillRef = useRef<HTMLDivElement>(null);
	const knobRef = useRef<HTMLDivElement>(null);
	const posRef = useRef<Spring>({ x: restAt, v: 0 });
	const scaleRef = useRef<Spring>({ x: 1, v: 0 });
	const targetRef = useRef(restAt);
	const rafRef = useRef(0);
	const mountedRef = useRef(false);
	const gestureRef = useRef<{
		downX: number;
		downRaw: number;
		grabOffset: number;
		nearKnob: boolean;
		dragging: boolean;
		pressed: boolean;
		lastTime: number;
	} | null>(null);

	const paint = (x: number, scale: number) => {
		const track = trackRef.current, fill = fillRef.current, knob = knobRef.current;
		if (!track || !fill || !knob) return;
		const width = track.clientWidth || 246;
		const clamped = Math.max(-0.04, Math.min(1.04, x));
		const cx = last ? 20 + clamped * Math.max(0, width - 40) : width / 2;
		knob.style.transform = `translate3d(${(cx - 16).toFixed(2)}px, -16px, 0) scale(${scale.toFixed(3)})`;
		fill.style.width = last ? `${Math.max(40, Math.min(width, cx + 20)).toFixed(2)}px` : "100%";
	};

	const startSpring = () => {
		if (rafRef.current) return;
		const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
		let prev = performance.now();
		const frame = (now: number) => {
			const dt = Math.min(0.04, Math.max(0.001, (now - prev) / 1000));
			prev = now;
			const g = gestureRef.current;
			const scaleTarget = g?.pressed ? 1.07 : 1;
			stepSpring(scaleRef.current, scaleTarget, dt, 0.18, 0.9, reduce);
			if (!g?.dragging) {
				stepSpring(posRef.current, targetRef.current, dt, 0.28, 0.85, reduce);
			}
			paint(posRef.current.x, scaleRef.current.x);
			const settledPos = !g?.dragging && Math.abs(posRef.current.x - targetRef.current) < 0.0005 && Math.abs(posRef.current.v) < 0.002;
			const settledScale = !g?.pressed && Math.abs(scaleRef.current.x - 1) < 0.001 && Math.abs(scaleRef.current.v) < 0.002;
			if (settledPos && settledScale) {
				posRef.current.x = targetRef.current;
				posRef.current.v = 0;
				scaleRef.current.x = 1;
				scaleRef.current.v = 0;
				paint(targetRef.current, 1);
				rafRef.current = 0;
				return;
			}
			rafRef.current = requestAnimationFrame(frame);
		};
		rafRef.current = requestAnimationFrame(frame);
	};

	useLayoutEffect(() => {
		if (!mountedRef.current) {
			mountedRef.current = true;
			posRef.current.x = restAt;
			targetRef.current = restAt;
			paint(restAt, 1);
			return;
		}
		if (!gestureRef.current) {
			targetRef.current = restAt;
			setNear(index);
			startSpring();
		}
	}, [index, last, restAt]);

	useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

	const chosen = all[near] ?? all[index]!;

	return (
		<>
			<div className="effort-label">
				<Swap id={chosen.id}><span>{chosen.label}</span></Swap>
			</div>
			<div ref={trackRef} className={dragging ? "slider dragging" : "slider"} role="radiogroup" aria-label={ariaLabel}
				onPointerDown={(event) => {
					if (all.length < 2) return;
					event.currentTarget.setPointerCapture(event.pointerId);
					const raw = along(event);
					const nearKnob = Math.abs(raw - posRef.current.x) <= 0.16;
					gestureRef.current = {
						downX: event.clientX,
						downRaw: raw,
						grabOffset: nearKnob ? posRef.current.x - raw : 0,
						nearKnob,
						dragging: false,
						pressed: true,
						lastTime: performance.now(),
					};
					if (!nearKnob && last > 0) {
						const tapped = Math.round(raw * last);
						targetRef.current = tapped / last;
						setNear(tapped);
					}
					startSpring();
				}}
				onPointerMove={(event) => {
					const g = gestureRef.current;
					if (!g || last < 1) return;
					if (!g.dragging) {
						if (Math.abs(event.clientX - g.downX) < 2) return;
						g.dragging = true;
						setDragging(true);
					}
					const raw = along(event);
					const now = performance.now();
					const dt = Math.max(0.004, (now - g.lastTime) / 1000);
					const offset = g.grabOffset * Math.max(0, 1 - Math.abs(raw - g.downRaw) * 3);
					const u = Math.min(1, Math.max(0, raw + offset));
					// Strictly monotonic magnetic pull over each stop (derivative >= 0.84 everywhere).
					const detent = u - 0.16 * Math.sin(2 * Math.PI * u * last) / (2 * Math.PI * last);
					posRef.current.v = Math.max(-5, Math.min(5, (detent - posRef.current.x) / dt * 0.5));
					posRef.current.x = detent;
					targetRef.current = detent;
					g.lastTime = now;
					paint(detent, scaleRef.current.x);
					const nextNear = Math.round(detent * last);
					setNear((prev) => prev === nextNear ? prev : nextNear);
					startSpring();
				}}
				onPointerUp={(event) => {
					const g = gestureRef.current;
					if (!g || last < 1) return;
					const wasDragging = g.dragging;
					gestureRef.current = null;
					setDragging(false);
					const raw = wasDragging ? posRef.current.x : along(event);
					const at = Math.round(raw * last);
					targetRef.current = at / last;
					setNear(at);
					startSpring();
					const picked = all[at]!;
					if (picked.id !== currentId) {
						setPendingId(picked.id);
						onChoose(picked.id);
					} else {
						setPendingId(null);
					}
				}}
				onPointerCancel={() => {
					gestureRef.current = null;
					setDragging(false);
					targetRef.current = restAt;
					setNear(index);
					startSpring();
				}}>
				<div ref={fillRef} className="slider-fill" />
				<div ref={knobRef} className="knob" />
				{all.map((stop, i) => (
					<button key={stop.id} type="button" role="radio" aria-checked={i === index} aria-label={stop.label} className={i === near ? "stop on" : "stop"} style={{ left: last ? `calc(${i / last} * (100% - 40px) + 20px)` : "50%" }}
						// The pointer is handled by the track; this is for the keyboard.
						onClick={(event) => {
							if (event.detail === 0 && stop.id !== currentId) {
								setPendingId(stop.id);
								onChoose(stop.id);
							}
						}} />
				))}
			</div>
		</>
	);
}

/** The model panel the dock opens: the models, then the thinking tier of the chosen one (the EffortPicker board). */
export function ModelPanel({ info, ask, onInfo, onAdd }: { info: ShellInfo | null; ask: (request: ShellRequest) => Promise<unknown>; onInfo: (info: ShellInfo) => void; onAdd: () => void }) {
	const { t } = useI18n();
	const [failed, setFailed] = useState("");
	if (!info) return null;
	const all = stops(info).map((stop) => ({ ...stop, label: knownLabel(stop.label, t) }));
	const current = info.effort === "default" && info.thinking === "tiers" ? info.defaultEffort : info.effort;
	const choose = (request: ShellRequest) => {
		setFailed("");
		void ask(request).then((next) => onInfo(next as ShellInfo), (error: unknown) => setFailed(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)));
	};
	return (
		<div className="model-panel">
			<div className="ph">{t("model")}</div>
			{info.models.map((model) => (
				<button key={model.id} type="button" role="menuitemradio" aria-checked={model.id === info.model} className="opt"
					onClick={() => { if (model.id !== info.model) choose({ type: "choose", model: model.id }); }}>
					<Tick /><span>{model.displayName}</span>
				</button>
			))}
			{info.models.length ? null : <button type="button" className="opt add-first" onClick={onAdd}>{t("addModel")}</button>}
			{failed ? <p className="setting-error">{failed}</p> : null}
			{info.ready && (all.length > 1 || info.thinking === "tiers" || info.ultraCode) ? (
				<div className="effort">
					{all.length > 1 || info.thinking === "tiers" ? (
						<>
							<div className="ph effort-head">{t("effort")}
								<button type="button" className="reset" aria-label={t("restoreDefault")} title={t("restoreDefault")} onClick={() => choose({ type: "choose", effort: "default" })}>
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
								</button>
							</div>
							<TierSlider all={all} currentId={current} ariaLabel={t("effort")} onChoose={(effort) => choose({ type: "choose", effort })} />
						</>
					) : null}
					{info.ultraCode ? (
						<label className="ultra-switch"><span className={info.team ? "ultra-word on" : "ultra-word"} data-word="UltraCode">UltraCode</span>
							<input type="checkbox" className="switch" checked={info.team} onChange={(event) => choose({ type: "team", enabled: event.target.checked })} />
						</label>
					) : null}
				</div>
			) : null}
		</div>
	);
}

const Tick = () => <svg className="ck" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>;

const Hand = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0" /><path d="M14 10V4a2 2 0 0 0-4 0v2" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></svg>;
const Shield = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>;
const Alert = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>;

const MODES = [
	{ id: "ask", label: "请求批准", note: "修改文件、运行命令前请求批准", icon: <Alert /> },
	{ id: "auto", label: "自动审批", note: "由另一个模型审批，无法判断时请求批准", icon: <Shield /> },
	{ id: "full", label: "完全访问", note: "直接修改文件、运行命令和联网", icon: <Alert /> },
] as const;

/** The approval panel the dock opens (the ApprovalMode board): strictest first, with inline model & effort controls. */
export function ApprovalPanel({ info, ask, onInfo, onDone }: { info: ShellInfo | null; ask: (request: ShellRequest) => Promise<unknown>; onInfo: (info: ShellInfo) => void; onDone: () => void }) {
	const { t } = useI18n();
	if (!info) return null;
	const tiers = info.approvalTiers ?? [];
	const defaultLabel = info.approvalDefaultLabel ?? t("defaultLowest");
	const currentEffort = info.approvalEffort ?? null;
	return (
		<div className="approval-panel">
			<div className="ph">{t("approvalHeading")}</div>
			<div className="approval-modes">
				{MODES.map((mode) => {
					const unavailable = mode.id === "auto" && !info.autoApproval;
					const checked = mode.id === info.approval;
					return (
						<button key={mode.id} type="button" role="menuitemradio" aria-checked={checked} disabled={unavailable}
							className={mode.id === "full" ? "opt approval-opt full" : "opt approval-opt"}
							onClick={() => void ask({ type: "approval", mode: mode.id }).then((next) => {
								onInfo(next as ShellInfo);
								if (mode.id !== "auto") setTimeout(onDone, 160);
							})}>
							<span className="opt-icon">{mode.icon}</span>
							<span className="opt-copy">
								<span className="opt-title">{t(mode.id === "ask" ? "askMode" : mode.id === "auto" ? "autoMode" : "fullMode")}</span>
								<small>{unavailable ? t("needReviewer") : t(mode.id === "ask" ? "askNote" : mode.id === "auto" ? "autoNote" : "fullNote")}</small>
							</span>
							<Tick />
						</button>
					);
				})}
			</div>
			{info.approval === "auto" && info.approvalModel ? (
				<div className="approval-extra">
					<label className="approval-field">
						<span className="approval-field-label">{t("approvalModel")}</span>
						<select className="select" aria-label={t("approvalModel")} value={info.approvalModel.follows ? "" : info.approvalModel.id}
							onChange={(event) => void ask({ type: "approvalModel", model: event.target.value || null }).then((next) => onInfo(next as ShellInfo))}>
							<option value="">{info.ready ? `${t("followCurrent")} (${info.displayName})` : t("followCurrent")}</option>
							{info.reviewModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
						</select>
					</label>
					<div className="approval-field">
						<span className="approval-field-label">{t("approvalEffort")}</span>
						{tiers.length ? (
							<div className="approval-tiers" role="radiogroup" aria-label={t("approvalEffort")}>
								<button type="button" role="radio" aria-checked={currentEffort === null} className={currentEffort === null ? "on" : undefined}
									onClick={() => void ask({ type: "approvalEffort", effort: null }).then((next) => onInfo(next as ShellInfo))}>
									{t("defaultLowest")}
								</button>
								{tiers.map((tier) => (
									<button key={tier.id} type="button" role="radio" aria-checked={currentEffort === tier.id} className={currentEffort === tier.id ? "on" : undefined}
										onClick={() => void ask({ type: "approvalEffort", effort: tier.id }).then((next) => onInfo(next as ShellInfo))}>
										{knownLabel(tier.label, t)}
									</button>
								))}
							</div>
						) : (
							<span className="approval-fixed">{t("fixedLowest", { name: knownLabel(defaultLabel, t) })}</span>
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** The dock's approval icon: the mode's own, and its name. */
export function approvalLabel(info: ShellInfo | null): { label: string; full: boolean } {
	const mode = MODES.find((m) => m.id === info?.approval) ?? MODES[0];
	return { label: mode.label, full: mode.id === "full" };
}
