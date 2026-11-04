import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateTracker, Workspace, type ApprovalRequest, type ToolContext, type ToolDefinition } from "@mountains/tools";
import { browserProcess } from "../src/browser-process.ts";
import {axFixtureNodes,axFixtureReply} from './fixtures/ax-protocol.ts';
import { encodePng } from "../src/image.ts";
	import { browserProfileDir, chromeArguments, chromeLaunchCommand, createWebTools, launcherExitMeansQuit, parseDevToolsActivePort, textLanded, WebBrowser, type CdpEvent, type CdpLike, type WebToolOptions } from "../src/web.ts";

const PNG = encodePng(1, 1, Buffer.from([8, 16, 32, 255])).toString("base64");

class FakeCdp implements CdpLike {
	sent: { method: string; params?: Record<string, unknown> }[] = [];
	private readonly listeners = new Set<(event: CdpEvent) => void>();
	private readonly targets:{targetId:string;type:string;title:string;url:string}[] = [];
	private readonly values = new Map<number, string>([[10, ""]]);
	private focused = 10;
	hold = false;
 passwordSelection:[number,number]|null=null;
 seedPassword(value:string){this.values.set(11,value);}
	seed(value: string): void { this.values.set(10, value); }
	async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
		this.sent.push({ method, ...(params ? { params } : {}) });
		if (method === "Target.getTargets") return { targetInfos: this.targets };
		if (method === "Target.createTarget") {
			const targetId = `page-${this.targets.length + 1}`;
			this.targets.push({ targetId, type: "page", title: "New Tab", url: "about:blank" });
			return { targetId };
		}
		if (method === "Target.attachToTarget") return { sessionId: `s-${String(params?.targetId)}` };
		if (method === "Page.createIsolatedWorld") return { executionContextId: 37 };
		if(method==='Page.getFrameTree')return{frameTree:{frame:{id:sessionId?.startsWith('s-')?'f1':'frame-'+sessionId,url:'http://localhost/own',...(sessionId?.startsWith('s-')?{}:{parentId:'f1'})}}};
		if(method==='DOM.describeNode')return{node:{backendNodeId:params?.nodeId??Number(String(params?.objectId??'').replace('obj-',''))}};
		if(method==='DOM.performSearch')return{searchId:'password-fields',resultCount:2};
		if(method==='DOM.getSearchResults')return{nodeIds:[11,13]};
		if (method === "Page.navigate") {
			const target = this.targets.find(item => sessionId === `s-${item.targetId}`) ?? this.targets[0]!;
			target.url = String(params?.url); target.title = "Example";
			this.emit("Page.loadEventFired", {}, sessionId);
			this.emit("Page.lifecycleEvent", { name: "networkIdle" }, sessionId);
			return { frameId: "f1" };
		}
		if (method === "Accessibility.getFullAXTree") return { nodes: axFixtureNodes(this.tree(),sessionId?.startsWith('s-')?'f1':'frame-'+sessionId) };
		if(['Accessibility.getRootAXNode','Accessibility.getChildAXNodes','Accessibility.getAXNodeAndAncestors'].includes(method)){
			// Reuse each test's mutable tree provider, including overrides; this
			// internal fixture lookup is not a product CDP network request.
			const tree=await this.send('Accessibility.getFullAXTree',{},sessionId) as {nodes:import('../src/web-ax.ts').AxNode[]};return axFixtureReply(tree.nodes,method,params,sessionId?.startsWith('s-')?'f1':'frame-'+sessionId);
		}
		if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
		if (method === "DOM.resolveNode") return { object: { objectId: `obj-${String(params?.backendNodeId)}` } };
		if (method === "DOM.focus") { this.focused = Number(params?.backendNodeId); return {}; }
		if (method === "Input.insertText") {
			if (!this.hold){const before=this.values.get(this.focused)??'',text=String(params?.text),selection=this.focused===11?this.passwordSelection:null;this.values.set(this.focused,selection?before.slice(0,selection[0])+text+before.slice(selection[1]):before+text);if(this.focused===11)this.passwordSelection=null;}
			return {};
		}
		if(method === "Runtime.evaluate" && String(params?.expression).includes("mountainsSettle"))return {result:{value:true}};
		if (method === "Runtime.evaluate" && params?.expression === "document.activeElement") return { result: { objectId: `obj-${this.focused}` } };
		if (method === "Runtime.callFunctionOn") {
			const source = String(params?.functionDeclaration);
			if(source.includes('mountainsPasswordSegment')){const args=params?.arguments as {value:unknown}[],value=this.values.get(Number(String(params?.objectId).replace('obj-','')))??'';return{result:{value:value.length===args[2]!.value&&value.slice(Number(args[0]!.value),Number(args[0]!.value)+String(args[1]!.value).length)===args[1]!.value}};}
			if (source.includes("HTMLSelectElement")) return { result: { value: { ok: true, value: "Blue" } } };
			const backend = Number(String(params?.objectId).replace("obj-", ""));
			if (source.includes('keyboardReceiver')) return { result: { value: { password: backend === 11 || backend === 13, payment: backend === 13, focused: backend === this.focused, length:(this.values.get(backend)??'').length,selectionStart:backend===11&&this.passwordSelection?this.passwordSelection[0]:(this.values.get(backend)??'').length,selectionEnd:backend===11&&this.passwordSelection?this.passwordSelection[1]:(this.values.get(backend)??'').length, value:backend===11||backend===13?null:this.values.get(backend)??'' } } };
			return { result: { value: { password: backend === 11 || backend === 13, payment: backend === 13, value: backend === 11 || backend === 13 ? null : this.values.get(backend) ?? "" } } };
		}
		if (method === "Page.captureScreenshot") return { data: PNG };
		return {};
	}
	on(listener: (event: CdpEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	async close(): Promise<void> {}
	private emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
		const event: CdpEvent = { method, params, ...(sessionId ? { sessionId } : {}) };
		for (const listener of this.listeners) listener(event);
	}
	private tree() {
		const email = this.values.get(10) ?? "";
		return [
			{ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3", "4", "5"] },
			{ nodeId: "2", role: { value: "textbox" }, name: { value: "Email" }, ...(email ? { value: { value: email } } : {}), backendDOMNodeId: 10, childIds: [] },
			{ nodeId: "3", role: { value: "textbox" }, name: { value: "Password" }, backendDOMNodeId: 11, childIds: [] },
			{ nodeId: "4", role: { value: "textbox" }, name: { value: "Secret" }, backendDOMNodeId: 13, childIds: [] },
			{ nodeId: "5", role: { value: "button" }, name: { value: "Send" }, backendDOMNodeId: 12, childIds: [] },
		];
	}
}

function ctx(answer: "allow" | "deny" = "allow"): ToolContext & { asked: ApprovalRequest[] } {
	const asked: ApprovalRequest[] = [];
	return { workspace: new Workspace(process.cwd()), files: new FileStateTracker(), signal: new AbortController().signal, toolCallId: "c1", asked, approve: async request => { asked.push(request); return answer; } };
}
function tools(fake: CdpLike, extra: WebToolOptions = {}): Record<string, ToolDefinition> {
	return Object.fromEntries(createWebTools({ connect: async () => fake, consent: { granted: true }, imageInput: true, ...extra }).map(tool => [tool.name, tool]));
}

test("concurrent browser clients cannot insert into each other's focused field",async()=>{
	let focused=10,release!:()=>void,entered!:()=>void;
	const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
	const values=new Map([[10,''],[20,'']]),log:string[]=[];
	const target={targetId:'race-page',type:'page',title:'Own fixture',url:'http://localhost/own'};
	const fake:CdpLike={on:()=>()=>{},close:async()=>{},async send(method,p={}){
		if(method==='Target.getTargets')return {targetInfos:[target]};
		if(method==='Target.attachToTarget')return {sessionId:'s1'};
		if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'race-frame',url:target.url}}};
		if(method==='DOM.performSearch')return{searchId:'no-password-fields',resultCount:0};
		if(method==='Runtime.evaluate'&&p.expression==='document.activeElement')return{result:{objectId:'o'+focused}};
		if(method==='DOM.describeNode')return{node:{backendNodeId:Number(String(p.objectId).slice(1))}};
		if(method==='Accessibility.getFullAXTree')return {nodes:axFixtureNodes([{nodeId:'root',role:{value:'RootWebArea'},childIds:['a','b']},...[10,20].map((id,i)=>({nodeId:i?'b':'a',role:{value:'textbox'},name:{value:i?'Field B':'Field A'},value:{value:values.get(id)},backendDOMNodeId:id}))],'race-frame')};
		if(['Accessibility.getRootAXNode','Accessibility.getChildAXNodes','Accessibility.getAXNodeAndAncestors'].includes(method))return axFixtureReply([{nodeId:'root',role:{value:'RootWebArea'},childIds:['a','b']},...[10,20].map((id,i)=>({nodeId:i?'b':'a',role:{value:'textbox'},name:{value:i?'Field B':'Field A'},value:{value:values.get(id)},backendDOMNodeId:id}))],method,p,'race-frame');
		if(method==='DOM.resolveNode')return {object:{objectId:'o'+p.backendNodeId}};
		if(method==='Runtime.callFunctionOn')return {result:{value:{password:false,payment:false,focused:true,length:0,value:values.get(Number(String(p.objectId).slice(1)))}}};
		if(method==='DOM.focus'){focused=Number(p.backendNodeId);log.push('focus '+focused);if(focused===10){entered();await gate;}return {};}
		if(method==='Input.insertText'){log.push('insert '+focused);values.set(focused,(values.get(focused)??'')+String(p.text));}
		return {};
	}};
	const a=new WebBrowser({connect:async()=>fake}),b=new WebBrowser({connect:async()=>fake}),signal=new AbortController().signal;
	try{
		const one=await a.open({tab:'t1'},signal),two=await b.open({tab:'t1'},signal);
		const id=(shot:typeof one,name:string)=>[...shot.elements.values()].find(e=>e.name===name)!.id;
		const first=a.perform(one,{action:'type',id:id(one,'Field A'),text:'A'},signal);
		await ready;
		const second=b.perform(two,{action:'type',id:id(two,'Field B'),text:'B'},signal);
		const refused=assert.rejects(second,/another action changed/);
		await new Promise<void>(r=>setImmediate(r));assert.deepEqual(log,['focus 10']);
		release();await first;await refused;
		assert.equal(values.get(10),'A');assert.equal(values.get(20),'');
		const fresh=await b.open({},signal);await b.perform(fresh,{action:'type',id:id(fresh,'Field B'),text:'B'},signal);
		assert.equal(values.get(10),'A');assert.equal(values.get(20),'B');
	}finally{release();await a.close();await b.close();}
});

test("cancellation during connection cannot create a new tab",async()=>{
	const controller=new AbortController(),fake=new FakeCdp();
	const browser=new WebBrowser({connect:async()=>{controller.abort(new Error('cancel during connection'));return fake;}});
	await assert.rejects(browser.open({newTab:true},controller.signal),/cancel during connection/);
	assert.deepEqual(fake.sent,[]);await browser.close();
});

test("closing during connection cannot revive the browser or create a tab",async()=>{
	const fake=new FakeCdp();let release!:(cdp:CdpLike)=>void,entered!:()=>void;
	const delayed=new Promise<CdpLike>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
	const browser=new WebBrowser({connect:async()=>{entered();return delayed;}});
	const opening=browser.open({newTab:true},new AbortController().signal),refused=assert.rejects(opening,/browser was closed/);
	await started;await browser.close();release(fake);await refused;
	assert.deepEqual(fake.sent,[]);
	await assert.rejects(browser.tabs(),/browser was closed/);
});
const idOf = (content: string, role: string, name: string): string => {
	const match = content.match(new RegExp(`(e\\d+) ${role} "${name}"`));
	assert.ok(match, content);
	return match[1]!;
};

