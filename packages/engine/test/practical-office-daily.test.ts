import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertToolPairing } from "@mountains/context";
import { isValidEvent, type EngineEvent } from "@mountains/protocol";
import type { ModelRequest, ModelResponse, ModelStreamHandlers } from "@mountains/providers";
import type { SessionMatch, SessionSearchResult } from "@mountains/tools";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse, type RunSummary } from "../src/index.ts";

// Synthetic office documents, real tools/commands/archives, deterministic model
// choices. These are workflow contracts, not a claim of model task success or
// support for binary Office documents or an interactive Preview 1 CLI.
type Call = { id: string; name: string; args: Record<string, unknown> };
type Step = (request: ModelRequest) => RecordedResponse;
const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, args });
function reply(calls: Call[] = [], content = "Synthetic workflow verified."): RecordedResponse {
	return {
		ok: true, message: { role: "assistant", content: calls.length ? "" : content, reasoning: "offline scenario", toolCalls: calls.map(({ id, name, args }) => ({ id, name, argumentsJson: JSON.stringify(args) })) },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash",
		rawUsage: { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 120 },
		httpStatus: 200, error: null, aborted: false,
	};
}
class Scenario extends ScriptedModelAdapter {
	private readonly recordedQueue: RecordedResponse[];
	private readonly steps: Step[];
	failure: unknown;
	constructor(steps: Step[]) {
		const responses: RecordedResponse[] = [];
		super(responses); this.recordedQueue = responses; this.steps = [...steps];
	}
	prepend(step: Step): void { this.steps.unshift(step); }
	override async complete(request: ModelRequest, handlers?: ModelStreamHandlers): Promise<ModelResponse> {
		try {
			assertToolPairing(request.messages);
			const step = this.steps.shift();
			assert.ok(step, "the engine sent an unplanned extra request");
			this.recordedQueue.push(step(request));
			return await super.complete(request, handlers);
		} catch (error) { this.failure = error; throw error; }
	}
	check(result: RunSummary, status: RunSummary["status"] = "completed"): void {
		assert.ifError(this.failure);
		assert.equal(result.status, status, result.reason);
	}
	done(): void { assert.equal(this.steps.length, 0, "every planned step must run"); }
}
function output(request: ModelRequest, id: string): string {
	const result = request.messages.find(message => message.role === "tool" && message.toolCallId === id);
	assert.ok(result?.role === "tool", `missing actual result for ${id}`);
	return result.content;
}
function completed(events: EngineEvent[], id: string) {
	const event = events.find(event => event.type === "tool.completed" && event.toolCallId === id);
	assert.ok(event?.type === "tool.completed", `missing completion for ${id}`);
	assert.ok(event.details && typeof event.details === "object" && !Array.isArray(event.details));
	return { ...event, details: event.details as Record<string, unknown> };
}
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "mountains-office-daily-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
	const workspace = join(root, "Synthetic office 工作"); mkdirSync(workspace);
	const budget = new BudgetGuard({ globalLimit: 20, ledgerPath: join(root, "spend.jsonl") });
	let instance = 0;
	function put(path: string, content: string): void {
		mkdirSync(dirname(join(workspace, path)), { recursive: true });
		writeFileSync(join(workspace, path), content);
	}
	function session(adapter: Scenario, extra: Partial<EngineOptions> = {}) {
		const events: EngineEvent[] = [];
		const options: EngineOptions = {
			workspace, dataDir: join(root, `run-data-${++instance}`), archiveDir: join(root, "archive"), sessionId: "ses_office_daily",
			adapter, model: "deepseek-flash", thinking: { enabled: false, effort: "default" }, maxTokens: 512,
			checkpoints: false, requestGuard: true, allowSessionSnapshots: true, budget,
			retry: { maxAttempts: 1, baseDelayMs: 0 }, limits: { maxTurns: 40, maxRequests: 40, maxCost: 2 },
			...extra, onEvent(event) { events.push(event); extra.onEvent?.(event); },
		};
		return { agent: new AgentSession(options), events, options };
	}
	return { root, workspace, put, session, budget };
}
const node = (script: string, ...args: string[]) => ({ argv: [process.execPath, script, ...args] });
const read = (id: string, path: string) => call(id, "file_read", { path });
const write = (id: string, path: string, content: string) => call(id, "file_write", { path, content });

