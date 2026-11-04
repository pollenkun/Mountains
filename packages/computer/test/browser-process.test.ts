import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {POSIX_ONLY} from './fixtures/platform.ts';
import {BrowserProcessProbe,BrowserProcessObservationUnknownError,browserProcess,parseBrowserProcess} from '../src/browser-process.ts';
import {JsonHelper} from '../src/helper.ts';
import {InputCoordinator} from '../src/coordinator.ts';

const native=fileURLToPath(new URL('../native/darwin-universal/process-identity',import.meta.url));
const birth={pid:123,bootId:'ae4aa992-0a83-4b78-a9b5-29fc44e99ca9',startSeconds:'1792392000',startMicroseconds:123456};
const live=()=>({status:'alive',birth:{...birth},executable:'/own/program'});
test('canonical OS identity ignores JSON order and preserves microsecond births and executable changes',()=>{
	const a=parseBrowserProcess(live(),123),b=parseBrowserProcess({executable:'/own/program',birth:{startMicroseconds:123456,startSeconds:birth.startSeconds,bootId:birth.bootId,pid:123},status:'alive'},123);
	assert.deepEqual(a,b);assert.equal(JSON.parse(a!.identity).schema,'macos-process-identity-v1');
	assert.notEqual(parseBrowserProcess({...live(),birth:{...birth,startMicroseconds:123457}},123)!.identity,a!.identity);
	assert.notEqual(parseBrowserProcess({...live(),executable:'/own/new-program'},123)!.identity,a!.identity);
	assert.equal(parseBrowserProcess({status:'absent'},123),null);
});
for(const [name,value]of [
	['unknown',{status:'unknown',reason:'process-query-failed'}],['missing',{}],['array',[]],['null',null],
	['absence with stale birth',{status:'absent',birth}],['wrong pid',{...live(),birth:{...birth,pid:124}}],
	['numeric seconds',{...live(),birth:{...birth,startSeconds:1792392000}}],['overflow seconds',{...live(),birth:{...birth,startSeconds:'9999999999999999999'}}],
	['bad boot',{...live(),birth:{...birth,bootId:'same-boot'}}],['invalid microsecond',{...live(),birth:{...birth,startMicroseconds:1_000_000}}],
	['fractional microsecond',{...live(),birth:{...birth,startMicroseconds:1.5}}],['relative path',{...live(),executable:'program'}],
	['unsafe path',{...live(),executable:'/own/program\nforged'}],['extra fields',{...live(),oldIdentity:'ps string'}]
]as const)test(`a ${name} observation is never process-exit evidence`,()=>{assert.throws(()=>parseBrowserProcess(value,123));});

for(const reason of ['executable-unavailable','process-changed-during-read','process-query-failed'])test(`a valid unknown observation retains its typed reason: ${reason}`,()=>{
	assert.throws(()=>parseBrowserProcess({status:'unknown',reason},123),error=>{
		assert.ok(error instanceof BrowserProcessObservationUnknownError);assert.equal(error.reason,reason);
		assert.match(error.message,/OS observation is unknown/);assert.ok(error.message.includes(reason));return true;
	});
});

for(const [name,value]of [
	['missing reason',{status:'unknown'}],['non-string reason',{status:'unknown',reason:42}],
	['empty reason',{status:'unknown',reason:''}],['control character',{status:'unknown',reason:'process-query-failed\n'}],
	['oversized reason',{status:'unknown',reason:'x'.repeat(257)}],['extra field',{status:'unknown',reason:'process-query-failed',birth}]
]as const)test(`a malformed unknown reply is not eligible for shutdown retry: ${name}`,()=>{
	assert.throws(()=>parseBrowserProcess(value,123),error=>{
		assert.ok(error instanceof Error);assert.equal(error instanceof BrowserProcessObservationUnknownError,false);
		assert.match(error.message,/invalid OS process observation/);return true;
	});
});

