import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ComponentInputClaims, type ClaimState, type ClaimStorageBinding, type ClaimRestoreObligation } from "../src/input-claim-mac.ts";
import { HelperResponseError, JsonHelper } from "../src/helper.ts";

const mac = { skip: process.platform !== "darwin", timeout: 30_000 };
const clean = { schema: "input-claim-cleanup-v2", pendingKeys: 0, pendingButtons: 0, failed: false, complete: true };
const address = (state:ClaimState) => ({schema:'mac-input-address-v1' as const,kind:'process' as const,operation:'file_probe',owner:{process:state.lease!.owner,window:100,bounds:{x:0,y:0,width:100,height:100}},target:{process:state.lease!.owner,window:100,bounds:{x:0,y:0,width:100,height:100}}});
const terminal = (state: ClaimState) => state.lease!.commands[0]!;
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "mountains-claim-component-"));
	await chmod(directory, 0o700);
	const started = performance.now();
	const client = new ComponentInputClaims(directory);
	const state = await client.initialize();
	const startupMs = performance.now() - started;
	const workers: ReturnType<typeof worker>[] = [];
	return { directory, client, state, startupMs, workers, async close() {
		await Promise.allSettled(workers.map(value => value.stop()));
		await client.close(); await rm(directory, { recursive: true, force: true });
	} };
}
async function acquire(client: ComponentInputClaims, state: ClaimState) {
	return client.call({ op: "acquire", revision: state.revision, leaseId: randomUUID() });
}
async function staged(client: ComponentInputClaims, state: ClaimState, pid = process.pid) {
	state = await client.call({ op: "register", senderKind:"file_only", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch, senderId: randomUUID(), senderPid: pid });
	return client.call({ op: "stage", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch, senderId: state.lease!.senders[0]!.id, commandId: randomUUID(), token: randomUUID(), route: randomUUID(), address: address(state) });
}
function ticket(state: ClaimState, command = terminal(state)) {
	return { leaseId: state.lease!.id, epoch: state.lease!.epoch, commandId: command.id, token: command.token, route: command.route, address: command.address, openObligations: [] };
}

const leaseFields=(state:ClaimState)=>({leaseId:state.lease!.id,epoch:state.lease!.epoch});
const restorationClean={schema:"input-claim-restoration-v1",complete:true,failed:false};
function obligation(state:ClaimState,kind:"clipboard"|"focus"):ClaimRestoreObligation{
	if(kind==="clipboard")return {id:randomUUID(),kind,address:{schema:"mac-input-address-v1",kind:"clipboard",operation:"clip_restore",clipboard:"general"}};
 return {id:randomUUID(),kind,address:{schema:"mac-input-address-v1",kind:"process",operation:"focus_restore",owner:{process:state.lease!.owner},target:{process:state.lease!.owner}},focusBaseline:{schema:"input-claim-focus-baseline-v1",scopeId:state.lease!.id,resource:"frontmost_application",reference:randomUUID(),keyboardAtCapture:"absent"}};
}
async function beginOwnCommand(client:ComponentInputClaims,state:ClaimState,opened:ClaimRestoreObligation[]=[]){
	const bound={...ticket(state,state.lease!.commands.at(-1)!),openObligations:opened};
	state=await client.call({op:"permit",revision:state.revision,...bound});
	return {bound,state:await client.call({op:"begin",...bound})};
}
async function stageNext(client:ComponentInputClaims,state:ClaimState){
	return client.call({op:"stage",revision:state.revision,...leaseFields(state),senderId:state.lease!.senders[0]!.id,commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address:address(state)});
}
async function finish(client: ComponentInputClaims, state: ClaimState) {
	state = await client.call({ op: "seal", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch });
	const focus=state.lease!.restorations.filter(r=>r.obligation.kind==="focus");
 if(focus.length&&!state.lease!.focusFinalization){
  const first=focus[0]!.obligation;assert.equal(first.kind,"focus");assert.equal(first.address.kind,"process");
  state=await client.call({op:"resolveFocus",...leaseFields(state),senderId:focus[0]!.senderId,focusFinalization:{observation:{schema:"input-claim-focus-observation-v1",id:randomUUID(),scopeId:first.focusBaseline.scopeId,front:{process:first.address.target.process,reference:first.focusBaseline.reference},keyboard:{status:"absent",destination:null}},resolutions:focus.map(record=>({restorationId:record.obligation.id,address:record.obligation.address,action:"no_write",reason:"already_at_original"}))}});
  assert.equal(state.lease!.tainted,false);
 }
 if (state.lease!.senders.length) state = await client.call({ op: "retire", leaseId: state.lease!.id, epoch: state.lease!.epoch, senderId: state.lease!.senders[0]!.id });
	return client.call({ op: "release", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch });
}
function worker() {
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/claim-worker.ts", import.meta.url))], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let sequence = 0;
	const pending = new Map<number, { resolve: (value: ClaimState) => void; reject: (error: Error) => void }>();
	child.stderr!.resume();
	child.on("message", (value: { id: number; result: ClaimState; error?: string }) => {
		const waiter = pending.get(value.id); if (!waiter) return;
		pending.delete(value.id); if (value.error) waiter.reject(new Error(value.error)); else waiter.resolve(value.result);
	});
	const closed = once(child, "close");
	child.on("close", () => { for (const waiter of pending.values()) waiter.reject(new Error("claim worker exited")); pending.clear(); });
	const send = (message: Record<string, unknown>) => new Promise<ClaimState>((resolve, reject) => {
		const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ ...message, id });
	});
	return { child, send, call: (command: Record<string, unknown>) => send({ op: "call", command }),
		connect: (directory: string, binding: ClaimStorageBinding) => send({ op: "connect", directory, binding }),
		async kill() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; },
		async stop() {
			try { if (child.exitCode === null && child.signalCode === null) await send({ op: "close" }); }
			finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; }
		} };
}

