import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type ModelLedgerWitness, type ToolExecutionIdentity } from "@mountains/engine";
import { ToolObserverIpcClient } from "../src/tool-observer-ipc.ts";
import type { ObserverAgent, ObserverPacket, ObserverReply, ObserverRequest } from "../src/tool-observer-protocol.ts";

/** Message delivery only. This fixture has no browser, AX, model endpoint or account access. */
class Host extends EventEmitter {
	connected = true;
	channel = {};
	env = {};
	execArgv = ["--disable-sigusr1"];
	auto = true;
	backpressure = false;
	readonly packets: ObserverPacket[] = [];
	onRequest: ((packet: ObserverRequest) => void) | undefined;
	send(packet: ObserverPacket, callback: (error: Error | null) => void): boolean {
		this.packets.push(packet);
		if (packet.kind === "request") { this.emit("sent", packet); if (this.auto) this.ack(packet); this.onRequest?.(packet); }
		callback(null); return !this.backpressure;
	}
	ack(packet: ObserverRequest, changes: Partial<ObserverReply> = {}): void {
		this.emit("message", { protocol: packet.protocol, kind: "reply", id: packet.id, phase: packet.phase, hash: packet.hash, ok: true, receipt: { observed: true }, ...changes });
	}
}
const agent: ObserverAgent = { name: "lead", role: "lead", dataDir: "/own/out" };
const identity = (): ToolExecutionIdentity => ({ executionId: randomUUID(), source: { sessionId: "own-session", runId: "own-run", turnId: "own-turn", requestId: "own-request", responseId: "own-offline-response", attempt: 1 },
	toolCallId: randomUUID(), name: "own_read", argumentsSha256: "0".repeat(64), recordedArgumentsSha256: "0".repeat(64) });
async function fixture(t: TestContext) {
	const host = new Host(), client = new ToolObserverIpcClient(host as unknown as NodeJS.Process);
	t.after(() => client.dispose());
	await client.start({ pid: process.pid, runId: "own-run", workspace: "/own/work", outDir: "/own/out", spendLedger: "/own/spend", task: "local fixture only", model: "own-model", effectiveConfigSha256: "0".repeat(64) });
	return { host, client, observer: client.forAgent(agent) };
}

test("send callback and backpressure never grant tool permission without a matching durable ACK", async t => {
	const { host, observer } = await fixture(t); host.auto = false; host.backpressure = true;
	const sent = once(host, "sent"); let resolved = false;
	const pending = observer.before(identity(), {}, new AbortController().signal).then(result => { resolved = true; return result; });
	const [request] = await sent as [ObserverRequest];
	await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(resolved, false);
	host.ack(request); assert.deepEqual(await pending, { observed: true });
	assert.equal(host.packets.filter(p => p.kind === "request" && p.phase === "before").length, 1, "backpressure must not resend a tool observation");
});

for (const fault of ["wrong-hash", "denied", "disconnect"] as const) test(`a ${fault} reply aborts all Agent observers and cannot grant later permission`, async t => {
	const { host, client, observer } = await fixture(t); host.auto = false;
	const member = client.forAgent({ name: "worker", role: "member", dataDir: "/own/out/agents/worker" });
	const sent = once(host, "sent"), first = observer.before(identity(), {}, new AbortController().signal); const rejected = assert.rejects(first);
	const [request] = await sent as [ObserverRequest];
	const second = member.before(identity(), {}, new AbortController().signal), secondRejected = assert.rejects(second);
	await new Promise<void>(resolve => setImmediate(resolve));
	if (fault === "wrong-hash") host.ack(request, { hash: "f".repeat(64) });
	else if (fault === "denied") host.ack(request, { ok: false, receipt: null });
	else { host.connected = false; host.emit("disconnect"); }
	await Promise.all([rejected, secondRejected]); assert.equal(client.healthy, false); assert.equal(client.fatalSignal.aborted, true);
	await assert.rejects(member.before(identity(), {}, new AbortController().signal));
});

test("one late cancelled ACK is ignored; a second copy fails the shared channel", async t => {
	const { host, client, observer } = await fixture(t); host.auto = false;
	const stop = new AbortController(), sent = once(host, "sent"), pending = observer.before(identity(), {}, stop.signal), rejected = assert.rejects(pending);
	const [request] = await sent as [ObserverRequest]; stop.abort(); await rejected;
	assert.equal(client.healthy, true); assert.equal(host.packets.filter(p => p.kind === "cancel").length, 1);
	host.ack(request); assert.equal(client.healthy, true);
	host.auto = true; await observer.before(identity(), {}, new AbortController().signal);
	host.ack(request); assert.equal(client.healthy, false); assert.equal(client.fatalSignal.aborted, true);
});

test("all tool observers wait for every queued live model bill; cancelling that wait does not corrupt the next one", async t => {
	const { host, client, observer } = await fixture(t); host.auto = false;
	const witness: ModelLedgerWitness = { sessionId: "own-session", runId: "own-run", turnId: "own-turn", requestId: "own-request", responseId: "own-response", attempt: 1, purpose: "agent-turn", cost: 0, currency: "CNY", recordSha256: "0".repeat(64) };
	client.noteModelLedger(agent, witness);
	const model = host.packets.at(-1) as ObserverRequest; assert.equal(model.phase, "model");
	const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(observer.before(identity(), {}, cancelled.signal));
	const sent = once(host, "sent"), next = observer.before(identity(), {}, new AbortController().signal);
	await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(host.packets.some(p => p.kind === "request" && p.phase === "before"), false);
	host.ack(model); const [request] = await sent as [ObserverRequest]; assert.equal(request.phase, "before");
	host.ack(request); await next; assert.equal(client.healthy, true);
});

test("an ACK followed by an invalid reply in the same delivery batch cannot start actual engine execution", async t => {
	const { host, client } = await fixture(t);
	host.onRequest = packet => { if (packet.phase === "before") host.ack(packet, { id: randomUUID() }); };
	const root = mkdtempSync(join(tmpdir(), "mountains-ipc-engine-")), workspace = join(root, "work"); mkdirSync(workspace);
	t.after(() => rmSync(root, { recursive: true, force: true })); let executions = 0;
	const session = new AgentSession({ workspace, dataDir: join(root, "out"), archiveDir: join(root, "archive"), appDataDir: join(root, "app"),
		model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 64, checkpoints: false, requestGuard: true,
		budget: new BudgetGuard({ globalLimit: 1, ledgerPath: join(root, "spend.jsonl") }), limits: { maxTurns: 1, maxCost: 1 },
		toolObserver: client.forAgent(agent), adapter: new ScriptedModelAdapter([{ ok: true, message: { role: "assistant", content: "", reasoning: "", toolCalls: [{ id: "own-call", name: "context_expand", argumentsJson: "{}" }] }, finishReason: "tool_calls",
			responseModel: "deepseek-flash", rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 }, httpStatus: 200, error: null, aborted: false }]),
		tools: [{ name: "context_expand", logicalName: "fixture.read", description: "local fixture", parameters: {}, readOnly: true, async execute() { executions++; return { ok: true, modelContent: "own result", summary: "own fixture", details: {} }; } }],
	});
	const summary = await session.run("Run the local fixture once.", client.fatalSignal);
	assert.equal(executions, 0); assert.notEqual(summary.status, "completed"); assert.equal(client.healthy, false); assert.equal(client.fatalSignal.aborted, true);
});
