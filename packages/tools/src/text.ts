/** Clip by UTF-16 units without separating a valid surrogate pair. */
export function truncateUtf16(text: string, maxCodeUnits: number): string {
	let end = Math.max(0, Math.min(text.length, Math.floor(maxCodeUnits)));
	if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
	return text.slice(0, end);
}

/** Keep a suffix by UTF-16 units without separating a valid surrogate pair. */
export function truncateUtf16Tail(text: string, maxCodeUnits: number): string {
	let start = Math.max(0, text.length - Math.max(0, Math.floor(maxCodeUnits)));
	if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start++;
	return text.slice(start);
}