test("component claim consumes each permit once and retires warm sender capabilities", mac, async t => {
	const f = await fixture();
	t.diagnostic(JSON.stringify({ componentOnly: true, phase: "fresh-client-and-native-process-initialize", startupMs: f.startupMs, cacheState: "OS cache is not reset", notAToolPerformanceResult: true }));
	try {
		let state = await staged(f.client, await acquire(f.client, f.state));
		const bound = ticket(state);
		state = await f.client.call({ op: "permit", revision: state.revision, ...bound });
		const duplicate = await f.client.call({ op: "permit", revision: state.revision, ...bound });
		assert.equal(duplicate.revision, state.revision);
		state = await f.client.call({ op: "begin", ...bound });
		await assert.rejects(f.client.call({ op: "begin", ...bound }), /already consumed/);
		state = await f.client.call({ op: "receipt", ...bound, receipt: clean });
		assert.equal(terminal(state).phase, "clean");
		assert.equal((await f.client.call({ op: "receipt", ...bound, receipt: clean })).revision, state.revision);
		state = await finish(f.client, state);
		assert.equal(state.lease, undefined);
		state = await acquire(f.client, state);
		await assert.rejects(f.client.call({ op: "receipt", ...bound, receipt: clean }), /stale/);
		await assert.rejects(f.client.call({ op: "release", revision: state.revision, leaseId: bound.leaseId, epoch: bound.epoch }), /stale/);
		assert.equal((await f.client.call({ op: "inspect" })).lease!.id, state.lease!.id);
	} finally { await f.close(); }
});

test("sealing retires a permit before the sender begins; a late permit cannot reopen it", mac, async () => {
	const f = await fixture();
	try {
		let state = await staged(f.client, await acquire(f.client, f.state)); const bound = ticket(state);
		state = await f.client.call({ op: "permit", revision: state.revision, ...bound });
		state = await f.client.call({ op: "seal", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch });
		assert.equal(terminal(state).phase, "notStarted");
		await assert.rejects(f.client.call({ op: "begin", ...bound }), /cannot begin/);
		await assert.rejects(f.client.call({ op: "permit", revision: state.revision, ...bound }), /cannot be permitted/);
		state = await f.client.call({ op: "receipt", ...bound, receipt: clean });
		state = await finish(f.client, state); assert.equal(state.lease, undefined);
	} finally { await f.close(); }
});

test("malformed, missing, pending or failed cleanup is sticky even after a late clean receipt", mac, async t => {
	for (const [name, receipt] of Object.entries({ missing: undefined, malformed: { complete: true }, pendingKey: { ...clean, pendingKeys: 1 }, pendingButton: { ...clean, pendingButtons: 1 }, failed: { ...clean, failed: true }, incomplete: { ...clean, complete: false } })) {
		await t.test(name, async () => {
			const f = await fixture();
			try {
				let state = await staged(f.client, await acquire(f.client, f.state)); const bound = ticket(state);
				state = await f.client.call({ op: "permit", revision: state.revision, ...bound });
				state = await f.client.call({ op: "begin", ...bound });
				state = await f.client.call({ op: "receipt", ...bound, receipt });
				assert.equal(terminal(state).phase, "unknown"); assert.equal(state.lease!.tainted, true);
				await assert.rejects(f.client.call({ op: "receipt", ...bound, receipt: clean }), /cannot be overwritten/);
				await assert.rejects(f.client.call({ op: "release", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch }), /cleanup remains unknown/);
			} finally { await f.close(); }
		});
	}
});

test("sender receipts use the immutable command binding, not an obsolete global revision", mac, async () => {
	const f = await fixture();
	try {
		let state = await staged(f.client, await acquire(f.client, f.state)); const bound = ticket(state), oldRevision = state.revision;
		state = await f.client.call({ op: "permit", revision: state.revision, ...bound });
		state = await f.client.call({ op: "begin", ...bound });
		state = await f.client.call({ op: "stage", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch, senderId: state.lease!.senders[0]!.id, commandId: randomUUID(), token: randomUUID(), route: randomUUID(), address: address(state) });
		state = await f.client.call({ op: "receipt", revision: oldRevision, ...bound, receipt: clean });
		assert.equal(terminal(state).phase, "clean"); await finish(f.client, state);
	} finally { await f.close(); }
});

test("the CLI checks its real parent birth, ignoring caller-supplied PID impersonation", mac, async () => {
	const f = await fixture(), outsider = worker(); f.workers.push(outsider);
	try {
		let state = await staged(f.client, await acquire(f.client, f.state)); const bound = ticket(state);
		state = await f.client.call({ op: "permit", revision: state.revision, ...bound });
		await outsider.connect(f.directory, state.binding);
		await assert.rejects(outsider.call({ op: "begin", ...bound, senderPid: process.pid }), /actual caller/);
		await assert.rejects(outsider.call({ op: "seal", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision }), /actual caller/);
		await assert.rejects(f.client.call({ op: "release", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: (BigInt(state.revision) - 1n).toString() }), /revision/);
		await finish(f.client, state);
	} finally { await f.close(); }
});

