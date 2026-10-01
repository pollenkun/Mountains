import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BlobStore, createCodeLookupTool, createSearchTool, defaultTools, FileStateTracker, symbolOfPattern, type ToolContext, Workspace } from "../src/index.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "mlookup-"));
	const ctx: ToolContext = {
		workspace: new Workspace(root),
		files: new FileStateTracker(),
		blobs: new BlobStore(join(root, "..", `${root.split("/").pop()}-blobs`)),
		signal: new AbortController().signal,
		toolCallId: "call_1",
		approve: async () => "allow",
	};
	return { root, ctx };
}

/** 模仿 sqlparse：包的 __init__ 从内部模块再导出，对外函数调用内部类。 */
function fixture(root: string) {
	mkdirSync(join(root, "pkg", "engine"), { recursive: true });
	writeFileSync(join(root, "pkg", "__init__.py"), "from pkg import engine\nfrom pkg.api import split\n\n__all__ = ['split']\n");
	writeFileSync(join(root, "pkg", "api.py"), "from pkg.engine import FilterStack\n\n\ndef split(sql):\n    stack = FilterStack()\n    return [str(s) for s in stack.run(sql)]\n");
	writeFileSync(join(root, "pkg", "engine", "__init__.py"), "from pkg.engine.filter_stack import FilterStack\n");
	writeFileSync(join(root, "pkg", "engine", "filter_stack.py"), "from pkg.engine.statement_splitter import StatementSplitter\n\n\nclass FilterStack:\n    def run(self, sql):\n        splitter = StatementSplitter()\n        return splitter.process(sql)\n");
	writeFileSync(join(root, "pkg", "engine", "statement_splitter.py"), "class StatementSplitter:\n    def _change_splitlevel(self, ttype, value):\n        if value in ('END IF', 'END FOR'):\n            return -1\n        return 0\n\n    def process(self, sql):\n        return sql.split(';')\n");
	writeFileSync(join(root, "tests.py"), "import pkg\n\n\ndef test_split():\n    assert pkg.split('a;b')\n");
	writeFileSync(join(root, "broken.py"), "def oops(:\n");
}

