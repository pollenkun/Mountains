import assert from 'node:assert/strict';
import {test} from 'node:test';
import {POSIX_ONLY} from './fixtures/platform.ts';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detailEvidence} from './fixtures/detail-evidence.ts';
import {verifyWebDataWithTarget} from './acceptance/web-verifier-channel.ts';

test('the actual case10 child verifier consumes the pinned target, all phases and the production call trace',POSIX_ONLY,async()=>{
	// Pure disposable evidence, never Chrome, UI, actual keys or model success.
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-web10-verifier-unit-'))),f=detailEvidence();
	try{
		mkdirSync(join(root,'web'));mkdirSync(join(root,'evidence'));const write=(path:string,value:unknown)=>writeFileSync(join(root,path),JSON.stringify(value));
		write('manifest.json',{root,values:{web10:{value:f.expected.value}}});write('web/server.json',{url:new URL(f.expected.url).origin});
		write('evidence/case-10-before.json',{id:10,phase:'before',at:80,native:{},nativeEvents:[],web:f.input.before});
		for(const phase of ['cancelled','refreshed','escaped','complete'] as const){const record=phase==='complete'?f.input.end:f.input[phase];write('evidence/case-10-'+phase+'.json',{...record,native:{},nativeEvents:[]});}
		const log=f.input.calls.flatMap(call=>[
			{at:call.at,call:call.id,case:10,request:{tool:call.tool,args:call.args}},
			{at:call.end,call:call.id,case:10,result:call.result,elapsedMs:call.end-call.at,observedControls:call.observedControls??[]},
		]);writeFileSync(join(root,'evidence/operator.jsonl'),log.map(row=>JSON.stringify(row)).join('\n')+'\n');
		const verify=()=>verifyWebDataWithTarget(root,10,f.expected.targetId);
		assert.equal((await verify()).verdict.passed,true);
		write('evidence/case-10-refreshed.json',{...f.input.refreshed,page:{...f.input.refreshed.page,target:'other-target'},webTarget:'other-target'});assert.equal((await verify()).verdict.passed,false,'public evidence cannot replace the parent target');
		write('evidence/case-10-refreshed.json',{...f.input.refreshed,browserObserver:{...f.input.refreshed.browserObserver,failure:'earlier private session disconnected'}});assert.equal((await verify()).verdict.passed,false,'new successful pages cannot clear earlier observation failure');
	}finally{rmSync(root,{recursive:true,force:true});}
});
