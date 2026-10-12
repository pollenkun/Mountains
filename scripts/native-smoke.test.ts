import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnv } from "../apps/cli/test/env.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
	return result.stdout;
}

test("packed source installs and runs offline on the native host", { timeout: 240_000 }, async t => {
	// npm supplies its own entrypoint on every platform. Executing it with Node
	// avoids assuming npm is a native executable (npm.cmd is a Windows shim).
	const npm = process.env.npm_execpath;
	assert.ok(npm && existsSync(npm), "Run this smoke test with npm run test:native");
	const root = mkdtempSync(join(tmpdir(), "mountains-native-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	const source = join(root, "packed source 空间"), home = join(root, "isolated home");
	for (const dir of [source, home]) mkdirSync(dir);
	const cache = run(process.execPath, [npm, "config", "get", "cache"], ROOT).trim();
	const env = { ...isolatedEnv(home), npm_config_cache: cache, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "empty.gitconfig") };
	const main = join(source, "apps", "cli", "src", "main.ts");
	let installed = false;
	t.diagnostic(`Native host: ${process.platform}/${process.arch}, Node ${process.version}. Other operating systems are not exercised by this process; CI runs each on its own native runner.`);

	await t.test("npm pack contains the source workspace and locked offline installation succeeds", () => {
		const packed = JSON.parse(run(process.execPath, [npm, "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", root], ROOT)) as { filename: string; files: { path: string }[] }[];
		assert.equal(packed.length, 1);
		const archive = packed[0]!;
		for (const path of ["package.json", "apps/cli/src/main.ts", "packages/engine/src/index.ts", "packages/tools/src/index.ts"]) {
			assert.ok(archive.files.some(file => file.path === path), `missing packed source: ${path}`);
		}
		// Windows tar can decode argv through an ANSI code page. Let Node set the
		// Unicode working directory and give tar only a relative ASCII archive path.
		run("tar", ["-xzf", join("..", archive.filename), "--strip-components=1"], source);
		// This private project documents installation from source. npm deliberately
		// omits package-lock.json from tarballs; retain the checkout's exact lockfile
		// rather than resolving newer versions or pretending this is a registry package.
		copyFileSync(join(ROOT, "package-lock.json"), join(source, "package-lock.json"));
		run(process.execPath, [npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], source, env);
		assert.deepEqual(readFileSync(join(source, "package-lock.json")), readFileSync(join(ROOT, "package-lock.json")));
		assert.ok(existsSync(join(source, "node_modules", ".bin", process.platform === "win32" ? "mountains.cmd" : "mountains")));
		installed = true;
	});

	// Reject model/network access even if replay accidentally starts using a live
	// adapter. No credentials, user config, original home or NODE_OPTIONS propagate.
	const preload = join(root, "offline-only.mjs");
	writeFileSync(preload, `import net from "node:net";
const blocked = () => { throw new Error("Native smoke test forbids network access"); };
globalThis.fetch = blocked;
net.Socket.prototype.connect = blocked;
`);
	const cli = (args: string[]) => run(process.execPath, ["--import", pathToFileURL(preload).href, main, ...args], source, env);

	const skip = installed ? false : "Packed-source installation failed; dependent CLI checks were not run";
	await t.test("help and version work without credentials through both source and installed bin", { skip }, () => {
		const cleanHome = join(root, "help home"); mkdirSync(cleanHome);
		const helpEnv = isolatedEnv(cleanHome);
		for (const args of [["--help"], ["run", "--help"], ["replay", "--help"]]) {
			assert.match(run(process.execPath, [main, ...args], source, helpEnv), /mountains run[\s\S]*mountains replay/);
		}
		const { version } = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version: string };
		assert.equal(run(process.execPath, [main, "--version"], source, helpEnv), `mountains ${version}\n`);
		assert.deepEqual(readdirSync(cleanHome), [], "help and version must not create state or caches");
		// npm exec resolves the newly installed local bin and its OS-specific shim.
		assert.equal(run(process.execPath, [npm, "exec", "--offline", "--", "mountains", "--version"], source, env), `mountains ${version}\n`);
	});

	await t.test("offline CLI startup reads, edits, writes and searches real Unicode/space paths", { skip }, () => {
		const workspace = join(root, "task workspace 山"), out = join(root, "run output");
		mkdirSync(workspace);
		const filename = "source 文件.ts", written = "结果 summary.txt";
		const original = "export function answer(): { value: number } {\r\n\treturn { value: 41 };\r\n}\r\n";
		writeFileSync(join(workspace, filename), original);
		const calls = [
			{ id: "read", name: "file_read", args: { path: filename } },
			{ id: "edit", name: "file_edit", args: { path: filename, oldText: "value: 41", newText: "value: 42" } },
			{ id: "write", name: "file_write", args: { path: written, content: "native smoke OK\n" } },
			{ id: "search", name: "query_plan", args: { steps: [
				{ id: "find", op: "search", pattern: "value: 42", glob: "*.ts" },
				{ id: "body", op: "read", path: { from: "find", expect: "one" }, force: true },
			] } },
		];
		const response = (call?: typeof calls[number]) => ({ kind: "model.response", data: {
			ok: true, message: { role: "assistant", content: call ? "" : "Native offline smoke complete.", reasoning: "", toolCalls: call ? [{ id: call.id, name: call.name, argumentsJson: JSON.stringify(call.args) }] : [] },
			finishReason: call ? "tool_calls" : "stop", responseModel: "deepseek-flash",
			rawUsage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 1, total_tokens: 11 },
			httpStatus: 200, error: null, aborted: false,
		} });
		const recording = join(root, "offline recording.jsonl");
		writeFileSync(recording, [
			{ kind: "meta", data: { model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64 } },
			{ kind: "user.input", data: { task: "Read the source, change 41 to 42, write the summary and verify the function with a search." } },
			...calls.map(call => response(call)), response(),
		].map(row => JSON.stringify(row)).join("\n") + "\n");
		const summary = JSON.parse(cli(["replay", "--recording", recording, "--workspace", workspace, "--out", out, "--json"]));
		assert.equal(summary.status, "completed");
		assert.equal(summary.finalText, "Native offline smoke complete.");
		assert.equal(summary.totals.requests, calls.length + 1);
		assert.deepEqual(summary.filesChanged.toSorted(), [filename, written].toSorted());
		assert.equal(readFileSync(join(workspace, filename), "utf8"), original.replace("value: 41", "value: 42"), "editing must preserve CRLF");
		assert.equal(readFileSync(join(workspace, written), "utf8"), "native smoke OK\n");
		const events = readFileSync(join(out, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		const completed = events.filter(event => event.type === "tool.completed");
		assert.deepEqual(completed.map(event => [event.toolCallId, event.ok]), calls.map(call => [call.id, true]), JSON.stringify(completed, null, 2));
		const rows = readFileSync(join(out, "recording.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		const search = rows.find(row => row.kind === "tool.output" && row.data.toolCallId === "search");
		assert.match(search?.data.modelContent ?? "", /return \{ value: 42 \}/, "search-dependent read must return the updated source");
		for (const file of ["recording.jsonl", "ledger.jsonl", "summary.json"]) assert.ok(readFileSync(join(out, file), "utf8").length > 0, file);
		assert.ok(!existsSync(join(workspace, ".mountains")), "runtime storage must stay outside the task workspace");
	});
});
