import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCommandTool } from "../src/command.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";
import { FileStateTracker, sha256, Workspace } from "../src/workspace.ts";

const unsupported = process.platform !== "darwin" && process.platform !== "linux";
const evidence = mkdtempSync(join(tmpdir(), "mountains-detached-cleanup-evidence-"));
const source = new URL("../src/command.ts", import.meta.url);
const sourceSha256 = sha256(readFileSync(source));
const reports: Record<string, unknown>[] = [];
after(() => {
	writeFileSync(join(evidence, "report.json"), JSON.stringify({ platform: process.platform, node: process.version, sourceSha256, sourceUnchanged: sha256(readFileSync(source)) === sourceSha256, cases: reports }, null, 2));
	console.log(`Detached descendant evidence: ${join(evidence, "report.json")}`);
});

interface ProcessState {
	pid: number;
	ppid: number;
	pgid: number;
	state: string;
	birth: string;
	command: string;
}

function states(pids?: number[]): Map<number, ProcessState> {
	if (pids&&!pids.length) return new Map();
	const found = new Map<number, ProcessState>();
	const result = spawnSync("/bin/ps", [...(pids?["-p",pids.join(",")]:["-ax"]), "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
		encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 1000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
	});
	assert.ifError(result.error);
	assert.ok(result.status===0||pids!==undefined&&result.status===1,result.stderr);
	for (const line of result.stdout.split("\n")) {
		if (!line.trim()) continue;
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
		assert.ok(match, line);
		const pid = Number(match[1]);
		found.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), state: match[4]!, birth: match[5]!.replace(/\s+/g, " "), command: match[6]! });
	}
	return found;
}

function alive(row: ProcessState | undefined): boolean { return row !== undefined && !row.state.startsWith("Z"); }

async function waitFor(check: () => boolean, message: string): Promise<void> {
	const end = Date.now() + 5000;
	while (Date.now() < end) { if (check()) return; await delay(25); }
	assert.ok(check(), message);
}

