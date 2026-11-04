/**
 * The working state of a run, as light in the upper half of the window. Three lights drift and walk a ring of hues
 * while a run goes on, then fade out gradually in place when it ends. Motion is transform and opacity on the
 * compositor (a colour change is a crossfade between two layers), so it holds while the page streams.
 */
import { useEffect, useRef } from "react";

const OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
/** Where each light sits while resting and while working: centre (fraction of the window), scale, opacity. */
const IDLE: [number, number, number, number][] = [[0.18, -0.08, 0.94, 0], [0.5, -0.14, 0.9, 0], [0.84, -0.06, 0.94, 0]];
const WORK: [number, number, number, number][] = [[0.18, -0.02, 1, 1], [0.5, -0.08, 0.96, 1], [0.84, 0, 1, 1]];
const placeOf = ([fx, fy, scale, opacity]: [number, number, number, number]) => ({
	transform: `translate(${((fx / 0.64 - 0.5) * 100).toFixed(2)}%, ${((fy - 0.5) * 100).toFixed(2)}%) scale(${scale})`,
	opacity,
});

const LOOPS: [Keyframe[], number][] = [
	[[{ transform: "translate(0,0) scale(1)" }, { transform: "translate(24%, 10%) scale(1.2)" }], 3200],
	[[{ transform: "translate(0,0) scale(1)" }, { transform: "translate(-20%, 12%) scale(0.86)" }], 3800],
	[[{ transform: "translate(0,0) scale(1)" }, { transform: "translate(-26%, 8%) scale(1.18)" }], 2800],
];
/** Working walks a chosen ring of hues; the colour wheel's greens look sickly on this ground. */
const RING = [212, 250, 285, 320, 345, 18, 36, 190];

interface Light { orb: HTMLElement; move: HTMLElement; cores: HTMLElement[]; front: number }

const quiet = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A colour change is a crossfade to the other layer, which the compositor can do on its own. */
function recolor(light: Light, color: string, ms: number): void {
	const next = light.cores[1 - light.front]!, previous = light.cores[light.front]!;
	next.style.setProperty("--c", color);
	for (const [element, to] of [[next, 1], [previous, 0]] as const) {
		const from = getComputedStyle(element).opacity;
		for (const running of element.getAnimations()) running.cancel();
		element.animate([{ opacity: from }, { opacity: to }], { duration: quiet() ? 1 : ms, easing: "ease", fill: "forwards" });
	}
	light.front = 1 - light.front;
}

/** Moves from wherever it is now, never from where it was meant to be: the eye sees no jump. */
function glide(element: HTMLElement, to: Keyframe, ms: number, easing: string): Animation {
	const style = getComputedStyle(element);
	const from = { transform: style.transform === "none" ? "translate(0,0)" : style.transform, opacity: style.opacity };
	for (const running of element.getAnimations()) running.cancel();
	return element.animate([from, quiet() ? { transform: from.transform, opacity: to.opacity ?? 0 } : to], { duration: quiet() ? 200 : ms, easing, fill: "forwards" });
}

export function Field({ working }: { working: boolean }) {
	const root = useRef<HTMLDivElement>(null);
	const lights = useRef<Light[]>([]);
	const previous = useRef(false);
	const current = useRef(working);
	const step = useRef(0);
	current.current = working;
	useEffect(() => {
		lights.current = [...root.current!.querySelectorAll<HTMLElement>(".orb")].map((orb) => ({ orb, move: orb.firstElementChild as HTMLElement, cores: [...orb.querySelectorAll<HTMLElement>(".core")], front: 0 }));
		for (const [index, light] of lights.current.entries()) light.orb.animate([placeOf(IDLE[index]!)], { duration: 1, fill: "forwards" });
		return () => {
			for (const light of lights.current) {
				for (const target of [light.orb, light.move, ...light.cores]) {
					for (const running of target.getAnimations()) running.cancel();
				}
			}
		};
	}, []);
	useEffect(() => {
		const from = previous.current, to = working;
		if (from === to) return;
		previous.current = to;
		if (!to) {
			for (const [index, light] of lights.current.entries()) {
				const fade = glide(light.orb, placeOf(IDLE[index]!), 1600, "ease");
				fade.finished.then(() => {
					if (current.current) return;
					for (const running of light.move.getAnimations()) running.cancel();
				}).catch(() => { /* a new run interrupted the fade-out */ });
			}
			return;
		}
		const visible = lights.current.some((light) => Number(getComputedStyle(light.orb).opacity) > 0.02);
		for (const [index, light] of lights.current.entries()) {
			if (!visible) light.orb.animate([quiet() ? { ...placeOf(WORK[index]!), opacity: 0 } : placeOf(IDLE[index]!)], { duration: 1, fill: "forwards" });
			glide(light.orb, placeOf(WORK[index]!), 800, OUT);
			if (!quiet() && light.move.getAnimations().length === 0) {
				const [frames, ms] = LOOPS[index]!;
				light.move.animate(frames, { duration: ms, easing: "ease-in-out", direction: "alternate", iterations: Infinity });
			}
		}
		const paint = (ms: number) => lights.current.forEach((light, index) => recolor(light, `hsl(${RING[(step.current + index * 3) % RING.length]} 74% 60% / .82)`, ms));
		if (visible) step.current = (step.current + 1) % RING.length;
		paint(visible ? 900 : 1);
		if (quiet()) return;
		const timer = setInterval(() => { step.current = (step.current + 1) % RING.length; paint(1300); }, 1400);
		return () => clearInterval(timer);
	}, [working]);
	return (
		<div className="field" ref={root} aria-hidden="true">
			{[0, 1, 2].map((index) => <div key={index} className="orb"><div className="move"><div className="core" /><div className="core" /></div></div>)}
		</div>
	);
}
