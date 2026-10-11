import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlanTool, executeQueryPlan, publishQueryResult } from "../src/plan.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";

function setup(t: { after(callback: () => void): void }) {
	const parent = mkdtempSync(join(tmpdir(), "mountains-plan-review-"));
	const root = join(parent, "workspace"); mkdirSync(root);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "independent-review", approve: async () => { throw new Error("read only"); } };
	return { parent, root, ctx };
}

test("unsupported Python symbol syntax is a local failure and preserves independent source", async t => {
	const { root, ctx } = setup(t);
	writeFileSync(join(root, "first.txt"), "FIRST_SAFE_SOURCE\n");
	writeFileSync(join(root, "last.txt"), "LAST_SAFE_SOURCE\n");
	writeFileSync(join(root, "target.py"), 'def target(item):\n    return f"""value {item}"""\n');
	const result = await createPlanTool({}).execute({ steps: [
		{ id: "first", op: "read", path: "first.txt" },
		{ id: "unsupported", op: "read", path: "target.py", symbol: "target" },
		{ id: "last", op: "read", path: "last.txt" },
	] }, ctx);
	assert.equal(result.details.partial, true, result.modelContent);
	assert.match(result.modelContent, /FIRST_SAFE_SOURCE/);
	assert.match(result.modelContent, /LAST_SAFE_SOURCE/);
	assert.deepEqual(result.reads?.map(read => read.path), ["first.txt", "last.txt"]);
	assert.equal(ctx.files.get("target.py"), undefined);
});

test("a failed step's observed file still participates in final synchronous validation", async t => {
	const { root, ctx } = setup(t);
	writeFileSync(join(root, "safe.txt"), "SAFE_SOURCE\n");
	writeFileSync(join(root, "bad.json"), "not-json\n");
	const result = await executeQueryPlan({ steps: [
		{ id: "safe", op: "read", path: "safe.txt" },
		{ id: "bad", op: "json_field", path: "bad.json", field: ["value"] },
	] }, ctx, {});
	assert.equal(result.details.partial, true, result.modelContent);
	assert.equal(ctx.files.get("safe.txt"), undefined, "execute must not publish before the caller commits the output");
	writeFileSync(join(root, "bad.json"), '{"value": 2}\n');
	assert.throws(() => publishQueryResult(result, ctx), /Source changed/);
	assert.equal(ctx.files.get("safe.txt"), undefined);
});

