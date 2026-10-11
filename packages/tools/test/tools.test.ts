import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import {
	type ApprovalRequest,
	BlobStore,
	classifyRisk,
	createCommandTool,
	createEditTool,
	createExpandTool,
	createOutlineTool,
	createReadTool,
	createWriteTool,
	DEFAULT_READ_LIMITS,
	FileStateTracker,
	findSymbol,
	sha256,
	type ToolContext,
	Workspace,
} from "../src/index.ts";

function setup(approve: (r: ApprovalRequest) => "allow" | "deny" = () => "allow") {
	const root = mkdtempSync(join(tmpdir(), "mtools-"));
	const approvals: ApprovalRequest[] = [];
	const ac = new AbortController();
	const ctx: ToolContext = {
		workspace: new Workspace(root),
		files: new FileStateTracker(),
		blobs: new BlobStore(join(root, "..", `${basename(root)}-blobs`)),
		signal: ac.signal,
		toolCallId: "call_1",
		approve: async (r) => {
			approvals.push(r);
			return approve(r);
		},
	};
	return { root, ctx, approvals, ac };
}

const read = createReadTool();
const edit = createEditTool();
const write = createWriteTool();
const cmd = createCommandTool();

describe("file_read", () => {
	test("中文与空格路径、行号、总行数与哈希", async () => {
		const { root, ctx } = setup();
		mkdirSync(join(root, "中文 目录"));
		const text = Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 行`).join("\n") + "\n";
		writeFileSync(join(root, "中文 目录", "文件 一.txt"), text);
		const r = await read.execute({ path: "中文 目录/文件 一.txt" }, ctx);
		assert.ok(r.ok, r.modelContent);
		assert.match(r.modelContent, /^中文 目录\/文件 一\.txt \| lines 1-300 of 300 \| sha256:/);
		assert.match(r.modelContent, /\n300\t第 300 行$/);
		assert.equal(r.details.truncated, false, "默认 500 行，300 行的文件一次读完");
		assert.equal(r.details.hash, sha256(text));
		const r2 = await read.execute({ path: "中文 目录/文件 一.txt", startLine: 250, endLine: 900 }, ctx);
		assert.match(r2.modelContent, /lines 250-300 of 300/);
	});

	test("单次最多 2000 行；不给范围时读整个文件（最多 2000 行）；超长单行截断；二进制拒绝", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "big.txt"), Array.from({ length: 3000 }, () => "x").join("\n"));
		const r = await read.execute({ path: "big.txt", startLine: 1, endLine: 3000 }, ctx);
		assert.match(r.modelContent, /lines 1-2000 of 3000/);
		const d = await read.execute({ path: "big.txt" }, ctx);
		assert.match(d.modelContent, /lines 1-2000 of 3000/);
		writeFileSync(join(root, "long.txt"), "a".repeat(5000));
		const r2 = await read.execute({ path: "long.txt" }, ctx);
		assert.match(r2.modelContent, /已截断/);
		writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
		const r3 = await read.execute({ path: "bin.dat" }, ctx);
		assert.equal(r3.ok, false);
		assert.match(r3.modelContent, /二进制/);
	});

	test("CRLF 文件：按行读取且标注 CRLF", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "win.txt"), "a\r\nb\r\nc\r\n");
		const r = await read.execute({ path: "win.txt" }, ctx);
		assert.match(r.modelContent, /lines 1-3 of 3 \| sha256:[0-9a-f]{12} \| CRLF\n1\ta\n2\tb\n3\tc$/);
	});

	test("拒绝越出工作区的路径与符号链接", async () => {
		const { root, ctx } = setup();
		const outside = mkdtempSync(join(tmpdir(), "outside-"));
		writeFileSync(join(outside, "secret.txt"), "s");
		symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
		for (const p of ["../x", join(outside, "secret.txt"), "link.txt"]) {
			const r = await read.execute({ path: p }, ctx);
			assert.equal(r.ok, false, p);
			assert.match(r.modelContent, /越出工作区|不存在/, p);
		}
	});
});

describe("file_read 稀疏行号（可选配置）", () => {
	test("sparse：首行与 10 的倍数行带行号，其余行原样；说明文字随之改变；默认仍每行带行号", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "b.txt"), `${Array.from({ length: 25 }, (_, i) => `v${i + 1}`).join("\n")}\n`);
		const sparse = createReadTool({ defaultLines: 120, maxLines: 400, maxLineChars: 2000, lineNumbers: "sparse" });
		const r = await sparse.execute({ path: "b.txt", startLine: 3, endLine: 21 }, ctx);
		const body = r.modelContent.split("\n").slice(1);
		assert.equal(body[0], "3\tv3");
		assert.equal(body[1], "v4");
		assert.equal(body[7], "10\tv10");
		assert.equal(body[17], "20\tv20");
		assert.equal(body[18], "v21");
		assert.match(sparse.description, /every 10th line/);
		const full = await read.execute({ path: "b.txt", startLine: 3, endLine: 4 }, ctx);
		assert.equal(full.modelContent.split("\n")[2], "4\tv4");
	});
});

describe("file_read 去重（可选配置）", () => {
	const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

	test("默认关闭：重复读取照常返回全文，参数里没有 force", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "a.txt"), lines(50));
		const r1 = await read.execute({ path: "a.txt" }, ctx);
		const r2 = await read.execute({ path: "a.txt" }, ctx);
		assert.equal(r2.modelContent, r1.modelContent);
		assert.equal((read.parameters as { properties: Record<string, unknown> }).properties.force, undefined);
	});

	test("开启后：已发送范围（含其子范围）只回简短说明；超出范围、force、文件改动、上下文修订后都照常返回", async () => {
		const { root, ctx } = setup();
		const dread = createReadTool({ defaultLines: 120, maxLines: 400, maxLineChars: 2000, dedupe: true });
		assert.ok((dread.parameters as { properties: Record<string, unknown> }).properties.force);
		writeFileSync(join(root, "a.txt"), lines(300));
		const first = await dread.execute({ path: "a.txt", startLine: 1, endLine: 100 }, ctx);
		assert.match(first.modelContent, /\n100\tline 100$/);
		const again = await dread.execute({ path: "a.txt", startLine: 1, endLine: 100 }, ctx);
		assert.equal(again.details.deduped, true);
		assert.match(again.modelContent, /already shown earlier/);
		assert.ok(again.modelContent.length < 200);
		assert.equal((await dread.execute({ path: "a.txt", startLine: 20, endLine: 60 }, ctx)).details.deduped, true, "子范围");
		// 两段相邻的已发送范围拼起来覆盖请求
		await dread.execute({ path: "a.txt", startLine: 101, endLine: 150 }, ctx);
		assert.equal((await dread.execute({ path: "a.txt", startLine: 90, endLine: 140 }, ctx)).details.deduped, true, "跨两段");
		const beyond = await dread.execute({ path: "a.txt", startLine: 140, endLine: 200 }, ctx);
		assert.notEqual(beyond.details.deduped, true, "超出已发送范围");
		assert.match(beyond.modelContent, /\n200\tline 200$/);
		const forced = await dread.execute({ path: "a.txt", startLine: 1, endLine: 10, force: true }, ctx);
		assert.match(forced.modelContent, /\n10\tline 10$/);
		// 文件内容变化：新版本没有发送记录
		const e = await edit.execute({ path: "a.txt", oldText: "line 5\n", newText: "LINE FIVE\n" }, ctx);
		assert.ok(e.ok, e.modelContent);
		const afterEdit = await dread.execute({ path: "a.txt", startLine: 1, endLine: 10 }, ctx);
		assert.match(afterEdit.modelContent, /\n5\tLINE FIVE/);
		// 上下文修订后记录作废
		ctx.files.forgetDelivered();
		assert.match((await dread.execute({ path: "a.txt", startLine: 1, endLine: 10 }, ctx)).modelContent, /\n10\tline 10$/);
	});
});

describe("file_outline（可选配置）", () => {
	test("Python：类、方法、嵌套函数带行号与缩进；未知类型给出提示；默认工具集不含它", async () => {
		const { root, ctx } = setup();
		writeFileSync(
			join(root, "m.py"),
			"import os\n\nclass A(Base):\n    x = 1\n\n    def f(self, a):\n        def inner():\n            pass\n        return a\n\nasync def g():\n    pass\n",
		);
		const outline = createOutlineTool();
		const r = await outline.execute({ path: "m.py" }, ctx);
		assert.ok(r.ok, r.modelContent);
		assert.match(r.modelContent, /^m\.py \| 12 lines \| sha256:\w{12} \| 4 definitions/);
		assert.deepEqual(r.modelContent.split("\n").slice(1), ["3\tclass A(Base):", "6\t    def f(self, a):", "7\t        def inner():", "11\tasync def g():"]);
		writeFileSync(join(root, "notes.txt"), "hello\n");
		assert.match((await outline.execute({ path: "notes.txt" }, ctx)).modelContent, /no definitions recognised/);
	});

	test("TypeScript：函数、类、接口与方法", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "a.ts"), "export interface I { a: number }\nexport class C {\n  private m(x: number): void {\n    return;\n  }\n}\nexport async function f() {}\nconst y = 1;\n");
		const r = await createOutlineTool().execute({ path: "a.ts" }, ctx);
		assert.deepEqual(r.modelContent.split("\n").slice(1).map((l) => l.split("\t")[0]), ["1", "2", "3", "7"]);
	});
});

describe("file_edit / file_write", () => {
	test("先读后改；旧哈希冲突时失败并给出当前哈希", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "a.py"), "def add(a, b):\n    return a - b\n");
		const noRead = await edit.execute({ path: "a.py", oldText: "a - b", newText: "a + b" }, ctx);
		assert.equal(noRead.ok, false);
		assert.match(noRead.modelContent, /请先用 file_read/);
		await read.execute({ path: "a.py" }, ctx);
		writeFileSync(join(root, "a.py"), "def add(a, b):\n    return a - b  # 用户同时改动\n");
		const stale = await edit.execute({ path: "a.py", oldText: "a - b", newText: "a + b" }, ctx);
		assert.equal(stale.ok, false);
		assert.match(stale.modelContent, /已改变/);
		assert.equal(readFileSync(join(root, "a.py"), "utf8").includes("用户同时改动"), true, "用户改动不被覆盖");
		await read.execute({ path: "a.py" }, ctx);
		const ok = await edit.execute({ path: "a.py", oldText: "return a - b", newText: "return a + b" }, ctx);
		assert.ok(ok.ok, ok.modelContent);
		assert.match(readFileSync(join(root, "a.py"), "utf8"), /return a \+ b  # 用户同时改动/);
	});

	test("匹配有歧义时失败；expectedMatches 可放宽", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "b.txt"), "x = 1\nx = 1\n");
		await read.execute({ path: "b.txt" }, ctx);
		const amb = await edit.execute({ path: "b.txt", oldText: "x = 1", newText: "x = 2" }, ctx);
		assert.equal(amb.ok, false);
		assert.match(amb.modelContent, /出现 2 次/);
		const both = await edit.execute({ path: "b.txt", oldText: "x = 1", newText: "x = 2", expectedMatches: 2 }, ctx);
		assert.ok(both.ok);
		assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "x = 2\nx = 2\n");
	});

	test("CRLF 文件编辑后保持 CRLF", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "w.txt"), "line1\r\nline2\r\nline3\r\n");
		await read.execute({ path: "w.txt" }, ctx);
		const r = await edit.execute({ path: "w.txt", oldText: "line1\nline2", newText: "LINE1\nLINE2" }, ctx);
		assert.ok(r.ok, r.modelContent);
		assert.equal(readFileSync(join(root, "w.txt"), "utf8"), "LINE1\r\nLINE2\r\nline3\r\n");
	});

	test("写文件：默认不覆盖；覆盖必须提供旧哈希；可在中文空格目录中新建", async () => {
		const { root, ctx } = setup();
		const c = await write.execute({ path: "新 目录/x.txt", content: "hi\n" }, ctx);
		assert.ok(c.ok, c.modelContent);
		assert.equal(readFileSync(join(root, "新 目录/x.txt"), "utf8"), "hi\n");
		const again = await write.execute({ path: "新 目录/x.txt", content: "bye\n" }, ctx);
		assert.equal(again.ok, false);
		const noHash = await write.execute({ path: "新 目录/x.txt", content: "bye\n", createOnly: false }, ctx);
		assert.equal(noHash.ok, false);
		const ok = await write.execute({ path: "新 目录/x.txt", content: "bye\n", createOnly: false, expectedHash: sha256("hi\n") }, ctx);
		assert.ok(ok.ok);
		const escape = await write.execute({ path: "../escape.txt", content: "x" }, ctx);
		assert.equal(escape.ok, false);
	});

	test("写前快照钩子被调用", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "s.txt"), "a\n");
		const seen: string[] = [];
		ctx.beforeWrite = async (p) => {
			seen.push(p);
		};
		await read.execute({ path: "s.txt" }, ctx);
		await edit.execute({ path: "s.txt", oldText: "a", newText: "b" }, ctx);
		assert.equal(seen.length, 1);
	});
});

describe("command_run", () => {
	test("未经批准不启动进程", async () => {
		const { root, ctx, approvals } = setup(() => "deny");
		const r = await cmd.execute({ argv: ["touch", "should-not-exist"] }, ctx);
		assert.equal(r.ok, false);
		assert.equal(approvals.length, 1);
		assert.equal(approvals[0]?.command, "touch should-not-exist");
		assert.equal(existsSync(join(root, "should-not-exist")), false);
	});

	test("捕获退出码与输出；子进程看不到 Key", async () => {
		const { ctx } = setup();
		process.env.DEEPSEEK_API_KEY_TEST_PROBE = "leak";
		const saved = process.env.DEEPSEEK_API_KEY;
		process.env.DEEPSEEK_API_KEY = "sk-should-not-leak";
		try {
			const r = await cmd.execute({ argv: [process.execPath, "-e", "console.log('k='+(process.env.DEEPSEEK_API_KEY??'none'));process.exitCode=3;"] }, ctx);
			assert.equal(r.ok, false);
			assert.equal(r.details.exitCode, 3);
			assert.match(r.modelContent, /k=none/);
		} finally {
			if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = saved;
			delete process.env.DEEPSEEK_API_KEY_TEST_PROBE;
		}
	});

	test("取消时终止整个进程树（含后台孙进程）", async t => {
		const { root, ctx, ac } = setup();
		const pidFile = join(root, "child.pid");
		const childScript = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);";
		const parentScript = "require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});setInterval(()=>{},1000);";
		const p = cmd.execute({ argv: [process.execPath, "-e", parentScript, childScript, pidFile] }, ctx);
		t.after(async () => { ac.abort(); await p; });
		for (let i = 0; i < 500 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		ac.abort();
		const r = await p;
		assert.equal(r.details.cancelled, true);
		const running = () => {
			try { process.kill(grandchild, 0); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
			// A Linux orphan may remain as an exited zombie until init reaps it.
			if (process.platform === "linux") {
				try { const stat = readFileSync(`/proc/${grandchild}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
			}
			return true;
		};
		for (let i = 0; i < 100 && running(); i++) await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(running(), false, "the recorded background child must stop");
	});

	test("超时终止", { timeout: 15_000 }, async () => {
		const { ctx } = setup();
		const r = await cmd.execute({ argv: [process.execPath, "-e", "setInterval(()=>{},1000);"], timeoutMs: 1000 }, ctx);
		assert.equal(r.details.timedOut, true);
		// Windows allows an 8s Job-stop handshake plus a 2s drain deadline.
		assert.ok(Number(r.details.durationMs) < (process.platform === "win32" ? 12_000 : 5000));
	});

	test("长输出保留首尾并存完整输出", async () => {
		const { ctx } = setup();
		const r = await cmd.execute({ argv: [process.execPath, "-e", "process.stdout.write(Array.from({length:1000},(_,i)=>String(i+1)).join('\\n')+'\\n');"] }, ctx);
		assert.match(r.modelContent, /lines omitted/);
		assert.match(r.modelContent, /\n1000\n?$/);
		assert.ok(r.fullOutputRef?.startsWith("blob_"));
	});

	test("风险分级", () => {
		assert.equal(classifyRisk("ls -la"), "read-only");
		assert.equal(classifyRisk("python -m pytest -x"), "workspace-write");
		assert.equal(classifyRisk("pip install requests"), "network");
		assert.equal(classifyRisk("sudo rm -rf /"), "dangerous");
		assert.equal(classifyRisk("cat a | sh"), "workspace-write");
	});
});

