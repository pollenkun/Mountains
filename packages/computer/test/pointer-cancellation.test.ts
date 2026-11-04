import assert from "node:assert/strict";
import { test } from "node:test";
import { POSIX_ONLY } from "./fixtures/platform.ts";
import { readFileSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { spawn } from "node:child_process";
import { HelperResponseError, JsonHelper } from "../src/helper.ts";
import { InputCoordinator } from "../src/coordinator.ts";
import { MacPointer } from "../src/pointer-mac.ts";
import { foundationFileGesture } from "./fixtures/jxa-file-gesture.ts";
import { mouseProbe } from "./fixtures/jxa-mouse.ts";

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const source=readFileSync(new URL("../src/pointer-mac.ts",import.meta.url),"utf8");

// This is an input-file simulation, not mouse input or proof of native delivery.
for(const mode of ["abort","timeout"])test(`cooperative ${mode} waits for release and never accepts a late success`,POSIX_ONLY,async()=>{
	const root=mkdtempSync(join(tmpdir(),"mountains-cancel-file-")),log=join(root,"events"),directory=join(root,"locks");
	const program=`const fs=require('node:fs'),r=require('node:readline').createInterface({input:process.stdin});let active;const record=s=>fs.appendFileSync(process.argv[1],s+'\\n');r.on('line',s=>{active=JSON.parse(s);record('down');});r.on('close',()=>{record('EOF');setTimeout(()=>{record('up');process.stdout.write(JSON.stringify({id:active.id,ok:true,inputSent:true,inputPointer:{x:31,y:42,button:'left',released:true}})+'\\n');setTimeout(()=>{record('exit');process.exit(0)},40)},80)});`;
	const helper=new JsonHelper(process.execPath,["-e",program,log],process.env,"eof"),stop=new AbortController(),coordinator=new InputCoordinator(directory);
	let result:unknown;
	try{
		const active=coordinator.run(stop.signal,()=>helper.send({op:"own-file-drag"},mode==="timeout"?200:2000)).catch(error=>{result=error;});
		for(let n=0;n<200&&(!existsSync(log)||!readFileSync(log,"utf8").includes("down"));n++)await wait(5);
		assert.ok(existsSync(log));if(mode==="abort")stop.abort(new Error("cancel own file simulation"));
		for(let n=0;n<200&&!readFileSync(log,"utf8").includes("EOF");n++)await wait(5);
		assert.ok(existsSync(join(directory,"input.lock")),"the claim must remain during release");
		await active;
		assert.ok(result instanceof HelperResponseError,String(result));assert.match(result.message,mode==="timeout"?/timed out/:/cancelled/);
		assert.deepEqual(result.reply.inputPointer,{x:31,y:42,button:"left",released:true});
		assert.deepEqual(readFileSync(log,"utf8").trim().split("\n"),["down","EOF","up","exit"]);
		assert.equal(helper.pid,null);assert.equal(existsSync(join(directory,"input.lock")),false);
	}finally{await helper.dispose();rmSync(root,{recursive:true,force:true});}
});

function gestureProtocol(interruptAt:number,interrupt:"eof"|"command"){
	const f=mouseProbe({wait:interrupt==="eof"?"pipe-eof":"reentrant-command",interruptAt});
	assert.throws(()=>f.send("drag"),/own-helper-exit:0/);
	return {records:f.records,events:f.trace};
}

for(const interrupt of ["eof","command"] as const)for(const at of [1,2])test(`the actual JXA gesture releases its last point before ${interrupt} exit at wait ${at}`,POSIX_ONLY,()=>{
	const {records,events}=gestureProtocol(at,interrupt),input=events.filter(e=>["down","drag","up"].includes(e.kind));
	assert.equal(input[0]?.kind,"down");assert.equal(input.at(-1)?.kind,"up");
	const previous=input.at(-2)!;assert.deepEqual(input.at(-1),{kind:"up",x:previous.x,y:previous.y});
	assert.deepEqual(events.slice(-3).map(e=>e.kind),["up","restore","exit"]);
	assert.equal(records.length,2,"a reentrant business command must not execute or reset evidence");assert.equal(records[1]!.ok,false);assert.equal(records[1]!.inputSent,true);
	assert.equal((records[1]!.inputPointer as {released:boolean}).released,true);
});

test("a lost reply pipe marks closing without throwing across input cleanup",POSIX_ONLY,()=>{
	const from=source.indexOf("let helperClosing = false"),to=source.indexOf("const primaryHeight",from);
	const dollar=Object.assign((s:unknown)=>({dataUsingEncoding:()=>s}),{NSUTF8StringEncoding:4});
	const run=runInNewContext(`(()=>{${source.slice(from,to)};return()=>{reply({ok:true});return helperClosing;};})()`,{out:{writeData:()=>{throw new Error("EPIPE");}},$:dollar}) as()=>boolean;
	assert.equal(run(),true);
});

test("the actual launcher keeps Foundation-only cleanup alive after a broken stdout pipe",{...POSIX_ONLY,skip:process.platform!=="darwin",timeout:5000},async()=>{
	const root=mkdtempSync(join(tmpdir(),"mountains-sigpipe-file-")),receipt=join(root,"cleanup"),pointer=new MacPointer();
	// Use the real launch wrapper, replacing only its program. The probe never
	// imports AppKit, AX or input APIs; it writes only its own receipt file.
	const helper=Reflect.get(pointer,"helper") as JsonHelper,args=[...Reflect.get(helper,"args") as string[]],command=Reflect.get(helper,"command") as string;
	const script=String.raw`function run(argv){ObjC.import("Foundation");ObjC.import("stdlib");$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;let caught=false;try{$.NSFileHandle.fileHandleWithStandardOutput.writeData($("x".repeat(1048576)).dataUsingEncoding($.NSUTF8StringEncoding));}catch(e){caught=true;}$.NSFileManager.defaultManager.createFileAtPathContentsAttributes($(argv[0]),$("cleanup:"+caught).dataUsingEncoding($.NSUTF8StringEncoding),$());$.exit(0);}`;
	const program=args.indexOf("-e");assert.ok(program>0);args[program+1]=script;args.push(receipt);
	const child=spawn(command,args,{stdio:["pipe","pipe","pipe"]});let error="";child.stderr.on("data",data=>error+=data);
	const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});
	const timer=setTimeout(()=>child.kill("SIGKILL"),3000);
	try{child.stdout.destroy();child.stdin.end();assert.deepEqual(await closed,{code:0,signal:null},error);assert.equal(readFileSync(receipt,"utf8"),"cleanup:true");}
	finally{clearTimeout(timer);await pointer.close();rmSync(root,{recursive:true,force:true});}
});

