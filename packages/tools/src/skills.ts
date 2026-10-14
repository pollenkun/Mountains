import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.ts";

/**
 * Skills follow the Agent Skills format (agentskills.io): a directory holding SKILL.md, whose YAML
 * frontmatter gives `name` and `description` and whose body holds the instructions. The model sees
 * only names and descriptions in the `skill` tool; it loads a skill's instructions when a task calls
 * for them. Built-in skills may also bring tools, which are present from the start of a session.
 */
export type SkillSource = "project" | "user" | "builtin";
export type SkillPermission = "allow" | "ask" | "deny";

export interface SkillRoot { dir: string; source: Exclude<SkillSource, "builtin"> }

/** A skill shipped with Mountains. Skills that bring tools appear only when enabled. */
export interface BuiltinSkill {
	name: string;
	description: string;
	body: string;
	tools?: ToolDefinition[];
	modelInvocable?: boolean;
	userInvocable?: boolean;
}

export interface SkillEntry {
	name: string;
	description: string;
	source: SkillSource;
	/** Directory holding SKILL.md; null for a built-in skill. */
	dir: string | null;
	file: string | null;
	modelInvocable: boolean;
	userInvocable: boolean;
	builtin?: BuiltinSkill;
}

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_LIMITS = { name: 64, description: 1024, bodyBytes: 256 * 1024, fileBytes: 256 * 1024, listedFiles: 50 } as const;

export class SkillFormatError extends Error {}

/** Parse SKILL.md: frontmatter fields (strings, booleans, nested maps skipped) and the body. */
export function parseSkillFile(text: string): { fields: Record<string, string>; body: string } {
	const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!src.startsWith("---\n")) throw new SkillFormatError("SKILL.md 必须以 --- 开头的 frontmatter 开始");
	const end = src.indexOf("\n---", 3);
	if (end < 0 || (src[end + 4] !== undefined && src[end + 4] !== "\n")) throw new SkillFormatError("frontmatter 没有以 --- 结束");
	const lines = src.slice(4, end + 1).split("\n");
	const body = src.slice(end + 4).replace(/^\n/, "");
	const fields: Record<string, string> = {};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const m = /^([A-Za-z0-9_.\/-]+):(?:\s+(.*))?$/.exec(line);
		if (!m) {
			if (/^\s/.test(line)) continue; // belongs to a nested map we do not read
			throw new SkillFormatError(`无法解析 frontmatter：${line.slice(0, 80)}`);
		}
		const key = m[1]!;
		const raw = (m[2] ?? "").trim();
		// Indented lines that follow belong to this key (a block scalar or a nested map).
		const block: string[] = [];
		while (i + 1 < lines.length && (lines[i + 1] === "" || /^\s/.test(lines[i + 1]!))) block.push(lines[++i]!);
		while (block.length && !block.at(-1)!.trim()) block.pop();
		if (/^[|>][+-]?$/.test(raw)) {
			const indent = Math.min(...block.filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length));
			const kept = block.map(l => l.slice(Number.isFinite(indent) ? indent : 0));
			fields[key] = raw.startsWith("|") ? kept.join("\n") : kept.reduce((out, l) => (!l.trim() ? `${out}\n` : out && !out.endsWith("\n") ? `${out} ${l.trim()}` : `${out}${l.trim()}`), "").trim();
		} else if (raw === "") {
			// A nested map (metadata and the like) or an empty value.
			if (!block.some(l => l.trim())) fields[key] = "";
		} else if (raw.startsWith('"') || raw.startsWith("'")) {
			const double = raw.startsWith('"');
			const pattern = double ? /^"((?:[^"\\]|\\[\s\S])*)"[ \t]*(?:#.*)?$/ : /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/;
			// A quoted value may continue on the indented lines that follow, up to its closing quote.
			let text = raw, used = 0, q = pattern.exec(text);
			while (!q && used < block.length) q = pattern.exec(text += `\n${block[used++]}`);
			if (!q) throw new SkillFormatError(`${key} 的引号没有闭合`);
			const folded = foldQuoted(q[1]!, double);
			fields[key] = double ? folded.replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c)) : folded.replace(/''/g, "'");
		} else {
			// Plain scalar; continuation lines fold into it.
			fields[key] = [raw.replace(/\s+#.*$/, ""), ...block.map(l => l.trim()).filter(Boolean)].join(" ").trim();
		}
	}
	return { fields, body };
}

