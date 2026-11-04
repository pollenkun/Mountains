import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {POSIX_ONLY} from "./fixtures/platform.ts";
import { spawn } from "node:child_process";
import {once} from 'node:events';
import { browserProcess, BrowserProcessObservationUnknownError, type BrowserProcess } from "../src/browser-process.ts";
import { BrowserClients, type BrowserChildLifetime } from "../src/browser-clients.ts";
import { InputCoordinator } from "../src/coordinator.ts";
import { WebBrowser, type CdpLike } from "../src/web.ts";

for (const disk of [false, true]) test(`only the last browser client closes the shared process (disk=${disk})`,POSIX_ONLY,async () => {
	const directory = disk ? await mkdtemp(join(tmpdir(), "mountains-clients-")) : undefined;
	const scheduler = new InputCoordinator(directory), signal = new AbortController().signal;
	const clientsA = new BrowserClients(scheduler), clientsB = new BrowserClients(scheduler);
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	const closed=once(child,'close').then(()=>{});
	const identity = await browserProcess(child.pid!);
	assert.ok(identity);
	let killed = false, transportClosed = 0;
	const connection = (): CdpLike => ({ on: () => () => {}, close: async () => { transportClosed++; },
		async send(method) { if (killed) throw new Error("shared browser was killed"); if (method === "Browser.close") { killed = true; child.kill("SIGTERM"); } return {}; } });
	const a = new WebBrowser(), b = new WebBrowser();
	const install = (browser: WebBrowser, clients: BrowserClients) => Object.assign(browser, { coordinator: scheduler, clients, endpoint: "ws://own-exact-endpoint", live: connection() });
	try {
		await scheduler.run(signal, async () => { await clientsA.join(); await clientsA.owned("ws://own-exact-endpoint", identity); await clientsB.join(); });
		install(a, clientsA); install(b, clientsB);
		await a.close();
		assert.equal(killed, false); assert.equal(transportClosed, 1);
		await b.close();
		assert.equal(killed, true); assert.equal(transportClosed, 2);
	} finally { child.kill("SIGTERM");await closed; if (directory) await rm(directory, { recursive: true, force: true }); }
});

test("a leftover ownership receipt cannot close a replacement browser",POSIX_ONLY,async () => {
	const scheduler = new InputCoordinator(), clients = new BrowserClients(scheduler);
	await clients.join(); await clients.owned("ws://old");
	assert.equal(await clients.leave("ws://replacement"), false);
});

test('an unreachable endpoint is not proof that the owned process exited',POSIX_ONLY,async context=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}),closed=once(child,'close').then(()=>{}),identity=await browserProcess(child.pid!);
 assert.ok(identity);
 const scheduler=new InputCoordinator(),clients=new BrowserClients(scheduler);
 await clients.join();await clients.owned('ws://unresponsive',identity);
 const browser=new WebBrowser(),fake:CdpLike={on:()=>()=>{},close:async()=>{},async send(){throw new Error('unresponsive');}};
 Object.assign(browser,{coordinator:scheduler,clients,endpoint:'ws://unresponsive',live:fake,existingSocket:async()=>undefined});
 let signals=0;context.mock.method(process,'kill',()=>{signals++;return true;});
 try{
  const closing=browser.close();assert.equal(browser.close(),closing);
  let failure:unknown;
  await assert.rejects(closing,error=>{failure=error;return error instanceof Error && /still running|deadline.*state remains unknown/.test(error.message);});
  await assert.rejects(browser.close(),error=>error===failure);
  assert.equal(signals,0,'an unreachable endpoint never authorizes a raw PID signal');
  assert.equal((await browserProcess(child.pid!))?.identity,identity.identity,'the original process must still be alive');
 }finally{child.kill('SIGTERM');await closed;}
});