// The generated helper is deliberately a plain Node script. CSV parsing and
// arithmetic are performed by this local command, not attributed to the engine.
const csvReportProgram = String.raw`const fs = require('node:fs');
const path = require('node:path');
function parse(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('Unclosed quoted cell');
  if (row.length || cell) { row.push(cell); rows.push(row); }
  return rows;
}
function cents(amount) {
  if (!/^-?\d+\.\d{2}$/.test(amount)) throw new Error('Invalid decimal: ' + amount);
  const negative = amount.startsWith('-');
  const [whole, fraction] = amount.replace(/^-/, '').split('.');
  return (negative ? -1 : 1) * (Number(whole) * 100 + Number(fraction));
}
const [input, jsonPath, markdownPath] = process.argv.slice(2);
try {
  const [header, ...rows] = parse(fs.readFileSync(input, 'utf8'));
  if (JSON.stringify(header) !== JSON.stringify(['id', 'category', 'amount', 'description'])) throw new Error('Unexpected CSV header');
  const ids = new Set(), totals = {}, descriptions = [];
  for (const row of rows) {
    if (row.length !== 4) throw new Error('Wrong field count');
    const [id, category, amount, description] = row;
    if (ids.has(id)) throw new Error('Duplicate entry: ' + id);
    ids.add(id); descriptions.push(description);
    totals[category] = (totals[category] || 0) + cents(amount);
  }
  const summary = { rows: rows.length, cents: Object.values(totals).reduce((a, b) => a + b, 0), byCategory: totals, descriptions };
  for (const target of [jsonPath, markdownPath]) fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(markdownPath, '# Office supplies\n\nValidated rows: ' + summary.rows + '\nTotal cents: ' + summary.cents + '\n');
  console.log(JSON.stringify(summary));
} catch (error) { console.error(error.message); process.exitCode = 2; }
`;
const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const csvRow = (values: string[]) => values.map(csvCell).join(",");

for (const variant of [
	{ name: "CRLF with BOM and quoted commas", seed: 17, eol: "\r\n", bom: "\uFEFF", description: 'Café supplies, "blue" folders', credit: "-2.50" },
	{ name: "LF with a multiline cell and zero-cost sample", seed: 91, eol: "\n", bom: "", description: "会议材料\nsecond shelf", credit: "0.00" },
	{ name: "no terminal newline and a supplementary Unicode filename", seed: 2026, eol: "\n", bom: "", description: "Workshop 📚 sheets", credit: "-0.01" },
]) {
	test(`office CSV: duplicate import is repaired without changing the original (${variant.name})`, { timeout: 60_000 }, async t => {
		const f = fixture(t);
		const source = `Inbox/采购 ${variant.seed} 📚.csv`, cleaned = "Working/cleaned supplies.csv";
		const program = "Utilities/build report.cjs", report = "Reports/供应 summary.json", markdown = "Reports/供应 summary.md";
		const dollars = 10 + variant.seed % 20;
		const rows = [
			[`OFFICE-${variant.seed}-A`, "Stationery", `${dollars}.09`, variant.description],
			[`OFFICE-${variant.seed}-B`, "Stationery", variant.credit, "Return or free sample"],
			[`OFFICE-${variant.seed}-C`, "会议", "4.25", "Paper"],
		];
		const lines = rows.map(csvRow);
		const ending = variant.seed === 2026 ? "" : variant.eol;
		const imported = variant.bom + ["id,category,amount,description", ...lines, lines[0]!].join(variant.eol) + ending;
		const expected = variant.bom + ["id,category,amount,description", ...lines].join(variant.eol) + ending;
		f.put(source, imported);
		const sourceBytes = readFileSync(join(f.workspace, source));
		const command = () => call("validate-fixed", "command_run", node(program, cleaned, report, markdown));
		const adapter = new Scenario([
			() => reply([read("inspect-import", source)]),
			request => {
				assert.ok(output(request, "inspect-import").includes(`OFFICE-${variant.seed}-A`));
				return reply([write("working-copy", cleaned, imported), write("report-script", program, csvReportProgram)]);
			},
			() => reply([call("validate-import", "command_run", node(program, cleaned, report, markdown))]),
			request => {
				assert.match(output(request, "validate-import"), /Duplicate entry: OFFICE-/);
				assert.equal(existsSync(join(f.workspace, report)), false, "a rejected import must not produce a successful report");
				return reply([read("read-for-repair", cleaned)]);
			},
			() => reply([call("remove-duplicate", "file_edit", {
				path: cleaned, oldText: `${lines[2]}${variant.eol}${lines[0]}${ending}`, newText: `${lines[2]}${ending}`,
			})]),
			() => reply([command()]),
			request => {
				assert.match(output(request, "validate-fixed"), /exit code 0/);
				return reply([read("report-json", report), read("report-markdown", markdown)]);
			},
			request => {
				assert.match(output(request, "report-json"), /"rows": 3/);
				assert.match(output(request, "report-markdown"), /Validated rows: 3/);
				return reply();
			},
		]);
		const { agent, events } = f.session(adapter);
		adapter.check(await agent.run(`Prepare a local supplies report from ${source}; preserve the original, remove the duplicate import from a working copy, and validate the report.`));
		adapter.done();
		const credit = variant.credit === "-2.50" ? -250 : variant.credit === "-0.01" ? -1 : 0;
		assert.deepEqual(JSON.parse(readFileSync(join(f.workspace, report), "utf8")), {
			rows: 3, cents: dollars * 100 + 9 + credit + 425, byCategory: { Stationery: dollars * 100 + 9 + credit, 会议: 425 }, descriptions: rows.map(row => row[3]),
		});
		assert.equal(readFileSync(join(f.workspace, cleaned), "utf8"), expected, "repair preserves BOM, line endings and final-newline choice");
		assert.deepEqual(readFileSync(join(f.workspace, source)), sourceBytes);
		assert.equal(completed(events, "validate-import").details.exitCode, 2);
		assert.equal(completed(events, "validate-fixed").ok, true);
	});
}

