import assert from 'node:assert/strict';
import type {CdpEvent,CdpLike} from '../../src/web.ts';
import type {RequestScope} from './request-witness.ts';
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Row;};
const id=(value:unknown):string=>{assert.ok(typeof value==='string'&&value.length>0&&value.length<=256);return value;};
export interface RequestPreparation{
 readonly cdp:CdpLike;readonly targetId:string;
 prepare(scope:Readonly<RequestScope>):Promise<{browserNotBefore:number;observation:Row}>;
}
/** Controller-only observation, before business navigation. This sends no
 * main-page JS or input. A private empty target samples Chrome's real global
 * monotonic Performance.Timestamp while a modal blocks the original renderer.
 * The controller does not expose that target for model actions. This is not a
 * cache-clock substitution or a foreground guarantee. */
export async function witnessBrowserObserver(cdp:CdpLike,options:{targetId:string;allowedURLs:readonly string[];verifyOwner:()=>Promise<void>;timeoutMs?:number}){
 const targetId=id(options.targetId),limit=options.timeoutMs??3000;assert.ok(Number.isInteger(limit)&&limit>0&&limit<=3000);const allowed=new Set(options.allowedURLs);assert.ok(allowed.has('about:blank'));
 let sessionId:string|undefined,clockTargetId:string|undefined,clockSessionId:string|undefined,clockFrame:{id:string;loaderId:string}|undefined,off:(()=>void)|undefined,failure:Error|undefined,closing:Promise<Row>|undefined,frame:Row|undefined,dialog:Row|undefined,serial=0,lastStamp=0,preparing=false;
 const events:Row[]=[],calibrations=new Map<number,Row>(),work=new Set<Promise<unknown>>();
 const append=(kind:string,fields:Row={})=>events.push({sequence:events.length+1,at:Date.now(),kind,...structuredClone(fields)});
 const fail=(error:unknown)=>{failure??=error instanceof Error?error:new Error(String(error));};
 const check=()=>{assert.ok(!closing,'browser observer is closed');if(failure)throw failure;};
 const bounded=async<T>(actual:Promise<T>,label:string,timeout=limit):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;const until=performance.now()+timeout;try{const value=await Promise.race([actual,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error(label+' exceeded independent observation deadline')),timeout);})]);assert.ok(performance.now()<until,label+' exceeded independent observation deadline');return value;}finally{clearTimeout(timer);}};
 const track=<T>(actual:Promise<T>):Promise<T>=>{work.add(actual);void actual.then(()=>work.delete(actual),error=>{work.delete(actual);if(!closing)fail(error);});return actual;};
 const send=(method:string,params:Row={},session?:string)=>{check();return bounded(track(cdp.send(method,params,session,limit)),method);};
 const resource=(method:string,params:Row,remember:(reply:Row)=>void)=>{check();return bounded(track(cdp.send(method,params,undefined,limit).then(reply=>{remember(object(reply));return reply;})),method);};
 const owner=()=>{check();return bounded(track(Promise.resolve().then(()=>options.verifyOwner())),'browser ownership');};
 const target=async(target:string,url?:string)=>{const actual=object(object(await send('Target.getTargetInfo',{targetId:target})).targetInfo);assert.equal(actual.targetId,target);assert.equal(actual.type,'page');if(url!==undefined)assert.equal(actual.url,url);return actual;};
 const tree=async(session:string)=>object(object(object(await send('Page.getFrameTree',{},session)).frameTree).frame);
 const stamp=async(session:string)=>{const metrics=object(await send('Performance.getMetrics',{},session)).metrics;assert.ok(Array.isArray(metrics));const found=metrics.map(object).filter(row=>row.name==='Timestamp');assert.equal(found.length,1);const value=found[0]!.value;assert.ok(typeof value==='number'&&Number.isFinite(value)&&value>=0);return value;};
 const sameFrame=(observed:Row)=>{check();assert.ok(frame);for(const key of ['generation','id','loaderId','url'])assert.equal(frame[key],observed[key],'document changed during input preparation');};
 const clock=async()=>{assert.ok(clockTargetId&&clockSessionId&&clockFrame);await target(clockTargetId,'about:blank');const current=await tree(clockSessionId);assert.equal(current.id,clockFrame.id);assert.equal(current.loaderId,clockFrame.loaderId);assert.equal(current.url,'about:blank');const timestamp=await stamp(clockSessionId);check();await target(clockTargetId,'about:blank');assert.ok(timestamp>=lastStamp,'actual Chrome clock reversed');lastStamp=timestamp;return timestamp;};
 const close=():Promise<Row>=>{
  if(closing)return closing;
  closing=Promise.resolve().then(async()=>{off?.();const errors:string[]=[],until=performance.now()+limit;const step=async(run:()=>Promise<unknown>)=>{try{await bounded(track(Promise.resolve().then(run)),'observer cleanup',Math.max(1,until-performance.now()));}catch(error){errors.push(String(error));}};
   // Retain late resource identities before settling their actual requests.
   // Detachment releases paused renderer commands; a second sweep then also
   // closes a target/session whose successful creation arrived after timeout.
   const detached=new Set<string>(),closed=new Set<string>();
   const sweep=async()=>{
    for(const attached of [sessionId,clockSessionId])if(attached&&!detached.has(attached)){await step(async()=>{await cdp.send('Target.detachFromTarget',{sessionId:attached},undefined,limit);detached.add(attached);});}
    if(clockTargetId&&!closed.has(clockTargetId)){const target=clockTargetId;await step(async()=>{const reply=object(await cdp.send('Target.closeTarget',{targetId:target},undefined,limit));assert.equal(reply.success,true);closed.add(target);});}
   };
   const drain=async()=>{const actualPending=[...work];await step(()=>Promise.allSettled(actualPending));};
   await sweep();await drain();await sweep();await drain();
   if(clockTargetId)await step(async()=>{const targets=object(await cdp.send('Target.getTargets',{},undefined,limit)).targetInfos;assert.ok(Array.isArray(targets));assert.ok(!targets.map(object).some(row=>row.targetId===clockTargetId),'private clock target did not close');});
   append('observer-stopped',{errors,pending:work.size});assert.equal(work.size,0,'actual observer requests did not settle');assert.equal(errors.length,0,errors.join('; '));return{events:events.length,clockTargetClosed:true,priorFailure:failure?.message??null};
  });return closing;
 };
 try{
  await owner();const initial=await target(targetId);assert.equal(initial.url,'about:blank','observer must precede the first business page load');
  await resource('Target.attachToTarget',{targetId,flatten:true},reply=>{sessionId=id(reply.sessionId);});assert.ok(sessionId);
  off=cdp.on((event:CdpEvent)=>{try{
   if(event.method==='Mountains.connectionClosed')throw new Error('observer Chrome connection closed');
   if(event.method==='Target.detachedFromTarget'&&[sessionId,clockSessionId].includes(String(event.params.sessionId)))throw new Error('observer session detached');
   if(clockSessionId&&event.sessionId===clockSessionId){if(event.method==='Page.frameNavigated'){const changed=object(event.params.frame);if(clockFrame){assert.equal(changed.id,clockFrame.id);assert.equal(changed.loaderId,clockFrame.loaderId);}assert.equal(changed.url,'about:blank');}else if(['Page.frameDetached','Page.javascriptDialogOpening','Inspector.detached'].includes(event.method))throw new Error('private clock target changed');return;}
   if(event.sessionId!==sessionId)return;
   const p=event.params;
   if(event.method==='Inspector.detached'||event.method==='Page.frameDetached'&&p.frameId===frame?.id)throw new Error('observed document detached');
   if(event.method==='Page.frameNavigated'){
    const f=object(p.frame);if(f.parentId)return;assert.ok(!dialog,'document navigated with an unresolved dialog');assert.ok(allowed.has(String(f.url)));frame={generation:Number(frame?.generation??-1)+1,id:id(f.id),loaderId:id(f.loaderId),url:String(f.url)};append('navigation',{frame});
   }else if(event.method==='Page.navigatedWithinDocument'&&p.frameId===frame?.id){assert.ok(!dialog,'document navigated with an unresolved dialog');assert.ok(allowed.has(String(p.url)));frame={...frame,generation:Number(frame!.generation)+1,url:String(p.url)};append('same-document-navigation',{frame});
   }else if(event.method==='Page.javascriptDialogOpening'){
    assert.ok(frame&&!dialog);assert.equal(p.url,frame.url);assert.ok(['confirm','alert','prompt'].includes(String(p.type)));dialog={serial:++serial,generation:frame.generation,url:p.url,type:p.type,message:p.message};append('dialog-opened',{dialog});
   }else if(event.method==='Page.javascriptDialogClosed'){assert.ok(dialog);assert.equal(typeof p.result,'boolean','missing actual dialog result');if(p.userInput!==undefined)assert.equal(typeof p.userInput,'string');append('dialog-closed',{dialog,result:p.result});dialog=undefined;
   }else if(event.method==='Runtime.exceptionThrown'){append('page-exception',{generation:frame?.generation,details:p.exceptionDetails});throw new Error('owned fixture threw an unhandled page exception');}
  }catch(error){fail(error);append('observer-failed',{error:failure?.message});}});
  await send('Page.enable',{},sessionId);await send('Runtime.enable',{},sessionId);await send('Performance.enable',{},sessionId);const initialFrame=await tree(sessionId);assert.equal(initialFrame.url,'about:blank');frame={generation:0,id:id(initialFrame.id),loaderId:id(initialFrame.loaderId),url:'about:blank'};
  await resource('Target.createTarget',{url:'about:blank',background:true},reply=>{clockTargetId=id(reply.targetId);assert.notEqual(clockTargetId,targetId);});await target(clockTargetId!,'about:blank');await resource('Target.attachToTarget',{targetId:clockTargetId,flatten:true},reply=>{clockSessionId=id(reply.sessionId);});
  // Page.enable may report the existing blank frame. Preserve the session
  // identity throughout startup; bind its frame identity after the real read.
  await send('Page.enable',{},clockSessionId);await send('Performance.enable',{},clockSessionId);const blank=await tree(clockSessionId!);assert.equal(blank.url,'about:blank');clockFrame={id:id(blank.id),loaderId:id(blank.loaderId)};
  await owner();check();append('observer-ready',{targetId,sessionId,frame,clock:{targetId:clockTargetId,sessionId:clockSessionId,frame:clockFrame}});
 }catch(error){fail(error);await close().catch(()=>{});throw error;}
 return Object.freeze({cdp,targetId,
  async prepare(scope:Readonly<RequestScope>):Promise<{browserNotBefore:number;observation:Row}>{
   check();assert.ok(!preparing);preparing=true;
   const actual=track((async()=>{await owner();check();assert.ok(frame);const before=structuredClone(frame);assert.equal(scope.targetId,targetId);assert.equal(scope.pageURL,before.url);assert.equal(scope.frameId,before.id);assert.equal(scope.loaderId,before.loaderId);const at=Date.now();let value:number,source:string;
    if(dialog){assert.equal(dialog.generation,before.generation);assert.equal(dialog.url,before.url);assert.ok(calibrations.has(Number(before.generation)),'no live cross-renderer clock calibration for this document');value=await clock();source='fresh private blank-page Performance.Timestamp with uninterrupted main-page dialog/navigation observations';}
    else{const actualFrame=await tree(sessionId!);for(const key of ['id','loaderId','url'])assert.equal(actualFrame[key],before[key]);const lower=await clock(),main=await stamp(sessionId!),upper=await clock();assert.ok(lower<=main&&main<=upper,'Chrome renderer timestamps did not share the same monotonic clock');calibrations.set(Number(before.generation),{at:Date.now(),generation:before.generation,lower,main,upper});value=upper;source='fresh private blank-page Performance.Timestamp calibrated around a live main-page sample';}
    await owner();sameFrame(before);const observation={at,end:Date.now(),document:before,dialog:dialog?structuredClone(dialog):null,clock:{targetId:clockTargetId,sessionId:clockSessionId,timestamp:value,source},calibration:structuredClone(calibrations.get(Number(before.generation))!)};append('input-prepared',{observation});return{browserNotBefore:value,observation};
   })());
   try{return await bounded(actual,'complete input preparation');}catch(error){fail(error);throw error;}finally{preparing=false;}
  },
  snapshot(){return{targetId,sessionId,frame:structuredClone(frame),dialog:structuredClone(dialog),events:structuredClone(events),failure:failure?.message??null,clock:{targetId:clockTargetId,sessionId:clockSessionId}};},
  verifyComplete(){check();assert.equal(preparing,false);assert.equal(work.size,0);assert.equal(dialog,undefined,'a real JS dialog remains open');},
  close,
 });
}