function setup(t: TestContext, mode: "normal" | "ignore-all",holdChildPid=false) {
	const root = mkdtempSync(join(tmpdir(), "mountains-detached-cleanup-"));
	const fixture = join(root, "tree.cjs");
	// This is the lawful reviewer fixture: a detached child, its ordinary child,
	// and no filesystem mutation except PID files and a parent-exit barrier.
	writeFileSync(fixture, `
const { spawn } = require("node:child_process");
const { writeFileSync, existsSync, renameSync } = require("node:fs");
const { join } = require("node:path");
const [root, role, mode] = process.argv.slice(2);
if(role === "child" && ${holdChildPid}) {
 process.on("SIGTERM", () => {}); setInterval(() => {}, 20);
} else {
const ready = join(root, role + ".pid"), staging = ready + "." + process.pid + ".tmp";
writeFileSync(staging, String(process.pid), {flag:"wx",mode:0o600});
renameSync(staging, ready);
if (role !== "parent" || mode === "ignore-all") process.on("SIGTERM", () => {});
setInterval(() => { if (role === "parent" && existsSync(join(root, "exit-parent"))) process.exit(0); }, 20);
if (role === "parent") spawn(process.execPath, [__filename, root, "child", mode], { detached: true, stdio: "ignore" });
if (role === "child") spawn(process.execPath, [__filename, root, "grandchild", mode], { stdio: "ignore" });
}
`);
	const controller = new AbortController();
	const ctx: ToolContext = { workspace: new Workspace(root), files: new FileStateTracker(), signal: controller.signal, toolCallId: t.name, approve: async () => "allow" };
	const identities = new Map<number, ProcessState>();
	const roles = ["parent", "child", "grandchild", "unrelated"];
	const scripts=new Set([fixture,realpathSync(fixture)]),executables=new Set([process.execPath,realpathSync(process.execPath)]);
	const owns=(row:ProcessState)=>[...executables].some(exe=>[...scripts].some(file=>roles.some(role=>row.command===[exe,file,root,role,mode].join(" "))));
	const discover=()=>[...states().values()].filter(owns);
	const invalidPidRecords:{role:string;rawBase64:string}[]=[];
	const pids = () => roles.filter(role => existsSync(join(root, `${role}.pid`))).map(role => {
		const raw=readFileSync(join(root,`${role}.pid`),"utf8"),pid=Number(raw);
		if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(pid)||pid<=1||pid===process.pid){invalidPidRecords.push({role,rawBase64:Buffer.from(raw).toString("base64")});throw new Error("invalid complete fixture PID record");}
		return pid;
	});
	const remember = () => {
		const current = states(pids());
		for (const [pid, row] of current) if (!identities.has(pid)) identities.set(pid, row);
		return current;
	};
	let unrelated: ChildProcess | undefined;
	let running: Promise<ToolResult> | undefined;
	const report: Record<string, unknown> = { name: t.name, passed: false, invalidPidRecords };
	reports.push(report);
	t.after(async () => {
		controller.abort();
		const cleanup: number[] = [];
		const errors:{stage:string;error:string}[]=[],candidates=new Set(identities.keys());
		const attempt=async(stage:string,run:()=>unknown)=>{try{await run();}catch(error){errors.push({stage,error:String(error)});}};
		// One unreadable or malformed PID must not skip every other owned child.
		for(const role of roles)await attempt("read "+role,()=>{
			const path=join(root,role+".pid");if(!existsSync(path))return;
			const raw=readFileSync(path,"utf8"),pid=Number(raw);
			if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(pid)||pid<=1||pid===process.pid){
				invalidPidRecords.push({role,rawBase64:Buffer.from(raw).toString("base64")});throw new Error("invalid complete fixture PID record");
			}candidates.add(pid);
		});
		if(unrelated?.pid)candidates.add(unrelated.pid);
		const collect=()=>{for(const row of discover()){candidates.add(row.pid);if(!identities.has(row.pid))identities.set(row.pid,row);}};
		const stopKnown=async()=>{for(const pid of candidates)await attempt("stop "+pid,()=>{
			const current=states([pid]).get(pid);if(!alive(current)||!current||!owns(current))return;
			const prior=identities.get(pid)??current,latest=states([pid]).get(pid);
			if(!alive(latest))return;
			if(prior.birth!==latest?.birth||prior.command!==latest.command||!owns(latest))throw new Error("fixture process identity changed; no signal sent");
			identities.set(pid,prior);try{process.kill(pid,"SIGKILL");cleanup.push(pid);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
		});};
		await attempt("discover before stop",collect);await stopKnown();
		if(running)await attempt("await command",()=>running);
		// A child can exist before publishing its PID. After the actual command
		// exits, keep discovering the exact owned argv until no producer remains.
		const end=Date.now()+5000;
		for(;;){let active:ProcessState[]=[];await attempt("discover after command",()=>{collect();active=discover().filter(alive);});if(!active.length)break;await stopKnown();if(Date.now()>=end){errors.push({stage:"late descendants",error:"owned fixture processes remain"});break;}await delay(10);}
		if(unrelated)await attempt("await direct child",()=>waitFor(()=>unrelated!.exitCode!==null||unrelated!.signalCode!==null,"direct fixture child must close"));
		await attempt("verify exits",()=>waitFor(()=>!discover().some(alive)&&[...states([...candidates]).values()].every(row=>!alive(row)),"all fixture processes must be cleaned up"));
		report.cleanupSignals=cleanup;report.cleanupErrors=errors;
		await attempt("record exits",()=>{report.afterCleanup=[...new Map([...states([...candidates]).values(),...discover()].map(row=>[row.pid,row])).values()];});
		if(errors.length){report.passed=false;report.fixtureRootRetained=root;throw new Error("fixture cleanup failed: "+JSON.stringify(errors));}
		rmSync(root,{recursive:true,force:true});
	});
	return {
		root, controller, ctx, report, remember, discover,
		start(timeoutMs: number) {
			unrelated = spawn(process.execPath, [fixture, root, "unrelated", mode], { detached: true, stdio: "ignore" });
			// This fixture asserts direct PPID/PGID ancestry of the observational fallback.
			running = createCommandTool(undefined, {}, { probeLinuxScope: async () => false }).execute({ argv: [process.execPath, fixture, root, "parent", mode], timeoutMs }, ctx);
			return running;
		},
		async ready() {
			await waitFor(() => { remember(); return roles.every(role => existsSync(join(root, `${role}.pid`))); }, "all four lawful fixture processes must start");
			const before = remember();
			const [parent, child, grandchild, other] = pids();
			assert.equal(before.get(parent!)?.ppid, process.pid);
			assert.equal(before.get(child!)?.ppid, parent);
			assert.equal(before.get(grandchild!)?.ppid, child);
			assert.equal(before.get(parent!)?.pgid, parent);
			assert.equal(before.get(child!)?.pgid, child, "the owned child really has a separate process group");
			assert.equal(before.get(grandchild!)?.pgid, child);
			assert.notEqual(before.get(other!)?.pgid, parent);
			assert.notEqual(before.get(other!)?.pgid, child);
			assert.ok([...before.values()].every(alive));
			report.before = [...before.values()];
			return { owned: [parent!, child!, grandchild!], unrelated: other! };
		},
		async assertStopped(owned: number[], other: number) {
			await waitFor(() => { const current = states(owned); return owned.every(pid => !alive(current.get(pid))); }, "no owned parent, child or grandchild may still execute");
			const after = states([...owned, other]);
			assert.ok(alive(after.get(other)), "the same-name unrelated Node fixture must survive");
			report.after = [...after.values()];
		},
	};
}

