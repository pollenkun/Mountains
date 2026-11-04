import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {WebShot} from '../src/web.ts';
import {assertFormalWebRequest,formalWebNavigates} from './acceptance/formal-web-policy.ts';
const url='http://127.0.0.1:1234/form',tab='own-tab';
const shot={url,tab,elements:new Map([['e1',{name:'Name',role:'textbox'}],['e2',{name:'Color',role:'combobox'}],['e3',{name:'I agree',role:'checkbox'}],['e4',{name:'Submit form',role:'button'}],['e5',{name:'External',role:'link'}]])} as unknown as WebShot;
test('formal Web case admits observed owned controls without exposing commands, JS or other tabs',()=>{
	const own={url,tab,shot};assert.doesNotThrow(()=>assertFormalWebRequest('web_read',{tab},own));
	assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,steps:[{action:'type',id:'e1',text:'Own'},{action:'select',id:'e2',text:'Green'},{action:'click',id:'e3'},{action:'click',id:'e4'}]},own));
	for(const tool of ['command_run','screen_act','Runtime.evaluate'])assert.throws(()=>assertFormalWebRequest(tool,{tab},own));
	for(const bad of [{tab:'other'},{tab,url:'https://example.com'},{tab,url},{tab,new_tab:true},{tab,newTab:true},{tab,targets:true}])assert.throws(()=>assertFormalWebRequest('web_read',bad,own));
	for(const ignored of [{action:'back'},{steps:[{action:'back'},{action:'forward'},{action:'reload'}]},{key:'Escape'},{id:'e4'}])assert.throws(()=>assertFormalWebRequest('web_read',{tab,...ignored},own),'read arguments cannot stand in for dispatched input');
	for(const step of [{action:'type',id:'e2'},{action:'select',id:'e1'},{action:'click',id:'e5'},{action:'click',id:'missing'},{action:'handoff'},{action:'upload'},{action:'key',key:'cmd+l'},{action:'key',key:'cmd+v'}])assert.throws(()=>assertFormalWebRequest('web_act',{tab,...step},own));
	assert.throws(()=>assertFormalWebRequest('web_read',{tab},{...own,shot:{...shot,url:url+'#other'}}));
});

test('async case admits its observed buttons while refusing text, other controls and external navigation',()=>{
 const asyncURL='http://127.0.0.1:1234/async';
 const asyncShot={url:asyncURL,tab,elements:new Map([['load',{name:'Load data',role:'button'}],['start',{name:'Start delayed operation',role:'button'}],['cancel',{name:'Cancel operation',role:'button'}],['label',{name:'Load data',role:'statictext'}],['external',{name:'Other page',role:'link'}],['name',{name:'Name',role:'textbox'}]])} as unknown as WebShot;
 const own={url:asyncURL,tab,shot:asyncShot,caseId:7 as const};
 for(const id of ['load','start','cancel'])assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,action:'click',id},own));
 for(const bad of [{action:'click',id:'label'},{action:'click',id:'external'},{action:'type',id:'name',text:'Other'},{action:'key',key:'cmd+l'},{action:'reload'}])assert.throws(()=>assertFormalWebRequest('web_act',{tab,...bad},own));
 assert.throws(()=>assertFormalWebRequest('web_read',{tab,url:asyncURL},own));
});

test('tasks case admits only observed task controls without broadening other cases',()=>{
 const taskURL='http://127.0.0.1:1234/tasks';
 const elements=new Map([
  ['new',{name:'New task',role:'textbox'}],['edit',{name:'Task own-1',role:'textbox'}],
  ['add',{name:'Add task',role:'button'}],['sort',{name:'Reverse sort',role:'button'}],
  ['save',{name:'Save own-1',role:'button'}],['delete',{name:'Delete own-1',role:'button'}],
  ['other',{name:'Delete user-1',role:'button'}],['label',{name:'Delete own-1',role:'statictext'}],
  ['third',{name:'Task own-3',role:'textbox'}],['external',{name:'Other page',role:'link'}],
 ]);
 const own={url:taskURL,tab,shot:{url:taskURL,tab,elements} as unknown as WebShot,caseId:8 as const};
 for(const id of ['new','edit'])assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,action:'type',id,text:'Owned'},own));
 for(const id of ['new','edit'])for(const key of ['cmd+a','ctrl+a','Backspace','Delete','Home','End','shift+ArrowLeft'])assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,action:'key',id,key},own));
 for(const step of [{action:'key',key:'cmd+a'},{action:'key',id:'save',key:'cmd+a'},{action:'key',id:'third',key:'Backspace'},{action:'key',id:'edit',key:'cmd+l'},{action:'key',id:'edit',key:'cmd+v'},{action:'key',id:'edit',key:'a'}])assert.throws(()=>assertFormalWebRequest('web_act',{tab,...step},own));
 for(const id of ['add','sort','save','delete'])assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,action:'click',id},own));
 for(const step of [{action:'type',id:'third',text:'Other'},{action:'click',id:'other'},{action:'click',id:'label'},{action:'click',id:'external'},{action:'select',id:'edit',text:'Other'},{action:'upload',id:'new',files:['/tmp/a']},{action:'key',key:'cmd+v'}])assert.throws(()=>assertFormalWebRequest('web_act',{tab,...step},own));
 for(const caseId of [6,7] as const)for(const id of ['add','sort','save','delete'])assert.throws(()=>assertFormalWebRequest('web_act',{tab,action:'click',id},{...own,caseId}));
});

