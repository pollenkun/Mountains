import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import type {CdpEvent} from '../../src/web.ts';
import {sha256} from './integrity.ts';

export const REQUEST_PROOF_HEADER = 'x-mountains-request-proof';
export interface RequestScope {
	origin:string; pageURL:string; targetId:string; sessionId:string; frameId:string; loaderId:string;
}
export interface RequestProof {
	permissionExecutionId:string; browserNotBefore:number;browserRequestTimestamp?:number;targetId:string; sessionId:string; frameId:string; loaderId:string;
	fetchRequestId:string; networkRequestId:string; method:'POST'; url:string; bodySha256:string; nonceSha256:string;
}
interface PendingRequest {
	proof:Readonly<RequestProof>; nonce:string; expires:number; continued:boolean;
	stage:'prepared'|'waiting'|'accepted'|'committed';
	wake?:()=>void;
}
interface NetworkRequest {permissionExecutionId:string;timestamp:number;url:string;method:string;bodySha256:string}
interface ExtraInfo {count:number;nonce:string|undefined}
const object=(value:unknown):Record<string,unknown>=>{
	assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'missing request object');
	const prototype=Object.getPrototypeOf(value);assert.ok(prototype===Object.prototype||prototype===null,'request object is not protocol data');
	assert.ok(Reflect.ownKeys(value).length<=512&&Reflect.ownKeys(value).every(key=>typeof key==='string'),'invalid request object keys');
	assert.ok(Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor=>'value' in descriptor),'request protocol accessors are refused');
	return value as Record<string,unknown>;
};
const id=(value:unknown):string=>{assert.ok(typeof value==='string'&&value.length>0&&value.length<=256,'missing bounded request identity');return value;};
const body=(value:unknown):string=>{assert.ok(typeof value==='string'&&Buffer.byteLength(value)<=32000,'missing complete request body');return value;};
const headers=(value:unknown):Record<string,string>=>{
	const raw=object(value),result:Record<string,string>={};
	assert.ok(Object.keys(raw).length<=128,'too many request headers');
	for(const [name,value]of Object.entries(raw)){
		assert.ok(name.length>0&&name.length<=256&&typeof value==='string'&&value.length<=16384,'invalid request header');
		const lower=name.toLowerCase();assert.ok(!(lower in result),'duplicate request header');result[lower]=value;
	}
	return result;
};

/** Correlates trusted controller observations. This is NOT an OS sender probe,
 * a CDP ownership check, a signed server journal, or proof of UI causality.
 * The runtime adapter must establish those boundaries before using this class.
 * Nothing here runs a page script, sends a CDP command or changes server data. */