test("an owner crash can recover a cleanly sealed claim without deleting its guard", mac, async () => {
	const f = await fixture(), owner = worker(); f.workers.push(owner);
	try {
		await owner.connect(f.directory, f.state.binding);
		let state = await owner.call({ op: "acquire", leaseId: randomUUID(), revision: f.state.revision });
		const guardBefore = await readFile(join(f.directory, "input-claim.guard"));
		await owner.kill();
		state = await f.client.call({ op: "recoverSeal", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision });
		state = await f.client.call({ op: "recover", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision });
		assert.equal(state.lease, undefined); assert.deepEqual(await readFile(join(f.directory, "input-claim.guard")), guardBefore);
	} finally { await f.close(); }
});

test("crash recovery waits for every old sender, even when its permit was never consumed", mac, async () => {
	const f = await fixture(), owner = worker(), sender = worker(); f.workers.push(owner, sender);
	try {
		await owner.connect(f.directory, f.state.binding); await sender.connect(f.directory, f.state.binding);
		let state = await owner.call({ op: "acquire", leaseId: randomUUID(), revision: f.state.revision });
		state = await owner.call({ op: "register", senderKind:"file_only", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision, senderId: randomUUID(), senderPid: sender.child.pid });
		await owner.kill();
		state = await f.client.call({ op: "recoverSeal", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision });
		await assert.rejects(f.client.call({ op: "recover", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision }), /old sender is still alive/);
		await sender.kill();
		state = await f.client.call({ op: "recover", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision }); assert.equal(state.lease, undefined);
	} finally { await f.close(); }
});

test("both processes ending cannot erase an executing command without a final receipt", mac, async () => {
	const f = await fixture(), owner = worker(), sender = worker(); f.workers.push(owner, sender);
	try {
		await owner.connect(f.directory, f.state.binding); await sender.connect(f.directory, f.state.binding);
		let state = await owner.call({ op: "acquire", leaseId: randomUUID(), revision: f.state.revision });
		state = await owner.call({ op: "register", senderKind:"file_only", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision, senderId: randomUUID(), senderPid: sender.child.pid });
		state = await owner.call({ op: "stage", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision, senderId: state.lease!.senders[0]!.id, commandId: randomUUID(), token: randomUUID(), route: randomUUID(), address: address(state) });
		const bound = ticket(state);
		state = await owner.call({ op: "permit", revision: state.revision, ...bound });
		state = await sender.call({ op: "begin", ...bound });
		await Promise.all([owner.kill(), sender.kill()]);
		state = await f.client.call({ op: "recoverSeal", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision });
		await assert.rejects(f.client.call({ op: "recover", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision }), /cleanup remains unknown/);
		assert.equal((await f.client.call({ op: "inspect" })).lease!.id, bound.leaseId);
	} finally { await f.close(); }
});

test("a sender can persist its finally receipt after owner death but recovery still waits for sender exit", mac, async () => {
	const f = await fixture(), owner = worker(), sender = worker(); f.workers.push(owner, sender);
	try {
		await owner.connect(f.directory, f.state.binding); await sender.connect(f.directory, f.state.binding);
		let state = await owner.call({ op: "acquire", leaseId: randomUUID(), revision: f.state.revision });
		state = await owner.call({ op: "register", senderKind:"file_only", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision, senderId: randomUUID(), senderPid: sender.child.pid });
		state = await owner.call({ op: "stage", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision, senderId: state.lease!.senders[0]!.id, commandId: randomUUID(), token: randomUUID(), route: randomUUID(), address: address(state) });
		const bound = ticket(state);
		state = await owner.call({ op: "permit", revision: state.revision, ...bound });
		state = await sender.call({ op: "begin", ...bound }); await owner.kill();
		state = await f.client.call({ op: "recoverSeal", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision });
		state = await sender.call({ op: "receipt", ...bound, receipt: clean }); assert.equal(terminal(state).phase, "clean");
		await assert.rejects(f.client.call({ op: "recover", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision }), /old sender is still alive/);
		await sender.stop();
		state = await f.client.call({ op: "recover", leaseId: state.lease!.id, epoch: state.lease!.epoch, revision: state.revision }); assert.equal(state.lease, undefined);
	} finally { await f.close(); }
});

test("competing owner processes cannot both acquire the same revision", mac, async () => {
	const f = await fixture(), a = worker(), b = worker(); f.workers.push(a, b);
	try {
		await Promise.all([a.connect(f.directory, f.state.binding), b.connect(f.directory, f.state.binding)]);
		const results = await Promise.allSettled([a, b].map(value => value.call({ op: "acquire", revision: f.state.revision, leaseId: randomUUID() })));
		assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
		assert.equal(results.filter(value => value.status === "rejected").length, 1);
		assert.ok((await f.client.call({ op: "inspect" })).lease);
	} finally { await f.close(); }
});

test("concurrent initializers yield one descriptor and never delete the winner's files", mac, async () => {
	const directory = await mkdtemp(join(tmpdir(), "mountains-claim-init-")); await chmod(directory, 0o700);
	const a = new ComponentInputClaims(directory), b = new ComponentInputClaims(directory);
	try {
		const results = await Promise.allSettled([a.initialize(), b.initialize()]);
		const winners = results.filter(value => value.status === "fulfilled"); assert.equal(winners.length, 1);
		const state = JSON.parse(await readFile(join(directory, "input-claim.state"), "utf8")) as ClaimState;
		assert.deepEqual(state.binding, winners[0]!.value.binding);
		assert.equal(results.filter(value => value.status === "rejected").length, 1);
	} finally { await Promise.all([a.close(), b.close()]); await rm(directory, { recursive: true, force: true }); }
});