test('records case permits observed pagination, filtering and exact text editing but no other data routes',()=>{
 const recordURL='http://127.0.0.1:1234/records',elements=new Map([
  ['filter',{name:'Filter records',role:'textbox'}],['target',{name:'Comment record-111',role:'textbox'}],['neighbor',{name:'Comment record-103',role:'textbox'}],
  ['apply',{name:'Apply filter',role:'button'}],['clear',{name:'Clear filter',role:'button'}],['previous',{name:'Previous page',role:'button'}],['next',{name:'Next page',role:'button'}],
  ['save',{name:'Save record-111',role:'button'}],['other',{name:'Save record-999',role:'button'}],['label',{name:'Next page',role:'statictext'}],['name',{name:'Name',role:'textbox'}],['task',{name:'Delete own-1',role:'button'}],
 ]),own={url:recordURL,tab,shot:{url:recordURL,tab,elements} as unknown as WebShot,caseId:9 as const};
 for(const id of ['filter','target','neighbor']){assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,action:'type',id,text:'Value'},own));for(const key of ['cmd+a','Backspace','Delete'])assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,action:'key',id,key},own));}
 for(const id of ['apply','clear','previous','next','save'])assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,action:'click',id},own));
 for(const step of [{action:'click',id:'other'},{action:'click',id:'label'},{action:'click',id:'task'},{action:'type',id:'name',text:'Value'},{action:'key',key:'cmd+a'},{action:'key',id:'save',key:'cmd+a'},{action:'key',id:'target',key:'cmd+l'},{action:'key',id:'target',key:'cmd+v'},{action:'select',id:'filter',text:'Other'},{action:'reload'}])assert.throws(()=>assertFormalWebRequest('web_act',{tab,...step},own));
 for(const caseId of [6,7,8] as const)assert.throws(()=>assertFormalWebRequest('web_act',{tab,action:'click',id:'next'},{...own,caseId}));
});

test('detail case separates pure observed navigation from editing without loosening older cases',()=>{
	const detailURL='http://127.0.0.1:1234/detail',elements=new Map([
		['field',{name:'Detail value',role:'textbox'}],['link',{name:'Detail',role:'link'}],['form',{name:'Form',role:'link'}],
		['edit',{name:'Edit detail',role:'button'}],['save',{name:'Save detail',role:'button'}],['refresh',{name:'Refresh page',role:'button'}],
		['focus',{name:'Test delayed focus',role:'button'}],['accept',{name:'Accept dialog',role:'button'}],['dismiss',{name:'Dismiss dialog',role:'button'}],
		['external',{name:'Outside',role:'link'}],['label',{name:'Detail',role:'statictext'}],['other',{name:'Name',role:'textbox'}],
	]),detailShot={url:detailURL,tab,elements} as unknown as WebShot,own={url,tab,shot:detailShot,caseId:10 as const};
	for(const args of [{action:'click',id:'link'},{action:'click',id:'form'},{action:'click',id:'refresh'},{steps:[{action:'back'},{action:'forward'},{action:'reload'}]}]){assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,...args},own));assert.equal(formalWebNavigates('web_act',args,detailShot),true);}
	for(const args of [{action:'type',id:'field',text:'Owned'},{action:'key',id:'field',key:'cmd+a'},{action:'key',key:'Escape'},{action:'click',id:'edit'},{action:'click',id:'save'},{action:'click',id:'focus'},{action:'click',id:'accept'},{action:'click',id:'dismiss'}]){assert.doesNotThrow(()=>assertFormalWebRequest('web_act',{tab,...args},own));assert.equal(formalWebNavigates('web_act',args,detailShot),false);}
	for(const args of [{steps:[{action:'back'},{action:'type',id:'field',text:'Mixed'}]},{steps:[{action:'click',id:'refresh'},{action:'click',id:'save'}]},{action:'click',id:'external'},{action:'click',id:'label'},{action:'type',id:'other',text:'Wrong'},{action:'key',key:'cmd+v'}])assert.throws(()=>assertFormalWebRequest('web_act',{tab,...args},own));
	assert.throws(()=>assertFormalWebRequest('web_read',{tab},{...own,shot:{...detailShot,url:'http://127.0.0.1:1234/other'}}));
	for(const caseId of [6,7,8,9] as const)assert.throws(()=>assertFormalWebRequest('web_act',{tab,action:'back'},{...own,url:detailURL,caseId}));
});
