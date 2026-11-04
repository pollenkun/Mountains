import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PROTOCOL_VERSION } from "@mountains/protocol";
import { createEngineHost, type EngineHost } from "../src/main/engine-host.ts";

const usage = {
	prompt_tokens: 20,
	completion_tokens: 4,
	total_tokens: 24,
	prompt_tokens_details: { cached_tokens: 0 },
	completion_tokens_details: { reasoning_tokens: 0 },
	prompt_cache_hit_tokens: 0,
	prompt_cache_miss_tokens: 20,
};

function sse(delta: Record<string, unknown>, finish: string | null): string {
	return `data: ${JSON.stringify({
		id: "r1", object: "chat.completion.chunk", model: "deepseek-flash",
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(finish ? { usage } : {}),
	})}\n\ndata: [DONE]\n\n`;
}

function fixture(approval = false): { home: string; workspace: string; config: string; out: string; ledger: string } {
	const home = mkdtempSync(join(tmpdir(), "mountains-desktop-host-"));
	const workspace = mkdtempSync(join(tmpdir(), "mountains-desktop-host-ws-"));
	const config = join(home, "config.json");
	writeFileSync(config, `${JSON.stringify({
		model: "deepseek-flash",
		baseUrl: "https://offline.invalid/v1",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		checkpoints: false,
		maxTokens: 64,
		skills: { enabled: false, dirs: [], enable: [], permissions: {} },
		retry: { maxAttempts: 1, baseDelayMs: 0 },
		limits: { maxTurns: 6, maxRequests: 6, maxCost: 5 },
		...(approval ? { approval: { rules: [], fallback: "ask" } } : {}),
	})}\n`);
	return { home, workspace, config, out: join(home, "out"), ledger: join(home, "spend.jsonl") };
}

async function using(dir: ReturnType<typeof fixture>, fetch: typeof globalThis.fetch, run: (host: EngineHost) => Promise<void>, session?: { id: string; file: string }): Promise<void> {
	const previous = {
		home: process.env.MOUNTAINS_HOME,
		key: process.env.DEEPSEEK_API_KEY,
		budget: process.env.MOUNTAINS_BUDGET,
	};
	process.env.MOUNTAINS_HOME = dir.home;
	process.env.DEEPSEEK_API_KEY = "desktop-test-key";
	process.env.MOUNTAINS_BUDGET = "5";
	const host = createEngineHost({
		workspace: dir.workspace,
		configPath: dir.config,
		outDir: dir.out,
		spendLedger: dir.ledger,
		fetch,
		...(session ? { session } : {}),
	});
	try { await run(host); }
	finally {
		await host.dispose();
		if (previous.home === undefined) delete process.env.MOUNTAINS_HOME;
		else process.env.MOUNTAINS_HOME = previous.home;
		if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previous.key;
		if (previous.budget === undefined) delete process.env.MOUNTAINS_BUDGET;
		else process.env.MOUNTAINS_BUDGET = previous.budget;
	}
}

