import assert from "node:assert/strict";
import { createHash, type Hash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ToolExecutionIdentity, ToolExecutionOutcome, ModelLedgerWitness } from "@mountains/engine";
import type { ObserverAgent } from "../../../../apps/cli/src/tool-observer-protocol.ts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): Record<string, any> => { assert.ok(v && typeof v === "object" && !Array.isArray(v), "expected proof object"); return v as Record<string, any>; };

/** One append-only descriptor per known CLI file; the final prefix check also detects in-place rewrites. */
class SourceFile {
	readonly path: string;
	readonly rows: Record<string, any>[] = [];
	private readonly fd: number;
	private readonly digest: Hash = createHash("sha256");
	private readonly decoder = new StringDecoder("utf8");
	private offset = 0;
	private pending = "";
	private lineOffset = 0;
	private readonly spans = new WeakMap<object, { offset: number; bytes: number; sha256: string }>();
	constructor(path: string) {
		this.path = path;
		assert.ok(lstatSync(path).isFile() && realpathSync(path) === path, "source file is not a canonical regular file");
		this.fd = openSync(path, "r");
	}
	read(): void {
		const file = fstatSync(this.fd), link = lstatSync(this.path);
		assert.ok(link.isFile() && file.dev === link.dev && file.ino === link.ino && file.size >= this.offset, "source file replaced or truncated");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		while (this.offset < file.size) {
			const bytes = readSync(this.fd, buffer, 0, Math.min(buffer.length, file.size - this.offset), this.offset);
			assert.ok(bytes > 0, "source read stopped"); this.offset += bytes;
			const chunk = buffer.subarray(0, bytes); this.digest.update(chunk); this.pending += this.decoder.write(chunk);
			for (;;) {
				const end = this.pending.indexOf("\n"); if (end < 0) break;
				const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
				assert.ok(line.length <= 16 * 1024 * 1024 && this.rows.length < 100_000, "source record limit exceeded");
				const bytes = Buffer.byteLength(line + "\n");
				if (line.trim()) { const row = object(JSON.parse(line)); this.rows.push(row); this.spans.set(row, { offset: this.lineOffset, bytes, sha256: sha(line + "\n") }); }
				this.lineOffset += bytes;
			}
			assert.ok(this.pending.length <= 16 * 1024 * 1024, "incomplete source record is too large");
		}
		assert.equal(this.pending, "", "incomplete source record");
	}
	verify(row: object): void {
		const span = this.spans.get(row); assert.ok(span, "unknown source row");
		const file = fstatSync(this.fd), link = lstatSync(this.path);
		assert.ok(link.isFile() && file.dev === link.dev && file.ino === link.ino && file.size >= span.offset + span.bytes, "source identity changed");
		const bytes = Buffer.allocUnsafe(span.bytes); let offset = 0;
		while (offset < bytes.length) { const n = readSync(this.fd, bytes, offset, bytes.length - offset, span.offset + offset); assert.ok(n > 0); offset += n; }
		assert.equal(sha(bytes), span.sha256, "source row changed before permission");
	}
	final(): { path: string; sha256: string; bytes: number } {
		this.read();
		const bytes = readFileSync(this.path);
		assert.equal(bytes.length, this.offset, "source changed during finalization");
		const hash = sha(bytes); assert.equal(hash, this.digest.copy().digest("hex"), "previous source bytes were rewritten");
		return { path: this.path, sha256: hash, bytes: bytes.length };
	}
	close(): void { closeSync(this.fd); }
}

