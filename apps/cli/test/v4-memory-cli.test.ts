import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
type Request = {
	model: string;
	stream: boolean;
	messages: { role: string; content?: string; tool_call_id?: string }[];
	tools: { function: { name: string } }[];
};
type Call = { id: string; name: string; args: Record<string, unknown> };
function response(calls: Call[] = []): string {
	const delta = calls.length
		? { tool_calls: calls.map(({ id, name, args }, index) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } })) }
		: { content: "Offline CLI check complete." };
	return [
		{ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "scripted local fixture" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } },
	].map((chunk) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "deepseek-flash", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n";
}
function runCli(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ code: number | null; pid: number | undefined; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [MAIN, ...args], { env, signal, timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
		let stdout = ""; let stderr = ""; let failure: Error | undefined;
		child.stdout.on("data", (data) => { stdout += data; });
		child.stderr.on("data", (data) => { stderr += data; });
		child.on("error", (error) => { failure = error; });
		child.on("close", (code) => failure ? reject(failure) : resolve({ code, pid: child.pid, stdout, stderr }));
	});
}
function system(request: Request): string {
	const message = request.messages.find((item) => item.role === "system");
	assert.equal(typeof message?.content, "string");
	return message!.content!;
}
function toolOutput(request: Request, id: string): string {
	const message = request.messages.find((item) => item.role === "tool" && item.tool_call_id === id);
	assert.equal(typeof message?.content, "string", `missing real tool result ${id}`);
	return message!.content!;
}

