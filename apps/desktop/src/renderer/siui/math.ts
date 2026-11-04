/**
 * The TeX models write in their replies, as a small tree the page can draw: sub- and superscripts, fractions, roots,
 * Greek letters, arrows and operators. No DOM here, so tests can drive it. A command it does not know stays visible.
 */
export type MathNode =
	| { kind: "text"; text: string; italic?: boolean }
	| { kind: "sub" | "sup" | "group" | "sqrt"; children: MathNode[] }
	| { kind: "frac"; over: MathNode[]; under: MathNode[] };

const SYMBOLS: Record<string, string> = {
	alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
	Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
	to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⇒", iff: "⇔", mapsto: "↦", uparrow: "↑", downarrow: "↓",
	times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", ast: "∗", circ: "∘", oplus: "⊕", otimes: "⊗", star: "⋆", bullet: "•",
	le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
	in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨", wedge: "∧", vee: "∨",
	infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", oint: "∮", angle: "∠", perp: "⊥", parallel: "∥", degree: "°", prime: "′", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
	ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", vert: "|", mid: "|",
	quad: " ", qquad: "  ", ",": " ", ":": " ", ";": " ", " ": " ", "!": "", "%": "%", "#": "#", "$": "$", "&": "&", "_": "_", "{": "{", "}": "}", "|": "‖", "\\": " ",
};
/** Named functions, set upright. */
const NAMES = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "lim", "max", "min", "sup", "inf", "det", "dim", "ker", "gcd", "deg", "arg", "mod", "bmod"]);
/** Commands that only wrap their argument. */
const WRAPPERS = new Set(["mathbf", "mathrm", "mathit", "mathsf", "mathtt", "mathcal", "mathbb", "boldsymbol", "bm", "operatorname", "overline", "underline", "hat", "bar", "vec", "tilde", "dot"]);
/** Commands drawn as nothing: sizing and alignment. */
const SILENT = new Set(["left", "right", "big", "Big", "bigg", "Bigg", "displaystyle", "textstyle", "nonumber", "limits"]);

export function parseMath(tex: string): MathNode[] {
	let at = 0;
	const push = (list: MathNode[], node: MathNode) => {
		const last = list[list.length - 1];
		if (node.kind === "text" && last?.kind === "text" && !!last.italic === !!node.italic) last.text += node.text;
		else list.push(node);
	};
	const atom = (): MathNode[] => {
		while (tex[at] === " ") at++;
		if (tex[at] === "{") { at++; return until("}"); }
		const list: MathNode[] = [];
		one(list);
		return list;
	};
	function one(list: MathNode[]): void {
		const ch = tex[at]!;
		if (ch === "\\") {
			const name = /^\\([A-Za-z]+|.)/s.exec(tex.slice(at))?.[1] ?? "";
			at += name.length + 1;
			if (SILENT.has(name)) return;
			if (name === "frac" || name === "dfrac" || name === "tfrac") { list.push({ kind: "frac", over: atom(), under: atom() }); return; }
			if (name === "sqrt") { list.push({ kind: "sqrt", children: atom() }); return; }
			if (name === "text" || name === "textbf" || name === "mbox") {
				if (tex[at] === "{") {
					const end = tex.indexOf("}", at), stop = end < 0 ? tex.length : end;
					push(list, { kind: "text", text: tex.slice(at + 1, stop) });
					at = stop + 1;
				}
				return;
			}
			if (WRAPPERS.has(name)) { list.push({ kind: "group", children: atom() }); return; }
			if (NAMES.has(name)) { push(list, { kind: "text", text: name }); return; }
			push(list, { kind: "text", text: SYMBOLS[name] ?? `\\${name}` });
			return;
		}
		if (ch === "_" || ch === "^") { at++; list.push({ kind: ch === "_" ? "sub" : "sup", children: atom() }); return; }
		if (ch === "{") { at++; list.push({ kind: "group", children: until("}") }); return; }
		at++;
		if (ch === "~") { push(list, { kind: "text", text: " " }); return; }
		if (ch === "\n") return;
		push(list, /[A-Za-z]/.test(ch) ? { kind: "text", text: ch, italic: true } : { kind: "text", text: ch === "-" ? "−" : ch });
	}
	function until(close: string | null): MathNode[] {
		const list: MathNode[] = [];
		while (at < tex.length) {
			if (close && tex[at] === close) { at++; break; }
			one(list);
		}
		return list;
	}
	return until(null);
}