test("office notes: a partial discovery failure and stale edit are repaired before organizing Markdown and text documents", { timeout: 60_000 }, async t => {
	const f = fixture(t);
	const notes = "Inbox/项目 [A]/Meeting notes.md", memo = "Inbox/项目 [A]/Café follow up.txt";
	const manifest = "Inbox/collection.json", destination = "Organized/项目 [A]";
	const original = "# Weekly planning\n- [ ] TODO: Draft agenda\n- [ ] TODO: Confirm room\n";
	const correction = "Owner correction: Use room B, keep the original wording above.\n";
	f.put(notes, original); f.put(memo, "Synthetic follow-up\nTODO: Bring paper handouts\n");
	f.put("Inbox/项目 A/Decoy.txt", "TODO: This sibling is outside the literal directory scope.\n");
	f.put(manifest, JSON.stringify({ label: "Office collection", folder: destination }, null, 2) + "\n");
	const sourceMemo = readFileSync(join(f.workspace, memo));
	const copyingProgram = "const fs=require('node:fs'),p=require('node:path');const [target,...sources]=process.argv.slice(1);fs.mkdirSync(target,{recursive:true});for(const source of sources)fs.copyFileSync(source,p.join(target,p.basename(source)));console.log(JSON.stringify(sources));";
	const adapter = new Scenario([
		() => reply([call("discover", "query_plan", { steps: [
			{ id: "manifest", op: "read", path: manifest },
			{ id: "destination", op: "json_field", path: manifest, field: ["destination"] },
			{ id: "notes", op: "read", path: notes },
			{ id: "todos", op: "search", path: "Inbox/项目 [A]", pattern: "TODO:" },
		] })]),
		request => {
			const discovery = output(request, "discover");
			assert.match(discovery, /Missing JSON field destination/);
			assert.match(discovery, /Draft agenda/);
			assert.match(discovery, /Bring paper handouts/);
			assert.equal(discovery.includes("outside the literal directory scope"), false);
			// A real external edit between observation and mutation. The tool must
			// preserve this correction even though the oldText still matches.
			f.put(notes, original + correction);
			return reply([
				call("fix-manifest", "file_edit", { path: manifest, oldText: '"folder":', newText: '"destination":' }),
				call("stale-checkoff", "file_edit", { path: notes, oldText: "- [ ] TODO: Draft agenda", newText: "- [x] TODO: Draft agenda" }),
			]);
		},
		request => {
			assert.match(output(request, "stale-checkoff"), /自上次读取后已改变/);
			assert.equal(readFileSync(join(f.workspace, notes), "utf8"), original + correction);
			return reply([read("refresh-notes", notes), read("read-memo", memo)]);
		},
		() => reply([call("checkoff-current", "file_edit", { path: notes, oldText: "- [ ] TODO: Draft agenda", newText: "- [x] TODO: Draft agenda" })]),
		() => reply([call("organize-copies", "command_run", { argv: [process.execPath, "-e", copyingProgram, destination, notes, memo] })]),
		request => {
			assert.match(output(request, "organize-copies"), /exit code 0/);
			return reply([write("collection-index", `${destination}/Index.md`, "# Project A documents\n\n- [Meeting notes](Meeting%20notes.md)\n- [Follow-up](Caf%C3%A9%20follow%20up.txt)\n\nOpen: Confirm room B; bring paper handouts.\n"), call("verify-destination", "query_plan", { steps: [
				{ id: "destination", op: "json_field", path: manifest, field: ["destination"] },
				{ id: "notes", op: "read", path: `${destination}/Meeting notes.md` },
				{ id: "memo", op: "read", path: `${destination}/Café follow up.txt` },
			] })]);
		},
		request => {
			assert.match(output(request, "verify-destination"), /Owner correction: Use room B/);
			return reply();
		},
	]);
	const { agent, events } = f.session(adapter);
	adapter.check(await agent.run("Check off the drafted agenda and organize the Project A Markdown/text documents as copies with an index. Preserve unrelated notes and any concurrent owner corrections."));
	adapter.done();
	const discovery = completed(events, "discover");
	assert.equal(discovery.ok, false); assert.equal(discovery.details.partial, true); assert.equal(discovery.details.receiptsVerified, true);
	assert.equal(completed(events, "fix-manifest").ok, true, "an independently verified read in a partial query remains usable for repair");
	assert.equal(completed(events, "stale-checkoff").ok, false);
	assert.equal(completed(events, "organize-copies").ok, true);
	assert.equal(readFileSync(join(f.workspace, `${destination}/Meeting notes.md`), "utf8"), original.replace("- [ ] TODO: Draft agenda", "- [x] TODO: Draft agenda") + correction);
	assert.deepEqual(readFileSync(join(f.workspace, memo)), sourceMemo);
	assert.deepEqual(readFileSync(join(f.workspace, `${destination}/Café follow up.txt`)), sourceMemo);
	assert.equal(readFileSync(join(f.workspace, "Inbox/项目 A/Decoy.txt"), "utf8"), "TODO: This sibling is outside the literal directory scope.\n");
});