describe("context_expand：按引用取回被移出上下文的原文", () => {
	const expand = createExpandTool();
	test("BlobStore.get 取回 put 存入的原文；无效或不存在的引用返回 null", () => {
		const { ctx } = setup();
		const ref = ctx.blobs?.put("line 1\nline 2") ?? "";
		assert.equal(ctx.blobs?.get(ref), "line 1\nline 2");
		assert.equal(ctx.blobs?.get("blob_0000000000000000"), null);
		assert.equal(ctx.blobs?.get("../etc/passwd"), null);
	});
	test("返回当时的原文与行范围；offset/limit 分段；越界与未知引用报错", async () => {
		const { ctx } = setup();
		const text = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join("\n");
		const ref = ctx.blobs?.put(text) ?? "";
		const all = await expand.execute({ ref }, ctx);
		assert.equal(all.ok, true);
		assert.equal(all.modelContent, `[ref=${ref} | lines 1-10 of 10 | as shown earlier]\n${text}`);
		const part = await expand.execute({ ref, offset: 3, limit: 2 }, ctx);
		assert.match(String(part.details.snapshot), /^page_v1_[0-9a-f]{32}$/);
		assert.equal(part.modelContent, `[ref=${ref} | lines 3-4 of 10 | as shown earlier | more: offset=5, snapshot=${part.details.snapshot}]\nrow 3\nrow 4`);
		const continuation = await expand.execute({ ref, snapshot: part.details.snapshot, offset: 5, limit: 2 }, ctx);
		assert.equal(continuation.ok, true);
		assert.ok(continuation.modelContent.endsWith("\nrow 5\nrow 6"));
		assert.equal((await expand.execute({ ref, offset: 11 }, ctx)).ok, false);
		assert.equal((await expand.execute({ ref, offset: 0 }, ctx)).ok, false);
		assert.equal((await expand.execute({ ref: "blob_ffffffffffffffff" }, ctx)).ok, false);
		assert.equal(expand.readOnly, true);
	});
});

