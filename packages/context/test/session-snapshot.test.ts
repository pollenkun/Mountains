import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { ContextBuilder, type ContextPolicy, type ContextStateV1, type ToolResultMeta } from "../src/index.ts";

type Options = ConstructorParameters<typeof ContextBuilder>[0];
const tools = [
	{ name: "file_read", description: "read a file", parameters: { type: "object" } },
	{ name: "context_expand", description: "recover shown text", parameters: { type: "object" } },
];
const settings: Options = { system: "system text", tools, expandTool: "context_expand", leanRefs: true };
const builder = (overrides: Partial<Options> = {}) => new ContextBuilder({ ...settings, ...overrides });
/** A builder that can archive interactions, as a session with a blob store does. */
const archiving = () => builder({ publicationGuard: { verifyReference: () => true, archiveInteraction: content => {
	const h = createHash("sha256").update(content).digest("hex");
	return `blob_v2_${h}_${"0".repeat(32)}_raw_${h}`;
} } });
const fold: ContextPolicy = { triggerTokens: 1, hardLimitTokens: 1_000_000, compactTokens: 900_000, compactTailTokens: 100, minBatchTokens: 0 };
/** One interaction reading two files: the first is read again over the same lines later, the second is not. */
function appendPair(context: ContextBuilder, id: string): void {
	context.appendAssistant({ role: "assistant", content: "", reasoning: `pair ${id}`, toolCalls: [
		{ id: `${id}_a`, name: "file_read", argumentsJson: '{"path":"a.txt"}' }, { id: `${id}_b`, name: "file_read", argumentsJson: '{"path":"b.txt"}' }] });
	context.appendToolResult(`${id}_a`, "file_read", longText, { kind: "file_content", ref: `shown_${id}_a`, target: "a.txt", lines: { start: 1, end: 10 } });
	context.appendToolResult(`${id}_b`, "file_read", longText, { kind: "file_content", ref: `shown_${id}_b`, target: "b.txt", lines: { start: 1, end: 10 } });
}
function reread(context: ContextBuilder): void {
	context.appendAssistant({ role: "assistant", content: "", reasoning: "again", toolCalls: [{ id: "again", name: "file_read", argumentsJson: '{"path":"a.txt"}' }] });
	context.appendToolResult("again", "file_read", "short", { kind: "file_content", ref: "shown_again", target: "a.txt", lines: { start: 1, end: 10 } });
	context.appendAssistant({ role: "assistant", content: "seen", reasoning: "r", toolCalls: [] });
}
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const longText = "历史正文 original captured bytes\r\n".repeat(1000);

function append(context: ContextBuilder, id: string, meta: Partial<ToolResultMeta> = {}, content = longText): void {
	// Deliberately use a different field insertion order from the protocol schema.
	context.appendAssistant({ reasoning: `思考 ${id}\n`, role: "assistant", toolCalls: [{ argumentsJson: '{ "path" : "文件.txt", "startLine": 1 }', name: "file_read", id }], content: `inspect ${id}` });
	context.appendToolResult(id, "file_read", content, { kind: "file_content", ref: `shown_${id}`, target: `file ${id}`, ...meta });
}

function complete(): ContextBuilder {
	const context = builder();
	context.appendUser("原始用户要求\r\n末尾没有换行");
	context.appendUser("第二条用户要求");
	context.appendRuntimeNotice("这是执行器通知，不是用户授权。");
	append(context, "one", { fullOutputRef: "raw_one", fullOutputSourceCallId: "original_capture" });
	append(context, "two", { preserve: "error" });
	context.appendAssistant({ role: "assistant", content: "最终答复", reasoning: "完整的最后思考", toolCalls: [] });
	return context;
}

function roundtrip(context: ContextBuilder): ContextBuilder {
	const state = jsonCopy(context.exportState());
	const restored = builder();
	restored.restoreState(state);
	assert.deepEqual(restored.plan(), context.plan());
	assert.deepEqual(restored.exportState(), state);
	return restored;
}

function rejected(raw: unknown, target = builder(), reason?: RegExp): void {
	const before = target.plan();
	const counts = [target.length, target.revision, target.assistantTurns];
	if (reason) assert.throws(() => target.restoreState(raw), reason);
	else assert.throws(() => target.restoreState(raw));
	assert.deepEqual(target.plan(), before, "Rejected data must not publish a partial history");
	assert.deepEqual([target.length, target.revision, target.assistantTurns], counts);
}