describe("code_lookup", () => {
	const tool = createCodeLookupTool();

	test("对外名字经再导出找到真正定义，列出它调用的函数在哪里定义，以及调用点", async () => {
		const { root, ctx } = setup();
		fixture(root);
		const r = await tool.execute({ symbol: "pkg.split" }, ctx);
		assert.ok(r.ok, r.modelContent);
		assert.match(r.modelContent, /re-export: pkg\/__init__\.py: from pkg\.api import split/);
		assert.match(r.modelContent, /## definition split \(def\) pkg\/api\.py:4-6/);
		assert.match(r.modelContent, /4\tdef split\(sql\):/);
		assert.match(r.modelContent, /FilterStack -> pkg\/engine\/filter_stack\.py:4/);
		assert.match(r.modelContent, /## call sites of split/);
		assert.match(r.modelContent, /tests\.py:5 in test_split/);
		assert.match(r.modelContent, /parse failed 1/, "解析失败要写明");
	});

	test("一次追到内部实现：类的方法与它调用的内部方法", async () => {
		const { root, ctx } = setup();
		fixture(root);
		const r = await tool.execute({ symbol: "StatementSplitter" }, ctx);
		assert.ok(r.ok);
		assert.match(r.modelContent, /## definition StatementSplitter \(class\) pkg\/engine\/statement_splitter\.py:1-8/);
		assert.match(r.modelContent, /3\t        if value in \('END IF', 'END FOR'\):/);
		const m = await tool.execute({ symbol: "_change_splitlevel" }, ctx);
		assert.match(m.modelContent, /## definition StatementSplitter\._change_splitlevel \(def\)/);
	});

	test("找不到时写明不能证明不存在；参数校验；输出可用于编辑（登记文件版本）", async () => {
		const { root, ctx } = setup();
		fixture(root);
		const none = await tool.execute({ symbol: "does_not_exist" }, ctx);
		assert.ok(none.ok);
		assert.match(none.modelContent, /does not prove absence/);
		const bad = await tool.execute({ symbol: "../etc/passwd" }, ctx);
		assert.equal(bad.ok, false);
		const extra = await tool.execute({ symbol: "split", path: "pkg" }, ctx);
		assert.equal(extra.ok, false);
		assert.match(extra.modelContent, /未知参数 path/);
		const ok = await tool.execute({ symbol: "pkg.split", maxDefinitionLines: 10 }, ctx);
		assert.ok(ok.ok);
	});

	test("定义行数截断时给出续读位置", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "big.py"), `def big():\n${Array.from({ length: 40 }, (_, i) => `    x${i} = ${i}\n`).join("")}    return 0\n`);
		const r = await tool.execute({ symbol: "big", maxDefinitionLines: 10 }, ctx);
		assert.match(r.modelContent, /… 32 more lines; file_read big\.py lines 11-42/);
	});

	test("默认不启用；开启后排在 content_search 之后", () => {
		assert.equal(defaultTools().some((t) => t.name === "code_lookup"), false);
		const names = defaultTools({ codeLookup: true }).map((t) => t.name);
		assert.equal(names[names.indexOf("content_search") + 1], "code_lookup");
	});
});

describe("content_search path 作用域（searchPath 开关）", () => {
	test("关闭时保持旧行为：path 被忽略、搜全仓；开启后只搜该文件或目录", async () => {
		const { root, ctx } = setup();
		execFileSync("git", ["init", "-q"], { cwd: root });
		mkdirSync(join(root, "pkg"));
		writeFileSync(join(root, "pkg", "a.py"), "target\n");
		writeFileSync(join(root, "b.py"), "target\n");
		const old = await createSearchTool().execute({ pattern: "target", path: "pkg/a.py" }, ctx);
		assert.match(old.modelContent, /2 matches in 2 files/, "旧行为：静默忽略 path");
		const scoped = createSearchTool({}, { pathScope: true });
		const file = await scoped.execute({ pattern: "target", path: "pkg/a.py" }, ctx);
		assert.ok(file.ok, file.modelContent);
		assert.match(file.modelContent, /1 match(es)? in 1 file/);
		assert.match(file.modelContent, /pkg\/a\.py:1:1: target/);
		const dir = await scoped.execute({ pattern: "target", path: "pkg" }, ctx);
		assert.match(dir.modelContent, /1 match(es)? in 1 file/);
		const all = await scoped.execute({ pattern: "target" }, ctx);
		assert.match(all.modelContent, /2 matches in 2 files/);
		const outside = await scoped.execute({ pattern: "target", path: "../" }, ctx);
		assert.equal(outside.ok, false);
		const unknown = await scoped.execute({ pattern: "target", dir: "pkg" }, ctx);
		assert.equal(unknown.ok, false);
		assert.match(unknown.modelContent, /未知参数 dir/);
		assert.ok(JSON.stringify(scoped.parameters).includes('"path"'));
		assert.ok(!JSON.stringify(createSearchTool().parameters).includes('"path"'));
	});
});

describe("content_search 的符号附加区（searchSymbols 开关）", () => {
	test("只认明确的标识符写法", () => {
		for (const [p, want] of [["_remove", "_remove"], ["def _remove", "_remove"], ["def _remove\\(", "_remove"], ["class FilterStack", "FilterStack"], ["pkg.split", "split"], ["END IF", null], ["foo.*bar", null], ["raise ValueError", null], ["ab", null], ["values\\.pop", null]] as const)
			assert.equal(symbolOfPattern(p), want, p);
	});

	test("同名定义在两个文件：列出两处并提醒核对导入；关闭时输出不变；普通文本不触发；同一符号只附一次", async () => {
		const { root, ctx } = setup();
		execFileSync("git", ["init", "-q"], { cwd: root });
		mkdirSync(join(root, "lib"));
		writeFileSync(join(root, "lib", "dictutils.py"), "class OMD:\n    def _remove(self, k):\n        values = self._map[k]\n        return values.pop(0)\n");
		writeFileSync(join(root, "lib", "urlutils.py"), "try:\n    from lib.dictutils import OMD\nexcept ImportError:\n    class OMD:\n        def _remove(self, k):\n            values = self._map[k]\n            return values.pop()\n\n# not a symbol: remove later\n");
		const plain = await createSearchTool({}, { pathScope: true }).execute({ pattern: "def _remove", path: "lib/urlutils.py" }, ctx);
		const tool = createSearchTool({}, { pathScope: true, symbolHints: true });
		const r = await tool.execute({ pattern: "def _remove", path: "lib/urlutils.py" }, ctx);
		assert.ok(r.ok, r.modelContent);
		assert.ok(r.modelContent.startsWith(plain.modelContent), "原有搜索结果原样保留，附加区在后面");
		assert.match(r.modelContent, /1 match(es)? in 1 file/, "path 作用域不变");
		assert.match(r.modelContent, /## symbol _remove: 2 definitions in the whole workspace/);
		assert.match(r.modelContent, /check the imports before assuming which one runs/);
		assert.match(r.modelContent, /OMD\._remove \(def\) lib\/dictutils\.py:2-4/);
		assert.match(r.modelContent, /OMD\._remove \(def\) lib\/urlutils\.py:5-7/);
		assert.match(r.modelContent, /4\t        return values\.pop\(0\)/, "很短的定义体直接附上");
		const again = await tool.execute({ pattern: "_remove" }, ctx);
		assert.ok(!again.modelContent.includes("## symbol"), "同一符号只附一次");
		const text = await tool.execute({ pattern: "remove later" }, ctx);
		assert.ok(!text.modelContent.includes("## symbol"));
		const none = await tool.execute({ pattern: "values" }, ctx);
		assert.ok(!none.modelContent.includes("## symbol"), "没有 def/class 定义就不附加");
		assert.equal((none.details as { symbolHint?: { shown: boolean } }).symbolHint?.shown, false);
	});

	test("定义太长时只给位置，不给定义体", async () => {
		const { root, ctx } = setup();
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, "big.py"), `def bigfn():\n${Array.from({ length: 60 }, (_, i) => `    x${i} = ${i}\n`).join("")}    return 0\n`);
		const r = await createSearchTool({}, { symbolHints: true }).execute({ pattern: "bigfn" }, ctx);
		assert.match(r.modelContent, /bigfn \(def\) big\.py:1-62/);
		assert.ok(!r.modelContent.includes("sha256:"));
	});
});

