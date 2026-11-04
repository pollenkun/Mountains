/**
 * The dock: one glass object. At rest it is hidden past the window's edge; the pointer touching that edge brings out
 * a rail of icons, which swell along the rail around the pointer; a panel is the same object opening out of it.
 * Reveal, swell, open and the label all move on one spring, written straight to the elements each frame.
 * The icons move only by transform, so the rail's own box never changes under the pointer.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type DockSide = "left" | "right" | "top" | "bottom";
const across = (side: DockSide) => side === "top" || side === "bottom";

export interface DockItem {
	key: string;
	label: string;
	icon: ReactNode;
	onClick?: () => void;
	/** What opens out of the dock. */
	panel?: (close: () => void) => ReactNode;
	current?: boolean;
	danger?: boolean;
}

const BASE = 38, MAX = 50, SIGMA = 44, EDGE = 8, KEEP = 40, LEAVE_MS = 260, GAP = 4, TIP_WAIT_MS = 280;

interface Spring { x: number; v: number }
const still = (x = 0): Spring => ({ x, v: 0 });

/** Semi-implicit Euler; `damping` 1 is critical, and below 1 it overshoots a little. */
function spring(state: Spring, target: number, dt: number, response = 0.34, damping = 1, reduce = false): number {
	if (reduce) { state.x = target; state.v = 0; return state.x; }
	const w = 2 * Math.PI / response;
	state.v += (w * w * (target - state.x) - 2 * damping * w * state.v) * dt;
	state.x += state.v * dt;
	return state.x;
}

