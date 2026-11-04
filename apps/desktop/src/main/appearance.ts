/**
 * The model can change how Mountains looks: colours for each mode, shown as a preview that stays only if the user keeps
 * it. Colours only, and readable ones: a change that would leave text or the approval card hard to read is refused
 * with the reason, so a theme cannot hide what the user must see.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, parseTheme, THEME_TOKENS, type Theme, type ThemeColors, type ThemeToken } from "@mountains/themes";
import type { RunHooks } from "@mountains/cli/run-session";

/** The page's own colours (styles.css), which a change starts from. */
const BASE: Record<"dark" | "light", ThemeColors> = {
	dark: { background: "#000000", sidebar: "#0A0A0A", panel: "#1A1A1A", selected: "#202020", border: "#2E2E2E", text: "#EDEDED", textSecondary: "#C9C9C9", muted: "#979797", faint: "#787878", strong: "#FFFFFF", star: "#FFFFFF", ring: "#979797", warning: "#F2C14E", added: "#7FD8C6", removed: "#FF9C9C" },
	light: { background: "#FFFFFF", sidebar: "#F5F5F5", panel: "#FFFFFF", selected: "#EEEEEE", border: "#E0E0E0", text: "#181818", textSecondary: "#414141", muted: "#636363", faint: "#828282", strong: "#181818", star: "#737373", ring: "#AEAEAE", warning: "#B7791F", added: "#1F8A74", removed: "#C2453D" },
};

const PAIRS: [ThemeToken, ThemeToken, number, string][] = [
	["text", "background", 4.5, "text on the page"],
	["text", "panel", 4.5, "text on cards and the approval card"],
	["strong", "panel", 4.5, "headings on cards"],
	["strong", "background", 4.5, "the primary button"],
	["muted", "background", 3, "hints"],
];

function themeFrom(args: Record<string, unknown>): Theme {
	const part = (mode: "dark" | "light") => {
		const given = args[mode] && typeof args[mode] === "object" ? args[mode] as Record<string, unknown> : {};
		return Object.fromEntries(Object.entries(given).filter(([key, value]) => key in THEME_TOKENS && typeof value === "string"));
	};
	const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 40) : "Custom";
	const theme = {
		format: "mountains-theme", version: 1, name,
		dark: { ...BASE.dark, ...part("dark") }, light: { ...BASE.light, ...part("light") },
		fonts: { ui: "\"Google Sans Flex\", \"PingFang SC\", \"Microsoft YaHei\", -apple-system, sans-serif", mono: "\"Google Sans Code\", ui-monospace, Menlo, Consolas, monospace, \"PingFang SC\", \"Microsoft YaHei\"" },
		radius: { small: 8, medium: 12, large: 18 }, css: "",
	};
	return parseTheme(JSON.stringify(theme));
}

/** Why a theme cannot be used, in words for the model; nothing when it reads well in both modes. */
export function unreadable(theme: Theme): string[] {
	const out: string[] = [];
	for (const mode of ["dark", "light"] as const) {
		for (const [fore, back, least, what] of PAIRS) {
			const ratio = contrast(theme[mode][fore], theme[mode][back]);
			if (ratio < least) out.push(`${mode}: ${what} (${fore} on ${back}) is ${ratio.toFixed(1)}:1, needs ${least}:1`);
		}
	}
	return out;
}

/** A theme from the page, checked again here: it decides what is written to disk. */
export function checkedTheme(json: string): Theme {
	const theme = parseTheme(json);
	const problems = unreadable(theme);
	if (problems.length) throw new Error(problems.join("; "));
	return theme;
}

export function appearanceTool(): NonNullable<RunHooks["tools"]>[number] {
	return {
		name: "set_appearance", logicalName: "desktop.set_appearance", readOnly: true,
		description: `Part of SIUI (Super Intelligent UI): change how Mountains itself looks when the user asks. Give #RRGGBB colours per mode, only the ones that change: ${Object.keys(THEME_TOKENS).join(", ")}. It shows as a preview; the user keeps, undoes, or saves it as a theme.`,
		parameters: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, dark: { type: "object" }, light: { type: "object" } } },
		async execute(args) {
			try {
				const theme = themeFrom(args), problems = unreadable(theme);
				if (problems.length) return { ok: false, modelContent: `Refused, hard to read: ${problems.join("; ")}`, summary: "外观对比度不够", details: { error: problems.join("; ") } };
				return { ok: true, modelContent: "Previewing. The user decides whether to keep it.", summary: "预览外观", details: { theme: JSON.stringify(theme) } };
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return { ok: false, modelContent: `Refused: ${reason}`, summary: "外观无效", details: { error: reason } };
			}
		},
	};
}

export function savedThemes(dataDir: string): { name: string; json: string }[] {
	const dir = join(dataDir, "themes");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((file) => file.endsWith(".json")).flatMap((file) => {
		try { const json = readFileSync(join(dir, file), "utf8"); return [{ name: parseTheme(json).name, json }]; }
		catch { return []; }
	});
}

export function saveTheme(dataDir: string, json: string, name: string): string {
	const theme = { ...checkedTheme(json), name: name.trim().slice(0, 40) };
	const text = JSON.stringify(theme), dir = join(dataDir, "themes");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, `${theme.name.replace(/[^\p{L}\p{N}_-]+/gu, "-")}.json`), text, { mode: 0o600 });
	return text;
}
