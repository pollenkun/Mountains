import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { installSkillSources, skillRemote } from "../src/index.ts";

const exec = promisify(execFile);

function temp(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "mountains-install-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeSkill(dir: string, name: string, extra = ""): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use ${name}.\n---\n${extra || "Follow this."}\n`);
	writeFileSync(join(dir, "note.txt"), "bundled");
}

test("a SKILL.md file and a folder of skills install under their names", async t => {
	const root = temp(t);
	const file = join(root, "one");
	writeSkill(file, "alpha-skill");
	const many = join(root, "many");
	writeSkill(join(many, "beta-skill"), "beta-skill");
	writeSkill(join(many, "gamma-skill"), "gamma-skill", "Second.");
	const dest = join(root, "installed");
	const fromFile = await installSkillSources({ paths: [join(file, "SKILL.md")], dest });
	assert.deepEqual(fromFile.installed.map(skill => skill.name), ["alpha-skill"]);
	assert.equal(readFileSync(join(dest, "alpha-skill", "note.txt"), "utf8"), "bundled");
	const fromDir = await installSkillSources({ paths: [many], dest });
	assert.deepEqual(fromDir.installed.map(skill => skill.name).sort(), ["beta-skill", "gamma-skill"]);
	assert.equal(fromDir.failed.length, 0);
	const plain = await installSkillSources({ paths: [join(root, "missing.md")], text: "hello https://example.com/page", dest });
	assert.deepEqual(plain, { installed: [], failed: [] });
});

test("a message can carry a local skill path, and a zip without a skill is left alone", async t => {
	const root = temp(t);
	const skill = join(root, "delta-skill");
	writeSkill(skill, "delta-skill");
	const dest = join(root, "installed");
	const report = await installSkillSources({ text: `装上 ${join(skill, "SKILL.md")} 谢谢`, dest });
	assert.equal(report.installed[0]?.name, "delta-skill");
	const zip = join(root, "notes.zip");
	writeFileSync(join(root, "notes.txt"), "just notes");
	await exec("tar", ["-cf", zip, "-C", root, "notes.txt"]);
	const packed = await installSkillSources({ paths: [zip], dest });
	assert.deepEqual(packed.installed, []);
	assert.deepEqual(packed.failed, []);
});

test("skill links are GitHub repositories, files, and raw skill documents", () => {
	assert.deepEqual(skillRemote("https://github.com/acme/skills"), { kind: "github", owner: "acme", repo: "skills" });
	assert.deepEqual(skillRemote("https://github.com/acme/skills/tree/main/tools/pdf"), { kind: "github", owner: "acme", repo: "skills", ref: "main", path: "tools/pdf" });
	assert.deepEqual(skillRemote("https://github.com/acme/skills/blob/main/tools/pdf/SKILL.md"), { kind: "github", owner: "acme", repo: "skills", ref: "main", path: "tools/pdf/SKILL.md" });
	assert.deepEqual(skillRemote("https://raw.githubusercontent.com/acme/skills/main/SKILL.md"), { kind: "github", owner: "acme", repo: "skills", ref: "main", path: "SKILL.md" });
	assert.equal(skillRemote("https://example.com/skills/SKILL.md")?.kind, "file");
	assert.equal(skillRemote("https://github.com/acme/skills/issues/3"), null);
	assert.equal(skillRemote("http://github.com/acme/skills"), null);
});