async function observedShutdown(context:TestContext,observe:(call:number,owner:BrowserProcess)=>BrowserProcess|null){
	// Exercise public close with real in-memory ownership, but no OS process or UI.
	const coordinator=new InputCoordinator(),clients=new BrowserClients(coordinator),endpoint='ws://observed-shutdown';
	const owner={pid:912345,identity:'own-launcher-browser'},deadlines:number[]=[],sent:string[]=[];
	let reads=0,transports=0,signals=0;
	context.mock.method(process,'kill',()=>{signals++;return true;});
	await clients.join();await clients.owned(endpoint,owner);
	const browser=new WebBrowser(),cdp:CdpLike={on:()=>()=>{},async close(){transports++;},async send(method){sent.push(method);return{};}};
	Object.assign(browser,{coordinator,clients,endpoint,live:cdp,async readProcess(pid:number,expiresAt:number){
		assert.equal(pid,owner.pid);assert.ok(Number.isFinite(expiresAt));deadlines.push(expiresAt);
		return observe(++reads,owner);
	}});
	return{browser,deadlines,sent,stats:()=>({reads,transports,signals})};
}

for(const aliveBetween of [false,true])test(`shutdown waits for confirmed absence after unknown observations (aliveBetween=${aliveBetween})`,POSIX_ONLY,async context=>{
	const unknown=new BrowserProcessObservationUnknownError('process-changed-during-read');
	const fixture=await observedShutdown(context,(call,owner)=>{if(call===1)throw unknown;return aliveBetween&&call===2?owner:null;});
	await fixture.browser.close();
	assert.equal(fixture.stats().reads,aliveBetween?3:2);
	assert.equal(new Set(fixture.deadlines).size,1,'every observation must share the original shutdown deadline');
	assert.deepEqual(fixture.sent,['Browser.close']);assert.equal(fixture.stats().transports,1);assert.equal(fixture.stats().signals,0);
});

test('persistent unknown observations fail at the original two-second deadline without sending PID signals',POSIX_ONLY,async context=>{
	let now=10_000,lastUnknown:BrowserProcessObservationUnknownError|undefined;
	context.mock.method(performance,'now',()=>now);
	const fixture=await observedShutdown(context,call=>{
		assert.ok(call<=4,'retrying must not renew the deadline');now+=500;
		throw lastUnknown=new BrowserProcessObservationUnknownError(`executable-unavailable-${call}`);
	});
	const closing=fixture.browser.close();
	await assert.rejects(closing,error=>error===lastUnknown);
	assert.equal(fixture.browser.close(),closing);assert.deepEqual(fixture.deadlines,[12_000,12_000,12_000,12_000]);
	assert.deepEqual(fixture.stats(),{reads:4,transports:1,signals:0});assert.deepEqual(fixture.sent,['Browser.close']);
});

test('an absence reply arriving at the shutdown deadline cannot turn unknown into successful cleanup',POSIX_ONLY,async context=>{
	let now=10_000;context.mock.method(performance,'now',()=>now);
	const unknown=new BrowserProcessObservationUnknownError('executable-unavailable');
	const fixture=await observedShutdown(context,call=>{if(call===1)throw unknown;now=12_000;return null;});
	await assert.rejects(fixture.browser.close(),error=>error===unknown);
	assert.deepEqual(fixture.deadlines,[12_000,12_000]);assert.deepEqual(fixture.stats(),{reads:2,transports:1,signals:0});
});

for(const detail of ['transport protocol failed','invalid OS process observation','OS observation is unknown (plain error)'])test(`shutdown never retries a non-unknown error: ${detail}`,POSIX_ONLY,async context=>{
	const primary=new Error(detail),fixture=await observedShutdown(context,()=>{throw primary;});
	await assert.rejects(fixture.browser.close(),error=>error===primary);
	assert.deepEqual(fixture.stats(),{reads:1,transports:1,signals:0});assert.deepEqual(fixture.sent,['Browser.close']);
});

test('a changed process identity fails immediately instead of retrying until a later absence',POSIX_ONLY,async context=>{
	const fixture=await observedShutdown(context,(call,owner)=>call===1?{...owner,identity:'replacement-browser'}:null);
	await assert.rejects(fixture.browser.close(),/identity changed.*cleanup is unverified/);
	assert.deepEqual(fixture.stats(),{reads:1,transports:1,signals:0});assert.deepEqual(fixture.sent,['Browser.close']);
});

