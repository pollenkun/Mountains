import assert from 'node:assert/strict';
import type {CdpEvent,CdpLike} from '../../src/web.ts';
type Row=Record<string,unknown>;
export const pageURL='http://127.0.0.1:12345/detail';
export class ObservedBrowser implements CdpLike{
	readonly commands:{method:string;params:Row;session?:string}[]=[];
	readonly frames=new Map<string,Row>([['main',{id:'main-frame',loaderId:'initial-loader',url:'about:blank'}]]);
	readonly sessions=new Map<string,string>();
	private readonly listeners=new Set<(event:CdpEvent)=>void>();
	private readonly pending=new Map<string,Set<(error:Error)=>void>>();
	private serial=0;
	clock=100;modal=false;holdClock=false;createDelay=0;invalidClock:unknown;metricsOverride:((target:string)=>unknown)|undefined;
	continuation:((params:Row,session:string)=>Promise<Row>)|undefined;
	on(listener:(event:CdpEvent)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
	emit(method:string,params:Row={},sessionId?:string){for(const listener of this.listeners)listener({method,params,...(sessionId?{sessionId}:{})});}
	emitMain(method:string,params:Row){for(const [session,target] of this.sessions)if(target==='main')this.emit(method,params,session);}
	navigate(url=pageURL,loaderId='detail-loader'){
		const frame={id:'main-frame',loaderId,url};this.frames.set('main',frame);this.emitMain('Page.frameNavigated',{frame});
	}
	openDialog(){this.modal=true;this.emitMain('Page.javascriptDialogOpening',{url:this.frames.get('main')!.url,type:'confirm',message:'Save this test detail?'});}
	closeDialog(){this.modal=false;this.emitMain('Page.javascriptDialogClosed',{result:false});}
	async send(method:string,params:Row={},session?:string):Promise<Row>{
		this.commands.push({method,params,...(session?{session}:{})});
		if(method==='Target.attachToTarget'){const sessionId='session-'+(++this.serial);this.sessions.set(sessionId,String(params.targetId));return{sessionId};}
		if(method==='Target.createTarget'){if(this.createDelay)await new Promise<void>(yes=>setTimeout(yes,this.createDelay));const targetId='clock-'+(++this.serial);assert.equal(params.background,true);assert.equal(params.url,'about:blank');this.frames.set(targetId,{id:targetId+'-frame',loaderId:targetId+'-loader',url:'about:blank'});return{targetId};}
		if(method==='Target.getTargetInfo'){const targetId=String(params.targetId),frame=this.frames.get(targetId);assert.ok(frame,'closed or unknown target');return{targetInfo:{targetId,type:'page',url:frame.url}};}
		if(method==='Target.detachFromTarget'){
			const detached=String(params.sessionId);this.sessions.delete(detached);
			for(const reject of this.pending.get(detached)??[])reject(new Error('actual fake session detached'));this.pending.delete(detached);return{};
		}
		if(method==='Target.closeTarget'){assert.notEqual(params.targetId,'main');this.frames.delete(String(params.targetId));return{success:true};}
		if(method==='Target.getTargets')return{targetInfos:[...this.frames].map(([targetId,frame])=>({targetId,type:'page',url:frame.url}))};
		const target=this.sessions.get(session??'');assert.ok(target,'command must use its actual attached session');
		if(method==='Fetch.continueRequest'&&this.continuation)return this.continuation(params,session!);
		if((this.modal&&target==='main'||this.holdClock&&target!=='main')&&['Page.getFrameTree','Performance.getMetrics'].includes(method))return await new Promise<Row>((_yes,no)=>{
			const set=this.pending.get(session!)??new Set();set.add(no);this.pending.set(session!,set);
		});
		if(method==='Page.getFrameTree')return{frameTree:{frame:structuredClone(this.frames.get(target))}};
		if(method==='Performance.getMetrics')return{metrics:[{name:'Timestamp',value:this.metricsOverride?this.metricsOverride(target):this.invalidClock===undefined?++this.clock:this.invalidClock}]};
		return{};
	}
	async close(){throw new Error('observer must not close the shared connection');}
}
