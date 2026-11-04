import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {signedFormService,type FormServiceAuthorization} from './acceptance/signed-form-service.ts';
import {BrowserRequestWitness,REQUEST_PROOF_HEADER} from './acceptance/request-witness.ts';

// Real owned loopback HTTP, but synthetic trusted browser observations. These
// tests prove service persistence/error handling, never Chrome/UI ownership.
async function setup(){
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-signed-form-component-'))),service=await signedFormService(root);
	return{root,service,remove:()=>rmSync(root,{recursive:true,force:true})};
}
function witnessFor(origin:string){return new BrowserRequestWitness({origin,pageURL:origin+'/form',targetId:'unit-target',sessionId:'unit-session',frameId:'unit-frame',loaderId:'unit-loader'});}
function proofFor(witness:BrowserRequestWitness,origin:string,body:string,index:number){
	const sessionId='unit-session',url=origin+'/api/form',requestId='fetch-'+index,networkId='network-'+index;
	witness.beginExecution('unit-execution-'+index,index);
	const command=witness.observe({sessionId,method:'Fetch.requestPaused',params:{requestId,networkId,frameId:'unit-frame',request:{method:'POST',url,postData:body,headers:{'content-type':'application/json'}}}})!;
	const nonce=command.headers.find(row=>row.name===REQUEST_PROOF_HEADER)!.value;
	witness.permitContinuation(requestId);
	witness.observe({sessionId,method:'Network.requestWillBeSent',params:{requestId:networkId,frameId:'unit-frame',loaderId:'unit-loader',documentURL:origin+'/form',timestamp:index,request:{method:'POST',url,postData:body}}});
	witness.observe({sessionId,method:'Network.requestWillBeSentExtraInfo',params:{requestId:networkId,headers:{[REQUEST_PROOF_HEADER]:nonce}}});
	return nonce;
}
function bind(witness:BrowserRequestWitness):FormServiceAuthorization{return{accept:request=>witness.accept(request),committed:proof=>witness.committed(proof.fetchRequestId),stop:()=>witness.stop()};}
const post=(origin:string,body:string,nonce?:string)=>fetch(origin+'/api/form',{method:'POST',headers:{'content-type':'application/json',...(nonce?{[REQUEST_PROOF_HEADER]:nonce}:{})},body});

