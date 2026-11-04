import assert from "node:assert/strict";
import { test } from "node:test";
import { POSIX_ONLY } from "./fixtures/platform.ts";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { currentInput, InputCoordinator } from "../src/coordinator.ts";

// Run the actual command-lifetime function with execFile and file-only Node
// children. Do not import/run any AX or desktop command script.
const source=readFileSync(new URL("../src/backend.ts",import.meta.url),"utf8"),from=source.indexOf("async function scopedCommand("),to=source.indexOf("/**",from);
assert.ok(from>0&&to>from);
const scoped=runInNewContext(stripTypeScriptTypes(source.slice(from,to)+";scopedCommand"),{currentInput,execFile,setTimeout,clearTimeout}) as(command:string,args:string[],timeout:number)=>Promise<{stdout:string}>;
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test("an unawaited backend command closes before another input lease starts",POSIX_ONLY,async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-command-lifetime-")),log=join(root,"events"),go=join(root,"go"),coordinator=new InputCoordinator(join(root,"coord"));await writeFile(log,"");let pending:Promise<unknown>|undefined;
	const program=`const fs=require('node:fs');fs.appendFileSync(process.argv[1],'started\\n');setInterval(()=>{if(fs.existsSync(process.argv[2])){fs.appendFileSync(process.argv[1],'OLD LATE EFFECT\\n');process.exit(0)}},3);`;
	try{
		const error=await coordinator.run(new AbortController().signal,async()=>{
			pending=scoped(process.execPath,["-e",program,log,go],2000);void pending.catch(()=>{});
			for(let n=0;n<200&&!(await readFile(log,"utf8")).includes("started");n++)await wait(5);assert.match(await readFile(log,"utf8"),/started/);
		}).then(()=>null,error=>error);
		await coordinator.run(new AbortController().signal,async()=>{await appendFile(log,"new start\n");await writeFile(go,"go");await wait(40);await appendFile(log,"new end\n");});
		assert.match(String(error),/unawaited helper work/);await assert.rejects(pending!,/was stopped because its input lease ended/);assert.equal(await readFile(log,"utf8"),"started\nnew start\nnew end\n");
	}finally{await rm(root,{recursive:true,force:true});}
});

test("an ended lease cannot start a delayed backend command",POSIX_ONLY,async()=>{
	const coordinator=new InputCoordinator();let finish!:()=>void,late:unknown;const done=new Promise<void>(resolve=>{finish=resolve;});
	await coordinator.run(new AbortController().signal,async()=>{setTimeout(()=>{void scoped(process.execPath,["-e","process.exit(87)"],1000).catch(error=>{late=error;}).finally(finish);},20);});
	await coordinator.run(new AbortController().signal,async()=>{await done;});assert.match(String(late),/lease has ended/);
});

test("a delayed desktop close checks its original lease before any local state or helper changes",POSIX_ONLY,async()=>{
	const from=source.indexOf("close() {"),to=source.indexOf("},",from);assert.ok(from>0&&to>from);
	let effects=0;const context={currentInput,Promise,closed:false,closing:undefined,windowQuery:{dispose:()=>{effects++;return Promise.resolve();}},pointer:{assertClosable:()=>{effects++;},close:()=>{effects++;return Promise.resolve();}},capture:undefined};
	const close=runInNewContext(`({${source.slice(from,to+1)}}).close`,context) as()=>Promise<void>;
	let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;}),coordinator=new InputCoordinator();let late:Promise<unknown>|undefined;
	await coordinator.run(new AbortController().signal,async()=>{late=gate.then(close).catch(error=>error);});
	await coordinator.run(new AbortController().signal,async()=>{resume();assert.match(String(await late),/lease has ended/);assert.equal(context.closed,false);assert.equal(effects,0);});
});

for(const cancelAfterTimeout of [false,true])test(`a timed-out backend command escalates even when SIGTERM is ignored (later abort=${cancelAfterTimeout})`,{...POSIX_ONLY,timeout:4000},async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-command-timeout-")),log=join(root,"events"),stop=new AbortController();await writeFile(log,"");
	const program=`const fs=require('node:fs');process.on('SIGTERM',()=>fs.appendFileSync(process.argv[1],'ignored TERM\\n'));fs.appendFileSync(process.argv[1],'started\\n');setInterval(()=>{},1000);`;
	try{
		const started=performance.now(),task=new InputCoordinator().run(stop.signal,()=>scoped(process.execPath,["-e",program,log],300)).catch(error=>error);
		if(cancelAfterTimeout){for(let n=0;n<200&&!(await readFile(log,"utf8")).includes("ignored TERM");n++)await wait(5);assert.match(await readFile(log,"utf8"),/ignored TERM/);stop.abort();}
		assert.match(String(await task),/the helper timed out/);assert.match(await readFile(log,"utf8"),/started\nignored TERM/);
		assert.ok(performance.now()-started<1500,"300ms deadline plus 200ms escalation must close within this 1.5s bound");
	}finally{await rm(root,{recursive:true,force:true});}
});