/** Paths come from the parent-owned CLI launch, never from cli-source.json supplied after a run. */
export class ModelSourceProof {
	private readonly files = new Map<string, SourceFile>();
	private readonly bindings = new Map<string, string>();
	private readonly sessions = new Map<string, string>();
	private readonly models = new Map<string, ModelLedgerWitness>();
	private readonly outputs = new Map<string, { agent: ObserverAgent; identity: ToolExecutionIdentity; outcome: Pick<ToolExecutionOutcome, "dispatch" | "started" | "finished" | "ok" | "modelContentSha256" | "recordedModelContentSha256"> }>();
	readonly outDir: string;
	readonly spendLedger: string;
	readonly spendBaseline: Readonly<{ bytes: number; rows: number; sha256: string }>;
	private readonly canonicalOutDir: string;
	constructor(outDir: string, spendLedger: string) {
		this.outDir = resolve(outDir); this.canonicalOutDir = realpathSync(outDir); this.spendLedger = resolve(spendLedger);
		// Only the bytes present before the parent permits CLI startup are old history.
		// An unknown run ID appended later is not permission to omit a new charge.
		if (existsSync(this.spendLedger)) {
			const source = this.source(this.spendLedger), prefix = source.final();
			this.spendBaseline = Object.freeze({ bytes: prefix.bytes, rows: source.rows.length, sha256: prefix.sha256 });
		} else this.spendBaseline = Object.freeze({ bytes: 0, rows: 0, sha256: sha("") });
	}
	private source(path: string): SourceFile {
		assert.ok(lstatSync(path).isFile(), "source path is not a regular file");
		const canonical = realpathSync(path);
		const binding = resolve(path), prior = this.bindings.get(binding);
		assert.ok(!prior || prior === canonical, "source path was redirected after its initial binding");
		this.bindings.set(binding, canonical);
		let file = this.files.get(canonical);
		if (!file) { assert.ok(this.files.size < 128, "too many source files"); file = new SourceFile(canonical); this.files.set(canonical, file); }
		file.read(); return file;
	}
	private agentDir(agent: ObserverAgent, sessionId: string): string {
		const lead = agent.name === "lead";
		assert.ok(lead ? agent.role === "lead" : /^[a-z][a-z0-9_]{0,30}$/.test(agent.name) && ["member", "group lead"].includes(agent.role), "invalid agent binding");
		const expected = lead ? this.outDir : join(this.outDir, "agents", agent.name);
		assert.equal(agent.dataDir, expected, "agent supplied another data directory");
		const canonical = lead ? this.canonicalOutDir : join(this.canonicalOutDir, "agents", agent.name);
		assert.equal(realpathSync(expected), canonical, "agent data directory is aliased");
		const prior = this.sessions.get(agent.name);
		assert.ok(!prior || prior === sessionId, "agent session changed");
		assert.ok(![...this.sessions].some(([name, session]) => name !== agent.name && session === sessionId), "two agents share a session");
		this.sessions.set(agent.name, sessionId); return canonical;
	}
	model(agent: ObserverAgent, witness: ModelLedgerWitness): Record<string, unknown> {
		const dir = this.agentDir(agent, witness.sessionId), key = JSON.stringify([witness.runId, witness.requestId]);
		assert.ok(!this.models.has(key), "duplicate live model bill");
		const recording = this.source(join(dir, "recording.jsonl")), meta = recording.rows.filter(row => row.kind === "meta"); assert.equal(meta.length, 1);
		assert.equal(meta[0]!.data.sessionId, witness.sessionId); assert.equal(meta[0]!.data.requestGuard, true); recording.verify(meta[0]!);
		const ledger = this.source(join(dir, "ledger.jsonl")), bills = ledger.rows.filter(row => row.requestId === witness.requestId); assert.equal(bills.length, 1);
		const bill = bills[0]!; ledger.verify(bill); assert.equal(sha(JSON.stringify(bill)), witness.recordSha256, "bill differs from its live append receipt");
		for (const field of ["sessionId", "runId", "turnId", "requestId", "attempt", "purpose", "responseId", "cost", "currency"]) assert.equal(bill[field], witness[field as keyof ModelLedgerWitness]);
		assert.equal(bill.costPartial, false);
		const spend = this.source(this.spendLedger), rows = spend.rows.filter(row => row.runId === witness.runId && row.requestId === witness.requestId);
		const reserved = rows.filter(row => row.kind === "budget.reserve"), settled = rows.filter(row => row.kind === "budget.settle"); assert.equal(reserved.length, 1); assert.equal(settled.length, 1);
		spend.verify(reserved[0]!); spend.verify(settled[0]!);
		assert.equal(settled[0]!.amount, witness.cost); assert.equal(settled[0]!.currency, witness.currency); assert.equal(settled[0]!.partial, false); assert.equal(settled[0]!.overrun, false);
		this.models.set(key, Object.freeze({ ...witness }));
		return { modelLedger: ledger.path, ledgerRecordSha256: witness.recordSha256, settlementSha256: sha(JSON.stringify(settled[0])) };
	}
	before(agent: ObserverAgent, identity: ToolExecutionIdentity): Record<string, unknown> {
		const origin = identity.source, dir = this.agentDir(agent, origin.sessionId);
		const witnessed = this.models.get(JSON.stringify([origin.runId, origin.requestId])); assert.ok(witnessed, "tool has no live model bill witness");
		assert.ok(typeof origin.responseId === "string" && origin.responseId.length > 0, "missing provider response ID");
		const recording = this.source(join(dir, "recording.jsonl"));
		const metadata = recording.rows.filter(row => row.kind === "meta"); assert.equal(metadata.length, 1);
		assert.equal(metadata[0]!.data.sessionId, origin.sessionId); assert.equal(metadata[0]!.data.requestGuard, true, "unreserved model requests cannot count");
		recording.verify(metadata[0]!);
		const responses = recording.rows.filter(row => row.kind === "model.response" && row.data?.requestId === origin.requestId);
		assert.equal(responses.length, 1, "missing or duplicate model response"); const response = responses[0]!.data;
		recording.verify(responses[0]!);
		for (const field of ["runId", "turnId", "requestId", "attempt", "responseId"]) assert.equal(response[field], origin[field as keyof typeof origin]);
		assert.equal(response.ok, true);
		const calls = response.toolCallIdentities;
		assert.ok(Array.isArray(calls), "response lacks unredacted argument fingerprints");
		const callsForId = calls.filter((row: any) => row.id === identity.toolCallId); assert.equal(callsForId.length, 1);
		assert.equal(callsForId[0].name, identity.name); assert.equal(callsForId[0].argumentsSha256, identity.argumentsSha256);
		assert.equal(callsForId[0].recordedArgumentsSha256, identity.recordedArgumentsSha256);
		const shownCalls = response.message.toolCalls.filter((row: any) => row.id === identity.toolCallId); assert.equal(shownCalls.length, 1);
		assert.equal(shownCalls[0].name, identity.name); assert.equal(sha(shownCalls[0].argumentsJson), identity.recordedArgumentsSha256, "recorded model arguments differ from their live commitment");
		const inputs = recording.rows.filter(row => row.kind === "tool.input" && row.data?.executionId === identity.executionId); assert.equal(inputs.length, 1);
		const input = inputs[0]!.data;
		recording.verify(inputs[0]!);
		assert.equal(input.toolCallId, identity.toolCallId); assert.equal(input.name, identity.name); assert.equal(input.argumentsSha256, identity.argumentsSha256);
		assert.equal(input.recordedArgumentsSha256, identity.recordedArgumentsSha256); assert.equal(sha(input.arguments), identity.recordedArgumentsSha256, "recorded input differs from its live commitment");
		assert.equal(JSON.stringify(input.source), JSON.stringify(origin), "tool input used another source");
		const ledger = this.source(join(dir, "ledger.jsonl")), entries = ledger.rows.filter(row => row.requestId === origin.requestId);
		assert.equal(entries.length, 1, "missing or duplicate model ledger entry"); const bill = entries[0]!;
		ledger.verify(bill); assert.equal(sha(JSON.stringify(bill)), witnessed.recordSha256);
		for (const field of ["sessionId", "runId", "turnId", "requestId", "attempt", "responseId"]) assert.equal(bill[field], origin[field as keyof typeof origin]);
		assert.equal(bill.purpose, "agent-turn"); assert.equal(bill.error, null); assert.equal(bill.costPartial, false);
		assert.ok(typeof bill.cost === "number" && Number.isFinite(bill.cost) && bill.cost >= 0 && typeof bill.currency === "string");
		const spendFile = this.source(this.spendLedger), spend = spendFile.rows.filter(row => row.runId === origin.runId && row.requestId === origin.requestId);
		const reserves = spend.filter(row => row.kind === "budget.reserve"), settles = spend.filter(row => row.kind === "budget.settle");
		assert.equal(reserves.length, 1); assert.equal(settles.length, 1, "request has no unique settlement");
		const settlement = settles[0]!; assert.equal(settlement.currency, bill.currency); assert.equal(settlement.amount, bill.cost);
		spendFile.verify(reserves[0]!); spendFile.verify(settlement);
		assert.equal(settlement.partial, false); assert.equal(settlement.overrun, false);
		return { modelLedger: ledger.path, modelResponseSha256: sha(JSON.stringify(responses[0])), toolInputSha256: sha(JSON.stringify(inputs[0])),
			ledgerRecordSha256: sha(JSON.stringify(bill)), settlementSha256: sha(JSON.stringify(settlement)), requestId: origin.requestId, responseId: origin.responseId, cost: bill.cost, currency: bill.currency };
	}
	after(agent: ObserverAgent, identity: ToolExecutionIdentity, outcome: ToolExecutionOutcome): void {
		assert.ok(!this.outputs.has(identity.executionId), "duplicate execution outcome");
		const { dispatch, started, finished, ok, modelContentSha256, recordedModelContentSha256 } = outcome;
		this.outputs.set(identity.executionId, { agent: Object.freeze({ ...agent }), identity: Object.freeze({ ...identity, source: Object.freeze({ ...identity.source }) }),
			outcome: { dispatch, started: started ? Object.freeze({ ...started }) : null, finished: finished ? Object.freeze({ ...finished }) : null, ok, modelContentSha256, recordedModelContentSha256 } });
	}
	finalize(totals?: { requests: number; cost: number; currency: string }): { path: string; sha256: string; bytes: number }[] {
		const dirs: ObserverAgent[] = [{ name: "lead", role: "lead", dataDir: this.outDir }];
		const agents = join(this.canonicalOutDir, "agents");
		if (existsSync(agents)) {
			assert.ok(lstatSync(agents).isDirectory() && realpathSync(agents) === agents, "aliased agent directory");
			for (const entry of readdirSync(agents, { withFileTypes: true })) {
				assert.ok(entry.isDirectory() && /^[a-z][a-z0-9_]{0,30}$/.test(entry.name) && entry.name !== "lead", "unexpected agent source directory");
				assert.ok(dirs.length < 33, "too many agent sources");
				dirs.push({ name: entry.name, role: "member", dataDir: join(this.outDir, "agents", entry.name) });
			}
		}
		const billed = new Set<string>(), dispatched = new Set<string>(); let requests = 0, cost = 0;
		for (const agent of dirs) {
			const recording = this.source(join(agent.dataDir, "recording.jsonl"));
			const meta = recording.rows.filter(row => row.kind === "meta"); assert.equal(meta.length, 1);
			const inputs = recording.rows.filter(row => row.kind === "tool.input"), outputs = recording.rows.filter(row => row.kind === "tool.output");
			const inputIds = new Set<string>(), outputIds = new Set<string>();
			for (const row of inputs) {
				const input = row.data, id = input.executionId; assert.ok(typeof id === "string" && !inputIds.has(id), "duplicate or missing execution input"); inputIds.add(id);
				const binding = JSON.stringify([input.source?.sessionId, input.source?.requestId, input.toolCallId]); assert.ok(!dispatched.has(binding), "model tool call dispatched twice"); dispatched.add(binding);
				this.before(agent, { executionId: id, source: input.source, toolCallId: input.toolCallId, name: input.name, argumentsSha256: input.argumentsSha256, recordedArgumentsSha256: input.recordedArgumentsSha256 });
			}
			for (const row of outputs) {
				const output = row.data, id = output.executionId;
				assert.ok(inputIds.has(id) && !outputIds.has(id), "orphan or duplicate execution output"); outputIds.add(id);
				assert.ok(["returned", "threw", "not-started"].includes(output.execution?.dispatch), "unknown execution state");
				if (output.execution.dispatch !== "not-started") assert.ok(this.outputs.has(id), "execution has no live controller witness");
			}
			assert.equal(outputIds.size, inputIds.size, "unfinished execution omitted from source evidence");
			const ledgerPath = join(agent.dataDir, "ledger.jsonl"), ledger = existsSync(ledgerPath) ? this.source(ledgerPath).rows : [];
			for (const bill of ledger) {
				assert.equal(bill.sessionId, meta[0]!.data.sessionId); const key = JSON.stringify([bill.runId, bill.requestId]);
				assert.ok(!billed.has(key), "model request was billed twice"); billed.add(key);
				const witnessed = this.models.get(key); assert.ok(witnessed && sha(JSON.stringify(bill)) === witnessed.recordSha256, "unobserved or changed model bill");
				assert.ok(Number.isFinite(bill.cost) && bill.cost >= 0 && bill.costPartial === false, "unverified model charge");
				if (totals) assert.equal(bill.currency, totals.currency);
				const spend = this.source(this.spendLedger).rows.filter(row => row.runId === bill.runId && row.requestId === bill.requestId);
				assert.equal(spend.filter(row => row.kind === "budget.reserve").length, 1);
				const settled = spend.filter(row => row.kind === "budget.settle"); assert.equal(settled.length, 1);
				assert.equal(settled[0]!.amount, bill.cost); assert.equal(settled[0]!.currency, bill.currency); assert.equal(settled[0]!.partial, false); assert.equal(settled[0]!.overrun, false);
				requests++; cost += bill.cost;
			}
		}
		assert.equal(billed.size, this.models.size, "a live model bill was omitted from disk");
		const runs = new Set([...this.models.values()].map(witness => witness.runId)), claims = new Set<string>();
		for (const row of this.source(this.spendLedger).rows.slice(this.spendBaseline.rows)) {
			assert.ok(typeof row.runId === "string" && runs.has(row.runId), "new budget record belongs to an unobserved run");
			if (row.kind === "budget.run-claim") {
				assert.ok(!claims.has(row.runId), "duplicate budget run claim"); claims.add(row.runId);
			} else {
				assert.ok(["budget.reserve", "budget.settle"].includes(row.kind), "unknown new budget record");
				assert.ok(this.models.has(JSON.stringify([row.runId, row.requestId])), "new budget charge has no live model bill");
			}
		}
		for (const run of runs) assert.ok(claims.has(run), "live model run has no new budget claim");
		if (totals) { assert.equal(requests, totals.requests, "summary omits or invents model requests"); assert.ok(Math.abs(cost - totals.cost) <= Number.EPSILON * Math.max(1, requests, cost), "summary cost differs from complete ledgers"); }
		for (const { agent, identity, outcome } of this.outputs.values()) {
			const dir = this.agentDir(agent, identity.source.sessionId), rows = this.source(join(dir, "recording.jsonl")).rows;
			const outputs = rows.filter(row => row.kind === "tool.output" && row.data?.executionId === identity.executionId); assert.equal(outputs.length, 1, "missing or duplicate tool output");
			const output = outputs[0]!.data;
			assert.equal(output.ok, outcome.ok); assert.equal(output.toolCallId, identity.toolCallId); assert.equal(output.name, identity.name);
			assert.equal(JSON.stringify(output.source), JSON.stringify(identity.source));
			assert.equal(output.execution.dispatch, outcome.dispatch);
			assert.equal(output.modelContentSha256, outcome.modelContentSha256); assert.equal(output.recordedModelContentSha256, outcome.recordedModelContentSha256);
			assert.equal(sha(output.modelContent), outcome.recordedModelContentSha256, "recorded result text differs from its live commitment");
			assert.equal(JSON.stringify(output.execution.started), JSON.stringify(outcome.started)); assert.equal(JSON.stringify(output.execution.finished), JSON.stringify(outcome.finished));
			assert.equal(output.observation.before.status, "completed"); assert.equal(output.observation.after.status, "completed");
		}
		return [...this.files.values()].map(file => file.final());
	}
	close(): void { for (const file of this.files.values()) file.close(); }
}
