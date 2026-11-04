/** The state a SIUI reply starts with, worked out from its tags (no page needed). */
import { evaluate, interpolate, type Value } from "./expr.ts";
import { PLAIN, type UiNode } from "./parse.ts";

const KNOWN = new Set(["scene", "box", "key", "big", "stat", "note", "progress", "chart", "steps", "step", "row", "grid", "card", "tabs", "tab", "slider", "input", "toggle", "select", "button", "var"]);

/** An attribute that may be written as `300`, `"300"` or `{300}`. */
const bare = (value: string | undefined) => value?.replace(/^\{|\}$/g, "");
const asValue = (value: string): Value => value !== "" && Number.isFinite(Number(value)) ? Number(value) : value;

/** The starting value of every control and variable in a reply. A variable only buttons set starts at 0. */
export function defaults(nodes: UiNode[]): Record<string, Value> {
	const out: Record<string, Value> = {}, hidden: string[] = [], made: [string, string][] = [];
	const visit = (n: UiNode) => {
		const name = n.attrs.name, start = bare(n.attrs.value);
		if (name) {
			if (n.name === "slider") out[name] = Number(start ?? n.attrs.min ?? 0);
			else if (n.name === "toggle") out[name] = start === "on" || start === "true" || n.attrs.checked !== undefined;
			else if (n.name === "select") out[name] = start ?? n.attrs.options?.split("|")[0] ?? "";
			else if (n.name === "input") out[name] = start ?? "";
			else if (n.name === "var") { out[name] = asValue(start ?? "0"); if (typeof out[name] === "string") made.push([name, out[name] as string]); }
		}
		for (const set of n.action?.matchAll(/^set\s+([\p{L}_][\p{L}\p{N}_]*)\s*=/gmu) ?? []) hidden.push(set[1]!);
		n.children.forEach(visit);
	};
	nodes.forEach(visit);
	for (const name of hidden) if (!(name in out)) out[name] = 0;
	Object.defineProperty(out, DERIVED, { value: made, enumerable: false });
	return out;
}

const DERIVED = Symbol("derived");

/** Variables whose value is a formula of others, worked out from the state as it stands; a plain word stays a word. */
export function withDerived(start: Record<string, Value>, changed: Record<string, Value>): Record<string, Value> {
	const vars = { ...start, ...changed };
	const formulas = (start as unknown as Record<symbol, [string, string][]>)[DERIVED] ?? [];
	// A formula may lean on one written after it: go round until each has had the others' results.
	for (let round = 0; round <= formulas.length; round++) {
		for (const [name, formula] of formulas) {
			if (name in changed) continue;
			try { vars[name] = evaluate(formula.replace(/^\{|\}$/g, ""), vars); } catch { /* a word, or waiting for another */ }
		}
	}
	return vars;
}

/** What `style` may say. Nothing that moves a thing out of its reply, covers the page or loads anything. */
const STYLE_PROPERTIES = new Set(["color", "background", "background-color", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-decoration", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "gap", "border", "border-top", "border-bottom", "border-left", "border-right", "border-radius", "opacity", "width", "max-width", "min-width", "height", "min-height", "display", "flex", "flex-direction", "flex-wrap", "justify-content", "align-items", "grid-template-columns"]);
const BIGGEST_TEXT = 72;

export function styleOf(source: string | undefined, vars: Record<string, Value>): Record<string, string> | undefined {
	if (!source) return undefined;
	const out: Record<string, string> = {};
	for (const rule of interpolate(source, vars).text.split(";")) {
		const colon = rule.indexOf(":");
		if (colon < 0) continue;
		const name = rule.slice(0, colon).trim().toLowerCase(), value = rule.slice(colon + 1).trim();
		if (!STYLE_PROPERTIES.has(name) || !value || /url\(|expression|@|\\|fixed|sticky/i.test(value)) continue;
		const size = name === "font-size" ? /^([\d.]+)px$/.exec(value) : null;
		out[name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = size && Number(size[1]) > BIGGEST_TEXT ? `${BIGGEST_TEXT}px` : value;
	}
	return Object.keys(out).length ? out : undefined;
}

/** What cannot be drawn: tags it does not know, controls with no name, expressions that fail. For the reply's footer. */
export function problems(nodes: UiNode[]): string[] {
	const vars = withDerived(defaults(nodes), {}), out = new Set<string>();
	const check = (text: string | undefined) => { if (text) for (const error of interpolate(text, vars).errors) out.add(error); };
	const visit = (n: UiNode) => {
		if (n.name === "#text") check(n.text);
		else if (!KNOWN.has(n.name) && !PLAIN.has(n.name)) out.add(`<${n.name}> is not a SIUI tag`);
		if (["slider", "input", "toggle", "select"].includes(n.name) && !n.attrs.name) out.add(`<${n.name}> needs a name`);
		check(n.attrs.label);
		check(n.attrs.title);
		if (n.name === "tab") check(n.attrs.name);
		for (const line of n.data) check(line);
		n.children.forEach(visit);
	};
	nodes.forEach(visit);
	return [...out];
}