test("three independent CLI processes persist checked facts and query methods, then reject a changed dependency at startup", { timeout: 30_000 }, async (t) => {
	const base = mkdtempSync(join(tmpdir(), "mountains-v4-cli-"));
	let waitForChild: Promise<unknown> = Promise.resolve();
	t.after(async () => { await waitForChild.catch(() => {}); rmSync(base, { recursive: true, force: true }); });
	const workspace = join(base, "workspace"); const home = join(base, "home");
	mkdirSync(workspace); mkdirSync(home);
	const command = "node --test cli-persisted.test.js";
	const inference = "UNVERIFIED_CLI_CLAIM_THIS_COMMAND_ALWAYS_PASSES";
	const method = "Read current package test and runner";
	const packageText = JSON.stringify({ name: "cli-fixture", scripts: { test: command } }, null, 2) + "\n";
	writeFileSync(join(workspace, "package.json"), packageText);
	writeFileSync(join(workspace, "settings.json"), '{"runner":"legacy"}\n');
	const config = join(base, "config.json");
	writeFileSync(config, JSON.stringify({
		maxTokens: 100, checkpoints: false, retry: { maxAttempts: 1 }, limits: { maxRequests: 6, maxTurns: 6 },
		memory: { enabled: true, verifiedFacts: true }, tools: { queryPlans: true },
	}));
	// No inherited provider credentials, proxy settings, or Mountains state.
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, MOUNTAINS_HOME: join(home, ".mountains"), MOUNTAINS_BUDGET_USD: "5" };
	const requests: Request[] = []; const auths: (string | undefined)[] = []; const urls: (string | undefined)[] = [];
	const serverErrors: unknown[] = []; let script: string[] = [];
	const server = http.createServer(async (req, res) => {
		try {
			let body = ""; for await (const chunk of req) body += chunk;
			requests.push(JSON.parse(body) as Request); auths.push(req.headers.authorization); urls.push(req.url);
			const next = script.shift(); assert.ok(next, "CLI sent an unplanned request");
			res.writeHead(200, { "content-type": "text/event-stream" }); res.end(next);
		} catch (error) { serverErrors.push(error); res.writeHead(500); res.end("fixture failure"); }
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const address = server.address(); assert.ok(address && typeof address === "object");
	const port = address.port;
	const pids: number[] = []; const sessionIds: string[] = [];
	async function run(number: number, responses: string[]) {
		script = [...responses]; const offset = requests.length; const out = join(base, `run-${number}`);
		const running = runCli([
			"run", "--task", "Check current project facts and saved lookup methods.", "--workspace", workspace,
			"--config", config, "--out", out, "--run-id", `cli-memory-${number}`, "--json",
			"--base-url", `http://127.0.0.1:${port}`, "--spend-ledger", join(home, "spend.jsonl"),
		], env, t.signal);
		waitForChild = running;
		const result = await running;
		assert.equal(result.code, 0, result.stderr || result.stdout);
		assert.deepEqual(serverErrors, []); assert.equal(script.length, 0);
		assert.ok(result.pid); pids.push(result.pid);
		const summary = JSON.parse(result.stdout);
		assert.equal(summary.status, "completed"); assert.equal(summary.totals.requests, responses.length);
		sessionIds.push(summary.sessionId);
		const sent = requests.slice(offset); assert.equal(sent.length, responses.length);
		return { out, sent };
	}

	const first = await run(1, [
		response([{ id: "save-method", name: "query_plan", args: { saveAs: method, steps: [
			{ id: "test", op: "json_field", path: "package.json", field: ["scripts", "test"] },
			{ id: "runner", op: "json_field", path: "settings.json", field: ["runner"] },
		] } }]),
		response([{ id: "save-fact", name: "memory_record", args: {
			note: inference, evidence: [{ path: "package.json", start_line: 2, end_line: 2 }],
			fact: { kind: "package-script", path: "package.json", selector: "/scripts/test" },
			dependencies: [{ kind: "json-field", path: "settings.json", selector: "/runner" }], coverage: "declared-complete",
		} }]), response(),
	]);
	assert.ok(toolOutput(first.sent[1]!, "save-method").includes(command));
	const recipeId = /Saved method (q_[0-9a-f]{16})/.exec(toolOutput(first.sent[1]!, "save-method"))?.[1]; assert.ok(recipeId);
	const memoryId = /Recorded note (m\d+)/.exec(toolOutput(first.sent[2]!, "save-fact"))?.[1]; assert.ok(memoryId);
	const firstState = JSON.parse(readFileSync(join(first.out, "memory.json"), "utf8"));
	assert.deepEqual(firstState.valid, []); assert.deepEqual(firstState.stale, []);
	assert.ok(firstState.file.startsWith(join(home, ".mountains", "projects")));
	const storedMemory = JSON.parse(readFileSync(firstState.file, "utf8"));
	assert.equal(storedMemory.entries[0].fact.value, command);
	const storedMethods = readFileSync(join(dirname(firstState.file), "query-recipes.json"), "utf8");
	assert.ok(storedMethods.includes(recipeId)); assert.ok(storedMethods.includes(method));
	assert.ok(!storedMethods.includes(command)); assert.ok(!storedMethods.includes('"legacy"'));

	const second = await run(2, [response()]);
	const secondSystem = system(second.sent[0]!);
	assert.ok(secondSystem.includes(`package.json /scripts/test = "${command}"`));
	assert.match(secondSystem, /current source: package\.json#\/scripts\/test, sha256=[0-9a-f]{64}/);
	assert.ok(secondSystem.includes(`${recipeId}: ${method}`));
	assert.match(secondSystem, /Saved query methods \(descriptions, not facts\)/);
	assert.ok(!secondSystem.includes(inference));
	const secondState = JSON.parse(readFileSync(join(second.out, "memory.json"), "utf8"));
	assert.equal(secondState.file, firstState.file);
	assert.deepEqual(secondState.valid, [{ id: memoryId, checks: ["same"] }]); assert.deepEqual(secondState.stale, []);
	assert.deepEqual(JSON.parse(readFileSync(join(second.out, "recipes.json"), "utf8")), { status: "available", count: 1 });

	// Keep the fact source and its cited line unchanged; change only a declared dependency.
	writeFileSync(join(workspace, "settings.json"), '{"runner":"current"}\n');
	const third = await run(3, [response([
		{ id: "query-stale", name: "memory_query", args: { id: memoryId } },
		{ id: "replay-current", name: "query_recipe", args: { action: "replay", id: recipeId } },
	]), response()]);
	const thirdSystem = system(third.sent[0]!);
	assert.ok(!thirdSystem.includes(command)); assert.ok(!thirdSystem.includes(inference));
	assert.match(thirdSystem, /dependency-changed/); assert.ok(thirdSystem.includes(`${recipeId}: ${method}`));
	const thirdState = JSON.parse(readFileSync(join(third.out, "memory.json"), "utf8"));
	assert.equal(thirdState.file, firstState.file);
	assert.deepEqual(thirdState.valid, []); assert.deepEqual(thirdState.stale, [{ id: memoryId, checks: ["same"] }]);
	assert.match(toolOutput(third.sent[1]!, "query-stale"), /dependency-changed/);
	assert.ok(!toolOutput(third.sent[1]!, "query-stale").includes(command));
	const replay = toolOutput(third.sent[1]!, "replay-current");
	assert.match(replay, /evidence was read now/); assert.ok(replay.includes(command));
	assert.match(replay, /= "current"/); assert.doesNotMatch(replay, /= "legacy"/);
	assert.equal(readFileSync(join(workspace, "package.json"), "utf8"), packageText);
	assert.equal(new Set(pids).size, 3); assert.equal(new Set(sessionIds).size, 3);
	assert.ok(requests.every((request) => request.model === "deepseek-flash" && request.stream));
	assert.ok(requests.every((request) => request.tools.some((tool) => tool.function.name === "memory_record") && request.tools.some((tool) => tool.function.name === "query_recipe")));
	assert.ok(auths.every((auth) => auth === "Bearer proxy-injected"));
	assert.ok(urls.every((url) => url === "/chat/completions"));
});
