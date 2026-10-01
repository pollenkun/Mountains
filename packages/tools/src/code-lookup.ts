import { spawn } from "node:child_process";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.ts";
import { ToolError } from "./workspace.ts";

/**
 * code_lookup：一次调用给出一个 Python 符号的定义源码、它调用的函数在哪里定义（一跳）、以及谁调用它。
 * 目的：把"搜到对外名字 → 猜导出位置 → 再搜 → 读包装层 → 再读内部实现"这串导航交给程序，
 * 模型只做"哪个分支是原因"的判断。关系全部来自 Python 自带的 ast（标注 ast），不是运行时调用图；
 * 动态调用、getattr、跨语言调用不会出现，结果写明截断与解析失败，不把"没找到"当成"不存在"。
 */

const PYTHON = process.env.MOUNTAINS_PYTHON ?? "python3";

const SCRIPT = String.raw`
import ast, builtins, hashlib, json, os, sys
BUILTINS = set(dir(builtins))
q = json.loads(sys.stdin.read())
root = q["root"]; target = q["symbol"]; max_defs = q["maxDefinitions"]; max_refs = q["maxReferences"]
max_lines = q["maxDefinitionLines"]; budget = q["maxChars"]
SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", "env", "build", "dist", ".tox", ".eggs", ".mypy_cache", ".pytest_cache"}
parts = target.split(".")
name = parts[-1]
prefix = parts[:-1]
files = []
for dp, dns, fns in os.walk(root):
    dns[:] = sorted(d for d in dns if d not in SKIP and not d.startswith("."))
    for fn in sorted(fns):
        if fn.endswith(".py"):
            files.append(os.path.join(dp, fn))
    if len(files) > 4000:
        break
defs = {}          # name -> [(rel, start, end, kind, qual)]
aliases = {}       # (rel, name) -> (module, orig)
calls = []         # (callee_name, rel, line, enclosing_qual, kind, base)  kind: name | attr；base: 属性调用左边的名字（self、模块别名等）
sources = {}
failed = []
def rel_of(p):
    return os.path.relpath(p, root).replace(os.sep, "/")
def module_of(rel):
    m = rel[:-3].split("/")
    if m[-1] == "__init__":
        m = m[:-1]
    return m
class V(ast.NodeVisitor):
    def __init__(self, rel):
        self.rel = rel; self.stack = []
    def _def(self, node, kind):
        qual = ".".join(self.stack + [node.name])
        defs.setdefault(node.name, []).append((self.rel, node.lineno, getattr(node, "end_lineno", node.lineno), kind, qual))
        self.stack.append(node.name); self.generic_visit(node); self.stack.pop()
    def visit_FunctionDef(self, n): self._def(n, "def")
    def visit_AsyncFunctionDef(self, n): self._def(n, "async def")
    def visit_ClassDef(self, n): self._def(n, "class")
    def visit_Assign(self, n):
        if not self.stack:
            for t in n.targets:
                if isinstance(t, ast.Name):
                    defs.setdefault(t.id, []).append((self.rel, n.lineno, getattr(n, "end_lineno", n.lineno), "assign", t.id))
        self.generic_visit(n)
    def visit_ImportFrom(self, n):
        mod = n.module or ""
        if n.level:
            base = module_of(self.rel)
            if not self.rel.endswith("__init__.py"):
                base = base[:-1]
            base = base[: len(base) - (n.level - 1)] if n.level > 1 else base
            mod = ".".join(base + ([mod] if mod else []))
        for a in n.names:
            aliases[(self.rel, a.asname or a.name)] = (mod, a.name)
    def visit_Call(self, n):
        f = n.func
        if isinstance(f, ast.Name):
            calls.append((f.id, self.rel, n.lineno, ".".join(self.stack) or "<module>", "name", None))
        elif isinstance(f, ast.Attribute):
            base = f.value.id if isinstance(f.value, ast.Name) else None
            calls.append((f.attr, self.rel, n.lineno, ".".join(self.stack) or "<module>", "attr", base))
        self.generic_visit(n)
for p in files:
    rel = rel_of(p)
    try:
        raw = open(p, "rb").read()
        text = raw.decode("utf-8")
        tree = ast.parse(text)
    except Exception as e:
        failed.append(rel); continue
    sources[rel] = (text.splitlines(), hashlib.sha256(raw).hexdigest())
    V(rel).visit(tree)
def module_matches(rel, pre):
    if not pre:
        return True
    m = module_of(rel)
    return m[-len(pre):] == pre or ".".join(m).endswith(".".join(pre))
cands = [d for d in defs.get(name, []) if d[3] != "assign" or not d[4].startswith("_")]
exact = [d for d in cands if module_matches(d[0], prefix)]
chosen = exact or cands
# 若请求的模块里只有 import 别名，沿别名解析一跳到真正定义
via = []
if prefix and not exact:
    for (rel, alias), (mod, orig) in aliases.items():
        if alias == name and module_matches(rel, prefix):
            tgt = [d for d in defs.get(orig, []) if module_matches(d[0], mod.split(".") if mod else [])]
            if tgt:
                via.append(f"{rel}: from {mod} import {orig}" + (f" as {alias}" if alias != orig else ""))
                chosen = tgt
chosen = sorted(chosen, key=lambda d: (d[3] == "assign", d[0], d[1]))
if q.get("mode") == "hints":
    # content_search 的附加区：只列同名定义的位置与再导出，定义体只在很短时附上；没有 def/class 定义就什么都不加
    real = [d for d in chosen if d[3] != "assign"]
    text = ""; records = []
    if real:
        head = f"## symbol {name}: {len(real)} definition" + ("" if len(real) == 1 else "s") + " in the whole workspace (static ast index, not limited by glob/path" + (f"; {len(failed)} files failed to parse" if failed else "") + ")"
        if len(real) > 1:
            head += ". Same name is defined in several places: check the imports before assuming which one runs"
        rows = [head]
        for (rel, s, e, kind, qual) in real[:8]:
            rows.append(f"  {qual} ({kind}) {rel}:{s}-{e}")
        if len(real) > 8:
            rows.append(f"  (+{len(real) - 8} more)")
        exports = sorted(f"{rel}: from {mod} import {orig}" + (f" as {alias}" if alias != orig else "") for (rel, alias), (mod, orig) in aliases.items() if alias == name and rel.endswith("__init__.py"))
        for x in exports[:3]:
            rows.append(f"  re-exported in {x}")
        body = []; left = q["maxBodyLines"]
        # 同名定义超过 3 处时只列位置：附哪几个的定义体都是猜
        for (rel, s, e, kind, qual) in (real if len(real) <= 3 else []):
            n = e - s + 1
            if n > left:
                continue
            lines, h = sources[rel]
            body.append(f"{qual} {rel}:{s}-{e} sha256:{h}")
            body += [f"{i}\t{lines[i-1]}" for i in range(s, e + 1)]
            left -= n
            records.append({"path": rel, "hash": h, "startLine": s, "endLine": e})
        text = "\n".join(rows + body)
        if len(text) > budget:
            text = "\n".join(rows); records = []
        if len(text) > budget:
            text = ""
    print(json.dumps({"text": text, "records": records, "definitions": len(real)}))
    sys.exit(0)
out = []; used = 0; truncated = []
def emit(s):
    global used
    if used + len(s) + 1 > budget:
        if "output budget" not in truncated:
            truncated.append("output budget")
        return False
    out.append(s); used += len(s) + 1; return True
records = []
emit(f"code_lookup {target} | relations: ast (static; dynamic calls not shown) | files parsed {len(sources)}" + (f", parse failed {len(failed)}" if failed else ""))
for v in via:
    emit(f"re-export: {v}")
if not chosen:
    emit(f"no definition named {name} found in parsed .py files (this does not prove absence: dynamic definitions, other languages and parse failures are not covered)")
for (rel, s, e, kind, qual) in chosen[:max_defs]:
    lines, h = sources[rel]
    shown_e = min(e, s + max_lines - 1)
    if not emit(f"\n## definition {qual} ({kind}) {rel}:{s}-{e} sha256:{h}"):
        break
    body = "\n".join(f"{i}\t{lines[i-1]}" for i in range(s, shown_e + 1))
    if not emit(body):
        break
    records.append({"path": rel, "hash": h, "startLine": s, "endLine": shown_e})
    if shown_e < e:
        emit(f"… {e - shown_e} more lines; file_read {rel} lines {shown_e + 1}-{e}")
    if kind in ("def", "async def"):
        cls = qual.rsplit(".", 1)[0] if "." in qual else None
        inner = []
        for (cname, crel, cline, encl, ckind, cbase) in calls:
            if crel != rel or not (s <= cline <= e) or cname == name:
                continue
            if cname.startswith("__") and cname.endswith("__"):
                continue
            if ckind == "name" and cname in BUILTINS and not any(d[0] == rel for d in defs.get(cname, [])):
                continue
            inner.append((cname, ckind, cbase))
        seen = []
        for c in inner:
            if c[0] not in [x[0] for x in seen]:
                seen.append(c)
        rows = []
        for (c, ckind, cbase) in seen[:15]:
            ds = defs.get(c, [])
            if ckind == "attr" and cbase == "self" and cls:
                same = [d for d in ds if d[4].startswith(cls + ".")]
                ds = same or ds
            elif ckind == "name":
                local = [d for d in ds if d[0] == rel]
                ds = local or ds
            if ds:
                locs = ", ".join(f"{d[0]}:{d[1]}" for d in ds[:3]) + (f" (+{len(ds) - 3} more)" if len(ds) > 3 else "")
                rows.append(f"  {c} -> {locs}")
        if rows:
            emit("calls (defined in this repo):")
            for r in rows:
                if not emit(r):
                    break
if len(chosen) > max_defs:
    emit(f"\n({len(chosen) - max_defs} more definitions of {name} not shown; pass a module-qualified symbol such as pkg.module.{name})")
module_level = bool(chosen) and all("." not in d[4] for d in chosen[:max_defs])
mod_names = set()
for d in chosen[:max_defs]:
    mod_names.update(module_of(d[0]))
mod_names.update(prefix)
def relevant(c):
    if c[0] != name:
        return False
    if not module_level:
        return True
    # 模块级函数/类：直接调用，或"模块名.函数"形式；排除 str.split 这类同名方法
    return c[4] == "name" or (c[5] is not None and (c[5] in mod_names or (c[1], c[5]) in aliases))
all_named = [c for c in calls if c[0] == name]
refs = [c for c in all_named if relevant(c)]
hidden = len(all_named) - len(refs)
if refs:
    emit(f"\n## call sites of {name} ({len(refs)} total)")
    for (cname, rel, line, encl, _k, _b) in refs[:max_refs]:
        lines, _ = sources[rel]
        if not emit(f"{rel}:{line} in {encl}: {lines[line-1].strip()[:200]}"):
            break
    if len(refs) > max_refs:
        emit(f"({len(refs) - max_refs} more call sites not shown)")
if hidden:
    emit(f"({hidden} same-named method calls on other objects excluded, e.g. str.{name})")
if truncated:
    emit(f"\nincomplete: {', '.join(truncated)}")
print(json.dumps({"text": "\n".join(out), "records": records, "definitions": len(chosen), "callSites": len(refs), "parseFailed": failed[:20], "truncated": truncated}))
`;

