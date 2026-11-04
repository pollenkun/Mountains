import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { outsideInputScope } from "./coordinator.ts";
import { JsonHelper } from "./helper.ts";

export interface BrowserProcess { pid: number; identity: string }
const DEADLINE_SLACK_MS=5;

/** A well-formed OS reply whose state could not be observed atomically. */
export class BrowserProcessObservationUnknownError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`could not verify the owned browser process; OS observation is unknown (${reason})`);
		this.name = 'BrowserProcessObservationUnknownError';
		this.reason = reason;
	}
}

function object(value:unknown,keys:string[]):Record<string,unknown>{
	if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))throw new Error('invalid OS process observation');
	return value as Record<string,unknown>;
}
function validPid(pid:number):void{if(!Number.isSafeInteger(pid)||pid<1||pid>2_147_483_647)throw new Error('browser has no process identity');}

/** The canonical string changes only with a different OS birth or executable,
 * never with mutable argv/comm. Unknown and malformed replies never mean exit. */
export function parseBrowserProcess(value:unknown,pid:number):BrowserProcess|null{
	validPid(pid);
	if(value&&typeof value==='object'&&!Array.isArray(value)&&'status'in value&&value.status==='absent'){object(value,['status']);return null;}
	if(value&&typeof value==='object'&&!Array.isArray(value)&&'status'in value&&value.status==='unknown'){
		const reply=object(value,['status','reason']);
		if(typeof reply.reason!=='string'||!reply.reason||reply.reason.length>256||/[\u0000-\u001f\u007f]/.test(reply.reason))throw new Error('invalid OS process observation');
		throw new BrowserProcessObservationUnknownError(reply.reason);
	}
	const reply=object(value,['status','birth','executable']),birth=object(reply.birth,['pid','bootId','startSeconds','startMicroseconds']);
	if(reply.status!=='alive'||birth.pid!==pid||typeof birth.bootId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(birth.bootId)||typeof birth.startSeconds!=='string'||!/^[1-9]\d{0,18}$/.test(birth.startSeconds)||BigInt(birth.startSeconds)>9_223_372_036_854_775_807n||typeof birth.startMicroseconds!=='number'||!Number.isInteger(birth.startMicroseconds)||birth.startMicroseconds<0||birth.startMicroseconds>=1_000_000||typeof reply.executable!=='string'||!reply.executable.startsWith('/')||reply.executable.length>4095||/[\u0000-\u001f\u007f]/.test(reply.executable))throw new Error('invalid OS process identity; process state remains unknown');
	return{pid,identity:JSON.stringify({schema:'macos-process-identity-v1',pid,bootId:birth.bootId,startSeconds:birth.startSeconds,startMicroseconds:birth.startMicroseconds,executable:reply.executable})};
}

function nativeReader():JsonHelper{
	if(!['arm64','x64'].includes(process.arch))throw new Error('macOS process identity is unsupported on this architecture');
	const binary=fileURLToPath(new URL('../native/darwin-universal/process-identity',import.meta.url)),source=fileURLToPath(new URL('../native/process-identity.swift',import.meta.url));
	try{
		const manifest=JSON.parse(readFileSync(binary+'.json','utf8')) as {format:number;sourceSha256:string;binarySha256:string;architectures:string[]};
		const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
		if(manifest.format!==1||!manifest.architectures.includes(process.arch)||manifest.sourceSha256!==sha(source)||manifest.binarySha256!==sha(binary))throw new Error('release artifact mismatch');
	}catch(error){throw new Error('The bundled read-only process identity reader is missing or invalid. Reinstall the complete Mountains package.',{cause:error});}
	const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('DYLD_'))delete env[key];
	return new JsonHelper(binary,[],env,'terminate',undefined,{strictReplies:true});
}

/** One readonly transport per browser. It never participates in UI input leases.
 * Close prevents late requests/spawns, drains the queue and awaits actual close. */
export class BrowserProcessProbe {
	private helper:JsonHelper|undefined;
	private closed=false;
	private closing:Promise<void>|undefined;
	private readonly work=new Set<Promise<BrowserProcess|null>>();
	read(pid:number,expiresAt=performance.now()+3000):Promise<BrowserProcess|null>{
		try{validPid(pid);if(this.closed)throw new Error('browser process reader is closed');if(!Number.isFinite(expiresAt)||performance.now()>=expiresAt)throw new Error('browser process observation deadline expired; state remains unknown');}catch(error){return Promise.reject(error);}
		const task=this.readOpen(pid,Math.min(expiresAt,performance.now()+3000));this.work.add(task);
		void task.then(()=>this.work.delete(task),()=>this.work.delete(task));return task;
	}
	private async readOpen(pid:number,expiresAt:number):Promise<BrowserProcess|null>{
		let value:BrowserProcess|null;
		try{
			if(process.platform!=='darwin')value=await legacyProcess(pid,Math.max(1,Math.ceil(expiresAt-performance.now())));
			else{
				const helper=this.helper??=nativeReader();
				const reply=await outsideInputScope(()=>helper.send({pid},Math.max(1,Math.min(3000,expiresAt-performance.now())),true,undefined,undefined,undefined,{expiresAt}));
				value=parseBrowserProcess(reply.observation,pid);
			}
		}catch(error){
			// The helper gets a wall-clock deadline built on whole-millisecond Date.now(), so it can see the
			// deadline pass up to a millisecond before this clock does and answer with a refusal.
			if(error instanceof BrowserProcessObservationUnknownError||performance.now()<expiresAt-DEADLINE_SLACK_MS)throw error;
			throw new Error('browser process observation deadline expired; state remains unknown',{cause:error});
		}
		if(this.closed)throw new Error('browser process reader closed during its query');
		if(performance.now()>=expiresAt)throw new Error('browser process observation arrived after its deadline; state remains unknown');
		return value;
	}
	close():Promise<void>{
		if(!this.closing){
			this.closed=true;let yes!:()=>void,no!:(error:unknown)=>void;
			this.closing=new Promise<void>((resolve,reject)=>{yes=resolve;no=reject;});
			void outsideInputScope(async()=>{
				let error:unknown,failed=false;
				try{await this.helper?.dispose();}catch(value){failed=true;error=value;}
				await Promise.allSettled([...this.work]);if(failed)throw error;
			}).then(yes,no);
		}
		return this.closing;
	}
}

/** Compatibility on other platforms. This string is never a signal authority. */
async function legacyProcess(pid:number,timeoutMs=3000):Promise<BrowserProcess|null>{
	try{
		const {stdout}=await promisify(execFile)('/bin/ps',['-p',String(pid),'-o','lstart=','-o','comm='],{timeout:timeoutMs,env:{...process.env,LC_ALL:'C',TZ:'UTC'}});
		const identity=stdout.trim();if(!identity)throw new Error('empty process observation');return{pid,identity};
	}catch(error){
		const failure=error as {code?:unknown;stdout?:string;stderr?:string};
		if(failure.code===1&&!failure.stdout?.trim()&&!failure.stderr?.trim())return null;
		throw new Error('could not verify whether the owned browser process exited',{cause:error});
	}
}

/** Standalone callers own and close their reader; WebBrowser reuses one. */
export async function browserProcess(pid:number):Promise<BrowserProcess|null>{
	const reader=new BrowserProcessProbe();let value:BrowserProcess|null,primary:unknown,failed=false;
	try{value=await reader.read(pid);}catch(error){failed=true;primary=error;}
	try{await reader.close();}catch(error){if(failed)throw new AggregateError([primary,error],'process query and reader cleanup failed');throw error;}
	if(failed)throw primary;return value!;
}
