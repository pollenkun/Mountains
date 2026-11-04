import assert from 'node:assert/strict';
import {parseKey} from '../../src/tools.ts';
import type {WebShot} from '../../src/web.ts';

/** Acceptance-controller boundary for the owned case6 fixture. It does not
 * restrict the product's websites or apps. No arbitrary JS/command/CDP tool is
 * exposed to the model by this entry. */
export function assertFormalWebRequest(tool:unknown,args:Record<string,unknown>,owned:{tab:string;url:string;shot:WebShot;caseId?:6|7|8|9|10}):void{
	assert.ok(tool==='web_read'||tool==='web_act','only Mountains web tools are exposed');const caseId=owned.caseId??6;assert.ok([6,7,8,9,10].includes(caseId));assert.equal(args.tab,owned.tab,'exact owned tab required');
	assert.equal(args.url,undefined,'the fixture is already open; later navigation is outside this form case');
	assert.ok(!args.new_tab&&!args.newTab&&!args.targets&&!args.files,'new tabs and uploads are outside this form case');
	if(caseId===10){const page=new URL(owned.shot.url);assert.equal(page.origin,new URL(owned.url).origin);assert.ok(['/form','/detail'].includes(page.pathname)&&!page.search&&!page.hash);}
	else assert.equal(owned.shot.url,owned.url,'owned document changed');assert.equal(owned.shot.tab,owned.tab);
	if(tool==='web_read'){assert.ok(Object.keys(args).every(key=>['tab','full','find','cursor'].includes(key)),'read calls cannot carry ignored action parameters');return;}
	const recordField=(name:string)=>name==='Filter records'||/^Comment record-(?:10[1-9]|11[0-3])$/.test(name);
	const taskField=(name:string)=>name==='New task'||/^Task own-[12]$/.test(name);
	const steps=Array.isArray(args.steps)?args.steps:[args];assert.ok(steps.length>0&&steps.length<=12);
	for(const raw of steps){
		assert.ok(raw&&typeof raw==='object'&&!Array.isArray(raw));const step=raw as Record<string,unknown>;
		assert.ok((caseId===10?['type','select','click','key','back','forward','reload']:['type','select','click','key']).includes(String(step.action)),'action is outside this form case');
		assert.ok(!step.files&&!step.allow_real_pointer,'file/real pointer action forbidden');
		if(['back','forward','reload'].includes(String(step.action)))continue;
		if(step.action==='key'){
			const key=parseKey(String(step.key??''));if(['Tab','Enter','Escape'].includes(key.key)&&key.held.every(mod=>mod==='Shift'&&key.key==='Tab'))continue;
			const field=typeof step.id==='string'?owned.shot.elements.get(step.id):undefined;
			assert.ok(field?.role==='textbox'&&(caseId===8&&taskField(field.name)||caseId===9&&recordField(field.name)||caseId===10&&field.name==='Detail value'),'editing keys require an observed owned textbox');
			assert.ok(key.key==='a'&&key.held.length===1&&['Meta','Ctrl'].includes(key.held[0]!)||['Backspace','Delete','Home','End','ArrowLeft','ArrowRight'].includes(key.key)&&key.held.every(mod=>mod==='Shift'),'only selection and text editing keys admitted');continue;
		}
		assert.ok(typeof step.id==='string');const element=owned.shot.elements.get(step.id);assert.ok(element,'unobserved element');
		if(step.action==='type')assert.ok(element.role==='textbox'&&(caseId===6&&element.name==='Name'||caseId===8&&taskField(element.name)||caseId===9&&recordField(element.name)||caseId===10&&element.name==='Detail value'),'typing is limited to the owned fields');
		if(step.action==='select')assert.ok(caseId===6&&element.name==='Color'&&['combobox','listbox'].includes(element.role),'selection is limited to the owned color field');
		if(step.action==='click'){
			if(caseId===10){assert.ok(element.role==='link'&&['Detail','Form'].includes(element.name)||element.role==='button'&&['Edit detail','Save detail','Cancel edit','Refresh page','Test delayed focus','Accept dialog','Dismiss dialog'].includes(element.name),'click is outside this detail fixture');}
			else{if(caseId!==6)assert.equal(element.role,'button');assert.ok(caseId===9?['Apply filter','Clear filter','Previous page','Next page'].includes(element.name)||/^Save record-(?:10[1-9]|11[0-3])$/.test(element.name):caseId===8?['Add task','Reverse sort'].includes(element.name)||/^(?:Save|Delete) own-[12]$/.test(element.name):(caseId===7?['Load data','Start delayed operation','Cancel operation']:['Name','Color','I agree','Submit form']).includes(element.name),'click is outside the selected fixture controls');}
		}
	}
	if(caseId===10){const kinds=steps.map(step=>detailNavigationStep(step as Record<string,unknown>,owned.shot));assert.ok(kinds.every(Boolean)||kinds.every(value=>!value),'navigation and writes must be separate calls so the old document is revoked first');}
}

function detailNavigationStep(step:Record<string,unknown>,shot:WebShot):boolean{
	if(['back','forward','reload'].includes(String(step.action)))return true;
	const element=typeof step.id==='string'?shot.elements.get(step.id):undefined;
	return step.action==='click'&&!!element&&(element.role==='link'&&['Detail','Form'].includes(element.name)||element.role==='button'&&element.name==='Refresh page');
}
/** Called only after assertFormalWebRequest. This classifies an already
 * observed owned control so the controller can revoke before navigation. */
export function formalWebNavigates(tool:unknown,args:Record<string,unknown>,shot:WebShot):boolean{
	return tool==='web_act'&&(Array.isArray(args.steps)?args.steps:[args]).some(step=>detailNavigationStep(step as Record<string,unknown>,shot));
}
