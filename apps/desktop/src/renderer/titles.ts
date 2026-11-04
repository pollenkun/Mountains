/**
 * The line on a new conversation: one of the user's own, a different one each time. Other languages get their own
 * wording; a line that is English in Chinese stays English everywhere.
 */
const TITLES: Record<"zh" | "en", readonly string[]> = {
	zh: ["我们应该构建什么？", "开始吧！", "你在想什么？", "Once Upon a Token…", "来做点什么，就看你了！", "有什么新想法？"],
	en: ["What should we build?", "Let's begin!", "What's on your mind?", "Once Upon a Token…", "Make something. It's up to you!", "Any new ideas?"],
};

const KEY = "mountains.title.last";

export function pickTitle(language: string, random = Math.random): string {
	const list = TITLES[language.toLowerCase().startsWith("zh") ? "zh" : "en"];
	let last = -1;
	try { last = Number(localStorage.getItem(KEY) ?? -1); } catch { /* no storage: a repeat is harmless */ }
	let index = Math.floor(random() * list.length);
	if (index === last) index = (index + 1) % list.length;
	try { localStorage.setItem(KEY, String(index)); } catch { /* as above */ }
	return list[index]!;
}