function run(input: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(PYTHON, ["-I", "-c", SCRIPT], { cwd, signal, stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = []; const err: Buffer[] = [];
		let size = 0;
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (c: Buffer) => { size += c.length; if (size <= 4 * 1024 * 1024) out.push(c); else child.kill("SIGKILL"); });
		child.stderr.on("data", (c: Buffer) => { if (err.length < 64) err.push(c); });
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new ToolError(`code_lookup 失败：${Buffer.concat(err).toString("utf8").trim().slice(-300) || `exit ${code}`}`));
			else resolve(Buffer.concat(out).toString("utf8"));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

/** content_search 命中的是一个标识符时，取它在工作区里的同名定义位置；没有定义时 text 为空。 */
export async function symbolHints(root: string, symbol: string, signal: AbortSignal, limits: { maxBodyLines: number; maxChars: number } = { maxBodyLines: 40, maxChars: 3000 }): Promise<{ text: string; records: { path: string; hash: string }[]; definitions: number }> {
	const raw = await run(JSON.stringify({ mode: "hints", root, symbol, maxDefinitions: 8, maxReferences: 0, maxDefinitionLines: limits.maxBodyLines, maxBodyLines: limits.maxBodyLines, maxChars: limits.maxChars }), root, signal, 10000);
	return JSON.parse(raw) as { text: string; records: { path: string; hash: string }[]; definitions: number };
}

const intOf = (v: unknown, name: string, dflt: number, min: number, max: number): number => {
	if (v === undefined) return dflt;
	if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new ToolError(`${name} 必须是 ${min}–${max} 的整数`);
	return v as number;
};

export function createCodeLookupTool(): ToolDefinition {
	return {
		name: "code_lookup",
		logicalName: "code.lookup",
		readOnly: true,
		description:
			"Look up a Python symbol in one call: its definition source (following package re-exports such as `from .engine import x`), " +
			"the functions it calls with where they are defined in this repo, and its call sites. " +
			"Use a module-qualified name when you know it (e.g. \"sqlparse.split\" or \"statement_splitter.StatementSplitter\"). " +
			"Relations are static (ast); dynamic calls are not shown and a missing result does not prove absence.",
		parameters: {
			type: "object",
			properties: {
				symbol: { type: "string", description: "Function, class or variable name, optionally module-qualified" },
				maxDefinitions: { type: "integer", minimum: 1, maximum: 5, description: "Default 2" },
				maxDefinitionLines: { type: "integer", minimum: 10, maximum: 200, description: "Source lines shown per definition, default 80" },
				maxReferences: { type: "integer", minimum: 0, maximum: 50, description: "Call sites shown, default 15" },
			},
			required: ["symbol"],
			additionalProperties: false,
		},
		async execute(args, ctx: ToolContext): Promise<ToolResult> {
			try {
				for (const k of Object.keys(args)) if (!["symbol", "maxDefinitions", "maxDefinitionLines", "maxReferences"].includes(k)) throw new ToolError(`未知参数 ${k}`);
				if (typeof args.symbol !== "string" || !/^[A-Za-z_][A-Za-z0-9_.]{0,200}$/.test(args.symbol)) throw new ToolError("symbol 必须是 Python 标识符，可带模块前缀（用 . 分隔）");
				const query = {
					root: ctx.workspace.root,
					symbol: args.symbol,
					maxDefinitions: intOf(args.maxDefinitions, "maxDefinitions", 2, 1, 5),
					maxDefinitionLines: intOf(args.maxDefinitionLines, "maxDefinitionLines", 80, 10, 200),
					maxReferences: intOf(args.maxReferences, "maxReferences", 15, 0, 50),
					maxChars: 12000,
				};
				const raw = await run(JSON.stringify(query), ctx.workspace.root, ctx.signal, 20000);
				const res = JSON.parse(raw) as { text: string; records: { path: string; hash: string }[]; definitions: number; callSites: number; parseFailed: string[]; truncated: string[] };
				for (const r of res.records) ctx.files.record(r.path, r.hash);
				return {
					ok: true,
					modelContent: res.text,
					summary: `code_lookup ${args.symbol}：${res.definitions} 个定义，${res.callSites} 处调用`,
					details: { symbol: args.symbol, definitions: res.definitions, callSites: res.callSites, parseFailed: res.parseFailed, truncated: res.truncated },
				};
			} catch (error) {
				const message = error instanceof ToolError ? error.message : `code_lookup 出错：${String(error).slice(0, 300)}`;
				return { ok: false, modelContent: message, summary: message, details: {} };
			}
		},
	};
}