// Exercise bounded session-search pagination through real engine calls. The
// cursor belongs to a fixed search snapshot, even as these results are indexed.
function searchPages(adapter: Scenario, initialId: string, needle: string, finished: (matches: SessionMatch[], pages: number) => RecordedResponse): Step {
	let id = initialId, pages = 0;
	const matches: SessionMatch[] = [];
	const next: Step = request => {
		const result = JSON.parse(output(request, id)) as SessionSearchResult;
		assert.equal(result.ok, true);
		matches.push(...result.matches); pages++;
		assert.equal(result.unavailableRecords, 0);
		if (!result.complete) {
			assert.ok(result.nextCursor, "partial history must provide a continuation cursor");
			assert.ok(pages < 30, "bounded fixture history should finish paging");
			id = `${initialId}-${pages + 1}`; adapter.prepend(next);
			return reply([call(id, "session_search", { needle, cursor: result.nextCursor, maxMatches: 1 })]);
		}
		return finished(matches, pages);
	};
	return next;
}

test("daily TODOs: successive requests, user corrections and historical evidence survive a disk snapshot restart", { timeout: 60_000 }, async t => {
	const f = fixture(t), todo = "Daily notes/今日 TODO.md";
	const firstTask = "Prepare a TODO list: draft the proposal, confirm the room, and print handouts. The original room choice is ROOM-A-123.";
	const correctionTask = "Correction: ROOM-B-456 replaces ROOM-A-123. The proposal is now drafted; keep room confirmation open.";
	const initialTodo = "# Today\n- [ ] Draft proposal\n- [ ] Confirm room ROOM-A-123\n- [ ] Print handouts\n";
	const correctedTodo = "# Today\n- [x] Draft proposal\n- [ ] Confirm room ROOM-B-456\n- [ ] Print handouts\n";
	let firstAdapter!: Scenario;
	firstAdapter = new Scenario([
		() => reply([write("create-todo", todo, initialTodo), call("save-working-note", "task_note", {
			requirements: ["Preserve incomplete TODOs"], facts: ["The requested initial room is ROOM-A-123"], next: "Wait for the user's completion updates",
		})]),
		() => reply([read("todo-original", todo)]),
		() => reply([], "The initial TODO list is saved, with ROOM-A-123 still unconfirmed."),
		request => {
			assert.ok(request.messages.some(message => message.role === "user" && message.content === firstTask));
			assert.equal(request.messages.at(-1)?.content, correctionTask);
			return reply([read("todo-before-update", todo)]);
		},
		request => {
			assert.match(output(request, "todo-before-update"), /- \[ \] Draft proposal/, "a new user request must receive a fresh source observation");
			return reply([call("apply-todo-correction", "file_edit", { path: todo, edits: [
				{ oldText: "- [ ] Draft proposal", newText: "- [x] Draft proposal" },
				{ oldText: "ROOM-A-123", newText: "ROOM-B-456" },
			] })]);
		},
		() => reply([], "Proposal marked done; ROOM-B-456 and handouts remain open."),
	]);
	const first = f.session(firstAdapter);
	firstAdapter.check(await first.agent.run(firstTask));
	firstAdapter.check(await first.agent.run(correctionTask)); firstAdapter.done();
	assert.equal(readFileSync(join(f.workspace, todo), "utf8"), correctedTodo);
	const snapshotFile = join(f.root, "closed-session.json");
	writeFileSync(snapshotFile, JSON.stringify(first.agent.exportSnapshot()));
	const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
	const spent = f.budget.globalSpent;
	let historicalRef = "";
	let resumedAdapter!: Scenario;
	resumedAdapter = new Scenario([
		request => {
			for (const task of [firstTask, correctionTask]) assert.ok(request.messages.some(message => message.role === "user" && message.content === task));
			const note = request.messages.flatMap(message => message.role === "assistant" ? message.toolCalls : []).find(tool => tool.id === "save-working-note");
			assert.equal(JSON.parse(note!.argumentsJson).requirements[0], "Preserve incomplete TODOs");
			return reply([call("find-old-room", "session_search", { needle: "ROOM-A-123", maxMatches: 1 })]);
		},
		request => searchPages(resumedAdapter, "find-old-room", "ROOM-A-123", (matches, pages) => {
			assert.ok(pages > 1, "the scenario must actually exercise continuation");
			assert.ok(matches.some(hit => hit.role === "user" && hit.text.includes("original room choice")));
			const oldRead = matches.find(hit => hit.toolCallId === "todo-original");
			assert.ok(oldRead, "the old source read remains indexed after restart"); historicalRef = oldRead.ref;
			return reply([call("recover-old-source", "context_expand", { ref: historicalRef }), read("observe-current-todo", todo)]);
		})(request),
		request => {
			assert.match(output(request, "recover-old-source"), /- \[ \] Confirm room ROOM-A-123/);
			assert.match(output(request, "observe-current-todo"), /- \[ \] Confirm room ROOM-B-456/);
			assert.equal(output(request, "observe-current-todo").includes("ROOM-A-123"), false);
			return reply([call("mark-handouts", "file_edit", { path: todo, oldText: "- [ ] Print handouts", newText: "- [x] Print handouts" })]);
		},
		() => reply([], "Handouts are done. Only confirmation of ROOM-B-456 remains."),
	]);
	const resumed = f.session(resumedAdapter);
	resumed.agent.restoreSnapshot(snapshot);
	assert.equal(resumedAdapter.requests.length, 0); assert.equal(f.budget.globalSpent, spent, "restoration neither replays work nor charges a request");
	resumedAdapter.check(await resumed.agent.run("What changed since the first room choice? The handouts are now printed; update the remaining TODOs."));
	resumedAdapter.done();
	assert.equal(readFileSync(join(f.workspace, todo), "utf8"), correctedTodo.replace("- [ ] Print handouts", "- [x] Print handouts"));
	assert.ok(f.budget.globalSpent > spent);
	const events = [...first.events, ...resumed.events];
	assert.ok(events.every(isValidEvent));
	assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq), "event ordering continues across restart");
	assert.equal(events.filter(event => event.type === "session.started").length, 1);
	assert.equal(new Set(events.filter(event => event.type === "run.started").map(event => event.runId)).size, 3);
	assert.equal(resumed.agent.exportSnapshot().runCount, 3);
});

