import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnv } from "./env.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 10, total_tokens: 110 };
type Call = { id: string; name: string; args: Record<string, unknown> };
type Row = { kind: string; data: Record<string, unknown> };

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-practical-cli-"));
	const children: { child: ChildProcess; done: Promise<unknown> }[] = [];
	t.after(async () => {
		for (const { child, done } of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			await done.catch(() => {});
		}
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	const home = join(root, "home"), workspace = join(root, "任务 workspace");
	mkdirSync(home); mkdirSync(workspace);
	const offline = join(root, "offline.mjs");
	writeFileSync(offline, `import net from "node:net";\nconst blocked = () => { throw new Error("Offline workflow forbids network access"); };\nglobalThis.fetch = blocked;\nnet.Socket.prototype.connect = blocked;\n`);
	const env = { ...isolatedEnv(home), NODE_DISABLE_COMPILE_CACHE: "1", MOUNTAINS_BUDGET_USD: "5",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "empty.gitconfig") };
	return { root, workspace, env, offline, children };
}

function runCli(f: ReturnType<typeof fixture>, args: string[], offline = true) {
	const child = spawn(process.execPath, [...(offline ? ["--import", pathToFileURL(f.offline).href] : []), MAIN, ...args], {
		cwd: f.workspace, env: f.env, stdio: ["ignore", "pipe", "pipe"], timeout: 45_000, killSignal: "SIGKILL",
	});
	let stdout = "", stderr = "", failure: Error | undefined;
	child.stdout.on("data", chunk => { stdout += chunk; });
	child.stderr.on("data", chunk => { stderr += chunk; });
	child.on("error", error => { failure = error; });
	const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
		child.once("close", (code, signal) => failure ? reject(failure) : resolve({ code, signal, stdout, stderr }));
	});
	f.children.push({ child, done });
	return { child, done };
}

function recorded(call?: Call) {
	return { kind: "model.response", data: { ok: true,
		message: { role: "assistant", content: call ? "" : "已验证 fixture，工作完成。", reasoning: "", toolCalls: call ? [{ id: call.id, name: call.name, argumentsJson: JSON.stringify(call.args) }] : [] },
		finishReason: call ? "tool_calls" : "stop", responseModel: "deepseek-flash", rawUsage: usage, httpStatus: 200, error: null, aborted: false } };
}

function recording(path: string, task: string, calls: Call[]) {
	writeFileSync(path, [
		{ kind: "meta", data: { model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 128 } },
		{ kind: "user.input", data: { task } }, ...calls.map(call => recorded(call)), recorded(),
	].map(row => JSON.stringify(row)).join("\n") + "\n");
}

function rows(path: string): Row[] { return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Row); }

async function untilCreated(path: string, child: ChildProcess) {
	const deadline = Date.now() + 20_000;
	while (!existsSync(path)) {
		assert.equal(child.exitCode, null, "CLI exited before the fixture command became ready");
		assert.ok(Date.now() < deadline, "fixture command did not become ready");
		await delay(20);
	}
}

