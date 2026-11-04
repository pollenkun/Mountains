import assert from "node:assert/strict";
import { test } from "node:test";
import { POSIX_ONLY } from "./fixtures/platform.ts";
import { mkdtemp, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InputCoordinator } from "../src/coordinator.ts";
import { HelperResponseError, JsonHelper } from "../src/helper.ts";
import { mouseProbe } from "./fixtures/jxa-mouse.ts";

const produced = mouseProbe({ wait: "error" }).send("drag");
const program = String.raw`
const fs=require('node:fs'),lines=require('node:readline').createInterface({input:process.stdin});
const root=process.argv[1],reply=JSON.parse(process.argv[2]),cancel=process.argv[3]==='true';let command;
const respond=()=>process.stdout.write(JSON.stringify({...reply,id:command.id})+'\n');
lines.on('line',line=>{const value=JSON.parse(line);
 if(value.op!=='route_ack'){command=value;process.stdout.write(JSON.stringify({id:value.id,kind:'input-route',routeToken:value.routeToken,route:{own:'file-only'}})+'\n');}
 else{fs.writeFileSync(root+'/started','yes');if(!cancel)respond();}
});lines.on('close',()=>{if(cancel)respond();setTimeout(()=>process.exit(0),10);});setInterval(()=>{},1000);
`;

async function check(reply: Record<string, unknown>, accepted: boolean, cancel = false, op = "drag") {
	const root = await mkdtemp(join(tmpdir(), "mountains-mouse-cleanup-record-")), directory = join(root, "coord"), stop = new AbortController(), coordinator = new InputCoordinator(directory);
	await writeFile(join(root, "started"), "");
	const helper = new JsonHelper(process.execPath, ["-e", program, root, JSON.stringify(reply), String(cancel)], process.env, "eof");
	const task = coordinator.run(stop.signal, () => helper.send({ op, routeToken: "own-mouse-receipt-route-123" }, 2000, true, () => {})).catch(error => error);
	try {
		if (cancel) {
			for (let index = 0; index < 200 && await readFile(join(root, "started"), "utf8") !== "yes"; index++) await new Promise(resolve => setTimeout(resolve, 5));
			assert.equal(await readFile(join(root, "started"), "utf8"), "yes"); stop.abort(new Error("cancel own receipt transport"));
		}
		const result = await task;
		if (accepted) {
			if (reply.ok === true && !cancel) assert.equal(result.ok, true);
			else { assert.ok(result instanceof HelperResponseError, String(result)); assert.match(result.message, cancel ? /cancelled/ : /RunLoop failure/); }
			await assert.rejects(lstat(join(directory, "input.lock")), { code: "ENOENT" });
			let next = false; await coordinator.run(new AbortController().signal, async () => { next = true; }); assert.equal(next, true);
		} else {
			assert.match(String(result), /termination could not be verified/); assert.equal(helper.pid, null);
			assert.ok((await lstat(join(directory, "input.lock"))).isDirectory());
			let next = false; await assert.rejects(coordinator.run(new AbortController().signal, async () => { next = true; }), /earlier input helper termination is unverified/); assert.equal(next, false);
		}
	} finally { stop.abort(); await task; await helper.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); }
}

for (const cancel of [false, true]) test(`complete production mouse cleanup keeps a failed or cancelled action failed without trapping a clean claim (${cancel})`, POSIX_ONLY, async () => { await check(produced, true, cancel); });

test("a successful click also requires its own complete mouse receipt", POSIX_ONLY, async () => {
	const reply = mouseProbe().send("click"); await check(reply, true, false, "click");
	await check({ ...reply, inputMouseCleanup: undefined }, false, false, "click");
});

test("a zero-down success or omitted dispatch flag cannot bypass the mouse proof requirement", POSIX_ONLY, async()=>{
	const base=produced.inputMouseCleanup as Record<string,unknown>;
	for(const op of ["click","drag"]){
		await check({...produced,ok:true,inputSent:false,inputMouseCleanup:{...base,registeredDowns:0}},false,false,op);
		await check({...produced,ok:true,inputSent:undefined,inputMouseCleanup:undefined},false,false,op);
		await check({...produced,ok:false,inputSent:undefined,inputMouseCleanup:undefined},false,false,op);
	}
});

test("missing, malformed, unbound or dirty mouse receipts cannot free a claim despite released=true", POSIX_ONLY, async () => {
	const base = produced.inputMouseCleanup as Record<string, unknown>;
	for (const receipt of [undefined, null, {}, { ...base, schema: "other" }, { ...base, commandId: 2 }, { ...base, registeredDowns: 0 }, { ...base, registeredDowns: -1 }, { ...base, registeredDowns: "1" }, { ...base, pendingButtons: 1 }, { ...base, pendingButtons: null }, { ...base, failed: true }, { ...base, complete: false }]) {
		await check({ ...produced, inputMouseCleanup: receipt }, false);
	}
});

test("a clean mouse receipt cannot certify a missing or unverified last point", POSIX_ONLY, async () => {
	for (const pointer of [null, undefined, { x: 10, y: 20, button: "left", released: true, positionVerified: false }, { x: 10, y: 20, button: "left", released: true, positionVerified: "unknown" }, { x: "10", y: 20, button: "left", released: true }]) {
		await check({ ...produced, inputPointer: pointer }, false);
	}
});

test("a later read cannot wash away a still-held mouse ledger", POSIX_ONLY, async () => {
	const reply = mouseProbe({ failUp: true }).send("drag");
	await check({ ...reply, ok: true, inputSent: false, inputPointer: null }, false, false, "ping");
});