test("missing, replaced, linked, corrupt or nonprivate claim storage is never silently reset", mac, async t => {
	const changes: Record<string, (directory: string) => Promise<unknown>> = {
		missingState: directory => rm(join(directory, "input-claim.state")),
		missingGuard: directory => rm(join(directory, "input-claim.guard")),
		bothMissing: async directory => { await rm(join(directory, "input-claim.state")); await rm(join(directory, "input-claim.guard")); },
		corruptState: directory => writeFile(join(directory, "input-claim.state"), "{"),
		guardReplacement: async directory => { const path = join(directory, "input-claim.guard"), data = await readFile(path); await rename(path, path + ".old"); await writeFile(path, data, { mode: 0o600 }); },
		guardSymlink: async directory => { const path = join(directory, "input-claim.guard"); await rename(path, path + ".old"); await symlink(path + ".old", path); },
		stateSymlink: async directory => { const path = join(directory, "input-claim.state"); await rename(path, path + ".old"); await symlink(path + ".old", path); },
		guardHardlink: directory => link(join(directory, "input-claim.guard"), join(directory, "another-guard")),
		stateHardlink: directory => link(join(directory, "input-claim.state"), join(directory, "another-state")),
		guardMode: directory => chmod(join(directory, "input-claim.guard"), 0o644),
		directoryMode: directory => chmod(directory, 0o755),
	};
	for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
		const f = await fixture();
		try {
			const state = await acquire(f.client, f.state); await change(f.directory);
			await assert.rejects(f.client.call({ op: "inspect" }));
			await assert.rejects(f.client.call({ op: "acquire", leaseId: randomUUID(), revision: state.revision }));
			await assert.rejects(f.client.call({ op: "initialize" }), /binding forbids reinitialization/);
		} finally { await chmod(f.directory, 0o700); await f.close(); }
	});
});

test("an open directory handle cannot redirect a claim after its pathname is replaced", mac, async () => {
	const f = await fixture(), old = f.directory + "-old";
	try {
		await acquire(f.client, f.state); await rename(f.directory, old);
		await symlink(old, f.directory);
		await assert.rejects(f.client.call({ op: "inspect" }), /directory was replaced/);
	} finally { await f.close(); await rm(old, { recursive: true, force: true }); }
});

test("caller-owned bindings and returned states cannot redirect a delayed client to a replacement store", mac, async () => {
	const f = await fixture(), old = f.directory + "-old";
	const original = structuredClone(f.state.binding), delayed = new ComponentInputClaims(f.directory, original);
	let replacement: ComponentInputClaims | undefined;
	try {
		await acquire(f.client, f.state); await rename(f.directory, old);
		const { mkdir } = await import("node:fs/promises"); await mkdir(f.directory, { mode: 0o700 });
		replacement = new ComponentInputClaims(f.directory);
		const next = await replacement.initialize();
		Object.assign(original, next.binding); Object.assign(f.state.binding, next.binding);
		await assert.rejects(delayed.call({ op: "inspect" }), /storage identity changed|guard binding changed/);
		await assert.rejects(f.client.call({ op: "inspect" }), /directory was replaced/);
		const returned = await replacement.call({ op: "inspect" }); returned.binding.storageId = randomUUID();
		assert.deepEqual((await replacement.call({ op: "inspect" })).binding, next.binding);
	} finally { await delayed.close(); await replacement?.close(); await f.close(); await rm(old, { recursive: true, force: true }); }
});

test("a conflicting terminal receipt remains recorded as unsafe without replacing the first receipt", mac, async () => {
	const f = await fixture();
	try {
		let state = await staged(f.client, await acquire(f.client, f.state)); const bound = ticket(state);
		state = await f.client.call({ op: "permit", revision: state.revision, ...bound });
		state = await f.client.call({ op: "begin", ...bound });
		state = await f.client.call({ op: "receipt", ...bound, receipt: clean });
		state = await f.client.call({ op: "receipt", ...bound, receipt: { ...clean, pendingKeys: 1 } });
		assert.equal(state.lease!.tainted, true); assert.deepEqual(terminal(state).receipt, clean);
		state = await f.client.call({ op: "receipt", ...bound, receipt: clean }); assert.equal(state.lease!.tainted, true);
		await assert.rejects(f.client.call({ op: "release", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch }), /cleanup remains unknown/);
	} finally { await f.close(); }
});

test("a persisted begin survives a broken reply pipe and cannot be reclassified as never started", mac, async () => {
	const f = await fixture();
	try {
		let state = await staged(f.client, await acquire(f.client, f.state)); const bound = ticket(state);
		state = await f.client.call({ op: "permit", revision: state.revision, ...bound });
		const binary = fileURLToPath(new URL("../native/darwin-universal/input-claim", import.meta.url));
		const child = spawn(binary, ["--component-only", f.directory], { stdio: ["pipe", "pipe", "pipe"] });
		const closed = once(child, "close"); child.stderr.resume(); child.stdin.on("error", () => {});
		child.stdout.destroy();
		child.stdin.end(JSON.stringify({ id: 1, op: "begin", binding: state.binding, ...bound }) + "\n");
		const [code, signal] = await closed; assert.ok(code !== 0 || signal !== null, "the unreceived final reply must not be reported as a successful CLI exit");
		state = await f.client.call({ op: "inspect" }); assert.equal(terminal(state).phase, "executing");
		state = await f.client.call({ op: "seal", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch });
		assert.equal(terminal(state).phase, "executing");
		await assert.rejects(f.client.call({ op: "release", revision: state.revision, leaseId: state.lease!.id, epoch: state.lease!.epoch }), /cleanup remains unknown/);
	} finally { await f.close(); }
});

