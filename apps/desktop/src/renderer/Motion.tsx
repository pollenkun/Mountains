/**
 * Motion shared by the page: streamed text rises in word by word, numbers roll, and things that leave are
 * kept on screen long enough to animate out. All of it stays still under reduced motion (styles.css).
 */
import { createElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const TRAILING_PUNCT = /^[,.;:!?，。！？；：、…—～）》」』】”’)\]}>%‰°℃]+$/u;

/** Words for Latin text, short words for Chinese; trailing punctuation rides with the word before it so kinsoku wrapping never shifts on settle. */
function segments(text: string): string[] {
	const out: string[] = [];
	for (const { segment } of segmenter.segment(text)) {
		const prev = out[out.length - 1];
		if (prev && /\S/.test(prev) && TRAILING_PUNCT.test(segment)) out[out.length - 1] = prev + segment;
		else out.push(segment);
	}
	return out;
}

/**
 * Words leave in beats of one to three, and the words of one beat rise together, so only two or three groups are ever
 * in the air. Groups grow and beats shorten as the model runs ahead; past 1.3 seconds behind, groups grow fast enough
 * to catch even a very quick model, so the text stays within about three seconds of it. A word takes up no room until
 * its beat comes, so the page grows with the words and the view never runs ahead of them.
 */
const RISE_MS = 1100;
export const SETTLE_MS = RISE_MS + 40;
/** A block that is not words waits until the words before it have mostly risen, so it never lands ahead of them. */
const BLOCK_WAIT_MS = 420;
function beat(backlogMs: number): { size: number; gap: number } {
	if (backlogMs < 300) return { size: 1, gap: 200 };
	if (backlogMs < 700) return { size: 2, gap: 190 };
	if (backlogMs < 1300) return { size: 3, gap: 170 };
	return { size: 3 + Math.ceil((backlogMs - 1300) / 90), gap: 110 };
}
/** Punctuation rides with the word before it instead of rising on its own. */
const WORDLIKE = /[\p{L}\p{N}]/u;

/**
 * The beat a whole reply's words keep, when the reply is drawn as many pieces (paragraphs, list items, cells):
 * every piece takes its words from the same clock, and each character offset remembers its scheduled birth timestamp
 * (`births`) so re-parsed Markdown spans/blocks keep their exact place in the queue instead of jumping ahead un-animated.
 */
export interface RevealClock {
	last: number;
	inBeat: number;
	revealed: number;
	births?: Map<number, number>;
	instant?: boolean;
	/** Characters before this were already on screen when the clock started, and do not rise again. */
	settledUntil?: number;
}
export const newClock = (instant = false): RevealClock => ({
	last: 0,
	inBeat: 0,
	revealed: instant ? Number.POSITIVE_INFINITY : 0,
	births: new Map(),
	instant,
});

function isInstantClock(clock: RevealClock): boolean {
	return Boolean(clock.instant || clock.revealed === Number.POSITIVE_INFINITY);
}

/** Reserves or reads a beat timestamp on `clock` for non-text visual blocks (code fences, rules, formulas, SIUI). */
export function reserveBeat(clock: RevealClock, at: number, advance = false): number {
	const now = performance.now();
	if (isInstantClock(clock)) return now - SETTLE_MS - 1;
	const births = (clock.births ??= new Map());
	const existing = births.get(at);
	if (existing !== undefined) return existing;
	let when: number;
	if (advance && clock.last > 0) {
		when = Math.max(now, clock.last + BLOCK_WAIT_MS);
		clock.last = when;
		clock.inBeat = 1;
	} else {
		when = Math.max(now, clock.last);
	}
	births.set(at, when);
	clock.revealed = Math.max(clock.revealed, at + 1);
	return when;
}

function firstBirthIn(clock: RevealClock, from: number, to?: number): number | undefined {
	const births = clock.births;
	if (!births?.size) return undefined;
	const direct = births.get(from);
	if (direct !== undefined) return direct;
	let earliest: number | undefined;
	const limit = to ?? Number.POSITIVE_INFINITY;
	for (const [pos, when] of births) {
		if (pos >= from && pos < limit && (earliest === undefined || when < earliest)) earliest = when;
	}
	return earliest;
}