test("cancellation cleans captured detached descendants after their parent exits; unrelated same-name process survives", { skip: unsupported, timeout: 15_000 }, async t => {
	const f = setup(t, "normal");
	const signals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = [];
	const originalKill = process.kill;
	t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => { signals.push({ pid, signal }); return originalKill(pid, signal); });
	const running = f.start(10_000);
	const { owned, unrelated } = await f.ready();
	f.controller.abort();
	const result = await running;
	assert.equal(result.ok, false);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.timedOut, false);
	assert.equal(result.details.signal, "SIGTERM");
	await f.assertStopped(owned, unrelated);
	const countAfterClose = signals.length;
	await delay(1250);
	assert.equal(signals.length, countAfterClose, "no scan or delayed SIGKILL may run after command close");
	assert.ok(alive(states([unrelated]).get(unrelated)));
	f.report.signalsBeforeClose = [...signals];
	f.report.noSignalsAfterCloseForMs = 1250;
	f.report.result = result.details;
	f.report.passed = true;
});

test("timeout escalates to SIGKILL for an owned detached tree that ignores SIGTERM", { skip: unsupported, timeout: 15_000 }, async t => {
	const f = setup(t, "ignore-all");
	const running = f.start(1000);
	const { owned, unrelated } = await f.ready();
	const result = await running;
	assert.equal(result.ok, false);
	assert.equal(result.details.timedOut, true);
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.signal, "SIGKILL");
	await f.assertStopped(owned, unrelated);
	f.report.result = result.details;
	f.report.passed = true;
});

test("cancellation of a SIGTERM-resistant tree clears its original timeout instead of postponing escalation", { skip: unsupported, timeout: 15_000 }, async t => {
	const f = setup(t, "ignore-all");
	const running = f.start(1000);
	const { owned, unrelated } = await f.ready();
	await delay(400);
	f.controller.abort();
	const result = await running;
	assert.equal(result.ok, false);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.timedOut, false, "the original timeout must stay cleared during cancellation's SIGTERM grace");
	assert.equal(result.details.signal, "SIGKILL");
	await f.assertStopped(owned, unrelated);
	f.report.result = result.details;
	f.report.passed = true;
});

