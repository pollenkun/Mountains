import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixtureControllerSocket } from "./fixtures/controller-socket.ts";
import { readWriterProcess, writerState, type WriterProcessIdentity } from "./acceptance/process-identity.ts";

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function close(child:ChildProcess):Promise<{code:number|null;signal:NodeJS.Signals|null}>{return new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});}
async function bounded<T>(promise:Promise<T>,ms=2000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("fixture lifetime deadline exceeded")),ms);})]);}finally{clearTimeout(timer);}}
function verifiedControllerEOF(stderr:string):void{
	assert.doesNotMatch(stderr,/MOUNTAINS_FIXTURE_WATCHDOG_EXIT/,"a watchdog exit is a failed EOF cleanup");
	assert.match(stderr,/MOUNTAINS_FIXTURE_CONTROLLER_EOF/,"missing controller EOF receipt");
}

test("the actual fixture lifetime code exits on its own controller stream, including controller SIGKILL",{skip:process.platform!=="darwin",timeout:30_000},async t=>{
	// Compile and run only the Foundation/Darwin lifetime prefix. No AppKit, AX,
	// application windows, input, accounts, or browser is loaded by these helpers.
	const selection=spawnSync("/usr/bin/xcode-select",["--print-path"],{encoding:"utf8",timeout:3000}),developer=selection.status===0?selection.stdout.trim():"";
	const compiler=[join(developer,"Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"),join(developer,"usr/bin/swiftc")].find(existsSync),sdk=[join(developer,"Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"),join(developer,"SDKs/MacOSX.sdk")].find(existsSync);
	if(!developer||!compiler||!sdk){t.skip("requires an already installed Swift compiler/SDK; no installer started");return;}
	const root=realpathSync(mkdtempSync(join(tmpdir(),"mountains-fixture-lifetime-"))),source=readFileSync(new URL("./fixtures/native-app.swift",import.meta.url),"utf8"),from=source.indexOf("func connectFixtureController("),to=source.indexOf("\nlet output =",from);
	assert.ok(from>0&&to>from);const main=join(root,"main.swift"),binary=join(root,"OwnLifetimeConsole");
	// A failing orphan test must not leave a helper behind or signal a stale PID.
	// This self-exit is deliberately later than the unchanged 2s EOF deadline.
	writeFileSync(main,'import Foundation\nimport Darwin\nDispatchQueue.global().asyncAfter(deadline: .now() + (CommandLine.arguments.contains("--ignore-controller-eof") ? 0.3 : 8)) { FileHandle.standardError.write(Data("MOUNTAINS_FIXTURE_WATCHDOG_EXIT\\n".utf8)); Darwin._exit(124) }\n'+source.slice(from,to)+String.raw`
if CommandLine.arguments.contains("--ignore-controller-eof") {
    fixtureController.readabilityHandler = { _ in }
} else if CommandLine.arguments.count > 4 {
    do {
        let log = try createFixtureEventLog(CommandLine.arguments[4])
        try log.write(contentsOf: Data("OWN EVENT\n".utf8))
        try log.close()
        Darwin.exit(0)
    } catch { Darwin.exit(2) }
}
FileHandle.standardOutput.write(Data("READY\n".utf8))
RunLoop.main.run()
`);
	try{
		const build=spawnSync(compiler,["-sdk",sdk,"-swift-version","6","-warnings-as-errors",main,"-o",binary],{encoding:"utf8",timeout:20_000});assert.equal(build.status,0,build.stderr);
		const probePath=join(root,"ReadProcessIdentity"),native=(name:string)=>fileURLToPath(new URL("./acceptance/native/"+name,import.meta.url));
		const probeBuild=spawnSync(compiler,["-sdk",sdk,"-swift-version","6","-warnings-as-errors","-parse-as-library",native("ProcessIdentity.swift"),native("ReadProcessIdentity.swift"),"-o",probePath],{encoding:"utf8",timeout:20_000});assert.equal(probeBuild.status,0,probeBuild.stderr);
		const probe={path:probePath,sha256:createHash("sha256").update(readFileSync(probePath)).digest("hex")};
		await t.test("a connected control stream outlives stdin EOF, then closes cleanly",async()=>{
			const controller=await fixtureControllerSocket(),child=spawn(binary,["unused","unused",controller.path],{stdio:["ignore","pipe","pipe"]}),closed=close(child);let output="",error="";child.stdout!.on("data",data=>output+=data);child.stderr!.on("data",data=>error+=data);
			try{
				await bounded(controller.connected);for(let n=0;n<100&&!output.includes("READY");n++)await wait(10);assert.match(output,/READY/);
				await wait(70);assert.equal(child.exitCode,null,"stdin /dev/null must not end the socket-owned helper");
				await bounded(controller.close());assert.deepEqual(await bounded(closed),{code:0,signal:null});verifiedControllerEOF(error);assert.equal(existsSync(controller.path),false);
			}finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed;await controller.close().catch(()=>{});}
		});
		await t.test("controller SIGKILL closes the stream and does not leave its Swift child alive",async()=>{
			const module=new URL("./fixtures/controller-socket.ts",import.meta.url).href;
			const program=`import{spawn}from'node:child_process';import{fixtureControllerSocket}from ${JSON.stringify(module)};const c=await fixtureControllerSocket();console.log('CONTROL '+c.path);const child=spawn(process.argv[1],['unused','unused',c.path],{stdio:['ignore',process.stdout,process.stderr]});console.log('CHILD '+child.pid);await c.connected;console.log('CONNECTED');`;
			const parent=spawn(process.execPath,["--input-type=module","-e",program,binary],{stdio:["ignore","pipe","pipe"]}),parentClosed=close(parent);let output="",error="",childPid:number|undefined,controlPath:string|undefined,childBirth:WriterProcessIdentity|undefined;
			const ended=new Promise<void>(resolve=>parent.stdout!.once("end",resolve));parent.stdout!.on("data",data=>{output+=data;childPid=Number(output.match(/CHILD (\d+)/)?.[1])||undefined;controlPath=output.match(/CONTROL (.+)\n/)?.[1];});parent.stderr!.on("data",data=>error+=data);
			try{
				for(let n=0;n<200&&(!output.includes("READY")||!output.includes("CONNECTED"));n++)await wait(10);assert.match(output,/READY/,error);assert.match(output,/CONNECTED/);assert.ok(childPid&&controlPath);
				const observation=await readWriterProcess(probe,childPid);assert.equal(observation.status,"alive");assert.ok(observation.status==="alive");childBirth=observation.identity;
				parent.kill("SIGKILL");assert.equal((await bounded(parentClosed)).signal,"SIGKILL");
				// Swift inherited the stdout pipe. EOF proves it closed its own copy too.
				await bounded(ended);verifiedControllerEOF(error);assert.equal(writerState(childBirth,await readWriterProcess(probe,childPid)),"exited","Swift controller peer must exit after the owner dies");
			}finally{
				if(parent.exitCode===null&&parent.signalCode===null)parent.kill("SIGKILL");
				// No signal is sent to the orphan PID. Even a failed EOF handler has
				// its own watchdog; PID reuse can never select another process here.
				await bounded(parentClosed,10_000);
				if(childBirth)assert.equal(writerState(childBirth,await readWriterProcess(probe,childBirth.pid)),"exited","fixture cleanup could not verify the original helper exited");
				if(controlPath&&/^\/private\/tmp\/mcu-fixture-[^/]+\/controller\.sock$/.test(controlPath))rmSync(dirname(controlPath),{recursive:true,force:true});
			}
		});
		await t.test("a watchdog exit inside the EOF deadline is explicitly rejected",async()=>{
			const controller=await fixtureControllerSocket(),child=spawn(binary,["unused","unused",controller.path,"--ignore-controller-eof"],{stdio:["ignore","pipe","pipe"]}),closed=close(child);let error="";child.stdout!.resume();child.stderr!.on("data",data=>error+=data);
			try{await bounded(controller.connected);await bounded(controller.close());assert.deepEqual(await bounded(closed),{code:124,signal:null});assert.throws(()=>verifiedControllerEOF(error),/watchdog exit is a failed EOF cleanup/);}
			finally{await bounded(closed,10_000);await controller.close();}
		});
		await t.test("a fresh event log records actual bytes and stays private",async()=>{
			const controller=await fixtureControllerSocket(),path=join(root,"new-events.jsonl");
			const child=spawn(binary,["unused","unused",controller.path,path],{stdio:"ignore"});
			try{assert.deepEqual(await bounded(close(child)),{code:0,signal:null});assert.equal(readFileSync(path,"utf8"),"OWN EVENT\n");assert.equal(statSync(path).mode&0o777,0o600);}
			finally{await controller.close();}
		});
		await t.test("preexisting event evidence and symlink targets cannot be overwritten",async()=>{
			const original=join(root,"prior-events.jsonl"),link=join(root,"event-link.jsonl"),bytes="PRIOR EVIDENCE\n";
			writeFileSync(original,bytes);symlinkSync(original,link);
			for(const path of [original,link]){
				const controller=await fixtureControllerSocket(),child=spawn(binary,["unused","unused",controller.path,path],{stdio:"ignore"});
				try{assert.deepEqual(await bounded(close(child)),{code:2,signal:null});assert.equal(readFileSync(original,"utf8"),bytes);}
				finally{await controller.close();}
			}
		});
		await t.test("an absent or oversized endpoint fails without starting any UI",async()=>{
			for(const path of [join(root,"missing.sock"),"/tmp/"+"x".repeat(150)]){const child=spawn(binary,["unused","unused",path],{stdio:"ignore"});const status=await bounded(close(child));assert.notEqual(status.code,0);}
		});
	}finally{rmSync(root,{recursive:true,force:true});}
});
