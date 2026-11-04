import assert from 'node:assert/strict';
import {parseKey} from '../../src/tools.ts';

/** Case 1 is an owned native form only. This is a test-controller boundary,
 * not a restriction on the product's supported applications or actions. */
export function assertFormalNativeRequest(tool:unknown,args:Record<string,unknown>,owned:{pid:number;windows:readonly string[]}):void{
	assert.ok(['screen_read','screen_act','screen_look'].includes(String(tool)),'this partial entry only admits native screen tools');
	assert.equal(args.app,String(owned.pid),'exact owned process is required');assert.ok(typeof args.window==='string'&&owned.windows.includes(args.window),'exact current owned document or panel is required');
	assert.ok(!args.menus,'this form case does not admit menu inventory');
	if(tool!=='screen_act')return;
	const steps=Array.isArray(args.steps)?args.steps:[args];assert.ok(steps.length>0&&steps.length<=12);
	for(const raw of steps){
		assert.ok(raw&&typeof raw==='object'&&!Array.isArray(raw));const step=raw as Record<string,unknown>;
		assert.ok(['focus','set_value','type','select_text','select','toggle','press','click','key'].includes(String(step.action)),'action is outside this form case');
		assert.ok(!step.allow_real_pointer,'global pointer forbidden');
		assert.ok(!step.modifiers||Array.isArray(step.modifiers)&&step.modifiers.length===0,'modified clicks are outside this form case');
		if(step.action==='key'){
			const key=parseKey(String(step.key??step.text??''));
			assert.ok(!key.held.some(modifier=>modifier==='Meta'||modifier==='Ctrl')||!['c','v','x'].includes(key.key.toLowerCase()),'clipboard shortcut forbidden');
			assert.ok(['Tab','Enter','Escape'].includes(key.key)&&key.held.every(modifier=>modifier==='Shift'&&key.key==='Tab'),'only form navigation keys are admitted');
		}
	}
}
