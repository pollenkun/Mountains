import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertFormalNativeRequest} from './acceptance/formal-native-policy.ts';
test('formal case 1 cannot switch targets, use a menu or reach modified clipboard shortcuts',()=>{
	const own={pid:1234,windows:['w:567']},args={app:'1234',window:'w:567'};
	assert.doesNotThrow(()=>assertFormalNativeRequest('screen_read',args,own));
	assert.doesNotThrow(()=>assertFormalNativeRequest('screen_act',{...args,steps:[{action:'set_value',id:'e1',text:'own'},{action:'key',key:'Tab'}]},own));
	for(const key of ['cmd+v','cmd+shift+v','meta+alt+v','cmd+c','ctrl+shift+x'])assert.throws(()=>assertFormalNativeRequest('screen_act',{...args,action:'key',key},own),/clipboard/);
	for(const action of ['right_click','menu','perform','paste','bring_to_front','expand'])assert.throws(()=>assertFormalNativeRequest('screen_act',{...args,action},own));
	assert.throws(()=>assertFormalNativeRequest('screen_act',{...args,action:'click',modifiers:['Ctrl']},own));
	assert.throws(()=>assertFormalNativeRequest('screen_act',{...args,steps:[{action:'click',allow_real_pointer:true}]},own));
	assert.throws(()=>assertFormalNativeRequest('screen_read',{...args,app:'1235'},own));
	assert.throws(()=>assertFormalNativeRequest('screen_read',{...args,window:'w:568'},own));
	assert.throws(()=>assertFormalNativeRequest('screen_read',{...args,menus:true},own));
	assert.throws(()=>assertFormalNativeRequest('web_act',{...args,action:'press'},own));
});
test('formal native window policy admits only the current controller-owned document and panel list',()=>{
	const own={pid:1234,windows:['w:567','w:568','w:569']};
	for(const window of own.windows)assert.doesNotThrow(()=>assertFormalNativeRequest('screen_read',{app:'1234',window},own));
	assert.throws(()=>assertFormalNativeRequest('screen_read',{app:'1234',window:'w:570'},own));
	assert.throws(()=>assertFormalNativeRequest('screen_act',{app:'1235',window:'w:569',action:'press'},own));
	assert.throws(()=>assertFormalNativeRequest('screen_read',{app:'1234',window:'w:569'},{pid:1234,windows:['w:567','w:568']}),'closed panels are not retained');
});
