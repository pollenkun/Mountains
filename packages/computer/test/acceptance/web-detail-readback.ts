import assert from 'node:assert/strict';
import {verifyWebRequestPairs} from './web-request-pairs.ts';
type Row=Record<string,any>;
interface Expected{targetId:string;url:string;value:string}
const object=(value:unknown):Row=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Row;};
const rows=(value:unknown):Row[]=>{assert.ok(Array.isArray(value));return value.map(object);};
function base(record:Row,phase:string,expected:Expected):{page:Row;observer:Row;documents:Row;events:Row[]}{
	assert.equal(record.id,10);assert.equal(record.phase,phase);assert.equal(record.webTarget,expected.targetId);
	const page=object(record.page),observer=object(record.browserObserver),documents=object(record.documentRequests);
	assert.equal(page.target,expected.targetId);assert.equal(page.provider,'separate raw CDP read-only connection');assert.equal(page.url,expected.url);
	assert.ok(Number.isFinite(record.at)&&Number.isFinite(record.capturedAt)&&record.at<=page.at&&page.at<=record.capturedAt);
	assert.equal(observer.targetId,expected.targetId);assert.equal(observer.failure,null);assert.ok(!observer.dialog,'a real JS dialog remains open');
	assert.equal(documents.targetId,expected.targetId);assert.equal(documents.failure,null);assert.equal(documents.active,null);assert.equal(documents.transition,null);
	const frame=object(observer.frame),document=object(page.document);assert.equal(frame.url,expected.url);assert.ok(Number.isInteger(frame.generation));for(const key of ['id','loaderId','url'])assert.equal(document[key],frame[key],'independent DOM read belongs to a different document');
	const epochs=rows(documents.epochs);assert.ok(epochs.length>=2);const sessions=new Set<string>();
	for(let index=0;index<epochs.length;index++){
		const epoch=epochs[index]!;assert.equal(epoch.index,index+1);assert.equal(epoch.closed,index<epochs.length-1);const scope=object(epoch.scope),doc=object(epoch.document);
		assert.equal(scope.targetId,expected.targetId);assert.equal(scope.frameId,doc.id);assert.equal(scope.loaderId,doc.loaderId);assert.equal(scope.pageURL,doc.url);assert.equal(scope.origin,new URL(expected.url).origin);
		assert.ok(typeof scope.sessionId==='string'&&!sessions.has(scope.sessionId));sessions.add(scope.sessionId);
		if(index)assert.ok(doc.generation>epochs[index-1]!.document.generation);
		const preparations=rows(epoch.preparations),ids=new Set<string>();for(const preparation of preparations){assert.ok(typeof preparation.id==='string'&&!ids.has(preparation.id));ids.add(preparation.id);assert.ok(Number.isFinite(preparation.browserNotBefore));}
		for(const proof of rows(epoch.requestProofs)){assert.equal(proof.stage,'committed');for(const key of ['targetId','sessionId','frameId','loaderId'])assert.equal(proof.proof[key],scope[key]);const preparation=preparations.filter(row=>row.id===proof.proof.permissionExecutionId);assert.equal(preparation.length,1,'old request lost its real input preparation');assert.equal(preparation[0]!.browserNotBefore,proof.proof.browserNotBefore);assert.deepEqual(preparation[0]!.observation.document,doc);}
	}
	assert.deepEqual(epochs.at(-1)!.document,frame);assert.equal(epochs[0]!.document.url,new URL('/form',expected.url).href);
	const events=rows(observer.events);assert.ok(events.length>0);for(let i=0;i<events.length;i++){assert.equal(events[i]!.sequence,i+1);assert.ok(Number.isFinite(events[i]!.at)&&events[i]!.at<=record.capturedAt);if(i)assert.ok(events[i]!.at>=events[i-1]!.at);}
	assert.equal(events[0]!.kind,'observer-ready');assert.equal(events.filter(row=>row.kind==='observer-ready').length,1);assert.ok(!events.some(row=>['observer-failed','observer-stopped','page-exception'].includes(row.kind)));
	assert.equal(events[0]!.frame.url,'about:blank');assert.equal(events[0]!.targetId,expected.targetId);assert.equal(events[0]!.sessionId,observer.sessionId);assert.deepEqual(events[0]!.clock.targetId,observer.clock.targetId);assert.deepEqual(events[0]!.clock.sessionId,observer.clock.sessionId);
	let observedDocument=events[0]!.frame;for(const event of events){if(event.kind==='navigation')observedDocument=event.frame;if(['dialog-opened','dialog-closed'].includes(event.kind)){assert.equal(event.dialog.generation,observedDocument.generation);assert.equal(event.dialog.url,observedDocument.url);}}
	const webEvents=rows(record.webEvents);for(let i=0;i<webEvents.length;i++){assert.equal(webEvents[i]!.sequence,i+1);assert.ok(Number.isFinite(webEvents[i]!.at)&&webEvents[i]!.at<=record.at);if(i)assert.ok(webEvents[i]!.at>=webEvents[i-1]!.at,'received and outcome times are contradictory');}
	return{page,observer,documents,events};
}
function dialogs(events:Row[],cancelledOnly:boolean):void{
	const actual=events.filter(row=>['dialog-opened','dialog-closed'].includes(row.kind));
	const wanted=cancelledOnly?[['confirm','Save this test detail?',false]]:[['confirm','Save this test detail?',false],['confirm','Save this test detail?',true],['alert','Saved test detail',null]];
	assert.equal(actual.length,wanted.length*2);
	for(let i=0;i<wanted.length;i++){
		const opened=actual[i*2]!,closed=actual[i*2+1]!,spec=wanted[i]!;assert.equal(opened.kind,'dialog-opened');assert.equal(closed.kind,'dialog-closed');
		assert.equal(opened.dialog.serial,i+1);assert.equal(opened.dialog.type,spec[0]);assert.equal(opened.dialog.message,spec[1]);assert.deepEqual(closed.dialog,opened.dialog);assert.equal(typeof closed.result,'boolean');if(spec[2]!==null)assert.equal(closed.result,spec[2]);
	}
}
function navigation(events:Row[],cancelledOnly:boolean,expected:Expected):void{
	const actual=events.filter(row=>row.kind==='navigation');const form=new URL('/form',expected.url).href;
	assert.deepEqual(actual.map(row=>row.frame.url),cancelledOnly?[form,expected.url]:[form,expected.url,form,expected.url,expected.url]);
	assert.ok(!events.some(row=>row.kind==='same-document-navigation'),'original case requires real back/forward/reload, not a hash-only substitute');
	for(let i=1;i<actual.length;i++)assert.ok(actual[i]!.frame.generation>actual[i-1]!.frame.generation);
	if(!cancelledOnly)assert.notEqual(actual[4]!.frame.loaderId,actual[3]!.frame.loaderId,'the final refresh did not load a new document');
}
function field(page:Row):Row{const matches=rows(page.fields).filter(row=>row.label==='Detail value');assert.equal(matches.length,1);assert.equal(matches[0]!.type,'text');return matches[0]!;}
export function verifyWebDetailPhase(record:Row,phase:'cancelled'|'refreshed'|'escaped'|'complete',expected:Expected):void{
	const {page,events,documents}=base(record,phase,expected),cancelled=phase==='cancelled',origin=new URL(expected.url).origin;
	assert.deepEqual(record.web,{detail:cancelled?'Original detail':expected.value});assert.equal(page.detailStored,'Stored detail: '+(cancelled?'Original detail':expected.value));assert.equal(field(page).value,expected.value);
	const htmlDialogs=rows(page.dialogs);assert.equal(htmlDialogs.length,1);assert.equal(htmlDialogs[0]!.open,cancelled);
	assert.equal(page.status,cancelled?'Confirmation cancelled':phase==='refreshed'?'Ready':phase==='escaped'?'Edit cancelled':'Delayed page focus attempted');
	const outcomes=verifyWebRequestPairs(rows(record.webEvents),cancelled?[]:[{kind:'detail-saved',path:'/api/detail',body:{value:expected.value}}],origin);
	const starts=rows(record.webEvents).filter(row=>row.kind==='service-start');assert.equal(starts.length,1);assert.deepEqual(starts[0]!.web,{detail:'Original detail'});
	const proofs=rows(documents.epochs).flatMap(epoch=>rows(epoch.requestProofs));assert.equal(proofs.length,cancelled?0:1);
	if(!cancelled){const proof=object(outcomes[0]!.proof);assert.deepEqual(outcomes[0]!.web,{detail:expected.value});assert.equal(proof.targetId,expected.targetId);assert.deepEqual(proofs[0]!.proof,proof);assert.equal(proofs[0]!.stage,'committed');}
	dialogs(events,cancelled);navigation(events,cancelled,expected);
}
/** Independent page/server/dialog/document evidence only. The controller must
 * separately establish real Chrome ownership, frozen UI causality, signatures,
 * complete focus monitoring, time/call limits and cleanup. */
