import assert from "node:assert/strict";
import { test } from "node:test";
import { mouseProbe } from "./fixtures/jxa-mouse.ts";
import { foundationFileGesture } from "./fixtures/jxa-file-gesture.ts";
import { mkdtemp, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonHelper, HelperResponseError } from "../src/helper.ts";
import { InputCoordinator } from "../src/coordinator.ts";
import { MacPointer } from "../src/pointer-mac.ts";

const clean = (reply: Record<string, unknown>,registeredDowns=1) => assert.deepEqual(reply.inputMouseCleanup, { schema: "mac-mouse-cleanup-v1", commandId: reply.id, registeredDowns,pendingButtons: 0, failed: false, complete: true });

test("invalid click counts fail before any helper starts or synthetic mouse event is posted",async()=>{
	const pointer=new MacPointer();
	try{
		for(const count of [-1,0,1.5,4,Number.NaN,Number.POSITIVE_INFINITY]){
			await assert.rejects(pointer.send({op:"click",pid:10,instance:"1",window:100,bounds:{x:0,y:0,width:300,height:300},x:10,y:20,count,cursor:false}),/click count must be/);assert.equal(pointer.pid,null);
			if(Number.isFinite(count)){const f=mouseProbe(),reply=f.send("click",{count});assert.equal(reply.ok,false);assert.equal(reply.inputSent,false);assert.deepEqual(f.events,[]);clean(reply,0);}
		}
	}finally{await pointer.close();}
});
for (const button of ["left", "right"]) for (const count of [1, 2]) test(`a ${button} click down that applies then throws is released at its original point (click ${count})`, () => {
	const kind = button === "right" ? "rdown" : "down", up = button === "right" ? "rup" : "up";
	const f = mouseProbe({ throwAfter: { kind, occurrence: count } }), reply = f.send("click", { count, button });
	assert.equal(reply.ok, false); assert.match(String(reply.error), /post applied .*down then threw/); clean(reply,count); assert.deepEqual([...f.held], []);
	assert.deepEqual(f.events.map(event => event.kind), Array.from({ length: count }, () => [kind, up]).flat());
	assert.ok(f.events.every(event => event.target === 10 && event.route === "PID" && event.x === 10 && event.y === 20));
});

test("a bridge that throws before applying down still uses the registered fixed point for cleanup", () => {
	const f = mouseProbe({ throwBeforeDown: true }), reply = f.send("click");
	assert.equal(reply.ok, false); clean(reply); assert.deepEqual(f.events.map(event => event.kind), ["up"]); assert.deepEqual([...f.held], []);
});

for(const occurrence of [1,2])test(`validation before click ${occurrence} posts neither an unregistered down nor an extra up`,()=>{
	const f=mouseProbe({rejectDownValidationAt:occurrence}),reply=f.send("click",{count:2});
	assert.equal(reply.ok,false);assert.match(String(reply.error),/validation refused/);clean(reply,occurrence-1);
	assert.deepEqual(f.events.map(event=>event.kind),Array.from({length:occurrence-1},()=>["down","up"]).flat());assert.deepEqual([...f.held],[]);
});

test("an up that applies then throws stays unknown and is not replayed during exit",()=>{
	const f=mouseProbe({throwAfter:{kind:"up",occurrence:1}}),reply=f.send("click");
	assert.equal(reply.ok,false);assert.match(String(reply.error),/post applied up then threw/);assert.equal((reply.inputMouseCleanup as{complete:boolean}).complete,false);
	assert.deepEqual(f.events.map(event=>event.kind),["down","up"]);assert.deepEqual([...f.held],[]);
	assert.throws(f.finish,/own-helper-exit:1/);assert.deepEqual(f.events.map(event=>event.kind),["down","up"]);
});

