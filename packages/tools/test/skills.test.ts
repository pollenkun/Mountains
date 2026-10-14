import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createSkillTool, discoverSkills, parseSkillFile, projectSkillRoots, skillInvocation, skillPermission, type ApprovalRequest, type SkillRoot, type ToolContext } from "../src/index.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";

function temp(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "mountains-skills-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function skill(root: string, folder: string, frontmatter: string, body = "Do the thing.", files: Record<string, string> = {}): string {
	const dir = join(root, folder);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}
function context(root: string, approve: (req: ApprovalRequest) => Promise<"allow" | "deny"> = async () => "allow"): ToolContext {
	return { workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "call-1", approve };
}

test("frontmatter: plain, quoted, folded and literal values; nested maps are skipped; CRLF and BOM are accepted", () => {
	const { fields, body } = parseSkillFile("﻿---\r\nname: pdf-tools\r\ndescription: >\r\n  Extract text\r\n  from PDFs.\r\nlicense: \"MIT\"\r\nnote: 'it''s'\r\nliteral: |\r\n  a\r\n  b\r\nmetadata:\r\n  opencode/slash: \"true\"\r\n---\r\n\r\n# Body\r\n");
	assert.deepEqual(fields, { name: "pdf-tools", description: "Extract text from PDFs.", license: "MIT", note: "it's", literal: "a\nb" });
	assert.equal(body.trim(), "# Body");
	assert.throws(() => parseSkillFile("# no frontmatter"), /frontmatter/);
	assert.throws(() => parseSkillFile("---\nname: \"open\n---\n"), /引号/);
});

test("discovery: earlier roots win a name, invalid skills are skipped with a reason, invocation flags are read", t => {
	const dir = temp(t);
	const project = join(dir, "project"), user = join(dir, "user");
	skill(project, "review", "name: review\ndescription: Review a change against the team checklist.");
	skill(user, "review", "name: review\ndescription: The user's own review skill.");
	skill(user, "Bad_Name", "name: Bad_Name\ndescription: x");
	skill(user, "quiet", "name: quiet\ndescription: Only when asked.\ndisable-model-invocation: true");
	skill(user, "strange", "name: strange\ndescription: Bad flag.\nuser-invocable: maybe");
	skill(user, "other-folder", "name: renamed\ndescription: Folder and name differ.");
	writeFileSync(join(user, "loose.md"), "not a skill directory");
	const roots: SkillRoot[] = [{ dir: project, source: "project" }, { dir: user, source: "user" }, { dir: join(dir, "missing"), source: "user" }];
	const { skills, warnings } = discoverSkills(roots, [{ name: "make-theme", description: "Create a Mountains theme file.", body: "Theme steps." }]);
	assert.deepEqual(skills.map(s => `${s.source}:${s.name}`), ["project:review", "user:renamed", "user:quiet", "builtin:make-theme"]);
	assert.equal(skills.find(s => s.name === "quiet")!.modelInvocable, false);
	assert.ok(warnings.some(w => /重名/.test(w)));
	assert.ok(warnings.some(w => /Bad_Name/.test(w)));
	assert.ok(warnings.some(w => /user-invocable/.test(w)));
	assert.ok(warnings.some(w => /文件夹名是 other-folder/.test(w)));
});

test("project roots: the workspace and its ancestors up to the repository root; without a repository only the workspace", t => {
	const dir = temp(t);
	const repo = join(dir, "repo"), ws = join(repo, "packages", "app");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(ws, { recursive: true });
	const roots = projectSkillRoots(ws).map(r => r.dir);
	assert.deepEqual(roots, [ws, join(repo, "packages"), repo].flatMap(d => [join(d, ".mountains", "skills"), join(d, ".agents", "skills")]));
	const loose = join(dir, "loose");
	mkdirSync(loose);
	assert.deepEqual(projectSkillRoots(loose).map(r => r.dir), [join(loose, ".mountains", "skills"), join(loose, ".agents", "skills")]);
});

test("permissions: project skills ask by default, others allow; the last matching pattern wins", () => {
	const project = { name: "deploy-prod", description: "d", source: "project" as const, dir: "/x", file: "/x/SKILL.md", modelInvocable: true, userInvocable: true };
	const user = { ...project, source: "user" as const };
	assert.equal(skillPermission(project), "ask");
	assert.equal(skillPermission(user), "allow");
	assert.equal(skillPermission(project, { "deploy-*": "deny", "deploy-prod": "allow" }), "allow");
	assert.equal(skillPermission(user, { "*": "deny" }), "deny");
});