test("Foundation actually delivers EOF inside the production gesture run loop before another move",{...POSIX_ONLY,skip:process.platform!=="darwin",timeout:6000},async()=>{
	const root=mkdtempSync(join(tmpdir(),"mountains-eof-file-")),log=join(root,"events");writeFileSync(log,"");
	const {command,args}=await foundationFileGesture(log);
	const helper=new JsonHelper(command,args,process.env,"eof"),stop=new AbortController();let result:unknown;
	try{
		const active=new InputCoordinator().run(stop.signal,()=>helper.send({op:"drag",pid:10,instance:"1",window:100,bounds:{x:0,y:0,width:300,height:300},x:10,y:20,x2:130,y2:140,cursor:false,routeToken:"own-file-route-12345"},2000,true,()=>{})).catch(error=>{result=error;});
		for(let n=0;n<200&&!readFileSync(log,"utf8").includes("down");n++)await wait(5);
		assert.match(readFileSync(log,"utf8"),/down/);stop.abort(new Error("cancel actual Foundation file gesture"));await active;
		assert.ok(result instanceof HelperResponseError,String(result));assert.match(result.message,/cancelled/);
		assert.deepEqual(readFileSync(log,"utf8").trim().split("\n"),["down","controller-eof","up","restore","helper-exit:0"]);
		assert.deepEqual(result.reply.inputPointer,{x:10,y:20,button:"left",released:true});assert.equal(helper.pid,null);
	}finally{await helper.dispose();rmSync(root,{recursive:true,force:true});}
});

