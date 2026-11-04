import assert from "node:assert/strict";
import { test } from "node:test";
import { starBitmap } from "../src/main/star.ts";

test("the menu-bar star is solid at the centre and the tips, empty in the corners, and symmetric", () => {
	const px = 32, data = starBitmap(px);
	const alpha = (x: number, y: number) => data[(y * px + x) * 4 + 3]!;
	assert.equal(alpha(16, 16), 255);
	assert.ok(alpha(16, 4) > 0 && alpha(4, 16) > 0, "tips reach close to the edges");
	assert.equal(alpha(3, 3), 0);
	assert.equal(alpha(28, 28), 0);
	for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) assert.equal(alpha(x, y), alpha(px - 1 - x, y));
	let ink = 0;
	for (let i = 3; i < data.length; i += 4) ink += data[i]! / 255;
	assert.ok(ink / (px * px) > 0.15 && ink / (px * px) < 0.45, `coverage ${ink / (px * px)}`);
});