for (const { name, pixelsPerCss, visualScale } of [
	{ name: "normal density", pixelsPerCss: 1, visualScale: 1 },
	{ name: "Retina density", pixelsPerCss: 2, visualScale: 1 },
	{ name: "visual viewport zoom", pixelsPerCss: 1, visualScale: 2 },
]) test(`canvas image coordinates include the scrollbar at ${name}`, async () => {
	const fake = new FakeCdp(), send = fake.send.bind(fake);
	// The old-system diagnostic captured a 756px image with a 741px content area.
	const width = 756 * pixelsPerCss, height = 413 * pixelsPerCss;
	const image = encodePng(width, height, Buffer.alloc(width * height * 4)).toString("base64");
	fake.send = async (method, params, session) => {
		if (method === "Page.captureScreenshot") return { data: image };
		if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 741 / visualScale, clientHeight: 413 / visualScale, scale: visualScale } };
		if (method === "Runtime.evaluate" && params?.expression === "innerWidth") return { result: { value: 756 } };
		return send(method, params, session);
	};
	const browser = new WebBrowser({ connect: async () => fake }), signal = new AbortController().signal;
	try {
		const shot = await browser.open({ url: "http://localhost/canvas" }, signal);
		await browser.screenshot(shot);
		const done = await browser.perform(shot, { action: "click", x: 104 * pixelsPerCss * visualScale, y: 206 * pixelsPerCss * visualScale }, signal);
		assert.deepEqual(fake.sent.filter(call => call.method === "Input.dispatchMouseEvent").map(call => [call.params?.type, call.params?.x, call.params?.y]), [
			["mousePressed", 104, 206], ["mouseReleased", 104, 206],
		]);
		await browser.screenshot(done.shot);
		await assert.rejects(browser.perform(done.shot, { action: "click", x: 750 * pixelsPerCss, y: 20 }, signal), /outside the page's visible area/);
		assert.equal(fake.sent.filter(call => call.method === "Input.dispatchMouseEvent").length, 2, "scrollbar coordinates must not send input");
	} finally { await browser.close(); }
});

test("a new canvas image without a viewport width cannot reuse an older coordinate scale", async () => {
	const fake = new FakeCdp(), send = fake.send.bind(fake);
	let widthAvailable = true;
	fake.send = async (method, params, session) => {
		if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1, clientHeight: 1, scale: 1 } };
		if (method === "Runtime.evaluate" && params?.expression === "innerWidth") {
			if (!widthAvailable) throw new Error("viewport unavailable");
			return { result: { value: 1 } };
		}
		return send(method, params, session);
	};
	const browser = new WebBrowser({ connect: async () => fake }), signal = new AbortController().signal;
	try {
		const shot = await browser.open({ url: "http://localhost/canvas" }, signal);
		await browser.screenshot(shot);
		widthAvailable = false;
		await browser.screenshot(shot);
		await assert.rejects(browser.perform(shot, { action: "click", x: 0, y: 0 }, signal), /look at this page first/);
		assert.equal(fake.sent.some(call => call.method.startsWith("Input.")), false);
	} finally { await browser.close(); }
});

for (const missingScale of ["request failure", undefined, null, 0, -1, NaN]) test(`canvas clicks fail closed when screenshot viewport scale is ${String(missingScale)}`, async () => {
	const fake = new FakeCdp(), send = fake.send.bind(fake);
	let measureScreenshot = false;
	fake.send = async (method, params, session) => {
		if (method === "Page.captureScreenshot") return { data: encodePng(756, 413, Buffer.alloc(756 * 413 * 4)).toString("base64") };
		if (method === "Page.getLayoutMetrics") {
			if (measureScreenshot && missingScale === "request failure") throw new Error("metrics temporarily unavailable");
			return { cssVisualViewport: { clientWidth: 370.5, clientHeight: 206.5, scale: measureScreenshot ? missingScale : 2 } };
		}
		if (method === "Runtime.evaluate" && params?.expression === "innerWidth") return { result: { value: 756 } };
		return send(method, params, session);
	};
	const browser = new WebBrowser({ connect: async () => fake }), signal = new AbortController().signal;
	try {
		const shot = await browser.open({ url: "http://localhost/canvas" }, signal);
		await browser.screenshot(shot);
		measureScreenshot = true;
		await browser.screenshot(shot);
		measureScreenshot = false;
		await assert.rejects(browser.perform(shot, { action: "click", x: 208, y: 100 }, signal), /look at this page first/);
		assert.equal(fake.sent.some(call => call.method.startsWith("Input.")), false);
	} finally { await browser.close(); }
});

test("canvas measurement ignores a page's replacement innerWidth and never falls back to its context", async () => {
	const fake = new FakeCdp(), send = fake.send.bind(fake);
	let measurementFails = false, unsafeReads = 0, safeReads = 0;
	fake.send = async (method, params, session) => {
		if (method === "Page.captureScreenshot") return { data: encodePng(756, 413, Buffer.alloc(756 * 413 * 4)).toString("base64") };
		if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 741, clientHeight: 413, scale: 1 } };
		if (method === "Runtime.evaluate" && params?.expression === "innerWidth") {
			if (params.contextId !== 37) { unsafeReads++; return { result: { value: 378 } }; }
			safeReads++; assert.equal(params.throwOnSideEffect, true);
			if (measurementFails) return { exceptionDetails: { text: "measurement unavailable" }, result: { value: 756 } };
			return { result: { value: 756 } };
		}
		return send(method, params, session);
	};
	const browser = new WebBrowser({ connect: async () => fake }), signal = new AbortController().signal;
	try {
		const shot = await browser.open({ url: "http://localhost/canvas" }, signal);
		await browser.screenshot(shot);
		const done = await browser.perform(shot, { action: "click", x: 104, y: 206 }, signal);
		assert.deepEqual(fake.sent.filter(call => call.method === "Input.dispatchMouseEvent").map(call => [call.params?.x, call.params?.y]), [[104, 206], [104, 206]]);
		measurementFails = true;
		await browser.screenshot(done.shot);
		await assert.rejects(browser.perform(done.shot, { action: "click", x: 104, y: 206 }, signal), /look at this page first/);
		assert.equal(unsafeReads, 0); assert.equal(safeReads, 2);
		assert.equal(fake.sent.filter(call => call.method === "Input.dispatchMouseEvent").length, 2);
	} finally { await browser.close(); }
});

test("typing is confirmed only when the new text lands in the field", async () => {
	assert.equal(textLanded("ada", "ada", "a"), false);
	assert.equal(textLanded("", "ada", "ada"), true);
	assert.equal(textLanded("ad", "ada", "a"), true);
	assert.equal(textLanded("hel", "helX", "X"), true);
	const fake = new FakeCdp(), t = tools(fake);
	fake.seed("ada");
	fake.hold = true;
	const page = await t.web_read!.execute({ url: "https://example.test/form" }, ctx());
	const email = idOf(page.modelContent, "textbox", "Email");
	const typed = await t.web_act!.execute({ action: "type", id: email, text: "a" }, ctx());
	assert.equal(typed.details.outcome, "unconfirmed", typed.modelContent);
	assert.equal(typed.ok, false);
});

