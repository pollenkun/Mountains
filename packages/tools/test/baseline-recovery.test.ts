import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BlobStore, createCommandTool, createReadTool, defaultTools, FileStateTracker, type DefaultToolOptions, type ToolContext, type ToolDefinition, type ToolResult, Workspace } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
	const root = mkdtempSync(join(tmpdir(), "baseline-recovery-"));
	roots.push(root);
	const workspaceRoot = join(root, "work");
	mkdirSync(workspaceRoot);
	const blobs = new BlobStore(join(root, "archive"), { workspaceRoot, sessionId: "baseline-recovery" });
	const ctx: ToolContext = { workspace: new Workspace(workspaceRoot), blobs, files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "read", approve: async () => "allow" };
	return { workspaceRoot, blobs, ctx };
}

async function assertRecovery(result: ToolResult, original: Buffer, tools: ToolDefinition[], ctx: ToolContext, enabled: boolean) {
	assert.equal(result.ok, true, result.modelContent);
	assert.ok(result.fullOutputRef, "original bytes remain archived for audit in every configuration");
	assert.deepEqual(ctx.blobs!.getBytes(result.fullOutputRef), original);
	const expand = tools.find((tool) => tool.name === "context_expand");
	assert.equal(Boolean(expand), enabled);
	if (!enabled) {
		assert.doesNotMatch(result.modelContent, /context_expand|recover|base64/);
		assert.match(result.modelContent, /audit only/);
		return;
	}
	assert.match(result.modelContent, /context_expand/);
	assert.ok(result.modelContent.includes(`fullOutputRef=${result.fullOutputRef}`));
	const page = await expand!.execute({ ref: result.fullOutputRef, offsetBytes: 0, maxBytes: 32 }, ctx);
	assert.equal(page.ok, true, page.modelContent);
	const body = page.modelContent.slice(page.modelContent.indexOf("\n") + 1);
	assert.deepEqual(Buffer.from(body, page.details.encoding === "base64" ? "base64" : "utf8"), original.subarray(0, 32));
}

for (const [label, options, enabled] of [
	["default", undefined, false],
	["expand=false", { expand: false }, false],
	["expand=true", { expand: true }, true],
] as const satisfies readonly (readonly [string, DefaultToolOptions | undefined, boolean])[]) {
	test(`${label}: partial, long-line and invalid UTF-8 file output matches the registered recovery tool`, async () => {
		const { workspaceRoot, ctx } = setup();
		const tools = defaultTools(options);
		assert.deepEqual(tools.map((tool) => tool.name), ["file_read", "content_search", "file_glob", "file_edit", "file_write", "command_run", ...(enabled ? ["context_expand"] : [])]);
		const read = tools.find((tool) => tool.name === "file_read")!;
		for (const [name, original, args, truncated] of [
			["partial", Buffer.from("first line\r\nsecond line\r\nthird line\r\n"), { endLine: 1 }, true],
			["long-line", Buffer.from("a".repeat(2100) + "\n"), {}, true],
			["invalid-utf8", Buffer.from([0x81, 0x40, 0x0d, 0x0a]), {}, false],
		] as const) {
			writeFileSync(join(workspaceRoot, `${name}.txt`), original);
			ctx.toolCallId = `read-${name}`;
			const result = await read.execute({ path: `${name}.txt`, ...args }, ctx);
			assert.equal(result.details.truncated, truncated);
			await assertRecovery(result, original, tools, ctx, enabled);
		}
	});

	test(`${label}: omitted lines, long output and invalid UTF-8 commands match the registered recovery tool`, async () => {
		const { workspaceRoot, ctx } = setup();
		const tools = defaultTools(options);
		const command = tools.find((tool) => tool.name === "command_run")!;
		for (const [name, original, truncated] of [
			["omitted-lines", Buffer.from(Array.from({ length: 200 }, (_, i) => `row ${i}\r\n`).join("")), true],
			["long-line", Buffer.from("a".repeat(13_000)), true],
			["invalid-utf8", Buffer.from([0x81, 0x40, 0x0d, 0x0a]), false],
		] as const) {
			ctx.toolCallId = `command-${name}`;
			writeFileSync(join(workspaceRoot, "output.bin"), original);
			const result = await command.execute({ argv: [process.execPath, "-e", 'process.stdout.write(require("node:fs").readFileSync("output.bin"))'] }, ctx);
			assert.equal(result.details.truncated, truncated);
			await assertRecovery(result, original, tools, ctx, enabled);
		}
	});
}

test("standalone factories retain their existing call forms without assuming a recovery tool", async () => {
	const { workspaceRoot, ctx } = setup();
	writeFileSync(join(workspaceRoot, "a.txt"), "first\nsecond\n");
	const read = await createReadTool().execute({ path: "a.txt", endLine: 1 }, ctx);
	await assertRecovery(read, Buffer.from("first\nsecond\n"), [], ctx, false);
	const raw = Buffer.from([0x81, 0x40, 0x0d, 0x0a]);
	const command = await createCommandTool().execute({ argv: [process.execPath, "-e", "process.stdout.write(Buffer.from([0x81,0x40,0x0d,0x0a]))"] }, ctx);
	await assertRecovery(command, raw, [], ctx, false);
});

test("archive failure never promises original-byte recovery even when the recovery tool is registered", async () => {
	for (const expand of [false, true]) {
		const { workspaceRoot, ctx } = setup();
		const raw = Buffer.from([0x81, 0x40, 0x0d, 0x0a]);
		writeFileSync(join(workspaceRoot, "invalid.txt"), raw);
		ctx.blobs!.put = () => { throw new Error("simulated disk failure"); };
		for (const tool of defaultTools({ expand }).filter((tool) => ["file_read", "command_run"].includes(tool.name))) {
			const args = tool.name === "file_read" ? { path: "invalid.txt" } : { argv: [process.execPath, "-e", 'process.stdout.write(require("node:fs").readFileSync("invalid.txt"))'] };
			const result = await tool.execute(args, ctx);
			assert.equal(result.ok, true, result.modelContent);
			assert.equal(result.details.invalidUtf8, true);
			assert.equal(result.fullOutputRef, undefined);
			assert.match(result.modelContent, /unavailable/);
			assert.doesNotMatch(result.modelContent, /context_expand|recover|base64|audit only|archive preserves/);
		}
	}
});