describe("context session snapshots preserve exact closed state", () => {
	test("empty state and ordinary history roundtrip through JSON without changing reasoning, arguments, or any prefix", () => {
		roundtrip(builder());
		const source = complete();
		const state = source.exportState();
		assert.deepEqual(Object.keys(state), ["format", "version", "history", "revisionCount", "assistantCount", "configHash", "prefixHashes"]);
		assert.match(state.configHash, /^[a-f0-9]{64}$/);
		assert.equal(state.format, "mountains-context");
		assert.equal(state.version, 1);
		assert.equal(state.assistantCount, 3);
		assert.equal(state.history[4]!.meta!.fullOutputSourceCallId, "original_capture");
		assert.equal(state.history[6]!.meta!.preserve, "error");
		const restored = roundtrip(source);
		const old = restored.plan();
		restored.appendUser("现在继续聊");
		assert.deepEqual(restored.plan().prefixHashes.slice(0, old.prefixHashes.length), old.prefixHashes);
		assert.deepEqual(restored.plan().messages.slice(0, old.messages.length), old.messages);
	});

	test("folded state keeps the original text and metadata as well as its frozen placeholder", () => {
		const source = archiving();
		source.appendUser("look at these files");
		appendPair(source, "one");
		reread(source);
		const revision = source.losslessRevision(fold, 0, source.plan().totalTokensEst);
		assert.deepEqual(revision?.maskedRefs, ["shown_one_a"]);
		const state = source.exportState();
		assert.equal(state.history[2]!.message.content, longText);
		assert.match(state.history[2]!.maskedContent!, /^\[Folded file_read result: a\.txt .*ref=shown_one_a/);
		assert.equal(state.history[3]!.maskedContent, undefined);
		assert.equal(state.revisionCount, 1);
		roundtrip(source);
	});

	test("compaction retains cumulative assistant counts, old user words, and the tail", () => {
		const source = archiving();
		source.appendUser("最初的用户要求");
		for (let index = 0; index < 8; index++) {
			append(source, `call_${index}`);
			if (index === 4) source.appendUser("用户后来补充的要求");
		}
		const tail = source.compactionTailStart(1500);
		assert.ok(tail !== null);
		source.applyCompaction("summary", tail, 0, 1_000_000, true);
		const remainingAssistants = source.plan().messages.filter(message => message.role === "assistant").length;
		assert.ok(remainingAssistants < source.assistantTurns);
		assert.equal(source.assistantTurns, 8);
		const restored = roundtrip(source);
		append(restored, "new_call");
		assert.equal(restored.assistantTurns, 9);
		assert.equal(restored.exportState().history.at(-1)!.turn, 9);
	});

	test("export and restore copies never share history, messages, calls, metadata, or hash arrays", () => {
		const source = complete();
		const original = source.plan();
		const state = source.exportState();
		const restored = builder();
		restored.restoreState(state);
		state.history[0]!.message.content = "changed externally";
		const assistant = state.history[3]!.message;
		assert.equal(assistant.role, "assistant");
		if (assistant.role === "assistant") assistant.toolCalls[0]!.argumentsJson = "changed arguments";
		state.history[4]!.meta!.fullOutputSourceCallId = "changed source";
		state.prefixHashes[0] = "0000000000000000";
		assert.deepEqual(source.plan(), original);
		assert.deepEqual(restored.plan(), original);
		const next = restored.exportState();
		next.history[0]!.message.content = "changed exported copy";
		assert.deepEqual(restored.plan(), original);
	});

	test("constructor data fingerprints must match but executable validation functions are not serialized", () => {
		const state = complete().exportState();
		for (const change of [
			{ system: "different system" },
			{ tools: [...tools].reverse() }, { tools: tools.map((tool, index) => index ? tool : { ...tool, description: "changed description" }) },
			{ expandTool: "another_expand" }, { leanRefs: false },
		] satisfies Partial<Options>[]) rejected(state, builder(change), /配置/);
		let calls = 0;
		const guarded = builder({ publicationGuard: { verifyReference: () => { calls++; return true; } } });
		guarded.restoreState(state);
		assert.deepEqual(guarded.exportState(), state);
		assert.equal(calls, 0, "State import/export must not execute dependencies from persisted data");
	});

	test("nonempty builders reject replacement, and a failed import still permits the next valid import", () => {
		const state = complete().exportState();
		const nonempty = builder();
		nonempty.appendUser("already here");
		rejected(state, nonempty, /空上下文/);
		const damaged = jsonCopy(state);
		damaged.prefixHashes[damaged.prefixHashes.length - 1] = "0000000000000000";
		const target = builder();
		rejected(damaged, target, /前缀/);
		target.restoreState(state);
		assert.deepEqual(target.plan(), complete().plan());
	});
});

describe("context snapshots reject incomplete, corrupted, and unsafe data", () => {
	test("export refuses a missing result, duplicate call, wrong result, or orphan result", () => {
		const pending = builder();
		pending.appendAssistant({ role: "assistant", content: "", reasoning: "", toolCalls: [{ id: "missing", name: "file_read", argumentsJson: "{}" }] });
		assert.throws(() => pending.exportState(), /结果尚未齐全/);
		const duplicate = builder(); append(duplicate, "same");
		assert.throws(() => append(duplicate, "same"), /编号重复/);
		assert.doesNotThrow(() => duplicate.exportState());
		const wrong = builder();
		wrong.appendAssistant({ role: "assistant", content: "", reasoning: "", toolCalls: [{ id: "wrong", name: "file_read", argumentsJson: "{}" }] });
		wrong.appendToolResult("wrong", "command_run", "result", { kind: "tool_output", ref: "shown_wrong", target: "wrong" });
		assert.throws(() => wrong.exportState(), /匹配/);
		const orphan = builder(); orphan.appendToolResult("orphan", "file_read", "text", { kind: "file_content", ref: "shown_orphan", target: "orphan" });
		assert.throws(() => orphan.exportState());
	});

	test("format, version, required fields, role-specific fields, counters, and every prefix are checked", () => {
		const state = complete().exportState();
		for (const version of [undefined, null, 0, 2, "1"]) rejected({ ...state, version });
		rejected({ ...state, format: "another-format" });
		for (const field of Object.keys(state)) {
			const copy = jsonCopy(state) as unknown as Record<string, unknown>;
			delete copy[field]; rejected(copy);
		}
		for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "3"]) {
			rejected({ ...state, assistantCount: value }); rejected({ ...state, revisionCount: value });
		}
		rejected({ ...state, assistantCount: 4 });
		rejected({ ...state, configHash: "not-a-hash" });
		for (const index of [0, 1, 4, state.prefixHashes.length - 1]) {
			const copy = jsonCopy(state); copy.prefixHashes[index] = "0000000000000000"; rejected(copy, builder(), /前缀/);
		}
		rejected({ ...state, prefixHashes: state.prefixHashes.slice(1) });
		rejected({ ...state, prefixHashes: [...state.prefixHashes, "0000000000000000"] });
		rejected({ ...state, prefixHashes: ["invalid hash"] });
		const invalidRole = jsonCopy(state) as unknown as { history: { message: Record<string, unknown> }[] };
		invalidRole.history[0]!.message.role = "system"; rejected(invalidRole);
		const oddUser = jsonCopy(state) as unknown as { history: { message: Record<string, unknown> }[] };
		oddUser.history[0]!.message.toolCalls = []; rejected(oddUser);
		const turn = jsonCopy(state); turn.history[4]!.turn = 0; rejected(turn);
	});

	test("restore refuses every broken tool pairing before publishing history", () => {
		const state = complete().exportState();
		const modifications: ((copy: ContextStateV1) => void)[] = [
			copy => { copy.history.splice(4, 1); },
			copy => { const message = copy.history[4]!.message; if (message.role === "tool") message.toolCallId = "unknown"; },
			copy => { const message = copy.history[4]!.message; if (message.role === "tool") message.name = "command_run"; },
			copy => { copy.history.splice(5, 0, jsonCopy(copy.history[4]!)); },
			copy => { const message = copy.history[5]!.message; if (message.role === "assistant") message.toolCalls[0]!.id = "one"; },
		];
		for (const modify of modifications) { const copy = jsonCopy(state); modify(copy); rejected(copy); }
	});

	test("metadata must use the real public shape and masked content must agree with it", () => {
		const state = complete().exportState();
		for (const meta of [undefined, null, {}, { ...state.history[4]!.meta, kind: "raw" },
			{ ...state.history[4]!.meta, preserve: "allow" }, { ...state.history[4]!.meta, ref: "" },
			{ kind: "tool_output", ref: "shown", target: "target", fullOutputSourceCallId: "source-without-raw" },
		]) {
			const copy = jsonCopy(state) as unknown as { history: { meta?: unknown }[] };
			copy.history[4]!.meta = meta; rejected(copy);
		}
		const nonTool = jsonCopy(state); nonTool.history[0]!.meta = state.history[4]!.meta!; rejected(nonTool);
		const protectedMask = jsonCopy(state); protectedMask.revisionCount = 1; protectedMask.history[6]!.maskedContent = "fake placeholder"; rejected(protectedMask);
		const source = archiving(); source.appendUser("request"); appendPair(source, "one"); reread(source);
		source.losslessRevision(fold, 0, source.plan().totalTokensEst);
		const masked = source.exportState();
		const content = jsonCopy(masked); content.history[2]!.maskedContent = "arbitrary text"; rejected(content, builder(), /占位/);
		const ref = jsonCopy(masked); ref.history[2]!.meta!.ref = "different-ref"; rejected(ref, builder(), /占位/);
		const revision = jsonCopy(masked); revision.revisionCount = 0; rejected(revision);
	});

	test("custom prototypes, prototype keys, symbols, getters, toJSON, sparse arrays, and extra array properties are rejected without executing them", () => {
		const state = complete().exportState();
		rejected(Object.assign(Object.create({ inherited: true }), state));
		for (const key of ["__proto__", "constructor", "prototype"]) {
			const copy = jsonCopy(state) as unknown as Record<string, unknown>;
			Object.defineProperty(copy, key, { value: {}, enumerable: true }); rejected(copy);
			const nested = jsonCopy(state);
			Object.defineProperty(nested.history[4]!.meta!, key, { value: {}, enumerable: true }); rejected(nested);
		}
		const symbol = jsonCopy(state); Object.defineProperty(symbol, Symbol("hidden"), { value: 1 }); rejected(symbol);
		let executions = 0;
		const accessor = jsonCopy(state); Object.defineProperty(accessor.history[0]!.message, "content", { enumerable: true, get: () => { executions++; return "unsafe"; } }); rejected(accessor);
		const json = { ...state, toJSON: () => { executions++; return state; } }; rejected(json);
		const sparse = jsonCopy(state); delete sparse.history[0]; rejected(sparse);
		const arrayGetter = jsonCopy(state); Object.defineProperty(arrayGetter.history, "0", { enumerable: true, get: () => { executions++; return state.history[0]; } }); rejected(arrayGetter);
		const arrayExtra = jsonCopy(state); Object.defineProperty(arrayExtra.history, "extra", { value: true }); rejected(arrayExtra);
		assert.equal(executions, 0);
	});

	test("history, tool call count, individual UTF-8 strings, and total serialized bytes are bounded", () => {
		const state = complete().exportState();
		rejected({ ...state, history: Array(20_001).fill(state.history[0]) }, builder(), /数组/);
		const calls = jsonCopy(state);
		const assistant = calls.history[3]!.message;
		if (assistant.role === "assistant") assistant.toolCalls = Array(1025).fill(assistant.toolCalls[0]);
		rejected(calls, builder(), /数组/);
		const long = jsonCopy(state); long.history[0]!.message.content = "x".repeat(8 * 1024 * 1024 + 1); rejected(long, builder(), /过长/);
		const utf8 = jsonCopy(state); utf8.history[0]!.message.content = "文".repeat(3 * 1024 * 1024); rejected(utf8, builder(), /大小/);
		const many = builder().exportState();
		many.history = Array.from({ length: 5 }, () => ({ message: { role: "user", content: "x".repeat(7 * 1024 * 1024) }, turn: 0 }));
		rejected(many, builder(), /大小/);
	});
});