test("the browser profile is never the user's Chrome profile, and headed Chrome stays in the background", () => {
	const profile = join(tmpdir(), "mountains-web");
	assert.equal(browserProfileDir(profile), join(realpathSync(tmpdir()),'mountains-web'));
	assert.throws(() => browserProfileDir(join(homedir(), "Library/Application Support/Google/Chrome")), /never use the user's Chrome profile/);
	assert.equal(parseDevToolsActivePort("9222\n/devtools/browser/abc\n")?.port, 9222);
	assert.equal(parseDevToolsActivePort("nope"), undefined);
	const args = chromeArguments(profile, false);
	assert.ok(args.some(arg => arg === `--user-data-dir=${profile}`));
	assert.equal(args.includes("--remote-allow-origins=*"), false);
	assert.ok(chromeArguments(profile, true).includes("--headless=new"));
	if (process.platform === "darwin") {
		const command = chromeLaunchCommand("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args, false);
		assert.match(command.file, /\/native\/darwin-universal\/launch-app$/);
		assert.deepEqual(command.args.slice(0, 6), ["--new", "--watch", "5", "--settle", "1", "/Applications/Google Chrome.app"]);
		assert.equal(launcherExitMeansQuit(command.file, 0), false);
		assert.equal(launcherExitMeansQuit(command.file, 1), true);
		assert.equal(launcherExitMeansQuit("open", 0), true, "only the bundled launcher's exit is a hand-off");
		assert.equal(launcherExitMeansQuit("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", 0), true);
	}
});

test("a profile alias cannot hide a normal Chrome profile, including a missing child directory", () => {
	const directory = mkdtempSync(join(tmpdir(), "mountains-profile-alias-"));
	try {
		const chrome = join(directory, "Google", "Chrome");
		mkdirSync(chrome, { recursive: true });
		symlinkSync(chrome, join(directory, "apparently-private"));
		assert.throws(() => browserProfileDir(join(directory, "apparently-private")), /never use the user's Chrome profile/);
		assert.throws(() => browserProfileDir(join(directory, "apparently-private", "new-profile")), /never use the user's Chrome profile/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cancellation during browser focus cannot insert text afterwards", async () => {
	const fake = new FakeCdp(), controller = new AbortController(), original = fake.send.bind(fake);
	fake.send = async (method, params, session) => {
		const result = await original(method, params, session);
		if (method === "DOM.focus") controller.abort(new Error("user cancelled"));
		return result;
	};
	const t = tools(fake), c = ctx(); c.signal = controller.signal;
	const page = await t.web_read!.execute({ url: "https://example.test/form" }, c);
	const result = await t.web_act!.execute({ action: "type", id: idOf(page.modelContent, "textbox", "Email"), text: "must not appear" }, c);
	assert.equal(result.ok, false);
	assert.equal(fake.sent.some(call => call.method === "Input.insertText"), false);
});

test("a mouse press with an uncertain acknowledgement still gets a release", async () => {
	const fake = new FakeCdp(), original = fake.send.bind(fake);
	fake.send = async (method, params, session) => {
		const result = await original(method, params, session);
		if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") throw new Error("lost acknowledgement");
		return result;
	};
	const t = tools(fake), page = await t.web_read!.execute({ url: "https://example.test/form" }, ctx());
	const result = await t.web_act!.execute({ action: "click", id: idOf(page.modelContent, "button", "Send") }, ctx());
	assert.equal(result.details.outcome, "failed");
	assert.deepEqual(fake.sent.filter(call => call.method === "Input.dispatchMouseEvent").map(call => call.params?.type), ["mousePressed", "mouseReleased"]);
});

test("a slow load outliving the idle timeout does not create an unhandled rejection", async () => {
	const fake = new FakeCdp(), original = fake.send.bind(fake);
	fake.send = async (method, params, session) => {
		if (method === "Page.navigate") await new Promise(resolve => setTimeout(resolve, 25));
		return original(method, params, session);
	};
	const result = await tools(fake, { idleMs: 1, navigationTimeoutMs: 200 }).web_read!.execute({ url: "https://example.test/slow" }, ctx());
	assert.equal(result.ok, true, result.modelContent);
});

test("a page is numbered, passwords remain hidden while typing is allowed, and Send clicks without an approval gate", async () => {
	const fake = new FakeCdp(), t = tools(fake), c = ctx();
	const listed = await t.web_read!.execute({}, c);
	assert.match(listed.modelContent, /no tabs/);
	assert.match(listed.modelContent, /untrusted data/);
	const blocked = await t.web_read!.execute({ url: "javascript:alert(1)" }, c);
	assert.equal(blocked.ok, false);
	assert.equal(fake.sent.some(call => call.method === "Page.navigate"), false);
	const page = await t.web_read!.execute({ url: "https://example.test/form" }, c);
	assert.match(page.modelContent, /untrusted data/);
	const email = idOf(page.modelContent, "textbox", "Email");
	const password = idOf(page.modelContent, "textbox", "Password");
	const secret = idOf(page.modelContent, "textbox", "Secret");
	const send = idOf(page.modelContent, "button", "Send");
	const typed = await t.web_act!.execute({ snapshot: page.details.snapshot, action: "type", id: email, text: "ada" }, c);
	assert.equal(typed.details.outcome, "confirmed", typed.modelContent);
	assert.match(typed.modelContent, /Email/);
	assert.doesNotMatch(typed.modelContent, /Password/);
	assert.match(typed.modelContent, /Element numbers not listed/);
	const refused = await t.web_act!.execute({ snapshot: typed.details.snapshot, action: "type", id: password, text: "hunter2" }, c);
	assert.equal(refused.details.dispatched, true, refused.modelContent);
	assert.equal(refused.details.outcome,"confirmed",refused.modelContent);assert.equal(refused.details.passwordLength,7);
	assert.doesNotMatch(refused.modelContent, /hunter2/);
	const hidden = await t.web_act!.execute({ snapshot: refused.details.snapshot, action: "type", id: secret, text: "4111" }, c);
	assert.equal(hidden.details.outcome, "not_executed");
	assert.equal(fake.sent.some(call => call.method === "Input.insertText" && call.params?.text === "hunter2"), true);
	const clicked = await t.web_act!.execute({ snapshot: refused.details.snapshot, action: "click", id: send }, c);
	assert.equal(c.asked.some(request => /Send/.test(request.explanation ?? "")), false);
	assert.equal(clicked.details.dispatched, true, clicked.modelContent);
	const keyed = await t.web_act!.execute({ action: "key", key: "Tab" }, c);
	assert.equal(keyed.details.dispatched, true, keyed.modelContent);
	assert.equal(fake.sent.filter(call => call.method === "Input.dispatchMouseEvent").length, 2);
});

test('an ignored password insertion is not confirmed merely because input was sent',async()=>{
 const fake=new FakeCdp(),t=tools(fake);fake.hold=true;
 const page=await t.web_read!.execute({url:'https://example.test/login'},ctx());
 const result=await t.web_act!.execute({action:'type',id:idOf(page.modelContent,'textbox','Password'),text:'hidden-secret'},ctx());
 assert.equal(result.details.dispatched,true);assert.equal(result.details.outcome,'unconfirmed');assert.equal(result.details.passwordLength,undefined);assert.doesNotMatch(result.modelContent,/hidden-secret/);
});

test('a page revealing its password input after typing cannot echo the entered secret',async()=>{
 const fake=new FakeCdp(),original=fake.send.bind(fake);let inserted=false;
 fake.send=async(method,params,session)=>{
  if(method==='Input.insertText')inserted=true;
  const result=await original(method,params,session);
  if(inserted&&method==='Runtime.callFunctionOn'&&String(params?.functionDeclaration).includes('keyboardReceiver')&&params?.objectId==='obj-11'){
   const value=(result as {result:{value:Record<string,unknown>}}).result.value;value.password=false;value.value='hidden-secret';
  }
  return result;
 };
 const t=tools(fake),page=await t.web_read!.execute({url:'https://example.test/login'},ctx());
 const result=await t.web_act!.execute({action:'type',id:idOf(page.modelContent,'textbox','Password'),text:'hidden-secret'},ctx());
 assert.equal(result.details.outcome,'confirmed',result.modelContent);assert.equal(result.details.passwordLength,13);assert.doesNotMatch(JSON.stringify(result),/hidden-secret/);
});

test("consent is asked once, a stale snapshot is refused, and a batch stops at the first failure", async () => {
	const fake = new FakeCdp();
	let opened = false;
	const asking = Object.fromEntries(createWebTools({ connect: async () => { opened = true; return fake; }, imageInput: true }).map(tool => [tool.name, tool]));
	const denied = await asking.web_read!.execute({}, ctx("deny"));
	assert.equal(denied.ok, false);
	assert.equal(opened, false);
	const allowed = ctx();
	assert.equal((await asking.web_read!.execute({}, allowed)).ok, true);
	assert.equal((await asking.web_read!.execute({}, allowed)).ok, true);
	assert.equal(allowed.asked.length, 1);

	const t = tools(fake);
	const first = await t.web_read!.execute({ url: "https://example.test/form" }, ctx());
	const slim = await t.web_read!.execute({ tab: "t1" }, ctx());
	assert.equal(slim.details.diff, true);
	assert.doesNotMatch(slim.modelContent, /Password/);
	const again = await t.web_read!.execute({ tab: "t1", full: true }, ctx());
	const stale = await t.web_act!.execute({ snapshot: first.details.snapshot, action: "click", id: "e1" }, ctx());
	assert.match(stale.modelContent, /out of date/);
	const email = idOf(again.modelContent, "textbox", "Email");
	const batch = await t.web_act!.execute({ snapshot: again.details.snapshot, steps: [
		{ action: "type", id: email, text: "ada" },
		{ action: "click", id: "e999" },
		{ action: "key", key: "Enter" },
	] }, ctx());
	assert.equal(batch.details.stoppedAt, 2);
	assert.match(batch.modelContent, /later steps were not run/);
	assert.equal(batch.details.dispatched,true);assert.equal(batch.details.outcome,'failed');assert.equal(batch.details.retryUnsafe,true);
	assert.deepEqual((batch.details.steps as {dispatched:boolean}[]).map(step=>step.dispatched),[true,false]);
	assert.match(batch.modelContent,/Do not repeat them/);
	assert.equal(fake.sent.some(call => call.method === "Input.dispatchKeyEvent"), false);
	const look = await t.web_look!.execute({ snapshot: again.details.snapshot }, ctx());
	assert.equal(look.ok, false, look.modelContent);
	const current = batch.details.snapshot;
	const image = await t.web_look!.execute({ snapshot: current }, ctx());
	assert.equal(image.images?.[0]?.width, 1);
});

test('batch syntax is validated completely before any earlier page input or approval',async()=>{
	for(const bad of [{action:'click',id:'e4',expect:'Submitted'},null,{action:'not-an-action'}]){
		const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake}),signal=new AbortController().signal;
		try{
			const initial=await browser.open({url:'http://localhost/own'},signal),email=[...initial.elements.values()].find(row=>row.name==='Email')!.id;
			const t=Object.fromEntries(createWebTools({browser,consent:{granted:false}}).map(tool=>[tool.name,tool])),context=ctx(),count=fake.sent.length;
			const rejected=await t.web_act!.execute({tab:initial.tab,steps:[{action:'type',id:email,text:'must-not-land'},{action:'key',key:'Tab'},bad]},context);
			assert.equal(rejected.ok,false);assert.equal(rejected.details.dispatched,false);assert.equal(rejected.details.outcome,'not_executed');
			assert.equal(fake.sent.length,count,'not even a preparation/read command may follow a syntax error');assert.equal(context.asked.length,0);
			const independent=await browser.open({tab:initial.tab,full:true},signal);assert.equal([...independent.elements.values()].find(row=>row.name==='Email')!.value,'');
		}finally{await browser.close();}
	}
});

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")].find(path => existsSync(path));

test("headless Chrome reads a local page, types, and clicks Send", { timeout: 60_000, skip: CHROME ? false : "Google Chrome is not installed" }, async () => {
	const page = `<!doctype html><meta charset="utf-8"><title>Mountains Web</title><input id="email" aria-label="Email"><input id="pw" type="password" aria-label="Password"><button id="send">Send</button><p id="out"></p><script>document.getElementById("send").addEventListener("click",()=>{document.getElementById("out").textContent="sent "+document.getElementById("email").value})</script>`;
	const server: Server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	const port = address && typeof address === "object" ? address.port : 0;
	const profile = await mkdtemp(join(tmpdir(), "mountains-web-"));
	const browser = new WebBrowser({ headless: true, profileDir: profile, idleMs: 400 });
	const t = Object.fromEntries(createWebTools({ browser, consent: { granted: true } }).map(tool => [tool.name, tool]));
	try {
		const read = await t.web_read!.execute({ url: `http://127.0.0.1:${port}/` }, ctx());
		assert.equal(read.ok, true, read.modelContent);
		const ownBrowser=await browser.ownedProcess();assert.ok(ownBrowser);assert.equal(read.details.pid,ownBrowser.pid);assert.equal(read.details.browserIdentity,ownBrowser.identity);
		assert.match(read.modelContent, /untrusted data/);
		const email = idOf(read.modelContent, "textbox", "Email");
		const password = idOf(read.modelContent, "textbox", "Password");
		const send = idOf(read.modelContent, "button", "Send");
		const typed = await t.web_act!.execute({ snapshot: read.details.snapshot, action: "type", id: email, text: "ada" }, ctx());
		assert.equal(typed.details.outcome, "confirmed", typed.modelContent);
		assert.equal(typed.details.pid,ownBrowser.pid);assert.equal(typed.details.browserIdentity,ownBrowser.identity);
		const refused = await t.web_act!.execute({ snapshot: typed.details.snapshot, action: "type", id: password, text: "hunter2" }, ctx());
		assert.equal(refused.details.dispatched, true, refused.modelContent);
		assert.doesNotMatch(JSON.stringify(refused),/hunter2/);
		const asked = ctx();
		const clicked = await t.web_act!.execute({ snapshot: refused.details.snapshot, action: "click", id: send }, asked);
		assert.equal(clicked.details.dispatched, true, clicked.modelContent);
		assert.equal(asked.asked.some(request => /Send/.test(request.explanation ?? "")), false);
		const batch=await t.web_act!.execute({snapshot:clicked.details.snapshot,steps:[{action:'key',key:'Tab'},{action:'key',key:'Shift+Tab'}]},ctx());
		assert.deepEqual((batch.details.steps as {pid:number}[]).map(step=>step.pid),[ownBrowser.pid,ownBrowser.pid]);
		assert.deepEqual(batch.details.targetPids,[ownBrowser.pid]);
		const partial=await t.web_act!.execute({snapshot:batch.details.snapshot,steps:[{action:'key',key:'Tab'},{action:'click',id:'e-missing'}]},ctx());
		assert.equal(partial.ok,false);assert.equal(partial.details.outcome,'failed');assert.equal(partial.details.dispatched,true);assert.equal(partial.details.retryUnsafe,true);
		assert.equal(partial.details.pid,ownBrowser.pid);assert.deepEqual(partial.details.targetPids,[ownBrowser.pid]);
		assert.deepEqual((partial.details.steps as {pid?:number;dispatched:boolean}[]).map(step=>({pid:step.pid,dispatched:step.dispatched})),[{pid:ownBrowser.pid,dispatched:true},{pid:undefined,dispatched:false}]);
		const after = await t.web_read!.execute({ tab: "t1", full: true }, ctx());
		assert.match(after.modelContent, /sent ada/, after.modelContent);
	} finally {
		const owner=await browser.ownedProcess();
		await browser.close();
        if(owner)assert.notEqual((await browserProcess(owner.pid))?.identity,owner.identity,"owned Chrome must actually exit");
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});


test("JavaScript dialogs are read and require a separate explicit action",async()=>{
 const fake=new FakeCdp(),listeners=new Set<(event:CdpEvent)=>void>();
 const original=fake.send.bind(fake),originalOn=fake.on.bind(fake);let modal=false;
 fake.on=listener=>{listeners.add(listener);const off=originalOn(listener);return()=>{listeners.delete(listener);off();};};
 fake.send=async(method,params,sessionId)=>{
  if(method==="Input.dispatchMouseEvent"&&params?.type==="mouseReleased"){
   modal=true;for(const listener of listeners)listener({method:"Page.javascriptDialogOpening",params:{type:"confirm",message:"Save own test?"},...(sessionId?{sessionId}:{})});
  }
  if(method==="Page.handleJavaScriptDialog"){
   assert.equal(params?.accept,false);modal=false;
   for(const listener of listeners)listener({method:"Page.javascriptDialogClosed",params:{result:false},...(sessionId?{sessionId}:{})});
  }
  if(modal&&method==="Accessibility.getFullAXTree")throw new Error("cannot read a paused page");
  return original(method,params,sessionId);
 };
 const t=tools(fake),page=await t.web_read!.execute({url:"http://localhost/own"},ctx());
 const clicked=await t.web_act!.execute({action:"click",id:idOf(page.modelContent,"button","Send")},ctx());
 assert.match(clicked.modelContent,/Save own test/);
 assert.equal(fake.sent.some(call=>call.method==="Page.handleJavaScriptDialog"),false);
 const dismissed=await t.web_act!.execute({action:"click",id:idOf(clicked.modelContent,"button","Dismiss dialog")},ctx());
 assert.equal(modal,false);assert.equal(dismissed.details.dispatched,true);
});

for(const chain of [false,true])test(`a dialog snapshot binds one opening, including consecutive dialogs (chain=${chain})`,async()=>{
 const fake=new FakeCdp(),listeners=new Set<(event:CdpEvent)=>void>();
 const send=fake.send.bind(fake),on=fake.on.bind(fake);let modal=0;const handled:number[]=[];
 fake.on=listener=>{listeners.add(listener);const off=on(listener);return()=>{listeners.delete(listener);off();};};
 const emit=(method:string,params:Record<string,unknown>)=>{for(const listener of listeners)listener({method,params,sessionId:'s-page-1'});};
 const show=(id:number)=>{modal=id;emit('Page.javascriptDialogOpening',{type:'confirm',message:'Dialog '+id});};
 const closed=()=>{modal=0;emit('Page.javascriptDialogClosed',{result:true});};
 fake.send=async(method,p,session)=>{
  if(method==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased')show(1);
  if(method==='Page.handleJavaScriptDialog'){handled.push(modal);closed();if(chain)show(2);}
  if(modal&&method==='Accessibility.getFullAXTree')throw new Error('page is paused');
  return send(method,p,session);
 };
 const browser=new WebBrowser({connect:async()=>fake}),t=createWebTools({browser,consent:{granted:true}}),by=Object.fromEntries(t.map(tool=>[tool.name,tool]));
 try{
  const read=await by.web_read!.execute({url:'http://localhost/own'},ctx());
  const first=await by.web_act!.execute({action:'click',id:idOf(read.modelContent,'button','Send')},ctx());
  if(!chain){closed();show(2);}
  const result=await by.web_act!.execute({snapshot:first.details.snapshot,action:'click',id:idOf(first.modelContent,'button','Accept dialog')},ctx());
  if(chain){assert.deepEqual(handled,[1]);assert.match(result.modelContent,/Dialog 2/);}
  else{assert.deepEqual(handled,[]);assert.equal(result.details.outcome,'not_executed');}
 }finally{if(chain)await assert.rejects(browser.close(),/keeps opening dialogs/);else await browser.close();}
});

for(const kind of ['replace','abort'])test(`dialog identity and cancellation are rechecked after the last await (${kind})`,async()=>{
 const fake=new FakeCdp(),listeners=new Set<(event:CdpEvent)=>void>(),controller=new AbortController();
 const send=fake.send.bind(fake),on=fake.on.bind(fake);let handled=0;
 fake.on=listener=>{listeners.add(listener);const off=on(listener);return()=>{listeners.delete(listener);off();};};
 const show=(number:number)=>{for(const listener of listeners)listener({method:'Page.javascriptDialogOpening',params:{type:'confirm',message:'Dialog '+number},sessionId:'s-page-1'});};
 fake.send=async(method,p,session)=>{if(method==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased')show(1);if(method==='Page.handleJavaScriptDialog')handled++;return send(method,p,session);};
 const browser=new WebBrowser({connect:async()=>fake}),t=Object.fromEntries(createWebTools({browser,consent:{granted:true}}).map(tool=>[tool.name,tool])),context={...ctx(),signal:controller.signal};
 const read=await t.web_read!.execute({url:'http://localhost/own'},context);
 const first=await t.web_act!.execute({action:'click',id:idOf(read.modelContent,'button','Send')},context);
 const internal=browser as unknown as {connection(signal?:AbortSignal):Promise<CdpLike>};
 const original=internal.connection.bind(browser);let armed=true;
 internal.connection=async signal=>{const live=await original(signal);if(armed&&signal===undefined){armed=false;if(kind==='replace')show(2);else controller.abort(new Error('cancel before final dispatch'));}return live;};
 try{
  const result=await t.web_act!.execute({snapshot:first.details.snapshot,action:'click',id:idOf(first.modelContent,'button','Accept dialog')},context);
  assert.equal(handled,0);assert.equal(result.details.outcome,'not_executed');assert.equal(result.details.dispatched,false);
 }finally{await browser.close();}
});

for(const action of ['click','scroll','type','select','key'] as const){
 for(const abortAt of ({click:['DOM.scrollIntoViewIfNeeded','DOM.getBoxModel','Input.dispatchMouseEvent'],scroll:['DOM.scrollIntoViewIfNeeded','DOM.getBoxModel','Input.dispatchMouseEvent'],type:['DOM.resolveNode','Runtime.callFunctionOn','DOM.focus','Input.insertText'],select:['DOM.resolveNode','Runtime.callFunctionOn'],key:['Input.dispatchKeyEvent']} as const)[action]){
  test(`cancel after ${abortAt} prevents additional web input (${action})`,async()=>{
   const fake=new FakeCdp(),controller=new AbortController(),send=fake.send.bind(fake),late:string[]=[];
   let armed=false;
   fake.send=async(method,p,session)=>{
    const cleanup=method==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased'||method==='Input.dispatchKeyEvent'&&p?.type==='keyUp';
    const mutation=method.startsWith('Input.')||method==='DOM.focus'||method==='DOM.scrollIntoViewIfNeeded'||method==='Runtime.callFunctionOn'&&String(p?.functionDeclaration).includes('HTMLSelectElement');
    if(armed&&controller.signal.aborted&&mutation&&!cleanup)late.push(method);
    const result=await send(method,p,session);
    if(armed&&method===abortAt)controller.abort(new Error('injected cancellation after '+method));
    return result;
   };
   const browser=new WebBrowser({connect:async()=>fake}),signal=controller.signal;
   try{
    const shot=await browser.open({},signal),field=[...shot.elements.values()].find(e=>e.name==='Email')!,button=[...shot.elements.values()].find(e=>e.name==='Send')!;
    // A select uses the same backend fixture with its role exposed as a combobox.
    const target=action==='click'||action==='scroll'?button:field;
    if(action==='select')target.role='combobox';
    armed=true;
    try{await browser.perform(shot,{action,id:target.id,text:'Blue',key:'Enter',dy:20},signal);}catch{/* cancellation may happen before or after an already-dispatched effect */}
    assert.equal(controller.signal.aborted,true,'the planned cancellation injection must actually run');
    assert.deepEqual(late,[]);
   }finally{await browser.close();}
  });
 }
}

test('cancel during navigation connection does not create unhandled waiter rejections',async()=>{
 const fake=new FakeCdp(),controller=new AbortController(),browser=new WebBrowser({connect:async()=>fake});
 const internal=browser as unknown as {connection(signal?:AbortSignal):Promise<CdpLike>;navigate(session:string,url:string,signal:AbortSignal):Promise<void>};
 const navigate=internal.navigate.bind(browser),connection=internal.connection.bind(browser);let armed=false;
 internal.navigate=async(session,url,signal)=>{armed=true;return navigate(session,url,signal);};
 internal.connection=async signal=>{const cdp=await connection(signal);if(armed){armed=false;controller.abort(new Error('cancel in navigation connection'));}return cdp;};
 try{
  await assert.rejects(browser.open({url:'http://localhost/own'},controller.signal),/cancel in navigation connection/);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(fake.sent.some(call=>call.method==='Page.navigate'),false);
 }finally{await browser.close();}
});

/** A real JS dialog can leave its triggering CDP request pending until it closes. */
function blockingDialog(trigger: (method: string, params: Record<string, unknown> | undefined) => boolean) {
 const fake = new FakeCdp(), send = fake.send.bind(fake), on = fake.on.bind(fake);
 const listeners = new Set<(event:CdpEvent)=>void>();
 const pending: (()=>void)[] = []; let armed=false, fired=false, modal=false;
 fake.on = listener => { listeners.add(listener); const off=on(listener); return()=>{listeners.delete(listener);off();}; };
 const emit = (method:string, params:Record<string,unknown>) => { for(const listener of [...listeners]) listener({method,params,sessionId:'s-page-1'}); };
 fake.send = async(method,params,session) => {
  if(method==='Page.handleJavaScriptDialog') {
   modal=false; emit('Page.javascriptDialogClosed',{result:params?.accept});
   for(const release of pending.splice(0))release();
   return send(method,params,session);
  }
  if(armed&&!fired&&trigger(method,params)) {
   fired=true;modal=true;
   const answer=await send(method,params,session);
   emit('Page.javascriptDialogOpening',{type:'confirm',message:'Blocked acknowledgement'});
   await new Promise<void>(resolve=>pending.push(resolve));return answer;
  }
  if(modal&&method==='Accessibility.getFullAXTree')throw new Error('AX read must not wait behind a dialog');
  return send(method,params,session);
 };
 return {fake,arm(){armed=true;},get modal(){return modal;}};
}

for(const trigger of ['DOM.focus','mousePressed','mouseReleased','keyDown'])test(`a blocked ${trigger} yields a dialog and releases input exactly once after an explicit response`,async()=>{
 const h=blockingDialog((method,p)=>trigger==='DOM.focus'?method===trigger:method.startsWith('Input.')&&p?.type===trigger);
 const browser=new WebBrowser({connect:async()=>h.fake}),t=tools(h.fake,{browser}),signal=new AbortController().signal;
 try {
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx());h.arm();
  const args=trigger==='DOM.focus'?{action:'type',id:idOf(page.modelContent,'textbox','Email'),text:'must not appear'}:trigger==='keyDown'?{action:'key',key:'Enter'}:{action:'click',id:idOf(page.modelContent,'button','Send')};
  const started=performance.now(),paused=await t.web_act!.execute({...args,steps:undefined},ctx());
  assert.ok(performance.now()-started<1000,'dialog should interrupt immediately, not wait for protocol timeout');
  assert.equal(paused.details.pausedByDialog,true,paused.modelContent);assert.equal(h.modal,true);
  assert.equal(h.fake.sent.filter(c=>c.method==='Input.insertText').length,0);
  const releases=()=>h.fake.sent.filter(c=>c.params?.type==='mouseReleased'||c.params?.type==='keyUp');
  assert.equal(releases().length,trigger==='mouseReleased'?1:0);
  const handled=await t.web_act!.execute({action:'click',id:idOf(paused.modelContent,'button','Dismiss dialog')},ctx());
  assert.equal(handled.details.dispatched,true,handled.modelContent);assert.equal(h.modal,false);
  assert.equal(releases().length,trigger==='DOM.focus'?0:1);
  assert.equal(h.fake.sent.filter(c=>c.method==='Input.insertText').length,0,'late focus acknowledgement must not resume old typing');
  assert.equal(signal.aborted,false);
 }finally{await browser.close();}
});

test('a batch stops at a newly opened dialog before its unseen Enter and text steps',async()=>{
 const h=blockingDialog((m,p)=>m==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased');
 const browser=new WebBrowser({connect:async()=>h.fake}),t=tools(h.fake,{browser});
 try {
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx());h.arm();
  const paused=await t.web_act!.execute({steps:[{action:'click',id:idOf(page.modelContent,'button','Send')},{action:'key',key:'Enter'},{action:'type',id:idOf(page.modelContent,'textbox','Email'),text:'bad'}]},ctx());
  assert.equal(paused.details.stoppedAt,1);assert.equal(paused.details.pausedByDialog,true);
  assert.equal(h.fake.sent.some(c=>c.method==='Page.handleJavaScriptDialog'||c.method==='Input.dispatchKeyEvent'||c.method==='Input.insertText'),false);
 }finally{await browser.close();}
});

for(const when of ['AX','navigate'])test(`a dialog interrupts a blocked ${when} read and preserves its virtual controls`,async()=>{
 const h=blockingDialog((m)=>m===(when==='AX'?'Accessibility.getFullAXTree':'Page.navigate'));
 const browser=new WebBrowser({connect:async()=>h.fake}),t=tools(h.fake,{browser});
 try {
  await t.web_read!.execute({url:'http://localhost/own'},ctx());h.arm();
  const page=await t.web_read!.execute({tab:'t1',...(when==='AX'?{}:{url:'http://localhost/another'})},ctx());
  assert.equal(page.ok,true,page.modelContent);assert.match(page.modelContent,/Blocked acknowledgement/);
  assert.match(page.modelContent,/Dismiss dialog/);
 }finally{await browser.close();}
});

test('a dialog interrupts the load wait after navigation has already acknowledged',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake),on=fake.on.bind(fake),listeners=new Set<(event:CdpEvent)=>void>();
 fake.on=listener=>{listeners.add(listener);const off=on(listener);return()=>{listeners.delete(listener);off();};};
 let armed=false;
 fake.send=async(m,p,s)=>{
  if(armed&&m==='Page.navigate'){
   setImmediate(()=>{for(const listener of [...listeners])listener({method:'Page.javascriptDialogOpening',params:{type:'alert',message:'Opened while waiting for load'},sessionId:s!});});
   return{frameId:'f1'};
  }
  if(m==='Page.handleJavaScriptDialog')for(const listener of [...listeners])listener({method:'Page.javascriptDialogClosed',params:{},sessionId:s!});
  return send(m,p,s);
 };
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  await t.web_read!.execute({url:'http://localhost/own'},ctx());armed=true;
  const started=performance.now(),page=await t.web_read!.execute({tab:'t1',url:'http://localhost/loading'},ctx());
  assert.ok(performance.now()-started<1000);assert.equal(page.ok,true,page.modelContent);assert.match(page.modelContent,/Opened while waiting for load/);
 }finally{await browser.close();}
});

test('another client cannot cross the owner\'s dialog or held mouse, and owner close releases it',async()=>{
 const h=blockingDialog((m,p)=>m==='Input.dispatchMouseEvent'&&p?.type==='mousePressed');
 const a=new WebBrowser({connect:async()=>h.fake}),b=new WebBrowser({connect:async()=>h.fake});
 const ta=tools(h.fake,{browser:a}),tb=tools(h.fake,{browser:b});
 try {
  const first=await ta.web_read!.execute({url:'http://localhost/own'},ctx());await tb.web_read!.execute({tab:'t1'},ctx());h.arm();
  await ta.web_act!.execute({action:'click',id:idOf(first.modelContent,'button','Send')},ctx());
  const read=await tb.web_read!.execute({tab:'t1'},ctx());
  const refused=await tb.web_act!.execute({action:'click',id:idOf(read.modelContent,'button','Accept dialog')},ctx());
  assert.equal(refused.details.dispatched,false);assert.match(refused.modelContent,/another browser client/);
  assert.equal(h.fake.sent.some(c=>c.method==='Page.handleJavaScriptDialog'||c.params?.type==='mouseReleased'),false);
  await a.close();assert.equal(h.modal,false);
  assert.equal(h.fake.sent.filter(c=>c.params?.type==='mouseReleased').length,1);
  const fresh=await tb.web_read!.execute({tab:'t1'},ctx());
  const result=await tb.web_act!.execute({action:'type',id:idOf(fresh.modelContent,'textbox','Email'),text:'safe'},ctx());
  assert.equal(result.ok,true,result.modelContent);
 }finally{await a.close();await b.close();}
});

test('select-all uses the platform chord on keydown only and checks the actual selection',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);let selected=false;
 fake.send=async(m,p,s)=>{if(m==='Input.dispatchKeyEvent'&&p?.type==='keyDown')selected=Array.isArray(p.commands)&&p.commands[0]==='selectAll';if(m==='Runtime.evaluate'&&p?.expression!=='document.activeElement')return{result:{value:selected}};return send(m,p,s);};
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try {
  await t.web_read!.execute({url:'http://localhost/own'},ctx());
  const chord=process.platform==='darwin'?'cmd+a':'ctrl+a';
  const result=await t.web_act!.execute({action:'key',key:chord},ctx());assert.equal(result.details.outcome,'confirmed',result.modelContent);
  const events=fake.sent.filter(c=>c.method==='Input.dispatchKeyEvent');
  assert.deepEqual(events[0]?.params?.commands,['selectAll']);assert.equal(events[0]?.params?.code,'KeyA');assert.equal(events[0]?.params?.windowsVirtualKeyCode,65);
  assert.equal(events[1]?.params?.commands,undefined);assert.equal(events[1]?.params?.modifiers,0);
  if(process.platform==='darwin') {await t.web_act!.execute({action:'key',key:'ctrl+a'},ctx());assert.equal(fake.sent.filter(c=>c.method==='Input.dispatchKeyEvent').at(-2)?.params?.commands,undefined);}
 }finally{await browser.close();}
});

test('a keyboard action with an element ID focuses that element before dispatch',async()=>{
 const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(page.modelContent,'textbox','Email');
  const start=fake.sent.length;
  await t.web_act!.execute({action:'key',id,key:process.platform==='darwin'?'cmd+a':'ctrl+a'},ctx());
  const input=fake.sent.slice(start).filter(c=>c.method==='DOM.focus'||c.method==='Input.dispatchKeyEvent');
  assert.equal(input[0]?.method,'DOM.focus');assert.equal(input[0]?.params?.backendNodeId,10);
  assert.equal(input[1]?.method,'Input.dispatchKeyEvent');
  const password=idOf(page.modelContent,'textbox','Password'),before=fake.sent.length;
  const denied=await t.web_act!.execute({action:'key',id:password,key:'a'},ctx());
  assert.equal(denied.details.dispatched,true,denied.modelContent);
  assert.equal(fake.sent.slice(before).some(c=>c.method==='DOM.focus'),true);
  assert.equal(fake.sent.slice(before).some(c=>c.method==='Input.dispatchKeyEvent'),true);
 }finally{await browser.close();}
});

