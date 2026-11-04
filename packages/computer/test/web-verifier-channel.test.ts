import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {closeSync,mkdtempSync,openSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {POSIX_ONLY} from './fixtures/platform.ts';
import type {Writable} from 'node:stream';
import {verifyWebDataWithTarget} from './acceptance/web-verifier-channel.ts';

const reader=fileURLToPath(new URL('./fixtures/read-web-binding.ts',import.meta.url));
const setup=()=>{
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-private-web-binding-unit-')));
	writeFileSync(join(root,'manifest.json'),JSON.stringify({root}));
	return{root,frame:JSON.stringify({schema:'web-verifier-target-v1',root,caseId:6,targetId:'own-target'})+'\n',close:()=>rmSync(root,{recursive:true,force:true})};
};
async function run(root:string,payload?:string|Buffer,options:{fd?:number;hold?:boolean}={}){
	const child=spawn(process.execPath,[reader,root,'6'],{stdio:['ignore','pipe','pipe',options.fd??'pipe']});
	let stdout='',stderr='';child.stdout!.on('data',chunk=>{stdout+=chunk;});child.stderr!.on('data',chunk=>{stderr+=chunk;});
	const input=child.stdio[3] as Writable|null;input?.on('error',()=>{});
	const timer=setTimeout(()=>child.kill('SIGKILL'),4000);
	try{
		if(options.fd===undefined){if(options.hold)input!.write(payload??'');else input!.end(payload);}
		const [code,signal]=await once(child,'close');
		assert.equal(signal,null,'binding reader must exit by itself');
		return{code,stdout,stderr,pid:child.pid};
	}finally{clearTimeout(timer);input?.destroy();}
}

test('private Web target requires one bounded canonical EOF frame, independent of read chunks',POSIX_ONLY,async()=>{
	const fixture=setup();
	try{
		const good=await run(fixture.root,fixture.frame);assert.equal(good.code,0);assert.equal(good.stdout,fixture.frame);
		const invalid=[undefined,'',fixture.frame.trimEnd(),fixture.frame+fixture.frame,fixture.frame+' ',fixture.frame.replace('"schema"',' "schema"'),
			fixture.frame.replace('"caseId":6','"caseId":6,"caseId":6'),Buffer.from([0xff,10]),'x'.repeat(4097)+'\n'];
		for(const payload of invalid){const result=await run(fixture.root,payload);assert.equal(result.code,1);assert.equal(result.stdout,'');}
	}finally{fixture.close();}
});
test('private Web target rejects a different run, case, manifest, target or schema',POSIX_ONLY,async()=>{
	const fixture=setup();
	try{
		const value=JSON.parse(fixture.frame);
		for(const patch of [{root:fixture.root+'-other'},{caseId:7},{caseId:6.5},{schema:'other'},{targetId:''},{targetId:'x/y'},{targetId:'x'.repeat(257)},{extra:true}]){
			assert.equal((await run(fixture.root,JSON.stringify({...value,...patch})+'\n')).code,1);
		}
		writeFileSync(join(fixture.root,'manifest.json'),JSON.stringify({root:fixture.root+'-other'}));
		assert.equal((await run(fixture.root,fixture.frame)).code,1);
	}finally{fixture.close();}
});
test('a public file cannot stand in for the private channel, and a complete frame still requires EOF',POSIX_ONLY,async()=>{
	const fixture=setup();let fd:number|undefined;
	try{
		const path=join(fixture.root,'public.json');writeFileSync(path,fixture.frame);fd=openSync(path,'r');
		assert.equal((await run(fixture.root,undefined,{fd})).code,1);
		const started=performance.now();const held=await run(fixture.root,fixture.frame,{hold:true});
		assert.equal(held.code,1);assert.ok(performance.now()-started>=900,'open channel must wait for its deadline, not accept the first frame');
		assert.equal(held.stdout,'');
	}finally{if(fd!==undefined)closeSync(fd);fixture.close();}
});
test('private verifier transport propagates actual child exit and never fabricates a verdict',POSIX_ONLY,async()=>{
	const fixture=setup();
	try{
		// The actual fixed verifier exits before reading fd3 because this pure-data
		// run has no checkpoints. Sending the binding must not turn that into success.
		await assert.rejects(verifyWebDataWithTarget(fixture.root,6,'own-target',true));
		for(const [caseId,target]of [[5,'own-target'],[11,'own-target'],[6,'bad/target']] as const)
			await assert.rejects(verifyWebDataWithTarget(fixture.root,caseId,target,true));
	}finally{fixture.close();}
});
