import assert from 'node:assert/strict';
import {test} from 'node:test';
import {POSIX_ONLY} from './fixtures/platform.ts';
import {verifyWebFormReadback} from './acceptance/web-form-readback.ts';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyWebDataWithTarget} from './acceptance/web-verifier-channel.ts';
import {sha256} from './acceptance/integrity.ts';

const expected={targetId:'actual-own-target',url:'http://127.0.0.1:12345/form',name:'Own 山川 🌍',color:'Green',agree:true,after:100,before:200};
const page=()=>({target:expected.targetId,url:expected.url,at:150,provider:'separate raw CDP read-only connection',status:`Submitted ${expected.name} / Green / agreed`,fields:[
	{label:'Name',type:'text',value:expected.name},
	{label:'Color',type:'select-one',value:'Green'},
	{label:'I agree',type:'checkbox',checked:true},
]});
test('Web form readback compares actual fields and status from the exact independent target',POSIX_ONLY,()=>{
	assert.doesNotThrow(()=>verifyWebFormReadback(page(),expected));
	for(const patch of [{target:'other-target'},{url:'http://127.0.0.1:12345/detail'},{at:99},{at:201},{provider:'tool-self-report'},{status:'Ready'},{status:'Error: failed'}]){
		assert.throws(()=>verifyWebFormReadback({...page(),...patch},expected));
	}
});
test('a correct server record cannot hide wrong, missing, duplicated or mismatched DOM controls',POSIX_ONLY,()=>{
	const wrongName=page();wrongName.fields[0]!.value='Wrong';
	const wrongColor=page();wrongColor.fields[1]!.value='Blue';
	const unchecked=page();unchecked.fields[2]!.checked=false;
	const missing=page();missing.fields.shift();
	const duplicated=page();duplicated.fields.push({...duplicated.fields[0]!});
	const password=page();password.fields[0]!.type='password';
	for(const bad of [wrongName,wrongColor,unchecked,missing,duplicated,password])assert.throws(()=>verifyWebFormReadback(bad,expected));
	assert.throws(()=>verifyWebFormReadback({target:expected.targetId,url:expected.url},expected));
	assert.throws(()=>verifyWebFormReadback(page(),{...expected,targetId:''}));
});

test('the actual case6 data verifier refuses correct service data paired with a wrong independent page',POSIX_ONLY,async()=>{
	// Disposable pure evidence objects; no server, browser, account or UI is run.
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-web6-data-verifier-unit-')));
	try{
		mkdirSync(join(root,'web'));mkdirSync(join(root,'evidence'));
		const write=(name:string,value:unknown)=>writeFileSync(join(root,name),JSON.stringify(value));
		const fields={name:expected.name,color:expected.color,agree:expected.agree};
		write('manifest.json',{root,values:{web06:fields}});write('web/server.json',{url:'http://127.0.0.1:12345'});
		const web={forms:[{id:'fake-unit-only',...fields}]};write('web/web-state.json',web);
		write('evidence/case-06-before.json',{id:6,phase:'before',at:80,native:{},nativeEvents:[]});
		writeFileSync(join(root,'evidence/operator.jsonl'),[
			{at:100,call:1,case:6,request:{tool:'web_act',args:{action:'click'}}},
			{at:140,call:1,case:6,result:{ok:true,details:{}},elapsedMs:40},
		].map(row=>JSON.stringify(row)).join('\n')+'\n');
		const complete={id:6,phase:'complete',at:150,capturedAt:200,native:{},nativeEvents:[],web,webEvents:[{kind:'form-invalid'}],webTarget:expected.targetId,page:page()};
		const verify=()=>verifyWebDataWithTarget(root,6,expected.targetId,true);
		for(const status of ['Ready','Error: failed',complete.page.status]){
			write('evidence/case-06-complete.json',{...complete,page:{...complete.page,status}});const result=await verify();
			assert.equal(result.verdict.passed,status===complete.page.status);
		}
		write('evidence/case-06-complete.json',{...complete,webTarget:'other-target',page:{...complete.page,target:'other-target'}});
		assert.equal((await verify()).verdict.passed,false,'changing both checkpoint target fields cannot change the private parent binding');
		const bare=spawnSync(process.execPath,[fileURLToPath(new URL('./acceptance/verify.mjs',import.meta.url)),root,'6','--runner','self','--check'],{encoding:'utf8',timeout:5000});
		assert.equal(bare.status,1,'direct CLI without the private parent channel must fail');
	}finally{rmSync(root,{recursive:true,force:true});}
});