describe("file_read 按名字读取定义（可选配置 symbols）", () => {
	const SRC = [
		"import os",
		"",
		"class Parser:",
		"    x = 1",
		"",
		"    @property",
		"    def parse(self):",
		"        return (1,",
		"                2)",
		"",
		"    def reset(self):",
		"        pass",
		"",
		"",
		"def parse(text):",
		"    return text.strip()",
		"",
	];
	test("findSymbol：顶层与嵌套定义、装饰器、块结束", () => {
		assert.deepEqual(findSymbol(SRC, "parse"), [{ start: 6, end: 9 }, { start: 15, end: 16 }]);
		assert.deepEqual(findSymbol(SRC, "Parser.parse"), [{ start: 6, end: 9 }]);
		assert.deepEqual(findSymbol(SRC, "Parser"), [{ start: 3, end: 12 }]);
		assert.deepEqual(findSymbol(SRC, "Other.parse"), []);
		assert.deepEqual(findSymbol(SRC, "missing"), []);
	});
	test("多行装饰器、字符串中不缩进的行、续行不截断定义", () => {
		// 两个合法 Python 样例（ast.parse 通过）
		assert.deepEqual(findSymbol(["@decorate(", "    option=True,", ")", "def f():", "    return 1"], "f"), [{ start: 1, end: 5 }]);
		assert.deepEqual(findSymbol(["def f():", '    s = """first', "unindented text", 'last"""', "    return s"], "f"), [{ start: 1, end: 5 }]);
		// 单引号三引号、反斜杠续行、字符串中的 # 与括号
		assert.deepEqual(findSymbol(["def g():", "    t = '''a", "b'''", "    x = 1 + \\", "2", '    y = "# ("', "    return t", "", "def h():", "    pass"], "g"), [{ start: 1, end: 7 }]);
		// 装饰器与 def 之间的注释；多个装饰器
		assert.deepEqual(findSymbol(["@a", "# note", "@b(1,", "   2)", "def k():", "    pass"], "k"), [{ start: 1, end: 6 }]);
		// 块后的顶格注释不算入定义
		assert.deepEqual(findSymbol(["def m():", "    return 1", "# section", "def n():", "    pass"], "m"), [{ start: 1, end: 2 }]);
		// 外层名逐级向外找：方法定义在 class 的 if 块中
		assert.deepEqual(findSymbol(["class C:", "    if True:", "        def f(self):", "            return 1"], "C.f"), [{ start: 3, end: 4 }]);
	});
	test("非 Python 文件不支持按名字读取，提示改用行范围", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "a.ts"), "class A {\n  f() {\n    return 1;\n  }\n}\n");
		const r = await createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true }).execute({ path: "a.ts", symbol: "A.f" }, ctx);
		assert.equal(r.ok, false);
		assert.match(r.modelContent, /只支持 Python 文件/);
	});
	test("短字符串的反斜杠续行保留状态，不把字符串内容当作定义", () => {
		for (const prefix of ["", "r", "b", "f"]) {
			for (const quote of ['"', "'"]) {
				const lines = [
					"def f():",
					`    s = ${prefix}${quote}first\\`,
					"def fake():\\",
					`# ) last${quote}`,
					"    return s",
					"",
					"def after():",
					"    pass",
				];
				assert.deepEqual(findSymbol(lines, "f"), [{ start: 1, end: 5 }], `${prefix}${quote}`);
				assert.deepEqual(findSymbol(lines, "fake"), [], `${prefix}${quote}`);
				assert.deepEqual(findSymbol(lines, "after"), [{ start: 7, end: 8 }]);
			}
		}
	});
	test("多级名字检查所有父定义，并忽略已结束的同名作用域", () => {
		const lines = [
			"class A:",
			"    class B:",
			"        def f(self):",
			"            return 1",
			"class Other:",
			"    class B:",
			"        def f(self):",
			"            return 2",
			"if True:",
			"    def f():",
			"        return 3",
		];
		assert.deepEqual(findSymbol(lines, "A.B.f"), [{ start: 3, end: 4 }]);
		assert.deepEqual(findSymbol(lines, "Other.B.f"), [{ start: 7, end: 8 }]);
		assert.deepEqual(findSymbol(lines, "B.f"), [{ start: 3, end: 4 }, { start: 7, end: 8 }]);
		assert.deepEqual(findSymbol(lines, "A.f"), []);
		assert.deepEqual(findSymbol(lines, "Other.f"), []);
	});
	test("大量平级类的同名方法仍只匹配指定父类", () => {
		const lines = Array.from({ length: 3000 }, (_, i) => [
			`class C${i}:`, "    def __init__(self):", "        self.value = 1",
		]).flat();
		assert.deepEqual(findSymbol(lines, "C2999.__init__"), [{ start: 8999, end: 9000 }]);
		assert.deepEqual(findSymbol(lines, "Missing.__init__"), []);
	});
	test("多行签名与转义三引号结束后，仍能找到后续定义", () => {
		const lines = [
			"@decorate(",
			'    text="[ # )",',
			")",
			"async def f(",
			"arg=1,",
			"):",
			'    text = """first \\"""',
			"def fake():",
			'last"""',
			"    return arg",
			"# Between definitions",
			"def after():",
			"    pass",
		];
		assert.deepEqual(findSymbol(lines, "f"), [{ start: 1, end: 10 }]);
		assert.deepEqual(findSymbol(lines, "fake"), []);
		assert.deepEqual(findSymbol(lines, "after"), [{ start: 12, end: 13 }]);
	});
	test("CRLF 中的续行字符串读取完整，超过行数上限明确标注", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "continued.py"), ['def f():', '    s = "first\\', 'def fake():\\', 'last"', '    return s'].join("\r\n"));
		const tool = createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true });
		const full = await tool.execute({ path: "continued.py", symbol: "f" }, ctx);
		assert.equal(full.ok, true, full.modelContent);
		assert.equal(full.details.endLine, 5);
		assert.equal(full.details.eol, "\r\n");
		assert.match(full.modelContent, /5\t    return s/);
		const short = await createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true, maxLines: 2 }).execute({ path: "continued.py", symbol: "f" }, ctx);
		assert.equal(short.ok, true, short.modelContent);
		assert.equal(short.details.endLine, 2);
		assert.equal(short.details.symbolEndLine, 5);
		assert.equal(short.details.symbolTruncated, true);
		assert.match(short.modelContent, /symbol incomplete.*endLine=5/);
		const deduped = await createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true, dedupe: true, maxLines: 2 }).execute({ path: "continued.py", symbol: "f" }, ctx);
		assert.equal(deduped.details.deduped, true);
		assert.match(deduped.modelContent, /symbol incomplete.*endLine=5/);
		const rest = await tool.execute({ path: "continued.py", startLine: 3, endLine: 5 }, ctx);
		assert.equal(rest.ok, true);
		assert.match(rest.modelContent, /5\t    return s/);
	});
	test("无法确认逻辑行闭合时提示按行读取，不返回猜出的函数范围", async () => {
		const { root, ctx } = setup();
		const tool = createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true });
		for (const source of ['def f():\n    s = "unterminated', 'def f():\n    s = """unterminated', 'def f():\n    s = (1 +', 'def f():\n    s = 1 + \\']) {
			writeFileSync(join(root, "incomplete.py"), source);
			const rejected = await tool.execute({ path: "incomplete.py", symbol: "f" }, ctx);
			assert.equal(rejected.ok, false);
			assert.match(rejected.modelContent, /无法确认 Python.*请用 startLine\/endLine/);
			const byLine = await tool.execute({ path: "incomplete.py", startLine: 1, endLine: 2 }, ctx);
			assert.equal(byLine.ok, true);
		}
	});
	test("格式化三引号字符串有插值时保守退回按行，不识别内部假定义", async () => {
		const { root, ctx } = setup();
		const tool = createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true });
		for (const prefix of ["f", "F", "fr", "rF"]) {
			for (const beforeBrace of ["", "\\"]) {
				// Python 3.12 允许表达式复用外层三引号；反斜杠不转义 f-string 的插值花括号。
				const source = ["def f():", `    s = ${prefix}"""${beforeBrace}{ """first`, "def fake():", 'last""" }"""', "    return s"].join("\n");
				writeFileSync(join(root, "formatted.py"), source);
				for (const symbol of ["f", "fake"]) {
					const result = await tool.execute({ path: "formatted.py", symbol }, ctx);
					assert.equal(result.ok, false, result.modelContent);
					assert.match(result.modelContent, /格式化三引号字符串.*startLine\/endLine/);
				}
				const byLine = await tool.execute({ path: "formatted.py", startLine: 1, endLine: 5 }, ctx);
				assert.equal(byLine.ok, true);
				assert.match(byLine.modelContent, /5\t    return s/);
			}
		}
	});
	test("普通、原始、字节三引号与无插值格式化三引号仍可按名读取", async () => {
		const { root, ctx } = setup();
		const tool = createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true });
		for (const prefix of ["", "r", "b", "br", "rb", "f", "fr", "rf"]) {
			for (const quote of ['"""', "'''"]) {
				const source = ["def f():", `    s = ${prefix}${quote}first`, "def fake():", `last${quote}`, "    return s"].join("\n");
				writeFileSync(join(root, "literal.py"), source);
				const result = await tool.execute({ path: "literal.py", symbol: "f" }, ctx);
				assert.equal(result.ok, true, result.modelContent);
				assert.equal(result.details.endLine, 5);
				assert.deepEqual(findSymbol(source.split("\n"), "fake"), []);
			}
		}
		// 双花括号只是 f-string 的字面内容；普通字符串中的单花括号也不插值。
		for (const [prefix, braces] of [["f", "{{literal}}"], ["", "{literal}"], ["r", "{literal}"], ["b", "{literal}"]]) {
			writeFileSync(join(root, "literal.py"), `def f():\n    s = ${prefix}"""${braces}"""\n    return s`);
			assert.equal((await tool.execute({ path: "literal.py", symbol: "f" }, ctx)).ok, true);
		}
	});
	test("只返回该定义；多处匹配时列出行号；开关关闭时参数不出现", async () => {
		const { root, ctx } = setup();
		writeFileSync(join(root, "p.py"), `${SRC.join("\n")}\n`);
		const tool = createReadTool({ ...DEFAULT_READ_LIMITS, symbols: true });
		const r = await tool.execute({ path: "p.py", symbol: "Parser.parse" }, ctx);
		assert.equal(r.ok, true);
		assert.match(r.modelContent, /^p\.py \| lines 6-9 of 17/);
		assert.equal(r.modelContent.split("\n").length, 5);
		const many = await tool.execute({ path: "p.py", symbol: "parse" }, ctx);
		assert.equal(many.ok, false);
		assert.match(many.modelContent, /第 6、15 行/);
		assert.equal((await tool.execute({ path: "p.py", symbol: "nope" }, ctx)).ok, false);
		assert.equal("symbol" in (createReadTool().parameters as { properties: Record<string, unknown> }).properties, false);
		assert.doesNotMatch(createReadTool().description, /symbol/);
	});
});
