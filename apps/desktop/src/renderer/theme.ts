/** Puts a theme's colours on the page, for the mode the system is in. CSP allows no style sheets of its own, so they go on the root element. */
export interface Looks { current: string | null; themes: { name: string; json: string }[] }

const VARIABLES: Record<string, string[]> = {
	background: ["--bg"], sidebar: ["--side"], panel: ["--panel", "--elevated"], selected: ["--sel"], border: ["--line"], text: ["--text"], textSecondary: ["--text2"],
	muted: ["--muted"], faint: ["--faint"], strong: ["--strong"], star: ["--star"], ring: ["--ring"], warning: ["--warn"], added: ["--add"], removed: ["--del"],
};

export function applyTheme(json: string | null): void {
	const root = document.documentElement.style;
	for (const names of Object.values(VARIABLES)) for (const name of names) root.removeProperty(name);
	root.removeProperty("--bg0");
	if (!json) return;
	const theme = JSON.parse(json) as { dark: Record<string, string>; light: Record<string, string> };
	const colors = theme[matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"];
	for (const [token, names] of Object.entries(VARIABLES)) for (const name of names) if (colors[token]) root.setProperty(name, colors[token]!);
	if (colors.background) root.setProperty("--bg0", `${colors.background}00`);
}