test('an expired caller deadline refuses a process query before starting a reader',async()=>{
	const reader=new BrowserProcessProbe();
	await assert.rejects(reader.read(process.pid,performance.now()-1),/deadline expired/);
	assert.equal((reader as unknown as {helper?:JsonHelper}).helper,undefined);await reader.close();
});

test('one browser reader reuses its real helper and closes it after an input lease ends',{skip:process.platform!=='darwin'},async()=>{
	const reader=new BrowserProcessProbe(),coordinator=new InputCoordinator();
	try{
		const first=await coordinator.run(new AbortController().signal,()=>reader.read(process.pid));assert.ok(first);
		const helper=(reader as unknown as {helper:JsonHelper}).helper,pid=helper.pid;assert.ok(pid);
		for(let i=0;i<8;i++){assert.deepEqual(await reader.read(process.pid),first);assert.equal(helper.pid,pid);}
		const child=(helper as unknown as {child:ChildProcessWithoutNullStreams}).child,closed=once(child,'close');
		const closing=reader.close();assert.equal(reader.close(),closing);await closing;await closed;assert.equal(helper.pid,null);
		await assert.rejects(reader.read(process.pid),/closed/);
	}finally{await reader.close();}
});

test('closing a queued query prevents its late spawn',{skip:process.platform!=='darwin'},async()=>{
	const reader=new BrowserProcessProbe(),pending=reader.read(process.pid);const refused=assert.rejects(pending);
	await reader.close();await refused;assert.equal((reader as unknown as {helper:JsonHelper}).helper.pid,null);
	await assert.rejects(reader.read(process.pid),/closed/);
});