for (const wait of ["eof", "error"] as const) for (const interruptAt of [1, 2]) test(`background ${wait} releases the last successful drag point at wait ${interruptAt}`, () => {
	const f = mouseProbe({ wait, interruptAt });
	if(wait==="eof")assert.throws(()=>f.send("drag"),/own-helper-exit:0/);
	else f.send("drag");
	const reply=f.records.at(-1)!;assert.equal(reply.ok,false);clean(reply);
	const last = f.events.at(-1)!, previous = f.events.at(-2)!;
	assert.equal(last.kind, "up"); assert.equal(last.x, previous.x); assert.equal(last.y, previous.y); assert.deepEqual([...f.held], []);
	assert.ok(f.events.every(event => event.route === "PID" && event.target === 10));
});

test("a drag post that applies then throws does not guess a drop at the previous point", () => {
	const f = mouseProbe({ throwAfter: { kind: "drag", occurrence: 1 } }), reply = f.send("drag");
	assert.equal(reply.ok, false); assert.match(String(reply.error), /post applied drag then threw/); assert.match(String(reply.error), /no drop position was guessed/);
	assert.deepEqual(f.events.map(event => event.kind), ["down", "drag"]); assert.equal((reply.inputPointer as { positionVerified: boolean }).positionVerified, false);
	assert.deepEqual(reply.inputMouseCleanup, { schema: "mac-mouse-cleanup-v1", commandId: 1, registeredDowns:1,pendingButtons: 1, failed: true, complete: false });
	const before = f.events.length, next = f.send("click"); assert.equal(next.ok, false); assert.match(String(next.error), /earlier mouse release/); assert.equal(f.events.length, before);
	const read = f.send("ping"); assert.equal(read.ok, true); assert.equal((read.inputMouseCleanup as { complete: boolean }).complete, false);
	assert.throws(f.finish, /own-helper-exit:1/);
});

test("a mouse-up failure preserves both the operation error and the cleanup failure", () => {
	const f = mouseProbe({ wait: "error", failUp: true }), reply = f.send("drag");
	assert.equal(reply.ok, false); assert.match(String(reply.error), /RunLoop failure/); assert.match(String(reply.error), /mouse up failed/);
	assert.equal((reply.inputMouseCleanup as { complete: boolean }).complete, false); assert.deepEqual([...f.held], ["10:left"]);
	assert.throws(f.finish, /own-helper-exit:1/);
});

test("a replaced original process receives no cleanup up", () => {
	const f = mouseProbe({ wait: "new-birth" }), reply = f.send("drag");
	assert.equal(reply.ok, false); assert.match(String(reply.error), /generation changed/); assert.deepEqual(f.events.map(event => event.kind), ["down"]);
	assert.equal((reply.inputMouseCleanup as { complete: boolean }).complete, false);
});

for (const wait of ["other-front", "pointer-moved", "buttons-changed", "new-birth","button-repressed"] as const) test(`an authorized real drag never sends global up after ${wait}`, () => {
	const f = mouseProbe({ wait }), reply = f.send("drag", { foregroundAuthorized: true });
	assert.equal(reply.ok, false); assert.equal(f.events.filter(event => event.kind === "up").length, 0);
	assert.equal((reply.inputMouseCleanup as { complete: boolean }).complete, false); assert.throws(f.finish, /own-helper-exit:1/);
});

test("an uninterrupted real drag sends its up only into the original still-current target", () => {
	const f = mouseProbe(), reply = f.send("drag", { foregroundAuthorized: true });
	assert.equal(reply.ok, true); clean(reply); assert.deepEqual([...f.held], []);
	assert.ok(f.events.every(event => event.target === 10 && event.route === "HID")); assert.deepEqual(f.events.at(-1), { kind: "up", x: 130, y: 140, target: 10, route: "HID" });
});

test("a real down that applies then throws can release only at the unchanged original target",()=>{
	const f=mouseProbe({throwAfter:{kind:"down",occurrence:1}}),reply=f.send("drag",{foregroundAuthorized:true});
	assert.equal(reply.ok,false);assert.match(String(reply.error),/post applied down then threw/);clean(reply);assert.deepEqual([...f.held],[]);
	assert.deepEqual(f.events.map(event=>[event.kind,event.x,event.y,event.target,event.route]),[["down",10,20,10,"HID"],["up",10,20,10,"HID"]]);
});