/**
 * Keeps a block/marker (such as `<li>` bullets, code blocks, quotes, tables, or SIUI groups) hidden via `display: none`
 * until its own beat on `clock` arrives, while keeping children mounted so their words schedule beats in document order.
 */
export function ClockGate({
	as = "div",
	clock,
	at,
	end,
	live = false,
	reserve = false,
	advance = false,
	className,
	title,
	children,
}: {
	as?: "div" | "span" | "li" | "blockquote" | "hr" | "tr" | "code";
	clock: RevealClock;
	at: number;
	end?: number;
	live?: boolean;
	reserve?: boolean;
	advance?: boolean;
	className?: string;
	title?: string;
	children?: ReactNode;
}) {
	const instant = isInstantClock(clock);
	const reservedWhen = reserve ? reserveBeat(clock, at, advance) : undefined;
	const [shown, setShown] = useState(() => instant || (reservedWhen !== undefined && reservedWhen <= performance.now() + 4));

	useLayoutEffect(() => {
		if (shown) return;
		if (isInstantClock(clock)) { setShown(true); return; }
		const when = reservedWhen ?? firstBirthIn(clock, at, end) ?? (!live ? Math.max(performance.now(), clock.last) : undefined);
		if (when === undefined) return;
		const wait = when - performance.now();
		if (wait <= 4) {
			setShown(true);
			return;
		}
		const timer = setTimeout(() => setShown(true), Math.max(0, wait));
		return () => clearTimeout(timer);
	});

	const style: CSSProperties | undefined = shown ? undefined : { display: "none" };
	// Coming into view starts its entrance (styles.css); a reopened conversation just shows.
	const rise = instant ? undefined : "";
	if (as === "hr") return createElement("hr", { className, style, "data-rise": rise });
	return createElement(as, { className, title, style, "data-rise": rise }, children);
}

/**
 * While `live`, the last word is held back: it may still grow ("pay" → "payments") and must rise only once.
 * `offset` is where this text starts in the reply, for the shared `clock`.
 */
