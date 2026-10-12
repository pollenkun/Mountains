import { statSync } from "node:fs";
import { readRegularFile } from "./regular-file.ts";
import { truncateUtf16 } from "./text.ts";
import { extname } from "node:path";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.ts";
import { sha256, ToolError } from "./workspace.ts";

/** 各语言的“定义行”识别规则（只做轻量正则，不做完整解析） */
const RULES: { exts: string[]; re: RegExp }[] = [
	{ exts: [".py", ".pyi"], re: /^\s*(?:async\s+def|def|class)\s+[_\p{ID_Start}][_\p{ID_Continue}]*/u },
	{
		exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		// The return-type class already includes whitespace; a preceding \s* would
		// repeatedly split that whitespace when an interface signature has no body.
		re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace)\s+[A-Za-z_$][\w$]*|^\s*(?:(?:public|private|protected|static|readonly|async|get|set)\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^{=]+)?\{\s*$/,
	},
	{ exts: [".go"], re: /^\s*(?:func|type)\s+/ },
	{ exts: [".rs"], re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\b/ },
	{ exts: [".java", ".kt", ".cs"], re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|open)\s+)*(?:class|interface|enum|record|fun|void|[A-Z][\w<>,]*(?:\s+[\w<>,]+)*)\s+[A-Za-z_]\w*\s*[({]/ },
];

const MAX_ENTRIES = 400;
const MAX_LINE = 160;

export function outlineLines(path: string, text: string): { line: number; text: string }[] {
	const rule = RULES.find((r) => r.exts.includes(extname(path).toLowerCase()));
	if (!rule) return [];
	const out: { line: number; text: string }[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i] ?? "";
		// Trim indentation once so regex alternatives never compete for long whitespace.
		if (rule.re.test(l.trimStart())) out.push({ line: i + 1, text: l.length > MAX_LINE ? `${truncateUtf16(l, MAX_LINE)}…` : l.replace(/\s+$/, "") });
	}
	return out;
}

/**
 * file_outline：列出文件中的类、函数、方法等定义行及行号（保留缩进以显示嵌套）。
 * 用途：先看结构，再用 file_read 精确读取需要的行范围，避免整段读取。可选配置，默认不启用。
 */
export function createOutlineTool(): ToolDefinition {
	return {
		name: "file_outline",
		logicalName: "file.outline",
		readOnly: true,
		description:
			"List the definitions (classes, functions, methods) of a source file with their line numbers, keeping indentation to show nesting. " +
			"Use it to find the right line range before calling file_read on just that range.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Workspace-relative path" } },
			required: ["path"],
			additionalProperties: false,
		},
		async execute(args, ctx: ToolContext): Promise<ToolResult> {
			try {
				if (typeof args.path !== "string") throw new ToolError("path 必须是字符串");
				const { abs, rel } = ctx.workspace.resolve(args.path);
				if (statSync(abs).isDirectory()) throw new ToolError(`${rel} 是目录，请用 file_glob 列出文件`);
				const buf = readRegularFile(abs);
				const text = buf.toString("utf8");
				const total = text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
				const hash = sha256(buf);
				const entries = outlineLines(rel, text);
				if (entries.length === 0) {
					return {
						ok: true,
						modelContent: `${rel} | ${total} lines | sha256:${hash.slice(0, 12)} | no definitions recognised for this file type; use file_read`,
						summary: `${rel} 没有可识别的定义`,
						details: { path: rel, totalLines: total, entries: 0 },
					};
				}
				const shown = entries.slice(0, MAX_ENTRIES);
				const header = `${rel} | ${total} lines | sha256:${hash.slice(0, 12)} | ${entries.length} definitions${entries.length > MAX_ENTRIES ? ` (first ${MAX_ENTRIES} shown)` : ""}`;
				return {
					ok: true,
					modelContent: [header, ...shown.map((e) => `${e.line}\t${e.text}`)].join("\n"),
					summary: `${rel} 的结构：${entries.length} 个定义`,
					details: { path: rel, totalLines: total, entries: entries.length, hash },
				};
			} catch (err) {
				const message = err instanceof ToolError ? err.message : String(err);
				return { ok: false, modelContent: `错误：${message}`, summary: `失败：${message}`, details: { error: message } };
			}
		},
	};
}
