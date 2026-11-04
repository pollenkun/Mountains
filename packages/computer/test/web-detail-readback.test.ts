import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyWebDetailReadback} from './acceptance/web-detail-readback.ts';
import {sha256} from './acceptance/integrity.ts';
import {detailEvidence as fixture} from './fixtures/detail-evidence.ts';
type Row=Record<string,any>;
// Pure evidence examples and counterexamples. No signing key, Chrome, model
// input, real dialog, actual history operation or focus safety is proved here.

test('detail evidence retains real cancel/accept/alert and old write across a history round trip and new reload',()=>{const f=fixture();verifyWebDetailReadback(f.input,f.expected);});
for(const kind of ['wrong-baseline','cancelled-write','cancelled-closed-html','cancelled-wrong-value','missing-actual-dialog','missing-alert','wrong-accept','missing-dialog-result','dialog-wrong-document','lost-observation-start','page-exception','observer-failed','changed-observer-session','changed-clock','replaced-earlier-events','wrong-dom-document','wrong-dom-target','wrong-dom-provider','stale-dom-time','refreshed-wrong-value','no-new-loader','no-real-back','no-real-escape','no-real-focus','early-focus','extra-restored-post','wrong-post-body','wrong-post-target','lost-old-proof','lost-old-preparation','wrong-old-preparation','old-connection-not-closed','reused-connection','document-manager-failed','active-input','lost-navigation-boundary','cancelled-after-write','wrong-phase','read-args-as-navigation','read-args-as-escape','read-args-as-focus','undispatched-navigation','partial-navigation','request-after-outcome','request-before-cancel-check','replaced-service-prefix'] as const)test('detail evidence rejects '+kind,()=>{
	const f=fixture(),{input}=f,{cancelled,refreshed,escaped,end}=input;
	switch(kind){
		case'wrong-baseline':input.before.detail='Changed';break;
		case'cancelled-write':cancelled.web.detail=f.expected.value;break;
		case'cancelled-closed-html':cancelled.page.dialogs[0].open=false;break;
		case'cancelled-wrong-value':cancelled.page.fields[0].value='Wrong';break;
		case'missing-actual-dialog':cancelled.browserObserver.events=cancelled.browserObserver.events.filter((row:Row)=>row.kind!=='dialog-opened');break;
		case'missing-alert':end.browserObserver.events=end.browserObserver.events.filter((row:Row)=>row.dialog?.type!=='alert');break;
		case'wrong-accept':refreshed.browserObserver.events.find((row:Row)=>row.kind==='dialog-closed'&&row.dialog.serial===2).result=false;break;
		case'missing-dialog-result':delete cancelled.browserObserver.events.at(-1).result;break;
		case'dialog-wrong-document':cancelled.browserObserver.events.at(-1).dialog.generation=0;break;
		case'lost-observation-start':end.browserObserver.events[0].kind='untrusted-start';break;
		case'page-exception':end.browserObserver.events.push({kind:'page-exception',sequence:end.browserObserver.events.length+1,at:200});break;
		case'observer-failed':end.browserObserver.failure='Observation disconnected';break;
		case'changed-observer-session':escaped.browserObserver.sessionId='different-permanent';break;
		case'changed-clock':escaped.browserObserver.clock.targetId='replacement-clock';break;
		case'replaced-earlier-events':end.browserObserver.events[1].at=99;break;
		case'wrong-dom-document':refreshed.page.document.loaderId='other-loader';break;
		case'wrong-dom-target':refreshed.page.target='other-target';break;
		case'wrong-dom-provider':refreshed.page.provider='product-self-report';break;
		case'stale-dom-time':refreshed.page.at=refreshed.at-1;break;
		case'refreshed-wrong-value':refreshed.page.detailStored='Stored detail: Wrong';break;
		case'no-new-loader':for(const record of [refreshed,escaped,end])record.browserObserver.events.at(-1).frame.loaderId='detail-loader';break;
  case'no-real-back':input.calls[1]!.args.steps![0]!.action='forward';break;
  case'no-real-escape':input.calls[2]!.args.key='Tab';break;
  case'no-real-focus':input.calls[3]!.observedControls=[];break;
  case'early-focus':input.calls[3]!.at=170;break;
		case'extra-restored-post':end.webEvents.push(structuredClone(end.webEvents[1]),structuredClone(end.webEvents[2]));break;
		case'wrong-post-body':end.webEvents[1].bodySha256=end.webEvents[2].proof.bodySha256=sha256('{"value":"Wrong"}');break;
		case'wrong-post-target':end.webEvents[2].proof.targetId='other-target';break;
		case'lost-old-proof':end.documentRequests.epochs[1].requestProofs=[];break;
		case'lost-old-preparation':end.documentRequests.epochs[1].preparations=[];break;
		case'wrong-old-preparation':end.documentRequests.epochs[1].preparations[0].observation.document.loaderId='wrong';break;
		case'old-connection-not-closed':end.documentRequests.epochs[1].closed=false;break;
		case'reused-connection':end.documentRequests.epochs[2].scope.sessionId='request-detail';break;
		case'document-manager-failed':end.documentRequests.failure='earlier cancelled';break;
		case'active-input':end.documentRequests.active='old-input';break;
		case'lost-navigation-boundary':end.documentRequests.navigations.splice(0,2);break;
		case'cancelled-after-write':cancelled.at=134;cancelled.capturedAt=136;cancelled.page.at=135;break;
  case'wrong-phase':escaped.phase='refreshed';break;
  case'read-args-as-navigation':input.calls[1]!.tool='web_read';break;
  case'read-args-as-escape':input.calls[2]!.tool='web_read';break;
  case'read-args-as-focus':input.calls[3]!.tool='web_read';break;
  case'undispatched-navigation':input.calls[1]!.result.details.steps[0].dispatched=false;break;
  case'partial-navigation':input.calls[1]!.result.details.steps.pop();break;
  case'request-after-outcome':for(const record of [refreshed,escaped,end])record.webEvents[1].at=134;break;
  case'request-before-cancel-check':for(const record of [refreshed,escaped,end])record.webEvents[1].at=120;break;
  case'replaced-service-prefix':end.webEvents[0].at=79;break;
	}
	assert.throws(()=>verifyWebDetailReadback(input,f.expected));
});