for(const mode of ['browser-close','term','kill'] as const)test(`a directly owned browser child is awaited through actual ${mode} exit`,POSIX_ONLY,async()=>{
	// Owned Node processes stand in for lifecycle only; no browser/UI is driven.
	const child=spawn(process.execPath,['-e',`${mode==='kill'?'process.on("SIGTERM",()=>{});':''}process.stdout.write('ready\\n');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore']});
	const closed=once(child,'close').then(()=>{});await once(child.stdout,'data');assert.ok(child.pid);
	const owner=await browserProcess(child.pid);assert.ok(owner);const coordinator=new InputCoordinator(),clients=new BrowserClients(coordinator);await clients.join();await clients.owned('ws://owned-child',owner,{child,isBrowser:true,closed});
	let transportsClosed=0;const cdp:CdpLike={on:()=>()=>{},async send(method){if(method==='Browser.close'&&mode==='browser-close'){child.kill('SIGTERM');await closed;}return{};},async close(){transportsClosed++;}};
	const browser=new WebBrowser();Object.assign(browser,{coordinator,clients,endpoint:'ws://owned-child',live:cdp,child,childLifetime:{child,isBrowser:true,closed}});
	try{await browser.close();assert.equal(transportsClosed,1);assert.equal(child.signalCode,mode==='kill'?'SIGKILL':'SIGTERM');await closed;}
	finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;}
});

test('an exited direct child cannot make cleanup follow a numeric PID now held by another process',POSIX_ONLY,async()=>{
	const prior=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'}),priorClosed=once(prior,'close').then(()=>{});await priorClosed;
	const replacement=spawn(process.execPath,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000);'],{stdio:['ignore','pipe','ignore']}),replacementClosed=once(replacement,'close').then(()=>{});await once(replacement.stdout,'data');assert.ok(replacement.pid);
	// Model PID recycling after the exact old ChildProcess already closed.
	// Only metadata changes; its OS child handle is still the exited original.
	Object.assign(prior,{pid:replacement.pid});
	const owner=await browserProcess(replacement.pid);assert.ok(owner);const coordinator=new InputCoordinator(),clients=new BrowserClients(coordinator);await clients.join();await clients.owned('ws://exited-child',owner,{child:prior,isBrowser:true,closed:priorClosed});
	const browser=new WebBrowser(),cdp:CdpLike={on:()=>()=>{},async send(){return{};},async close(){}};
	Object.assign(browser,{coordinator,clients,endpoint:'ws://exited-child',live:cdp,child:prior,childLifetime:{child:prior,isBrowser:true,closed:priorClosed}});
	try{await browser.close();assert.ok(await browserProcess(replacement.pid),'the replacement must remain alive');}
	finally{replacement.kill('SIGTERM');await replacementClosed;}
});

async function ownChild(ignoreTerm=false,inspect=browserProcess){
	const child=spawn(process.execPath,['-e',`${ignoreTerm?'process.on("SIGTERM",()=>{});':''}process.on('message',title=>{process.title=String(title);process.send?.('renamed');});process.stdout.write('ready\\n');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore','ipc']});
	const closed=new Promise<void>(yes=>child.once('close',()=>yes()));let spawnError:Error|undefined,timer:ReturnType<typeof setTimeout>|undefined;
	child.once('error',error=>{spawnError=error;});
	const finish=async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;};
	try{
		await Promise.race([once(child.stdout!,'data'),closed.then(()=>{throw spawnError??new Error('owned lifecycle fixture exited before ready');}),new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error('owned lifecycle fixture did not become ready')),3000);})]);
		const owner=await inspect(child.pid!);assert.ok(owner);
		const lifetime:BrowserChildLifetime={child,isBrowser:true,closed};return{child,owner,lifetime,finish};
	}catch(error){await finish();throw error;}
	finally{clearTimeout(timer);}
}

test('a fixture identity-read failure still awaits that new fixture exiting',POSIX_ONLY,async()=>{
	const primary=new Error('initial process query failed');let pid:number|undefined;
	await assert.rejects(ownChild(false,async value=>{pid=value;throw primary;}),error=>error===primary);
	assert.ok(pid);assert.equal(await browserProcess(pid),null);
});

