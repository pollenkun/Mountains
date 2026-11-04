/** The four-point star as a BGRA bitmap, so the menu bar needs no image file. Only alpha is set (a template image). */
export function starBitmap(px: number): Buffer {
	const data = Buffer.alloc(px * px * 4);
	// |x|^0.55 + |y|^0.55 <= 1 is a concave four-point star; 4x4 samples per pixel smooth its edges.
	const inside = (x: number, y: number) => Math.pow(Math.abs(x), 0.55) + Math.pow(Math.abs(y), 0.55) <= 1;
	for (let row = 0; row < px; row++) for (let col = 0; col < px; col++) {
		let hits = 0;
		for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
			const x = ((col + (sx + 0.5) / 4) / px) * 2 - 1, y = ((row + (sy + 0.5) / 4) / px) * 2 - 1;
			if (inside(x * 1.08, y * 1.08)) hits++;
		}
		data[(row * px + col) * 4 + 3] = Math.round((hits / 16) * 255);
	}
	return data;
}
