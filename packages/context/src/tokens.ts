import { createHash } from "node:crypto";
import type { Message } from "@mountains/protocol";

/**
 * 本地 token 估算（只是估算；供应商 usage 才是请求级事实，两者分开存）。
 * 系数取自 DeepSeek 官方说明：1 个英文字符约 0.3 token，1 个中文字符约 0.6 token
 * （https://api-docs.deepseek.com/quick_start/token_usage/ ，2026-09-25 查询）。
 */
export function estimateTokens(text: string): number {
	let ascii = 0;
	let other = 0;
	for (const ch of text) {
		if (ch.charCodeAt(0) < 128) ascii++;
		else other++;
	}
	return Math.ceil(ascii * 0.3 + other * 0.6);
}

/** Images count by area (about 750 pixels per token), not by the size of their base64 text. */
export function imageTokens(width: number, height: number): number {
	return Math.ceil(Math.max(1, width) * Math.max(1, height) / 750);
}

/** A message's size for the model: its text, plus its images by area. */
export function messageTokens(m: Message): number {
	if (m.role !== "tool" || !m.images?.length) return estimateTokens(JSON.stringify(m));
	const { images, ...text } = m;
	return estimateTokens(JSON.stringify({ ...text, images: images.map(i => ({ mimeType: i.mimeType, width: i.width, height: i.height })) })) +
		images.reduce((n, i) => n + imageTokens(i.width, i.height), 0);
}

export function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function chainHash(prev: string, segmentHash: string): string {
	return shortHash(prev + segmentHash);
}