describe("leanOutput：回执不给模型看哈希与审计引用", () => {
	test("读、改、写、命令的回执去掉哈希和 fullOutputRef；details 里照旧保留；关闭时不变", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "a.py"), Array.from({ length: 300 }, (_, i) => `x${i} = ${i}\n`).join(""));
		const pick = (lean: boolean) => Object.fromEntries(defaultTools({ leanOutput: lean }).map((t) => [t.name, t]));
		const off = pick(false), on = pick(true);
		const r0 = await off.file_read!.execute({ path: "a.py", startLine: 1, endLine: 5 }, ctx);
		assert.match(r0.modelContent.split("\n")[0]!, /sha256:[0-9a-f]{12}/);
		assert.match(r0.modelContent.split("\n")[0]!, /fullOutputRef=blob_/);
		assert.match(off.file_read!.description, /expectedHash/);
		const r1 = await on.file_read!.execute({ path: "a.py", startLine: 1, endLine: 5 }, ctx);
		assert.equal(r1.modelContent.split("\n")[0], "a.py | lines 1-5 of 300 | more: startLine=6");
		assert.equal(r1.modelContent.split("\n").slice(1).join("\n"), r0.modelContent.split("\n").slice(1).join("\n"), "正文不变");
		assert.ok((r1.details as { hash?: string }).hash, "哈希仍在 details 里");
		assert.ok(!/expectedHash/.test(on.file_read!.description));
		const e = await on.file_edit!.execute({ path: "a.py", oldText: "x3 = 3\n", newText: "x3 = 33\n" }, ctx);
		assert.equal(e.modelContent, "edited a.py: 1 replacement(s) at line 4");
		const w = await on.file_write!.execute({ path: "b.py", content: "y = 1\n" }, ctx);
		assert.equal(w.modelContent, "created b.py (1 lines)");
		const c = await on.command_run!.execute({ argv: ["python3", "-c", "print('z' * 200000)"] }, ctx);
		assert.ok(!/fullOutputRef|audit only/.test(c.modelContent), c.modelContent.slice(-300));
		const c0 = await off.command_run!.execute({ argv: ["python3", "-c", "print('z' * 200000)"] }, ctx);
		assert.match(c0.modelContent, /fullOutputRef=/);
	});
});

