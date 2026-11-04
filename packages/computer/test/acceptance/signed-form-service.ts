import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,openSync,readFileSync,readdirSync,realpathSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {REQUEST_PROOF_HEADER,type RequestProof} from './request-witness.ts';
import {sha256} from './integrity.ts';
import {AsyncFixture,ASYNC_PAGE} from './async-fixture.ts';
import {TaskFixture,TASK_PAGE,type DeleteTaskAuthorization} from './task-fixture.ts';
import {RecordsFixture,RECORDS_PAGE} from './records-fixture.ts';
import {DetailFixture,DETAIL_PAGE,DETAIL_NAV} from './detail-fixture.ts';

interface FormRecord{id:string;name:string;color:string;agree:true}
export interface FormServiceAuthorization{
 authorizeTaskDeletion?:DeleteTaskAuthorization;
	accept(request:{nonce:string;method:string;url:string;body:Uint8Array},signal:AbortSignal):Promise<Readonly<RequestProof>>;
	committed(proof:Readonly<RequestProof>,signal:AbortSignal):void|Promise<void>;
	stop():void|Promise<void>;
}
type JournalRow=Record<string,unknown>;

/** Private controller-owned HTTP fixture for the unchanged case6 form. It
 * never grants itself Chrome identity or UI causality. The parent must attest
 * its browser/CDP channel and supply the one-shot authorization before input.
 * No public page token, environment or file contains the signing/proof keys.
 * This component is not yet an entry point for formal desktop acceptance. */
