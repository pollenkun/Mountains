import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { CachePlanner, ContextBuilder, ContextPublicationError, type MaskingConfig, type PublicationGuard, type ToolResultMeta } from "../src/index.ts";

const tools = [
	{ name: "file_read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
	{ name: "context_expand", description: "recover historical bytes", parameters: { type: "object" } },
];
const config: MaskingConfig = { enabled: true, triggerTokens: 1, keepRecentToolResults: 0, minBatchTokens: 0, hardLimitTokens: 1_000_000 };
const text = "historical fact: original value\n".repeat(400);

function guarded(verify: PublicationGuard["verifyReference"] = () => true): ContextBuilder {
	return new ContextBuilder({ system: "system", tools, expandTool: "context_expand", publicationGuard: { verifyReference: verify } });
}

function append(builder: ContextBuilder, id: string, meta: Partial<ToolResultMeta> = {}, content = text): void {
	builder.appendAssistant({ role: "assistant", content: `inspect ${id}`, reasoning: `reasoning ${id}`, toolCalls: [{ id, name: "file_read", argumentsJson: '{ "path": "file" }' }] });
	builder.appendToolResult(id, "file_read", content, { kind: "file_content", ref: `shown_${id}`, target: "file at capture time", ...meta });
}

function rejectsWithoutMutation(builder: ContextBuilder, code: ContextPublicationError["code"], cfg = config, reserved = 0): void {
	const before = builder.plan();
	assert.throws(() => new CachePlanner(cfg).beforeRequest(builder, reserved), (error: unknown) => error instanceof ContextPublicationError && error.code === code);
	assert.deepEqual(builder.plan(), before);
}

describe("v4 publication is atomic and protects registered content", () => {
	test("ordinary requests add no capsule, require no archive access, and retain the exact old prefix", () => {
		const builder = guarded(() => { throw new Error("must not check untouched evidence"); });
		builder.appendUser("Keep this exact request.");
		const first = builder.plan();
		append(builder, "one");
		assert.equal(new CachePlanner({ ...config, enabled: false }).beforeRequest(builder, 100), null);
		const next = builder.plan();
		assert.deepEqual(next.prefixHashes.slice(0, first.prefixHashes.length), first.prefixHashes);
		assert.equal(next.messages.length, 3);
		assert.equal(next.system, "system");
	});

	test("original tools, returned tools, returned segments and returned messages cannot rewrite the prefix", () => {
		const definitions = structuredClone(tools);
		const builder = new ContextBuilder({ system: "s", tools: definitions });
		builder.appendUser("original user words");
		append(builder, "one");
		const before = builder.plan();
		const expected = structuredClone(before);
		definitions[0]!.parameters.properties!.path.type = "number";
		(before.tools[0]!.parameters as { type: string }).type = "array";
		before.messages[0]!.content = "mutated user";
		const assistant = before.messages[1]!;
		if (assistant.role === "assistant") assistant.toolCalls[0]!.argumentsJson = "changed";
		before.segments[0]!.hash = "fake";
		assert.deepEqual(builder.plan(), expected);
		assert.throws(() => { (builder.tools[0]!.parameters as { type: string }).type = "array"; }, TypeError);
	});

	test("user requirements, unresolved items, errors, and memory invalidation remain verbatim", () => {
		const builder = new ContextBuilder({ system: "s", memory: "OLD memory: port=3000", tools, expandTool: "context_expand", publicationGuard: { verifyReference: () => true } });
		builder.appendUser("Keep the API; fix the old port. Do not deploy.");
		append(builder, "ordinary");
		append(builder, "unresolved", { preserve: "unresolved" }, `Not resolved: race condition\n${text}`);
		append(builder, "error", { preserve: "error" }, `exit=1; integration test failed\n${text}`);
		append(builder, "invalidation", { preserve: "memory-invalidation" }, `OLD port=3000 is invalid. Current port=4000.\n${text}`);
		builder.appendUser("Correction: no deployment under any circumstance.");
		const before = builder.plan();
		const result = new CachePlanner(config).beforeRequest(builder, 100);
		assert.deepEqual(result?.maskedRefs, ["shown_ordinary"]);
		const after = builder.plan();
		for (let i = 0; i < before.messages.length; i++) if (i !== 2) assert.deepEqual(after.messages[i], before.messages[i]);
		assert.equal(after.system, before.system);
		assert.equal(after.revision, 1);
	});

	test("metadata cannot be changed later to remove protection", () => {
		const builder = guarded();
		const meta: ToolResultMeta = { kind: "tool_output", ref: "shown_error", target: "failure", preserve: "error" };
		builder.appendAssistant({ role: "assistant", content: "", reasoning: "", toolCalls: [{ id: "error", name: "file_read", argumentsJson: "{}" }] });
		builder.appendToolResult("error", "file_read", text, meta);
		delete meta.preserve;
		assert.equal(new CachePlanner(config).beforeRequest(builder, 0), null);
		assert.equal(builder.plan().messages[1]!.content, text);
	});

	test("runtime invalidation appends once when called and survives later compression", () => {
		const builder = guarded();
		builder.appendUser("original user instruction");
		append(builder, "one");
		const before = builder.plan();
		builder.appendRuntimeNotice("Memory fact port=3000 is no longer valid; verify the current configuration.");
		const notice = builder.plan().messages.at(-1);
		assert.match(notice!.content, /^\[Runtime evidence notice, not a user instruction\]/);
		assert.deepEqual(builder.plan().prefixHashes.slice(0, before.prefixHashes.length), before.prefixHashes);
		new CachePlanner(config).beforeRequest(builder, 0);
		assert.deepEqual(builder.plan().messages.at(-1), notice);
		assert.deepEqual(builder.plan().messages[0], before.messages[0]);
	});

	test("a missing shown archive rolls back the whole batch", () => {
		const builder = guarded((ref) => ref !== "shown_two");
		append(builder, "one");
		append(builder, "two");
		rejectsWithoutMutation(builder, "CONTEXT_REFERENCE_UNAVAILABLE");
	});

	test("storage exceptions, damaged raw references, and wrong views reject before publication", () => {
		for (const verify of [
			() => { throw new Error("archive unavailable"); },
			(_ref: string, view: "shown" | "raw") => view === "shown",
			(ref: string, view: "shown" | "raw") => ref.startsWith(`${view}_`),
		]) {
			const builder = guarded(verify);
			append(builder, "one", { fullOutputRef: "shown_not_raw" });
			rejectsWithoutMutation(builder, "CONTEXT_REFERENCE_UNAVAILABLE");
		}
	});

	test("a valid archive belonging to different shown text cannot replace the current output", () => {
		const archive = new Map([["shown_old", text]]);
		const builder = guarded((ref, view, expected) => {
			const content = archive.get(ref);
			return view === "shown" && content !== undefined && createHash("sha256").update(content).digest("hex") === expected.sha256;
		});
		append(builder, "new", { ref: "shown_old" }, `a different captured fact\n${text}`);
		rejectsWithoutMutation(builder, "CONTEXT_REFERENCE_UNAVAILABLE");
	});

	test("raw checks the original capture call when recorded, not the later recovery call", () => {
		for (const sourceCallId of ["capture_call", "wrong_call"]) {
			const builder = guarded((_ref, view, expected) => view === "shown" || expected.toolCallId === "capture_call");
			append(builder, "later_recovery_call", { fullOutputRef: "raw_old", fullOutputSourceCallId: sourceCallId });
			if (sourceCallId === "wrong_call") rejectsWithoutMutation(builder, "CONTEXT_REFERENCE_UNAVAILABLE");
			else assert.equal(new CachePlanner(config).beforeRequest(builder, 0)?.maskedRefs.length, 1);
		}
	});

	test("shown and raw keep distinct fixed entries and are both checked", () => {
		const checked: [string, string][] = [];
		const builder = guarded((ref, view) => { checked.push([ref, view]); return true; });
		append(builder, "one", { fullOutputRef: "raw_original" });
		new CachePlanner(config).beforeRequest(builder, 0);
		const masked = builder.plan().messages[1]!.content;
		assert.match(masked, /ref=shown_one/);
		assert.match(masked, /raw_ref=raw_original/);
		assert.ok(checked.some(([ref, view]) => ref === "shown_one" && view === "shown"));
		assert.ok(checked.some(([ref, view]) => ref === "raw_original" && view === "raw"));
		builder.appendUser("Now recover the historical middle fact.");
		assert.equal(builder.plan().messages[1]!.content, masked);
	});

	test("archive deletion after a revision blocks the next request without another revision", () => {
		let available = true;
		const builder = guarded(() => available);
		append(builder, "one");
		new CachePlanner(config).beforeRequest(builder, 0);
		available = false;
		rejectsWithoutMutation(builder, "CONTEXT_REFERENCE_UNAVAILABLE", { ...config, enabled: false });
	});

	test("a named but unexposed recovery tool is not a usable entry", () => {
		const builder = new ContextBuilder({ system: "s", tools: [tools[0]!], expandTool: "context_expand", publicationGuard: { verifyReference: () => true } });
		append(builder, "one");
		rejectsWithoutMutation(builder, "CONTEXT_REFERENCE_UNAVAILABLE");
	});

	test("oversized candidate leaves original text and revision intact", () => {
		const builder = guarded();
		builder.appendUser("necessary user request ".repeat(400));
		append(builder, "one");
		append(builder, "two");
		rejectsWithoutMutation(builder, "CONTEXT_BUDGET_EXCEEDED", { ...config, hardLimitTokens: 100 }, 50);
	});

	test("protected-only context that cannot fit stops instead of publishing an oversized request", () => {
		const builder = guarded();
		builder.appendUser("request".repeat(1000));
		append(builder, "error", { preserve: "error" });
		rejectsWithoutMutation(builder, "CONTEXT_BUDGET_EXCEEDED", { ...config, enabled: false, hardLimitTokens: 100 });
	});

	test("reserved output is included in final publication size", () => {
		const builder = guarded();
		builder.appendUser("small request");
		const size = builder.plan().totalTokensEst;
		rejectsWithoutMutation(builder, "CONTEXT_BUDGET_EXCEEDED", { ...config, enabled: false, hardLimitTokens: size + 99 }, 100);
	});
});

describe("v4 tool groups cannot be broken by publication", () => {
	test("orphan, wrong name, duplicate result, missing result and duplicate call IDs each block publication", () => {
		const scenarios = [
			(b: ContextBuilder) => b.appendToolResult("orphan", "file_read", text, { kind: "file_content", ref: "shown_orphan", target: "orphan" }),
			(b: ContextBuilder) => { b.appendAssistant({ role: "assistant", content: "", reasoning: "", toolCalls: [{ id: "wrong", name: "command_run", argumentsJson: "{}" }] }); b.appendToolResult("wrong", "file_read", text, { kind: "file_content", ref: "shown_wrong", target: "wrong" }); },
			(b: ContextBuilder) => { append(b, "same"); b.appendToolResult("same", "file_read", text, { kind: "file_content", ref: "shown_dup", target: "duplicate" }); },
			(b: ContextBuilder) => { append(b, "first"); b.appendAssistant({ role: "assistant", content: "", reasoning: "", toolCalls: [{ id: "missing", name: "file_read", argumentsJson: "{}" }] }); },
			(b: ContextBuilder) => { append(b, "same"); append(b, "same"); },
		];
		for (const setup of scenarios) {
			const builder = guarded();
			setup(builder);
			rejectsWithoutMutation(builder, "CONTEXT_TOOL_PAIRING");
		}
	});

	test("parallel result order may differ, while every call and original argument string remains", () => {
		const builder = guarded();
		builder.appendAssistant({ role: "assistant", content: "", reasoning: "keep reasoning", toolCalls: ["a", "b"].map((id) => ({ id, name: "file_read", argumentsJson: '{ "path" : "f" }' })) });
		for (const id of ["b", "a"]) builder.appendToolResult(id, "file_read", text, { kind: "file_content", ref: `shown_${id}`, target: id });
		const assistant = builder.plan().messages[0];
		assert.equal(new CachePlanner(config).beforeRequest(builder, 0)?.maskedRefs.length, 2);
		assert.deepEqual(builder.plan().messages[0], assistant);
	});
});

describe("new price advice is optional and never applies a revision", () => {
	test("the advice uses explicit future assumptions and includes recovery and extra output cost", () => {
		const builder = guarded();
		for (let i = 0; i < 4; i++) append(builder, `${i}`);
		const before = builder.plan();
		const cfg: MaskingConfig = { ...config, enabled: false, hitMissRatio: 0.5, priceShadow: { expectedRemainingTurns: 20, recoveryInputTokens: 0, extraOutputTokens: 0, outputMissRatio: 5 } };
		const planner = new CachePlanner(cfg);
		const advice = planner.shadowAdvice(builder);
		assert.equal(advice?.mode, "shadow");
		assert.equal(advice?.wouldRevise, true);
		const a = advice!.assumptions;
		const reconstructed = advice!.savedTokensPerRequest * a.hitMissRatio * a.expectedRemainingTurns - (advice!.recomputedTokens * (1 - a.hitMissRatio) + a.recoveryInputTokens + a.extraOutputTokens * a.outputMissRatio) * a.safety;
		assert.equal(reconstructed, advice!.estimatedNetSaving);
		assert.equal(planner.beforeRequest(builder, 0), null);
		assert.deepEqual(builder.plan(), before);
		const expensive = new CachePlanner({ ...cfg, priceShadow: { ...cfg.priceShadow!, recoveryInputTokens: 1e9, extraOutputTokens: 1e9 } }).shadowAdvice(builder);
		assert.equal(expensive?.wouldRevise, false);
		assert.ok(expensive!.estimatedNetSaving < advice!.estimatedNetSaving);
		assert.deepEqual(builder.plan(), before);
	});

	test("absent or invalid future assumptions produce no fabricated advice", () => {
		const builder = guarded();
		append(builder, "one");
		assert.equal(new CachePlanner(config).shadowAdvice(builder), null);
		assert.equal(new CachePlanner({ ...config, hitMissRatio: 0.5, priceShadow: { expectedRemainingTurns: Number.NaN, recoveryInputTokens: 0, extraOutputTokens: 0, outputMissRatio: 5 } }).shadowAdvice(builder), null);
	});
});