test('real own processes get distinct precise identities and mutable process titles do not change them',{skip:process.platform!=='darwin'},async()=>{
	const children=[0,1].map(()=>spawn(process.execPath,['-e',`process.on('message',name=>{process.title=String(name);process.send?.('renamed');});process.stdout.write('ready\\n');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore','ipc']}));
	const closes=children.map(child=>once(child,'close').then(()=>{}));
	try{
		await Promise.all(children.map(child=>once(child.stdout!,'data')));
		const [a,b]=await Promise.all(children.map(child=>browserProcess(child.pid!)));assert.ok(a);assert.ok(b);assert.notEqual(a.identity,b.identity);
		const named=once(children[0]!,'message');children[0]!.send('changed-title-is-not-birth');await named;
		assert.deepEqual(await browserProcess(children[0]!.pid!),a);
	}finally{for(const child of children)child.kill('SIGKILL');await Promise.all(closes);}
});

test('only confirmed OS absence returns null',{skip:process.platform!=='darwin'},async()=>{
	const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'}),closed=once(child,'close');await closed;
	assert.ok(child.pid);assert.equal(await browserProcess(child.pid),null);
});

test('native protocol refuses invalid requests and incomplete pipes without input or UI',{skip:process.platform!=='darwin'},()=>{
	const good={id:1,pid:process.pid,deadline:Date.now()+3000};
	const run=(input:string)=>spawnSync(native,[],{input,encoding:'utf8',timeout:4000});
	for(const request of [{...good,pid:true},{...good,pid:0},{...good,pid:1.5},{...good,pid:2_147_483_648},{...good,deadline:0},{...good,extra:true}]){
		const output=run(JSON.stringify(request)+'\n');assert.equal(output.status,0,output.stderr);assert.equal(JSON.parse(output.stdout).ok,false);
	}
	for(const input of [JSON.stringify(good),'x'.repeat(4097)])assert.equal(run(input).status,1);
});

const fakeProgram=String.raw`
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const root=process.argv[1];
rl.on('line',line=>{const request=JSON.parse(line);fs.appendFileSync(root+'/calls',JSON.stringify(request)+'\n');
 if(request.hold){fs.writeFileSync(root+'/entered','yes');const timer=setInterval(()=>{if(fs.existsSync(root+'/release')){clearInterval(timer);process.stdout.write(JSON.stringify({id:request.id,ok:true})+'\n');}},5);return;}
 const final=JSON.stringify({id:request.id,ok:true,observation:{status:'absent'}})+'\n';
 if(process.argv[2]==='malformed'){process.stdout.write('not-json\n');return;}
 if(process.argv[2]==='invalid-first'){process.stdout.write('not-json\n'+final);return;}
 if(process.argv[2]==='wrong-first'){process.stdout.write(JSON.stringify({id:999,ok:true})+'\n'+final);return;}
 if(process.argv[2]==='duplicate'){process.stdout.write(final+final);return;}
 if(process.argv[2]==='late-idle'){process.stdout.write(JSON.stringify({id:request.id,ok:true,observation:{status:'unknown',reason:'process-query-failed'}})+'\n');setTimeout(()=>process.stdout.write('late-unmatched\n'),10);return;}
 process.stdout.write(JSON.stringify({id:request.id,ok:true,observation:{status:'unknown',reason:'process-query-failed'}})+'\n');
});`;
async function fixture(mode='unknown'){
	const root=await mkdtemp(join(tmpdir(),'mountains-process-transport-'));await writeFile(join(root,'calls'),'');
	const helper=new JsonHelper(process.execPath,['-e',fakeProgram,root,mode],process.env,'terminate',undefined,{strictReplies:true}),reader=new BrowserProcessProbe();Object.assign(reader,{helper});
	return{root,helper,reader,async finish(){try{
		if(['malformed','invalid-first','wrong-first','duplicate','late-idle'].includes(mode))await assert.rejects(reader.close(),/JSON|different request|extra data|unsolicited/);
		else await reader.close();
	}finally{await rm(root,{recursive:true,force:true});}}};
}
for(const mode of ['unknown','malformed','invalid-first','wrong-first','duplicate'])test(`a real helper's ${mode} reply cannot become successful absence`,{skip:process.platform!=='darwin'},async()=>{
	const f=await fixture(mode);try{await assert.rejects(f.reader.read(process.pid));}finally{await f.finish();}
});

test('late unsolicited output poisons subsequent queries without starting a replacement helper',{skip:process.platform!=='darwin'},async()=>{
	const f=await fixture('late-idle');try{
		await assert.rejects(f.reader.read(process.pid),/unknown/);await delay(40);
		await assert.rejects(f.reader.read(process.pid),/unsolicited/);
		assert.equal((await readFile(join(f.root,'calls'),'utf8')).trim().split('\n').length,1);
	}finally{await f.finish();}
});

test('late idle protocol corruption is reported even if no further query follows',{skip:process.platform!=='darwin'},async()=>{
	const f=await fixture('late-idle');try{await assert.rejects(f.reader.read(process.pid),/unknown/);await delay(40);await assert.rejects(f.reader.close(),/unsolicited/);}finally{await f.finish();}
});

test('the compatibility branch drains its real query and cannot return a late success after close',{skip:process.platform!=='darwin'},async()=>{
	// Replay the non-macOS branch with actual macOS ps on our own process.
	// This is not a claim that a Linux host was tested.
	const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{value:'linux'});
	const reader=new BrowserProcessProbe();let settled=false;
	try{
		const query=reader.read(process.pid),result=query.then(()=>{settled=true;assert.fail('closed query returned success');},error=>{settled=true;assert.match(String(error),/closed during/);});
		await reader.close();assert.equal(settled,true);await result;
	}finally{await reader.close();Object.defineProperty(process,'platform',descriptor);}
});

test('the reader deadline includes queue time and forbids a late metadata request',{skip:process.platform!=='darwin',timeout:8000},async()=>{
	const f=await fixture();let first:Promise<unknown>|undefined;
	try{
		first=f.helper.send({hold:true},6000);const deadline=performance.now()+2000;
		for(;;){try{await readFile(join(f.root,'entered'));break;}catch{assert.ok(performance.now()<deadline);await delay(5);}}
		await assert.rejects(f.reader.read(process.pid),/expired|deadline/);
		await writeFile(join(f.root,'release'),'yes');await first;await delay(10);
		assert.equal((await readFile(join(f.root,'calls'),'utf8')).trim().split('\n').length,1,'expired query must never write after the blocker completes');
	}finally{await writeFile(join(f.root,'release'),'yes');await first?.catch(()=>{});await f.finish();}
});

test('a short caller deadline expires while awaiting a busy helper instead of using the default three seconds',{skip:process.platform!=='darwin',timeout:5000},async()=>{
	const f=await fixture();let first:Promise<unknown>|undefined;
	try{
		first=f.helper.send({hold:true},4000);const readyBy=performance.now()+2000;
		for(;;){try{await readFile(join(f.root,'entered'));break;}catch{assert.ok(performance.now()<readyBy);await delay(5);}}
		const started=performance.now();
		await assert.rejects(f.reader.read(process.pid,started+100),/expired|deadline/);
		const elapsed=performance.now()-started;
		assert.ok(elapsed>=50&&elapsed<1000,`a 100 ms caller budget must expire before the default 3 s budget; took ${elapsed} ms`);
		await writeFile(join(f.root,'release'),'yes');await first;await delay(10);
		assert.equal((await readFile(join(f.root,'calls'),'utf8')).trim().split('\n').length,1,'the expired query must never dispatch after the busy helper becomes available');
	}finally{await writeFile(join(f.root,'release'),'yes');await first?.catch(()=>{});await f.finish();}
});

test('JsonHelper disposal waits for the original close after exit while inherited stdout drains',{timeout:5000},async()=>{
	// The descendant is our own finite Node timer, not a browser or user app.
	// Its inherited pipe keeps the parent close event later than parent exit.
	const program=String.raw`process.stdin.once('data',bytes=>{const q=JSON.parse(String(bytes));require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),250)'],{stdio:['ignore',process.stdout,process.stderr]}).unref();process.stdout.write(JSON.stringify({id:q.id,ok:true})+'\n',()=>process.exit(0));});`;
	const helper=new JsonHelper(process.execPath,['-e',program]);let child:ChildProcessWithoutNullStreams|undefined,closed:Promise<void>|undefined,exit:Promise<unknown>|undefined,didClose=false;
	try{
		await helper.send({},3000,true,undefined,undefined,undefined,undefined,context=>{child=context.child;closed=once(child,'close').then(()=>{didClose=true;});exit=once(child,'exit');});
		await exit;assert.equal(didClose,false);assert.ok(child);assert.notEqual(child.exitCode,null);
		await helper.dispose();assert.equal(didClose,true,'exitCode is insufficient until actual close');await closed;
	}finally{await helper.dispose();await closed;}
});

test('stopping an initially live helper has a total close deadline even if a descendant holds its pipe',{...POSIX_ONLY,timeout:8000},async()=>{
	const program=String.raw`process.stdin.once('data',bytes=>{const q=JSON.parse(String(bytes));require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),3800)'],{stdio:['ignore',process.stdout,process.stderr]}).unref();process.stdout.write(JSON.stringify({id:q.id,ok:true})+'\n');setInterval(()=>{},1000);});`;
	const helper=new JsonHelper(process.execPath,['-e',program]);let child:ChildProcessWithoutNullStreams|undefined,closed:Promise<void>|undefined,didClose=false;
	try{
		await helper.send({},3000,true,undefined,undefined,undefined,undefined,context=>{child=context.child;closed=once(child,'close').then(()=>{didClose=true;});});
		assert.ok(child);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
		await assert.rejects(helper.dispose(),/did not actually close.*deadline/);assert.equal(didClose,false);
		await closed;assert.equal(didClose,true);await assert.rejects(helper.dispose(),/unverified/);
	}finally{await helper.dispose().catch(()=>{});await closed;}
});
