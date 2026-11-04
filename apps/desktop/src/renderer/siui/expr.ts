/**
 * SIUI expressions: the `{…}` in a component line. Numbers, strings, variables, + - * / % **, comparisons,
 * && || !, `a ? b : c`, and a few named functions. Nothing else can be reached: no properties, no calls but
 * these, no code. An expression that does not parse or names an unknown variable evaluates to an error.
 */
export type Value = number | string | boolean;
export type Vars = Readonly<Record<string, Value>>;

const FUNCTIONS: Record<string, (...args: number[]) => Value> = {
	round: (x, d = 0) => { const f = 10 ** Math.max(0, Math.min(10, d)); return Math.round(x * f) / f; },
	fixed: (x, d = 0) => x.toFixed(Math.max(0, Math.min(10, d))),
	pct: (x, d = 0) => `${(x * 100).toFixed(Math.max(0, Math.min(10, d)))}%`,
	min: (...xs) => Math.min(...xs),
	max: (...xs) => Math.max(...xs),
	abs: (x) => Math.abs(x),
	floor: (x) => Math.floor(x),
	ceil: (x) => Math.ceil(x),
	sqrt: (x) => Math.sqrt(x),
	/** A whole number from a to b, for a game's dice; meant for a button's `set`, where it runs once. */
	rand: (a = 1, b = 6) => a + Math.floor(Math.random() * (b - a + 1)),
};

type Token = { kind: "num"; value: number } | { kind: "str"; value: string } | { kind: "name"; value: string } | { kind: "op"; value: string };

function tokens(source: string): Token[] {
	const out: Token[] = [];
	const re = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|"([^"]*)"|'([^']*)'|([\p{L}_][\p{L}\p{N}_]*)|(\*\*|==|!=|<=|>=|&&|\|\||[-+*/%()<>!?:,]))/uy;
	let at = 0;
	while (at < source.length) {
		if (!source.slice(at).trim()) break;
		re.lastIndex = at;
		const m = re.exec(source);
		if (!m) throw new Error(`unexpected ${JSON.stringify(source.slice(at).trim()[0])}`);
		at = re.lastIndex;
		if (m[1] !== undefined) out.push({ kind: "num", value: Number(m[1]) });
		else if (m[2] !== undefined || m[3] !== undefined) out.push({ kind: "str", value: m[2] ?? m[3]! });
		else if (m[4] !== undefined) out.push({ kind: "name", value: m[4] });
		else out.push({ kind: "op", value: m[5]! });
	}
	return out;
}

const BINARY: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "**": 7 };

function num(v: Value): number {
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	const n = Number(v);
	if (Number.isNaN(n)) throw new Error(`${JSON.stringify(v)} is not a number`);
	return n;
}

/** Evaluates one expression against the variables; throws with a short reason when it cannot. */
export function evaluate(source: string, vars: Vars): Value {
	const list = tokens(source);
	let i = 0;
	const peek = () => list[i];
	const take = (op?: string) => {
		const t = list[i];
		if (!t || (op !== undefined && !(t.kind === "op" && t.value === op))) throw new Error(op ? `expected ${op}` : "unexpected end");
		i++;
		return t;
	};
	const primary = (): Value => {
		const t = take();
		if (t.kind === "num" || t.kind === "str") return t.value;
		if (t.kind === "op" && t.value === "(") { const v = expression(); take(")"); return v; }
		if (t.kind === "op" && (t.value === "-" || t.value === "+")) { const v = num(unary()); return t.value === "-" ? -v : v; }
		if (t.kind === "op" && t.value === "!") return !truthy(unary());
		if (t.kind === "name") {
			if (t.value === "true" || t.value === "false") return t.value === "true";
			const next = peek();
			if (next?.kind === "op" && next.value === "(") {
				const fn = FUNCTIONS[t.value];
				if (!fn) throw new Error(`unknown function ${t.value}`);
				take("(");
				const args: number[] = [];
				if (!(peek()?.kind === "op" && peek()!.value === ")")) {
					do args.push(num(expression())); while (peek()?.kind === "op" && peek()!.value === "," && take(","));
				}
				take(")");
				return fn(...args);
			}
			if (!Object.hasOwn(vars, t.value)) throw new Error(`unknown ${t.value}`);
			return vars[t.value]!;
		}
		throw new Error(`unexpected ${t.value}`);
	};
	const unary = (): Value => primary();
	const binary = (min: number): Value => {
		let left = unary();
		for (;;) {
			const t = peek();
			if (t?.kind !== "op") return left;
			const p = BINARY[t.value];
			if (p === undefined || p < min) return left;
			i++;
			const right = binary(t.value === "**" ? p : p + 1);
			left = apply(t.value, left, right);
		}
	};
	const expression = (): Value => {
		const condition = binary(1);
		if (!(peek()?.kind === "op" && peek()!.value === "?")) return condition;
		take("?");
		const yes = expression();
		take(":");
		const no = expression();
		return truthy(condition) ? yes : no;
	};
	const value = expression();
	if (i < list.length) throw new Error(`unexpected ${String(list[i]!.value)}`);
	return value;
}

function truthy(v: Value): boolean { return typeof v === "string" ? v.length > 0 : Boolean(v); }

function apply(op: string, a: Value, b: Value): Value {
	switch (op) {
		case "+": return typeof a === "string" || typeof b === "string" ? `${show(a)}${show(b)}` : num(a) + num(b);
		case "-": return num(a) - num(b);
		case "*": return num(a) * num(b);
		case "/": return num(a) / num(b);
		case "%": return num(a) % num(b);
		case "**": return num(a) ** num(b);
		case "==": return a === b || (typeof a !== "string" || typeof b !== "string") && num(a) === num(b);
		case "!=": return !(a === b || (typeof a !== "string" || typeof b !== "string") && num(a) === num(b));
		case "<": return num(a) < num(b);
		case ">": return num(a) > num(b);
		case "<=": return num(a) <= num(b);
		case ">=": return num(a) >= num(b);
		case "&&": return truthy(a) && truthy(b);
		case "||": return truthy(a) || truthy(b);
	}
	throw new Error(`unknown ${op}`);
}

/** A value as text; numbers lose float noise, so 0.1 + 0.2 shows 0.3. */
export function show(v: Value): string {
	if (typeof v === "number") return Number.isFinite(v) ? String(Number(v.toPrecision(12))) : "—";
	return String(v);
}

/** Replaces each `{expression}` in a text; one that fails shows as ⚠ with its reason, so the model can see it. */
export function interpolate(text: string, vars: Vars): { text: string; errors: string[] } {
	const errors: string[] = [];
	const out = text.replace(/\{([^{}]+)\}/g, (_, source: string) => {
		try { return show(evaluate(source, vars)); }
		catch (error) { errors.push(`{${source}}: ${error instanceof Error ? error.message : String(error)}`); return "⚠"; }
	});
	return { text: out, errors };
}