describe("file_read 的 outlineFirst", () => {
	test("大文件不带范围时返回大纲；带范围、带 symbol、小文件、认不出定义的文件照常读", async () => {
		const { root, ctx } = setup();
		const big = ["import os", "", "class A:", "    def f(self):", "        return 1", "", ...Array.from({ length: 250 }, (_, i) => `X${i} = ${i}`), "def g():", "    return 2"].join("\n") + "\n";
		writeFileSync(join(root, "big.py"), big);
		writeFileSync(join(root, "big.txt"), Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n");
		writeFileSync(join(root, "small.py"), "def h():\n    return 3\n");
		const tool = Object.fromEntries(defaultTools({ read: { defaultLines: 60, maxLines: 150, maxLineChars: 2000, outlineFirst: 200, symbols: true }, leanOutput: true }).map((t) => [t.name, t])).file_read!;
		const o = await tool.execute({ path: "big.py" }, ctx);
		assert.equal(o.modelContent, "big.py | 258 lines | outline of definitions (no range given and the file is longer than 200 lines); read a definition with symbol=Name or a range with startLine/endLine\n3\tclass A:\n4\t    def f(self):\n257\tdef g():");
		assert.match((await tool.execute({ path: "big.py", startLine: 1, endLine: 3 }, ctx)).modelContent, /^big\.py \| lines 1-3 of 258 \| more: startLine=4\n1\timport os/);
		assert.match((await tool.execute({ path: "big.py", symbol: "g" }, ctx)).modelContent, /lines 257-258/);
		assert.match((await tool.execute({ path: "big.txt" }, ctx)).modelContent, /^big\.txt \| lines 1-60 of 300/);
		assert.match((await tool.execute({ path: "small.py" }, ctx)).modelContent, /^small\.py \| lines 1-2 of 2/);
		assert.match(tool.description, /outline/);
	});
});

describe("file_read 的 classOutlineOver", () => {
	test("按 symbol 读大类只给结构；full=true 给全文；方法和小类照常完整返回", async () => {
		const { root, ctx } = setup();
		const body = ["import os", "", "class Big:", "    x = 1", "", "    def a(self):", ...Array.from({ length: 60 }, (_, i) => `        v${i} = ${i}`), "        return 1", "", "    def b(self):", ...Array.from({ length: 40 }, (_, i) => `        w${i} = ${i}`), "        return 2", "", "class Small:", "    def c(self):", "        return 3"].join("\n") + "\n";
		writeFileSync(join(root, "m.py"), body);
		const tool = Object.fromEntries(defaultTools({ read: { defaultLines: 60, maxLines: 400, maxLineChars: 2000, symbols: true, classOutlineOver: 80 }, leanOutput: true }).map((t) => [t.name, t])).file_read!;
		const o = await tool.execute({ path: "m.py", symbol: "Big" }, ctx);
		assert.match(o.modelContent, /^m\.py \| class Big lines 3-110 \(108 lines\) \| structure only/);
		assert.match(o.modelContent, /\n6\t    def a\(self\):\n69\t    def b\(self\):$/);
		const full = await tool.execute({ path: "m.py", symbol: "Big", full: true }, ctx);
		assert.match(full.modelContent, /^m\.py \| lines 3-110 of 114/);
		const meth = await tool.execute({ path: "m.py", symbol: "Big.a" }, ctx);
		assert.match(meth.modelContent, /^m\.py \| lines 6-67 of 114/);
		const small = await tool.execute({ path: "m.py", symbol: "Small" }, ctx);
		assert.match(small.modelContent, /^m\.py \| lines 112-114 of 114/);
		assert.match(tool.description, /structure/);
	});
});
