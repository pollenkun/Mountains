import assert from "node:assert/strict";
import { test } from "node:test";
import * as themes from "../src/index.ts";
import { contrast, MOUNTAINS_THEME, parseTheme, ThemeError, themeCss, themeWarnings } from "../src/index.ts";

const theme = (extra: Record<string, unknown>) => JSON.stringify({ format: "mountains-theme", version: 1, name: "Forest", ...extra });
const problems = (text: string) => { try { parseTheme(text); return []; } catch (error) { assert.ok(error instanceof ThemeError); return error.problems; } };

test("the Mountains theme round-trips and is readable in both modes", () => {
	assert.deepEqual(parseTheme(JSON.stringify(MOUNTAINS_THEME)), MOUNTAINS_THEME);
	assert.deepEqual(themeWarnings(MOUNTAINS_THEME), []);
	assert.equal(contrast("#000000", "#FFFFFF").toFixed(1), "21.0");
});

test("a theme may give one mode and a few fields; the rest come from the Mountains theme", () => {
	const parsed = parseTheme(theme({ dark: { background: "#0b1a12", text: "#e8f5ec" }, radius: { large: 24 }, fonts: { ui: "Inter, \"PingFang SC\", sans-serif" }, accent: "#5fd38d" }));
	assert.equal(parsed.dark.background, "#0B1A12");
	assert.equal(parsed.dark.panel, MOUNTAINS_THEME.dark.panel);
	assert.deepEqual(parsed.light, MOUNTAINS_THEME.light);
	assert.deepEqual(parsed.radius, { small: 8, medium: 12, large: 24 });
	const css = themeCss(parsed, "dark");
	assert.match(css, /^:root\{--background:#0B1A12;.*--text-secondary:#C3C9D8;.*--accent:#5FD38D;--font-ui:Inter, "PingFang SC", sans-serif;.*--radius-large:24px\}$/);
	assert.match(themeCss(parsed, "dark", "#ff00aa"), /--accent:#ff00aa/, "the user's accent wins");
});

test("nothing that loads files or runs code gets in, and every problem is reported at once", () => {
	for (const css of ["body{background:url(https://x.test/a.png)}", "@import 'https://x.test/a.css';", "@font-face{font-family:x}", "a{behavior:url(x.htc)}", "a{b:expression(alert(1))}", "</style><script>alert(1)</script>", "a{content:'\\75rl(x)'}", "a{background:image-set('a.png' 1x)}"]) {
		assert.ok(problems(theme({ dark: {}, css })).some(p => p.startsWith("css may not contain")), css);
	}
	const many = problems(theme({ name: "", dark: { background: "red", sparkle: "#fff" }, fonts: { ui: "url(x)" }, radius: { small: 99 }, script: "alert(1)" }));
	assert.deepEqual(many.map(p => p.split(" ")[0]), ["the", "name", "dark", "dark.background", "fonts.ui", "radius.small"]);
	assert.match(problems("{ not json")[0]!, /not valid JSON/);
	assert.match(problems(theme({}))[0]!, /dark, light or both/);
	assert.ok(parseTheme(theme({ light: {}, css: ".sidebar{opacity:.96}" })).css.includes("opacity"));
});

test("weak contrast is pointed out", () => {
	const pale = parseTheme(theme({ light: { text: "#BBBBBB" } }));
	assert.ok(themeWarnings(pale).some(w => w.startsWith("light: text on background")));
});

test("make-theme is not a bundled skill", () => {
	assert.equal("makeThemeSkill" in themes, false);
	assert.equal("MAKE_THEME_INSTRUCTIONS" in themes, false);
});
