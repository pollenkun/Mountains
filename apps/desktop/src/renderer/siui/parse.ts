/**
 * Splits a reply into Markdown and SIUI (Super Intelligent UI) components. A line that starts with a known tag opens
 * a component written as short HTML, closed by its own tags whatever the lines and indents; everything else is
 * Markdown. Models know HTML by heart, so its habits are read too: `<input type=range>`, `<select>` with `<option>`,
 * `className`, `value={300}`. Replies from before this language used `::` lines, and those still draw.
 */
export interface UiNode {
	name: string;
	/** The words inside: a tag's text, or what a `::` line says. */
	text: string;
	attrs: Record<string, string>;
	/** Style words: green, huge, bold… */
	styles: string[];
	/** What a button does: `send "…"`, `set x = …`, `reset`. */
	action: string | null;
	children: UiNode[];
	/** A chart's `label: value` lines. */
	data: string[];
	/** Where it starts in the reply, so text that was already shown is not animated again. */
	offset: number;
	/** Still being written: the stream has not closed it yet. */
	open?: boolean;
}

export type Block = { kind: "md"; text: string; offset: number } | { kind: "ui"; node: UiNode };

const STYLE_WORDS = new Set(["green", "red", "yellow", "blue", "purple", "muted", "accent", "big", "huge", "giant", "small", "bold", "mono", "info", "warn", "success", "error", "done", "now"]);
const COMPONENT = /^(\s*)::([a-z]+)(?:\s+(.*))?$/;
const CONTROLS = new Set(["slider", "input", "toggle", "select"]);
const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** A `::` line, turned into what a tag would have said. */
function line_(name: string, rest: string, offset: number): UiNode {
	let text = rest.trim(), action: string | null = null, styles: string[] = [];
	const dot = text.lastIndexOf(" · ");
	if (dot >= 0) {
		const words = text.slice(dot + 3).trim().split(/\s+/);
		if (words.length && words.every((w) => STYLE_WORDS.has(w))) { styles = words; text = text.slice(0, dot).trim(); }
	}
	const arrow = text.indexOf(" -> ");
	if (arrow >= 0) { action = text.slice(arrow + 4).trim(); text = text.slice(0, arrow).trim(); }
	const made: UiNode = { name, text, attrs: {}, styles, action, children: [], data: [], offset };
	const words = text.split(/\s+/);
	const words1 = () => words.slice(1).join(" ");
	if (name === "stat") { made.attrs.label = words[0] ?? ""; made.text = words1(); }
	else if (name === "progress") { made.attrs.value = words[0] ?? "0"; made.attrs.label = words1(); made.text = ""; }
	else if (name === "chart") { made.attrs.type = words[0] ?? "bar"; made.attrs.title = words1(); made.text = ""; }
	else if (name === "grid") { made.attrs.cols = text; made.text = ""; }
	else if (name === "card") { made.attrs.title = text; made.text = ""; }
	else if (name === "tab") { made.attrs.name = text; made.text = ""; }
	else if (CONTROLS.has(name)) { Object.assign(made.attrs, controlAttrs(text)); made.text = ""; }
	if (made.text) made.children.push(textNode(made.text, offset));
	return made;
}

const textNode = (text: string, offset: number): UiNode => ({ name: "#text", text, attrs: {}, styles: [], action: null, children: [], data: [], offset });

/** A `::` control's arguments: the label, the variable (the word before its range, options or default), the rest. */
export function controlParts(text: string): { label: string; name: string; rest: string[] } | null {
	const words = text.match(/"[^"]*"|\S+/g) ?? [];
	const first = words.findIndex((w) => w.includes("..") || w.includes("|") || w.startsWith("="));
	const at = first > 0 ? first - 1 : words.length - 1;
	if (at < 0) return null;
	if (at >= 1 && NAME.test(words[at]!)) return { label: words.slice(0, at).join(" "), name: words[at]!, rest: words.slice(at + 1) };
	// A label run straight into the variable, as in 房价（万元）price.
	const joined = /^(.*[^\p{L}\p{N}_])([\p{L}_][\p{L}\p{N}_]*)$/u.exec(words[at]!);
	if (!joined) return null;
	return { label: [...words.slice(0, at), joined[1]!].join(" "), name: joined[2]!, rest: words.slice(at + 1) };
}

