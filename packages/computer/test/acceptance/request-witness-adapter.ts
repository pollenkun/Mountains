import assert from 'node:assert/strict';
import type {CdpEvent,CdpLike} from '../../src/web.ts';
import {BrowserRequestWitness,type RequestProof,type RequestScope} from './request-witness.ts';
import type {FormServiceAuthorization} from './signed-form-service.ts';
import type {RequestPreparation} from './witness-browser-observer.ts';

const object=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const identity=(value:unknown):string=>{assert.ok(typeof value==='string'&&value.length>0&&value.length<=256);return value;};

/** Controller-only side session. Never exported as a model tool. The caller
 * must independently attest its actual Chrome child, OS birth/executable,
 * endpoint/profile and focus monitoring in verifyOwner. This adapter binds
 * real CDP clock/events; it cannot certify that callback or replace UI proof. */
export async function attachRequestWitness(cdp:CdpLike,options:{targetId:string;pageURL:string;verifyOwner:()=>Promise<void>;preparation?:RequestPreparation;preparationTimeoutMs?:number}){
	const targetId=identity(options.targetId),page=new URL(options.pageURL);assert.equal(page.protocol,'http:');assert.equal(page.hostname,'127.0.0.1');assert.equal(page.username,'');assert.equal(page.password,'');
	const preparationLimit=options.preparationTimeoutMs??3000;assert.ok(Number.isInteger(preparationLimit)&&preparationLimit>0&&preparationLimit<=3000);if(options.preparation){assert.equal(options.preparation.cdp,cdp);assert.equal(options.preparation.targetId,targetId);}
	await options.verifyOwner();
	const target=object(object(await cdp.send('Target.getTargetInfo',{targetId},undefined,3000)).targetInfo);
	assert.equal(target.targetId,targetId);assert.equal(target.type,'page');assert.equal(target.url,page.href);
	const sessionId=identity(object(await cdp.send('Target.attachToTarget',{targetId,flatten:true},undefined,3000)).sessionId);
	let witness:BrowserRequestWitness|undefined,off:(()=>void)|undefined,failure:Error|undefined,closing:Promise<void>|undefined,beginning=false,ending=false;
	const work=new Set<Promise<unknown>>(),paused=new Set<string>();
	const preparations:Record<string,unknown>[]=[];
	const fail=()=>{failure??=new Error('private browser request observation failed');witness?.stop(failure);};
	const check=()=>{assert.ok(!closing&&!failure,'request adapter is closed or failed');};
	const track=<T>(promise:Promise<T>):Promise<T>=>{work.add(promise);void promise.then(()=>work.delete(promise),()=>{work.delete(promise);fail();});return promise;};
	const send=(method:string,params?:Record<string,unknown>)=>track(cdp.send(method,params,sessionId,3000));
	const owner=()=>track(Promise.resolve().then(()=>options.verifyOwner()));
	let scope:RequestScope;
	const frame=async()=>{
		const tree=object(object(await send('Page.getFrameTree')).frameTree),root=object(tree.frame);
		assert.equal(root.url,page.href);assert.ok(!root.parentId);return{frameId:identity(root.id),loaderId:identity(root.loaderId)};
	};
	try{
		await send('Page.enable');await send('Network.enable');await send('Performance.enable');
		scope={origin:page.origin,pageURL:page.href,targetId,sessionId,...await frame()};witness=new BrowserRequestWitness(scope);
		off=cdp.on((event:CdpEvent)=>{
			try{
				const command=witness!.observe(event);if(!command)return;
					assert.ok(!closing&&!failure&&!beginning,'request pause arrived outside ready input execution');
				paused.add(command.requestId);
				if(command.requiresProof)witness!.permitContinuation(command.requestId);
				// The nonce is sent only to Chrome. Neither commands nor plaintext
				// headers are returned through this private adapter's public data.
				const actual=send('Fetch.continueRequest',{requestId:command.requestId,headers:command.headers});
				void actual.then(()=>paused.delete(command.requestId),()=>{});
			}catch{fail();}
		});
		await send('Fetch.enable',{patterns:[{urlPattern:page.origin+'/api/*',requestStage:'Request'}]});await owner();check();
	}catch(error){
		fail();off?.();
		try{await cdp.send('Target.detachFromTarget',{sessionId},undefined,3000);}catch{/* Startup is failed even if observer cleanup also fails. */}
		throw error;
	}
	const authorization:FormServiceAuthorization={
		accept(request,signal){return track(Promise.resolve().then(async()=>{check();signal.throwIfAborted();const cancel=()=>witness!.stop(new Error('HTTP authorization cancelled'));signal.addEventListener('abort',cancel,{once:true});
			try{const proof=await witness!.accept(request);signal.throwIfAborted();check();return proof;}finally{signal.removeEventListener('abort',cancel);}}));},
		committed(proof:Readonly<RequestProof>,signal){return track(Promise.resolve().then(()=>{check();signal.throwIfAborted();const actual=witness!.publicRecords().find(row=>row.proof.fetchRequestId===proof.fetchRequestId);assert.ok(actual);assert.deepEqual(actual.proof,proof);witness!.committed(proof.fetchRequestId);}));},
		stop(){witness!.stop(new Error('HTTP service stopped'));},
	};
	return{scope:Object.freeze({...scope}),authorization,
		async beginExecution(id:string):Promise<{browserNotBefore:number;observation?:Record<string,unknown>}>{
			check();assert.ok(!beginning&&!ending,'request execution initialization or settlement already pending');beginning=true;
			let timer:ReturnType<typeof setTimeout>|undefined;const until=performance.now()+preparationLimit;
			try{
			const actual=track((async()=>{
				if(options.preparation){
					await owner();check();const value=await options.preparation.prepare(scope);check();assert.ok(typeof value.browserNotBefore==='number'&&Number.isFinite(value.browserNotBefore)&&value.browserNotBefore>=0);const observed=object(value.observation),document=object(observed.document);assert.equal(document.id,scope.frameId);assert.equal(document.loaderId,scope.loaderId);assert.equal(document.url,scope.pageURL);await owner();check();return structuredClone(value);
				}
				await owner();check();assert.deepEqual(await frame(),{frameId:scope.frameId,loaderId:scope.loaderId});check();
				const metrics=object(await send('Performance.getMetrics')).metrics;assert.ok(Array.isArray(metrics));
				const stamps=metrics.map(object).filter(row=>row.name==='Timestamp');assert.equal(stamps.length,1,'missing or ambiguous actual browser clock');
				const stamp=stamps[0]!.value;assert.ok(typeof stamp==='number'&&Number.isFinite(stamp)&&stamp>=0);await owner();check();
				return{browserNotBefore:stamp};
			})());
			const value=await Promise.race([actual,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error('input preparation exceeded independent deadline')),preparationLimit);})]);
			const record={id,at:Date.now(),...structuredClone(value)};
			check();assert.ok(performance.now()<until,'input preparation exceeded independent deadline');
			// No nonce-bearing continuation is possible until preparation has
			// actually finished within its independent absolute deadline.
			witness!.beginExecution(id,value.browserNotBefore);preparations.push(record);return value;
			}catch(error){fail();throw error;}finally{clearTimeout(timer);beginning=false;}
		},
		async endExecution(id:string):Promise<void>{
			check();assert.ok(!beginning&&!ending,'request execution initialization or settlement already pending');ending=true;
			const deadline=performance.now()+3000;
			try{
				// A CDP acknowledgement can precede HTTP arrival, durable write and
				// the private committed callback. Wait only for known real work;
				// do not poison the witness by calling endExecution prematurely.
				const settled=()=>{check();assert.ok(performance.now()<deadline,'browser request settlement deadline exceeded');return work.size===0&&paused.size===0&&witness!.executionSettled(id);};
				while(!settled())await new Promise<void>(yes=>setTimeout(yes,5));
				let timer:ReturnType<typeof setTimeout>|undefined;
				try{await Promise.race([owner(),new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error('browser ownership settlement deadline exceeded')),Math.max(1,deadline-performance.now()));})]);}finally{clearTimeout(timer);}
				while(!settled())await new Promise<void>(yes=>setTimeout(yes,5));
				witness!.endExecution(id);
			}catch(error){fail();throw error;}finally{ending=false;}
		},
		verifyComplete():void{check();assert.ok(!beginning&&!ending);assert.equal(work.size,0);assert.equal(paused.size,0);witness!.verifyComplete();},
		publicRecords:()=>witness!.publicRecords(),
		preparations:()=>structuredClone(preparations),
		close():Promise<void>{
			if(closing)return closing;
			const deadline=performance.now()+3000;
			closing=Promise.resolve().then(async()=>{
				const errors:unknown[]=[];
				try{witness!.verifyComplete();}catch(error){errors.push(error);}
				off?.();witness!.stop(new Error('private request adapter closed'));
				const bounded=async(run:()=>Promise<unknown>)=>{
					let timer:ReturnType<typeof setTimeout>|undefined;
					try{const actual=track(Promise.resolve().then(run));await Promise.race([actual,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error('private CDP cleanup deadline exceeded')),Math.max(1,deadline-performance.now()));})]);assert.ok(performance.now()<deadline);}
					catch(error){errors.push(error);}finally{clearTimeout(timer);}
				};
				// Settle real continuation commands before detaching our own session.
				const pending=[...work];await bounded(()=>Promise.allSettled(pending));
				for(const requestId of paused)await bounded(()=>cdp.send('Fetch.failRequest',{requestId,errorReason:'Aborted'},sessionId,Math.max(1,deadline-performance.now())));
				await bounded(()=>cdp.send('Fetch.disable',{},sessionId,Math.max(1,deadline-performance.now())));
				await bounded(()=>cdp.send('Target.detachFromTarget',{sessionId},undefined,Math.max(1,deadline-performance.now())));
				assert.ok(errors.length===0&&!failure&&work.size===0,'private browser request cleanup failed');
			});return closing;
		},
	};
}