/** YAML line folding inside quotes: one line break is a space, each empty line a newline, and `\` ends a line without a space. */
function foldQuoted(inner: string, double: boolean): string {
	const lines = inner.split("\n");
	let out = "", pending = "";
	lines.forEach((line, k) => {
		let part = k > 0 ? line.replace(/^[ \t]+/, "") : line;
		const last = k === lines.length - 1;
		if (!last && double && /(?:^|[^\\])(?:\\\\)*\\$/.test(part)) {
			out += pending + part.slice(0, -1);
			pending = "";
			return;
		}
		if (!last) part = part.replace(/[ \t]+$/, "");
		if (k > 0 && !part && !last) { pending = pending === " " ? "\n" : `${pending}\n`; return; }
		out += pending + part;
		pending = last ? "" : " ";
	});
	return out;
}

function parseFlag(value: string | undefined, key: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const v = value.trim().toLowerCase();
	if (["true", "yes", "on", "1"].includes(v)) return true;
	if (["false", "no", "off", "0"].includes(v)) return false;
	throw new SkillFormatError(`${key} 必须是布尔值`);
}

function validNameAndDescription(name: string | undefined, description: string | undefined): { name: string; description: string } {
	if (!name || name.length > SKILL_LIMITS.name || !SKILL_NAME.test(name)) throw new SkillFormatError(`技能名无效：${JSON.stringify(name ?? "")}（小写字母、数字和单个连字符，最多 64 个字符）`);
	const text = (description ?? "").replace(/\s+/g, " ").trim();
	if (!text || text.length > SKILL_LIMITS.description) throw new SkillFormatError(`技能 ${name} 的 description 必须是 1–1024 个字符`);
	return { name, description: text };
}

/**
 * Directories searched for project skills: `.mountains/skills` and `.agents/skills` in the workspace
 * and its ancestors up to the repository root. Without a repository only the workspace itself counts.
 */
