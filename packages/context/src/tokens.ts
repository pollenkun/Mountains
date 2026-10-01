import { createHash } from "node:crypto";

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

export function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function chainHash(prev: string, segmentHash: string): string {
	return shortHash(prev + segmentHash);
}