test("ordinary parent exit cleans previously captured detached descendants without signaling its old process group", { skip: unsupported, timeout: 15_000 }, async t => {
	const f = setup(t, "normal");
	const signals: number[] = [];
	const originalKill = process.kill;
	t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => { signals.push(pid); return originalKill(pid, signal); });
	const running = f.start(10_000);
	const { owned, unrelated } = await f.ready();
	// Keep the parent live across multiple 200ms snapshots before allowing its exit.
	await delay(650);
	writeFileSync(join(f.root, "exit-parent"), "finish normally\n");
	const result = await running;
	assert.equal(result.ok, true, result.modelContent);
	assert.equal(result.details.exitCode, 0);
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.timedOut, false);
	await f.assertStopped(owned, unrelated);
	assert.ok(!signals.includes(-owned[0]!), "a finished parent's unverified old PGID must never be signalled");
	f.report.result = result.details;
	f.report.signalledPids = [...signals];
	f.report.passed = true;
});

test("an invalid complete fixture PID is preserved without skipping known process cleanup",{skip:unsupported,timeout:15_000},async t=>{
	let cleanup!:()=>Promise<void>;
	const f=setup({name:t.name,after:(run:()=>Promise<void>)=>{cleanup=run;}} as TestContext,"normal"),running=f.start(10_000);
	let originals:ProcessState[]=[];
	// Independent safety net for this deliberate teardown fault. Every signal
	// still requires the captured birth and exact owned fixture command.
	t.after(async()=>{
		f.controller.abort();
		for(const prior of originals){const now=states([prior.pid]).get(prior.pid);if(alive(now)&&now?.birth===prior.birth&&now.command===prior.command&&now.command.includes(f.root))try{process.kill(prior.pid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}}
		await running;await waitFor(()=>[...states(originals.map(row=>row.pid)).values()].every(row=>!alive(row)),"fault-injection fixture must not leave processes");
	});
	await f.ready();originals=[...f.remember().values()];
	writeFileSync(join(f.root,"child.pid"),"invalid-complete-record");
	await assert.rejects(cleanup(),/fixture cleanup failed/);
	assert.deepEqual(f.report.cleanupErrors,[{stage:"read child",error:"Error: invalid complete fixture PID record"}]);
	assert.deepEqual(f.report.afterCleanup,[]);
	assert.deepEqual(f.report.invalidPidRecords,[{role:"child",rawBase64:Buffer.from("invalid-complete-record").toString("base64")}]);
	assert.equal(f.report.fixtureRootRetained,f.root);assert.equal(readFileSync(join(f.root,"child.pid"),"utf8"),"invalid-complete-record");
	f.report.expectedCleanupFailure="invalid complete child PID";f.report.passed=true;
});

test("cleanup discovers an already spawned child before it publishes a PID or becomes ready",{skip:unsupported,timeout:15_000},async t=>{
	let cleanup!:()=>Promise<void>;
	const f=setup({name:t.name,after:(run:()=>Promise<void>)=>{cleanup=run;}} as TestContext,"normal",true),running=f.start(10_000);let originals:ProcessState[]=[];
	t.after(async()=>{
		f.controller.abort();
		for(const prior of originals){const now=states([prior.pid]).get(prior.pid);if(alive(now)&&now?.birth===prior.birth&&now.command===prior.command&&now.command.includes(f.root))try{process.kill(prior.pid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}}
		await running;await waitFor(()=>!f.discover().some(alive),"unpublished fixture child must not remain");
	});
	await waitFor(()=>{originals=f.discover();return ["parent","child","unrelated"].every(role=>originals.some(row=>row.command.endsWith(" "+f.root+" "+role+" normal")));},"owned child must exist before its PID publication");
	const child=originals.find(row=>row.command.endsWith(" "+f.root+" child normal"))!;assert.equal(existsSync(join(f.root,"child.pid")),false);
	f.report.before=originals;f.report.taskReadiness=false;await cleanup();
	assert.deepEqual(f.report.cleanupErrors,[]);assert.ok((f.report.afterCleanup as ProcessState[]).every(row=>!alive(row)));
	assert.ok((f.report.cleanupSignals as number[]).includes(child.pid),"cleanup must independently discover and stop the unpublished child");
	assert.equal(f.discover().some(alive),false);f.report.passed=true;
});