test("the kernel releases flock after holder death but does not discard persisted input state", mac, async () => {
	const f = await fixture(); let holder: ChildProcess | undefined;
	try {
		const state = await acquire(f.client, f.state);
		holder = spawn("/usr/bin/python3", ["-c", "import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()", join(f.directory, "input-claim.guard")], { stdio: ["pipe", "pipe", "pipe"] });
		await once(holder.stdout!, "data");
		await assert.rejects(f.client.call({ op: "inspect" }), /claim lock busy/);
		const closed = once(holder, "close"); holder.kill("SIGKILL"); await closed;
		const actual = await f.client.call({ op: "inspect" }); assert.equal(actual.lease!.id, state.lease!.id); assert.equal(actual.revision, state.revision);
	} finally { holder?.kill("SIGKILL"); await f.close(); }
});

test("the component needs no PATH commands and reports thirty whole protocol transactions separately from tool speed", mac, async t => {
	const f = await fixture(), samples: number[] = [];
	try {
		let state = f.state;
		for (let index = 0; index < 30; index++) {
			const started = performance.now();
			state = await staged(f.client, await acquire(f.client, state)); const bound = ticket(state);
			state = await f.client.call({ op: "permit", revision: state.revision, ...bound });
			state = await f.client.call({ op: "begin", ...bound });
			state = await f.client.call({ op: "receipt", ...bound, receipt: clean });
			state = await finish(f.client, state); samples.push(performance.now() - started);
		}
		assert.equal(state.revision,'270');
		assert.equal('released' in state,false,'no ever-growing or lifetime-limited retired nonce list');
		await assert.rejects(f.client.call({ op: 'acquire', revision: '0', leaseId: randomUUID() }), /revision changed/);
		const sorted = [...samples].sort((a, b) => a - b);
		t.diagnostic(JSON.stringify({ componentOnly: true, phase: "warm-eight-durable-transitions-and-one-begin", samplesMs: samples, p95Ms: sorted[Math.ceil(samples.length * 0.95) - 1], coldStartupExcluded: "initialize occurs before this specifically warm component benchmark; first suite startup is reported as its own test duration", notAToolPerformanceResult: true }));
		const program = `import {ComponentInputClaims} from ${JSON.stringify(new URL("../src/input-claim-mac.ts", import.meta.url).href)};const c=new ComponentInputClaims(${JSON.stringify(f.directory)},${JSON.stringify(state.binding)});try{const s=await c.call({op:'inspect'});console.log(s.binding.componentOnly);}finally{await c.close();}`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", program], { env: { ...process.env, PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", error = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { error += data; });
		const [code] = await once(child, "close"); assert.equal(code, 0, error); assert.equal(output.trim(), "true");
	} finally { await f.close(); }
});

test("a store passes 4096 completed leases without an ever-growing nonce list and still executes a command",{...mac,timeout:60_000},async t=>{
	const f=await fixture(),nonce=randomUUID();const started=performance.now();
	try{
		let state=f.state;
		for(let index=0;index<4100;index++){
			state=await f.client.call({op:"acquire",revision:state.revision,leaseId:nonce});
			state=await finish(f.client,state);
		}
		assert.equal(state.revision,"12300");assert.equal("released" in state,false);
		state=await staged(f.client,await acquire(f.client,state));const {bound,state:begun}=await beginOwnCommand(f.client,state);state=begun;
		state=await f.client.call({op:"receipt",...bound,receipt:clean});state=await finish(f.client,state);assert.equal(state.lease,undefined);
		t.diagnostic(JSON.stringify({componentOnly:true,completedEmptyLeases:4100,elapsedMs:performance.now()-started,notAToolSpeedResult:true}));
	}finally{await f.close();}
});

test("old epochs cannot affect a new lease even when every UUID and process identity is deliberately reused",mac,async()=>{
	const f=await fixture(),nonce=randomUUID();
	try{
		let state=await staged(f.client,await f.client.call({op:"acquire",revision:f.state.revision,leaseId:nonce}));
		const original=ticket(state),senderId=state.lease!.senders[0]!.id,oldAcquireRevision="0";
		state=await f.client.call({op:"permit",revision:state.revision,...original});state=await f.client.call({op:"begin",...original});state=await f.client.call({op:"receipt",...original,receipt:clean});
		state=await finish(f.client,state);const acquireRevision=state.revision;
		state=await f.client.call({op:"acquire",revision:acquireRevision,leaseId:nonce});
		assert.notEqual(state.lease!.epoch,original.epoch);
		assert.equal((await f.client.call({op:"acquire",revision:acquireRevision,leaseId:nonce})).revision,state.revision,"lost acquire response retries exactly its original transaction");
		await assert.rejects(f.client.call({op:"acquire",revision:oldAcquireRevision,leaseId:nonce}),/busy/);
		state=await f.client.call({op:"register",senderKind:"file_only",revision:state.revision,...leaseFields(state),senderId,senderPid:process.pid});
		state=await f.client.call({op:"stage",revision:state.revision,...leaseFields(state),senderId,commandId:original.commandId,token:original.token,route:original.route,address:original.address});
		for(const op of ["register","stage","permit","begin","receipt","seal","retire","release","recoverSeal","recover"]){
			await assert.rejects(f.client.call({op,revision:state.revision,...original,senderId,senderPid:process.pid,receipt:clean}),/stale or missing lease epoch/);
		}
		const current=ticket(state);state=await f.client.call({op:"permit",revision:state.revision,...current});state=await f.client.call({op:"begin",...current});state=await f.client.call({op:"receipt",...current,receipt:clean});await finish(f.client,state);
	}finally{await f.close();}
});

