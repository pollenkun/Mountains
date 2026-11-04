import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendFileSync,writeFileSync,mkdtempSync,rmSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FocusTargetCandidates} from './acceptance/focus-targets.ts';

const row=(kind:string,pid:number,fields:Record<string,unknown>={})=>JSON.stringify({kind,observedPid:pid,...fields})+'\n';
const subscription=(pid:number)=>row('subscribed',pid,{notifications:['AXFocusedUIElementChanged']});
test('monitor candidates read appended records once and retain only currently subscribed generations',()=>{
	const root=mkdtempSync(join(tmpdir(),'mountains-focus-candidates-')),path=join(root,'own.jsonl');writeFileSync(path,subscription(22)+subscription(23));const reader=new FocusTargetCandidates(path);
	try{
		assert.deepEqual(reader.read(),[22,23]);assert.deepEqual(reader.read(),[22,23]);
		appendFileSync(path,row('termination-hint',22));assert.deepEqual(reader.read(),[22,23]);
		appendFileSync(path,row('subscription-invalidated',22)+subscription(24));assert.deepEqual(reader.read(),[23,24]);
		appendFileSync(path,row('process-terminated',23)+subscription(22));assert.deepEqual(reader.read(),[22,24]);
		appendFileSync(path,row('notification-unavailable',24,{notification:'AXFocusedWindowChanged'}));assert.deepEqual(reader.read(),[22,24]);
		appendFileSync(path,row('notification-identity-unavailable',24));assert.deepEqual(reader.read(),[22]);
	}finally{reader.close();rmSync(root,{recursive:true,force:true});}
});
test('a partial last record is deferred until complete, not parsed or discarded',()=>{
	const root=mkdtempSync(join(tmpdir(),'mountains-focus-partial-')),path=join(root,'own.jsonl');writeFileSync(path,subscription(22));const reader=new FocusTargetCandidates(path);
	try{assert.deepEqual(reader.read(),[22]);const value=subscription(23);appendFileSync(path,value.slice(0,12));assert.deepEqual(reader.read(),[22]);appendFileSync(path,value.slice(12));assert.deepEqual(reader.read(),[22,23]);}
	finally{reader.close();rmSync(root,{recursive:true,force:true});}
});
test('replaced and truncated journals never supply seemingly live monitor targets',()=>{
	for(const mode of ['replace','truncate']){
		const root=mkdtempSync(join(tmpdir(),'mountains-focus-change-')),path=join(root,'own.jsonl');writeFileSync(path,subscription(22));const reader=new FocusTargetCandidates(path);
		try{assert.deepEqual(reader.read(),[22]);if(mode==='replace'){renameSync(path,path+'.old');writeFileSync(path,subscription(24));}else writeFileSync(path,'');assert.throws(()=>reader.read(),/replaced|truncated/);}
		finally{reader.close();rmSync(root,{recursive:true,force:true});}
	}
});
