import { deflateSync, inflateSync } from "node:zlib";
import type { Rect } from "./backend.ts";

/** Minimal PNG encoder for RGBA pixels (no dependency beyond zlib). */
const CRC = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
	return t;
})();
function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
	if (rgba.length !== width * height * 4) throw new Error("像素数据长度和尺寸不符");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Decode the 8-bit, non-interlaced RGB or RGBA PNGs that screencapture and sips write. */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
	if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("不是 PNG 图片");
	let width = 0, height = 0, channels = 0;
	const data: Buffer[] = [];
	for (let at = 8; at < png.length;) {
		const length = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8), body = png.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0); height = body.readUInt32BE(4);
			channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
			if (body[8] !== 8 || !channels || body[12] !== 0) throw new Error("不支持这种 PNG 格式");
		} else if (type === "IDAT") data.push(body);
		else if (type === "IEND") break;
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(data)), stride = width * channels, rgba = Buffer.alloc(width * height * 4);
	let prev = Buffer.alloc(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!, line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? line[i - channels]! : 0, b = prev[i]!, c = i >= channels ? prev[i - channels]! : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
			line[i] = (line[i]! + add) & 0xff;
		}
		for (let x = 0; x < width; x++) {
			line.copy(rgba, (y * width + x) * 4, x * channels, x * channels + 3);
			rgba[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3]! : 255;
		}
		prev = line;
	}
	return { width, height, rgba };
}

/** 3×5 glyphs for element numbers ("e" and digits), drawn at 2× scale. */
const GLYPHS: Record<string, string[]> = {
	e: ["000", "111", "101", "110", "011"], 0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"],
	2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "111", "001", "111"], 4: ["101", "101", "111", "001", "001"],
	5: ["111", "100", "111", "001", "111"], 6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "010", "010", "010"],
	8: ["111", "101", "111", "101", "111"], 9: ["111", "101", "111", "001", "111"],
};
const SCALE = 2;

export interface Box { rect: Rect; label: string }

/** Draw an outlined box and a filled label for each element, in place. */
export function drawBoxes(pixels: Buffer, width: number, height: number, boxes: Box[]): void {
	const set = (x: number, y: number, r: number, g: number, b: number) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const i = (Math.floor(y) * width + Math.floor(x)) * 4;
		pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
	};
	const color: [number, number, number] = [230, 40, 120];
	for (const { rect, label } of boxes) {
		const x0 = Math.round(rect.x), y0 = Math.round(rect.y), x1 = Math.round(rect.x + rect.width), y1 = Math.round(rect.y + rect.height);
		for (let t = 0; t < 2; t++) {
			for (let x = x0; x <= x1; x++) { set(x, y0 + t, ...color); set(x, y1 - t, ...color); }
			for (let y = y0; y <= y1; y++) { set(x0 + t, y, ...color); set(x1 - t, y, ...color); }
		}
		const glyphs = [...label].map(ch => GLYPHS[ch]).filter((g): g is string[] => Boolean(g));
		const tagW = glyphs.length * 4 * SCALE + 2, tagH = 5 * SCALE + 4;
		const tx = Math.max(0, Math.min(x0, width - tagW)), ty = y0 - tagH >= 0 ? y0 - tagH : y0;
		for (let y = 0; y < tagH; y++) for (let x = 0; x < tagW; x++) set(tx + x, ty + y, ...color);
		glyphs.forEach((g, gi) => g.forEach((row, ry) => [...row].forEach((bit, rx) => {
			if (bit !== "1") return;
			for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) set(tx + 2 + gi * 4 * SCALE + rx * SCALE + sx, ty + 2 + ry * SCALE + sy, 255, 255, 255);
		})));
	}
}

/**
 * Why the window no longer shows what an earlier image of it showed, or null when it still does: the same size,
 * the same content around each target point (image pixels), and most of the rest unchanged. A blinking caret,
 * a clock or a spinner elsewhere does not count; a scroll, a new layout or a change under a target does.
 */
export function changedSince(before: { width: number; height: number; pixels: Buffer }, now: { width: number; height: number; pixels: Buffer }, targets: [number, number][]): string | null {
	if (before.width !== now.width || before.height !== now.height) return "the window's image changed size";
	const differs = (i: number) => Math.max(Math.abs(before.pixels[i]! - now.pixels[i]!), Math.abs(before.pixels[i + 1]! - now.pixels[i + 1]!), Math.abs(before.pixels[i + 2]! - now.pixels[i + 2]!)) > 24;
	const share = (x0: number, y0: number, x1: number, y1: number, step: number) => {
		let changed = 0, all = 0;
		for (let y = Math.max(0, y0); y < Math.min(now.height, y1); y += step) for (let x = Math.max(0, x0); x < Math.min(now.width, x1); x += step) { all++; if (differs((y * now.width + x) * 4)) changed++; }
		return all ? changed / all : 0;
	};
	const r = Math.max(12, Math.round(now.width * 0.02));
	for (const [x, y] of targets) if (share(Math.round(x) - r, Math.round(y) - r, Math.round(x) + r, Math.round(y) + r, 1) > 0.15) return "what is at the target changed";
	if (share(0, 0, now.width, now.height, 4) > 0.35) return "much of the window changed";
	return null;
}