test("task-file CLI repairs a failing local project through mock HTTP and its recording replays identically offline", { timeout: 60_000 }, async t => {
	const f = fixture(t), out = join(f.root, "run output");
	const source = "sum 文件.cjs", check = "check fixture.cjs", report = "验证说明.md";
	const seed = (workspace: string) => {
		writeFileSync(join(workspace, source), "exports.sum = (a, b) => a - b;\r\n");
		writeFileSync(join(workspace, check), `const assert = require("node:assert/strict"); const { sum } = require(${JSON.stringify(`./${source}`)}); for (const [a,b] of [[2,3],[-4,9],[0,0]]) assert.equal(sum(a,b), a+b); console.log("fixture checks passed");\n`);
	};
	seed(f.workspace);
	const task = "修复 sum 文件.cjs，先运行检查，再修改并复查；保留换行，写验证说明。";
	const taskFile = join(f.root, "今日任务.md"); writeFileSync(taskFile, task);
	const calls: Call[] = [
		{ id: "inspect", name: "file_read", args: { path: source } },
		{ id: "failing-check", name: "command_run", args: { argv: [process.execPath, check], timeoutMs: 10_000 } },
		{ id: "repair", name: "file_edit", args: { path: source, oldText: "a - b", newText: "a + b" } },
		{ id: "passing-check", name: "command_run", args: { argv: [process.execPath, check], timeoutMs: 10_000 } },
		{ id: "report", name: "file_write", args: { path: report, content: "# 验证\n三个本地边界例子已通过。\n" } },
	];
	const requests: Record<string, unknown>[] = [], errors: string[] = [];
	const responses = [...calls.map(call => recorded(call).data), recorded().data];
	const server = http.createServer(async (request, response) => {
		try {
			let body = ""; for await (const chunk of request) body += chunk;
			requests.push(JSON.parse(body) as Record<string, unknown>);
			const next = responses.shift(); assert.ok(next, "unexpected extra model request");
			const call = next.message.toolCalls[0];
			const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: call.argumentsJson } }] } : { content: next.message.content };
			const chunks = [ { choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: next.finishReason }], usage } ];
			const bytes = Buffer.from(chunks.map(chunk => `data: ${JSON.stringify({ model: "deepseek-flash", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n");
			response.writeHead(200, { "content-type": "text/event-stream" });
			// Fixed byte chunks can split Chinese UTF-8 and JSON argument strings.
			for (let start = 0; start < bytes.length; start += 37) { response.write(bytes.subarray(start, start + 37)); await delay(0); }
			response.end();
		} catch (error) { errors.push(String(error)); response.destroy(); }
	});
	t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address === "object");
	const result = await runCli(f, ["run", "--task-file", taskFile, "--workspace", f.workspace, "--out", out, "--json", "--base-url", `http://127.0.0.1:${address.port}`], false).done;
	assert.equal(result.code, 0, result.stderr); assert.deepEqual(errors, []); assert.equal(responses.length, 0);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.status, "completed"); assert.equal(summary.totals.requests, calls.length + 1);
	assert.deepEqual(summary.filesChanged.toSorted(), [source, report].toSorted());
	assert.equal(readFileSync(join(f.workspace, source), "utf8"), "exports.sum = (a, b) => a + b;\r\n");
	assert.ok(JSON.stringify(requests[0]).includes(task), "the task-file text must reach the adapter");
	const outputs = rows(join(out, "recording.jsonl")).filter(row => row.kind === "tool.output");
	assert.deepEqual(outputs.map(row => [row.data.toolCallId, row.data.ok]), calls.map(call => [call.id, call.id !== "failing-check"]));
	assert.match(String(outputs.find(row => row.data.toolCallId === "passing-check")?.data.modelContent), /fixture checks passed/);
	const replayWorkspace = join(f.root, "replay workspace"); mkdirSync(replayWorkspace); seed(replayWorkspace);
	const replayOut = join(f.root, "replay output");
	const replay = await runCli(f, ["replay", "--recording", join(out, "recording.jsonl"), "--workspace", replayWorkspace, "--out", replayOut, "--json"]).done;
	assert.equal(replay.code, 0, replay.stderr);
	const replaySummary = JSON.parse(replay.stdout);
	assert.equal(replaySummary.status, "completed"); assert.equal(replaySummary.totals.requests, summary.totals.requests);
	for (const path of [source, report, check]) assert.deepEqual(readFileSync(join(replayWorkspace, path)), readFileSync(join(f.workspace, path)), path);
	assert.equal(requests.length, calls.length + 1, "offline replay must not call the provider");
});

test("SIGTERM cancels a running CLI command and a fresh invocation continues the completed filesystem work", { skip: process.platform === "win32" ? "Windows does not deliver POSIX SIGTERM to the CLI; engine cancellation is tested separately" : false, timeout: 60_000 }, async t => {
	const f = fixture(t), out = join(f.root, "interrupted output"), first = join(f.root, "first.jsonl");
	const saved = "日常 notes.md", ready = "command-ready.txt", late = "must-not-run.txt";
	writeFileSync(join(f.workspace, "wait.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready"); setTimeout(() => process.exit(0), 15000);\n`);
	recording(first, "Save notes, run a temporary command, then finish.", [
		{ id: "save", name: "file_write", args: { path: saved, content: "- [ ] 继续已保存的工作\n" } },
		{ id: "wait", name: "command_run", args: { argv: [process.execPath, "wait.cjs"], timeoutMs: 20_000 } },
		{ id: "late", name: "file_write", args: { path: late, content: "wrong\n" } },
	]);
	const running = runCli(f, ["replay", "--recording", first, "--workspace", f.workspace, "--out", out, "--json"]);
	await untilCreated(join(f.workspace, ready), running.child);
	assert.equal(running.child.kill("SIGTERM"), true);
	const interrupted = await running.done;
	assert.equal(interrupted.code, 130, interrupted.stderr); assert.equal(interrupted.signal, null);
	const summary = JSON.parse(interrupted.stdout);
	assert.equal(summary.status, "cancelled"); assert.equal(existsSync(join(f.workspace, late)), false);
	assert.equal(readFileSync(join(f.workspace, saved), "utf8"), "- [ ] 继续已保存的工作\n");
	const completion = rows(join(out, "recording.jsonl")).find(row => row.kind === "tool.output" && row.data.toolCallId === "wait");
	assert.equal(completion?.data.ok, false);
	assert.equal((completion?.data.details as { cancelled?: boolean }).cancelled, true);
	const next = join(f.root, "next.jsonl"), nextOut = join(f.root, "continued output");
	recording(next, "Continue the saved note in a fresh CLI invocation.", [
		{ id: "read", name: "file_read", args: { path: saved } },
		{ id: "complete", name: "file_edit", args: { path: saved, oldText: "[ ]", newText: "[x]" } },
	]);
	const continued = await runCli(f, ["replay", "--recording", next, "--workspace", f.workspace, "--out", nextOut, "--json"]).done;
	assert.equal(continued.code, 0, continued.stderr); assert.equal(JSON.parse(continued.stdout).status, "completed");
	assert.equal(readFileSync(join(f.workspace, saved), "utf8"), "- [x] 继续已保存的工作\n");
	assert.equal(existsSync(join(f.workspace, late)), false);
	assert.equal(JSON.parse(readFileSync(join(out, "summary.json"), "utf8")).status, "cancelled", "the next invocation must preserve prior results");
});