test('cancellation during targeted keyboard focus never sends the key',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake),controller=new AbortController();
 fake.send=async(m,p,s)=>{const result=await send(m,p,s);if(m==='DOM.focus')controller.abort(new Error('cancel focus'));return result;};
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(page.modelContent,'textbox','Email');
  const result=await t.web_act!.execute({action:'key',id,key:'a'},{...ctx(),signal:controller.signal});
  assert.equal(result.ok,false);assert.equal(fake.sent.some(c=>c.method==='Input.dispatchKeyEvent'),false);
 }finally{await browser.close();}
});

test('keyboard input checks actual password/payment receiver and refuses focus redirection',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake),browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx()),secret=idOf(page.modelContent,'textbox','Secret'),email=idOf(page.modelContent,'textbox','Email');
  let before=fake.sent.length;
  const hidden=await t.web_act!.execute({action:'key',id:secret,key:'a'},ctx());
  assert.equal(hidden.details.dispatched,false,hidden.modelContent);assert.equal(fake.sent.slice(before).some(c=>c.method==='DOM.focus'||c.method.startsWith('Input.')),false);
  await send('DOM.focus',{backendNodeId:13});before=fake.sent.length;
  const current=await t.web_act!.execute({action:'key',key:'a'},ctx());
  assert.equal(current.details.dispatched,false,current.modelContent);assert.equal(fake.sent.slice(before).some(c=>c.method.startsWith('Input.')),false);
  fake.send=async(m,p,s)=>m==='DOM.focus'?send(m,{backendNodeId:13},s):send(m,p,s);before=fake.sent.length;
  const redirected=await t.web_act!.execute({action:'key',id:email,key:'a'},ctx());
  assert.equal(redirected.ok,false,redirected.modelContent);assert.equal(redirected.details.dispatched,true);
  assert.equal(fake.sent.slice(before).some(c=>c.method==='Input.dispatchKeyEvent'),false);
  fake.send=async(m,p,s)=>m==='Runtime.callFunctionOn'?{result:{}}:send(m,p,s);before=fake.sent.length;
  const unreadable=await t.web_act!.execute({action:'key',key:'a'},ctx());
  assert.equal(unreadable.details.dispatched,false,unreadable.modelContent);assert.equal(fake.sent.slice(before).some(c=>c.method.startsWith('Input.')),false);
 }finally{await browser.close();}
});