for(const disk of [false,true])for(const mode of ['term','kill'] as const)test(`the last shared client retains the creator's actual child through ${mode} (disk=${disk})`,POSIX_ONLY,async()=>{
	const fixture=await ownChild(mode==='kill'),directory=disk?await mkdtemp(join(tmpdir(),'mountains-shared-child-')):undefined;
	const schedulerA=new InputCoordinator(directory),schedulerB=disk?new InputCoordinator(directory):schedulerA;
	const aClients=new BrowserClients(schedulerA),bClients=new BrowserClients(schedulerB),endpoint='ws://shared-original';
	const a=new WebBrowser(),b=new WebBrowser();let attempts=0;
	const cdp=():CdpLike=>({on:()=>()=>{},close:async()=>{},async send(method){if(method==='Browser.close'){attempts++;throw new Error('browser is not responding');}return{};}});
	try{
		await aClients.join();await aClients.owned(endpoint,fixture.owner,fixture.lifetime);await bClients.join();
		Object.assign(a,{coordinator:schedulerA,clients:aClients,endpoint,live:cdp(),child:fixture.child,childLifetime:fixture.lifetime});
		Object.assign(b,{coordinator:schedulerB,clients:bClients,endpoint,live:cdp()});
		await a.close();assert.equal(attempts,0);assert.ok(await browserProcess(fixture.owner.pid));
		assert.equal((await bClients.childLifetime(endpoint,fixture.owner))?.child,fixture.child);
		await b.close();await fixture.lifetime.closed;
		assert.equal(attempts,1);assert.equal(fixture.child.signalCode,mode==='kill'?'SIGKILL':'SIGTERM');
		assert.equal(await bClients.childLifetime(endpoint,fixture.owner),undefined);
	}finally{await fixture.finish();if(directory)await rm(directory,{recursive:true,force:true});}
});

for(const disk of [false,true])test(`browser ownership is copied on registration and read (disk=${disk})`,POSIX_ONLY,async()=>{
	const directory=disk?await mkdtemp(join(tmpdir(),'mountains-owner-copy-')):undefined;
	try{
		const clients=new BrowserClients(new InputCoordinator(directory)),owner={pid:12345,identity:'original'};
		await clients.join();await clients.owned('ws://original',owner);owner.identity='caller changed it';
		const returned=await clients.process('ws://original');assert.ok(returned);assert.equal(returned.identity,'original');returned.pid=12346;returned.identity='reader changed it';
		assert.deepEqual(await clients.process('ws://original'),{pid:12345,identity:'original'});
		assert.equal(await clients.process('ws://other'),undefined);await clients.leave('ws://original');
	}finally{if(directory)await rm(directory,{recursive:true,force:true});}
});

for(const disk of [false,true])test(`mutating a pending registration cannot substitute another actual child (disk=${disk})`,POSIX_ONLY,async()=>{
	const original=await ownChild(),other=await ownChild(),directory=disk?await mkdtemp(join(tmpdir(),'mountains-child-register-')):undefined;
	try{
		const coordinator=new InputCoordinator(directory),clients=new BrowserClients(coordinator),endpoint='ws://registration-original';await clients.join();
		const caller={...original.lifetime},registering=clients.owned(endpoint,original.owner,caller);
		caller.child=other.child;caller.closed=other.lifetime.closed;caller.isBrowser=false;
		await registering;assert.equal((await clients.childLifetime(endpoint,original.owner))?.child,original.child);
		const browser=new WebBrowser(),cdp:CdpLike={on:()=>()=>{},close:async()=>{},send:async()=>({})};Object.assign(browser,{coordinator,clients,endpoint,live:cdp});
		await browser.close();await original.lifetime.closed;assert.equal(original.child.signalCode,'SIGTERM');
		assert.equal(other.child.exitCode,null);assert.equal(other.child.signalCode,null);assert.ok(await browserProcess(other.owner.pid),'the substituted child must remain untouched');
	}finally{await original.finish();await other.finish();if(directory)await rm(directory,{recursive:true,force:true});}
});

