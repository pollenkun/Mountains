import assert from "node:assert/strict";
import { test } from "node:test";
import { FileStateTracker, Workspace, type ToolContext, type ToolDefinition } from "@mountains/tools";
import { createComputerTools, domainMatches, redactSecrets, resolveSecrets, scopeAllows, type Desktop, type SecretStore, type UiApp, type UiElement } from "../src/index.ts";

const store = (values: Record<string, string>, scopes: { name: string; domains?: string[]; apps?: string[] }[]): SecretStore => ({
	list: async () => scopes.map(s => ({ name: s.name, domains: s.domains ?? [], apps: s.apps ?? [] })),
	value: async name => { if (!(name in values)) throw new Error("missing"); return values[name]!; },
});

test("a domain covers itself and its subdomains, never a lookalike", () => {
	assert.equal(domainMatches("github.com", "github.com"), true);
	assert.equal(domainMatches("gist.github.com", "github.com"), true);
	assert.equal(domainMatches("github.com.evil.io", "github.com"), false);
	assert.equal(domainMatches("evilgithub.com", "github.com"), false);
	assert.equal(domainMatches("github.com", "*.github.com"), false);
	assert.equal(domainMatches("api.github.com", "https://*.github.com/"), true);
});

test("a secret goes only to https pages of its sites, or to its own apps", () => {
	const scope = { name: "gh", domains: ["github.com"], apps: ["com.apple.Notes"] };
	assert.equal(scopeAllows(scope, { url: "https://github.com/login" }), true);
	assert.equal(scopeAllows(scope, { url: "http://github.com/login" }), false, "plain http can be read on the way");
	assert.equal(scopeAllows(scope, { url: "https://example.com" }), false);
	assert.equal(scopeAllows({ ...scope, domains: ["localhost"] }, { url: "http://localhost:3000" }), true);
	assert.equal(scopeAllows(scope, { app: { name: "Notes", bundleId: "com.apple.Notes" } }), true);
	assert.equal(scopeAllows(scope, { app: { name: "TextEdit", bundleId: "com.apple.TextEdit" } }), false);
});

test("placeholders are filled only where allowed, and values are scrubbed from everything shown afterwards", async () => {
	const s = store({ gh: "hunter2" }, [{ name: "gh", domains: ["github.com"] }]);
	const resolved = await resolveSecrets("user me / <secret>gh</secret>", s, { url: "https://github.com" });
	assert.equal(resolved.text, "user me / hunter2");
	await assert.rejects(resolveSecrets("<secret>gh</secret>", s, { url: "https://example.com" }), /not allowed on example\.com; no text was sent/);
	await assert.rejects(resolveSecrets("<secret>nope</secret>", s, { url: "https://github.com" }), /no saved secret named "nope"/);
	await assert.rejects(resolveSecrets("<secret>gh</secret>", undefined, { url: "https://github.com" }), /no secret store/);
	assert.deepEqual(redactSecrets({ text: "value hunter2", nested: ["hunter2!", { k: "x hunter2" }], n: 3 }, resolved.values),
		{ text: "value <secret>gh</secret>", nested: ["<secret>gh</secret>!", { k: "x <secret>gh</secret>" }], n: 3 });
});