test('the page URL and title come from its actual AX root after a link navigation',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);
 fake.send=async(m,p,s)=>m==='Accessibility.getFullAXTree'?{nodes:[{nodeId:'1',role:{value:'RootWebArea'},name:{value:'Actual new page'},properties:[{name:'url',value:{value:'http://localhost/changed'}}]}]}:send(m,p,s);
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const r=await t.web_read!.execute({url:'http://localhost/old'},ctx());
  assert.equal(r.details.url,'http://localhost/changed');assert.match(r.modelContent,/Actual new page/);
 }finally{await browser.close();}
});

for(const result of [{exceptionDetails:{text:'getter failed'},result:{}},{result:{value:{value:''}}}])test('unknown field safety never allows a text dispatch',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);
 fake.send=async(m,p,s)=>m==='Runtime.callFunctionOn'?result:send(m,p,s);
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(page.modelContent,'textbox','Secret'),before=fake.sent.length;
  const denied=await t.web_act!.execute({action:'type',id,text:'never insert'},ctx());
  assert.equal(denied.details.dispatched,false,denied.modelContent);assert.equal(fake.sent.slice(before).some(c=>c.method==='DOM.focus'||c.method==='Input.insertText'),false);
 }finally{await browser.close();}
});

test('an unacknowledged release stays blocked and is never replayed',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);let releases=0,closed=0;
 fake.close=async()=>{closed++;};
 fake.send=async(m,p,s)=>{if(m==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased'){releases++;throw new Error('release acknowledgement lost');}return send(m,p,s);};
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 const read=await t.web_read!.execute({url:'http://localhost/own'},ctx());
 const click=await t.web_act!.execute({action:'click',id:idOf(read.modelContent,'button','Send')},ctx());
 assert.equal(click.details.outcome,'failed');
 await t.web_read!.execute({tab:'t1'},ctx());
 const next=await t.web_act!.execute({action:'key',key:'Enter'},ctx());
 assert.equal(next.details.dispatched,false);assert.match(next.modelContent,/earlier input is still unverified|release was not acknowledged/);
 assert.equal(fake.sent.some(c=>c.method==='Input.dispatchKeyEvent'),false);
 await assert.rejects(browser.close(),/release was not acknowledged/);
 assert.equal(releases,1);assert.equal(closed,1,'close transport even when shared cleanup cannot be proved');
});

test('a late interrupted request failure is reported without leaving a nonexistent dialog blocking new work',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake),on=fake.on.bind(fake),listeners=new Set<(event:CdpEvent)=>void>();let armed=false,rejectFocus!:(error:Error)=>void;
 fake.on=l=>{listeners.add(l);const off=on(l);return()=>{listeners.delete(l);off();};};
 const emit=(method:string,params:Record<string,unknown>)=>{for(const l of [...listeners])l({method,params,sessionId:'s-page-1'});};
 fake.send=async(m,p,s)=>{
  if(armed&&m==='DOM.focus'){armed=false;const pending=new Promise<unknown>((_,reject)=>{rejectFocus=reject;});emit('Page.javascriptDialogOpening',{type:'confirm',message:'Focus opened dialog'});return pending;}
  if(m==='Page.handleJavaScriptDialog'){emit('Page.javascriptDialogClosed',{});setImmediate(()=>rejectFocus(new Error('old focus acknowledgement failed')));}
  return send(m,p,s);
 };
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx());armed=true;
  const paused=await t.web_act!.execute({action:'type',id:idOf(page.modelContent,'textbox','Email'),text:'no'},ctx());
  const handled=await t.web_act!.execute({action:'click',id:idOf(paused.modelContent,'button','Dismiss dialog')},ctx());
  assert.deepEqual(handled.details.interruptedErrors,['old focus acknowledgement failed']);
  await t.web_read!.execute({tab:'t1'},ctx());
  const next=await t.web_act!.execute({action:'type',id:idOf(page.modelContent,'textbox','Email'),text:'safe'},ctx());
  assert.equal(next.ok,true,next.modelContent);assert.equal(fake.sent.filter(c=>c.method==='Input.insertText').length,1);
 }finally{await browser.close();}
});