for(const phase of ["before-ack","after-down"])test(`killing the actual Node worker ${phase} leaves Foundation alive long enough to release`,{...POSIX_ONLY,skip:process.platform!=="darwin",timeout:8000},async()=>{
	const root=mkdtempSync(join(tmpdir(),"mountains-worker-kill-file-")),log=join(root,"events"),directory=join(root,"locks");writeFileSync(log,"");
	const helperModule=new URL("../src/helper.ts",import.meta.url).href,coordinatorModule=new URL("../src/coordinator.ts",import.meta.url).href,fixtureModule=new URL("./fixtures/jxa-file-gesture.ts",import.meta.url).href;
	const program=`import{JsonHelper}from ${JSON.stringify(helperModule)};import{InputCoordinator}from ${JSON.stringify(coordinatorModule)};import{foundationFileGesture}from ${JSON.stringify(fixtureModule)};const {command,args}=await foundationFileGesture(process.argv[1]);const helper=new JsonHelper(command,args,process.env,'eof');await new InputCoordinator(process.argv[2]).run(new AbortController().signal,()=>helper.send({op:'drag',pid:10,instance:'1',window:100,bounds:{x:0,y:0,width:300,height:300},x:10,y:20,x2:130,y2:140,cursor:false,routeToken:'own-worker-kill-route-123'},5000,true,()=>{console.log('HELPER '+helper.pid);if(process.argv[3]==='before-ack')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);}));await helper.dispose();`;
	const worker=spawn(process.execPath,["--input-type=module","-e",program,log,directory,phase],{stdio:["ignore","pipe","pipe"]});let output="",error="",helperPid:number|undefined;
	worker.stdout.on("data",chunk=>{output+=chunk;helperPid=Number(output.match(/HELPER (\d+)/)?.[1])||undefined;});worker.stderr.on("data",chunk=>error+=chunk);
	const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{worker.once("error",reject);worker.once("close",(code,signal)=>resolve({code,signal}));});
	try{
		for(let n=0;n<400&&(!helperPid||phase==="after-down"&&!readFileSync(log,"utf8").includes("down"));n++)await wait(5);
		assert.ok(helperPid,error);if(phase==="after-down")assert.match(readFileSync(log,"utf8"),/down/);
		worker.kill("SIGKILL");assert.equal((await closed).signal,"SIGKILL");
		for(let n=0;n<700&&!readFileSync(log,"utf8").includes("exit:");n++)await wait(5);
		const events=readFileSync(log,"utf8").trim().split("\n"),eof=events.indexOf("controller-eof");assert.ok(eof>=0,events.join(","));
		assert.ok(!events.some(e=>e.startsWith("watchdog")),"cleanup watchdog is a failure, never an EOF success");
		assert.equal(events.at(-1),"helper-exit:0");
		if(phase==="before-ack")assert.deepEqual(events,["controller-eof","restore","helper-exit:0"]);
		else{assert.equal(events[0],"down");assert.deepEqual(events.slice(eof+1),["up","restore","helper-exit:0"],"no business move may follow controller EOF");assert.equal(events.filter(e=>e==="up").length,1);}
		let absent=false;for(let n=0;n<100;n++){try{process.kill(helperPid,0);}catch(e){if((e as NodeJS.ErrnoException).code==="ESRCH"){absent=true;break;}throw e;}await wait(10);}assert.equal(absent,true,"original helper must be absent, not just have written a final marker");
		// Until crash recovery is implemented, retain this honest known gap.
		assert.equal(existsSync(join(directory,"input.lock")),true,"the killed worker cannot run its lease finally");
	}finally{
		if(worker.exitCode===null&&worker.signalCode===null)worker.kill("SIGKILL");await closed;
		// The Foundation helper's own marked watchdog bounds a failed orphan.
		// No signal is ever addressed to its old PID.
		for(let n=0;n<700&&!readFileSync(log,"utf8").includes("exit:");n++)await wait(5);
		rmSync(root,{recursive:true,force:true});
	}
});