test("preparing a real release cannot hide an intervening switch into the user's other application",()=>{
	const f=mouseProbe({switchDuringUpCreation:true}),reply=f.send("drag",{foregroundAuthorized:true});
	assert.equal(reply.ok,false);assert.equal(f.events.filter(event=>event.kind==="up").length,0);
	assert.equal((reply.inputMouseCleanup as{complete:boolean}).complete,false);assert.throws(f.finish,/own-helper-exit:1/);
});

for(const kind of ["down","drag"] as const)test(`preparing real ${kind} cannot post into an intervening foreground application`,()=>{
	const f=mouseProbe({switchDuringCreation:kind}),reply=f.send("drag",{foregroundAuthorized:true});
	assert.equal(reply.ok,false);assert.ok(f.events.every(event=>event.target===10));
	assert.deepEqual(f.events.map(event=>event.kind),kind==="down"?[]:["down"]);
	if(kind==="down")clean(reply,0);else assert.equal((reply.inputMouseCleanup as{complete:boolean}).complete,false);
});

for(const count of [1,2])test(`actual Foundation/JXA releases after the ${count}th file-only click down applies then throws`,{skip:process.platform!=="darwin",timeout:6000},async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-mouse-foundation-")),log=join(root,"events"),directory=join(root,"coord");await writeFile(log,"");
	const launch=await foundationFileGesture(log,{downThenThrowAt:count}),helper=new JsonHelper(launch.command,launch.args,process.env,"eof");
	try{
		const error=await new InputCoordinator(directory).run(new AbortController().signal,()=>helper.send({op:"click",pid:10,instance:"1",window:100,bounds:{x:0,y:0,width:300,height:300},x:10,y:20,count,cursor:false,routeToken:"own-foundation-mouse-route"},2000,true,()=>{})).catch(error=>error);
		assert.ok(error instanceof HelperResponseError,String(error));assert.match(error.message,/down post applied then failed/);clean(error.reply,count);
		await assert.rejects(lstat(join(directory,"input.lock")),{code:"ENOENT"});await helper.dispose();assert.equal(helper.pid,null);
		assert.equal(await readFile(log,"utf8"),Array.from({length:count},()=>["down","up"]).flat().concat(["controller-eof","restore","helper-exit:0"]).join("\n")+"\n");
	}finally{await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
});

for(const fault of ["move","up"] as const)test(`actual Foundation/JXA retains a claim for an unknown file-only ${fault}`,{skip:process.platform!=="darwin",timeout:6000},async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-mouse-foundation-unknown-")),log=join(root,"events"),directory=join(root,"coord");await writeFile(log,"");
	const launch=await foundationFileGesture(log,fault==="move"?{dragThenThrowAt:1}:{downThenThrowAt:1,failUp:true}),helper=new JsonHelper(launch.command,launch.args,process.env,"eof"),coordinator=new InputCoordinator(directory);
	try{
		await assert.rejects(coordinator.run(new AbortController().signal,()=>helper.send({op:"drag",pid:10,instance:"1",window:100,bounds:{x:0,y:0,width:300,height:300},x:10,y:20,x2:130,y2:140,cursor:false,routeToken:"own-foundation-mouse-route"},2000,true,()=>{})),fault==="move"?/drag post applied then failed.*no drop position was guessed/:/down post applied then failed.*mouse up failed/);
		assert.ok((await lstat(join(directory,"input.lock"))).isDirectory());assert.equal(helper.pid,null);
		let next=false;await assert.rejects(coordinator.run(new AbortController().signal,async()=>{next=true;}),/earlier input helper termination is unverified/);assert.equal(next,false);
		assert.equal(await readFile(log,"utf8"),(fault==="move"?["down","drag"]:["down"]).concat(["controller-eof","restore","helper-exit:1"]).join("\n")+"\n");
	}finally{await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
});