test('web_look returns immediately for a known dialog without starting a paused screenshot request',async()=>{
 const h=blockingDialog((m,p)=>m==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased'),browser=new WebBrowser({connect:async()=>h.fake}),t=tools(h.fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx());h.arm();
  await t.web_act!.execute({action:'click',id:idOf(page.modelContent,'button','Send')},ctx());
  const look=await t.web_look!.execute({},ctx());assert.equal(look.ok,false);assert.match(look.modelContent,/dialog opened/);
  assert.equal(h.fake.sent.some(c=>c.method==='Page.captureScreenshot'),false);
 }finally{await browser.close();}
});

for(const checked of ['false','true','mixed'])test(`Chrome AX tristate ${checked} is read as an actual checkbox state`,async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);let value=checked;
 fake.send=async(m,p,s)=>{
  if(m==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased')value='true';
  if(m==='Accessibility.getFullAXTree')return{nodes:[{nodeId:'1',role:{value:'checkbox'},name:{value:'I agree'},properties:[{name:'checked',value:{value}}],backendDOMNodeId:10}]};
  return send(m,p,s);
 };
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx());
  assert.match(page.modelContent,new RegExp('\\['+(checked==='false'?'unchecked':checked==='mixed'?'mixed':'checked')+'\\]'));
  const clicked=await t.web_act!.execute({action:'click',id:idOf(page.modelContent,'checkbox','I agree'),expect:{id:idOf(page.modelContent,'checkbox','I agree'),property:'checked',value:true}},ctx());
  assert.equal(clicked.details.outcome,'confirmed',clicked.modelContent);assert.equal(clicked.details.observed,true);
 }finally{await browser.close();}
});

test('invalid Web expectations are refused before input and missing states never confirm',async()=>{
 const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(page.modelContent,'button','Send');
  const count=()=>fake.sent.filter(c=>c.method.startsWith('Input.')).length;
  for(const [property,value] of [['value',null],['checked',null],['selected',null],['expanded',null],['exists',null],['value',true],['checked','false'],['selected','true'],['expanded','mixed'],['exists','false']]){
   const before=count(),r=await t.web_act!.execute({action:'click',id,expect:{id,property,value}},ctx());
   assert.equal(r.ok,false,r.modelContent);assert.equal(r.details.dispatched,false);assert.equal(count(),before);
  }
  for(const property of ['checked','selected','expanded']){
   const r=await t.web_act!.execute({action:'click',id,expect:{id,property,value:false}},ctx());
   assert.equal(r.details.outcome,'unconfirmed',r.modelContent);assert.equal(r.details.observed,null);
  }
  const absent=await t.web_act!.execute({action:'click',id,expect:{id:'absent',property:'exists',value:false}},ctx());
  assert.equal(absent.details.outcome,'unconfirmed',absent.modelContent);assert.equal(absent.details.observed,null);
 }finally{await browser.close();}
});

test('an explicit page-text expectation waits for the actual delayed result with exactly one click',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake);let status='Still working',timer:ReturnType<typeof setTimeout>|undefined;
	fake.send=async(method,params,session)=>{
		if(method==='Input.dispatchMouseEvent'&&params?.type==='mouseReleased')timer=setTimeout(()=>{status='Own delayed result is ready';},65);
		const reply=await send(method,params,session);
		if(method==='Accessibility.getFullAXTree'){const tree=reply as {nodes:{nodeId:string;childIds?:string[]}[]};tree.nodes[0]!.childIds!.push('own-status');tree.nodes.push({nodeId:'own-status',role:{value:'statictext'},name:{value:status},backendDOMNodeId:30,childIds:[]} as any);}
		return reply;
	};
	const browser=new WebBrowser({connect:async()=>fake,navigationTimeoutMs:500}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(first.modelContent,'button','Send'),start=performance.now();
		const result=await t.web_act!.execute({action:'click',id,expect:{property:'text',value:'Own delayed result is ready'}},ctx());
		assert.equal(result.ok,true,result.modelContent);assert.equal(result.details.outcome,'confirmed');assert.equal(result.details.observed,status);assert.ok(performance.now()-start>=55);
		assert.equal(fake.sent.filter(row=>row.method==='Input.dispatchMouseEvent'&&row.params?.type==='mousePressed').length,1);assert.equal(fake.sent.filter(row=>row.method==='Input.dispatchMouseEvent'&&row.params?.type==='mouseReleased').length,1);
	}finally{clearTimeout(timer);await browser.close();}
});
test('a text expectation that never appears stays unconfirmed and never repeats input',async()=>{
	const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake,navigationTimeoutMs:50}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx()),start=performance.now();
		const result=await t.web_act!.execute({action:'click',id:idOf(first.modelContent,'button','Send'),expect:{property:'text',value:'This result never appears'}},ctx());
		assert.equal(result.ok,false);assert.equal(result.details.dispatched,true);assert.equal(result.details.outcome,'unconfirmed');assert.equal(result.details.observed,null);assert.ok(performance.now()-start>=40&&performance.now()-start<1000);
		assert.equal(fake.sent.filter(row=>row.method==='Input.dispatchMouseEvent'&&row.params?.type==='mousePressed').length,1);
	}finally{await browser.close();}
});
test('cancelling an explicit text wait preserves the first click and stops without a later input',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake),stop=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
	fake.send=async(method,params,session)=>{if(method==='Input.dispatchMouseEvent'&&params?.type==='mouseReleased')timer=setTimeout(()=>stop.abort(new Error('cancel own text wait')),30);return send(method,params,session);};
	const browser=new WebBrowser({connect:async()=>fake,navigationTimeoutMs:500}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx());
		const result=await t.web_act!.execute({action:'click',id:idOf(first.modelContent,'button','Send'),expect:{property:'text',value:'Never ready'}},{...ctx(),signal:stop.signal});
		assert.equal(result.ok,false);assert.equal(result.details.dispatched,true);assert.equal(result.details.outcome,'failed');const inputs=fake.sent.filter(row=>row.method.startsWith('Input.')).length;
		await new Promise<void>(yes=>setImmediate(yes));assert.equal(fake.sent.filter(row=>row.method.startsWith('Input.')).length,inputs);assert.equal(fake.sent.filter(row=>row.method==='Input.dispatchMouseEvent'&&row.params?.type==='mousePressed').length,1);
	}finally{clearTimeout(timer);await browser.close();}
});
test('invalid text waits are rejected for the whole batch before the first input',async()=>{
	const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(first.modelContent,'button','Send');
		for(const expect of [{property:'text',value:true},{property:'text',value:''},{property:'text',value:'  '},{property:'text',value:'x'.repeat(2001)},{id,property:'text',value:'Own result'}]){
			const result=await t.web_act!.execute({steps:[{action:'click',id},{action:'click',id,expect}]},ctx());assert.equal(result.ok,false);assert.equal(result.details.dispatched,false);assert.equal(fake.sent.filter(row=>row.method.startsWith('Input.')).length,0);
		}
	}finally{await browser.close();}
});
test('text waits do not match element numbers or protocol role labels as page content',async()=>{
	const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake,navigationTimeoutMs:5}),t=tools(fake,{browser});
	try{
		let page=await t.web_read!.execute({url:'http://localhost/own'},ctx());
		for(const value of ['button',idOf(page.modelContent,'button','Send')]){
			const result=await t.web_act!.execute({action:'click',id:idOf(page.modelContent,'button','Send'),expect:{property:'text',value}},ctx());assert.equal(result.ok,false);assert.equal(result.details.observed,null);
			page=await t.web_read!.execute({tab:'t1',full:true},ctx());
		}
	}finally{await browser.close();}
});
test('text returned by a slow read after the checking deadline is retained but cannot be confirmed',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake);let clicked=false;
	fake.send=async(method,params,session)=>{
		if(method==='Input.dispatchMouseEvent'&&params?.type==='mouseReleased')clicked=true;
		if(method==='Accessibility.getFullAXTree'&&clicked){await new Promise<void>(yes=>setTimeout(yes,40));const reply=await send(method,params,session) as {nodes:any[]};reply.nodes[0].childIds.push('late-text');reply.nodes.push({nodeId:'late-text',role:{value:'statictext'},name:{value:'Own late result'},backendDOMNodeId:30,childIds:[]});return reply;}
		return send(method,params,session);
	};
	const browser=new WebBrowser({connect:async()=>fake,navigationTimeoutMs:10}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx()),result=await t.web_act!.execute({action:'click',id:idOf(first.modelContent,'button','Send'),expect:{property:'text',value:'Own late result'}},ctx());
		assert.equal(result.ok,false);assert.equal(result.details.dispatched,true);assert.equal(result.details.observed,null);assert.equal(result.details.textWaitTimedOut,true);assert.match(result.modelContent,/Own late result/);assert.match(result.modelContent,/checking deadline/);
		assert.equal(fake.sent.filter(row=>row.method==='Input.dispatchMouseEvent'&&row.params?.type==='mousePressed').length,1);
	}finally{await browser.close();}
});
test('synthetic iframe URL headers cannot satisfy a page-text expectation',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake),needle='ONLY_FRAME_METADATA_8251';
	fake.send=async(method,params,session)=>{
		if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'f1',loaderId:'main-loader',url:'http://localhost/own'},childFrames:[{frame:{id:'own-child',parentId:'f1',loaderId:'child-loader',url:'https://metadata.invalid/'+needle}}]}};
		if(method==='Accessibility.getFullAXTree'&&params?.frameId==='own-child')return{nodes:axFixtureNodes([{nodeId:'child-root',role:{value:'RootWebArea'},name:{value:'Empty child'},childIds:[]}],'own-child')};
		return send(method,params,session);
	};
	const browser=new WebBrowser({connect:async()=>fake,navigationTimeoutMs:5}),t=tools(fake,{browser});
	try{const first=await t.web_read!.execute({url:'http://localhost/own',full:true},ctx());assert.match(first.modelContent,new RegExp(needle));const result=await t.web_act!.execute({action:'click',id:idOf(first.modelContent,'button','Send'),expect:{property:'text',value:needle}},ctx());assert.equal(result.ok,false);assert.equal(result.details.observed,null);assert.equal(result.details.textWaitTimedOut,true);}
	finally{await browser.close();}
});
test('tabs created during the final text capture are reported in the actual action receipt',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake);let clicked=false,born=false;
	fake.send=async(method,params,session)=>{
		if(method==='Input.dispatchMouseEvent'&&params?.type==='mouseReleased')clicked=true;const reply=await send(method,params,session);
		if(method==='Target.getTargets'&&born)return{targetInfos:[...(reply as {targetInfos:unknown[]}).targetInfos,{targetId:'own-new-tab',type:'page',url:'http://localhost/own-new',title:'Own new page'}]};
		if(method==='Accessibility.getFullAXTree'&&clicked){born=true;const nodes=(reply as {nodes:any[]}).nodes;nodes[0].childIds.push('new-ready');nodes.push({nodeId:'new-ready',role:{value:'statictext'},name:{value:'Own actual result'},backendDOMNodeId:30,childIds:[]});}return reply;
	};
	const browser=new WebBrowser({connect:async()=>fake,navigationTimeoutMs:100}),t=tools(fake,{browser});
	try{const first=await t.web_read!.execute({url:'http://localhost/own'},ctx()),result=await t.web_act!.execute({action:'click',id:idOf(first.modelContent,'button','Send'),expect:{property:'text',value:'Own actual result'}},ctx());assert.equal(result.ok,true,result.modelContent);assert.ok((result.details.newTabs as {url:string}[]).some(tab=>tab.url==='http://localhost/own-new'));assert.equal(fake.sent.filter(row=>row.method==='Input.dispatchMouseEvent'&&row.params?.type==='mousePressed').length,1);}
	finally{await browser.close();}
});
test('an unmet explicit expectation stops a batch before its later input',async()=>{
	const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake,navigationTimeoutMs:5}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx()),result=await t.web_act!.execute({steps:[{action:'click',id:idOf(first.modelContent,'button','Send'),expect:{property:'text',value:'Result never appears'}},{action:'type',id:idOf(first.modelContent,'textbox','Email'),text:'MUST_NOT_SEND'}]},ctx());
		assert.equal(result.ok,false);assert.equal(result.details.outcome,'unconfirmed');assert.equal(result.details.stoppedAt,1);assert.equal((result.details.steps as unknown[]).length,1);assert.equal(fake.sent.filter(row=>row.method==='Input.insertText').length,0);assert.match(result.modelContent,/later steps were not run/);
	}finally{await browser.close();}
});