test('retained child lookup requires the original endpoint, owner and private directory',POSIX_ONLY,async()=>{
	const fixture=await ownChild(),other=await ownChild(),directory=await mkdtemp(join(tmpdir(),'mountains-child-directory-'));
	try{
		const clients=new BrowserClients(new InputCoordinator(directory)),endpoint='ws://original';
		await clients.join();await clients.owned(endpoint,fixture.owner,fixture.lifetime);
		assert.equal(await clients.childLifetime('ws://other',fixture.owner),undefined);
		assert.equal(await clients.childLifetime(endpoint,{...fixture.owner,identity:'different'}),undefined);
		await clients.forgetChild(endpoint,other.lifetime);
		assert.equal((await clients.childLifetime(endpoint,fixture.owner))?.child,fixture.child);
		await assert.rejects(clients.owned(endpoint,other.owner,other.lifetime),/cannot be replaced/);
		assert.deepEqual(await clients.process(endpoint),fixture.owner,'a rejected replacement must not overwrite ownership');
		const original=join(directory,'browser-clients'),moved=join(directory,'original-directory');await rename(original,moved);await mkdir(original,{mode:0o700});
		const replacement=new BrowserClients(new InputCoordinator(directory));await replacement.join();await replacement.owned(endpoint,fixture.owner);
		assert.equal(await replacement.childLifetime(endpoint,fixture.owner),undefined,'replacement directory cannot adopt an old handle');
		await replacement.leave(endpoint);await rm(original,{recursive:true});await rename(moved,original);
		await clients.forgetChild(endpoint,fixture.lifetime);assert.equal(await clients.childLifetime(endpoint,fixture.owner),undefined);await clients.leave(endpoint);
	}finally{await fixture.finish();await other.finish();await rm(directory,{recursive:true,force:true});}
});

test('changing comm while the same process lives cannot be reported as a successful close',POSIX_ONLY,async context=>{
	const fixture=await ownChild(),clients=new BrowserClients(new InputCoordinator()),endpoint='ws://renamed';
	let signals=0;context.mock.method(process,'kill',()=>{signals++;return true;});
	try{
		await clients.join();await clients.owned(endpoint,fixture.owner);
		const renamed=once(fixture.child,'message');fixture.child.send('mountains-own-lifecycle-fixture');await renamed;
		const actual=await browserProcess(fixture.owner.pid);assert.ok(actual);
		if(process.platform==='darwin')assert.equal(actual.identity,fixture.owner.identity,'real OS birth/executable must ignore process.title');
		else assert.notEqual(actual.identity,fixture.owner.identity);
		const browser=new WebBrowser(),cdp:CdpLike={on:()=>()=>{},close:async()=>{},send:async()=>({})};
		Object.assign(browser,{clients,endpoint,live:cdp});
		await assert.rejects(browser.close(),/identity changed.*unverified|still running.*unverified|deadline.*state remains unknown/);
		assert.equal(signals,0,'no raw PID termination is allowed');
		assert.ok(await browserProcess(fixture.owner.pid),'no raw PID termination is allowed');
	}finally{await fixture.finish();}
});

test('close publishes one promise before synchronous abort listeners can reenter it',POSIX_ONLY,async()=>{
	const browser=new WebBrowser(),lifecycle=(browser as unknown as {lifecycle:AbortController}).lifecycle;let reentered:Promise<void>|undefined,transports=0,guards=0;
	Object.assign(browser,{live:{on:()=>()=>{},send:async()=>({}),async close(){transports++;}},focusGuard:{async close(){guards++;}}});
	lifecycle.signal.addEventListener('abort',()=>{reentered=browser.close();},{once:true});
	const closing=browser.close();assert.equal(reentered,closing);assert.equal(browser.close(),closing);await closing;assert.equal(transports,1);assert.equal(guards,1);
});

for(const fault of ['leave','retained','transport','frames','guard','unsubscribe','all'] as const)test(`cleanup continues after ${fault} failure and retains original errors`,POSIX_ONLY,async()=>{
	const events:string[]=[],failures=new Map<string,Error>(),fail=(name:string)=>{events.push(name);if(fault===name||fault==='all'){const error=new Error(name);failures.set(name,error);throw error;}};
	const clients={async leave(){fail('leave');return fault==='retained';},async retained(){fail('retained');return[];}};
	const browser=new WebBrowser();Object.assign(browser,{clients,endpoint:'ws://cleanup-test',live:{async close(){fail('transport');}},frames:{close(){fail('frames');}},focusGuard:{async close(){fail('guard');}},subscriptions:[()=>fail('unsubscribe'),()=>events.push('last-unsubscribe')]});
	await assert.rejects(browser.close(),error=>{
		const actual=error instanceof AggregateError?error.errors:[error];assert.deepEqual(actual,[...failures.values()]);return true;
	});
	assert.deepEqual(events.filter(e=>!['leave','retained'].includes(e)),['transport','frames','guard','unsubscribe','last-unsubscribe']);
	const state=browser as unknown as {live:unknown;frames:unknown;focusGuard:unknown;subscriptions:unknown[]};assert.equal(state.live,null);assert.equal(state.frames,undefined);assert.equal(state.focusGuard,undefined);assert.deepEqual(state.subscriptions,[]);
});