describe("desktop engine host", { concurrency: false }, () => {
	test("drops invalid commands before they reach the engine", () => {
		const dir = fixture();
		const host = createEngineHost({ workspace: dir.workspace, configPath: dir.config, outDir: dir.out, spendLedger: dir.ledger });
		host.handleCommand({ type: "nope" });
		host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: 1 });
		host.handleCommand(null);
		assert.equal(host.droppedCommands, 3);
		assert.equal(host.runsStarted, 0);
	});

	test("keeps a valid model.set and session.clear", async () => {
		const dir = fixture();
		const host = createEngineHost({ workspace: dir.workspace, configPath: dir.config, outDir: dir.out, spendLedger: dir.ledger });
		host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "model.set", model: "deepseek-flash" });
		host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "session.clear" });
		await host.whenIdle();
		assert.equal(host.droppedCommands, 0);
		assert.equal(host.runsStarted, 0);
		await host.dispose();
	});

	test("approval.respond unblocks the engine", async () => {
		const dir = fixture(true);
		let calls = 0;
		const fetch: typeof globalThis.fetch = async () => {
			calls += 1;
			const payload = calls === 1
				? sse({ tool_calls: [{ index: 0, id: "call_A", type: "function", function: { name: "command_run", arguments: "{\"argv\":[\"echo\",\"hi\"]}" } }] }, "tool_calls")
				: sse({ role: "assistant", content: "读完了。" }, "stop");
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		await using(dir, fetch, async (host) => {
			const seen: string[] = [];
			host.onEvent((event) => {
				seen.push(event.type);
				if (event.type === "approval.requested") {
					host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: event.toolCallId, decision: "allow" });
				}
			});
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "读 missing.txt" });
			await host.whenIdle();
			assert.ok(seen.includes("approval.requested"), seen.join(","));
			assert.ok(seen.includes("run.completed"), seen.join(","));
			assert.ok(seen.lastIndexOf("run.completed") > seen.indexOf("approval.requested"));
		});
	});

	test("an answer for a call that was never requested cannot approve it later", async () => {
		const dir = fixture(true);
		let calls = 0;
		const fetch: typeof globalThis.fetch = async () => {
			calls += 1;
			const payload = calls === 1
				? sse({ tool_calls: [{ index: 0, id: "call_A", type: "function", function: { name: "command_run", arguments: "{\"argv\":[\"echo\",\"hi\"]}" } }] }, "tool_calls")
				: sse({ role: "assistant", content: "没有运行。" }, "stop");
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		await using(dir, fetch, async (host) => {
			let ran: boolean | undefined;
			host.onEvent((event) => {
				if (event.type === "approval.requested") {
					setTimeout(() => host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: event.toolCallId, decision: "deny" }), 20);
				}
				if (event.type === "tool.completed" && event.toolCallId === "call_A") ran = event.ok;
			});
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: "call_A", decision: "allow" });
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "运行 echo hi" });
			await host.whenIdle();
			assert.equal(host.droppedCommands, 1);
			assert.equal(ran, false);
		});
	});

	for (const [mode, asks] of [["ask", true], ["full", false]] as const) {
		test(`approval mode ${mode}: a command ${asks ? "waits for the user" : "runs without asking"}`, async () => {
			const dir = fixture();
			let calls = 0;
			const fetch: typeof globalThis.fetch = async () => {
				calls += 1;
				const payload = calls === 1
					? sse({ tool_calls: [{ index: 0, id: "call_M", type: "function", function: { name: "command_run", arguments: "{\"argv\":[\"touch\",\"made.txt\"]}" } }] }, "tool_calls")
					: sse({ role: "assistant", content: "好了。" }, "stop");
				return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
			};
			await using(dir, fetch, async (host) => {
				host.choose({ approval: mode });
				const seen: string[] = [];
				host.onEvent((event) => {
					seen.push(event.type);
					if (event.type === "approval.requested") host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: event.toolCallId, decision: "allow" });
				});
				host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "建一个 made.txt" });
				await host.whenIdle();
				assert.equal(seen.includes("approval.requested"), asks, seen.join(","));
				assert.ok(seen.includes("run.completed"));
			});
		});
	}

	test("a message sent while a run goes on reaches the model with its next request", async () => {
		const dir = fixture(true);
		const bodies: string[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			bodies.push(String(init?.body ?? ""));
			const payload = bodies.length === 1
				? sse({ tool_calls: [{ index: 0, id: "call_I", type: "function", function: { name: "command_run", arguments: "{\"argv\":[\"echo\",\"hi\"]}" } }] }, "tool_calls")
				: sse({ role: "assistant", content: "好，也看了 README。" }, "stop");
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		await using(dir, fetch, async (host) => {
			const said: string[] = [];
			host.onEvent((event) => {
				if (event.type === "run.interjected") said.push(event.text);
				if (event.type === "approval.requested") {
					host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.interject", text: "顺便看下 README" });
					host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: event.toolCallId, decision: "allow" });
				}
			});
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "运行 echo hi" });
			await host.whenIdle();
			assert.deepEqual(said, ["顺便看下 README"]);
		});
		assert.equal(bodies.length, 2);
		assert.doesNotMatch(bodies[0]!, /顺便看下 README/);
		assert.match(bodies[1]!, /顺便看下 README/);
	});

	test("a message sent with nothing running says why it was not taken", async () => {
		const dir = fixture();
		await using(dir, async () => new Response(sse({ role: "assistant", content: "好。" }, "stop"), { status: 200, headers: { "content-type": "text/event-stream" } }), async (host) => {
			const errors: string[] = [];
			host.onEvent((event) => { if (event.type === "error") errors.push(event.message); if (event.type === "run.interjected") errors.push("taken"); });
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.interject", text: "还在吗" });
			await host.whenIdle();
			assert.deepEqual(errors, ["没有跟进：这一轮已经结束，直接发送会开始新的一轮"]);
		});
	});

	test("自动审批 with no approval model configured reviews on the run's own model, thinking off", async () => {
		const dir = fixture();
		const bodies: string[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const body = String(init?.body ?? "");
			bodies.push(body);
			const review = !/"tools"/.test(body);
			const payload = review ? sse({ role: "assistant", content: "{\"decision\":\"ask\",\"reason\":\"test\"}" }, "stop")
				: bodies.filter((b) => /"tools"/.test(b)).length === 1
					? sse({ tool_calls: [{ index: 0, id: "call_R", type: "function", function: { name: "command_run", arguments: "{\"argv\":[\"touch\",\"made.txt\"]}" } }] }, "tool_calls")
					: sse({ role: "assistant", content: "好了。" }, "stop");
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		await using(dir, fetch, async (host) => {
			host.choose({ approval: "auto" });
			host.onEvent((event) => { if (event.type === "approval.requested") host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: event.toolCallId, decision: "allow" }); });
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "建一个 made.txt" });
			await host.whenIdle();
		});
		const reviews = bodies.filter((body) => !/"tools"/.test(body));
		assert.ok(reviews.length >= 1, `no review request among ${bodies.length}`);
		assert.match(reviews[0]!, /"model":"deepseek-flash"/);
		assert.doesNotMatch(reviews[0]!, /"thinking":\{"type":"enabled"/);
	});

	test("自动审批 respects a chosen approvalEffort when enabled", async () => {
		const dir = fixture();
		const bodies: string[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const body = String(init?.body ?? "");
			bodies.push(body);
			const review = !/"tools"/.test(body);
			const payload = review ? sse({ role: "assistant", content: "{\"decision\":\"ask\",\"reason\":\"test\"}" }, "stop")
				: bodies.filter((b) => /"tools"/.test(b)).length === 1
					? sse({ tool_calls: [{ index: 0, id: "call_E", type: "function", function: { name: "command_run", arguments: "{\"argv\":[\"touch\",\"made.txt\"]}" } }] }, "tool_calls")
					: sse({ role: "assistant", content: "好了。" }, "stop");
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		await using(dir, fetch, async (host) => {
			host.choose({ approval: "auto", approvalEffort: "high" });
			host.onEvent((event) => {
				if (event.type === "approval.requested" && event.source !== "model") {
					host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "approval.respond", toolCallId: event.toolCallId, decision: "allow" });
				}
			});
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "建一个 made.txt" });
			await host.whenIdle();
		});
		const reviews = bodies.filter((body) => !/"tools"/.test(body));
		assert.ok(reviews.length >= 1);
		assert.match(reviews[0]!, /"thinking":\{"type":"enabled"\}/);
	});

	test("Super Intelligent UI tells the model how to write components only when it is on", async () => {
		for (const on of [true, false]) {
			const dir = fixture();
			const bodies: string[] = [];
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				bodies.push(String(init?.body ?? ""));
				return new Response(sse({ role: "assistant", content: "好。" }, "stop"), { status: 200, headers: { "content-type": "text/event-stream" } });
			};
			await using(dir, fetch, async (host) => {
				if (on) host.choose({ siui: true });
				host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "你好" });
				await host.whenIdle();
			});
			assert.equal(/Super Intelligent UI/.test(bodies[0]!), on, bodies[0]!.slice(0, 300));
			assert.equal(/draw live UI/.test(bodies[0]!), on, bodies[0]!.slice(0, 300));
			assert.doesNotMatch(bodies[0]!, /set_appearance/, "colors and themes are not the model's to change");
		}
	});

	test("a reopened conversation continues with the context it had", async () => {
		const dir = fixture();
		const session = { id: "ses_c_reopen", file: join(dir.home, "conversation", "session.json") };
		const bodies: string[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			bodies.push(String(init?.body ?? ""));
			return new Response(sse({ role: "assistant", content: bodies.length === 1 ? "记住了。" : "是 42。" }, "stop"), { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		await using(dir, fetch, async (host) => {
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "暗号是 42" });
			await host.whenIdle();
		}, session);
		assert.ok(existsSync(session.file));
		await using(dir, fetch, async (host) => {
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "暗号是多少？" });
			await host.whenIdle();
		}, session);
		assert.equal(bodies.length, 2);
		assert.match(bodies[1]!, /暗号是 42/);
		assert.match(bodies[1]!, /记住了。/);
	});

	test("a saved context that no longer fits starts the conversation over", async () => {
		const dir = fixture();
		const session = { id: "ses_c_broken", file: join(dir.home, "conversation", "session.json") };
		mkdirSync(join(dir.home, "conversation"));
		writeFileSync(session.file, "{\"format\":\"other\"}\n");
		const bodies: string[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			bodies.push(String(init?.body ?? ""));
			return new Response(sse({ role: "assistant", content: "好。" }, "stop"), { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		await using(dir, fetch, async (host) => {
			let status = "";
			host.onEvent((event) => { if (event.type === "run.completed") status = event.status; });
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "你好" });
			await host.whenIdle();
			assert.equal(status, "completed");
		}, session);
		assert.equal(bodies.length, 1);
		assert.match(readFileSync(session.file, "utf8"), /mountains-agent-session/);
	});

	test("run.cancel aborts the model request", async () => {
		const dir = fixture();
		const fetch: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
			const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
			if (init?.signal?.aborted) abort();
			else init?.signal?.addEventListener("abort", abort, { once: true });
		});
		await using(dir, fetch, async (host) => {
			let status = "";
			host.onEvent((event) => {
				if (event.type === "run.started") host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.cancel" });
				if (event.type === "run.completed") status = event.status;
			});
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "停下来" });
			await host.whenIdle();
			assert.equal(status, "cancelled");
		});
	});

	test("UltraCode team mode preserves maxAgents across toggles and enforces 自动审批 on subagent tool calls", async () => {
		const dir = fixture();
		const bodies: string[] = [];
		let agentTurns = 0;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const body = String(init?.body ?? "");
			bodies.push(body);
			// Review requests carry no tools array and use non-streaming JSON chat.completion.
			if (!/"tools"/.test(body)) {
				return new Response(JSON.stringify({
					id: "r_rev",
					object: "chat.completion",
					model: "deepseek-flash",
					choices: [{ index: 0, message: { role: "assistant", content: "{\"decision\":\"allow\",\"risk\":\"low\"}" }, finish_reason: "stop" }],
					usage,
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			const isSubagent = body.includes("You are helper, a sub-agent");
			if (isSubagent) {
				const subTurn = ++agentTurns;
				const payload = subTurn === 1
					? sse({ tool_calls: [{ index: 0, id: "sub_touch", type: "function", function: { name: "command_run", arguments: "{\"argv\":[\"touch\",\"sub.txt\"]}" } }] }, "tool_calls")
					: sse({ role: "assistant", content: "sub.txt 已创建。" }, "stop");
				return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
			}
			const leadCalls = bodies.filter((b) => /"tools"/.test(b) && !b.includes("You are helper, a sub-agent")).length;
			const payload = leadCalls === 1
				? sse({ tool_calls: [{ index: 0, id: "lead_spawn", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ name: "helper", purpose: "建文件", task: "创建 sub.txt" }) } }] }, "tool_calls")
				: sse({ role: "assistant", content: "已完成。" }, "stop");
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		await using(dir, fetch, async (host) => {
			// Setting maxAgents before enabling team keeps maxAgents once team is turned on.
			host.choose({ maxAgents: 4 });
			host.choose({ team: true, approval: "auto" });
			assert.deepEqual(host.preferences().maxAgents, 4);
			assert.equal(host.preferences().team, true);
			const subEvents: string[] = [];
			host.onEvent((event) => {
				if (event.agent === "helper") subEvents.push(`${event.type}${event.type === "approval.requested" ? `:${event.source}` : ""}`);
			});
			host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "让子 Agent 创建 sub.txt" });
			await host.whenIdle();
			assert.ok(subEvents.includes("approval.requested:model"), `expected model auto-approval on subagent: ${subEvents.join(",")}`);
			assert.ok(existsSync(join(dir.workspace, "sub.txt")));
		});
	});
});

