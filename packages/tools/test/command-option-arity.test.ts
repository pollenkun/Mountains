import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCommandTool, classifyRisk, DEFAULT_COMMAND_LIMITS } from "../src/command.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";
import type { Risk, ToolContext } from "../src/types.ts";

for (const option of ["-r", "-E", "-M", "-e", "--replace", "--encoding", "--max-columns"]) {
 test(`rg ${option} cannot consume the claimed no-config flag as its value`, () => {
  assert.equal(classifyRisk(["rg", option, "--no-config", "needle", "target"]), "workspace-write");
 });
}
test("known value options consume their operand before considering later flags", () => {
 assert.equal(classifyRisk(["rg", "-rreplacement", "--no-config", "needle", "target"]), "read-only");
 assert.equal(classifyRisk(["grep", "-D", "read", "needle", "target"]), "read-only");
 assert.equal(classifyRisk(["tree", "-H", "https://example.invalid", "--filelimit", "20", "."]), "read-only");
});
test("read-only approval rejects a configured rg preprocessor hidden by replacement option arity", { skip: process.platform === "win32" }, async t => {
 const root = mkdtempSync(join(tmpdir(), "mountains-option-arity-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const work = join(root, "work"); mkdirSync(work); writeFileSync(join(work, "target"), "needle\n");
 const marker = join(root, "marker"), preprocessor = join(root, "preprocessor.cjs"), config = join(root, "rg-config");
 writeFileSync(preprocessor, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'fixture');process.stdout.write('needle\\n');`, { mode: 0o700 });
 writeFileSync(config, `--pre\n${preprocessor}\n`);
 const risks: Risk[] = [];
 const ctx: ToolContext = { workspace: new Workspace(work), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "arity", approve: async req => { risks.push(req.risk); return req.risk === "read-only" ? "allow" : "deny"; } };
 const tool = createCommandTool(DEFAULT_COMMAND_LIMITS, {}, { environment: { ...process.env, RIPGREP_CONFIG_PATH: config }, probeLinuxScope: async () => false });
 const denied = await tool.execute({ argv: ["rg", "-r", "--no-config", "needle", "target"] }, ctx);
 assert.equal(denied.ok, false); assert.equal(denied.details.approved, false); assert.equal(risks[0], "workspace-write"); assert.equal(existsSync(marker), false);
 const allowed = await tool.execute({ argv: ["rg", "--no-config", "-r", "replacement", "needle", "target"] }, ctx);
 assert.equal(allowed.ok, true, allowed.modelContent); assert.equal(existsSync(marker), false); assert.equal(risks[1], "read-only");
});
