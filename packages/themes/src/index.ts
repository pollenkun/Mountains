/**
 * A Mountains theme is a JSON file: colours for the light and dark modes, fonts, corner radii and a
 * little extra CSS. It holds no scripts and loads nothing from elsewhere, so importing one is safe.
 */
export const THEME_TOKENS = {
	background: "Main conversation area",
	sidebar: "Sidebar and title bar",
	panel: "Input box, cards and popovers",
	selected: "Selected row and your own messages",
	border: "Dividers and outlines",
	text: "Body text",
	textSecondary: "Secondary text such as tool steps",
	muted: "Hints and descriptions",
	faint: "Least important text: times, counts",
	strong: "Headings and the primary button",
	star: "The four-pointed star when idle",
	ring: "The ring around the star while a tool runs",
	warning: "Warnings, such as a cache that may have gone cold",
	added: "Added lines in a diff",
	removed: "Removed lines in a diff",
} as const;

export type ThemeToken = keyof typeof THEME_TOKENS;
export type ThemeColors = Record<ThemeToken, string>;
export type ThemeMode = "light" | "dark";

export interface Theme {
	format: "mountains-theme";
	version: 1;
	name: string;
	author?: string;
	description?: string;
	/** Suggested accent; the accent the user picks in Appearance wins. */
	accent?: string;
	dark: ThemeColors;
	light: ThemeColors;
	fonts: { ui: string; mono: string };
	radius: { small: number; medium: number; large: number };
	css: string;
}

export const MOUNTAINS_THEME: Theme = {
	format: "mountains-theme",
	version: 1,
	name: "Mountains",
	dark: {
		background: "#0D111C", sidebar: "#0A0D16", panel: "#141A28", selected: "#1A2030", border: "#262E42",
		text: "#E9EDF6", textSecondary: "#C3C9D8", muted: "#8E97AD", faint: "#6F7890", strong: "#FFFFFF",
		star: "#FFFFFF", ring: "#8E97AD", warning: "#F2C14E", added: "#7FD8C6", removed: "#FF9C9C",
	},
	light: {
		background: "#FFFFFF", sidebar: "#F4F5F8", panel: "#FFFFFF", selected: "#ECEEF3", border: "#DCE0E8",
		text: "#121826", textSecondary: "#3A4252", muted: "#5B6376", faint: "#7A8294", strong: "#121826",
		star: "#6B7385", ring: "#A6AEBF", warning: "#B7791F", added: "#1F8A74", removed: "#C2453D",
	},
	fonts: {
		ui: "\"Google Sans Flex\", \"PingFang SC\", \"Microsoft YaHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
		mono: "\"Google Sans Code\", \"IBM Plex Mono\", ui-monospace, Menlo, Consolas, monospace, \"PingFang SC\", \"Microsoft YaHei\"",
	},
	radius: { small: 8, medium: 12, large: 18 },
	css: "",
};

export const THEME_LIMITS = { fileBytes: 64 * 1024, cssBytes: 20 * 1024, name: 40, text: 200, radius: 32 } as const;

