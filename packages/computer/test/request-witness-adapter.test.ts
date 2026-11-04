import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CdpEvent,CdpLike} from '../src/web.ts';
import {attachRequestWitness} from './acceptance/request-witness-adapter.ts';
import {signedFormService} from './acceptance/signed-form-service.ts';
import {REQUEST_PROOF_HEADER} from './acceptance/request-witness.ts';

class Browser implements CdpLike{
	readonly commands:{method:string;params:Record<string,unknown>;session?:string}[]=[];
	private readonly listeners=new Set<(event:CdpEvent)=>void>();
	stamp:unknown=100;loader='unit-loader';continuation:((params:Record<string,unknown>)=>Promise<unknown>)|undefined;
	readonly url:string;
	constructor(url:string){this.url=url;}
	on(listener:(event:CdpEvent)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
	emit(method:string,params:Record<string,unknown>,sessionId='unit-session'){for(const listener of this.listeners)listener({method,params,sessionId});}
	async send(method:string,params:Record<string,unknown>={},sessionId?:string){
		this.commands.push({method,params,...(sessionId?{session:sessionId}:{})});
		if(method==='Target.getTargetInfo')return{targetInfo:{targetId:'unit-target',type:'page',url:this.url}};
		if(method==='Target.attachToTarget')return{sessionId:'unit-session'};
		if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'unit-frame',loaderId:this.loader,url:this.url}}};
		if(method==='Performance.getMetrics')return{metrics:[{name:'Timestamp',value:this.stamp}]};
		if(method==='Fetch.continueRequest'&&this.continuation)return this.continuation(params);
		return{};
	}
	async close(){}
}
const attach=(browser:Browser,verifyOwner=async()=>{})=>attachRequestWitness(browser,{targetId:'unit-target',pageURL:browser.url,verifyOwner});

