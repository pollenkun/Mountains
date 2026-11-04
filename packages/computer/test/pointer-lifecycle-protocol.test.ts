import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POSIX_ONLY } from "./fixtures/platform.ts";
import { InputCoordinator, InputPostconditionError, InputTerminationUnverifiedError } from "../src/coordinator.ts";
import { PhasedPointerActor } from "../src/pointer-lifecycle.ts";
import { MacPointer } from "../src/pointer-mac.ts";

// Real parent protocol, inherited fd3 and owned Node child. The child writes
// business attempts only to its new file; it never touches the desktop.
const worker=String.raw`
const fs=require("node:fs"),net=require("node:net"),control=new net.Socket({fd:3,readable:true,writable:true});
let controls="",input="";const bytes=rows=>rows.map(row=>JSON.stringify(row)+"\n").join("");const send=rows=>control.write(bytes(rows));
control.setEncoding("utf8");control.on("data",chunk=>{controls+=chunk;let nl;while((nl=controls.indexOf("\n"))>=0){
 const c=JSON.parse(controls.slice(0,nl));controls=controls.slice(nl+1);
 if(c.op==="begin_scope"&&process.env.MODE==="control-eof"){control.end();continue;}
 const foreground={unchanged:true,byUser:false,frontChanged:false,focusChanged:false,restored:true,attributionUnknown:false,reason:""};
 const value=c.op==="begin_scope"?{active:true}:c.op==="cancel_local"?{pendingKeys:0,pendingButtons:0,failed:false,complete:true}:{idle:true,resourcesClean:true,foreground};
 if(c.op==="finish_scope"&&process.env.MODE==="by-user")Object.assign(foreground,{unchanged:false,byUser:true,frontChanged:true,focusChanged:true,restored:false});
 if(c.op==="finish_scope"&&process.env.MODE==="late-theft")Object.assign(foreground,{unchanged:false,focusChanged:true,reason:"late file-only focus change"});
 if(c.op==="finish_scope"&&process.env.MODE==="missing-focus")delete value.foreground;
 const row={kind:"pointer-lifecycle",id:c.id,nonce:c.nonce,scope:c.scope,pid:process.pid,ok:true,...value};
 if(c.op==="finish_scope"&&process.env.MODE.startsWith("finish-invalid-")){
  const wrong={"finish-invalid-json":"{bad-json\n","finish-invalid-kind":JSON.stringify({...row,kind:"not-control"})+"\n","finish-invalid-array":"[]\n","finish-invalid-null":"null\n"}[process.env.MODE];control.write(wrong+bytes([row]));continue;
 }
 if((c.op==="begin_scope"&&process.env.MODE==="begin-bad-first")||(c.op==="finish_scope"&&process.env.MODE==="finish-bad-first"))send([{...row,nonce:"wrong"},row]);
 else if(c.op==="finish_scope"&&process.env.MODE==="finish-valid-extra")send([row,{...row,id:row.id+100}]);
 else send([row]);
}});
process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk;let nl;while((nl=input.indexOf("\n"))>=0){const c=JSON.parse(input.slice(0,nl));input=input.slice(nl+1);fs.appendFileSync(process.env.OWN_LOG,JSON.stringify(c)+"\n");process.stdout.write(bytes([{id:c.id,ok:true,inputSent:false,pid:process.pid}]));}});
process.stdin.on("end",()=>process.exit(0));setTimeout(()=>process.exit(8),8000).unref();
`;
async function fixture(mode:string){
	const root=await mkdtemp(join(tmpdir(),"mountains-phased-protocol-")),log=join(root,"commands");await writeFile(log,"");
	const actor=new PhasedPointerActor(process.execPath,["-e",worker],{...process.env,MODE:mode,OWN_LOG:log}),coordinator=new InputCoordinator(join(root,"claim"));
	const send=async()=>{const command=actor.command("ping");return actor.helper.send({op:"ping",lifecycleScope:command.scope},3000,false,undefined,undefined,()=>command.assertValid(),undefined,command.beforeCommand);};
	return {root,actor,coordinator,send,commands:()=>readFile(log,"utf8"),claimed:()=>lstat(join(root,"claim","input.lock")).then(()=>true,error=>{if(error.code!=="ENOENT")throw error;return false;}),async close(){await actor.dispose().catch(()=>{});assert.equal(actor.helper.pid,null);await rm(root,{recursive:true,force:true});}};
}

