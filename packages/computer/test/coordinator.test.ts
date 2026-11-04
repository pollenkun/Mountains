import assert from 'node:assert/strict';
import { test } from 'node:test';
import {POSIX_ONLY} from './fixtures/platform.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { InputCoordinator, InputTerminationUnverifiedError } from '../src/coordinator.ts';
import { JsonHelper } from '../src/helper.ts';
const wait = (ms:number)=>new Promise(r=>setTimeout(r,ms));

test('a cancelled queued request returns promptly without releasing the earlier owner',POSIX_ONLY,async()=>{
 const coordinator=new InputCoordinator(),stop=new AbortController();let release!:()=>void;
 const log:string[]=[];
 const first=coordinator.run(new AbortController().signal,async()=>{log.push('first start');await new Promise<void>(r=>{release=r});log.push('first end')});
 await wait(5);
 const second=coordinator.run(stop.signal,async()=>{log.push('must not run')});
 const third=coordinator.run(new AbortController().signal,async()=>{log.push('third')});
 stop.abort(new Error('cancelled'));
 await assert.rejects(second,/cancelled/);assert.deepEqual(log,['first start']);
 release();await Promise.all([first,third]);assert.deepEqual(log,['first start','first end','third']);
});

test('separate processes share one input claim and revision files',POSIX_ONLY,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mountains-input-test-'));
 const module=new URL('../src/coordinator.ts',import.meta.url).href;
 const script=`import {InputCoordinator} from ${JSON.stringify(module)};import {appendFile} from 'node:fs/promises';const c=new InputCoordinator(process.argv[1]);await c.run(new AbortController().signal,async()=>{await appendFile(process.argv[2],process.pid+' start\\n');await new Promise(r=>setTimeout(r,50));await c.changed('app/window');await appendFile(process.argv[2],process.pid+' end\\n')});`;
 try {
  const log=join(directory,'events');
  await Promise.all(Array.from({length:3},()=>new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',script,directory,log]);let error='';p.stderr.on('data',s=>error+=s);p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error(error)))})));
  const rows=(await readFile(log,'utf8')).trim().split('\n');assert.equal(rows.length,6);
  for(let i=0;i<6;i+=2){assert.match(rows[i]!,/ start$/);assert.equal(rows[i+1],rows[i]!.replace('start','end'));}
  assert.notEqual(await new InputCoordinator(directory).revision('app/window'),'0');
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('cancelling an input helper waits for termination before the next lease begins',POSIX_ONLY,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mountains-helper-test-')),log=join(directory,'events');
 const program=`const fs=require('node:fs');process.stdin.on('data',()=>{fs.appendFileSync(process.argv[1],'start\\n');setInterval(()=>fs.appendFileSync(process.argv[1],'event\\n'),10)});`;
 const helper=new JsonHelper(process.execPath,['-e',program,log]),coordinator=new InputCoordinator(),controller=new AbortController();
 try {
  const active=coordinator.run(controller.signal,()=>helper.send({op:'long'},5000));
  for(let i=0;i<100;i++){try{if((await readFile(log,'utf8')).includes('start'))break;}catch{}await wait(5);}
  controller.abort();await assert.rejects(active,/stopped/);
  const before=await readFile(log,'utf8');await coordinator.run(new AbortController().signal,async()=>{await wait(60);assert.equal(await readFile(log,'utf8'),before)});
 } finally {await helper.stop();await rm(directory,{recursive:true,force:true});}
});

test('a received pre-input refusal keeps its negative dispatch evidence',POSIX_ONLY,async()=>{
 const helper=new JsonHelper(process.execPath,['-e',`process.stdin.on('data',s=>{const c=JSON.parse(String(s));process.stdout.write(JSON.stringify({id:c.id,ok:false,error:'wrong window',inputSent:false})+'\\n')});`]);
 try{await assert.rejects(helper.send({op:'key'}),e=>e instanceof Error&&'reply' in e&&(e.reply as Record<string,unknown>).inputSent===false);}
 finally{await helper.stop();}
});

test('a dead owner\'s claim is taken over once no orphaned input helper is left, and kept while one is',POSIX_ONLY,async () => {
	const { staleClaim } = await import('../src/coordinator.ts');
	const directory = await mkdtemp(join(tmpdir(), 'mountains-stale-lock-'));
	try {
		const lock = join(directory, 'input.lock');
		await mkdir(lock, { mode: 0o700 });
		await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22, started: Date.now() }));
		const probe = (orphans: number, alive = false, startedAt: number | null = null) => ({ alive: () => alive, startedAt: async () => startedAt, orphanedHelpers: async () => orphans });
		assert.equal(await staleClaim(lock, probe(1)), false, 'an orphaned helper may still be sending input');
		assert.equal(await staleClaim(lock, probe(0, true, Date.now() - 60_000)), false, 'a live owner keeps its claim');
		assert.equal(await staleClaim(lock, probe(0, true, Date.now() + 60_000)), true, 'the PID now belongs to a later process');
		assert.equal(await staleClaim(lock, probe(0)), true, 'the owner is gone and nothing is left sending input');
		// The real coordinator takes the dead owner's claim (no PID 2^22 exists) and runs.
		let ran = false;
		await new InputCoordinator(directory).run(new AbortController().signal, async () => { ran = true; });
		assert.equal(ran, true);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

for(const mode of ['normal','cleanup-flag','new-lease'])test(`a timer from an ended lease cannot send input through ${mode}`,POSIX_ONLY,async()=>{
	const root=await mkdtemp(join(tmpdir(),'mountains-ended-lease-')),log=join(root,'events'),coordinator=new InputCoordinator(join(root,'coord'));
	await writeFile(log,'');
	const program=`const fs=require('node:fs');process.stdin.on('data',s=>{const c=JSON.parse(String(s));fs.appendFileSync(process.argv[1],'OLD INPUT\\n');process.stdout.write(JSON.stringify({id:c.id,ok:true})+'\\n')});`;
	const helper=new JsonHelper(process.execPath,['-e',program,log]);let finished!:()=>void,lateError:unknown;
	const done=new Promise<void>(resolve=>{finished=resolve;});
	try{
		await coordinator.run(new AbortController().signal,async()=>{
			setTimeout(()=>{const late=mode==='new-lease'?new InputCoordinator().run(new AbortController().signal,()=>helper.send({op:'old-input'})):helper.send({op:'old-input'},1000,mode!=='cleanup-flag');void late.catch(error=>{lateError=error;}).finally(finished);},25);
		});
		await coordinator.run(new AbortController().signal,async()=>{await appendFile(log,'new start\n');await done;await appendFile(log,'new end\n');});
		assert.match(String(lateError),/lease has ended/);assert.equal(await readFile(log,'utf8'),'new start\nnew end\n');assert.equal(helper.pid,null);
	}finally{await helper.dispose();await rm(root,{recursive:true,force:true});}
});

for(const cancellable of [true,false])test(`an unawaited helper is stopped before a later lease can run (cancellable=${cancellable})`,POSIX_ONLY,async()=>{
	const root=await mkdtemp(join(tmpdir(),'mountains-unawaited-lease-')),log=join(root,'events'),go=join(root,'allow-late-effect'),coordinator=new InputCoordinator(join(root,'coord'));await writeFile(log,'');
	const program=`const fs=require('node:fs');process.stdin.on('data',s=>{const c=JSON.parse(String(s));fs.appendFileSync(process.argv[1],'started\\n');const timer=setInterval(()=>{if(!fs.existsSync(process.argv[2]))return;clearInterval(timer);fs.appendFileSync(process.argv[1],'OLD LATE EFFECT\\n');process.stdout.write(JSON.stringify({id:c.id,ok:true})+'\\n');},3)});`;
	const helper=new JsonHelper(process.execPath,['-e',program,log,go]);let pending:Promise<unknown>|undefined;
	try{
		const failure=await coordinator.run(new AbortController().signal,async()=>{
			pending=helper.send({op:'own-file-input'},2000,cancellable);void pending.catch(()=>{});
			for(let n=0;n<200&&!(await readFile(log,'utf8')).includes('started');n++)await wait(5);assert.match(await readFile(log,'utf8'),/started/);
		}).then(()=>null,error=>error);
		await coordinator.run(new AbortController().signal,async()=>{await appendFile(log,'new start\n');await writeFile(go,'go');await wait(50);await appendFile(log,'new end\n');});
		assert.match(String(failure),/unawaited helper work/);await assert.rejects(pending!,/stopped/);
		assert.equal(await readFile(log,'utf8'),'started\nnew start\nnew end\n');assert.equal(helper.pid,null);
	}finally{await helper.dispose();await rm(root,{recursive:true,force:true});}
});

test('a cleanup send may finish after abort while its original lease remains active',POSIX_ONLY,async()=>{
	const stop=new AbortController(),helper=new JsonHelper(process.execPath,['-e',`process.stdin.on('data',s=>{const c=JSON.parse(String(s));process.stdout.write(JSON.stringify({id:c.id,ok:true})+'\\n')});`]);
	try{const result=await new InputCoordinator().run(stop.signal,async()=>{stop.abort();return helper.send({op:'own-cleanup-receipt'},1000,false);});assert.equal(result.ok,true);}
	finally{await helper.dispose();}
});

test('a failed stop retains the claim and rejects already queued and later callers',POSIX_ONLY,async()=>{
	const root=await mkdtemp(join(tmpdir(),'mountains-stop-failure-')),coordinator=new InputCoordinator(root),stop=new AbortController();
	let entered!:()=>void,leave!:()=>void,nextRan=false;
	const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),leavePromise=new Promise<void>(resolve=>{leave=resolve;});
	try{
		const first=coordinator.run(stop.signal,async lease=>{lease.watch(async()=>{throw new Error('injected failed stop');});entered();await leavePromise;throw new Error('primary cancelled input');});
		await enteredPromise;
		const queued=coordinator.run(new AbortController().signal,async()=>{nextRan=true;}).catch(error=>error);
		stop.abort();leave();await assert.rejects(first,/primary cancelled input; input helper termination could not be verified/);
		assert.match(String(await queued),/earlier input helper termination is unverified/);assert.equal(nextRan,false);
		await assert.rejects(coordinator.run(new AbortController().signal,async()=>{nextRan=true;}),/earlier input helper termination is unverified/);
		assert.equal(nextRan,false);assert.ok(JSON.parse(await readFile(join(root,'input.lock','owner.json'),'utf8')).pid===process.pid);
	}finally{await rm(root,{recursive:true,force:true});}
});

test('a nested unawaited coordinator cannot outlive its parent input claim',POSIX_ONLY,async()=>{
	const parent=new InputCoordinator(),child=new InputCoordinator(),log:string[]=[];let childEntered!:()=>void,releaseChild!:()=>void,childWork:Promise<void>|undefined;
	const entered=new Promise<void>(resolve=>{childEntered=resolve;}),finishChild=new Promise<void>(resolve=>{releaseChild=resolve;});
	const first=parent.run(new AbortController().signal,async()=>{
		childWork=child.run(new AbortController().signal,async()=>{log.push('child started');childEntered();await finishChild;log.push('child effect');});void childWork.catch(()=>{});
		await entered;log.push('parent returning');
	}).then(()=>null,error=>error);
	await entered;
	const second=parent.run(new AbortController().signal,async()=>{log.push('next parent started');});
	await wait(20);assert.deepEqual(log,['child started','parent returning']);releaseChild();
	assert.match(String(await first),/unawaited helper work/);await second;await childWork;
	assert.deepEqual(log,['child started','parent returning','child effect','next parent started']);
});

test('the same coordinator refuses an unawaited recursive claim without deadlocking',POSIX_ONLY,async()=>{
	const coordinator=new InputCoordinator();let nested:Promise<unknown>|undefined;
	const result=await coordinator.run(new AbortController().signal,async()=>{nested=coordinator.run(new AbortController().signal,async()=>{assert.fail('recursive input must not execute');});void nested.catch(()=>{});return 'outer complete';});
	assert.equal(result,'outer complete');await assert.rejects(nested!,/recursive desktop input claim/);
});

test('recursive claim checks include every ancestor (A then B then A)',POSIX_ONLY,async()=>{
	const a=new InputCoordinator(),b=new InputCoordinator();
	await a.run(new AbortController().signal,async()=>b.run(new AbortController().signal,async()=>{
		await assert.rejects(a.run(new AbortController().signal,async()=>{assert.fail('ancestor claim must not execute');}),/recursive desktop input claim/);
	}));
});

for(const alias of [false,true])test(`different coordinators cannot reacquire the same physical directory (alias=${alias})`,POSIX_ONLY,async()=>{
	const root=await mkdtemp('/tmp/mountains-recursive-domain-'),other=alias?await realpath(root):root,a=new InputCoordinator(root),b=new InputCoordinator(other);
	try{await a.run(new AbortController().signal,async()=>{await assert.rejects(b.run(new AbortController().signal,async()=>{assert.fail('same directory must not execute');}),/recursive desktop input claim/);});}
	finally{await rm(root,{recursive:true,force:true});}
});

test('a newly created intermediate path cannot hide a recursive physical directory',POSIX_ONLY,async()=>{
	const root=await mkdtemp('/tmp/mountains-recursive-missing-'),a=new InputCoordinator(root),b=new InputCoordinator(`${root}/missing/..`);
	try{
		await assert.rejects(lstat(`${root}/missing`),{code:'ENOENT'});
		await a.run(new AbortController().signal,async()=>{
			await assert.rejects(b.run(AbortSignal.timeout(500),async()=>{assert.fail('ancestor directory must not execute');}),/recursive desktop input claim/);
		});
	}finally{await rm(root,{recursive:true,force:true});}
});

test('parent cancellation reaches an active nested lease with its own signal',POSIX_ONLY,async()=>{
	const parent=new InputCoordinator(),child=new InputCoordinator(),stop=new AbortController(),childStop=new AbortController();
	let entered!:()=>void,childSignal:AbortSignal|undefined;
	const ready=new Promise<void>(resolve=>{entered=resolve;});
	const task=parent.run(stop.signal,async()=>child.run(childStop.signal,async lease=>{
		childSignal=lease.signal;entered();
		await new Promise<void>((resolve,reject)=>{lease.signal.addEventListener('abort',()=>reject(lease.signal.reason),{once:true});});
	})).catch(error=>error);
	await ready;stop.abort(new Error('parent requested cancel'));
	const inherited=childSignal!.aborted;
	// Only rescue a broken implementation, so a failed assertion leaves no waiter.
	if(!inherited)childStop.abort(new Error('test cleanup after missing inherited cancellation'));
	assert.match(String(await task),/parent requested cancel/);assert.equal(inherited,true);
});

test('parent cancellation removes a queued child without releasing an earlier owner',POSIX_ONLY,async()=>{
	const parent=new InputCoordinator(),child=new InputCoordinator(),stop=new AbortController(),log:string[]=[];
	let release!:()=>void,entered!:()=>void;
	const held=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
	const earlier=child.run(new AbortController().signal,async()=>{log.push('earlier start');await held;log.push('earlier end');});
	const task=parent.run(stop.signal,async()=>{entered();await child.run(AbortSignal.timeout(500),async()=>{log.push('cancelled child must not run');});}).catch(error=>error);
	try{
		await ready;stop.abort(new Error('parent cancelled while child queued'));
		assert.match(String(await task),/parent cancelled while child queued/);
		const later=child.run(new AbortController().signal,async()=>{log.push('later start');});
		await wait(10);assert.deepEqual(log,['earlier start']);release();await earlier;await later;
		assert.deepEqual(log,['earlier start','earlier end','later start']);
	}finally{release();await earlier;}
});

for(const caught of [false,true])test(`a descendant's unverified stop retains ancestor claims even when its error is caught (${caught})`,POSIX_ONLY,async()=>{
	const root=await mkdtemp(join(tmpdir(),'mountains-descendant-stop-')),parentDir=join(root,'parent'),childDir=join(root,'child'),parent=new InputCoordinator(parentDir),child=new InputCoordinator(childDir);
	let entered!:()=>void,release!:()=>void,nested:Promise<unknown>|undefined,nextRan=false;
	const ready=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
	const first=parent.run(new AbortController().signal,async()=>{
		nested=child.run(new AbortController().signal,async lease=>{
			lease.watch(async()=>{throw new Error('injected descendant helper stop failure');});entered();await held;
		});void nested.catch(()=>{});
		await ready;
		if(caught){release();await nested.catch(()=>{});}
	}).catch(error=>error);
	try{
		await ready;
		const queued=parent.run(new AbortController().signal,async()=>{nextRan=true;}).catch(error=>error);
		release();
		assert.match(String(await first),/termination could not be verified/);
		await assert.rejects(nested!,/termination could not be verified/);
		assert.match(String(await queued),/earlier input helper termination is unverified/);
		assert.ok((await lstat(join(parentDir,'input.lock'))).isDirectory());
		assert.ok((await lstat(join(childDir,'input.lock'))).isDirectory());
		await assert.rejects(parent.run(new AbortController().signal,async()=>{nextRan=true;}),/earlier input helper termination is unverified/);
		await assert.rejects(new InputCoordinator(parentDir).run(AbortSignal.timeout(60),async()=>{nextRan=true;}),error=>error instanceof Error&&['AbortError','TimeoutError'].includes(error.name));
		assert.equal(nextRan,false);
	}finally{release();await first;await nested?.catch(()=>{});await rm(root,{recursive:true,force:true});}
});

for(const unknown of [true,false])test('direct operation failure retains only explicitly unverified termination: '+unknown,POSIX_ONLY,async()=>{
 const root=await mkdtemp(join(tmpdir(),'mountains-direct-termination-')),directory=join(root,'claim'),coordinator=new InputCoordinator(directory),reason=unknown?new InputTerminationUnverifiedError('direct close did not verify cleanup'):new Error('ordinary operation failed after clean completion');
 try{
  await assert.rejects(coordinator.run(new AbortController().signal,async()=>{throw reason;}),error=>unknown?error instanceof InputTerminationUnverifiedError&&error.cause instanceof AggregateError&&error.cause.errors.includes(reason):error===reason);
  if(unknown){assert.ok((await lstat(join(directory,'input.lock'))).isDirectory());let next=false;await assert.rejects(coordinator.run(new AbortController().signal,async()=>{next=true;}),/earlier input helper termination is unverified/);assert.equal(next,false);}
  else{await assert.rejects(lstat(join(directory,'input.lock')),{code:'ENOENT'});let next=false;await coordinator.run(new AbortController().signal,async()=>{next=true;});assert.equal(next,true);}
 }finally{await rm(root,{recursive:true,force:true});}
});