function field(log: string[]): UiElement & { value: string } {
	const self = {
		role: "text_field", name: "Password", value: "", description: null, stableId: null, actions: ["set_value"], bounds: { x: 110, y: 120, width: 200, height: 24 },
		visible: true, enabled: true, focused: true, selected: false, checked: null, expanded: null, editable: true, raw: {},
		children: async () => [], press: async () => {}, focus: async () => {}, toggle: async () => {}, expand: async () => {}, collapse: async () => {}, select: async () => {},
		increment: async () => {}, decrement: async () => {}, scrollIntoView: async () => {}, showMenu: async () => {}, performAction: async () => {}, selectText: async () => {},
		setValue: async (v: string) => { log.push(`set ${v}`); self.value = v; }, typeText: async () => {},
	};
	return self as UiElement & { value: string };
}
function setup(bundleId: string) {
	const log: string[] = [], input = field(log);
	const window = { ...field(log), role: "window", name: "Login", bounds: { x: 100, y: 100, width: 400, height: 300 }, children: async () => [input] } as UiElement;
	const app: UiApp = { name: "Notes", bundleId, pid: 4242, isForeground: false, windows: async () => [window] };
	const desktop = { apps: async () => [app], captureWindow: async () => { throw new Error("none"); }, pointer: async () => {}, key: async () => {}, showCursor: async () => {}, ownPids: () => [],
		prepare: async () => {}, clipboardSet: async () => {}, clipboardRestore: async () => {}, installedApps: async () => [], launch: async () => {}, menus: async () => [], pressMenu: async () => {} } as Desktop;
	const tools = Object.fromEntries(createComputerTools({ desktop: async () => desktop, settleMs: 0, settleMaxMs: 0, apps: { Notes: "act" }, cursor: false, secrets: store({ notes: "s3cret!" }, [{ name: "notes", apps: ["com.apple.Notes"] }]) }).map(t => [t.name, t])) as Record<string, ToolDefinition>;
	return { log, tools };
}
const ctx = (): ToolContext => ({ workspace: new Workspace(process.cwd()), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c", approve: async () => "allow" });

test("a native field takes a saved secret in its own app; the model is told the name and never sees the value", async () => {
	const { log, tools } = setup("com.apple.Notes");
	const read = await tools.screen_read!.execute({ app: "Notes" }, ctx());
	assert.match(read.modelContent, /Saved secrets usable here[^\n]*<secret>notes<\/secret>/);
	const id = read.modelContent.match(/(e\d+) text_field/)![1];
	const done = await tools.screen_act!.execute({ app: "Notes", action: "set_value", id, text: "<secret>notes</secret>" }, ctx());
	assert.deepEqual(log, ["set s3cret!"]);
	assert.doesNotMatch(JSON.stringify(done), /s3cret!/, "the value never reaches the model or the recording");
});

test("another app is refused before any input", async () => {
	const { log, tools } = setup("com.apple.TextEdit");
	const read = await tools.screen_read!.execute({ app: "Notes" }, ctx());
	assert.doesNotMatch(read.modelContent, /Saved secrets/);
	const id = read.modelContent.match(/(e\d+) text_field/)![1];
	const done = await tools.screen_act!.execute({ app: "Notes", action: "set_value", id, text: "<secret>notes</secret>" }, ctx());
	assert.equal(done.ok, false); assert.match(done.modelContent, /not allowed in Notes; no text was sent/);
	assert.deepEqual(log, []);
	const pressed = await tools.screen_act!.execute({ app: "Notes", action: "select", id, text: "<secret>notes</secret>" }, ctx());
	assert.match(pressed.modelContent, /can only be typed or set/);
});

test("a used secret is scrubbed from every later result, and a too-short one is refused", async () => {
	const { UsedSecrets, computerUseSkill } = await import("../src/index.ts");
	const used = new UsedSecrets();
	await resolveSecrets("<secret>gh</secret>", store({ gh: "hunter2" }, [{ name: "gh", domains: ["github.com"] }]), { url: "https://github.com" }, used);
	assert.equal(used.values.get("gh"), "hunter2");
	await assert.rejects(resolveSecrets("<secret>pin</secret>", store({ pin: "12" }, [{ name: "pin", domains: ["github.com"] }]), { url: "https://github.com" }), /shorter than 4 characters/);
	// A later read whose content echoes the value (a page title, a log line) goes through the skill's scrub.
	const window = { role: "window", name: "Signed in with hunter2", value: null, description: null, stableId: null, actions: [], bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true, enabled: true, focused: false, selected: false, checked: null, expanded: null, editable: false, raw: {}, children: async () => [] } as unknown as UiElement;
	const app: UiApp = { name: "Notes", pid: 5, isForeground: false, windows: async () => [window] };
	const d = { apps: async () => [app], captureWindow: async () => { throw new Error("none"); }, pointer: async () => {}, key: async () => {}, showCursor: async () => {}, ownPids: () => [], prepare: async () => {},
		clipboardSet: async () => {}, clipboardRestore: async () => {}, installedApps: async () => [], launch: async () => {}, menus: async () => [], pressMenu: async () => {} } as Desktop;
	const skill = computerUseSkill({ desktop: async () => d, apps: { Notes: "act" }, usedSecrets: used, cursor: false, web: { connect: async () => { throw new Error("no browser"); } } });
	try {
		const read = await skill.tools!.find(t => t.name === "screen_read")!.execute({ app: "Notes" }, ctx());
		assert.match(read.modelContent, /Signed in with <secret>gh<\/secret>/);
		assert.doesNotMatch(JSON.stringify(read), /hunter2/);
	} finally { await skill.dispose?.(); }
});