export function verifyWebDetailReadback(input:{before:unknown;cancelled:Row;refreshed:Row;escaped:Row;end:Row;calls:Row[]},expected:Expected):void{
	assert.deepEqual(input.before,{detail:'Original detail'});const phases=[input.cancelled,input.refreshed,input.escaped,input.end],names=['cancelled','refreshed','escaped','complete'] as const;
	for(let i=0;i<phases.length;i++)verifyWebDetailPhase(phases[i]!,names[i]!,expected);
	for(let i=1;i<phases.length;i++){
		const earlier=phases[i-1]!,later=phases[i]!;assert.ok(earlier.capturedAt<=later.at);const oldEvents=rows(earlier.browserObserver.events),newEvents=rows(later.browserObserver.events);assert.deepEqual(newEvents.slice(0,oldEvents.length),oldEvents,'later page replaced the original browser event history');
		assert.equal(earlier.browserObserver.sessionId,later.browserObserver.sessionId);assert.deepEqual(earlier.browserObserver.clock,later.browserObserver.clock);
		const oldWeb=rows(earlier.webEvents),newWeb=rows(later.webEvents);assert.deepEqual(newWeb.slice(0,oldWeb.length),oldWeb,'later checkpoint replaced the original service journal');
		const oldEpochs=rows(earlier.documentRequests.epochs),newEpochs=rows(later.documentRequests.epochs);assert.ok(newEpochs.length>=oldEpochs.length);for(let j=0;j<oldEpochs.length;j++){assert.deepEqual(oldEpochs[j]!.document,newEpochs[j]!.document);assert.deepEqual(oldEpochs[j]!.scope,newEpochs[j]!.scope);}
	}
	const finalEvents=rows(input.end.browserObserver.events),confirmAccept=finalEvents.filter(row=>row.kind==='dialog-closed'&&row.dialog.type==='confirm'&&row.result===true);assert.equal(confirmAccept.length,1);
	const outcome=rows(input.end.webEvents).find(row=>row.kind==='detail-saved')!,received=rows(input.end.webEvents).find(row=>row.kind==='request-received')!;assert.ok(received.at>=input.cancelled.capturedAt&&received.at>=confirmAccept[0]!.at&&outcome.at>=received.at&&outcome.at<=input.refreshed.at,'save request did not occur after the real cancellation and accept');
	assert.deepEqual(input.end.requestProofs,rows(input.end.documentRequests.epochs).flatMap(epoch=>epoch.requestProofs));
	const actions=input.calls.filter(call=>call.tool==='web_act'&&call.result?.ok===true).map(call=>{
		const args=object(call.args),receipt=object(call.result.details),steps=Array.isArray(args.steps)?rows(args.steps):[args],actual=Array.isArray(receipt.steps)?rows(receipt.steps):[receipt];
		assert.equal(receipt.dispatched,true);assert.equal(actual.length,steps.length);for(let i=0;i<steps.length;i++){assert.equal(actual[i]!.action,steps[i]!.action);assert.equal(actual[i]!.dispatched,true);assert.ok(!['failed','not_executed'].includes(actual[i]!.outcome));}
		const controls=rows(call.observedControls??[]);assert.equal(controls.length,steps.length);for(let i=0;i<steps.length;i++){assert.equal(controls[i]!.action,steps[i]!.action);assert.equal(controls[i]!.id,steps[i]!.id);}
		return{call,steps,controls};
	});
	const steps=actions.flatMap(row=>row.steps);
	for(const action of ['back','forward','reload'])assert.ok(steps.some(step=>step.action===action),'missing actual production browser '+action);
	assert.ok(steps.some(step=>step.action==='key'&&step.key==='Escape'),'missing actual Escape input');
	const focusCalls=actions.filter(row=>row.controls.some(control=>control.action==='click'&&control.name==='Test delayed focus'));assert.equal(focusCalls.length,1);assert.ok(focusCalls[0]!.call.at>=input.escaped.capturedAt&&focusCalls[0]!.call.end<=input.end.at);
	const nav=rows(input.end.documentRequests.navigations),epochs=rows(input.end.documentRequests.epochs);assert.equal(nav.length,(epochs.length-1)*2);assert.ok(nav.length>=4);for(let i=0;i<nav.length;i+=2){assert.equal(nav[i]!.stage,'revoked');assert.equal(nav[i+1]!.stage,'attached');assert.equal(nav[i]!.id,nav[i+1]!.id);assert.deepEqual(nav[i]!.document,nav[i+1]!.before);assert.deepEqual(nav[i]!.document,epochs[i/2]!.document);assert.deepEqual(nav[i+1]!.document,epochs[i/2+1]!.document);assert.ok(nav[i+1]!.document.generation>nav[i]!.document.generation);const calls=actions.filter(row=>'case10-call-'+row.call.id===nav[i]!.id);assert.equal(calls.length,1,'document boundary lacks its actual dispatched action');assert.ok(calls[0]!.call.at<=nav[i]!.at&&nav[i]!.at<=nav[i+1]!.at&&nav[i+1]!.at<=calls[0]!.call.end);}
}