export async function signedFormService(directory:string,scenario:'form'|'async'|'tasks'|'records'|'detail'='form'){
	assert.ok(scenario==='form'||scenario==='async'||scenario==='tasks'||scenario==='records'||scenario==='detail');
	assert.equal(realpathSync(directory),directory,'form fixture directory must be canonical');
	assert.equal(readdirSync(directory).length,0,'form fixture requires a fresh empty directory');
	const path=join(directory,'signed-form-events.jsonl'),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
	const identity=fstatSync(fd),key=randomBytes(32),forms:FormRecord[]=[];
	let sequence=0,observed='',journalBytes='',failure:Error|undefined,closing:Promise<void>|undefined,authorization:FormServiceAuthorization|undefined,active=0,closed=false;
	const lifetime=new AbortController(),used=new Set<string>(),authorizationWork=new Set<Promise<unknown>>();
	const fail=()=>{failure??=new Error('signed form service failed; effects must be independently checked');};
	const sameFile=()=>{const stat=lstatSync(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.dev,identity.dev);assert.equal(stat.ino,identity.ino);assert.equal(stat.nlink,1);};
	const append=(kind:string,fields:JournalRow={})=>{
		assert.ok(!closed,'form journal is closed');sameFile();
		const row={...fields,sequence:++sequence,at:Date.now(),pid:process.pid,kind},payload=Buffer.from(JSON.stringify(row));
		const line=JSON.stringify({...row,signedPayload:payload.toString('base64'),signature:createHmac('sha256',key).update(payload).digest('hex')})+'\n';
		const bytes=Buffer.from(line);let offset=0;
		while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);assert.ok(count>0,'form journal write made no progress');offset+=count;}
		fsyncSync(fd);journalBytes+=line;
	};
	const verify=():JournalRow[]=>{
		try{
			sameFile();const input=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:Buffer;
			try{const stat=fstatSync(input);assert.equal(stat.dev,identity.dev);assert.equal(stat.ino,identity.ino);raw=readFileSync(input);}finally{closeSync(input);}
			assert.ok(raw.equals(Buffer.from(journalBytes)),'signed form journal bytes were changed');const bytes=raw.toString('utf8');
			assert.equal(bytes,journalBytes,'signed form journal was changed or truncated');assert.ok(bytes.startsWith(observed));assert.ok(bytes.endsWith('\n'));
			const rows=bytes.trimEnd().split('\n').map((line,index)=>{
				const {signedPayload,signature,...row}=JSON.parse(line);assert.ok(typeof signedPayload==='string'&&typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature));
				const payload=Buffer.from(signedPayload,'base64');assert.equal(payload.toString('base64'),signedPayload);assert.deepEqual(JSON.parse(payload.toString('utf8')),row);
				assert.ok(timingSafeEqual(createHmac('sha256',key).update(payload).digest(),Buffer.from(signature,'hex')));assert.equal(row.sequence,index+1);assert.equal(row.pid,process.pid);return row;
			});observed=bytes;return rows;
		}catch{fail();throw failure;}
	};
	const callback=async<T>(run:()=>T|Promise<T>):Promise<T>=>{
		lifetime.signal.throwIfAborted();const deadline=performance.now()+2000;
		let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
		try{
			const actual=Promise.resolve().then(()=>{lifetime.signal.throwIfAborted();return run();});
			authorizationWork.add(actual);void actual.then(()=>authorizationWork.delete(actual),()=>authorizationWork.delete(actual));
			const proof=await Promise.race([actual,new Promise<never>((_,no)=>{
				abort=()=>no(new Error('form service authorization cancelled'));lifetime.signal.addEventListener('abort',abort,{once:true});
				timer=setTimeout(()=>no(new Error('form service authorization timed out')),2000);
			})]);
			lifetime.signal.throwIfAborted();assert.ok(performance.now()<deadline,'form authorization exceeded its real deadline');return proof;
		}finally{clearTimeout(timer);if(abort)lifetime.signal.removeEventListener('abort',abort);}
	};
	const asynchronous=scenario==='async'?new AsyncFixture((kind,fields)=>{append(kind,fields);verify();},fail):undefined;
	const tasks=scenario==='tasks'?new TaskFixture((kind,fields)=>{append(kind,fields);verify();},(task,state,proof)=>{assert.ok(authorization?.authorizeTaskDeletion,'no individual deletion authorizer');return authorization.authorizeTaskDeletion(task,state,proof);}):undefined;
	const records=scenario==='records'?new RecordsFixture((kind,fields)=>{append(kind,fields);verify();}):undefined;
	const detail=scenario==='detail'?new DetailFixture((kind,fields)=>{append(kind,fields);verify();}):undefined;
	const send=(res:ServerResponse,code:number,value:unknown)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(closing?{connection:'close'}:{})});res.end(JSON.stringify(value));};
	const server=createServer((req,res)=>{void(async()=>{
		active++;let received=false;
		try{
			assert.ok(!closing&&!failure,'form service is stopping or failed');
			const address=server.address();assert.ok(address&&typeof address==='object');
			const origin='http://127.0.0.1:'+address.port,url=new URL(req.url??'/',origin);
			assert.equal(req.headers.host,'127.0.0.1:'+address.port,'form request has another Host');assert.equal(url.origin,origin);
			if(req.method==='GET'){
				if(url.pathname==='/api/state')return send(res,200,detail?detail.snapshot():records?records.snapshot():tasks?tasks.snapshot():asynchronous?asynchronous.snapshot():{forms});
				if(detail?!['/form','/detail'].includes(url.pathname):url.pathname!==(records?'/records':tasks?'/tasks':asynchronous?'/async':'/form'))return send(res,404,{error:'not found'});
				res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'"});
				return res.end(detail?(url.pathname==='/detail'?DETAIL_PAGE:FORM_PAGE.replace('<h1>Form validation</h1>',DETAIL_NAV+'<h1>Form validation</h1>')):records?RECORDS_PAGE:tasks?TASK_PAGE:asynchronous?ASYNC_PAGE:FORM_PAGE);
			}
			assert.equal(req.method,'POST');assert.ok(detail?url.pathname==='/api/detail':records?url.pathname==='/api/records':tasks?url.pathname==='/api/tasks':asynchronous?['/api/retry','/api/job/start','/api/job/cancel'].includes(url.pathname):url.pathname==='/api/form');assert.equal(url.search,'');
			const chunks:Buffer[]=[];let length=0;
			for await(const chunk of req){length+=chunk.length;assert.ok(length<=32000,'form body is too large');chunks.push(Buffer.from(chunk));}
			const body=Buffer.concat(chunks),nonce=req.headers[REQUEST_PROOF_HEADER];
			append('request-received',{method:req.method,url:url.href,bodySha256:sha256(body),bytes:body.length,nonceSha256:typeof nonce==='string'?sha256(nonce):null});received=true;
			assert.ok(authorization,'private browser authorization is not installed');assert.ok(typeof nonce==='string');
			const proof=await callback(()=>authorization!.accept({nonce,method:req.method!,url:url.href,body},lifetime.signal));
			assert.ok(!closing&&!failure,'form service stopped while authorization was pending');
			assert.equal(proof.method,req.method);assert.equal(proof.url,url.href);assert.equal(proof.bodySha256,sha256(body));assert.equal(proof.nonceSha256,sha256(nonce));
			assert.ok(!used.has(proof.fetchRequestId)&&used.size<128,'form request proof was reused or limit reached');used.add(proof.fetchRequestId);
			const data=JSON.parse(body.toString('utf8')) as Record<string,unknown>;
			if(detail){const outcome=detail.apply(data,proof);await callback(()=>authorization!.committed(proof,lifetime.signal));return send(res,outcome.code,outcome.body);}
			if(records){const outcome=records.apply(data,proof);await callback(()=>authorization!.committed(proof,lifetime.signal));return send(res,outcome.code,outcome.body);}
			if(tasks){const outcome=tasks.apply(data,proof);await callback(()=>authorization!.committed(proof,lifetime.signal));return send(res,outcome.code,outcome.body);}
			if(asynchronous){const outcome=asynchronous.apply(url.pathname,data,proof);await callback(()=>authorization!.committed(proof,lifetime.signal));return send(res,outcome.code,outcome.body);}
			const valid=Object.keys(data).sort().join(',')==='agree,color,name'&&typeof data.name==='string'&&data.name.trim().length>0&&typeof data.color==='string'&&['Blue','Green','Red'].includes(data.color)&&data.agree===true;
			const record:FormRecord|undefined=valid?{id:randomUUID(),name:data.name as string,color:data.color as string,agree:true}:undefined;
			const next=record?[...forms,record]:[...forms];
			// fsync the signed outcome and its full resulting state before claiming
			// any HTTP success. A later acknowledgment error remains a failed run.
			append(record?'form-committed':'form-invalid',{proof,forms:next});verify();
			if(record)forms.push(record);
			await callback(()=>authorization!.committed(proof,lifetime.signal));
			if(!record)return send(res,400,{error:'Name, color and agreement are required'});
			return send(res,200,{message:'Submitted '+record.name+' / '+record.color+' / agreed',record});
		}catch{
			fail();try{append('request-rejected',{received});}catch{/* No successful verdict can follow a failed journal. */}
			if(!res.headersSent)send(res,403,{error:'private request authorization failed'});else res.destroy();
		}finally{active--;}
	})();});
	server.requestTimeout=5000;server.headersTimeout=5000;
	try{
		append('service-start',detail?{web:detail.snapshot()}:records?{web:records.snapshot()}:tasks?{web:tasks.snapshot()}:asynchronous?{web:asynchronous.snapshot()}:{});await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',no);yes();});});
	}catch(error){server.close(()=>{});closeSync(fd);key.fill(0);throw error;}
	server.on('error',fail);
	const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
	return{origin,url:origin+(records?'/records':tasks?'/tasks':asynchronous?'/async':'/form'),journalPath:path,
		bind(value:FormServiceAuthorization):void{assert.ok(!authorization&&!closing&&!failure);authorization=value;},
		verify,
		assertHealthy():void{assert.ok(!failure,'signed form service failed');asynchronous?.assertHealthy();verify();},
		close():Promise<void>{
			// Publish the promise before any external callback can reenter close().
			if(closing)return closing;
			const deadline=performance.now()+2000;
			closing=Promise.resolve().then(async()=>{
			let timer:ReturnType<typeof setTimeout>|undefined,expired=false;
			const checkDeadline=()=>{if(performance.now()>=deadline){expired=true;fail();}};
			try{
				checkDeadline();asynchronous?.close();lifetime.abort();const stopping=Promise.resolve().then(()=>{checkDeadline();return authorization?.stop();}).then(()=>{checkDeadline();});void stopping.catch(fail);
				const drained=new Promise<void>((yes,no)=>{server.close(error=>error?no(error):yes());server.closeIdleConnections();});
				await Promise.race([Promise.all([drained,Promise.allSettled([stopping,...authorizationWork])]),new Promise<never>((_,no)=>{
					timer=setTimeout(()=>{expired=true;server.closeAllConnections();no(new Error('form service authorization or HTTP cleanup is unverified'));},Math.max(1,deadline-performance.now()));
				})]);
				checkDeadline();
				assert.ok(!expired&&active===0&&authorizationWork.size===0,'form service did not drain its real requests/authorization');assert.ok(!failure,'signed form service had a failed request');append('service-stop');verify();
			}finally{clearTimeout(timer);closed=true;closeSync(fd);key.fill(0);}
			});return closing;
		},
	};
}

// Same fields, choices, validation and visible result as original case6. The
// business request is created only by the actual Submit form button handler.
// There is no credential in this page; only the trusted CDP adapter adds proof.
const FORM_PAGE=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mountains Web QA</title>
<style>body{font:17px system-ui;margin:28px}label{display:block;margin:14px 0}input,select,button{font:inherit;padding:7px}</style>
<h1>Form validation</h1><label>Name <input aria-label="Name" type="text"></label>
<label>Color <select aria-label="Color"><option>Blue</option><option>Green</option><option>Red</option></select></label>
<label>I agree <input aria-label="I agree" type="checkbox"></label><button type="button">Submit form</button>
<p id="status" role="status">Ready</p><script>
document.querySelector('button').addEventListener('click',async()=>{
 const status=document.querySelector('#status');
 try{const response=await fetch('/api/form',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.querySelector('[aria-label="Name"]').value,color:document.querySelector('select').value,agree:document.querySelector('[type="checkbox"]').checked})});
 const data=await response.json();if(!response.ok)throw new Error(data.error);status.textContent=data.message;
 }catch(error){status.textContent='Error: '+error.message;}
});</script></html>`;
