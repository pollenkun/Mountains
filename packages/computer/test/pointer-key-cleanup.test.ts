import assert from "node:assert/strict";
import { test } from "node:test";
import { keyboardProbe } from "./fixtures/jxa-keyboard.ts";
import { mkdtemp, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonHelper, HelperResponseError } from "../src/helper.ts";
import { InputCoordinator } from "../src/coordinator.ts";
import { foundationFileKeyboard } from "./fixtures/jxa-file-keyboard.ts";

for(const op of ["key","text","type_focus"] as const)for(const wait of ["eof","error"] as const)test(`${op} releases its original key after ${wait}`,()=>{
	const probe=keyboardProbe({wait}),reply=probe.send(op);
	assert.equal(reply.ok,false);assert.deepEqual([...probe.held],[]);
	assert.deepEqual(probe.events.map(event=>[event.target,event.key,event.down]),[[10,0,true],[10,0,false]]);
	assert.deepEqual(reply.inputCleanup,{schema:"mac-keyboard-cleanup-v1",commandId:1,pendingKeys:0,failed:false,complete:true});
	assert.match(String(reply.error),wait==="error"?/RunLoop exception/:/controller closed/);
});

test("a plain key post that applies then throws still releases the same key",()=>{
	const probe=keyboardProbe({postThenThrow:0}),reply=probe.send("key");
	assert.equal(reply.ok,false);assert.match(String(reply.error),/post applied down then threw/);
	assert.deepEqual(probe.events.map(event=>[event.key,event.down]),[[0,true],[0,false]]);assert.deepEqual([...probe.held],[]);
	assert.equal((reply.inputCleanup as {complete:boolean}).complete,true);
});

for(const code of [55,0])test(`PSN post that applies then throws releases its registered key (${code})`,()=>{
	const probe=keyboardProbe({postThenThrow:code}),reply=probe.send("key",["Meta","Shift"]);
	assert.equal(reply.ok,false);assert.match(String(reply.error),/post applied down then threw/);
	assert.deepEqual([...probe.held],[]);assert.equal((reply.inputCleanup as {complete:boolean}).complete,true);
	assert.ok(probe.events.every(event=>event.route==="PSN"&&event.target===10));
	assert.deepEqual(probe.events.filter(event=>event.down).map(event=>event.key).reverse(),probe.events.filter(event=>!event.down).map(event=>event.key));
});

test("PSN cleanup refuses a replacement process and retains all pending keys",()=>{
	const probe=keyboardProbe({wait:"new-birth"}),reply=probe.send("key",["Meta","Shift"]);
	assert.equal(reply.ok,false);assert.match(String(reply.error),/process generation changed/);
	assert.equal(probe.attempts.filter(event=>!event.down).length,0);
	assert.deepEqual([...probe.held],[55,56,0]);
	assert.deepEqual(reply.inputCleanup,{schema:"mac-keyboard-cleanup-v1",commandId:1,pendingKeys:3,failed:true,complete:false});
	assert.equal(probe.checkedBirths.filter(check=>check==="original/replacement").length,3);
});

test("all key releases are attempted and primary and cleanup failures survive",()=>{
	const probe=keyboardProbe({wait:"error",failUps:[0,55]}),reply=probe.send("key",["Meta","Shift"]);
	assert.equal(reply.ok,false);assert.match(String(reply.error),/RunLoop exception/);assert.match(String(reply.error),/up failed for 0/);assert.match(String(reply.error),/up failed for 55/);
	assert.deepEqual(probe.attempts.filter(event=>!event.down).map(event=>event.key),[0,56,55]);
	assert.deepEqual([...probe.held],[55,0]);assert.equal((reply.inputCleanup as {complete:boolean}).complete,false);
	const before=probe.events.length;
	const read=probe.send("ping");assert.equal(read.ok,true);assert.equal((read.inputCleanup as {complete:boolean}).complete,false);
	const later=probe.send("key");assert.equal(later.ok,false);assert.match(String(later.error),/earlier key release remains unverified/);assert.equal(probe.events.length,before);
});

test("a foreground key releases into its original process after the user switches apps",()=>{
	const probe=keyboardProbe({wait:"other-front"}),reply=probe.send("key",[],true);
	assert.equal(reply.ok,true);assert.deepEqual(probe.events.map(event=>[event.route,event.target,event.down]),[["HID",10,true],["PID-cleanup",10,false]]);
	assert.equal((reply.inputCleanup as {complete:boolean}).complete,true);
});

test("validation before posting sends neither a down nor an extra release",()=>{
	const probe=keyboardProbe({rejectBeforePost:true}),reply=probe.send("key");
	assert.equal(reply.ok,false);assert.equal(reply.inputSent,false);assert.match(String(reply.error),/validation refused before down/);
	assert.deepEqual(probe.events,[]);assert.equal((reply.inputCleanup as {complete:boolean}).complete,true);
});

for(const modifier of [false,true])test(`actual Foundation/JXA releases after a file-only down post throws (modifier=${modifier})`,{skip:process.platform!=="darwin",timeout:6000},async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-key-foundation-")),log=join(root,"events"),directory=join(root,"coord");await writeFile(log,"");
	const launch=await foundationFileKeyboard(log),helper=new JsonHelper(launch.command,launch.args,process.env,"eof");
	try{
		const error=await new InputCoordinator(directory).run(new AbortController().signal,()=>helper.send({op:"key",pid:10,instance:"1",window:100,bounds:{x:0,y:0,width:300,height:300},key:"a",held:modifier?["Meta","Shift"]:[],cursor:false,routeToken:"own-foundation-key-route"},2000,true,()=>{})).catch(error=>error);
		assert.ok(error instanceof HelperResponseError,String(error));assert.match(error.message,/down post applied then failed/);
		assert.deepEqual(error.reply.inputCleanup,{schema:"mac-keyboard-cleanup-v1",commandId:1,pendingKeys:0,failed:false,complete:true});
		await assert.rejects(lstat(join(directory,"input.lock")),{code:"ENOENT"});
		await helper.dispose();assert.equal(helper.pid,null);
		const code=modifier?55:0;
		assert.equal(await readFile(log,"utf8"),`down:${code}\nup:${code}\ncontroller-eof\nrestore\nhelper-exit:0\n`);
	}finally{await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
});