for(const [property,value] of [['checked',false],['checked','mixed'],['selected',false],['expanded',false]] as const)test(`known Web ${property}=${value} confirms its actual state`,async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);
 fake.send=async(m,p,s)=>m==='Accessibility.getFullAXTree'?{nodes:[{nodeId:'1',role:{value:'button'},name:{value:'Stateful'},properties:[{name:property,value:{value}}],backendDOMNodeId:10}]}:send(m,p,s);
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(page.modelContent,'button','Stateful');
  const r=await t.web_act!.execute({action:'click',id,expect:{id,property,value}},ctx());
  assert.equal(r.details.outcome,'confirmed',r.modelContent);assert.equal(r.details.observed,value);
 }finally{await browser.close();}
});

test('back, forward, reload and close use the same target; close stops a batch',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake),browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});let closed=false;
 fake.send=async(m,p,s)=>{
  if(m==='Page.getNavigationHistory')return{currentIndex:1,entries:[{id:10},{id:20},{id:30}]};
  if(m==='Target.closeTarget'){closed=true;return{success:true};}
  if(m==='Target.getTargets'&&closed)return{targetInfos:[]};return send(m,p,s);
 };
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx());assert.equal(page.ok,true,page.modelContent);
  for(const action of ['back','forward','reload']){const r=await t.web_act!.execute({action},ctx());assert.equal(r.details.dispatched,true,r.modelContent);}
  const sent=fake.sent.filter(c=>c.method==='Page.navigateToHistoryEntry').map(c=>c.params?.entryId);assert.deepEqual(sent,[10,30]);
  const before=fake.sent.filter(c=>c.method.startsWith('Input.')).length;
  const closed=await t.web_act!.execute({steps:[{action:'close'},{action:'key',key:'a'}]},ctx());
  assert.equal(closed.details.stoppedAt,1);assert.match(closed.modelContent,/Tab closed/);
  assert.equal(fake.sent.filter(c=>c.method.startsWith('Input.')).length,before);
 }finally{await browser.close();}
});

test('file upload waits for the clicked chooser and supplies only absolute existing files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mountains-upload-')),file=join(directory,'own.txt');await writeFile(file,'Own upload test');
 const fake=new FakeCdp(),send=fake.send.bind(fake),listeners=new Set<(e:CdpEvent)=>void>(),on=fake.on.bind(fake);
 fake.on=listener=>{listeners.add(listener);const off=on(listener);return()=>{listeners.delete(listener);off();};};
 fake.send=async(m,p,s)=>{if(m==='DOM.describeNode'&&p?.backendNodeId===10)return{node:{nodeName:'INPUT',attributes:['type','file']}};const r=await send(m,p,s);if(m==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased')for(const listener of listeners)listener({method:'Page.fileChooserOpened',params:{backendNodeId:10,mode:'selectSingle'},...(s?{sessionId:s}:{})});return r;};
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  const page=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(page.modelContent,'button','Send');
  const denied=await t.web_act!.execute({action:'upload',id,files:['relative.txt']},ctx());assert.equal(denied.details.dispatched,false);
  const uploaded=await t.web_act!.execute({action:'upload',id,files:[file]},ctx());assert.equal(uploaded.details.dispatched,true,uploaded.modelContent);
  assert.deepEqual(fake.sent.find(c=>c.method==='DOM.setFileInputFiles')?.params,{files:[file],backendNodeId:10});
  const methods=fake.sent.map(c=>c.method),intercept=methods.indexOf('Page.setInterceptFileChooserDialog');assert.ok(intercept<methods.indexOf('Input.dispatchMouseEvent'));
  assert.equal(fake.sent.filter(c=>c.method==='Page.setInterceptFileChooserDialog').at(-1)?.params?.enabled,false);
 }finally{await browser.close();await rm(directory,{recursive:true,force:true});}
});

test('a custom dropdown is not marked dispatched when its native-select preflight rejects',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);fake.send=async(m,p,s)=>m==='Accessibility.getFullAXTree'?{nodes:[{nodeId:'1',role:{value:'combobox'},name:{value:'Color'},backendDOMNodeId:10}]}:m==='Runtime.callFunctionOn'&&String(p?.functionDeclaration).includes('HTMLSelectElement')?{result:{value:{ok:false,reason:'not a native select element'}}}:send(m,p,s);
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{const read=await t.web_read!.execute({url:'http://localhost/own'},ctx());const id=idOf(read.modelContent,'combobox','Color');const r=await t.web_act!.execute({action:'select',id,text:'Blue'},ctx());assert.equal(r.details.outcome,'not_executed',r.modelContent);}finally{await browser.close();}
});


test('navigation during an AX response discards that old tree before publishing numbers',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake),listeners=new Set<(event:CdpEvent)=>void>(),on=fake.on.bind(fake);let first=true;
 fake.on=listener=>{listeners.add(listener);const off=on(listener);return()=>{off();listeners.delete(listener);};};
 fake.send=async(m,p,s)=>{
  if(m==='Accessibility.getFullAXTree'){
   if(first){first=false;for(const listener of listeners)listener({method:'Page.frameNavigated',params:{frame:{id:'root',url:'http://localhost/new',loaderId:'new'}},...(s?{sessionId:s}:{})});return{nodes:[{nodeId:'old',role:{value:'textbox'},name:{value:'Old document'},backendDOMNodeId:999}]};}
   return{nodes:[{nodeId:'new',role:{value:'RootWebArea'},name:{value:'New document'},properties:[{name:'url',value:{value:'http://localhost/new'}}]}]};
  }return send(m,p,s);
 };
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{const read=await t.web_read!.execute({url:'http://localhost/old'},ctx());assert.equal(read.ok,true,read.modelContent);assert.doesNotMatch(read.modelContent,/Old document/);assert.match(read.modelContent,/New document/);assert.equal(read.details.url,'http://localhost/new');}finally{await browser.close();}
});

test('same-process and cross-site child navigation invalidates old page input before dispatch',async()=>{
 for(const crossSite of [false,true]){
  const fake=new FakeCdp(),listeners=new Set<(event:CdpEvent)=>void>(),on=fake.on.bind(fake);
  fake.on=listener=>{listeners.add(listener);const off=on(listener);return()=>{off();listeners.delete(listener);};};
  const emit=(sessionId:string,method:string,params:Record<string,unknown>)=>{for(const listener of listeners)listener({sessionId,method,params});};
  const browser=new WebBrowser({connect:async()=>fake}),signal=new AbortController().signal;
  try{
   let shot=await browser.open({url:'http://localhost/own'},signal);const root=shot.sessionId;
   if(crossSite){emit(root,'Target.attachedToTarget',{sessionId:'cross-session',targetInfo:{targetId:'cross-target',type:'iframe'},waitingForDebugger:false});shot=await browser.open({},signal);}
   const email=[...shot.elements.values()].find(element=>element.name==='Email')!.id,before=fake.sent.length;
   emit(crossSite?'cross-session':root,'Page.frameNavigated',{frame:{id:'child-frame',parentId:'main',url:'http://localhost/new-inner',loaderId:'new-inner-loader'}});
   await assert.rejects(browser.perform(shot,{action:'type',id:email,text:'must-not-land'},signal),/navigated since that read/);
   assert.equal(fake.sent.slice(before).some(call=>call.method.startsWith('Input.')||call.method==='DOM.focus'),false);
   const current=await browser.open({},signal);const done=await browser.perform(current,{action:'type',id:email,text:'fresh'},signal);assert.equal(done.readback,'fresh');
  }finally{await browser.close();}
 }
});

test('child navigation during field focus stops text insertion instead of using the old read',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake),on=fake.on.bind(fake),listeners=new Set<(event:CdpEvent)=>void>();
 fake.on=listener=>{listeners.add(listener);const off=on(listener);return()=>{off();listeners.delete(listener);};};
 fake.send=async(method,params,sessionId)=>{
  const answer=await send(method,params,sessionId);
  if(method==='DOM.focus')for(const listener of listeners)listener({method:'Page.frameNavigated',sessionId:sessionId!,params:{frame:{id:'child',parentId:'main',loaderId:'new-child',url:'http://localhost/new-inner'}}});
  return answer;
 };
 const browser=new WebBrowser({connect:async()=>fake}),signal=new AbortController().signal;
 try{
  const shot=await browser.open({url:'http://localhost/own'},signal),email=[...shot.elements.values()].find(element=>element.name==='Email')!.id;
  await assert.rejects(browser.perform(shot,{action:'type',id:email,text:'must-not-land'},signal),/observed frame is no longer available/);
  assert.equal(fake.sent.some(call=>call.method==='Input.insertText'),false);
 }finally{await browser.close();}
});

for(const chord of ['cmd+c','ctrl+x','cmd+shift+v'])test(`web clipboard shortcut ${chord} asks every time before page input`,async()=>{
 const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{
  await t.web_read!.execute({url:'http://localhost/own'},ctx());const denied=ctx('deny'),before=fake.sent.length;
  const stopped=await t.web_act!.execute({action:'key',key:chord},denied);assert.equal(stopped.details.dispatched,false);assert.equal(denied.asked.length,1);assert.match(denied.asked[0]!.explanation!,/clipboard/);
  assert.equal(fake.sent.slice(before).some(call=>call.method.startsWith('Input.')||call.method==='DOM.focus'),false);
  const allowed=ctx();await t.web_act!.execute({action:'key',key:chord},allowed);await t.web_act!.execute({action:'key',key:chord},allowed);assert.equal(allowed.asked.length,2);
 }finally{await browser.close();}
});

test('a revealed password field cannot expose its editor text through child AX nodes',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);fake.send=async(method,params,session)=>method==='Accessibility.getFullAXTree'?{nodes:[
  {nodeId:'root',frameId:'f1',role:{value:'RootWebArea'},childIds:['credential']},
  {nodeId:'credential',role:{value:'textbox'},name:{value:'Credential'},backendDOMNodeId:11,value:{value:'synthetic-secret'},childIds:['editor']},
  {nodeId:'editor',role:{value:'StaticText'},name:{value:'synthetic-secret'},backendDOMNodeId:20}
 ]}:send(method,params,session);
 const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
 try{const page=await t.web_read!.execute({url:'http://localhost/own',full:true},ctx());assert.equal(page.ok,true,page.modelContent);assert.match(page.modelContent,/Credential.*password/);assert.doesNotMatch(page.modelContent,/synthetic-secret/);}
 finally{await browser.close();}
});

for(const shape of ['ignored','generic'] as const)for(const identity of ['DOM password','AX protected'] as const)test(`${shape} password parent hides editor descendants identified by ${identity}`,async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);
 fake.send=async(method,params,session)=>method==='Accessibility.getFullAXTree'?{nodes:[
  {nodeId:'root',frameId:'f1',role:{value:'RootWebArea'},childIds:['credential','ordinary']},
  {nodeId:'credential',ignored:shape==='ignored',role:{value:shape==='generic'?'generic':'textbox'},name:{value:'Credential'},backendDOMNodeId:identity==='DOM password'?11:21,...(identity==='AX protected'?{properties:[{name:'protected',value:{value:true}}]}:{}),childIds:['editor']},
  {nodeId:'editor',role:{value:'StaticText'},name:{value:'own-synthetic-secret'},backendDOMNodeId:20},
  {nodeId:'ordinary',role:{value:'StaticText'},name:{value:'Ordinary page content'},backendDOMNodeId:30}
 ]}:send(method,params,session);
 const browser=new WebBrowser({connect:async()=>fake}),signal=new AbortController().signal;
 try{const shot=await browser.open({url:'http://localhost/own',full:true},signal);assert.doesNotMatch(JSON.stringify([...shot.elements.values()]),/own-synthetic-secret/);assert.doesNotMatch([...shot.lines.values()].join('\n'),/own-synthetic-secret/);assert.match([...shot.lines.values()].join('\n'),/Ordinary page content/);}
 finally{await browser.close();}
});