test("decimal revisions and epochs preserve integers above the JavaScript safe-number range",mac,async()=>{
	const f=await fixture();
	try{
		const huge="9007199254740993",path=join(f.directory,"input-claim.state");
		await writeFile(path,JSON.stringify({...f.state,revision:huge}),{mode:0o600});
		let state=await f.client.call({op:"inspect"});assert.equal(state.revision,huge);
		state=await acquire(f.client,state);assert.equal(state.lease!.epoch,"9007199254740994");assert.equal(state.revision,"9007199254740994");
		for(const value of [Number(state.revision),"09007199254740994","9e15","-1","18446744073709551616"]){
			await assert.rejects(f.client.call({op:"seal",revision:value,...leaseFields(state)}),error=>error instanceof HelperResponseError&&!/timed out/i.test(error.message),"a decode failure must retain this command ID, not turn into a five-second transport timeout");
			assert.equal((await f.client.call({op:"inspect"})).revision,state.revision);
		}
		state=await finish(f.client,state);assert.equal(state.revision,"9007199254740996");
	}finally{await f.close();}
});

test("v1/v2 credentials and on-disk state are refused without rewriting or resetting either file",mac,async()=>{
 const f=await fixture();
 try{
  const guard=join(f.directory,"input-claim.guard"),statePath=join(f.directory,"input-claim.state");
  for(const format of [1,2]){
   const old={...f.state.binding,format};
   await writeFile(guard,JSON.stringify(old),{mode:0o600});await writeFile(statePath,JSON.stringify({binding:old,revision:"0"}),{mode:0o600});
   const before=[await readFile(guard),await readFile(statePath)];
   assert.throws(()=>new ComponentInputClaims(f.directory,old as unknown as ClaimStorageBinding),/no automatic v1\/v2 migration/);
   await assert.rejects(f.client.call({op:"inspect"}),/guard binding changed/);
   const binary=fileURLToPath(new URL("../native/darwin-universal/input-claim",import.meta.url));
   const native=new JsonHelper(binary,["--component-only",f.directory]);
   try{await assert.rejects(native.send({op:"inspect",binding:old}),/invalid storage binding/);}finally{await native.dispose();}
   const unbound=new ComponentInputClaims(f.directory);try{await assert.rejects(unbound.initialize(),/fresh empty/);}finally{await unbound.close();}
   assert.deepEqual([await readFile(guard),await readFile(statePath)],before);
  }
 }finally{await f.close();}
});

test("process, window and remote-target address changes cannot consume an original permit",mac,async()=>{
	const f=await fixture();
	try{
		let state=await staged(f.client,await acquire(f.client,f.state));const bound=ticket(state);state=await f.client.call({op:"permit",revision:state.revision,...bound});
		const original=bound.address;assert.equal(original.kind,"process");
		const changed=[undefined,{...original,operation:"another_action"},{...original,target:{...original.target,window:101}},{...original,target:{...original.target,bounds:{x:1,y:0,width:100,height:100}}},{...original,target:{...original.target,process:{...original.target.process,startMicroseconds:(original.target.process.startMicroseconds+1)%1_000_000}}}];
		for(const address of changed){await assert.rejects(f.client.call({op:"begin",...bound,address}),/original input address changed/);assert.equal(terminal(await f.client.call({op:"inspect"})).phase,"permitted");}
		state=await f.client.call({op:"begin",...bound});state=await f.client.call({op:"receipt",...bound,receipt:clean});await finish(f.client,state);
	}finally{await f.close();}
});

test("a dead or replaced destination process is rejected before a command can begin",mac,async()=>{
	const f=await fixture(),target=worker();f.workers.push(target);
	try{
		await target.connect(f.directory,f.state.binding);let state=await staged(f.client,await acquire(f.client,f.state));const bound=ticket(state);
		// Register the real test worker to obtain its kernel birth; its fake window
		// number here is address metadata, never a claim that a GUI window exists.
		state=await f.client.call({op:"register",senderKind:"file_only",revision:state.revision,...leaseFields(state),senderId:randomUUID(),senderPid:target.child.pid});
		const birth=state.lease!.senders.at(-1)!.birth,remote={...address(state),target:{...address(state).target,process:birth}};
		state=await f.client.call({op:"stage",revision:state.revision,...leaseFields(state),senderId:state.lease!.senders[0]!.id,commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address:remote});
		const remoteTicket=ticket(state,state.lease!.commands.at(-1)!);state=await f.client.call({op:"permit",revision:state.revision,...remoteTicket});await target.kill();
		await assert.rejects(f.client.call({op:"begin",...remoteTicket}),/address process has ended/);
		assert.equal((await f.client.call({op:"inspect"})).lease!.commands.at(-1)!.phase,"permitted");
	}finally{await f.close();}
});

test("an authenticated receipt with a missing or changed address is sticky unknown",mac,async()=>{
	const f=await fixture();
	try{
		let state=await staged(f.client,await acquire(f.client,f.state));const started=await beginOwnCommand(f.client,state);state=started.state;
		state=await f.client.call({op:"receipt",...started.bound,address:undefined,receipt:clean});
		assert.equal(terminal(state).phase,"unknown");assert.equal(state.lease!.tainted,true);
		await assert.rejects(f.client.call({op:"receipt",...started.bound,receipt:clean}),/cannot be overwritten/);
	}finally{await f.close();}
});