export function AnimatedText({ text, live = false, clock, offset = 0 }: { text: string; live?: boolean; clock?: RevealClock; offset?: number }) {
	// Only the end of a growing text is split again: a long stream must not cost more with every word.
	const split = useRef<{ text: string; all: string[] }>({ text: "", all: [] });
	if (split.current.text !== text) {
		const known = split.current, tail = known.all[known.all.length - 1] ?? "", kept = known.text.length - tail.length;
		split.current = text.startsWith(known.text) && known.all.length
			? { text, all: [...known.all.slice(0, -1), ...segments(text.slice(kept))] }
			: { text, all: segments(text) };
	}
	const all = split.current.all;
	const parts = live ? all.slice(0, -1) : all;
	const born = useRef<number[]>([]);
	const delays = useRef<number[]>([]);
	const own = useRef<RevealClock | null>(null);
	const beatClock = clock ?? (own.current ??= newClock());
	const [, tick] = useState(0);
	const now = performance.now();
	// Text already there when this mounts outside a stream (a reopened conversation) is shown as it is.
	if (!born.current.length && !live && parts.length && !clock) {
		for (let i = 0; i < parts.length; i++) {
			born.current.push(now - SETTLE_MS - 1);
			delays.current.push(0);
		}
	}
	const births = (beatClock.births ??= new Map());
	const instant = isInstantClock(beatClock);
	let at = offset + parts.slice(0, born.current.length).join("").length;
	for (let i = born.current.length; i < parts.length; i++) {
		const part = parts[i]!;
		let when: number | undefined;
		let delay = 0;
		if (instant) {
			when = now - SETTLE_MS - 1;
		} else {
			for (let p = at; p < at + part.length; p++) {
				const existing = births.get(p);
				if (existing !== undefined) { when = existing; break; }
			}
			if (when !== undefined) {
				// Re-parsed mid-flight word: preserve its remaining arc without restarting or skipping.
				if (when < now - 16 && now - when < SETTLE_MS) delay = Math.round(when - now);
			} else if (beatClock.settledUntil !== undefined && at < beatClock.settledUntil) {
				when = now - SETTLE_MS - 1;
			} else if (!part.trim() || !WORDLIKE.test(part)) {
				when = Math.max(now, beatClock.last);
			} else {
				const { size, gap } = beat(beatClock.last - now);
				if (beatClock.last >= now && beatClock.inBeat < size) { when = beatClock.last; beatClock.inBeat++; }
				else { when = Math.max(now, beatClock.last + gap); beatClock.inBeat = 1; }
				beatClock.last = when;
			}
			for (let p = at; p < at + part.length; p++) {
				if (!births.has(p)) births.set(p, when);
			}
		}
		at += part.length;
		beatClock.revealed = Math.max(beatClock.revealed, at);
		born.current.push(when);
		delays.current.push(delay);
	}
	if (born.current.length > parts.length) {
		born.current.length = parts.length;
		delays.current.length = parts.length;
	}

	// Words whose rise has finished merge back into plain text, so a long reply is not thousands of spans.
	let settled = 0;
	while (settled < parts.length && born.current[settled]! + SETTLE_MS < now) settled++;
	// Only words whose beat has come are drawn; the next beat draws again.
	let shown = settled;
	while (shown < parts.length && born.current[shown]! <= now + 4) shown++;
	const next = born.current[shown];
	useEffect(() => {
		if (next === undefined) return;
		const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, next - performance.now()));
		return () => clearTimeout(timer);
	}, [next, shown]);
	const final = born.current[parts.length - 1];
	useEffect(() => {
		if (final === undefined) return;
		const wait = final + SETTLE_MS - performance.now();
		if (wait <= 0) return;
		const timer = setTimeout(() => tick((n) => n + 1), wait + 20);
		return () => clearTimeout(timer);
	}, [final, parts.length]);

	return (
		<>
			{settled ? parts.slice(0, settled).join("") : null}
			{parts.slice(settled, shown).map((part, i) => {
				const index = settled + i;
				if (!part.trim()) return part;
				const delay = delays.current[index] ?? 0;
				return <span key={index} className="tok" style={delay < 0 ? { animationDelay: `${delay}ms` } : undefined}>{part}</span>;
			})}
		</>
	);
}

/** One digit: the old one rolls up and away while the new one rolls up into place. */
function Digit({ value }: { value: string }) {
	const [shown, setShown] = useState({ now: value, before: null as string | null, turn: 0 });
	if (shown.now !== value) setShown({ now: value, before: shown.now, turn: shown.turn + 1 });
	return (
		<span className="digit">
			{shown.before !== null ? <span key={`out${shown.turn}`} className="digit-out" aria-hidden="true">{shown.before}</span> : null}
			<span key={`in${shown.turn}`} className={shown.turn ? "digit-in" : undefined}>{shown.now}</span>
		</span>
	);
}

export function RollingNumber({ value }: { value: number }) {
	return <RollingText text={String(value)} />;
}

/** Any short text whose characters change in place, such as an amount: each changed character rolls. */
export function RollingText({ text }: { text: string }) {
	return (
		<span className="rolling" aria-label={text}>
			{[...text].map((digit, i) => <Digit key={text.length - i} value={digit} />)}
		</span>
	);
}

export function useSeconds(since: number, live: boolean, until?: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!live) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [live]);
	return Math.max(0, Math.round(((until ?? now) - since) / 1000));
}

/** How long things take to leave; styles.css plays the matching exit animations in this time. */
export const LEAVE_MS = 160;

/** `shown` stays true for `ms` after `open` turns false, with `leaving` set, so the exit can play. */
export function useLeaving(open: boolean, ms = LEAVE_MS): { shown: boolean; leaving: boolean } {
	const [state, setState] = useState({ open, leaving: false });
	if (state.open !== open) setState({ open, leaving: !open });
	useEffect(() => {
		if (!state.leaving) return;
		const timer = setTimeout(() => setState((current) => current.open ? current : { open: false, leaving: false }), ms);
		return () => clearTimeout(timer);
	}, [state.leaving, ms]);
	return { shown: open || state.leaving, leaving: !open && state.leaving };
}