for(const shape of ['ignored','generic','heading','button','link'] as const)test(`${shape} ordinary Password Manager container still exposes its page text`,async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);
 fake.send=async(method,params,session)=>method==='Accessibility.getFullAXTree'?{nodes:[
  {nodeId:'root',frameId:'f1',role:{value:'RootWebArea'},name:{value:'Password Manager'},childIds:['container']},
  {nodeId:'container',ignored:shape==='ignored',role:{value:shape==='ignored'?'generic':shape},name:{value:'Password Manager'},backendDOMNodeId:21,childIds:['text']},
  {nodeId:'text',role:{value:'StaticText'},name:{value:'Ordinary page content'},backendDOMNodeId:30}
 ]}:send(method,params,session);
 const browser=new WebBrowser({connect:async()=>fake}),signal=new AbortController().signal;
 try{const shot=await browser.open({url:'http://localhost/own',full:true},signal);assert.match([...shot.lines.values()].join('\n'),/Ordinary page content/);}
 finally{await browser.close();}
});


test('same-length ignored replacement cannot confirm a different password',async()=>{
 const fake=new FakeCdp();fake.seedPassword('AAAA');fake.passwordSelection=[0,4];fake.hold=true;
 const t=tools(fake),page=await t.web_read!.execute({url:'https://example.test/login'},ctx());
 const result=await t.web_act!.execute({action:'type',id:idOf(page.modelContent,'textbox','Password'),text:'BBBB'},ctx());
 assert.equal(result.details.outcome,'unconfirmed',result.modelContent);assert.equal(result.details.passwordLength,undefined);assert.doesNotMatch(result.modelContent,/AAAA|BBBB/);
});

test('snapshot-known password remains hidden if the first DOM read already sees type=text',async()=>{
 const fake=new FakeCdp(),send=fake.send.bind(fake);
 fake.send=async(method,params,session)=>{
  const result=await send(method,params,session);
  if(method==='Runtime.callFunctionOn'&&String(params?.functionDeclaration).includes('keyboardReceiver')&&params?.objectId==='obj-11'){const value=(result as {result:{value:Record<string,unknown>}}).result.value;value.password=false;value.value='sensitive-value';}
  return result;
 };
 const t=tools(fake),page=await t.web_read!.execute({url:'https://example.test/login'},ctx());
 const result=await t.web_act!.execute({action:'type',id:idOf(page.modelContent,'textbox','Password'),text:'sensitive-value'},ctx());
 assert.equal(result.details.dispatched,true);assert.doesNotMatch(JSON.stringify(result),/sensitive-value/);
});

for(const shape of ['missing-child','cycle','duplicate-ID'] as const)test(`a malformed full ${shape} reply cannot confirm an existing field disappeared`,async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake);let corrupted=false;
	fake.seed('Still present');
	fake.send=async(method,p,session)=>{
		if(corrupted&&method==='Accessibility.getFullAXTree'){
			const root={nodeId:'1',frameId:'f1',role:{value:'RootWebArea'},childIds:['2']},email={nodeId:'2',parentId:'1',role:{value:'textbox'},name:{value:'Email'},backendDOMNodeId:10};
			return{nodes:shape==='missing-child'?[root]:shape==='cycle'?[root,{...email,childIds:['1']}]:[root,email,{...email,role:{value:'button'},name:{value:'Replacement'}}]};
		}
		const reply=await send(method,p,session);if(method==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased')corrupted=true;return reply;
	};
	const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own',full:true},ctx());assert.equal(first.ok,true,first.modelContent);
		const action=await t.web_act!.execute({action:'click',id:idOf(first.modelContent,'button','Send'),expect:{id:idOf(first.modelContent,'textbox','Email'),property:'exists',value:false}},ctx());
		assert.equal(action.ok,false,action.modelContent);assert.notEqual(action.details.outcome,'confirmed');assert.equal(action.details.dispatched,true);
		const actual=await send('Accessibility.getFullAXTree',{},'s-page-1') as {nodes:{name?:{value:string};value?:{value:string}}[]};assert.equal(actual.nodes.find(node=>node.name?.value==='Email')?.value?.value,'Still present');
	}finally{await browser.close();}
});

test('targeted readback refuses an element adopted into a different document',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake);
	fake.send=async(method,p,session)=>method==='Accessibility.getAXNodeAndAncestors'?{nodes:[
		{nodeId:'2',parentId:'foreign',role:{value:'textbox'},name:{value:'Email'},value:{value:'own-test'},backendDOMNodeId:10},
		{nodeId:'foreign',frameId:'different-document',role:{value:'RootWebArea'},childIds:['2']}
	]}:send(method,p,session);
	const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx());const action=await t.web_act!.execute({action:'type',id:idOf(first.modelContent,'textbox','Email'),text:'own-test'},ctx());
		assert.equal(action.ok,false,action.modelContent);assert.notEqual(action.details.outcome,'confirmed');assert.match(action.modelContent,/another document/);
		assert.equal(fake.sent.some(call=>call.method==='Accessibility.getAXNodeAndAncestors'&&call.params?.frameId!==undefined),false,'the protocol has no frameId argument for this method');
	}finally{await browser.close();}
});

test('whole-page search matches unclipped public labels and values while password descendants remain hidden',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake);const needle='NEEDLE_AFTER_PREFIX',secret='OWN_PASSWORD_ONLY';
	fake.send=async(method,p,session)=>method==='Accessibility.getFullAXTree'?{nodes:[
		{nodeId:'root',frameId:'f1',role:{value:'RootWebArea'},childIds:['button','field','password']},
		{nodeId:'button',role:{value:'button'},name:{value:'A'.repeat(100)+needle},backendDOMNodeId:50},
		{nodeId:'field',role:{value:'textbox'},name:{value:'Own public field'},value:{value:'B'.repeat(180)+needle},backendDOMNodeId:10},
		{nodeId:'password',role:{value:'textbox'},name:{value:'Credential'},value:{value:secret},backendDOMNodeId:11,childIds:['editor']},
		{nodeId:'editor',role:{value:'StaticText'},name:{value:secret},backendDOMNodeId:51}
	]}:send(method,p,session);
	const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{
		const found=await t.web_read!.execute({url:'http://localhost/own',find:needle},ctx());assert.equal(found.ok,true,found.modelContent);assert.equal(found.details.shown,2);assert.equal(found.details.nextCursor,undefined);assert.equal((found.modelContent.match(/\[match:/g)??[]).length,2);assert.match(found.modelContent,new RegExp(needle));
		const hidden=await t.web_read!.execute({tab:found.details.tab,find:secret},ctx());assert.equal(hidden.ok,true,hidden.modelContent);assert.equal(hidden.details.shown,0);assert.doesNotMatch(hidden.modelContent,new RegExp(secret));
	}finally{await browser.close();}
});

for(const initial of [{full:true},{find:'Send'}])test(`a ${initial.full?'full read':'search'} does not make later ordinary actions read the whole page`,async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake),requests:string[]=[];
	fake.send=async(method,p,session)=>{if(method==='Accessibility.getFullAXTree'&&p?.frameId!==undefined||method==='Accessibility.getRootAXNode')requests.push(method);return send(method,p,session);};
	const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own',...initial},ctx());assert.equal(first.ok,true,first.modelContent);assert.deepEqual(requests,['Accessibility.getFullAXTree']);requests.length=0;
		const id=idOf(first.modelContent,'button','Send');for(let i=0;i<2;i++)await t.web_act!.execute({action:'click',id},ctx());assert.deepEqual(requests,['Accessibility.getRootAXNode','Accessibility.getRootAXNode']);
	}finally{await browser.close();}
});

test('partial reads refuse a password editor with conflicting parents before returning any contents',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake),secret='OWN_SYNTHETIC_PROTECTED_EDITOR';
	fake.send=async(method,p,session)=>method==='Accessibility.getFullAXTree'?{nodes:[
		{nodeId:'root',frameId:'f1',role:{value:'RootWebArea'},childIds:['password','editor']},
		{nodeId:'password',parentId:'root',role:{value:'textbox'},name:{value:'Credential'},backendDOMNodeId:11,childIds:['editor'],properties:[{name:'protected',value:{value:true}}]},
		{nodeId:'editor',parentId:'password',role:{value:'StaticText'},name:{value:secret},backendDOMNodeId:50}
	]}:send(method,p,session);
	const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{const read=await t.web_read!.execute({url:'http://localhost/own'},ctx());assert.equal(read.ok,false,read.modelContent);assert.doesNotMatch(JSON.stringify(read),new RegExp(secret));assert.match(read.modelContent,/parent/);}
	finally{await browser.close();}
});

test('typing and expecting the same field performs only one precise ancestor read',async()=>{
	const fake=new FakeCdp(),browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{
		const read=await t.web_read!.execute({url:'http://localhost/own'},ctx()),id=idOf(read.modelContent,'textbox','Email');
		const before=fake.sent.length,action=await t.web_act!.execute({action:'type',id,text:'own',expect:{id,property:'value',value:'own'}},ctx());
		assert.equal(action.details.outcome,'confirmed',action.modelContent);assert.equal(fake.sent.slice(before).filter(call=>call.method==='Accessibility.getAXNodeAndAncestors').length,1);
	}finally{await browser.close();}
});

for(const backend of [99,undefined])test(`a later ancestor reply cannot remove a protected container marker (${backend??'AX identity only'})`,async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake),secret='OWN_SYNTHETIC_SECRET_AFTER_PROTECTED_HEADER';let changed=false;
	const root={nodeId:'root',frameId:'f1',role:{value:'RootWebArea'},childIds:['protected']};
	const parent={nodeId:'protected',parentId:'root',role:{value:'generic'},...(backend===undefined?{}:{backendDOMNodeId:backend}),properties:[{name:'protected',value:{value:true}}],childIds:['email']};
	const email={nodeId:'email',parentId:'protected',role:{value:'textbox'},name:{value:'Email'},value:{value:secret},backendDOMNodeId:10};
	fake.send=async(method,p,session)=>{
		if(changed&&method==='Accessibility.getRootAXNode')return{node:root};
		if(changed&&method==='Accessibility.getChildAXNodes'){assert.equal(p?.id,'root');return{nodes:[parent]};}
		if(changed&&method==='Accessibility.getAXNodeAndAncestors')return{nodes:[email,{...parent,properties:[]},root]};
		const reply=await send(method,p,session);if(method==='Input.dispatchMouseEvent'&&p?.type==='mouseReleased')changed=true;return reply;
	};
	const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx());assert.equal(first.ok,true,first.modelContent);
		const action=await t.web_act!.execute({action:'click',id:idOf(first.modelContent,'button','Send'),expect:{id:idOf(first.modelContent,'textbox','Email'),property:'exists',value:true}},ctx());
		assert.equal(action.details.outcome,'unconfirmed',action.modelContent);assert.doesNotMatch(JSON.stringify(action),new RegExp(secret));
	}finally{await browser.close();}
});

test('a later precise reply cannot replace an observed AX node with a different backend identity',async()=>{
	const fake=new FakeCdp(),send=fake.send.bind(fake);
	fake.send=async(method,p,session)=>{const reply=await send(method,p,session);if(method==='Accessibility.getAXNodeAndAncestors'){
		const tree=reply as {nodes:import('../src/web-ax.ts').AxNode[]};const root=tree.nodes.at(-1)!;root.backendDOMNodeId=999;
	}return reply;};
	const browser=new WebBrowser({connect:async()=>fake}),t=tools(fake,{browser});
	try{
		const first=await t.web_read!.execute({url:'http://localhost/own'},ctx());const action=await t.web_act!.execute({action:'type',id:idOf(first.modelContent,'textbox','Email'),text:'own'},ctx());
		assert.equal(action.ok,false,action.modelContent);assert.notEqual(action.details.outcome,'confirmed');assert.match(action.modelContent,/backend identity changed/);
	}finally{await browser.close();}
});
