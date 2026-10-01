import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, type MountainsConfig } from "../src/config.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TASK = "Run the local fixture log generator and inspect its archived output.";
const LOG_COMMAND = { argv: [process.execPath, "make-log.cjs"] };
const HIDDEN_LINE = "ARCHIVE_NEEDLE payload=sealed_125";

interface ChatBody {
	model: string;
	stream: boolean;
	messages: { role: string; content?: string; tool_call_id?: string }[];
	tools?: { type: string; function: { name: string; description: string; parameters: unknown } }[];
}
interface CapturedRequest { body: ChatBody; authorization: string | undefined; url: string | undefined }

function reply(tool?: { name: string; args: Record<string, unknown>; id: string }): string {
	const delta = tool
		? { tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
		: { content: "Offline archive fixture complete." };
	const chunks = [
		{ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
			usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } },
	];
	return chunks.map(chunk => `data: ${JSON.stringify({ id: "archive-cli-fixture", object: "chat.completion.chunk", model: "deepseek-flash", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n";
}

async function localServer(t: TestContext, respond: (request: CapturedRequest, index: number) => string) {
	const requests: CapturedRequest[] = [];
	const errors: unknown[] = [];
	const server = http.createServer(async (req, res) => {
		try {
			let text = "";
			for await (const chunk of req) text += chunk;
			const request = { body: JSON.parse(text) as ChatBody, authorization: req.headers.authorization, url: req.url };
			requests.push(request);
			assert.equal(request.url, "/v1/chat/completions");
			assert.equal(request.authorization, "Bearer proxy-injected");
			assert.equal(request.body.model, "deepseek-flash");
			assert.equal(request.body.stream, true, "only the streaming main model may be requested");
			const sse = respond(request, requests.length - 1);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(sse);
		} catch (error) {
			errors.push(error);
			res.writeHead(500);
			res.end("offline fixture failed");
		}
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { url: `http://127.0.0.1:${address.port}/v1`, requests, errors };
}

function cliFixture(t: TestContext) {
	const base = mkdtempSync(join(tmpdir(), "mountains-archive-search-cli-"));
	const workspace = join(base, "workspace");
	const home = join(base, "home");
	const out = join(base, "out");
	const path = join(base, "config.json");
	const spend = join(home, "spend.jsonl");
	mkdirSync(workspace); mkdirSync(home);
	writeFileSync(join(workspace, "make-log.cjs"),
		`for (let i = 1; i <= 260; i++) console.log(i === 125 ? ${JSON.stringify(HIDDEN_LINE)} : "fixture-line-" + i);\n`);
	let pending: Promise<unknown> = Promise.resolve();
	t.after(async () => { await pending.catch(() => {}); rmSync(base, { recursive: true, force: true }); });
	return {
		out,
		run: async (baseUrl: string, tools: Record<string, unknown>) => {
			writeFileSync(path, JSON.stringify({
				model: "deepseek-flash", apiKeyEnv: "ABSENT_ARCHIVE_FIXTURE_KEY", maxTokens: 100,
				checkpoints: false, retry: { maxAttempts: 1 },
				limits: { maxCost: 1, maxRequests: 6, maxTurns: 5 }, tools,
			}));
			// Allowlist only process essentials. No inherited keys, proxy settings or NODE_OPTIONS.
			const env: NodeJS.ProcessEnv = {
				PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home,
				USERPROFILE: home, MOUNTAINS_HOME: join(home, ".mountains"), MOUNTAINS_BUDGET_USD: "5",
			};
			const running = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				const child = spawn(process.execPath, [MAIN, "run", "--task", TASK, "--workspace", workspace,
					"--config", path, "--out", out, "--json", "--run-id", "archive-cli-fixture",
					"--base-url", baseUrl, "--spend-ledger", spend],
				{ env, signal: t.signal, timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
				let stdout = ""; let stderr = ""; let failure: Error | undefined;
				child.stdout.on("data", data => { stdout += data; });
				child.stderr.on("data", data => { stderr += data; });
				child.on("error", error => { failure = error; });
				child.on("close", code => failure ? reject(failure) : resolve({ code, stdout, stderr }));
			});
			pending = running;
			return await running;
		},
	};
}

function config(overrides: Record<string, unknown> = {}) {
	return loadConfig(null, overrides as Partial<MountainsConfig>);
}
function lastTool(body: ChatBody): string {
	const message = body.messages.filter(message => message.role === "tool").at(-1);
	assert.ok(message?.content, "a real tool result must reach the upstream fixture");
	return message.content;
}
function readRecording(out: string) {
	return readFileSync(join(out, "recording.jsonl"), "utf8").trim().split("\n")
		.map(line => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
}

test("archiveSearch configuration: omission and false share the disabled default and hash", () => {
	for (const expand of [false, true]) {
		const omitted = config({ tools: { expand } });
		const disabled = config({ tools: { expand, archiveSearch: false } });
		assert.equal(omitted.config.tools.archiveSearch, false);
		assert.equal(disabled.config.tools.archiveSearch, false);
		assert.deepEqual(omitted.config, disabled.config);
		assert.equal(omitted.sha256, disabled.sha256);
		assert.equal(omitted.systemPrompt, disabled.systemPrompt);
		assert.equal(omitted.config.modelApproval, null);
		assert.equal(omitted.config.requestGuard, false);
	}
	assert.equal(config().config.tools.expand, false);
	assert.equal(config().config.tools.archiveSearch, false);
});

test("archiveSearch configuration: only booleans are accepted", () => {
	for (const archiveSearch of ["true", "false", 0, 1, null, [], {}]) {
		assert.throws(() => config({ tools: { expand: true, archiveSearch } }), /archiveSearch.*布尔/,
			`invalid archiveSearch ${JSON.stringify(archiveSearch)}`);
	}
});

test("archiveSearch configuration: true requires literal expand=true and changes only its setting", () => {
	for (const expand of [undefined, false, null, 0, 1, "true", "false", [], {}]) {
		const tools = expand === undefined ? { archiveSearch: true } : { expand, archiveSearch: true };
		assert.throws(() => config({ tools }), /archiveSearch.*expand/);
	}
	const disabled = config({ tools: { expand: true, archiveSearch: false } });
	const enabled = config({ tools: { expand: true, archiveSearch: true } });
	assert.equal(enabled.config.tools.archiveSearch, true);
	assert.notEqual(enabled.sha256, disabled.sha256);
	assert.equal(enabled.systemPrompt, disabled.systemPrompt);
	assert.deepEqual(enabled.config, { ...disabled.config, tools: { ...disabled.config.tools, archiveSearch: true } });
});

test("archiveSearch CLI: disabled payload stays identical; enabled appends one tool and records its flag", { timeout: 40_000 }, async (t) => {
	const upstream = await localServer(t, (request, index) => {
		if (index % 2 === 0) return reply({ name: "command_run", args: LOG_COMMAND, id: "fixture-log" });
		const result = lastTool(request.body);
		assert.match(result, /output truncated/);
		assert.match(result, /fullOutputRef=/);
		assert.ok(!result.includes(HIDDEN_LINE), "the middle line must be omitted from the actual command result");
		return reply();
	});
	const modes = [{ expand: true }, { expand: true, archiveSearch: false }, { expand: true, archiveSearch: true }];
	const outputs: { config: MountainsConfig; sha256: string }[] = [];
	for (const [i, tools] of modes.entries()) {
		const fixture = cliFixture(t);
		const result = await fixture.run(upstream.url, tools);
		assert.equal(result.code, 0, result.stderr || result.stdout);
		assert.equal(upstream.requests.length, (i + 1) * 2, "only two scripted main requests per run");
		const summary = JSON.parse(result.stdout);
		assert.equal(summary.totals.requests, 2);
		assert.equal(summary.totals.approvalRequests ?? 0, 0);
		const saved = JSON.parse(readFileSync(join(fixture.out, "config.json"), "utf8")) as { config: MountainsConfig; sha256: string };
		outputs.push(saved);
		assert.equal(saved.config.tools.archiveSearch, i === 2);
		assert.equal(saved.config.modelApproval, null);
		assert.equal(saved.config.requestGuard, false);
		assert.equal(summary.configSha256, saved.sha256);
		const meta = readRecording(fixture.out).find(entry => entry.kind === "meta")?.data;
		assert.ok(meta);
		assert.equal((meta.toolOptions as Record<string, unknown>).archiveSearch, i === 2);
		const toolResult = lastTool(upstream.requests[i * 2 + 1]!.body);
		assert.equal(toolResult.includes("context_search"), i === 2);
	}
	assert.deepEqual(upstream.errors, []);
	const omitted = upstream.requests[0]!.body;
	const disabled = upstream.requests[2]!.body;
	const enabled = upstream.requests[4]!.body;
	assert.deepEqual(omitted, disabled, "omitted/false must generate the same initial upstream payload");
	assert.ok(disabled.tools?.some(tool => tool.function.name === "context_expand"));
	assert.ok(!JSON.stringify(disabled).includes("context_search"), "disabled definitions and prompts have no search hint");
	assert.ok(enabled.tools && disabled.tools);
	assert.equal(enabled.tools.length, disabled.tools.length + 1);
	assert.equal(enabled.tools.at(-1)?.function.name, "context_search");
	assert.deepEqual(enabled.tools.slice(0, -1), disabled.tools, "existing tool definitions and order stay byte-equivalent");
	assert.deepEqual({ ...enabled, tools: disabled.tools }, disabled, "the new tool is the only upstream payload change");
	assert.equal(outputs[0]!.sha256, outputs[1]!.sha256);
	assert.notEqual(outputs[1]!.sha256, outputs[2]!.sha256);
});

test("archiveSearch CLI: actual truncated output can be searched and expanded without an approval model", { timeout: 20_000 }, async (t) => {
	const fixture = cliFixture(t);
	let fullRef = "";
	let snippetText = "";
	const upstream = await localServer(t, (request, index) => {
		if (index === 0) return reply({ name: "command_run", args: LOG_COMMAND, id: "fixture-log" });
		if (index === 1) {
			const output = lastTool(request.body);
			assert.match(output, /output truncated/);
			assert.ok(!output.includes(HIDDEN_LINE));
			const ref = /fullOutputRef=([^;\]\s]+)/.exec(output)?.[1];
			assert.ok(ref, "the real command returns its immutable full-output reference");
			fullRef = ref;
			assert.ok(output.includes(`context_search ref=${ref} toolCallId="fixture-log"`));
			return reply({ name: "context_search", args: { ref, toolCallId: "fixture-log", needle: HIDDEN_LINE }, id: "fixture-search" });
		}
		if (index === 2) {
			const found = JSON.parse(lastTool(request.body)) as {
				ok: boolean; source: { ref: string };
				matches: { line: number; snippet: { byteStart: number; byteEnd: number; text: string } }[];
			};
			assert.equal(found.ok, true);
			assert.equal(found.source.ref, fullRef);
			assert.equal(found.matches.length, 1);
			const match = found.matches[0]!;
			assert.equal(match.line, 125);
			assert.ok(match.snippet.text.includes(HIDDEN_LINE));
			snippetText = match.snippet.text;
			const length = match.snippet.byteEnd - match.snippet.byteStart;
			assert.ok(length > 0 && length <= 12_000);
			return reply({
				name: "context_expand",
				args: { ref: fullRef, offsetBytes: match.snippet.byteStart, maxBytes: length },
				id: "fixture-expand",
			});
		}
		assert.equal(index, 3, "no retry, judge or extra main-model request is expected");
		const expanded = lastTool(request.body);
		assert.ok(expanded.includes(HIDDEN_LINE));
		assert.ok(expanded.includes(snippetText), "the returned byte range reproduces the search snippet");
		assert.match(expanded, /original archived bytes/);
		return reply();
	});
	const result = await fixture.run(upstream.url, { expand: true, archiveSearch: true });
	assert.equal(result.code, 0, result.stderr || result.stdout);
	assert.equal(upstream.requests.length, 4);
	assert.deepEqual(upstream.errors, []);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.totals.requests, 4);
	assert.equal(summary.totals.approvalRequests ?? 0, 0);
	const meta = readRecording(fixture.out).find(entry => entry.kind === "meta")?.data;
	assert.ok(meta);
	assert.equal((meta.toolOptions as Record<string, unknown>).archiveSearch, true);
});