for(const kind of ["clipboard","focus"] as const)test(`a clean command cannot retire its sender while ${kind} restoration is still pending`,mac,async()=>{
	const f=await fixture();
	try{
		let state=await staged(f.client,await acquire(f.client,f.state));const restore=obligation(state,kind),started=await beginOwnCommand(f.client,state,[restore]);state=started.state;
		state=await f.client.call({op:"receipt",...started.bound,receipt:clean});
		assert.equal(terminal(state).phase,"clean");assert.equal(state.lease!.restorations[0]!.phase,"pending");
		state=await f.client.call({op:"seal",revision:state.revision,...leaseFields(state)});
		await assert.rejects(f.client.call({op:"retire",...leaseFields(state),senderId:state.lease!.senders[0]!.id}),/pending restorations/);
		await assert.rejects(f.client.call({op:"release",revision:state.revision,...leaseFields(state)}),/restorations are pending/);
		state=await f.client.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address});
		state=await f.client.call({op:"restorationReceipt",...leaseFields(state),restorationId:restore.id,address:restore.address,restorationReceipt:restorationClean});
		state=await finish(f.client,state);assert.equal(state.lease,undefined);
	}finally{await f.close();}
});

test("nested clipboard restoration is permitted only inside out, and each permit is consumed once",mac,async()=>{
	const f=await fixture();
	try{
		let state=await staged(f.client,await acquire(f.client,f.state));const outer=obligation(state,"clipboard"),inner=obligation(state,"clipboard"),first=await beginOwnCommand(f.client,state,[outer]);state=first.state;
		state=await f.client.call({op:"receipt",...first.bound,receipt:clean});state=await stageNext(f.client,state);const second=await beginOwnCommand(f.client,state,[inner]);state=second.state;
		state=await f.client.call({op:"receipt",...second.bound,receipt:clean});
		await assert.rejects(f.client.call({op:"beginRestore",...leaseFields(state),restorationId:outer.id,address:outer.address}),/nested restoration/);
		for(const restore of [inner,outer]){
			state=await f.client.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address});
			await assert.rejects(f.client.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address}),/already consumed/);
			state=await f.client.call({op:"restorationReceipt",...leaseFields(state),restorationId:restore.id,address:restore.address,restorationReceipt:restorationClean});
			assert.equal((await f.client.call({op:"restorationReceipt",...leaseFields(state),restorationId:restore.id,address:restore.address,restorationReceipt:restorationClean})).revision,state.revision);
		}
		await finish(f.client,state);
	}finally{await f.close();}
});

for(const failure of ["missing","failed","wrong-address","without-permit"])test(`a ${failure} restoration receipt cannot later be replaced by success`,mac,async()=>{
	const f=await fixture();
	try{
		let state=await staged(f.client,await acquire(f.client,f.state));const restore=obligation(state,"clipboard"),started=await beginOwnCommand(f.client,state,[restore]);state=started.state;
		state=await f.client.call({op:"receipt",...started.bound,receipt:clean});
		if(failure!=="without-permit")state=await f.client.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address});
		state=await f.client.call({op:"restorationReceipt",...leaseFields(state),restorationId:restore.id,address:failure==="wrong-address"?undefined:restore.address,restorationReceipt:failure==="missing"?undefined:failure==="failed"?{...restorationClean,failed:true}:restorationClean});
		assert.equal(state.lease!.restorations[0]!.phase,"unknown");assert.equal(state.lease!.tainted,true);
		await assert.rejects(f.client.call({op:"restorationReceipt",...leaseFields(state),restorationId:restore.id,address:restore.address,restorationReceipt:restorationClean}),/cannot be overwritten/);
	}finally{await f.close();}
});

test("only the original sender can finish its declared restorations after owner death and sealing",mac,async()=>{
	const f=await fixture(),owner=worker(),sender=worker(),outsider=worker();f.workers.push(owner,sender,outsider);
	try{
		await owner.connect(f.directory,f.state.binding);await sender.connect(f.directory,f.state.binding);await outsider.connect(f.directory,f.state.binding);
		let state=await owner.call({op:"acquire",revision:f.state.revision,leaseId:randomUUID()});
		state=await owner.call({op:"register",senderKind:"file_only",revision:state.revision,...leaseFields(state),senderId:randomUUID(),senderPid:sender.child.pid});
		state=await owner.call({op:"stage",revision:state.revision,...leaseFields(state),senderId:state.lease!.senders[0]!.id,commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address:address(state)});
		const restore=obligation(state,"clipboard"),bound={...ticket(state),openObligations:[restore]};
		state=await owner.call({op:"permit",revision:state.revision,...bound});state=await sender.call({op:"begin",...bound});state=await sender.call({op:"receipt",...bound,receipt:clean});
		await owner.kill();state=await f.client.call({op:"recoverSeal",revision:state.revision,...leaseFields(state)});
		await assert.rejects(f.client.call({op:"recover",revision:state.revision,...leaseFields(state)}),/restorations are pending/);
		await assert.rejects(outsider.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address}),/not original restoration sender/);
		await assert.rejects(sender.call({op:"beginRestore",...leaseFields(state),epoch:"0",restorationId:restore.id,address:restore.address}),/stale or missing lease epoch/);
		state=await sender.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address});
		await assert.rejects(outsider.call({op:"restorationReceipt",...leaseFields(state),restorationId:restore.id,address:restore.address,restorationReceipt:restorationClean}),/not original restoration sender/);
		state=await sender.call({op:"restorationReceipt",...leaseFields(state),restorationId:restore.id,address:restore.address,restorationReceipt:restorationClean});
		await assert.rejects(f.client.call({op:"recover",revision:state.revision,...leaseFields(state)}),/old sender is still alive/);
		await sender.stop();state=await f.client.call({op:"recover",revision:state.revision,...leaseFields(state)});assert.equal(state.lease,undefined);
	}finally{await f.close();}
});