export function Dock({ side, items, groups }: { side: DockSide; items: Record<string, DockItem>; groups: string[][] }) {
	const [open, setOpen] = useState<string | null>(null);
	const dock = useRef<HTMLElement>(null);
	const rail = useRef<HTMLDivElement>(null);
	const surface = useRef<HTMLSpanElement>(null);
	const sheet = useRef<HTMLDivElement>(null);
	const tip = useRef<HTMLSpanElement>(null);
	const lip = useRef<HTMLDivElement>(null);
	const openRef = useRef<string | null>(null);
	openRef.current = open;
	const sideRef = useRef(side);
	sideRef.current = side;
	const close = useCallback(() => setOpen(null), []);
	// One full frame is owed after mounting or moving to another side: it places the dock out of sight.
	const placed = useRef(false);

	useEffect(() => {
		const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const node = dock.current!, railNode = rail.current!, surfaceNode = surface.current!, sheetNode = sheet.current!, tipNode = tip.current!, lipNode = lip.current!;
		const reveal = still(), opening = still(), tipAt = still(), tipAlpha = still();
		const panelW = still(), panelH = still(), switchProgress = still(1);
		const scales = new Map<Element, Spring>();
		const ptr = { x: -1e4, y: -1e4 };
		let shown = false, outsideSince = 0, hovered: Element | null = null, tipSeen = 0, focusInside = false, last = performance.now(), frame = 0, leaving: HTMLElement | null = null;
		let currentPanelEl: HTMLElement | null = null, switchingFrom: HTMLElement | null = null;

		const onMove = (event: PointerEvent) => { ptr.x = event.clientX; ptr.y = event.clientY; };
		const onLeave = () => { ptr.x = ptr.y = -1e4; };
		// Keyboard focus keeps the dock out; a click leaves focus behind too, and that must not.
		const onFocusIn = (event: FocusEvent) => { focusInside = (event.target as Element).matches(":focus-visible"); };
		const onFocusOut = () => { focusInside = false; };
		window.addEventListener("pointermove", onMove, { passive: true });
		document.documentElement.addEventListener("pointerleave", onLeave);
		node.addEventListener("focusin", onFocusIn);
		node.addEventListener("focusout", onFocusOut);

		const edgeDistance = () => {
			if (ptr.x < 0 || ptr.y < 0 || ptr.x > innerWidth || ptr.y > innerHeight) return Infinity;
			return sideRef.current === "left" ? ptr.x : sideRef.current === "right" ? innerWidth - ptr.x : sideRef.current === "top" ? ptr.y : innerHeight - ptr.y;
		};
		const inRail = (margin: number) => {
			const box = railNode.getBoundingClientRect(), vertical = !across(sideRef.current);
			const grow = vertical ? [MAX - BASE + margin, margin] : [margin, MAX - BASE + margin];
			return ptr.x > box.left - grow[0]! && ptr.x < box.right + grow[0]! && ptr.y > box.top - grow[1]! && ptr.y < box.bottom + grow[1]!;
		};
		const openPanel = () => openRef.current ? sheetNode.querySelector<HTMLElement>(`[data-panel="${openRef.current}"]`) : null;

		const tick = (now: number) => {
			frame = requestAnimationFrame(tick);
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			const currentSide = sideRef.current, vertical = !across(currentSide), drop = currentSide === "top" ? -10 : 10;
			const panel = openPanel();
			const distance = edgeDistance();
			// Hidden and at rest, nothing here costs a layout read: the page may be streaming.
			if (placed.current && !shown && !panel && distance > EDGE && !focusInside && Math.abs(reveal.x) < 0.001 && Math.abs(reveal.v) < 0.001 && opening.x < 0.001 && !leaving && !switchingFrom) return;
			placed.current = true;
			if (!shown && (distance <= EDGE || focusInside)) shown = true;
			if (shown && !panel && !inRail(KEEP) && !focusInside && distance > EDGE) {
				outsideSince ||= now;
				if (now - outsideSince > LEAVE_MS) shown = false;
			} else outsideSince = 0;
			const out = shown || panel ? 1 : 0;
			const r = Math.max(0, Math.min(1.04, spring(reveal, out, dt, 0.36, out ? 0.82 : 1, reduce)));
			const railW = railNode.offsetWidth, railH = railNode.offsetHeight;
			const off = (1 - r) * ((vertical ? railW : railH) + 64);
			node.style.transform = currentSide === "left" ? `translate(${-off}px,-50%)` : currentSide === "right" ? `translate(${off}px,-50%)` : `translate(-50%,${currentSide === "top" ? -off : off}px)`;
			lipNode.style.opacity = String(0.18 * Math.max(0, 1 - r * 2));

			// Icons swell along the rail, not while a panel is open: the rail is then a stable index.
			const box = railNode.getBoundingClientRect(), along = vertical ? ptr.y : ptr.x, start = vertical ? box.top : box.left;
			const swelling = r > 0.9 && !panel && inRail(0) && !reduce;
			const children = [...railNode.children] as HTMLElement[];
			let total = 0;
			for (const element of children) {
				if (!element.classList.contains("di")) continue;
				const state = scales.get(element) ?? still(1);
				scales.set(element, state);
				const centre = start + (vertical ? element.offsetTop : element.offsetLeft) + BASE / 2;
				const swell = swelling ? Math.exp(-((along - centre) ** 2) / (2 * SIGMA * SIGMA)) : 0;
				spring(state, 1 + (MAX / BASE - 1) * swell, dt, 0.22, 1, reduce);
				total += (state.x - 1) * BASE;
			}
			let run = -total / 2, hit: { element: Element; mid: number } | null = null;
			const move = (at: number) => vertical ? `translateY(${at.toFixed(2)}px)` : `translateX(${at.toFixed(2)}px)`;
			for (const element of children) {
				if (!element.classList.contains("di")) { element.style.transform = move(run); continue; }
				const scale = scales.get(element)!.x, extra = (scale - 1) * BASE, at = run + extra / 2;
				element.style.transform = `${move(at)} scale(${scale.toFixed(4)})`;
				const low = (vertical ? element.offsetTop : element.offsetLeft) + at, high = low + BASE * scale;
				if (r > 0.9 && !panel && inRail(0) && along - start >= low && along - start < high) hit = { element, mid: (low + high) / 2 };
				run += extra;
			}

			// Detect panel switching vs opening vs closing
			if (panel !== currentPanelEl) {
				if (currentPanelEl && panel && opening.x > 0.25) {
					if (switchingFrom && switchingFrom !== currentPanelEl) {
						switchingFrom.style.opacity = "0";
						switchingFrom.style.filter = "";
					}
					switchingFrom = currentPanelEl;
					switchProgress.x = 0;
					switchProgress.v = 0;
				} else if (!panel) {
					if (switchingFrom) {
						switchingFrom.style.opacity = "0";
						switchingFrom.style.filter = "";
						switchingFrom = null;
					}
					switchProgress.x = 1;
					switchProgress.v = 0;
				}
				currentPanelEl = panel;
			}

			// The object opens: the surface grows from the rail to hold the panel, and smoothly morphs between panels on switch.
			const o = Math.max(0, spring(opening, panel ? 1 : 0, dt, 0.38, panel ? 0.86 : 1, reduce));
			const targetPw = panel?.offsetWidth || switchingFrom?.offsetWidth || 0;
			const targetPh = panel?.offsetHeight || switchingFrom?.offsetHeight || 0;
			if (opening.x < 0.05 && panel) {
				panelW.x = targetPw; panelW.v = 0;
				panelH.x = targetPh; panelH.v = 0;
			} else if (targetPw && targetPh) {
				spring(panelW, targetPw, dt, 0.32, 0.86, reduce);
				spring(panelH, targetPh, dt, 0.32, 0.86, reduce);
			}
			const pw = panelW.x || targetPw, ph = panelH.x || targetPh;
			const lengthRest = (vertical ? railH : railW) + total, crossRest = vertical ? railW : railH;
			let sx: number, sy: number, sw: number, sh: number;
			if (vertical) {
				sw = crossRest + (GAP + pw) * o;
				sh = lengthRest + (Math.max(lengthRest, ph + 14) - lengthRest) * o;
				sx = currentSide === "left" ? 0 : railW - sw;
				sy = (railH - sh) / 2;
				sheetNode.style.transform = `translate(${currentSide === "left" ? railW + GAP : -(pw + GAP)}px, ${(railH - ph) / 2}px)`;
			} else {
				sh = crossRest + (GAP + ph) * o;
				sw = lengthRest + (Math.max(lengthRest, pw + 14) - lengthRest) * o;
				sx = (railW - sw) / 2;
				sy = currentSide === "top" ? 0 : railH - sh;
				sheetNode.style.transform = `translate(${(railW - pw) / 2}px, ${currentSide === "top" ? railH + GAP : -(ph + GAP)}px)`;
			}
			surfaceNode.style.width = `${sw}px`;
			surfaceNode.style.height = `${sh}px`;
			surfaceNode.style.transform = `translate(${sx}px, ${sy}px)`;
			surfaceNode.style.borderRadius = `${(26 - 4 * o).toFixed(1)}px`;

			if (switchingFrom) {
				spring(switchProgress, 1, dt, 0.30, 0.88, reduce);
				const sp = Math.max(0, Math.min(1, switchProgress.x));
				const outAlpha = Math.max(0, 1 - sp * 2.2);
				switchingFrom.style.opacity = outAlpha.toFixed(3);
				switchingFrom.style.filter = sp > 0.01 ? `blur(${(sp * 6).toFixed(2)}px)` : "";
				switchingFrom.style.transform = vertical ? `translateX(${(sp * (currentSide === "left" ? 10 : -10)).toFixed(2)}px)` : `translateY(${(sp * drop).toFixed(2)}px)`;
				if (sp >= 0.98 || outAlpha <= 0) {
					switchingFrom.style.opacity = "0";
					switchingFrom.style.filter = "";
					switchingFrom = null;
				}
				if (panel) {
					const inAlpha = Math.max(0, Math.min(1, (sp - 0.15) / 0.80));
					panel.style.opacity = inAlpha.toFixed(3);
					panel.style.filter = inAlpha < 0.98 ? `blur(${((1 - inAlpha) * 6).toFixed(2)}px)` : "";
					panel.style.transform = vertical ? `translateX(${((1 - inAlpha) * (currentSide === "left" ? -10 : 10)).toFixed(2)}px)` : `translateY(${((1 - inAlpha) * drop).toFixed(2)}px)`;
				}
			} else if (panel) {
				const c = Math.max(0, Math.min(1, (o - 0.5) / 0.45));
				panel.style.opacity = c.toFixed(3);
				panel.style.filter = c < 1 ? `blur(${((1 - c) * 6).toFixed(2)}px)` : "";
				panel.style.transform = vertical ? `translateX(${((1 - c) * (currentSide === "left" ? -10 : 10)).toFixed(2)}px)` : `translateY(${((1 - c) * drop).toFixed(2)}px)`;
			} else if (leaving) {
				const c = Math.max(0, Math.min(1, (o - 0.5) / 0.45));
				leaving.style.opacity = c.toFixed(3);
				leaving.style.filter = c < 1 ? `blur(${((1 - c) * 6).toFixed(2)}px)` : "";
				leaving.style.transform = vertical ? `translateX(${((1 - c) * (currentSide === "left" ? -10 : 10)).toFixed(2)}px)` : `translateY(${((1 - c) * drop).toFixed(2)}px)`;
				if (o < 0.02) { leaving.style.opacity = "0"; leaving.style.filter = ""; leaving = null; }
			}
			if (panel) leaving = panel;

			// One label, travelling from icon to icon rather than fading out and in.
			if (hit) {
				if (!hovered) tipSeen = tipAlpha.x > 0.5 ? tipSeen : now;
				if (hovered !== hit.element) tipNode.textContent = hit.element.getAttribute("aria-label");
				hovered = hit.element;
			} else hovered = null;
			spring(tipAlpha, hovered && now - tipSeen > TIP_WAIT_MS ? 1 : 0, dt, 0.2, 1, reduce);
			const target = hit ? hit.mid : tipAt.x;
			if (tipAlpha.x < 0.02 && hit) { tipAt.x = target; tipAt.v = 0; } else spring(tipAt, target, dt, 0.14, 1, reduce);
			const tw = tipNode.offsetWidth, th = tipNode.offsetHeight, a = tipAlpha.x;
			tipNode.style.opacity = Math.max(0, Math.min(1, a)).toFixed(3);
			const pop = 0.94 + 0.06 * Math.min(1, a);
			if (currentSide === "left") tipNode.style.transform = `translate(${railW + 10 + (1 - a) * -6}px, ${tipAt.x - th / 2}px) scale(${pop})`;
			if (currentSide === "right") tipNode.style.transform = `translate(${-tw - 10 + (1 - a) * 6}px, ${tipAt.x - th / 2}px) scale(${pop})`;
			if (currentSide === "bottom") tipNode.style.transform = `translate(${tipAt.x - tw / 2}px, ${-th - 10 + (1 - a) * 6}px) scale(${pop})`;
			if (currentSide === "top") tipNode.style.transform = `translate(${tipAt.x - tw / 2}px, ${railH + 10 + (1 - a) * -6}px) scale(${pop})`;
			tipNode.style.transformOrigin = currentSide === "left" ? "left center" : currentSide === "right" ? "right center" : currentSide === "top" ? "center top" : "center bottom";
		};
		frame = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("pointermove", onMove);
			document.documentElement.removeEventListener("pointerleave", onLeave);
			node.removeEventListener("focusin", onFocusIn);
			node.removeEventListener("focusout", onFocusOut);
		};
	}, []);

	useEffect(() => {
		const away = (event: PointerEvent) => { if (openRef.current && !(event.target as Element).closest?.(".dock")) setOpen(null); };
		// Escape closes a panel first; only with none open does it reach the run.
		const key = (event: KeyboardEvent) => { if (event.key === "Escape" && openRef.current) { event.preventDefault(); event.stopPropagation(); setOpen(null); } };
		document.addEventListener("pointerdown", away);
		window.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key, true); };
	}, []);
	useEffect(() => { setOpen(null); placed.current = false; }, [side]);

	const all = Object.values(items);
	return (
		<>
			<div className={`dock-lip ${side}`} ref={lip} aria-hidden="true" />
			<nav className={`dock ${across(side) ? "h" : "v"} ${side}`} ref={dock} aria-label="工具栏">
				<span className="dock-surface" ref={surface} aria-hidden="true" />
				<div className="dock-rail" ref={rail}>
					{groups.flatMap((group, index) => [
						...(index ? [<span key={`gap${index}`} className="dock-gap" />] : []),
						...group.map((key) => {
							const item = items[key]!;
							return (
								<button key={key} type="button" data-k={key} aria-label={item.label} aria-expanded={item.panel ? open === key : undefined} aria-current={item.current ? "page" : undefined}
									className={["di", open === key ? "sel" : "", item.danger ? "danger" : ""].filter(Boolean).join(" ")}
									onClick={() => {
										if (item.panel) { setOpen(open === key ? null : key); return; }
										setOpen(null);
										item.onClick?.();
									}}>{item.icon}</button>
							);
						}),
					])}
				</div>
				<div className="dock-sheet" ref={sheet}>
					{all.filter((item) => item.panel).map((item) => (
						<div key={item.key} data-panel={item.key} className={open === item.key ? "dock-panel open" : "dock-panel"} role="dialog" aria-label={item.label} inert={open !== item.key}>{item.panel!(close)}</div>
					))}
				</div>
				<span className="dock-tip" ref={tip} aria-hidden="true" />
			</nav>
		</>
	);
}
