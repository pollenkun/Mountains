import assert from "node:assert/strict";
import { test } from "node:test";
import { POSIX_ONLY } from "./fixtures/platform.ts";
import { mkdtemp, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InputCoordinator } from "../src/coordinator.ts";
import { HelperResponseError, JsonHelper } from "../src/helper.ts";
import { keyboardProbe } from "./fixtures/jxa-keyboard.ts";

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
// Parent-side validation uses an actual production JXA error/cleanup record.
// The transport child writes files only and never posts keyboard or GUI input.
const produced=keyboardProbe({wait:"error"}).send("key");
const program=String.raw`
const fs=require('node:fs'),lines=require('node:readline').createInterface({input:process.stdin});
const root=process.argv[1],reply=JSON.parse(process.argv[2]),mode=process.argv[3];let command;
const respond=()=>process.stdout.write(JSON.stringify({...reply,id:command.id})+'\n');
lines.on('line',line=>{const value=JSON.parse(line);
 if(value.op!=='route_ack'){command=value;process.stdout.write(JSON.stringify({id:value.id,kind:'input-route',routeToken:value.routeToken,route:{own:'file-only'}})+'\n');}
 else{fs.writeFileSync(root+'/started','yes');if(mode!=='cancel')respond();}
});lines.on('close',()=>{if(mode==='cancel')respond();setTimeout(()=>process.exit(0),10);});setInterval(()=>{},1000);
`;

async function checkReply(reply:Record<string,unknown>,accepted:boolean,cancel=false,op="key"){
	const root=await mkdtemp(join(tmpdir(),"mountains-key-cleanup-record-")),directory=join(root,"coord"),coordinator=new InputCoordinator(directory),stop=new AbortController();
	await writeFile(join(root,"started"),"");
	const helper=new JsonHelper(process.execPath,["-e",program,root,JSON.stringify(reply),cancel?"cancel":"ordinary"],process.env,"eof");
	const task=coordinator.run(stop.signal,()=>helper.send({op,routeToken:"own-key-cleanup-record-route"},2000,true,()=>{})).catch(error=>error);
	try{
		if(cancel){for(let n=0;n<200&&await readFile(join(root,"started"),"utf8")!=="yes";n++)await wait(5);assert.equal(await readFile(join(root,"started"),"utf8"),"yes");stop.abort(new Error("cancel own key record"));}
		const error=await task;
		if(accepted){
			assert.ok(error instanceof HelperResponseError,String(error));
			assert.match(error.message,cancel?/cancelled/:/RunLoop exception/);
			await assert.rejects(lstat(join(directory,"input.lock")),{code:"ENOENT"});
			let next=false;await coordinator.run(new AbortController().signal,async()=>{next=true;});assert.equal(next,true);
		}else{
			assert.match(String(error),/termination could not be verified/);
			assert.ok((await lstat(join(directory,"input.lock"))).isDirectory());assert.equal(helper.pid,null);
			let next=false;await assert.rejects(coordinator.run(new AbortController().signal,async()=>{next=true;}),/earlier input helper termination is unverified/);assert.equal(next,false);
		}
	}finally{stop.abort();await task;await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
}

for(const cancel of [false,true])test(`a complete production keyboard cleanup record preserves the failed action without trapping its claim (cancel=${cancel})`,POSIX_ONLY,async()=>{
	await checkReply(produced,true,cancel);
});

test("incomplete or mismatched keyboard cleanup records cannot free an input claim",POSIX_ONLY,async()=>{
	const base=produced.inputCleanup as Record<string,unknown>;
	for(const cleanup of [undefined,null,{}, {...base,schema:"other"},{...base,commandId:2},{...base,pendingKeys:1},{...base,pendingKeys:null},{...base,failed:true},{...base,failed:undefined},{...base,complete:false}]){
		await checkReply({...produced,inputCleanup:cleanup},false);
	}
});

test("a keyboard cleanup record cannot certify a pointer whose down may have posted without a pointer record",POSIX_ONLY,async()=>{
	await checkReply({...produced,error:"mouse post threw after down",inputSent:true,inputPointer:null},false,false,"drag");
});

const lateProgram=String.raw`
const fs=require('node:fs'),lines=require('node:readline').createInterface({input:process.stdin});
const root=process.argv[1],kind=process.argv[2],lateOk=process.argv[3]==='true';let command;
const log=s=>fs.appendFileSync(root+'/events',s+'\n');
const cleanup=(pending,failed)=>({schema:'mac-keyboard-cleanup-v1',commandId:command.id,pendingKeys:pending,failed,complete:!failed&&pending===0});
lines.on('line',line=>{const value=JSON.parse(line);
 if(value.op!=='route_ack'){command=value;process.stdout.write(JSON.stringify({id:value.id,kind:'input-route',routeToken:value.routeToken,route:{own:'file-only'}})+'\n');}
 else{log('down');fs.writeFileSync(root+'/held','true');log('first unknown');process.stdout.write(JSON.stringify({id:command.id,ok:false,error:'first release remains unknown',inputSent:true,inputPointer:kind==='drag'?{x:1,y:2,button:'left',released:false}:null,inputCleanup:cleanup(1,true)})+'\n');}
});
lines.on('close',()=>{
 log('EOF after first unknown');
 setTimeout(()=>{log('late clean reply without up');process.stdout.write(JSON.stringify({id:command.id,ok:lateOk,error:'late clean business result',inputSent:true,inputPointer:kind==='drag'?{x:1,y:2,button:'left',released:true}:null,inputCleanup:cleanup(0,false)})+'\n');},10);
 setTimeout(()=>{log('exit');process.exit(0);},70);
});setInterval(()=>{},1000);
`;

for(const op of ["key","drag"])for(const lateOk of [true,false])test(`a late clean reply cannot overwrite the first unknown release (${op}, ok=${lateOk})`,POSIX_ONLY,async()=>{
	const root=await mkdtemp(join(tmpdir(),"mountains-key-late-cleanup-")),directory=join(root,"coord"),coordinator=new InputCoordinator(directory);
	await writeFile(join(root,"events"),"");
	const helper=new JsonHelper(process.execPath,["-e",lateProgram,root,op,String(lateOk)],process.env,"eof");
	try{
		await assert.rejects(coordinator.run(new AbortController().signal,()=>helper.send({op,routeToken:"own-late-cleanup-route"},2000,true,()=>{})),/first release remains unknown/);
		assert.equal(helper.pid,null,"completion must wait until this exact helper closes");
		assert.equal(await readFile(join(root,"held"),"utf8"),"true");
		assert.equal(await readFile(join(root,"events"),"utf8"),"down\nfirst unknown\nEOF after first unknown\nlate clean reply without up\nexit\n");
		assert.ok((await lstat(join(directory,"input.lock"))).isDirectory());
		let next=false;await assert.rejects(coordinator.run(new AbortController().signal,async()=>{next=true;}),/earlier input helper termination is unverified/);assert.equal(next,false);
	}finally{await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
});
