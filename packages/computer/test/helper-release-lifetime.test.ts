import assert from "node:assert/strict";
import { test } from "node:test";
import { POSIX_ONLY } from "./fixtures/platform.ts";
import { mkdtemp, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InputCoordinator } from "../src/coordinator.ts";
import { JsonHelper } from "../src/helper.ts";
import { productionPointerReleaseFailure } from "./fixtures/jxa-failed-release.ts";

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
// These children write private files only. No mouse, keyboard, AX or GUI input.
const program=String.raw`
const fs=require('node:fs'),lines=require('node:readline').createInterface({input:process.stdin});
const root=process.argv[1],mode=process.argv[2],event=s=>fs.appendFileSync(root+'/events',s+'\n');let command;
process.on('SIGTERM',()=>event('ignored TERM'));
lines.on('close',()=>{event('EOF');if(mode==='before-ack')process.exit(0);});
lines.on('line',line=>{const value=JSON.parse(line);
 if(value.op==='gesture'){command=value;process.stdout.write(JSON.stringify({id:value.id,kind:'input-route',routeToken:value.routeToken,route:{target:'private file'}})+'\n');}
 if(value.op==='route_ack'){fs.writeFileSync(root+'/held','true');event('down');if(mode!=='forced')setTimeout(()=>process.exit(Number(mode)),20);}
});setInterval(()=>{},1000);
`;

