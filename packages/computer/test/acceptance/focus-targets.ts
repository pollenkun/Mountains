import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,lstatSync,readSync} from 'node:fs';
import {realpathSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {readProcessBatch,writerProcessIdentity,type ProcessObservation,type WriterProcessIdentity} from './process-identity.ts';
import {focusNotificationVerdict} from './integrity.ts';

type Row=Record<string,unknown>;
export interface FocusSubscription {pid:number;birth:WriterProcessIdentity;generation:string;revision:number}
export interface FocusCursor {path:string;bytes:number;sequence:number;sha256:string}
export interface FocusSnapshot {at:number;sampleAt:number;monitorBirth:WriterProcessIdentity;cursor:FocusCursor;baselinePids:number[];subscriptions:FocusSubscription[]}
export interface StrictFocusOptions {monitorBirth:WriterProcessIdentity;maxSampleGapMs:number;maxFreshnessMs?:number;now?:()=>number}
const birth=(value:unknown,pid:number):WriterProcessIdentity=>{
	assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'missing live focus process observation');const row=value as Row;assert.equal(row.status,'alive','focus process observation is not live');
	const result=writerProcessIdentity(row.identity);assert.equal(result.pid,pid,'focus process PID differs');return result;
};
const finite=(value:unknown):number=>{assert.ok(typeof value==='number'&&Number.isFinite(value)&&value>=0,'invalid focus time or number');return value;};

/** Read only newly appended monitor records. Re-reading a long journal for
 * every tool would make identity checks increasingly expensive. */