test("a sender disappearing during restoration cannot be treated as successful cleanup",mac,async()=>{
	const f=await fixture(),owner=worker(),sender=worker();f.workers.push(owner,sender);
	try{
		await owner.connect(f.directory,f.state.binding);await sender.connect(f.directory,f.state.binding);
		let state=await owner.call({op:"acquire",revision:f.state.revision,leaseId:randomUUID()});
		state=await owner.call({op:"register",senderKind:"file_only",revision:state.revision,...leaseFields(state),senderId:randomUUID(),senderPid:sender.child.pid});
		state=await owner.call({op:"stage",revision:state.revision,...leaseFields(state),senderId:state.lease!.senders[0]!.id,commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address:address(state)});
		const restore=obligation(state,"clipboard"),bound={...ticket(state),openObligations:[restore]};
		state=await owner.call({op:"permit",revision:state.revision,...bound});state=await sender.call({op:"begin",...bound});state=await sender.call({op:"receipt",...bound,receipt:clean});
		state=await sender.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address});
		await owner.kill();await sender.kill();state=await f.client.call({op:"recoverSeal",revision:state.revision,...leaseFields(state)});
		assert.equal(state.lease!.restorations[0]!.phase,"restoring");await assert.rejects(f.client.call({op:"recover",revision:state.revision,...leaseFields(state)}),/restorations are pending/);
	}finally{await f.close();}
});

test("commands and restorations cannot overlap another input sender",mac,async()=>{
	const f=await fixture(),sender=worker();f.workers.push(sender);
	try{
		await sender.connect(f.directory,f.state.binding);let state=await staged(f.client,await acquire(f.client,f.state));
		const restore=obligation(state,"clipboard"),first=await beginOwnCommand(f.client,state,[restore]);state=first.state;
		state=await f.client.call({op:"register",senderKind:"file_only",revision:state.revision,...leaseFields(state),senderId:randomUUID(),senderPid:sender.child.pid});const otherSender=state.lease!.senders.at(-1)!.id;
		state=await f.client.call({op:"stage",revision:state.revision,...leaseFields(state),senderId:otherSender,commandId:randomUUID(),token:randomUUID(),route:randomUUID(),address:address(state)});
		const next=ticket(state,state.lease!.commands.at(-1)!);state=await f.client.call({op:"permit",revision:state.revision,...next});
		await assert.rejects(sender.call({op:"begin",...next}),/another input command/);
		state=await f.client.call({op:"receipt",...first.bound,receipt:clean});state=await f.client.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address});
		await assert.rejects(sender.call({op:"begin",...next}),/another input command or restoration/);
		state=await f.client.call({op:"restorationReceipt",...leaseFields(state),restorationId:restore.id,address:restore.address,restorationReceipt:restorationClean});
		state=await sender.call({op:"begin",...next});state=await sender.call({op:"receipt",...next,receipt:clean});
		state=await f.client.call({op:"seal",revision:state.revision,...leaseFields(state)});
		state=await sender.call({op:"retire",...leaseFields(state),senderId:otherSender});state=await finish(f.client,state);assert.equal(state.lease,undefined);
	}finally{await f.close();}
});

test("removing a pending restoration from a stored record is detected rather than treated as clean",mac,async()=>{
	const f=await fixture();
	try{
		let state=await staged(f.client,await acquire(f.client,f.state));const started=await beginOwnCommand(f.client,state,[obligation(state,"clipboard")]);state=started.state;
		state=await f.client.call({op:"receipt",...started.bound,receipt:clean});
		const corrupt={...state,lease:{...state.lease!,restorations:[]}};await writeFile(join(f.directory,"input-claim.state"),JSON.stringify(corrupt),{mode:0o600});
		await assert.rejects(f.client.call({op:"inspect"}),/restorations/);
		await assert.rejects(f.client.call({op:"seal",revision:state.revision,...leaseFields(state)}),/restorations/);
	}finally{await f.close();}
});

test("a dead focus-restoration destination cannot consume a permit or be reported as restored",mac,async()=>{
	const f=await fixture(),target=worker();f.workers.push(target);
	try{
		await target.connect(f.directory,f.state.binding);let state=await staged(f.client,await acquire(f.client,f.state));
		state=await f.client.call({op:"register",senderKind:"file_only",revision:state.revision,...leaseFields(state),senderId:randomUUID(),senderPid:target.child.pid});
		const birth=state.lease!.senders.at(-1)!.birth;
		const baseline=obligation(state,"focus");assert.equal(baseline.kind,"focus");
  const restore:ClaimRestoreObligation={...baseline,address:{schema:"mac-input-address-v1",kind:"process",operation:"focus_restore",owner:{process:birth},target:{process:birth}}};
		const started=await beginOwnCommand(f.client,state,[restore]);state=started.state;state=await f.client.call({op:"receipt",...started.bound,receipt:clean});state=await f.client.call({op:"seal",revision:state.revision,...leaseFields(state)});await target.stop();
		await assert.rejects(f.client.call({op:"beginRestore",...leaseFields(state),restorationId:restore.id,address:restore.address}),/address process has ended/);
		const after=await f.client.call({op:"inspect"});assert.equal(after.revision,state.revision);assert.equal(after.lease!.restorations[0]!.phase,"pending");
		state=await f.client.call({op:"seal",revision:after.revision,...leaseFields(after)});
		await assert.rejects(f.client.call({op:"release",revision:state.revision,...leaseFields(state)}),/restorations are pending/);
	}finally{await f.close();}
});