for(const mode of ["forced","0","7"])test(`an EOF helper without a final release reply cannot free its input claim (${mode})`,{...POSIX_ONLY,timeout:9000},async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-helper-release-")),directory=join(root,"coord"),coordinator=new InputCoordinator(directory),stop=new AbortController();
	await writeFile(join(root,"events"),"");
	const helper=new JsonHelper(process.execPath,["-e",program,root,mode],process.env,"eof");
	let permitted=false,nextRan=false;
	const task=coordinator.run(stop.signal,()=>helper.send({op:"gesture",routeToken:"own-file-release-route"},3000,true,()=>{},()=>{permitted=true;})).catch(error=>error);
	try{
		for(let n=0;n<200&&!(await readFile(join(root,"events"),"utf8")).includes("down");n++)await wait(5);
		assert.equal(permitted,true);assert.equal(await readFile(join(root,"held"),"utf8"),"true");
		if(mode==="forced")stop.abort(new Error("cancel after own file down"));
		const error=await task;
		assert.match(String(error),/input release and cleanup remain unverified/);
		assert.ok((await lstat(join(directory,"input.lock"))).isDirectory());assert.equal(helper.pid,null);
		assert.doesNotMatch(await readFile(join(root,"events"),"utf8"),/^up$/m);
		await assert.rejects(coordinator.run(new AbortController().signal,async()=>{nextRan=true;}),/earlier input helper termination is unverified/);
		await assert.rejects(new InputCoordinator(directory).run(AbortSignal.timeout(60),async()=>{nextRan=true;}),error=>error instanceof Error&&["AbortError","TimeoutError"].includes(error.name));
		await assert.rejects(helper.send({op:"must not restart"}),/input release and cleanup remain unverified/);
		await assert.rejects(helper.dispose(),/input release and cleanup remain unverified/);
		assert.equal(nextRan,false);
	}finally{stop.abort();await task;await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('the held state exists before its ready event even when the actual state write is slow',{...POSIX_ONLY,timeout:5000},async()=>{
	const root=await mkdtemp(join(tmpdir(),'mountains-helper-ready-order-'));await writeFile(join(root,'events'),'');
	// Slow only our own state-file write. The exact fixture program still
	// decides when to publish down; assertions and permission order are unchanged.
	const preface=String.raw`const originalWrite=require('node:fs').writeFileSync;require('node:fs').writeFileSync=function(path,...args){if(String(path).endsWith('/held'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);return originalWrite(path,...args);};`;
	const helper=new JsonHelper(process.execPath,['-e',preface+program,root,'0'],process.env,'eof');
	const task=helper.send({op:'gesture',routeToken:'own-delayed-state-write'},3000,true,()=>{}).catch(error=>error);
	try{
		for(let n=0;n<200&&!(await readFile(join(root,'events'),'utf8')).includes('down');n++)await wait(5);
		assert.match(await readFile(join(root,'events'),'utf8'),/down/);assert.equal(await readFile(join(root,'held'),'utf8'),'true');
		assert.ok(await task instanceof Error);assert.equal(helper.pid,null);
	}finally{await task;await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test("cancellation before route permission sends no input and can finish cleanly",{...POSIX_ONLY,timeout:5000},async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-helper-no-permit-")),directory=join(root,"coord"),coordinator=new InputCoordinator(directory),stop=new AbortController();
	await writeFile(join(root,"events"),"");
	const helper=new JsonHelper(process.execPath,["-e",program,root,"before-ack"],process.env,"eof");let permitted=false;
	try{
		await assert.rejects(coordinator.run(stop.signal,()=>helper.send({op:"gesture",routeToken:"own-file-no-permit-route"},2000,true,()=>{stop.abort(new Error("cancel before permit"));},()=>{permitted=true;})),/cancel before permit/);
		assert.equal(permitted,false);assert.equal(await readFile(join(root,"events"),"utf8"),"EOF\n");assert.equal(helper.pid,null);
		await assert.rejects(lstat(join(directory,"input.lock")),{code:"ENOENT"});
		let nextRan=false;await coordinator.run(new AbortController().signal,async()=>{nextRan=true;});assert.equal(nextRan,true);
	}finally{await helper.dispose();await rm(root,{recursive:true,force:true});}
});

const finalErrorProgram=String.raw`
const fs=require('node:fs'),lines=require('node:readline').createInterface({input:process.stdin});
const root=process.argv[1],mode=process.argv[2],reply=JSON.parse(process.argv[3]);let command;
const event=s=>fs.appendFileSync(root+'/events',s+'\n');
const fail=()=>{event('release failed');process.stdout.write(JSON.stringify({...reply,id:command.id})+'\n');};
lines.on('line',line=>{const value=JSON.parse(line);
 if(value.op!=='route_ack'){command=value;process.stdout.write(JSON.stringify({id:value.id,kind:'input-route',routeToken:value.routeToken,route:{target:'own file'}})+'\n');}
 else{event('down');if(mode!=='cancel')setTimeout(fail,10);}
});
lines.on('close',()=>{event('EOF');if(mode==='cancel')fail();setTimeout(()=>process.exit(0),20);});setInterval(()=>{},1000);
`;

const releaseFailure=productionPointerReleaseFailure();
const finalErrors=[
	{op:"drag",mode:"ordinary",reply:releaseFailure,swallow:false},
	{op:"drag",mode:"cancel",reply:releaseFailure,swallow:false},
	...["key","text","type_focus"].map(op=>({op,mode:"ordinary",reply:{ok:false,error:"injected key or modifier release failed",inputSent:true,inputPointer:null},swallow:false})),
	...["release_key","release_pointer"].map(op=>({op,mode:"ordinary",reply:{ok:false,error:"injected cleanup refused",inputSent:false,inputPointer:null},swallow:true})),
];
for(const entry of finalErrors)test(`a final error cannot clear unknown release (${entry.op}, ${entry.mode}, caught=${entry.swallow})`,{...POSIX_ONLY,timeout:5000},async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-helper-final-release-")),directory=join(root,"coord"),coordinator=new InputCoordinator(directory),stop=new AbortController();
	await writeFile(join(root,"events"),"");
	const helper=new JsonHelper(process.execPath,["-e",finalErrorProgram,root,entry.mode,JSON.stringify(entry.reply)],process.env,"eof");
	const task=coordinator.run(stop.signal,async()=>{
		const pending=helper.send({op:entry.op,routeToken:"own-final-release-error-route"},2000,true,()=>{});
		if(entry.swallow){await pending.catch(()=>{});return 'caller tried to ignore cleanup failure';}
		return pending;
	}).catch(error=>error);
	try{
		for(let n=0;n<200&&!(await readFile(join(root,"events"),"utf8")).includes("down");n++)await wait(5);
		assert.match(await readFile(join(root,"events"),"utf8"),/down/);
		if(entry.mode==="cancel")stop.abort(new Error("cancel before own failed release reply"));
		assert.match(String(await task),/termination could not be verified/);
		assert.ok((await lstat(join(directory,"input.lock"))).isDirectory());assert.equal(helper.pid,null);
		let nextRan=false;await assert.rejects(coordinator.run(new AbortController().signal,async()=>{nextRan=true;}),/earlier input helper termination is unverified/);assert.equal(nextRan,false);
		await assert.rejects(helper.dispose(),/input release and cleanup remain unverified/);
	}finally{stop.abort();await task;await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
});