export class BrowserRequestWitness {
	private readonly scope:Readonly<RequestScope>;
	private readonly pending=new Map<string,PendingRequest>();
	private readonly network=new Map<string,Readonly<NetworkRequest>>();
	private readonly extra=new Map<string,ExtraInfo>();
	private readonly executions=new Set<string>();
	private readonly now:()=>number;
	private readonly ttl:number;
	private readonly waitMs:number;
	private active:string|undefined;
	private browserNotBefore:number|undefined;
	private previousNow=0;
	private failure:Error|undefined;
	constructor(scope:RequestScope,options:{now?:()=>number;ttlMs?:number;waitMs?:number}={}){
		const origin=new URL(scope.origin),page=new URL(scope.pageURL);
		assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');assert.equal(origin.origin,scope.origin);
		assert.equal(page.origin,scope.origin);assert.equal(page.username,'');assert.equal(page.password,'');
		for(const value of [scope.targetId,scope.sessionId,scope.frameId,scope.loaderId])id(value);
		this.scope=Object.freeze({...scope});this.now=options.now??(()=>performance.now());
		this.ttl=options.ttlMs??5000;this.waitMs=options.waitMs??2000;
		assert.ok(Number.isFinite(this.ttl)&&this.ttl>0&&Number.isFinite(this.waitMs)&&this.waitMs>0&&this.waitMs<=this.ttl);
	}
	private check():number{
		if(this.failure)throw this.failure;
		const now=this.now();assert.ok(Number.isFinite(now)&&now>=this.previousNow,'request clock reversed or became unknown');this.previousNow=now;return now;
	}
	private failed(error:unknown):never{
		this.stop(error);throw this.failure;
	}
	/** Cancellation revokes every outstanding claim without waiting for a new
	 * browser event. Cleanup callers can invoke it without throwing. */
	stop(error:unknown=new Error('request witness stopped')):void{
		let reason='request witness stopped';
		try{if(error instanceof Error){const descriptor=Object.getOwnPropertyDescriptor(error,'message');if(typeof descriptor?.value==='string')reason=descriptor.value.slice(0,1024);}}catch{/* An unprintable cancellation reason must still revoke permission. */}
		this.failure??=new Error(reason);
		for(const entry of this.pending.values())entry.wake?.();
	}
	private ownURL(value:unknown):boolean{
		if(typeof value!=='string')return false;
		try{const url=new URL(value);return url.origin===this.scope.origin&&url.pathname.startsWith('/api/');}catch{return false;}
	}
	/** browserNotBefore must come from an attested, read-only browser-clock
	 * sample received before dispatch. It rejects delayed old events; it does
	 * not prove that an asynchronous request was caused by this UI action. */
	beginExecution(executionId:string,browserNotBefore:number):void{
		try{this.check();id(executionId);assert.equal(this.active,undefined,'a previous UI execution is still open');
			assert.ok(Number.isFinite(browserNotBefore)&&browserNotBefore>=0,'missing trusted browser-clock lower bound');
			assert.ok(this.browserNotBefore===undefined||browserNotBefore>=this.browserNotBefore,'browser-clock lower bound reversed');
			assert.ok(!this.executions.has(executionId)&&this.executions.size<512,'UI execution identity was reused or limit reached');this.executions.add(executionId);this.active=executionId;this.browserNotBefore=browserNotBefore;
		}catch(error){this.failed(error);}
	}
	/** Call with events from the attested CDP session only. The returned secret
	 * belongs only in Fetch.continueRequest, never in a model/tool/file log. */
	observe(event:CdpEvent):{requestId:string;requiresProof:boolean;headers:{name:string;value:string}[]}|undefined{
		try{
			object(event);
			const now=this.check();assert.notEqual(event.method,'Mountains.connectionClosed','request observation connection closed');
			assert.ok(!(event.method==='Target.detachedFromTarget'&&event.params.sessionId===this.scope.sessionId),'request observation target detached');
			if(event.sessionId!==this.scope.sessionId)return;
			const p=object(event.params);
			assert.ok(!(event.method==='Page.frameDetached'&&p.frameId===this.scope.frameId),'request observation frame detached');
			assert.notEqual(event.method,'Inspector.detached','request observation inspector detached');
			if(event.method==='Page.frameNavigated'&&object(p.frame).id===this.scope.frameId)assert.equal(object(p.frame).loaderId,this.scope.loaderId,'request observation document changed');
			if(event.method==='Page.navigatedWithinDocument'&&p.frameId===this.scope.frameId)assert.equal(p.url,this.scope.pageURL,'request observation URL changed');
			if(event.method==='Fetch.requestPaused'){
				const request=object(p.request);if(!this.ownURL(request.url))return;
				const original=headers(request.headers);assert.ok(!(REQUEST_PROOF_HEADER in original),'the page supplied a private request proof');
				assert.ok(p.responseStatusCode===undefined&&p.responseErrorReason===undefined,'response-stage pause cannot authorize a request');
				if(request.method==='GET')return{requestId:id(p.requestId),requiresProof:false,headers:Object.entries(original).map(([name,value])=>({name,value}))};
				assert.ok(this.active,'API request has no permitted UI execution');
				assert.equal(p.frameId,this.scope.frameId,'API request belongs to another frame');assert.equal(request.method,'POST');
				const fetch=id(p.requestId),network=id(p.networkId);
				assert.ok(!this.pending.has(fetch)&&![...this.pending.values()].some(row=>row.proof.networkRequestId===network),'request pause repeated or redirected');
				assert.ok(this.pending.size<128,'request witness limit');
				const nonce=randomBytes(32).toString('hex'),proof=Object.freeze({permissionExecutionId:this.active,browserNotBefore:this.browserNotBefore!,targetId:this.scope.targetId,sessionId:this.scope.sessionId,frameId:this.scope.frameId,loaderId:this.scope.loaderId,
					fetchRequestId:fetch,networkRequestId:network,method:'POST' as const,url:String(request.url),bodySha256:sha256(body(request.postData)),nonceSha256:sha256(nonce)});
				this.pending.set(fetch,{proof,nonce,expires:now+this.ttl,continued:false,stage:'prepared'});
				return{requestId:fetch,requiresProof:true,headers:[...Object.entries(original).map(([name,value])=>({name,value})),{name:REQUEST_PROOF_HEADER,value:nonce}]};
			}
			if(event.method==='Network.requestWillBeSent'){
				const request=object(p.request);if(!this.ownURL(request.url))return;
				if(request.method==='GET')return;
				assert.ok(this.active,'network request has no permitted UI execution');
				assert.equal(p.frameId,this.scope.frameId);assert.equal(p.loaderId,this.scope.loaderId,'request belongs to another document generation');
				assert.equal(p.documentURL,this.scope.pageURL);assert.equal(request.method,'POST');body(request.postData);
				assert.ok(typeof p.timestamp==='number'&&Number.isFinite(p.timestamp)&&p.timestamp>=this.browserNotBefore!,'network event predates the permitted execution or has no browser timestamp');
				const requestId=id(p.requestId);assert.ok(!this.network.has(requestId)&&p.redirectResponse===undefined,'redirect/reused network request is not witnessed');
				assert.ok(this.network.size<128);this.network.set(requestId,Object.freeze({permissionExecutionId:this.active,timestamp:p.timestamp,url:String(request.url),method:String(request.method),bodySha256:sha256(body(request.postData))}));
			}
			if(event.method==='Network.requestWillBeSentExtraInfo'){
				const actual=headers(p.headers),nonce=actual[REQUEST_PROOF_HEADER],requestId=id(p.requestId),prior=this.extra.get(requestId);
				assert.ok(this.extra.size<512||prior,'wire evidence limit');this.extra.set(requestId,{count:(prior?.count??0)+1,nonce});
				const entry=[...this.pending.values()].find(row=>row.proof.networkRequestId===requestId);
				if(nonce){const issued=[...this.pending.values()].find(row=>row.nonce===nonce);assert.ok(issued,'wire headers contain an unissued private proof');assert.equal(requestId,issued.proof.networkRequestId,'Fetch and Network identities differ');}
				if(entry){assert.ok(!prior,'wire header event repeated');assert.ok(nonce===entry.nonce,'actual wire headers are missing the private proof');assert.ok(entry.continued,'request appeared before continuation was permitted');}
			}
			for(const entry of this.pending.values())entry.wake?.();
		}catch(error){this.failed(error);}
	}
	permitContinuation(fetchRequestId:string):void{
		try{const now=this.check();const entry=this.pending.get(fetchRequestId);assert.ok(entry);assert.equal(entry.stage,'prepared');assert.equal(entry.proof.permissionExecutionId,this.active);
			assert.equal(entry.continued,false,'request continuation repeated');assert.ok(now<entry.expires,'request proof expired');entry.continued=true;
		}catch(error){this.failed(error);}
	}
	/** Atomically claims the secret before waiting for out-of-order wire events.
	 * The server must still verify its private controller channel, OS ownership,
	 * and durable journal before applying an effect. This receipt alone is not
	 * a committed HTTP request and must never be counted as a saved result. */
	async accept(received:{nonce:string;method:string;url:string;body:Uint8Array}):Promise<Readonly<RequestProof>>{
		let timer:ReturnType<typeof setTimeout>|undefined,entry:PendingRequest|undefined;
		try{
			object(received);
			const now=this.check();assert.ok(typeof received.nonce==='string'&&/^[a-f0-9]{64}$/.test(received.nonce),'missing private request proof');
			entry=[...this.pending.values()].find(row=>row.nonce===received.nonce);assert.ok(entry,'unissued request proof');
			assert.equal(entry.stage,'prepared','request proof was already claimed');assert.ok(entry.continued,'request continuation was not permitted');
			assert.equal(entry.proof.permissionExecutionId,this.active);assert.equal(received.method,entry.proof.method);assert.equal(received.url,entry.proof.url);
			assert.ok(now<entry.expires,'request proof expired');
			assert.ok(received.body instanceof Uint8Array&&received.body.byteLength<=32000,'server must supply complete raw request bytes');
			assert.equal(sha256(received.body),entry.proof.bodySha256,'received bytes differ from the paused request');
			entry.stage='waiting';
			const waitUntil=Math.min(entry.expires,now+this.waitMs);
			await new Promise<void>((resolve,reject)=>{
				const ready=()=>{try{const current=this.check();assert.ok(current<entry!.expires,'request proof expired');assert.ok(current<waitUntil,'wire request wait deadline exceeded');if(this.network.has(entry!.proof.networkRequestId)&&this.extra.has(entry!.proof.networkRequestId))resolve();}catch(error){reject(error);}};
				entry!.wake=ready;timer=setTimeout(()=>reject(new Error('wire request evidence is incomplete')),Math.min(this.waitMs,Math.max(1,entry!.expires-now)));ready();
			});
			const current=this.check();assert.equal(entry.proof.permissionExecutionId,this.active);assert.ok(current<entry.expires,'request proof expired');assert.ok(current<waitUntil,'wire request wait deadline exceeded');
			assert.equal(received.method,entry.proof.method);assert.equal(received.url,entry.proof.url);assert.equal(sha256(received.body),entry.proof.bodySha256,'received bytes changed while awaiting evidence');
			const network=this.network.get(entry.proof.networkRequestId),wire=this.extra.get(entry.proof.networkRequestId);assert.ok(network&&wire);assert.equal(network.permissionExecutionId,entry.proof.permissionExecutionId);
			assert.equal(wire.count,1,'extra wire requests were observed');assert.ok(wire.nonce===entry.nonce,'wire request proof differs');
				assert.equal(network.url,entry.proof.url);assert.equal(network.method,entry.proof.method);assert.equal(network.bodySha256,entry.proof.bodySha256);
			entry.proof=Object.freeze({...entry.proof,browserRequestTimestamp:network.timestamp});entry.stage='accepted';return entry.proof;
		}catch(error){return this.failed(error);}finally{clearTimeout(timer);if(entry)delete entry.wake;}
	}
	/** Only after the controller independently verifies the server's signed,
	 * durable completion record; callers cannot infer this from accept(). */
	committed(fetchRequestId:string):void{
		try{this.check();const entry=this.pending.get(fetchRequestId);assert.ok(entry);assert.equal(entry.proof.permissionExecutionId,this.active);assert.equal(entry.stage,'accepted');entry.stage='committed';}
		catch(error){this.failed(error);}
	}
	endExecution(executionId:string):void{
		try{this.check();assert.equal(this.active,executionId);const own=[...this.pending.values()].filter(row=>row.proof.permissionExecutionId===executionId);
			assert.ok(own.every(row=>row.stage==='committed'),'request has no independently committed server record');
			assert.ok([...this.network].filter(([,row])=>row.permissionExecutionId===executionId).every(([id])=>own.some(row=>row.proof.networkRequestId===id)),'network request has no matching paused request');this.active=undefined;}
		catch(error){this.failed(error);}
	}
	/** Read-only readiness for the adapter's bounded HTTP drain. An accepted
	 * request is not complete merely because Chrome acknowledged continuation. */
	executionSettled(executionId:string):boolean{
		this.check();assert.equal(this.active,executionId);
		const own=[...this.pending.values()].filter(row=>row.proof.permissionExecutionId===executionId);
		return own.every(row=>row.stage==='committed')&&[...this.network].filter(([,row])=>row.permissionExecutionId===executionId).every(([id])=>own.some(row=>row.proof.networkRequestId===id));
	}
	/** No nonce or body plaintext is exposed to persistent logs. */
	publicRecords():{proof:Readonly<RequestProof>;stage:string}[]{return[...this.pending.values()].map(row=>({proof:row.proof,stage:row.stage}));}
	verifyComplete():void{
		try{this.check();assert.equal(this.active,undefined,'a UI execution has not ended');
			assert.ok([...this.pending.values()].every(row=>row.stage==='committed'),'request evidence is not committed');
			assert.equal(this.network.size,this.pending.size,'unmatched network request evidence');
		}catch(error){this.failed(error);}
	}
}