export class FocusTargetCandidates{
	private readonly fd:number;private readonly path:string;private offset=0;private pending='';private readonly decoder=new StringDecoder('utf8');private readonly pids=new Set<number>();
	private readonly canonical:string;private readonly strict:StrictFocusOptions|undefined;private readonly digest=createHash('sha256');private bytes=0;private sequence=0;private closed=false;private failed=false;
	private ready:Row|undefined;private sample:Row|undefined;private state:'running'|'draining'|'stopped'='running';private previousAt=0;private previousUptime=0;
	private readonly subscriptions=new Map<number,Row>();private readonly revisions=new Map<number,number>();
	constructor(path:string,strict?:StrictFocusOptions){
		this.path=path;this.canonical=realpathSync(path);this.fd=openSync(path,'r');
		try{
			if(strict){assert.ok(Number.isFinite(strict.maxSampleGapMs)&&strict.maxSampleGapMs>0);assert.ok(Number.isFinite(strict.maxFreshnessMs??150)&&(strict.maxFreshnessMs??150)>0);}
			this.strict=strict?Object.freeze({...strict,monitorBirth:Object.freeze(writerProcessIdentity(strict.monitorBirth))}):undefined;
		}catch{closeSync(this.fd);throw new Error('invalid strict focus observation options');}
	}
	private subscription(pid:number,row:Row):FocusSubscription{
		const before=birth(row.subscriptionBefore,pid),after=birth(row.subscriptionAfter,pid);assert.deepEqual(before,after,'process changed during focus subscription');
		assert.ok(typeof row.subscriptionGeneration==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.subscriptionGeneration),'missing focus subscription generation');
		return{pid,birth:after,generation:row.subscriptionGeneration,revision:this.revisions.get(pid)!};
	}
	private identity(){
		assert.ok(!this.closed&&!this.failed,'focus observation source is closed or failed');
		const stat=fstatSync(this.fd),path=lstatSync(this.path);assert.equal(realpathSync(this.path),this.canonical,'focus journal path was redirected');
		assert.ok(stat.isFile()&&path.isFile()&&path.dev===stat.dev&&path.ino===stat.ino,'focus journal was replaced');assert.ok(stat.size>=this.offset,'focus journal was truncated');return stat;
	}
	private accept(row:Row):void{
		if(this.strict){
			assert.equal(row.sequence,this.sequence+1,'focus journal sequence missing or repeated');
			assert.deepEqual(birth(row.monitorProcess,this.strict.monitorBirth.pid),this.strict.monitorBirth,'focus monitor process was replaced');
			const at=finite(row.at),uptime=finite(row.uptimeMs);assert.ok(at>=this.previousAt&&uptime>=this.previousUptime,'focus journal clock reversed');this.previousAt=at;this.previousUptime=uptime;
			assert.notEqual(row.kind,'fatal','focus monitor reported failure');
			if(row.kind==='ready'){
				assert.ok(!this.ready&&this.state==='running','focus readiness repeated or after shutdown');assert.equal(row.focusReadable,true);
				for(const [key,observation]of [['foregroundPid','foregroundProcess'],['focusPid','focusProcess'],['keyboardPid','keyboardProcess']]){
					const pid=Number(row[key!]),current=birth(row[observation!],pid),subscription=this.subscriptions.get(pid);assert.ok(subscription,'baseline subscription was not ready');assert.deepEqual(this.subscription(pid,subscription).birth,current,'baseline subscription belongs to a replaced process');
				}
				finite(row.focusToken);assert.ok(Number(row.focusToken)>0);this.ready=row;
			}
			if(row.kind==='monitor-observers-stopped'){assert.equal(this.state,'running','focus shutdown repeated');assert.equal(row.pendingSubscriptions,0,'focus registrations still pending');this.state='draining';}
			if(row.kind==='stopped'){assert.equal(this.state,'draining','focus monitor skipped observer drain');this.state='stopped';}
			if(this.state!=='running')assert.ok(!['subscribed','AX-notification'].includes(String(row.kind)),'focus subscriptions reappeared after shutdown');
			if(this.ready){
				// emit() reads foreground and its OS birth on every record. A later
				// sample can already be restored, including after a termination hint.
				assert.equal(row.foregroundPid,this.ready.foregroundPid,'observed foreground changed between samples');
				assert.deepEqual(birth(row.foregroundProcess,Number(row.foregroundPid)),birth(this.ready.foregroundProcess,Number(this.ready.foregroundPid)),'observed foreground process was replaced');
				if(row.kind==='AX-notification'&&row.systemKeyboardPidAtNotification!==undefined)assert.equal(row.systemKeyboardPidAtNotification,this.ready.keyboardPid,'observed keyboard application changed at notification');
				assert.ok(!['focus','keyboard-application','foreground-notification','foreground-sample','focus-read-state','notification-identity-unavailable'].includes(String(row.kind)),'focus changed or became unknown');
				assert.equal(focusNotificationVerdict(row),'unrelated','focus notification cannot prove unchanged global focus');
				if(['sample','stopped'].includes(String(row.kind))){
					assert.equal(row.focusReadable,true,'focus became unreadable');assert.equal(row.focusToken,this.ready.focusToken,'focused element changed');
					for(const [key,observation]of [['foregroundPid','foregroundProcess'],['focusPid','focusProcess'],['keyboardPid','keyboardProcess']]){
						assert.equal(row[key!],this.ready[key!],'global focus application changed');assert.deepEqual(birth(row[observation!],Number(row[key!])),birth(this.ready[observation!],Number(this.ready[key!])),'global focus process was replaced');
					}
				}
			}
			if(row.kind==='sample'){
				for(const key of ['pointerX','pointerY','modifierFlags']){const value=row[key];assert.ok(typeof value==='number'&&Number.isFinite(value),'missing pointer or modifier sample');if(this.ready&&this.sample)assert.equal(value,this.sample[key],'global pointer or modifier changed');}
				if(this.ready&&this.sample)assert.ok(uptime-finite(this.sample.uptimeMs)<=this.strict.maxSampleGapMs,'focus sampling gap');this.sample=row;
			}
		}
		this.sequence++;
		const pid=row.observedPid;if(typeof pid!=='number'||!Number.isSafeInteger(pid)||pid<=0)return;
		if(row.kind==='subscribed'&&Array.isArray(row.notifications)&&row.notifications.includes('AXFocusedUIElementChanged')){
			this.pids.add(pid);this.subscriptions.set(pid,row);this.revisions.set(pid,(this.revisions.get(pid)??0)+1);
		}
		if(['process-terminated','subscription-invalidated','notification-identity-unavailable'].includes(String(row.kind))||row.kind==='notification-unavailable'&&(!row.notification||row.notification==='AXFocusedUIElementChanged')){
			if(this.strict&&this.ready)assert.ok(!['foregroundPid','focusPid','keyboardPid'].some(key=>this.ready![key]===pid),'baseline focus subscription stopped');
			this.pids.delete(pid);this.subscriptions.delete(pid);this.revisions.set(pid,(this.revisions.get(pid)??0)+1);
		}
	}
	read():number[]{
		try{
		const stat=this.identity();
		const buffer=Buffer.allocUnsafe(Math.min(1024*1024,stat.size-this.offset));
		while(this.offset<stat.size){const count=readSync(this.fd,buffer,0,Math.min(buffer.length,stat.size-this.offset),this.offset);assert.ok(count>0,'focus journal read stopped');this.offset+=count;this.pending+=this.decoder.write(buffer.subarray(0,count));
			for(;;){const end=this.pending.indexOf('\n');if(end<0)break;const text=this.pending.slice(0,end);this.pending=this.pending.slice(end+1);if(!text){assert.ok(!this.strict,'empty strict focus record');this.digest.update('\n');this.bytes++;continue;}
				assert.ok(Buffer.byteLength(text)<=1024*1024&&this.sequence<2_000_000,'focus journal record limit');
				let row:Row;try{row=JSON.parse(text) as Row;}catch{throw new Error('invalid focus journal JSON');}assert.ok(row&&typeof row==='object'&&!Array.isArray(row),'invalid focus record');this.accept(row);this.digest.update(text+'\n');this.bytes+=Buffer.byteLength(text+'\n');
			}
			assert.ok(this.pending.length<=1024*1024,'incomplete monitor record is too large');
		}
		assert.ok(this.pids.size>0&&this.pids.size<=4096,'no bounded set of current monitor candidates');return [...this.pids].sort((a,b)=>a-b);
		}catch(error){this.failed=true;throw error;}
	}
	snapshot():FocusSnapshot{
		assert.ok(this.strict,'strict monitor birth is required for focus evidence');this.read();
		try{
		const now=(this.strict.now??Date.now)();assert.equal(this.state,'running','focus observation has stopped');assert.ok(this.ready&&this.sample,'focus monitor is not ready');
		// Swift emits fractional wall milliseconds, while Date.now truncates them.
		// Compare at the reader clock's resolution; a later whole millisecond is still future.
		const sampleAt=finite(this.sample.at),sampleMillis=Math.floor(sampleAt);
		assert.ok(now>=sampleMillis&&now-sampleMillis<=(this.strict.maxFreshnessMs??150),'focus sample is stale or from the future');
		const subscriptions=[...this.subscriptions].map(([pid,row])=>this.subscription(pid,row));
		for(const key of ['foregroundPid','focusPid','keyboardPid'])assert.ok(subscriptions.some(item=>item.pid===this.ready![key]),'baseline application lost its focus subscription');
		return{at:now,sampleAt:Number(this.sample.at),monitorBirth:{...this.strict.monitorBirth},cursor:{path:this.canonical,bytes:this.bytes,sequence:this.sequence,sha256:this.digest.copy().digest('hex')},baselinePids:[...new Set(['foregroundPid','focusPid','keyboardPid'].map(key=>Number(this.ready![key])))],subscriptions};
		}catch(error){this.failed=true;throw error;}
	}
	/** Verify the privately observed prefix, including old bytes, without reading the whole file into memory. */
	verifyPrefix():FocusCursor{
		try{
			this.read();const cursor={path:this.canonical,bytes:this.bytes,sequence:this.sequence,sha256:this.digest.copy().digest('hex')};const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let offset=0;
			while(offset<cursor.bytes){const count=readSync(this.fd,buffer,0,Math.min(buffer.length,cursor.bytes-offset),offset);assert.ok(count>0,'focus prefix read stopped');hash.update(buffer.subarray(0,count));offset+=count;}
			this.identity();assert.equal(hash.digest('hex'),cursor.sha256,'observed focus history was rewritten');return cursor;
		}catch(error){this.failed=true;throw error;}
	}
	close():void{if(!this.closed){this.closed=true;closeSync(this.fd);}}
}
export interface FocusTargetBoundary{at:number;end:number;processes:{pid:number;observation:ProcessObservation}[]}
export async function observeFocusTargets(binary:{path:string;sha256:string},inputPids:readonly number[],signal?:AbortSignal):Promise<FocusTargetBoundary>{
	const pids=[...inputPids];
	const at=Date.now(),observed=await readProcessBatch(binary,pids,signal);
	return{at,end:Date.now(),processes:pids.map(pid=>({pid,observation:observed.get(pid)??{status:'unknown',reason:'process-query-failed'}}))};
}