export function projectSkillRoots(workspaceRoot: string): SkillRoot[] {
	const start = resolve(workspaceRoot);
	const chain: string[] = [];
	let dir = start, gitRoot: string | null = null;
	for (;;) {
		chain.push(dir);
		if (existsSync(join(dir, ".git"))) { gitRoot = dir; break; }
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const dirs = gitRoot ? chain : [start];
	return dirs.flatMap(d => [{ dir: join(d, ".mountains", "skills"), source: "project" as const }, { dir: join(d, ".agents", "skills"), source: "project" as const }]);
}

/** Find skills in the given roots (earlier roots win a name collision), then the built-in ones. */
export function discoverSkills(roots: readonly SkillRoot[], builtin: readonly BuiltinSkill[] = []): { skills: SkillEntry[]; warnings: string[] } {
	const skills: SkillEntry[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	const add = (entry: SkillEntry, where: string) => {
		if (seen.has(entry.name)) { warnings.push(`技能 ${entry.name} 重名，保留先找到的那个，忽略 ${where}`); return; }
		seen.add(entry.name);
		skills.push(entry);
	};
	for (const root of roots) {
		let names: string[];
		try { names = readdirSync(root.dir).sort(); }
		catch { continue; } // A missing root is an ordinary empty state.
		for (const child of names) {
			if (child.startsWith(".")) continue;
			const dir = join(root.dir, child);
			const file = join(dir, "SKILL.md");
			try {
				if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
				const st = statSync(file);
				if (!st.isFile() || st.size > SKILL_LIMITS.bodyBytes) throw new SkillFormatError("SKILL.md 不是普通文件或超过 256KB");
				const { fields } = parseSkillFile(readFileSync(file, "utf8"));
				const { name, description } = validNameAndDescription(fields.name, fields.description);
				if (name !== child) warnings.push(`技能 ${name} 的文件夹名是 ${child}；建议保持一致`);
				add({ name, description, source: root.source, dir: realpathSync(dir), file: realpathSync(file),
					modelInvocable: !parseFlag(fields["disable-model-invocation"], "disable-model-invocation", false),
					userInvocable: parseFlag(fields["user-invocable"], "user-invocable", true) }, file);
			} catch (error) {
				warnings.push(`跳过 ${file}：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	for (const b of builtin) {
		try {
			const { name, description } = validNameAndDescription(b.name, b.description);
			add({ name, description, source: "builtin", dir: null, file: null, modelInvocable: b.modelInvocable ?? true, userInvocable: b.userInvocable ?? true, builtin: b }, "内置技能");
		} catch (error) { warnings.push(`跳过内置技能 ${b.name}：${error instanceof Error ? error.message : String(error)}`); }
	}
	return { skills, warnings };
}

/**
 * `*` matches any run of characters; the last matching pattern wins. Project skills default to ask.
 * Asking is a high-risk approval: someone (the user or the approval model) must say yes, so a run with
 * no one to ask does not load the skill.
 */
export function skillPermission(entry: SkillEntry, permissions: Readonly<Record<string, SkillPermission>> = {}): SkillPermission {
	let mode: SkillPermission = entry.source === "project" ? "ask" : "allow";
	for (const [pattern, value] of Object.entries(permissions)) {
		const re = new RegExp(`^${pattern.split("*").map(p => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		if (re.test(entry.name)) mode = value;
	}
	return mode;
}

/** The instructions of a skill, read again on every load so edits apply without a restart. */
export function skillBody(entry: SkillEntry): string {
	if (entry.builtin) return entry.builtin.body;
	const st = statSync(entry.file!);
	if (!st.isFile() || st.size > SKILL_LIMITS.bodyBytes) throw new Error("SKILL.md 不是普通文件或超过 256KB");
	return parseSkillFile(readFileSync(entry.file!, "utf8")).body.trim();
}

/** Bundled files, relative to the skill directory, for the model to ask for by path. */
export function skillFiles(entry: SkillEntry): string[] {
	if (!entry.dir) return [];
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		let names: string[];
		try { names = readdirSync(dir).sort(); } catch { return; }
		for (const n of names) {
			if (out.length >= SKILL_LIMITS.listedFiles || n.startsWith(".")) continue;
			const p = join(dir, n);
			let st;
			try { st = lstatSync(p); } catch { continue; }
			if (st.isDirectory() && depth < 3) walk(p, depth + 1);
			else if (st.isFile() && !(depth === 0 && n === "SKILL.md")) out.push(relative(entry.dir!, p).split(sep).join("/"));
		}
	};
	walk(entry.dir, 0);
	return out;
}

/** What a load returns, whether the model or the user asked for the skill. */
export function renderSkillContent(entry: SkillEntry, body: string): string {
	const files = skillFiles(entry);
	return `<skill_content name="${entry.name}">\n` +
		(entry.dir ? `Skill directory: ${entry.dir}\nBundled files (load one with the skill tool's file parameter; run scripts from this directory):${files.length ? `\n${files.map(f => `- ${f}`).join("\n")}${files.length >= SKILL_LIMITS.listedFiles ? "\n- …" : ""}` : " none"}\n\n` : "") +
		`${body}\n</skill_content>`;
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Skills the model may see and load: model-invocable and not denied. */
export function modelSkills(skills: readonly SkillEntry[], permissions: Readonly<Record<string, SkillPermission>> = {}): SkillEntry[] {
	return skills.filter(s => s.modelInvocable && skillPermission(s, permissions) !== "deny");
}

function fail(message: string, details: Record<string, unknown> = {}): ToolResult {
	return { ok: false, modelContent: `Skill not loaded: ${message}`, summary: `技能未加载：${message}`, details: { ...details, error: message } };
}

/** Read a bundled file without leaving the skill directory, symbolic links included. */
function readBundledFile(entry: SkillEntry, path: string): string {
	if (!entry.dir) throw new Error("built-in skills have no bundled files");
	if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("file must be a path inside the skill directory");
	const target = resolve(entry.dir, path);
	const real = realpathSync(target);
	if (real !== entry.dir && !real.startsWith(entry.dir + sep)) throw new Error("file leaves the skill directory");
	const st = statSync(real);
	if (!st.isFile()) throw new Error("file is not a regular file");
	if (st.size > SKILL_LIMITS.fileBytes) throw new Error("file is larger than 256KB; run or read it from the skill directory instead");
	const bytes = readFileSync(real);
	const text = bytes.toString("utf8");
	if (text.includes("\uFFFD") && Buffer.compare(Buffer.from(text, "utf8"), bytes) !== 0) throw new Error("file is not UTF-8 text");
	return text;
}

/** The model-facing `skill` tool; its description carries the catalog. */
export function createSkillTool(skills: readonly SkillEntry[], permissions: Readonly<Record<string, SkillPermission>> = {}, userLoaded: ReadonlySet<string> = new Set()): ToolDefinition {
	const listed = modelSkills(skills, permissions);
	const approved = new Set<string>();
	const catalog = listed.map(s => `  <skill>\n    <name>${s.name}</name>\n    <description>${escapeText(s.description)}</description>\n  </skill>`).join("\n");
	return {
		name: "skill",
		logicalName: "skill.load",
		readOnly: true,
		description: listed.length
			? "Load a skill: instructions, and sometimes files, for a specific kind of task. Before working on a task that matches a skill below, load it and follow its instructions; never act on the description alone. To read one of a skill's bundled files, pass its path as file.\n" +
				`<available_skills>\n${catalog}\n</available_skills>`
			: "Read a bundled file of a skill the user loaded with /name: pass the skill's name, and the file's path relative to the skill directory as file.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: listed.length ? "Exact skill name from available_skills" : "Exact name of a skill the user loaded" },
				file: { type: "string", description: "Optional bundled file, relative to the skill directory" },
			},
			required: ["name"],
			additionalProperties: false,
		},
		async execute(args, ctx) {
			const name = typeof args.name === "string" ? args.name.trim() : "";
			const file = typeof args.file === "string" ? args.file.trim() : undefined;
			if (Object.keys(args).some(k => k !== "name" && k !== "file")) return fail("unknown argument");
			// A skill only the user may start is not listed, but once the user loads it its bundled files can be read.
			const entry = listed.find(s => s.name === name) ?? (userLoaded.has(name) ? skills.find(s => s.name === name && s.userInvocable && skillPermission(s, permissions) !== "deny") : undefined);
			if (!entry) return fail(`no skill named ${JSON.stringify(name)} is available`, { skill: name });
			if (file === undefined && !listed.includes(entry)) return fail(`${entry.name} is started by the user with /${entry.name}; its instructions are already in the conversation. Pass file to read one of its bundled files.`, { skill: entry.name });
			if (skillPermission(entry, permissions) === "ask" && !approved.has(entry.name) && !userLoaded.has(entry.name)) {
				const decision = await ctx.approve({
					toolCallId: ctx.toolCallId, command: `load skill ${entry.name}${entry.dir ? ` from ${entry.dir}` : ""}`, cwd: ctx.workspace.root, risk: "dangerous",
					explanation: `${entry.source === "project" ? "Project" : "This"} skill's instructions can ask the agent to run scripts or change files.`,
				});
				if (decision !== "allow") return fail(`loading ${entry.name} was not approved`, { skill: entry.name, source: entry.source });
				approved.add(entry.name);
			}
			try {
				if (file !== undefined) {
					const text = readBundledFile(entry, file);
					return { ok: true, modelContent: `<skill_file skill="${entry.name}" path="${file}">\n${text}\n</skill_file>`, summary: `读取技能 ${entry.name} 的 ${file}`, details: { skill: entry.name, source: entry.source, file } };
				}
				return { ok: true, modelContent: renderSkillContent(entry, skillBody(entry)), summary: `使用了技能：${entry.name}`, details: { skill: entry.name, source: entry.source } };
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error), { skill: entry.name });
			}
		},
	};
}

/** `/name rest` at the start of a user message, when `name` is a user-invocable skill. */
export function skillInvocation(text: string, skills: readonly SkillEntry[], permissions: Readonly<Record<string, SkillPermission>> = {}): SkillEntry | null {
	const m = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(text.trimStart());
	if (!m) return null;
	const entry = skills.find(s => s.name === m[1]);
	return entry && entry.userInvocable && skillPermission(entry, permissions) !== "deny" ? entry : null;
}