test("Kimi runs with no budget in the environment, and its first request fits its task cap", async () => {
	const dir = fixture();
	writeFileSync(dir.config, `${JSON.stringify({ model: "kimi-k2.7-code", baseUrl: "https://offline.invalid/v1", apiKeyEnv: "MOONSHOT_API_KEY", thinking: { enabled: true, effort: "default" }, checkpoints: false, skills: { enabled: false, dirs: [], enable: [], permissions: {} }, retry: { maxAttempts: 1, baseDelayMs: 0 } })}\n`);
	const previous = { MOUNTAINS_HOME: process.env.MOUNTAINS_HOME, MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY, MOUNTAINS_BUDGET: process.env.MOUNTAINS_BUDGET };
	process.env.MOUNTAINS_HOME = dir.home;
	process.env.MOONSHOT_API_KEY = "desktop-test-key";
	delete process.env.MOUNTAINS_BUDGET;
	const fetch: typeof globalThis.fetch = async () => new Response(sse({ role: "assistant", content: "好" }, "stop").replace("deepseek-flash", "kimi-k2.7-code"), { status: 200, headers: { "content-type": "text/event-stream" } });
	const host = createEngineHost({ workspace: dir.workspace, configPath: dir.config, outDir: dir.out, spendLedger: dir.ledger, fetch });
	try {
		const seen: string[] = [];
		host.onEvent((event) => seen.push(event.type === "error" ? JSON.stringify(event) : event.type));
		host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "你好" });
		await host.whenIdle();
		assert.ok(seen.includes("run.completed"), seen.join(",").slice(0, 900));
	} finally {
		await host.dispose();
		for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
	}
});

test("computer use stays out of the model's tools even when a config file enables it", async () => {
	const dir = fixture();
	const config = JSON.parse(readFileSync(dir.config, "utf8")) as Record<string, unknown>;
	writeFileSync(dir.config, `${JSON.stringify({ ...config, skills: { enabled: true, dirs: [], enable: ["computer-use"], permissions: {} } })}\n`);
	let body = "";
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		body = String(init?.body);
		return new Response(sse({ role: "assistant", content: "好" }, "stop"), { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	await using(dir, fetch, async (host) => {
		host.handleCommand({ protocolVersion: PROTOCOL_VERSION, type: "run.start", task: "你好" });
		await host.whenIdle();
	});
	const tools = (JSON.parse(body) as { tools: { function: { name: string } }[] }).tools.map((tool) => tool.function.name);
	assert.ok(tools.includes("file_read"));
	assert.deepEqual(tools.filter((name) => /^(screen|web)_(read|act|look)$/.test(name)), []);
	assert.doesNotMatch(body, /computer.use/i);
});
