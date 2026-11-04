import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fstatSync,readFileSync,realpathSync} from 'node:fs';
import {Socket} from 'node:net';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Writable} from 'node:stream';

export interface WebTargetBinding {schema:'web-verifier-target-v1';root:string;caseId:number;targetId:string}
function binding(value:unknown,expected:{root:string;caseId:number}):WebTargetBinding{
	assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'missing parent target binding');
	const row=value as Record<string,unknown>;assert.deepEqual(Object.keys(row).sort(),['caseId','root','schema','targetId']);
	assert.equal(row.schema,'web-verifier-target-v1');assert.equal(row.root,expected.root);assert.equal(row.caseId,expected.caseId);
	assert.ok(Number.isInteger(row.caseId)&&Number(row.caseId)>=6&&Number(row.caseId)<=10);
	assert.ok(typeof row.targetId==='string'&&/^[a-zA-Z0-9_-]{1,256}$/.test(row.targetId),'missing exact parent-owned target');
	assert.equal(realpathSync(expected.root),expected.root,'run root must be canonical');
	assert.equal(JSON.parse(readFileSync(join(expected.root,'manifest.json'),'utf8')).root,expected.root,'manifest belongs to another run');
	return Object.freeze({schema:'web-verifier-target-v1',root:expected.root,caseId:expected.caseId,targetId:row.targetId});
}

/** This channel transports facts from the trusted controller. A pipe is NOT
 * parent authentication or Chrome ownership evidence. The formal adapter must
 * independently attest the caller and capture its actual target first. No
 * checkpoint, model parameter, public file or fallback can supply this input. */
export async function readPrivateWebTarget(expected:{root:string;caseId:number}):Promise<WebTargetBinding>{
	const stat=fstatSync(3);assert.ok(stat.isFIFO()||stat.isSocket(),'target binding requires a private inherited channel');
	const deadline=performance.now()+1000;
	const bytes=await new Promise<Buffer>((yes,no)=>{
		const stream=new Socket({fd:3,readable:true,writable:false}),chunks:Buffer[]=[];let count=0,settled=false;
		const done=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);stream.destroy();if(error)no(error);else yes(Buffer.concat(chunks));};
		const timer=setTimeout(()=>done(new Error('private target binding timed out')),1000);
		stream.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>4096||performance.now()>=deadline)done(new Error('private target binding exceeded its size or time bound'));else chunks.push(chunk);});
		stream.once('end',()=>done(performance.now()>=deadline?new Error('private target binding exceeded its deadline'):undefined));
		stream.once('error',()=>done(new Error('private target binding channel failed')));
		stream.once('close',()=>{if(!settled)done(new Error('private target binding closed before EOF'));});
	});
	const text=bytes.toString('utf8');assert.ok(Buffer.from(text).equals(bytes),'private target binding is not UTF-8');
	assert.ok(text.length>1&&text.indexOf('\n')===text.length-1,'private target binding must be exactly one complete frame');
	const raw=text.slice(0,-1),value=JSON.parse(raw);assert.equal(JSON.stringify(value),raw,'private target binding is not canonical data');
	return binding(value,{root:resolve(expected.root),caseId:expected.caseId});
}

/** Fixed producer for the private verifier input. targetId must already be
 * held by the independently attested parent; this helper does not discover or
 * certify it. The actual Chrome/controller adapter is still required. */
export async function verifyWebDataWithTarget(root:string,caseId:number,targetId:string,check=false):Promise<{childPid:number;verdict:Record<string,unknown>}>{
	const canonical=realpathSync(root),pin=binding({schema:'web-verifier-target-v1',root:canonical,caseId,targetId},{root:canonical,caseId});
	const executable=fileURLToPath(new URL('./verify.mjs',import.meta.url));
	return new Promise((yes,no)=>{
		const child=spawn(process.execPath,[executable,canonical,String(caseId),'--runner','self',...(check?['--check']:[])],{stdio:['ignore','pipe','pipe','pipe']});
		const input=child.stdio[3] as Writable;let output='',errors='',failure:Error|undefined,written=false,expired=false;
		const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},5000);
		input.on('error',()=>{failure??=new Error('private verifier binding write/close failed');});
		child.stdout!.on('data',bytes=>{output+=bytes;if(Buffer.byteLength(output)>65536){failure??=new Error('verifier result exceeded limit');child.kill('SIGKILL');}});
		child.stderr!.on('data',bytes=>{errors+=bytes;if(Buffer.byteLength(errors)>65536){failure??=new Error('verifier diagnostic exceeded limit');child.kill('SIGKILL');}});
		child.once('error',()=>{failure??=new Error('private verifier did not start');});
		child.once('close',(code,signal)=>{
			clearTimeout(timer);
			try{assert.ok(!failure&&!expired&&written&&input.writableFinished,'private verifier channel did not finish cleanly');assert.equal(signal,null);
				const verdict=JSON.parse(output) as Record<string,unknown>;assert.equal(verdict.id,caseId);assert.equal(typeof verdict.passed,'boolean');assert.equal(code,verdict.passed?0:1);
				assert.ok(child.pid);yes({childPid:child.pid,verdict});
			}catch(error){no(failure??(error instanceof Error?error:new Error('private verifier failed')));}
		});
		try{input.end(JSON.stringify(pin)+'\n',(error?:Error|null)=>{if(error)failure??=new Error('private verifier binding write failed');else written=true;});}
		catch{failure??=new Error('private verifier binding could not be sent');child.kill('SIGKILL');}
	});
}