function controlAttrs(text: string): Record<string, string> {
	const parts = controlParts(text);
	if (!parts) return {};
	const out: Record<string, string> = { label: parts.label, name: parts.name };
	const unit: string[] = [];
	for (const word of parts.rest) {
		const range = /^(-?[\d.]+)\.\.(-?[\d.]+)$/.exec(word);
		if (range) { out.min = range[1]!; out.max = range[2]!; }
		else if (word.startsWith("=")) out.value = word.slice(1).replace(/^"|"$/g, "");
		else if (word.startsWith("step=")) out.step = word.slice(5);
		else if (word.includes("|")) out.options = word;
		else unit.push(word);
	}
	if (unit.length) out.unit = unit.join(" ");
	return out;
}

const COMPONENTS = new Set(["scene", "box", "key", "big", "stat", "note", "progress", "chart", "steps", "step", "row", "grid", "card", "tabs", "tab", "slider", "input", "toggle", "select", "button", "var"]);
/** Plain HTML a model reaches for: drawn as itself, with no behaviour of its own. */
export const PLAIN = new Set(["div", "section", "p", "span", "h1", "h2", "h3", "ul", "ol", "li", "b", "strong", "em", "small", "table", "thead", "tbody", "tr", "th", "td", "hr", "br"]);
const INSIDE = new Set(["option", "label"]);
const VOID = new Set(["slider", "input", "toggle", "var", "box", "key", "hr", "br"]);
const OPEN = /<([a-z][a-z0-9]*)((?:\s(?:"[^"]*"|'[^']*'|\{[^{}]*\}|[^>"'{])*)?)>/y;
const CLOSE = /<\/([a-z][a-z0-9]*)\s*>/y;
const ATTR = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[^{}]*\})|([^\s"'>]+)))?/g;
const BLOCK = new RegExp(`^\\s*<(${[...COMPONENTS, ...PLAIN].join("|")})(\\s|>|/)`);
/** A component with attributes means what it says even in the middle of a line; a bare `<slider>` in a sentence is a word. */
const ATTRIBUTED = new RegExp(`<(${[...COMPONENTS].join("|")})\\s+[a-z]+(=|\\s*/?>)`);
const STRAY_CLOSE = new RegExp(`</(${[...COMPONENTS].join("|")})>\\s*$`);
const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

/** Code examples are words, never controls. Keep offsets so a real tag later on the line still works. */
function outsideCode(line: string, live: boolean): string {
	const masked = line.split("");
	const ticks = /`+/g;
	let opener: RegExpExecArray | null;
	while ((opener = ticks.exec(line))) {
		let slashes = 0;
		for (let at = opener.index - 1; at >= 0 && line[at] === "\\"; at--) slashes++;
		if (slashes % 2) continue;
		const after = ticks.lastIndex;
		let closer: RegExpExecArray | null, end = -1;
		while ((closer = ticks.exec(line))) if (closer[0].length === opener[0].length) { end = ticks.lastIndex; break; }
		if (end < 0) {
			ticks.lastIndex = after;
			if (!live) continue;
			end = line.length;
		}
		masked.fill(" ", opener.index, end);
	}
	return masked.join("");
}

/** `a=1; b=a+1` as the lines a button's or a scene's action runs. */
export const setAction = (written: string) => written.split(/;\s*/).filter(Boolean).map((one) => `set ${one}`).join("\n");

function element(name: string, written: string, offset: number): UiNode {
	const attrs: Record<string, string> = {};
	// Words of a label or title left unquoted run up to the next attribute: label=总进度 {done}/4 class=green.
	const source = written.replace(/\b(title|label)=(?!["'])(.*?)(?=\s+[\w-]+=|\s*\/?\s*$)/g, (_, key: string, value: string) => `${key}="${value.trim()}"`);
	for (const m of source.matchAll(ATTR)) attrs[m[1]!] = decode(m[2] ?? m[3] ?? m[4] ?? m[5] ?? "true");
	let kind = name;
	if (kind === "input" && attrs.type === "range") kind = "slider";
	if (kind === "input" && attrs.type === "checkbox") kind = "toggle";
	const words = `${attrs.class ?? ""} ${attrs.classname ?? attrs.className ?? ""} ${attrs.type ?? ""} ${attrs.status ?? ""}`.split(/\s+/);
	let action: string | null = null;
	if (attrs.send !== undefined) action = `send "${attrs.send}"`;
	else if (attrs.set !== undefined) action = setAction(attrs.set);
	else if (attrs.reset !== undefined) action = "reset";
	return { name: kind, text: "", attrs, styles: words.filter((w) => STYLE_WORDS.has(w)), action, children: [], data: [], offset };
}

/** Gathers a closed node's words; a chart's are its data, a select's options are its choices. */
function finish(node: UiNode): void {
	node.text = node.children.filter((c) => c.name === "#text").map((c) => c.text).join(" ").trim();
	if (node.name === "chart") { node.data = node.text.split("\n").map((l) => l.trim()).filter(Boolean); node.children = []; node.text = ""; }
	if (node.name === "select" && node.children.length) {
		node.attrs.options ??= node.children.filter((c) => c.name === "option").map((c) => c.attrs.value ?? c.text).join("|");
		node.children = [];
	}
	if (node.name === "tab") node.attrs.name ??= node.attrs.title ?? node.attrs.label ?? "";
}

/**
 * Reads tags from \`start\` until they all close. While the reply is streaming, what is open draws with the
 * children it has so far, and a tag still being written waits.
 */
function readTags(source: string, start: number, live: boolean): { nodes: UiNode[]; end: number } {
	const roots: UiNode[] = [], stack: UiNode[] = [];
	let at = start;
	const add = (node: UiNode) => { const parent = stack[stack.length - 1]; if (parent) parent.children.push(node); else roots.push(node); };
	// After the last tag closes, more tags on the same line, or on the next, belong to the same run.
	const goesOn = () => {
		const rest = /^\s*/.exec(source.slice(at))![0].length;
		if (!BLOCK.test(source.slice(at + rest, at + rest + 40))) return false;
		at += rest;
		return true;
	};
	const text = (from: number, to: number) => {
		const words = decode(source.slice(from, to));
		if (words.trim()) add(textNode(words.trim(), from));
	};
	while (at < source.length) {
		CLOSE.lastIndex = OPEN.lastIndex = at;
		const close = CLOSE.exec(source);
		if (close) {
			at = CLOSE.lastIndex;
			const index = stack.map((n) => n.name).lastIndexOf(close[1]!);
			if (index >= 0) for (const node of stack.splice(index).reverse()) finish(node);
			if (!stack.length && !goesOn()) break;
			continue;
		}
		const open = OPEN.exec(source);
		if (open && (COMPONENTS.has(open[1]!) || PLAIN.has(open[1]!) || INSIDE.has(open[1]!))) {
			const node = element(open[1]!, open[2] ?? "", at);
			at = OPEN.lastIndex;
			if (node.name === "label" && !/\/\s*$/.test(open[2] ?? "")) continue;
			add(node);
			const leaf = VOID.has(open[1]!) || VOID.has(node.name) || /\/\s*$/.test(open[2] ?? "") || (node.name === "progress" && !/^\s*<\/progress/.test(source.slice(at))) || (node.name === "select" && node.attrs.options !== undefined);
			if (leaf) {
				finish(node);
				// `<slider ...></slider>`: a closing tag for what needs none.
				const stray = /^\s*<\/[a-z]+\s*>/.exec(source.slice(at));
				if (stray && stray[0].includes(`</${open[1]!}`)) at += stray[0].length;
				if (!stack.length && !goesOn()) break;
				continue;
			}
			stack.push(node);
			continue;
		}
		const next = source.indexOf("<", at + 1);
		// A tag still arriving at the end of a stream waits; a lone < in text is text.
		if (live && source[at] === "<" && next < 0 && /^<\/?[a-z]*[^>]*$/.test(source.slice(at))) { at = source.length; break; }
		const stop = next < 0 ? source.length : next;
		text(at, stop);
		at = stop;
	}
	if (live) {
		const last = stack[stack.length - 1]?.children.at(-1);
		// An expression still being written is not shown half done.
		if (last?.name === "#text" && last.text.lastIndexOf("{") > last.text.lastIndexOf("}")) last.text = last.text.slice(0, last.text.lastIndexOf("{")).trimEnd();
	}
	const open = stack.length > 0;
	for (const node of stack.reverse()) finish(node);
	if (open) roots[roots.length - 1]!.open = true;
	return { nodes: roots, end: at };
}

/**
 * While the reply is still streaming, the last line is held back until it is finished, so a component never
 * appears half written.
 */
export function parse(source: string, live = false): Block[] {
	const text = live ? tableHeldBack(!source.endsWith("\n") ? source.slice(0, source.lastIndexOf("\n") + 1) + heldBack(source.slice(source.lastIndexOf("\n") + 1)) : source) : source;
	const lines = text.split("\n");
	const blocks: Block[] = [];
	let markdown: string[] = [], mdOffset = 0, offset = 0;
	// The open components by indent, outermost first.
	let stack: { indent: number; node: UiNode }[] = [];
	const flush = () => {
		// A closing tag with nothing open, left at the end of a sentence, is not something to read.
		const words = markdown.map((l) => l.replace(STRAY_CLOSE, ""));
		if (words.some((l) => l.trim())) blocks.push({ kind: "md", text: words.join("\n"), offset: mdOffset });
		markdown = [];
	};
	let fence: string | null = null;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!, lineOffset = offset;
		offset += line.length + 1;
		// Inside a Markdown code block a `::` line is just code.
		const opener = /^\s*(```|~~~)/.exec(line)?.[1];
		if (fence || opener) {
			if (fence && opener === fence) fence = null;
			else if (!fence && opener) fence = opener;
			stack = [];
			if (!markdown.length) mdOffset = lineOffset;
			markdown.push(line);
			continue;
		}
		// Words of a closing tag that has nothing to close, on a line of their own.
		if (/^\s*<\/(slider|input|toggle|var)\s*>\s*$/.test(line)) continue;
		const syntax = outsideCode(line, live);
		const tagAt = BLOCK.test(syntax) ? syntax.search(/\S/) : syntax.search(ATTRIBUTED);
		if (tagAt >= 0) {
			if (tagAt > 0) { if (!markdown.length) mdOffset = lineOffset; markdown.push(line.slice(0, tagAt)); }
			flush();
			stack = [];
			const { nodes, end } = readTags(text, lineOffset + tagAt, live);
			for (const n of nodes) blocks.push({ kind: "ui", node: n });
			// Go on from the line after the one the tags ended on; words after them on that line are Markdown.
			while (offset <= end && index + 1 < lines.length) offset += lines[++index]!.length + 1;
			const rest = text.slice(end, Math.max(end, offset - 1));
			if (rest.trim()) { mdOffset = end; markdown.push(rest); }
			continue;
		}
		// A bare `::` is a component never named: nothing to draw.
		if (line.trim() === "::") continue;
		const m = COMPONENT.exec(line);
		const indent = (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "  ").length;
		if (m) {
			flush();
			const n = line_(m[2]!, m[3] ?? "", lineOffset);
			while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
			const parent = stack[stack.length - 1];
			if (parent) parent.node.children.push(n);
			else blocks.push({ kind: "ui", node: n });
			stack.push({ indent, node: n });
			continue;
		}
		// An indented plain line under a component is its data; a blank line inside a group is skipped.
		const owner = stack[stack.length - 1];
		if (owner && line.trim() && indent > owner.indent) { owner.node.data.push(line.trim()); continue; }
		if (owner && !line.trim()) continue;
		stack = [];
		if (!markdown.length) mdOffset = lineOffset;
		markdown.push(line);
	}
	flush();
	return blocks;
}

/** An unfinished last line: a component waits for its end, a table row for its line break; Markdown text shows as it comes. */
function heldBack(line: string): string {
	return /^\s*(::|\|)/.test(line) || /^\s*:$/.test(line) || /^\s*<[a-z/][^>]*$/.test(line) && !BLOCK.test(`${line} `) ? "" : line;
}

/** A line of pipes with none before it may be a table's head: until the next line says so, it is not text to show. */
function tableHeldBack(text: string): string {
	const lines = text.split("\n"), last = lines.length - 2;
	const pipes = (line: string | undefined) => line !== undefined && /^\s*\|/.test(line);
	if (text.endsWith("\n") && pipes(lines[last]) && !pipes(lines[last - 1])) return lines.slice(0, last).join("\n") + (last ? "\n" : "");
	return text;
}