test('failure to acquire the cleanup lock still releases every local resource',POSIX_ONLY,async()=>{
	const primary=new Error('lock failed'),events:string[]=[],browser=new WebBrowser();
	Object.assign(browser,{coordinator:{async run(){throw primary;}},live:{async close(){events.push('transport');}},focusGuard:{async close(){events.push('guard');}},subscriptions:[()=>events.push('unsubscribe')]});
	await assert.rejects(browser.close(),error=>error===primary);assert.deepEqual(events,['transport','guard','unsubscribe']);
});

test('failed download setup preserves the original error when transport cleanup also fails',POSIX_ONLY,async()=>{
	const primary=new Error('download setup failed'),secondary=new Error('transport cleanup failed');let closes=0;
	const browser=new WebBrowser({connect:async()=>({on:()=>()=>{},async send(){throw primary;},async close(){closes++;throw secondary;}})});
	await assert.rejects(browser.tabs(),error=>{assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[primary,secondary]);return true;});
	assert.equal(closes,1);await browser.close();assert.equal(closes,1);
});

test('a handed-off browser retains its original child until a later client finishes it',POSIX_ONLY,async()=>{
	const fixture=await ownChild(),scheduler=new InputCoordinator(),clients=new BrowserClients(scheduler),endpoint='ws://handoff-lifetime';let closes=0;
	const connection=():CdpLike=>({on:()=>()=>{},close:async()=>{},async send(method){if(method==='Browser.close')closes++;return{};}});
	try{
		await clients.join();await clients.owned(endpoint,fixture.owner,fixture.lifetime);await clients.retain(endpoint,'own-login-page');
		const original=new WebBrowser();Object.assign(original,{coordinator:scheduler,clients,endpoint,live:connection(),child:fixture.child,childLifetime:fixture.lifetime});
		await original.close();assert.equal(closes,0);assert.ok(await browserProcess(fixture.owner.pid));
		const nextClients=new BrowserClients(scheduler);await nextClients.join();await nextClients.retain(endpoint,'own-login-page',false);
		const next=new WebBrowser();Object.assign(next,{coordinator:scheduler,clients:nextClients,endpoint,live:connection()});
		await next.close();await fixture.lifetime.closed;assert.equal(closes,1);assert.equal(fixture.child.signalCode,'SIGTERM');
	}finally{await fixture.finish();}
});

test('failed startup still awaits its actual new child when client removal throws',POSIX_ONLY,async()=>{
	// Node deliberately rejects Chrome flags. This exercises actual spawn/exit
	// cleanup without starting Chrome, touching UI or using any browser profile.
	const directory=await mkdtemp(join(tmpdir(),'mountains-failed-spawn-')),cleanupError=new Error('client removal failed'),browser=new WebBrowser({headless:true,chromePath:process.execPath,profileDir:directory});
	let launched:BrowserChildLifetime|undefined;
	const clients={join:async()=>{},async leave(){launched??=(browser as unknown as {childLifetime:BrowserChildLifetime}).childLifetime;throw cleanupError;}};
	Object.assign(browser,{clients,coordinator:new InputCoordinator(),existingSocket:async()=>undefined});
	const flatten=(error:unknown):unknown[]=>error instanceof AggregateError?error.errors.flatMap(flatten):[error];
	try{
		await assert.rejects(browser.tabs(),error=>{const errors=flatten(error);assert.ok(errors.some(value=>value instanceof Error&&/Chrome quit before/.test(value.message)));assert.ok(errors.includes(cleanupError));return true;});
		assert.ok(launched);await launched.closed;assert.notEqual(launched.child.exitCode,null);
		const state=browser as unknown as {child:unknown;childLifetime:unknown};assert.equal(state.child,null);assert.equal(state.childLifetime,undefined);
	}finally{if(launched){if(launched.child.exitCode===null&&launched.child.signalCode===null)launched.child.kill('SIGKILL');await launched.closed;}await rm(directory,{recursive:true,force:true});}
});