test('private CDP adapter binds actual clock, Fetch/Network events and real owned HTTP outcomes',async()=>{
	// Synthetic CDP + real disposable HTTP. This is not a Chrome or UI claim.
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-request-adapter-unit-'))),service=await signedFormService(root),browser=new Browser(service.url);
	let ownerReads=0;const adapter=await attach(browser,async()=>{ownerReads++;});service.bind(adapter.authorization);
	try{
		const clock=await adapter.beginExecution('unit-execution');assert.equal(clock.browserNotBefore,100);
		const body=JSON.stringify({name:'Own adapter 山川',color:'Green',agree:true});let response:Response|undefined,privateNonce='';
		let done!:()=>void;const actualHTTP=new Promise<void>(yes=>{done=yes;});
		browser.continuation=async params=>{
			const headers=params.headers as {name:string;value:string}[],nonce=headers.find(row=>row.name===REQUEST_PROOF_HEADER)!.value;
			privateNonce=nonce;
			browser.emit('Network.requestWillBeSentExtraInfo',{requestId:'network-1',headers:{[REQUEST_PROOF_HEADER]:nonce}});
			response=await fetch(service.origin+'/api/form',{method:'POST',headers:{[REQUEST_PROOF_HEADER]:nonce},body});done();return{};
		};
		browser.emit('Network.requestWillBeSent',{requestId:'network-1',frameId:'unit-frame',loaderId:'unit-loader',documentURL:service.url,timestamp:100.01,request:{method:'POST',url:service.origin+'/api/form',postData:body}});
		browser.emit('Fetch.requestPaused',{requestId:'fetch-1',networkId:'network-1',frameId:'unit-frame',request:{method:'POST',url:service.origin+'/api/form',postData:body,headers:{}}});
		await actualHTTP;assert.equal(response?.status,200);await adapter.endExecution('unit-execution');adapter.verifyComplete();
		assert.equal(adapter.publicRecords()[0]?.stage,'committed');assert.equal(service.verify().filter(row=>row.kind==='form-committed').length,1);
		assert.ok(privateNonce.length===64&&!JSON.stringify(adapter.publicRecords()).includes(privateNonce));
		assert.ok(ownerReads>=4);await adapter.close();await service.close();
		assert.ok(browser.commands.some(row=>row.method==='Target.detachFromTarget'&&row.params.sessionId==='unit-session'));
	}finally{await adapter.close().catch(()=>{});await service.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});
test('missing clock, changed document and failed owner cannot initialize an input permission',async()=>{
	for(const kind of ['clock','document','owner'] as const){
		const browser=new Browser('http://127.0.0.1:12345/form');let rejectOwner=false;
		const adapter=await attach(browser,async()=>{assert.ok(!rejectOwner,'owner changed');});
		try{
			if(kind==='clock')browser.stamp=undefined;if(kind==='document')browser.loader='other-loader';if(kind==='owner')rejectOwner=true;
			await assert.rejects(adapter.beginExecution('not-permitted'));assert.deepEqual(adapter.publicRecords(),[]);
		}finally{await adapter.close().catch(()=>{});}
	}
});
test('detached/closed observation cannot continue accepting HTTP and secrets are absent from public records',async()=>{
	const browser=new Browser('http://127.0.0.1:12345/form'),adapter=await attach(browser);
	try{
		await adapter.beginExecution('unit-execution');browser.emit('Mountains.connectionClosed',{});
		await assert.rejects(adapter.endExecution('unit-execution'));assert.throws(()=>adapter.verifyComplete());
	}finally{await adapter.close().catch(()=>{});}
});
test('closing the private session neither closes the shared browser connection nor re-enters cleanup',async()=>{
	const browser=new Browser('http://127.0.0.1:12345/form');let closed=0;browser.close=async()=>{closed++;};
	const adapter=await attach(browser),first=adapter.close(),second=adapter.close();assert.equal(first,second);await first;
	assert.equal(closed,0);assert.equal(browser.commands.filter(row=>row.method==='Target.detachFromTarget').length,1);await assert.rejects(adapter.beginExecution('late'));
});

test('preparation has a real independent deadline and a late CDP clock never grants input permission',async()=>{
	const browser=new Browser('http://127.0.0.1:12345/form'),original=browser.send.bind(browser);let held=false,entered!:()=>void,release!:()=>void;
	const waiting=new Promise<void>(yes=>{entered=yes;}),gate=new Promise<void>(yes=>{release=yes;});
	browser.send=async(method,params,session)=>{if(held&&method==='Performance.getMetrics'){entered();await gate;}return original(method,params,session);};
	const adapter=await attachRequestWitness(browser,{targetId:'unit-target',pageURL:browser.url,verifyOwner:async()=>{},preparationTimeoutMs:50});
	try{
		held=true;const pending=adapter.beginExecution('never-permitted');await waiting;await assert.rejects(pending,/independent deadline/);
		release();await new Promise<void>(yes=>setImmediate(yes));assert.deepEqual(adapter.preparations(),[]);assert.deepEqual(adapter.publicRecords(),[]);assert.throws(()=>adapter.verifyComplete());await assert.rejects(adapter.beginExecution('retry'));
	}finally{release();await adapter.close().catch(()=>{});}
});
test('an external preparation must belong to this exact connection and target',async()=>{
	const browser=new Browser('http://127.0.0.1:12345/form');
	for(const preparation of [
		{cdp:new Browser(browser.url),targetId:'unit-target'},
		{cdp:browser,targetId:'other-target'},
	])await assert.rejects(attachRequestWitness(browser,{targetId:'unit-target',pageURL:browser.url,verifyOwner:async()=>{},preparation:{...preparation,prepare:async()=>{throw new Error('must not be called');}}}));
	assert.deepEqual(browser.commands,[]);
});
test('a preparation cannot authorize a different document even if it returns a valid timestamp',async()=>{
	for(const field of ['id','loaderId','url']){
		const browser=new Browser('http://127.0.0.1:12345/form');
		const adapter=await attachRequestWitness(browser,{targetId:'unit-target',pageURL:browser.url,verifyOwner:async()=>{},preparation:{cdp:browser,targetId:'unit-target',prepare:async()=>({browserNotBefore:101,observation:{document:{id:'unit-frame',loaderId:'unit-loader',url:browser.url,[field]:'other'}}})}});
		try{await assert.rejects(adapter.beginExecution('wrong-document'));assert.deepEqual(adapter.preparations(),[]);assert.throws(()=>adapter.verifyComplete());}finally{await adapter.close().catch(()=>{});}
	}
});
test('cleanup waits for the whole preparation provider instead of only its child CDP requests',async()=>{
	const browser=new Browser('http://127.0.0.1:12345/form');let release!:()=>void,entered!:()=>void,active=false;
	const gate=new Promise<void>(yes=>{release=yes;}),waiting=new Promise<void>(yes=>{entered=yes;});
	const adapter=await attachRequestWitness(browser,{targetId:'unit-target',pageURL:browser.url,verifyOwner:async()=>{},preparation:{cdp:browser,targetId:'unit-target',async prepare(scope){active=true;entered();await gate;active=false;return{browserNotBefore:100,observation:{document:{id:scope.frameId,loaderId:scope.loaderId,url:scope.pageURL}}};}}});
	const begun=adapter.beginExecution('closing-input');const rejected=assert.rejects(begun,/closed or failed/);await waiting;
	let closed=false;const closing=adapter.close().then(()=>{closed=true;},error=>{closed=true;throw error;});const cleanupFailed=assert.rejects(closing,/cleanup failed/);
	await new Promise<void>(yes=>setTimeout(yes,20));assert.equal(active,true);assert.equal(closed,false);
	release();await rejected;await cleanupFailed;assert.equal(active,false);assert.deepEqual(adapter.preparations(),[]);
});
test('an expired synchronous preparation cannot briefly grant an old queued request a nonce',async()=>{
	for(const depth of [1,4,6,12]){
		const browser=new Browser('http://127.0.0.1:12345/form');let ownerChecks=0;
		const adapter=await attachRequestWitness(browser,{targetId:'unit-target',pageURL:browser.url,preparationTimeoutMs:20,preparation:{cdp:browser,targetId:'unit-target',async prepare(scope){return{browserNotBefore:100,observation:{document:{id:scope.frameId,loaderId:scope.loaderId,url:scope.pageURL}}};}},verifyOwner:async()=>{
			if(++ownerChecks!==4)return;const until=performance.now()+45;while(performance.now()<until){}
			const later=(remaining:number):void=>{if(remaining){queueMicrotask(()=>later(remaining-1));return;}browser.emit('Fetch.requestPaused',{requestId:'expired-fetch',networkId:'expired-network',frameId:'unit-frame',request:{method:'POST',url:'http://127.0.0.1:12345/api/form',postData:'{}',headers:{}}});};later(depth);
		}});
		try{await assert.rejects(adapter.beginExecution('expired'));await new Promise<void>(yes=>setImmediate(yes));assert.equal(browser.commands.filter(row=>row.method==='Fetch.continueRequest').length,0);assert.deepEqual(adapter.preparations(),[]);assert.deepEqual(adapter.publicRecords(),[]);}finally{await adapter.close().catch(()=>{});}
	}
});

for(const expires of [false,true])test('CDP ack before actual HTTP commit '+(expires?'fails within a real bound when commit is missing':'waits for the real private committed callback'),async()=>{
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-request-adapter-drain-'))),service=await signedFormService(root),browser=new Browser(service.url),adapter=await attach(browser);
	let release!:()=>void,entered!:()=>void;const held=new Promise<void>(yes=>{release=yes;}),committing=new Promise<void>(yes=>{entered=yes;});
	let http:Promise<Response>|undefined;
	service.bind({...adapter.authorization,committed:async(proof,signal)=>{entered();await held;await adapter.authorization.committed(proof,signal);}});
	try{
		await adapter.beginExecution('unit-drain');const body=JSON.stringify({name:'Own delayed commit',color:'Green',agree:true});
		browser.continuation=async params=>{
			const nonce=(params.headers as {name:string;value:string}[]).find(row=>row.name===REQUEST_PROOF_HEADER)!.value;
			browser.emit('Network.requestWillBeSentExtraInfo',{requestId:'network-drain',headers:{[REQUEST_PROOF_HEADER]:nonce}});
			http=fetch(service.origin+'/api/form',{method:'POST',headers:{[REQUEST_PROOF_HEADER]:nonce},body});return{};
		};
		browser.emit('Network.requestWillBeSent',{requestId:'network-drain',frameId:'unit-frame',loaderId:'unit-loader',documentURL:service.url,timestamp:100.01,request:{method:'POST',url:service.origin+'/api/form',postData:body}});
		browser.emit('Fetch.requestPaused',{requestId:'fetch-drain',networkId:'network-drain',frameId:'unit-frame',request:{method:'POST',url:service.origin+'/api/form',postData:body,headers:{}}});
		await committing;assert.equal(service.verify().filter(row=>row.kind==='form-committed').length,1);assert.equal(adapter.publicRecords()[0]?.stage,'accepted');
		const started=performance.now(),end=adapter.endExecution('unit-drain');let ended=false;void end.then(()=>{ended=true;},()=>{ended=true;});
		if(expires){
			await assert.rejects(end,/settlement deadline exceeded/);assert.ok(performance.now()-started>=2900&&performance.now()-started<5000);assert.throws(()=>adapter.verifyComplete());
			release();assert.equal((await http!).status,403);assert.equal(service.verify().filter(row=>row.kind==='form-committed').length,1,'durable effect is preserved, but never counts as a completed call');
		}else{
			await new Promise<void>(yes=>setTimeout(yes,25));assert.equal(ended,false,'CDP continuation ACK cannot substitute for HTTP completion');
			release();await end;assert.equal((await http!).status,200);adapter.verifyComplete();assert.equal(adapter.publicRecords()[0]?.stage,'committed');await adapter.close();await service.close();
		}
	}finally{release();await http?.catch(()=>{});await adapter.close().catch(()=>{});await service.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});