test('owned HTTP form signs both real validation and durable exact submission before replying',async()=>{
	const {root,service,remove}=await setup(),witness=witnessFor(service.origin);service.bind(bind(witness));
	try{
		const html=await(await fetch(service.url)).text();assert.ok(html.includes('Submit form'));assert.ok(!html.includes(REQUEST_PROOF_HEADER)&&!html.includes('qa-token'));
		const invalid=JSON.stringify({name:'',color:'Blue',agree:false}),badNonce=proofFor(witness,service.origin,invalid,1);
		assert.equal((await post(service.origin,invalid,badNonce)).status,400);witness.endExecution('unit-execution-1');
		const fields={name:'Own 山川 🌍',color:'Green',agree:true},body=JSON.stringify(fields),nonce=proofFor(witness,service.origin,body,2);
		const response=await post(service.origin,body,nonce);assert.equal(response.status,200);
		assert.equal((await response.json() as {message:string}).message,'Submitted '+fields.name+' / Green / agreed');witness.endExecution('unit-execution-2');witness.verifyComplete();
		const rows=service.verify();assert.deepEqual(rows.map(row=>row.kind),['service-start','request-received','form-invalid','request-received','form-committed']);
		assert.deepEqual((rows.at(-1)!.forms as Record<string,unknown>[]).map(({id,...data})=>data),[fields]);
		const actual=await(await fetch(service.origin+'/api/state')).json() as {forms:unknown};assert.deepEqual(actual.forms,rows.at(-1)!.forms);
		const bytes=readFileSync(service.journalPath,'utf8');assert.ok(!bytes.includes(nonce)&&!bytes.includes(badNonce));service.assertHealthy();
		await service.close();assert.ok(readFileSync(service.journalPath,'utf8').includes('service-stop'));
		await assert.rejects(fetch(service.url));
	}finally{await service.close().catch(()=>{});remove();}
});
test('reading the public page cannot authorize a POST and a failed request stays failed through close',async()=>{
	const {service,remove}=await setup();
	try{
		assert.equal((await fetch(service.url)).status,200);
		assert.equal((await post(service.origin,JSON.stringify({name:'forged',color:'Green',agree:true}),'public-page-token')).status,403);
		assert.throws(()=>service.assertHealthy());assert.ok(!service.verify().some(row=>row.kind==='form-committed'));
		await assert.rejects(service.close());await assert.rejects(fetch(service.url));
	}finally{await service.close().catch(()=>{});remove();}
});
test('private request proof replay cannot make a second durable form record',async()=>{
	const {service,remove}=await setup(),witness=witnessFor(service.origin);service.bind(bind(witness));
	try{
		const body=JSON.stringify({name:'Own once',color:'Green',agree:true}),nonce=proofFor(witness,service.origin,body,1);
		assert.equal((await post(service.origin,body,nonce)).status,200);
		assert.equal((await post(service.origin,body,nonce)).status,403);
		assert.equal(service.verify().filter(row=>row.kind==='form-committed').length,1);assert.throws(()=>service.assertHealthy());
	}finally{await service.close().catch(()=>{});remove();}
});
test('an array-shaped color stays invalid like the original form service',async()=>{
	const {service,remove}=await setup(),witness=witnessFor(service.origin);service.bind(bind(witness));
	try{
		const body=JSON.stringify({name:'Own invalid array',color:['Green'],agree:true}),nonce=proofFor(witness,service.origin,body,1);
		assert.equal((await post(service.origin,body,nonce)).status,400);witness.endExecution('unit-execution-1');witness.verifyComplete();
		assert.equal(service.verify().filter(row=>row.kind==='form-committed').length,0);service.assertHealthy();await service.close();
	}finally{await service.close().catch(()=>{});remove();}
});
test('reentrant close shares one real cleanup and cannot close its journal twice',async()=>{
	const {service,remove}=await setup();let stops=0,nested:Promise<void>|undefined;
	service.bind({accept:async()=>assert.fail('no HTTP write'),committed:()=>assert.fail('no commit'),stop:()=>{stops++;nested=service.close();}});
	try{
		const outer=service.close();await outer;assert.equal(nested,outer);assert.equal(stops,1);await nested;
		assert.equal(readFileSync(service.journalPath,'utf8').split('\n').filter(line=>line.includes('service-stop')).length,1);await assert.rejects(fetch(service.url));
	}finally{await service.close().catch(()=>{});remove();}
});
test('changed or replaced service journal cannot become a verified state',async()=>{
	for(const replace of [false,true]){
		const {service,remove}=await setup();
		try{
			if(replace)renameSync(service.journalPath,service.journalPath+'.old');
			writeFileSync(service.journalPath,'forged\n');assert.throws(()=>service.verify());assert.throws(()=>service.assertHealthy());
			await assert.rejects(service.close());await assert.rejects(fetch(service.url));
		}finally{await service.close().catch(()=>{});remove();}
	}
});
test('closing during authorization prevents a late approval from committing and still closes HTTP',async()=>{
	const {service,remove}=await setup();let ready!:()=>void,approve!:(value:never)=>void;
	const entered=new Promise<void>(yes=>{ready=yes;});
	service.bind({accept:()=>{ready();return new Promise<never>(yes=>{approve=yes;});},committed:()=>assert.fail('no late commit'),stop:()=>{throw new Error('injected stop failure');}});
	try{
		const request=post(service.origin,'{}','unit-only-unapproved');await entered;
		const closing=service.close();let ended=false;void closing.then(()=>{ended=true;},()=>{ended=true;});assert.equal((await request).status,403);
		await new Promise(yes=>setImmediate(yes));assert.equal(ended,false,'HTTP cancellation alone must not claim the actual authorization ended');
		approve({} as never);await assert.rejects(closing);
		assert.ok(!readFileSync(service.journalPath,'utf8').includes('form-committed'));await assert.rejects(fetch(service.url));
	}finally{await service.close().catch(()=>{});remove();}
});
test('acknowledgment failure preserves an already durable effect while failing the run',async()=>{
	const {service,remove}=await setup(),witness=witnessFor(service.origin);
	service.bind({...bind(witness),committed:()=>{throw new Error('injected ack failure');}});
	try{
		const body=JSON.stringify({name:'Durable before ack',color:'Blue',agree:true}),nonce=proofFor(witness,service.origin,body,1);
		assert.equal((await post(service.origin,body,nonce)).status,403);
		const commits=service.verify().filter(row=>row.kind==='form-committed');assert.equal(commits.length,1);
		assert.equal((commits[0]!.forms as {name:string}[])[0]!.name,'Durable before ack');assert.throws(()=>service.assertHealthy());
	}finally{await service.close().catch(()=>{});remove();}
});
test('asynchronous acknowledgment is awaited and its rejection cannot become HTTP success',async()=>{
	const {service,remove}=await setup(),witness=witnessFor(service.origin);let enter!:()=>void,release!:()=>void;
	const entered=new Promise<void>(yes=>{enter=yes;}),gate=new Promise<void>(yes=>{release=yes;});
	service.bind({...bind(witness),committed:async()=>{enter();await gate;throw new Error('async ack rejected');}});
	try{
		const body=JSON.stringify({name:'Durable async',color:'Green',agree:true}),nonce=proofFor(witness,service.origin,body,1);
		const request=post(service.origin,body,nonce);let replied=false;void request.then(()=>{replied=true;});
		await entered;assert.equal(replied,false);release();assert.equal((await request).status,403);
		assert.equal(service.verify().filter(row=>row.kind==='form-committed').length,1);assert.throws(()=>service.assertHealthy());await assert.rejects(service.close());
	}finally{release();await service.close().catch(()=>{});remove();}
});
test('asynchronous stop is awaited and its rejection makes close fail after HTTP actually closes',async()=>{
	const {service,remove}=await setup();let enter!:()=>void,release!:()=>void;
	const entered=new Promise<void>(yes=>{enter=yes;}),gate=new Promise<void>(yes=>{release=yes;});
	service.bind({accept:async()=>assert.fail('no writes'),committed:()=>assert.fail('no writes'),stop:async()=>{enter();await gate;throw new Error('async stop rejected');}});
	try{
		const closing=service.close();let ended=false;void closing.then(()=>{ended=true;},()=>{ended=true;});
		await entered;await new Promise(yes=>setImmediate(yes));assert.equal(ended,false);release();await assert.rejects(closing);await assert.rejects(fetch(service.url));
	}finally{release();await service.close().catch(()=>{});remove();}
});
test('a synchronously blocked stop cannot extend the close deadline or sign a clean stop',async()=>{
	const {service,remove}=await setup();
	service.bind({accept:async()=>assert.fail('no writes'),committed:()=>assert.fail('no writes'),stop:()=>{const end=performance.now()+2100;while(performance.now()<end){/* injected blocking callback */}}});
	try{
		await assert.rejects(service.close());assert.ok(!readFileSync(service.journalPath,'utf8').includes('service-stop'));await assert.rejects(fetch(service.url));
	}finally{await service.close().catch(()=>{});remove();}
});