/** How long a Reveal takes to shut; styles.css plays it. */
export const REVEAL_OUT_MS = 220;

/** Past this height, opening interpolates layout every frame and the page drops frames, so it only fades. */
const REVEAL_HEAVY_PX = 160;

/** A part that grows open and shuts again (styles.css .reveal), instead of appearing and vanishing. `pace` is how long that open takes, when it should not use the default. */
export function Reveal({ open, children, ms = REVEAL_OUT_MS, pace }: { open: boolean; children: ReactNode; ms?: number; pace?: number }) {
	const { shown, leaving } = useLeaving(open, ms);
	const inner = useRef<HTMLDivElement>(null);
	const [heavy, setHeavy] = useState(false);
	const [settled, setSettled] = useState(false);
	useLayoutEffect(() => {
		if (!shown || !inner.current) return;
		setHeavy(inner.current.scrollHeight > REVEAL_HEAVY_PX);
	}, [shown]);
	useEffect(() => {
		if (!shown || leaving) { setSettled(false); return; }
		const timer = setTimeout(() => setSettled(true), pace ?? (heavy ? 160 : 340));
		return () => clearTimeout(timer);
	}, [shown, leaving, pace, heavy]);
	if (!shown) return null;
	const className = ["reveal", heavy ? "reveal-heavy" : "", settled ? "reveal-settled" : ""].filter(Boolean).join(" ");
	return <div className={className} style={pace ? { animationDuration: `${pace}ms` } : undefined} data-leaving={leaving || undefined}><div className="reveal-inner" ref={inner}>{children}</div></div>;
}

/** The list as it is, plus items just removed, kept in their old place with `leaving` until they have animated out. */
export function useLeavingList<T>(items: T[], key: (item: T) => string, ms = LEAVE_MS): Array<{ item: T; leaving: boolean }> {
	const gone = useRef(new Map<string, { item: T; index: number }>());
	const before = useRef<T[]>(items);
	const [, tick] = useState(0);
	const now = new Set(items.map(key));
	before.current.forEach((item, index) => { const k = key(item); if (!now.has(k) && !gone.current.has(k)) gone.current.set(k, { item, index }); });
	for (const k of now) gone.current.delete(k);
	before.current = items;
	const leavingKeys = [...gone.current.keys()].join("\n");
	useEffect(() => {
		if (!leavingKeys) return;
		const timer = setTimeout(() => { gone.current.clear(); tick((n) => n + 1); }, ms);
		return () => clearTimeout(timer);
	}, [leavingKeys, ms]);
	const out = items.map((item) => ({ item, leaving: false }));
	for (const { item, index } of [...gone.current.values()].sort((a, b) => a.index - b.index)) out.splice(Math.min(index, out.length), 0, { item, leaving: true });
	return out;
}

/**
 * A status that changes in place ("正在思考" to "思考了 3 秒"): the old one leaves upward and the new one rises
 * in, both with a little motion blur. `id` names the state; the content may change within a state without a swap.
 */
export function Swap({ id, children }: { id: string; children: ReactNode }) {
	const [state, setState] = useState({ id, before: null as ReactNode, turn: 0 });
	const last = useRef<ReactNode>(children);
	if (state.id !== id) setState({ id, before: last.current, turn: state.turn + 1 });
	last.current = children;
	useEffect(() => {
		if (state.before === null) return;
		const timer = setTimeout(() => setState((current) => current.before === null ? current : { ...current, before: null }), 240);
		return () => clearTimeout(timer);
	}, [state.turn, state.before !== null]);
	return (
		<span className="swap">
			{state.before !== null ? <span key={`out${state.turn}`} className="swap-out" aria-hidden="true">{state.before}</span> : null}
			<span key={`in${state.turn}`} className={state.turn ? "swap-in" : "swap-now"}>{children}</span>
		</span>
	);
}