for(const mode of ["begin-bad-first","finish-bad-first","finish-valid-extra","missing-focus","control-eof","finish-invalid-json","finish-invalid-kind","finish-invalid-array","finish-invalid-null"])test(`an actual owned child cannot release input after a corrupt ${mode} receipt`,{...POSIX_ONLY,timeout:10_000},async()=>{
	const f=await fixture(mode);try{
		let failure:unknown;try{await f.coordinator.run(new AbortController().signal,async()=>{await f.send();return "BUSINESS_COMPLETED";});}catch(error){failure=error;}
		assert.ok(failure instanceof InputTerminationUnverifiedError);assert.equal(await f.claimed(),true);
		const beforeBusiness=mode==="begin-bad-first"||mode==="control-eof";
		assert.equal((await f.commands()).trim().split("\n").filter(Boolean).length,beforeBusiness?0:1);
		if(!beforeBusiness)assert.equal(failure.completedResult,"BUSINESS_COMPLETED");
		await assert.rejects(f.coordinator.run(new AbortController().signal,async()=>f.send()),/earlier input helper termination is unverified/);
	}finally{await f.close();}
});

for(const mode of ["by-user","late-theft"])test(`a final ${mode} observation preserves the result but cannot confirm success`,{...POSIX_ONLY,timeout:10_000},async()=>{
	const f=await fixture(mode);try{
		let failure:unknown;try{await f.coordinator.run(new AbortController().signal,async()=>{await f.send();return {written:"own-file-content"};});}catch(error){failure=error;}
		assert.ok(failure instanceof InputPostconditionError);assert.deepEqual(failure.completedResult,{written:"own-file-content"});assert.equal(await f.claimed(),false);
		assert.match(failure.message,mode==="by-user"?/read its window again/:/late file-only focus change/);
		assert.equal((await f.commands()).trim().split("\n").length,1);
	}finally{await f.close();}
});

test("an old captured command cannot inherit a later lease in the same warm process",{...POSIX_ONLY,timeout:10_000},async()=>{
	const f=await fixture("clean");try{
		let old:ReturnType<PhasedPointerActor["command"]>|undefined;
		await f.coordinator.run(new AbortController().signal,async()=>{await f.send();old=f.actor.command("ping");});
		await f.coordinator.run(new AbortController().signal,async()=>{await f.send();assert.throws(()=>old!.assertValid(),/lease has ended/);});
		assert.equal((await f.commands()).trim().split("\n").length,2);assert.equal(await f.claimed(),false);
	}finally{await f.close();}
});

for(const throughPointer of [false,true])test(`an ended scope cannot dispose the current owned actor (pointer wrapper=${throughPointer})`,{...POSIX_ONLY,timeout:10_000},async()=>{
	const f=await fixture("clean"),pointer=throughPointer?new MacPointer(undefined,{phasedInput:true}):undefined;if(pointer)Reflect.set(pointer,"phased",f.actor);
	let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;});let late:Promise<unknown>|undefined;
	const close=()=>pointer?pointer.close():f.actor.dispose();
	try{
		await f.coordinator.run(new AbortController().signal,async()=>{await f.send();late=gate.then(close).catch(error=>error);});const pid=f.actor.helper.pid;
		await f.coordinator.run(new AbortController().signal,async()=>{await f.send();resume();assert.match(String(await late),/lease has ended/);await f.send();});
		await f.coordinator.run(new AbortController().signal,async()=>{await f.send();});assert.equal(f.actor.helper.pid,pid);assert.equal(await f.claimed(),false);
		if(pointer){assert.equal(Reflect.get(pointer,"closed"),false);assert.equal((await pointer.send({op:"ping"})).pid,pid);}
	}finally{resume();await late;await pointer?.close();await f.close();}
});

for(const throughPointer of [false,true])test(`rejecting disposal in its own lease has no side effects (pointer wrapper=${throughPointer})`,{...POSIX_ONLY,timeout:10_000},async()=>{
	const f=await fixture("clean"),pointer=throughPointer?new MacPointer(undefined,{phasedInput:true}):undefined;if(pointer)Reflect.set(pointer,"phased",f.actor);
	try{
		await f.coordinator.run(new AbortController().signal,async()=>{await f.send();await assert.rejects(pointer?pointer.close():f.actor.dispose(),/cannot await pointer disposal inside/);await f.send();});
		await f.coordinator.run(new AbortController().signal,async()=>{await f.send();});if(pointer)assert.equal(Reflect.get(pointer,"closed"),false);
	}finally{await pointer?.close();await f.close();}
});