test("daily batch: cancelling a real command preserves a completed copy and restart finishes only the missing work", { timeout: 90_000 }, async t => {
	const f = fixture(t), progress = "Working/progress.json", source = "Inbox/手順 notes.txt", copied = "Organized/手順 notes.txt";
	f.put(source, "Synthetic procedures\nKeep originals.\n");
	f.put("Utilities/stage batch.cjs", String.raw`const fs = require('node:fs'), path = require('node:path');
const [source, copy, journal] = process.argv.slice(2);
fs.mkdirSync(path.dirname(copy), { recursive: true });
fs.mkdirSync(path.dirname(journal), { recursive: true });
fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(journal, JSON.stringify({ completed: [copy], pid: process.pid }) + '\n');
console.log('COPY_RECORDED');
setInterval(() => {}, 1000);
`);
	const firstAdapter = new Scenario([
		() => reply([call("record-progress", "command_run", { ...node("Utilities/stage batch.cjs", source, copied, progress), timeoutMs: 60_000 }), write("must-not-publish", "Organized/Finished.md", "Incorrect premature completion\n")]),
	]);
	const first = f.session(firstAdapter), controller = new AbortController();
	const running = first.agent.run("Organize the procedure notes and then create the completion summary. Keep a progress journal so work can be resumed.", controller.signal);
	let journal: { completed: string[]; pid: number } | undefined;
	let cancelled: RunSummary;
	try {
		const deadline = Date.now() + 45_000;
		while (!journal && Date.now() < deadline) {
			try { journal = JSON.parse(readFileSync(join(f.workspace, progress), "utf8")); }
			catch (error) {
				// File creation and its small write are separate syscalls; wait for
				// the complete journal rather than cancelling on an empty file.
				if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!journal) await delay(25);
		}
		assert.ok(journal, "the real command must reach its durable progress point before cancellation");
	} finally {
		controller.abort();
		// Even a failed readiness assertion must settle the child before the
		// test's temporary-directory cleanup starts.
		cancelled = await running;
	}
	firstAdapter.check(cancelled, "cancelled"); firstAdapter.done();
	assert.deepEqual(journal?.completed, [copied]);
	assert.equal(cancelled.finalText, "");
	assert.equal(completed(first.events, "record-progress").details.cancelled, true);
	assert.equal(completed(first.events, "must-not-publish").ok, false);
	assert.equal(existsSync(join(f.workspace, "Organized/Finished.md")), false);
	assertToolPairing(first.agent.builder.plan().messages);
	assert.ok(journal && journal.pid > 0);
	assert.throws(() => process.kill(journal!.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", "the directly launched process must be gone before restart");
	const originalCopy = readFileSync(join(f.workspace, copied));
	// A fresh object and an on-disk JSON snapshot model a host restart; the CLI
	// itself remains single-task and provides no interactive resume command.
	const snapshotFile = join(f.root, "cancelled-session.json");
	writeFileSync(snapshotFile, JSON.stringify(first.agent.exportSnapshot()));
	const resumedAdapter = new Scenario([
		request => {
			assert.match(output(request, "record-progress"), /cancelled/);
			return reply([read("progress-after-restart", progress), read("copied-after-restart", copied)]);
		},
		request => {
			assert.match(output(request, "progress-after-restart"), /completed/);
			assert.match(output(request, "copied-after-restart"), /Keep originals/);
			return reply([write("finish-summary", "Organized/Finished.md", "# Completed\n\nProcedure notes copied once. The interrupted command was not replayed.\n")]);
		},
		() => reply([call("verify-resumed-batch", "command_run", { argv: [process.execPath, "-e", "const fs=require('node:fs'),a=require('node:assert/strict');const [source,copy,summary]=process.argv.slice(1);a.deepEqual(fs.readFileSync(copy),fs.readFileSync(source));a.match(fs.readFileSync(summary,'utf8'),/copied once/);console.log('RESUMED_BATCH_OK');", source, copied, "Organized/Finished.md"] })]),
		request => { assert.match(output(request, "verify-resumed-batch"), /RESUMED_BATCH_OK/); return reply(); },
	]);
	const resumed = f.session(resumedAdapter);
	resumed.agent.restoreSnapshot(JSON.parse(readFileSync(snapshotFile, "utf8")));
	resumedAdapter.check(await resumed.agent.run("Resume from the saved progress. Do not repeat the completed copy; finish and validate the missing summary."));
	resumedAdapter.done();
	assert.deepEqual(readFileSync(join(f.workspace, copied)), originalCopy);
	assert.equal(readFileSync(join(f.workspace, progress), "utf8"), JSON.stringify(journal) + "\n", "the completed command must never be replayed during restoration or repair");
	assert.equal(completed(resumed.events, "verify-resumed-batch").ok, true);
	assert.equal([...first.events, ...resumed.events].filter(event => event.type === "tool.requested" && event.toolCallId === "record-progress").length, 1);
});
