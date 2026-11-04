import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The cursor path is plain JavaScript inside the macOS helper script. Run that same text here.
const source = readFileSync(new URL("../src/pointer-mac.ts", import.meta.url), "utf8");
const code = source.slice(source.indexOf("// --- cursor path: pure"), source.indexOf("// --- end cursor path ---"));
type Point = [number, number];
type Path = { points: Point[]; angles: number[]; sx: number[]; sy: number[]; arrive: number; scoot: boolean };
const { cursorPath, MOTION } = new Function(`${code}; return { cursorPath, MOTION };`)() as {
	cursorPath: (a: Point, b: Point, width: number, height: number, random: () => number) => Path;
	MOTION: { rate: number; closeEnough: number };
};
const steps = (points: Point[]) => points.slice(1).map((q, i) => Math.hypot(q[0] - points[i]![0], q[1] - points[i]![1]));

test("a long move arrives in about half a second, without jumps, and barely overshoots", () => {
	const a: Point = [100, 100], b: Point = [900, 600], dist = Math.hypot(800, 500);
	const path = cursorPath(a, b, 1440, 900, () => 0.3);
	assert.deepEqual(path.points.at(-1), b);
	assert.deepEqual(path.points[0], a, "it starts exactly where the cursor was");
	assert.ok(path.arrive > 0.3 && path.arrive < 0.6, `close enough to click at ${path.arrive} s`);
	const s = steps(path.points), change = s.slice(1).map((x, i) => Math.abs(x - s[i]!));
	assert.ok(Math.max(...s) * 2 < 100, `at most 100 points per 60 Hz frame, got ${Math.max(...s) * 2}`);
	assert.ok(Math.max(...change) < 7, `speed changes smoothly between samples, largest jump ${Math.max(...change)}`);
	const along = path.points.map(q => ((q[0] - b[0]) * 800 + (q[1] - b[1]) * 500) / dist);
	assert.ok(Math.max(...along) < dist * 0.03, "an overshoot stays under 3% of the distance");
	assert.ok(path.angles.every(x => Math.abs(x) <= 0.12) && path.angles.at(-1) === 0, "the lean is bounded and ends upright");
	assert.ok(path.sx.every(x => x >= 1 && x <= 1.1) && path.sx.at(-1) === 1, "a speed stretch stays small and ends at rest");
});

test("an arc near the screen edge bows inward and never leaves the screen", () => {
	for (const random of [() => 0, () => 0.99]) {
		const path = cursorPath([1380, 60], [1400, 840], 1440, 900, random);
		assert.equal(path.points.filter(([x, y]) => x < 0 || x > 1440 || y < 0 || y > 900).length, 0);
	}
});

test("a short move is a straight scoot that stretches along its way", () => {
	const a: Point = [300, 300], b: Point = [320, 310], path = cursorPath(a, b, 1440, 900, () => 0.5);
	assert.equal(path.scoot, true);
	const off = path.points.map(([x, y]) => Math.abs((x - a[0]) * 10 - (y - a[1]) * 20) / Math.hypot(20, 10));
	assert.ok(Math.max(...off) < 0.5, "it stays on the straight line");
	assert.ok(Math.max(...path.sx) > 1 && Math.max(...path.sx) <= 1.18 && path.sx.at(-1) === 1);
	assert.ok(path.arrive > 0 && path.arrive < 0.2);
});

test("every path ends exactly on its target and reaches it within the click distance", () => {
	for (const [a, b] of [[[0, 0], [1440, 900]], [[700, 450], [705, 452]], [[50, 850], [1300, 60]]] as [Point, Point][]) {
		const path = cursorPath(a, b, 1440, 900, () => 0.7);
		assert.deepEqual(path.points.at(-1), b);
		assert.ok(path.arrive > 0, "the click time is found");
		const at = path.points[Math.round(path.arrive * MOTION.rate)]!;
		assert.ok(Math.hypot(at[0] - b[0], at[1] - b[1]) < MOTION.closeEnough);
	}
});
