import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ToolDefinition } from "@mountains/tools";
import { AgentSession, BudgetGuard, ScriptedModelAdapter, type EngineOptions, type RecordedResponse } from "../src/index.ts";

type Call = { id: string; name: string; args: Record<string, unknown> };
function reply(calls: Call[] = []): RecordedResponse {
	return { ok: true, message: { role: "assistant", content: calls.length ? "" : "Done.", reasoning: "analysis",
		toolCalls: calls.map(call => ({ id: call.id, name: call.name, argumentsJson: JSON.stringify(call.args) })) },
		finishReason: calls.length ? "tool_calls" : "stop", responseModel: "deepseek-flash",
		rawUsage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, completion_tokens: 12, total_tokens: 132 },
		httpStatus: 200, error: null, aborted: false };
}
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "engine-skills-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "work"); mkdirSync(workspace);
	const skills = join(root, "skills");
	const write = (folder: string, frontmatter: string, body: string) => {
		mkdirSync(join(skills, folder), { recursive: true });
		writeFileSync(join(skills, folder, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
	};
	let n = 0;
	const options = (adapter: ScriptedModelAdapter, extra: Partial<EngineOptions> = {}): EngineOptions => ({
		workspace, dataDir: join(root, `data-${++n}`), sessionId: `ses_skills_${n}`, adapter, model: "deepseek-flash",
		thinking: { enabled: true, effort: "high" }, maxTokens: 4000, checkpoints: false,
		budget: new BudgetGuard({ globalLimit: 100, ledgerPath: join(root, "spend.jsonl") }),
		limits: { maxTurns: 10, maxRequests: 10, maxCost: 10 }, retry: { maxAttempts: 1, baseDelayMs: 0 }, ...extra,
	});
	return { root, workspace, skills, write, options };
}

test("without skills nothing changes; with skills the skill tool comes last and carries the catalog", async t => {
	const f = fixture(t);
	const plain = new ScriptedModelAdapter([reply()]);
	await new AgentSession(f.options(plain, { skills: { roots: [{ dir: f.skills, source: "user" }] } })).run("Hello");
	const before = new ScriptedModelAdapter([reply()]);
	await new AgentSession(f.options(before)).run("Hello");
	assert.deepEqual(plain.requests[0]!.tools, before.requests[0]!.tools, "an empty skills directory adds nothing");
	assert.ok(!plain.requests[0]!.tools.some(tool => tool.name === "skill"));

	f.write("changelog", "name: changelog\ndescription: Write a changelog entry in the project's format.", "Use Keep a Changelog headings.");
	const withSkill = new ScriptedModelAdapter([reply()]);
	await new AgentSession(f.options(withSkill, { skills: { roots: [{ dir: f.skills, source: "user" }] } })).run("Hello");
	const tools = withSkill.requests[0]!.tools;
	assert.equal(tools.at(-1)!.name, "skill");
	assert.match(tools.at(-1)!.description, /<name>changelog<\/name>/);
	assert.deepEqual(tools.slice(0, -1), before.requests[0]!.tools, "the other tools stay byte-identical");
	assert.equal(withSkill.requests[0]!.system, before.requests[0]!.system, "the system prompt does not change");
});

test("a skill the model loads reaches the next request in full", async t => {
	const f = fixture(t);
	f.write("changelog", "name: changelog\ndescription: Write a changelog entry.", "Use Keep a Changelog headings.");
	const adapter = new ScriptedModelAdapter([reply([{ id: "s1", name: "skill", args: { name: "changelog" } }]), reply()]);
	const summary = await new AgentSession(f.options(adapter, { skills: { roots: [{ dir: f.skills, source: "user" }] } })).run("Add a changelog entry.");
	assert.equal(summary.status, "completed", summary.reason);
	const result = adapter.requests[1]!.messages.find(m => m.role === "tool" && m.toolCallId === "s1");
	assert.match(result?.content ?? "", /^<skill_content name="changelog">[\s\S]*Use Keep a Changelog headings\.\n<\/skill_content>$/);
});

test("/name puts the skill in just before the user's message, which stays as typed; snapshots still export", async t => {
	const f = fixture(t);
	f.write("changelog", "name: changelog\ndescription: Write a changelog entry.", "Use Keep a Changelog headings.");
	const adapter = new ScriptedModelAdapter([reply()]);
	const archiveDir = join(f.root, "archive");
	const session = new AgentSession(f.options(adapter, { allowSessionSnapshots: true, archiveDir, skills: { roots: [{ dir: f.skills, source: "user" }] } }));
	await session.run("/changelog for the 2.1 release");
	const users = adapter.requests[0]!.messages.filter(m => m.role === "user").map(m => m.content);
	assert.match(users[0]!, /^\[Skill loaded at the user's request, not a new user instruction\]\n<skill_content name="changelog">/);
	assert.equal(users[1], "/changelog for the 2.1 release");
	const snapshot = session.exportSnapshot();
	assert.deepEqual(snapshot.userRequests.map(r => r.text), ["/changelog for the 2.1 release"]);
	const resumed = new AgentSession(f.options(new ScriptedModelAdapter([]), { allowSessionSnapshots: true, archiveDir, sessionId: session.sessionId, skills: { roots: [{ dir: f.skills, source: "user" }] } }));
	resumed.restoreSnapshot(JSON.parse(JSON.stringify(snapshot)));
});

test("an @name skill keeps access to its bundled files after restoring a conversation", async t => {
	const f = fixture(t);
	f.write("changelog", "name: changelog\ndescription: Write a changelog entry.\ndisable-model-invocation: true", "Read checklist.txt.");
	writeFileSync(join(f.skills, "changelog", "checklist.txt"), "Keep the release date.");
	const archiveDir = join(f.root, "archive");
	const options = { allowSessionSnapshots: true, archiveDir, skills: { roots: [{ dir: f.skills, source: "user" as const }] } };
	const first = new AgentSession(f.options(new ScriptedModelAdapter([reply()]), options));
	await first.run("请用 @changelog 写更新说明");
	const adapter = new ScriptedModelAdapter([reply([{ id: "read", name: "skill", args: { name: "changelog", file: "checklist.txt" } }]), reply()]);
	const resumed = new AgentSession(f.options(adapter, { ...options, sessionId: first.sessionId }));
	resumed.restoreSnapshot(JSON.parse(JSON.stringify(first.exportSnapshot())));
	assert.equal((await resumed.run("再读一下清单")).status, "completed");
	assert.match(adapter.requests[1]!.messages.find(m => m.role === "tool" && m.toolCallId === "read")?.content ?? "", /Keep the release date/);
});

test("@name shows the skill wherever it sits, including one installed after the session began", async t => {
	const f = fixture(t);
	f.write("changelog", "name: changelog\ndescription: Write a changelog entry.", "Use Keep a Changelog headings.");
	const adapter = new ScriptedModelAdapter([reply(), reply()]);
	const session = new AgentSession(f.options(adapter, { skills: { roots: [{ dir: f.skills, source: "user" }] } }));
	await session.run("请按 @changelog 写");
	const first = adapter.requests[0]!.messages.filter(message => message.role === "user").map(message => message.content);
	assert.match(first[0]!, /<skill_content name="changelog">/);
	assert.equal(first[1], "请按 @changelog 写");
	f.write("notes", "name: notes\ndescription: Keep notes.", "Write short notes.");
	await session.run("再看 @notes");
	const second = adapter.requests[1]!.messages.filter(message => message.role === "user").map(message => message.content);
	assert.match(second.at(-2)!, /<skill_content name="notes">/);
	assert.equal(second.at(-1), "再看 @notes");
	assert.equal(adapter.requests[0]!.tools.length, adapter.requests[1]!.tools.length);
});

test("a built-in skill that brings tools appears only when turned on, and its tools are there from the start", async t => {
	const f = fixture(t);
	const screenRead: ToolDefinition = { name: "screen_read", logicalName: "screen.read", description: "Read a window.", parameters: { type: "object" }, readOnly: true,
		execute: async () => ({ ok: true, modelContent: "window", summary: "read", details: {} }) };
	const builtin = [{ name: "computer-use", description: "Operate desktop apps.", body: "Read the window first.", tools: [screenRead] }];
	const off = new ScriptedModelAdapter([reply()]);
	await new AgentSession(f.options(off, { skills: { builtin } })).run("Hello");
	assert.ok(!off.requests[0]!.tools.some(tool => tool.name === "screen_read" || tool.name === "skill"));
	const on = new ScriptedModelAdapter([reply()]);
	await new AgentSession(f.options(on, { skills: { builtin, enable: ["computer-use"] } })).run("Hello");
	assert.deepEqual(on.requests[0]!.tools.slice(-2).map(tool => tool.name), ["screen_read", "skill"]);
	assert.match(on.requests[0]!.tools.at(-1)!.description, /<name>computer-use<\/name>/);
	const clash = [{ ...builtin[0]!, tools: [{ ...screenRead, name: "file_read" }] }];
	assert.throws(() => new AgentSession(f.options(new ScriptedModelAdapter([]), { skills: { builtin: clash, enable: ["computer-use"] } })), /工具名重复/);
});

test("with the default approval rules nobody is asked, so a project skill that asks is not loaded", async t => {
	const f = fixture(t);
	f.write("release", "name: release\ndescription: Cut a release.", "Run scripts/release.sh.");
	const adapter = new ScriptedModelAdapter([reply([{ id: "s1", name: "skill", args: { name: "release" } }]), reply()]);
	await new AgentSession(f.options(adapter, { skills: { roots: [{ dir: f.skills, source: "project" }] } })).run("Release it.");
	const result = adapter.requests[1]!.messages.find(m => m.role === "tool" && m.toolCallId === "s1")?.content ?? "";
	assert.match(result, /not approved/);
	assert.doesNotMatch(result, /release\.sh/);
	const allowed = new ScriptedModelAdapter([reply([{ id: "s1", name: "skill", args: { name: "release" } }]), reply()]);
	await new AgentSession(f.options(allowed, { skills: { roots: [{ dir: f.skills, source: "project" }], permissions: { release: "allow" } } })).run("Release it.");
	assert.match(allowed.requests[1]!.messages.find(m => m.role === "tool" && m.toolCallId === "s1")?.content ?? "", /release\.sh/);
});

test("an image from a skill tool reaches the next request; the recording keeps only its size and hash", async t => {
	const f = fixture(t);
	const data = Buffer.from("fake png bytes").toString("base64");
	const look: ToolDefinition = { name: "screen_look", logicalName: "screen.look", description: "Look.", parameters: { type: "object" }, readOnly: true,
		execute: async () => ({ ok: true, modelContent: "[Image of Notes]", summary: "look", details: {}, images: [{ mimeType: "image/png", data, width: 640, height: 400 }] }) };
	const builtin = [{ name: "computer-use", description: "Operate desktop apps.", body: "Look first.", tools: [look] }];
	const adapter = new ScriptedModelAdapter([reply([{ id: "l1", name: "screen_look", args: {} }]), reply()]);
	const session = new AgentSession(f.options(adapter, { skills: { builtin, enable: ["computer-use"] } }));
	assert.equal((await session.run("Look at Notes.")).status, "completed");
	const tool = adapter.requests[1]!.messages.find(m => m.role === "tool" && m.toolCallId === "l1");
	assert.ok(tool?.role === "tool");
	assert.deepEqual(tool.images, [{ mimeType: "image/png", data, width: 640, height: 400 }]);
	const recording = readFileSync(join(session.options.dataDir, "recording.jsonl"), "utf8");
	assert.ok(!recording.includes(data), "no image bytes in the recording");
	assert.match(recording, /"images":\[\{"mimeType":"image\/png","width":640,"height":400,"sha256":"[0-9a-f]{64}"\}\]/);
});


test("enabled persistent built-in instructions survive compaction and are absent when disabled",async t=>{
 const f=fixture(t),body="Passwords may be entered only after destination consent. PERSISTENT-COMPUTER-END";
 const builtin=[{name:"computer-use",description:"Own UI",body,persistentInstructions:true,tools:[]}];
 const adapter=new ScriptedModelAdapter([reply(),reply(),reply()]);
 const session=new AgentSession(f.options(adapter,{skills:{builtin,enable:["computer-use"]}}));
 await session.run("First");
 await session.run("Second");
 session.builder.applyCompaction("Compacted history",2,4000,1000000,false);
 await session.run("Third");
 for(const request of adapter.requests)assert.ok(request.system.includes(body));
});

for(const trusted of [true,false])test(`handoff control stops later tools and model calls only for trusted host tools (${trusted})`,async t=>{
 const f=fixture(t),sent:string[]=[];
 const handoff:ToolDefinition={name:"web_handoff",logicalName:"web.handoff",description:"Give original page to user",parameters:{type:"object"},readOnly:false,canHandoff:trusted,
  execute:async()=>({ok:true,modelContent:"Original tab retained",summary:"handed off",details:{},control:{kind:"handoff",message:"请在保留的页面完成登录后回复。"}})};
 const click:ToolDefinition={name:"after_click",logicalName:"after.click",description:"must stop",parameters:{type:"object"},readOnly:false,execute:async()=>{sent.push("clicked");return{ok:true,modelContent:"clicked",summary:"clicked",details:{}};}};
 const builtin=[{name:"own-browser",description:"Own",body:"",tools:[handoff,click]}];
 const adapter=new ScriptedModelAdapter([reply([{id:"h1",name:"web_handoff",args:{}},{id:"bad-followup",name:"after_click",args:{}}]),reply()]);
 const session=new AgentSession(f.options(adapter,{skills:{builtin,enable:["own-browser"]}}));
 const done=await session.run("Ask me to finish login");assert.equal(done.status,"completed");
 assert.deepEqual(sent,trusted?[]:["clicked"]);assert.equal(adapter.requests.length,trusted?1:2);
 if(trusted){assert.match(done.finalText,/完成登录/);const resumed=await session.run("已完成，请继续");assert.equal(resumed.status,"completed");assert.equal(adapter.requests.length,2);}
});