test("the skill tool lists only loadable skills, escapes descriptions, loads instructions and bundled files", async t => {
	const dir = temp(t);
	const root = join(dir, "skills");
	skill(root, "pdf-tools", "name: pdf-tools\ndescription: Read <PDF> & convert it.", "Read references/formats.md first.", { "references/formats.md": "Formats here.", "scripts/run.sh": "echo hi" });
	skill(root, "hidden", "name: hidden\ndescription: Denied skill.");
	skill(root, "manual", "name: manual\ndescription: User only.\ndisable-model-invocation: true");
	writeFileSync(join(dir, "secret.txt"), "outside");
	symlinkSync(join(dir, "secret.txt"), join(root, "pdf-tools", "link.txt"));
	const { skills } = discoverSkills([{ dir: root, source: "user" }]);
	const tool = createSkillTool(skills, { hidden: "deny" });
	assert.match(tool.description, /<name>pdf-tools<\/name>\n    <description>Read &lt;PDF&gt; &amp; convert it\.<\/description>/);
	assert.doesNotMatch(tool.description, /hidden|manual/);
	const ctx = context(dir);
	const loaded = await tool.execute({ name: "pdf-tools" }, ctx);
	assert.equal(loaded.ok, true, loaded.modelContent);
	assert.match(loaded.modelContent, /^<skill_content name="pdf-tools">\nSkill directory: .*pdf-tools\n/);
	assert.match(loaded.modelContent, /- references\/formats\.md\n- scripts\/run\.sh\n/);
	assert.match(loaded.modelContent, /Read references\/formats\.md first\.\n<\/skill_content>$/);
	const file = await tool.execute({ name: "pdf-tools", file: "references/formats.md" }, ctx);
	assert.equal(file.modelContent, '<skill_file skill="pdf-tools" path="references/formats.md">\nFormats here.\n</skill_file>');
	for (const bad of ["../secret.txt", "/etc/passwd", "link.txt"]) assert.equal((await tool.execute({ name: "pdf-tools", file: bad }, ctx)).ok, false, bad);
	assert.equal((await tool.execute({ name: "hidden" }, ctx)).ok, false);
	assert.equal((await tool.execute({ name: "manual" }, ctx)).ok, false);
	assert.equal((await tool.execute({ name: "pdf-tools", extra: 1 }, ctx)).ok, false);
});

test("a skill that asks is approved once per session; a denial loads nothing", async t => {
	const dir = temp(t);
	const root = join(dir, "skills");
	skill(root, "release", "name: release\ndescription: Cut a release.", "Run the release script.");
	const { skills } = discoverSkills([{ dir: root, source: "project" }]);
	const requests: ApprovalRequest[] = [];
	const allow = createSkillTool(skills);
	const ctx = context(dir, async req => { requests.push(req); return "allow"; });
	assert.equal((await allow.execute({ name: "release" }, ctx)).ok, true);
	assert.equal((await allow.execute({ name: "release" }, ctx)).ok, true);
	assert.equal(requests.length, 1);
	assert.match(requests[0]!.command, /^load skill release from /);
	const denied = await createSkillTool(skills).execute({ name: "release" }, context(dir, async () => "deny"));
	assert.equal(denied.ok, false);
	assert.doesNotMatch(denied.modelContent, /Run the release script/);
});

test("/name at the start of a message names a user-invocable skill; other text does not", t => {
	const dir = temp(t);
	const root = join(dir, "skills");
	skill(root, "pdf-tools", "name: pdf-tools\ndescription: PDFs.");
	skill(root, "auto-only", "name: auto-only\ndescription: Model only.\nuser-invocable: false");
	const { skills } = discoverSkills([{ dir: root, source: "user" }]);
	assert.equal(skillInvocation("/pdf-tools extract report.pdf", skills)?.name, "pdf-tools");
	assert.equal(skillInvocation("  /pdf-tools", skills)?.name, "pdf-tools");
	assert.equal(skillInvocation("please /pdf-tools", skills), null);
	assert.equal(skillInvocation("/pdf-toolsX", skills), null);
	assert.equal(skillInvocation("/auto-only now", skills), null);
	assert.equal(skillInvocation("/pdf-tools", skills, { "pdf-*": "deny" }), null);
});