test('the actual pagination verifier binds every intermediate page to its own phase, run target and capture interval',POSIX_ONLY,async()=>{
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-web9-phase-verifier-unit-')));
	try{
		mkdirSync(join(root,'web'));mkdirSync(join(root,'evidence'));
		const write=(name:string,value:unknown)=>writeFileSync(join(root,name),JSON.stringify(value));
		write('manifest.json',{root,values:{web09:{id:'record-111',comment:'own change'}}});write('web/server.json',{url:'http://127.0.0.1:12345'});
		const records=Array.from({length:13},(_,index)=>({id:'record-'+(101+index),name:index===2||index===10?'Quarterly report':'Record '+(101+index),amount:index+1,comment:'Initial '+(101+index)})),web={records},updated=structuredClone(web);updated.records[10]!.comment='own change';
		write('web/web-state.json',updated);writeFileSync(join(root,'evidence/operator.jsonl'),'');
		// This is an explicit no-DOM baseline, not a pretend page capture before Chrome existed.
		write('evidence/case-09-before.json',{id:9,phase:'before',at:100,native:{},nativeEvents:[],web});
		const start={kind:'service-start',at:110,web},proof={targetId:expected.targetId,method:'POST',url:'http://127.0.0.1:12345/api/records',fetchRequestId:'unit-only',nonceSha256:sha256('unit-nonce'),bodySha256:sha256(JSON.stringify({id:'record-111',comment:'own change'}))};
		const phase=(name:string,at:number,recordPage:string,ids:string[],filter='')=>({id:9,phase:name,at,capturedAt:at+2,native:{},nativeEvents:[],web,webEvents:[start] as Record<string,unknown>[],webTarget:expected.targetId,
			page:{target:expected.targetId,url:'http://127.0.0.1:12345/records',provider:'separate raw CDP read-only connection',at:at+1,text:recordPage,recordPage,recordRows:records.filter(row=>ids.includes(row.id)).map(({id,name,comment})=>({id,name,comment})),status:'Updated record-111',fields:[{label:'Filter records',value:filter}]}});
		const paged=phase('paged',120,'Page 3 of 4 / 13 records',['record-109','record-110','record-111','record-112']);
		const filtered=phase('filtered',150,'Page 1 of 1 / 2 records',['record-103','record-111'],'Quarterly report');
		const complete=phase('complete',200,'Page 1 of 4 / 13 records',['record-101','record-102','record-103','record-104']);complete.web=updated;complete.webEvents=[start,{kind:'request-received',at:170,url:proof.url,nonceSha256:proof.nonceSha256,bodySha256:proof.bodySha256},{kind:'record-edited',at:171,id:'record-111',proof,web:updated}];
		write('evidence/case-09-complete.json',complete);
		const verify=()=>verifyWebDataWithTarget(root,9,expected.targetId,true);
		for(const [name,valid]of [['paged',paged],['filtered',filtered]] as const){
			write('evidence/case-09-paged.json',paged);write('evidence/case-09-filtered.json',filtered);
			assert.equal((await verify()).verdict.passed,true);
			for(const patch of [
				{webTarget:'other-target',page:{...valid.page,target:'other-target'}},
				{page:{...valid.page,url:'http://127.0.0.1:12346/records'}},
				{page:{...valid.page,provider:'tool-self-report'}},
				{id:8},{phase:'complete'},{at:99},{capturedAt:203},{page:{...valid.page,at:valid.at-1}},
			]){
				write('evidence/case-09-'+name+'.json',{...valid,...patch});
				assert.equal((await verify()).verdict.passed,false,`${name} must reject ${JSON.stringify(patch)}`);
			}
		}
		write('evidence/case-09-paged.json',{...paged,page:{...paged.page,recordRows:undefined,text:'Page 3 of 4 / 13 records record-111'}});write('evidence/case-09-filtered.json',filtered);
		assert.equal((await verify()).verdict.passed,false,'legacy labels-only evidence must remain insufficient');
	}finally{rmSync(root,{recursive:true,force:true});}
});