/** Thrown with every problem found, so one fix-up pass is enough. */
export class ThemeError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(`主题文件无效：\n${problems.map(p => `- ${p}`).join("\n")}`);
		this.problems = problems;
	}
}

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT = /^[\p{L}\p{N} ,'"._-]+$/u;
// Anything that could load a resource or run code; backslashes could spell any of these in escapes.
const CSS_FORBIDDEN: [RegExp, string][] = [
	[/url\s*\(/i, "url()"], [/image-set\s*\(/i, "image-set()"], [/@import/i, "@import"], [/@font-face/i, "@font-face"], [/@namespace/i, "@namespace"],
	[/expression\s*\(/i, "expression()"], [/javascript:/i, "javascript:"], [/behavior\s*:/i, "behavior"], [/-moz-binding/i, "-moz-binding"],
	[/<\/?\s*[a-z]/i, "HTML tags"], [/\\/, "backslash escapes"],
];

/** Validate a theme file; modes and fields it leaves out come from the Mountains theme. */
export function parseTheme(text: string): Theme {
	if (Buffer.byteLength(text, "utf8") > THEME_LIMITS.fileBytes) throw new ThemeError([`file is larger than ${THEME_LIMITS.fileBytes / 1024} KB`]);
	let raw: unknown;
	try { raw = JSON.parse(text.replace(/^﻿/, "")); } catch (error) { throw new ThemeError([`not valid JSON: ${(error as Error).message}`]); }
	const problems: string[] = [];
	const record = (value: unknown, where: string, keys: readonly string[]): Record<string, unknown> | null => {
		if (!value || typeof value !== "object" || Array.isArray(value)) { problems.push(`${where} must be an object`); return null; }
		for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push(`${where} has an unknown field "${key}"`);
		return value as Record<string, unknown>;
	};
	const root = record(raw, "the theme", ["$schema", "format", "version", "name", "author", "description", "accent", "dark", "light", "fonts", "radius", "css"]);
	if (!root) throw new ThemeError(problems);
	if (root.format !== "mountains-theme") problems.push('format must be "mountains-theme"');
	if (root.version !== 1) problems.push("version must be 1");
	const text_ = (value: unknown, where: string, max: number, required = false): string | undefined => {
		if (value === undefined && !required) return undefined;
		if (typeof value !== "string" || !value.trim() || value.length > max) { problems.push(`${where} must be text of 1–${max} characters`); return undefined; }
		return value.trim();
	};
	const color = (value: unknown, where: string): string | undefined => {
		if (typeof value !== "string" || !COLOR.test(value)) { problems.push(`${where} must be a hex colour such as #1A2030 (got ${JSON.stringify(value)})`); return undefined; }
		return value.toUpperCase();
	};
	const name = text_(root.name, "name", THEME_LIMITS.name, true);
	const author = text_(root.author, "author", THEME_LIMITS.text);
	const description = text_(root.description, "description", THEME_LIMITS.text);
	const accent = root.accent === undefined ? undefined : color(root.accent, "accent");
	if (root.dark === undefined && root.light === undefined) problems.push("give colours for dark, light or both");
	const mode = (key: ThemeMode): ThemeColors => {
		const colors = { ...MOUNTAINS_THEME[key] };
		if (root[key] === undefined) return colors;
		const given = record(root[key], key, Object.keys(THEME_TOKENS));
		if (given) for (const [token, value] of Object.entries(given)) {
			if (!(token in THEME_TOKENS)) continue;
			const parsed = color(value, `${key}.${token}`);
			if (parsed) colors[token as ThemeToken] = parsed;
		}
		return colors;
	};
	const dark = mode("dark"), light = mode("light");
	const fonts = { ...MOUNTAINS_THEME.fonts };
	if (root.fonts !== undefined) {
		const given = record(root.fonts, "fonts", ["ui", "mono"]);
		for (const key of ["ui", "mono"] as const) {
			const value = given?.[key];
			if (value === undefined) continue;
			if (typeof value !== "string" || !value.trim() || value.length > THEME_LIMITS.text || !FONT.test(value)) problems.push(`fonts.${key} must list installed font names, e.g. "Inter, sans-serif"`);
			else fonts[key] = value.trim();
		}
	}
	const radius = { ...MOUNTAINS_THEME.radius };
	if (root.radius !== undefined) {
		const given = record(root.radius, "radius", ["small", "medium", "large"]);
		for (const key of ["small", "medium", "large"] as const) {
			const value = given?.[key];
			if (value === undefined) continue;
			if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > THEME_LIMITS.radius) problems.push(`radius.${key} must be a whole number of pixels from 0 to ${THEME_LIMITS.radius}`);
			else radius[key] = value as number;
		}
	}
	let css = "";
	if (root.css !== undefined) {
		if (typeof root.css !== "string") problems.push("css must be text");
		else if (Buffer.byteLength(root.css, "utf8") > THEME_LIMITS.cssBytes) problems.push(`css is larger than ${THEME_LIMITS.cssBytes / 1024} KB`);
		else {
			for (const [pattern, label] of CSS_FORBIDDEN) if (pattern.test(root.css)) problems.push(`css may not contain ${label}: a theme cannot load files or run code`);
			css = root.css;
		}
	}
	if (problems.length) throw new ThemeError(problems);
	return { format: "mountains-theme", version: 1, name: name!, ...(author ? { author } : {}), ...(description ? { description } : {}), ...(accent ? { accent } : {}), dark, light, fonts, radius, css };
}

const kebab = (s: string) => s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

/** CSS variables for one mode, then the theme's own CSS; `accent` is the user's choice in Appearance. */
export function themeCss(theme: Theme, mode: ThemeMode, accent?: string): string {
	const colors = theme[mode];
	const vars = [
		...Object.entries(colors).map(([token, value]) => `--${kebab(token)}:${value}`),
		`--accent:${accent && COLOR.test(accent) ? accent : theme.accent ?? colors.strong}`,
		`--font-ui:${theme.fonts.ui}`, `--font-mono:${theme.fonts.mono}`,
		`--radius-small:${theme.radius.small}px`, `--radius-medium:${theme.radius.medium}px`, `--radius-large:${theme.radius.large}px`,
	];
	return `:root{${vars.join(";")}}${theme.css ? `\n${theme.css}` : ""}`;
}

/** WCAG contrast ratio of two hex colours (alpha ignored). */
export function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const h = hex.length === 4 ? [...hex.slice(1)].map(c => c + c).join("") : hex.slice(1, 7);
		const [r, g, bl] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
	};
	const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
	return (x! + 0.05) / (y! + 0.05);
}

/** Readability problems worth fixing before the user imports the theme. */
export function themeWarnings(theme: Theme): string[] {
	const out: string[] = [];
	for (const mode of ["dark", "light"] as const) {
		const c = theme[mode];
		for (const [token, min] of [["text", 4.5], ["textSecondary", 4.5], ["muted", 3], ["strong", 4.5]] as const) {
			for (const surface of ["background", "panel"] as const) {
				const ratio = contrast(c[token], c[surface]);
				if (ratio < min) out.push(`${mode}: ${token} on ${surface} has contrast ${ratio.toFixed(1)}:1, below ${min}:1`);
			}
		}
	}
	return out;
}
