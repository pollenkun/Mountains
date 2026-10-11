import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlanTool } from "../src/plan.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";
import { useNodeFixture } from "./helpers/node-fixture.ts";

function fixture() {
	const parent = mkdtempSync(join(tmpdir(), "mountains-plan-independent-"));
	const root = join(parent, "workspace"); mkdirSync(root);
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "independent", approve: async () => { throw new Error("Read-only query requested approval"); } };
	return { parent, root, ctx };
}

for (const suffix of [" ", "\t", "\n"]) {
	test(`literal search.path preserves trailing ${JSON.stringify(suffix)} in a filename`, { skip: process.platform === "win32" ? "Windows does not support trailing spaces or control characters in ordinary filenames" : false }, async () => {
		const { parent, root, ctx } = fixture();
		try {
			const path = `a.txt${suffix}`;
			writeFileSync(join(root, path), "NEEDLE_TARGET\n");
			writeFileSync(join(root, "a.txt"), "NEEDLE_WRONG\n");
			for (const bulkSearch of [false, true]) {
				const result = await createPlanTool({}).execute({ steps: [{ id: "find", op: "search", pattern: "NEEDLE", path }] }, ctx);
				assert.equal(result.ok, true, result.modelContent);
				assert.deepEqual((result.details.steps as { paths: string[] }[])[0]!.paths, [path], `bulkSearch=${bulkSearch}: ${result.modelContent}`);
				assert.match(result.modelContent, /NEEDLE_TARGET/);
				assert.doesNotMatch(result.modelContent, /NEEDLE_WRONG/);
			}
		} finally { rmSync(parent, { recursive: true, force: true }); }
	});
}

test("bulk search cannot bind replacement-directory contents to the observed source hash", async t => {
	const { parent, root, ctx } = fixture();
	const previous = process.env.MOUNTAINS_RG;
	try {
		mkdirSync(join(root, "src"));
		const file = join(root, "src", "a.txt"); writeFileSync(file, "SAFE_OLD\n");
		const fake = join(parent, "rg-wrapper.cjs"); useNodeFixture(t, fake);
		const held = join(parent, "held-original");
		writeFileSync(fake, `const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2), src = path.join(process.cwd(), 'src'), held = ${JSON.stringify(held)};
let moved = false;
try {
  if (args.includes('--json')) {
    fs.renameSync(src, held); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'NEEDLE_WRONG\\n'); moved = true;
  }
  const result = cp.spawnSync('rg', args, { input: fs.readFileSync(0), encoding: 'utf8' });
  if (moved) { fs.rmSync(src, { recursive: true }); fs.renameSync(held, src); moved = false; }
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exitCode = result.status ?? 2;
} finally {
  if (moved) { fs.rmSync(src, { recursive: true, force: true }); fs.renameSync(held, src); }
}
`, { mode: 0o700 });
		process.env.MOUNTAINS_RG = fake;
		const before = statSync(file, { bigint: true });
		const result = await createPlanTool({}).execute({ steps: [{ id: "find", op: "search", pattern: "NEEDLE", glob: "src/**" }] }, ctx);
		const after = statSync(file, { bigint: true });
		for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode"] as const) assert.equal(after[field], before[field], `source ${field} changed; this fixture must exercise an unchanged source fingerprint`);
		assert.equal(readFileSync(file, "utf8"), "SAFE_OLD\n");
		assert.equal(result.ok, true, result.modelContent);
		assert.deepEqual((result.details.steps as { paths: string[] }[])[0]!.paths, []);
		assert.doesNotMatch(result.modelContent, /NEEDLE_WRONG/);
	} finally {
		if (previous === undefined) delete process.env.MOUNTAINS_RG; else process.env.MOUNTAINS_RG = previous;
		rmSync(parent, { recursive: true, force: true });
	}
});
