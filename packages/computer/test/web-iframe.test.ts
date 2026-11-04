import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {ChildProcess} from 'node:child_process';
import {WebBrowser,type WebShot,type WebElement,type CdpLike} from '../src/web.ts';

const chrome=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',join(homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')].find(existsSync);
// Targeted product regression only. This does not open account applications,
// use a user profile or count as the formal, independently monitored 20 tasks.
test('headless Chrome reads and operates nested same-site and cross-site frames safely',{skip:!chrome,timeout:90_000},async context=>{
	const root=await mkdtemp(join(tmpdir(),'mountains-iframe-integration-')),profile=join(root,'profile'),file=join(root,'own-upload.txt');await writeFile(file,'fresh iframe upload 你好 🌍');
	const audit:{who:string;kind:string;value:string}[]=[],timings:{action:string;ms:number;status:'sent'|'rejected'}[]=[],reads:{phase:string;ms:number}[]=[];
	let port=0;
	const server=createServer(async(req,res)=>{
		if(req.url==='/audit'){let body='';for await(const part of req)body+=part;audit.push(JSON.parse(body));res.writeHead(200);res.end('ok');return;}
		if(req.url==='/legacy'){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<!doctype html><html><head><title>Fresh legacy frameset</title></head><frameset cols="100%"><frame src="/leaf" name="own-legacy"></frameset></html>');return;}
		const who=req.url==='/same'?'Same':req.url==='/cross'?'Cross':req.url==='/leaf'?'Legacy':'Main';
		const nested=who==='Main'?`<iframe title="Same document" src="/same" style="width:700px;height:620px;border:7px solid"></iframe>`:who==='Same'?`<iframe title="Cross document" src="http://localhost:${port}/cross" style="width:450px;height:350px;border:9px solid"></iframe>`:'';
		res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(`<!doctype html><meta charset="utf-8"><title>${who} fresh fixture</title>
		<style>body{margin:17px}input,button,select{display:block;margin:12px}</style><h1>${who} fixture</h1>
		<input id="field" aria-label="${who} field"><input id="card" aria-label="${who} Card number">
		<input id="credential" type="password" aria-label="${who} credential"><div id="shadow"></div><div id="closed"></div>
		<select id="color" aria-label="${who} color"><option value="red">Red</option><option value="blue">Blue</option></select>
		<input id="upload" type="file" aria-label="${who} upload"><button id="click">${who} click</button><button id="confirm">${who} confirm</button>${nested}
		<script>const who=${JSON.stringify(who)},report=(kind,value)=>fetch('/audit',{method:'POST',body:JSON.stringify({who,kind,value})});
		field.addEventListener('input',()=>report('input',field.value));card.addEventListener('input',()=>report('card',card.value));
		credential.addEventListener('input',()=>{credential.type='text';report('credential-length',String(credential.value.length))});
		const component=shadow.attachShadow({mode:'open'});component.innerHTML='<input id="inner" aria-label="${who} component field"><label id="pay-label">Card number</label><input id="opaque" aria-labelledby="pay-label">';
		component.getElementById('inner').addEventListener('input',()=>report('component',component.getElementById('inner').value));
		const sealed=document.getElementById('closed').attachShadow({mode:'closed'});sealed.innerHTML='<input id="inner" aria-label="${who} sealed field"><label id="card-label">Card number</label><input id="opaque" aria-labelledby="card-label">';
		sealed.getElementById('inner').addEventListener('input',()=>report('sealed',sealed.getElementById('inner').value));
		window.focusClosedCard=()=>sealed.getElementById('opaque').focus();
		color.addEventListener('change',()=>report('select',color.value));upload.addEventListener('change',()=>report('upload',upload.files[0]?.name||''));
		document.getElementById('click').onclick=()=>report('click','clicked');document.getElementById('confirm').onclick=()=>{if(confirm('Own iframe long confirm'))report('confirm','accepted')};
		</script>`);
	});
	await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));const address=server.address();assert.ok(address&&typeof address==='object');port=address.port;
	const browser=new WebBrowser({headless:true,chromePath:chrome!,profileDir:profile,idleMs:100}),signal=new AbortController().signal;
	let child:ChildProcess|null|undefined;
	const internal=browser as unknown as {connection():Promise<CdpLike>;child:ChildProcess|null};
	const element=(shot:WebShot,name:string):WebElement=>{const found=[...shot.elements.values()].find(el=>el.name===name);assert.ok(found,'Missing '+name+' in '+[...shot.elements.values()].map(el=>el.name).join(', '));return found;};
	const observed=async(who:string,kind:string,value:string)=>{const until=Date.now()+2500;while(!audit.some(item=>item.who===who&&item.kind===kind&&item.value===value)){assert.ok(Date.now()<until,`Independent HTTP audit did not observe ${who}/${kind}/${value}: ${JSON.stringify(audit)}`);await delay(10);}};
	try{
		const firstRead=performance.now();let shot=await browser.open({url:`http://127.0.0.1:${port}/`,full:true},signal);reads.push({phase:'cold',ms:Math.round(performance.now()-firstRead)});child=internal.child;
		const read=async()=>{const started=performance.now();shot=await browser.open({full:true},signal);reads.push({phase:'warm',ms:Math.round(performance.now()-started)});};
		const originalTab=shot.tab,main=element(shot,'Main field'),same=element(shot,'Same field'),cross=element(shot,'Cross field');
		assert.equal(same.sessionId,main.sessionId);assert.notEqual(same.frameId,main.frameId);assert.notEqual(cross.sessionId,main.sessionId,'This test must actually use a cross-process iframe');
		const act=async(step:Parameters<WebBrowser['perform']>[1])=>{const started=performance.now();try{const done=await browser.perform(shot,step,signal);timings.push({action:step.action,ms:Math.round(performance.now()-started),status:'sent'});shot=done.shot;return done;}catch(error){timings.push({action:step.action,ms:Math.round(performance.now()-started),status:'rejected'});throw error;}};
		for(const who of ['Main','Same','Cross']){
			const value=who+' 你好 🌍';assert.equal((await act({action:'type',id:element(shot,who+' field').id,text:value})).readback,value);await observed(who,'input',value);
			await act({action:'click',id:element(shot,who+' click').id});await observed(who,'click','clicked');
		}
		await act({action:'type',id:element(shot,'Cross field').id,text:'x'});await act({action:'key',key:'y'});await observed('Cross','input','Cross 你好 🌍xy');
		const selected=await act({action:'key',key:process.platform==='darwin'?'cmd+a':'ctrl+a'});assert.equal(selected.selectionVerified,true);
		await act({action:'type',id:element(shot,'Cross field').id,text:'replacement'});await observed('Cross','input','replacement');
		await act({action:'select',id:element(shot,'Cross color').id,text:'Blue'});await observed('Cross','select','blue');
		await act({action:'upload',id:element(shot,'Cross upload').id,files:[file]});await observed('Cross','upload','own-upload.txt');
		const fakeCredential='fixture-only-value',credential=element(shot,'Cross credential');assert.equal(credential.secure,true);
		const hidden=await act({action:'type',id:credential.id,text:fakeCredential});assert.equal(hidden.readback,null);assert.equal(hidden.passwordLength,fakeCredential.length);await observed('Cross','credential-length',String(fakeCredential.length));assert.doesNotMatch([...shot.lines.values()].join('\n'),new RegExp(fakeCredential));
		await act({action:'type',id:element(shot,'Cross component field').id,text:'component 你好 🌍'});await act({action:'key',key:'z'});await observed('Cross','component','component 你好 🌍z');
		await act({action:'type',id:element(shot,'Cross sealed field').id,text:'closed 你好 🌍'});await act({action:'key',key:'z'});await observed('Cross','sealed','closed 你好 🌍z');
		const cdp=await internal.connection();
		const inFrame=async(el:WebElement,expression:string)=>{
			const world=await cdp.send('Page.createIsolatedWorld',{frameId:el.frameId,worldName:'independent-fixture-setup'},el.sessionId) as {executionContextId:number};
			const response=await cdp.send('Runtime.evaluate',{expression,contextId:world.executionContextId,returnByValue:true},el.sessionId) as {exceptionDetails?:unknown};assert.equal(response.exceptionDetails,undefined);
		};
		// Technical controller setup: no model/UI claim. Local focus can remain
		// in a child after its focus handler synchronously redirects the parent.
		await inFrame(element(shot,'Same field'),`document.getElementById('field').addEventListener('focus',()=>top.document.getElementById('field').focus(),{once:true})`);
		const before=audit.length;
		await assert.rejects(act({action:'type',id:element(shot,'Same field').id,text:'must-not-land'}),/focus changed|actual keyboard receiver changed/);
		await delay(50);assert.equal(audit.slice(before).some(item=>item.value.includes('must-not-land')),false);
		await read();
		await inFrame(element(shot,'Cross field'),`document.getElementById('card').focus()`);const cardBefore=audit.length;
		await assert.rejects(act({action:'key',key:'4'}),/payment/);await delay(50);assert.equal(audit.slice(cardBefore).some(item=>item.kind==='card'),false);
		await inFrame(element(shot,'Cross field'),`document.getElementById('shadow').shadowRoot.getElementById('opaque').focus()`);
		await assert.rejects(act({action:'key',key:'4'}),/payment/);
		// The closed root is deliberately unavailable through host.shadowRoot.
		// Calling this fixture's main-world function is controller setup only.
		const closedNode=element(shot,'Cross sealed field');await cdp.send('Runtime.evaluate',{expression:'window.focusClosedCard()',returnByValue:true},closedNode.sessionId);
		await assert.rejects(act({action:'key',key:'4'}),/payment/);
		await read();
		const legacyRead=performance.now();shot=await browser.open({url:`http://127.0.0.1:${port}/legacy`,newTab:true,full:true},signal);reads.push({phase:'new-tab',ms:Math.round(performance.now()-legacyRead)});
		await act({action:'type',id:element(shot,'Legacy field').id,text:'legacy 你好'});await act({action:'key',key:'!'});await observed('Legacy','input','legacy 你好!');
		await inFrame(element(shot,'Legacy field'),`document.getElementById('card').focus()`);await assert.rejects(act({action:'key',key:'4'}),/payment/);
		// Return explicitly to the original owned tab for the long-dialog test.
		const returnRead=performance.now();shot=await browser.open({tab:originalTab,full:true},signal);reads.push({phase:'warm',ms:Math.round(performance.now()-returnRead)});
		const paused=await act({action:'click',id:element(shot,'Cross confirm').id});assert.equal(paused.pausedByDialog,true);assert.match([...shot.lines.values()].join('\n'),/Own iframe long confirm/);
		await delay(20_000); // The original lost-release regression used 15 s.
		const accept=element(shot,'Accept dialog');await act({action:'click',id:accept.id});await observed('Cross','confirm','accepted');
		await act({action:'type',id:element(shot,'Cross field').id,text:' after-dialog'});await observed('Cross','input','replacement after-dialog');
		context.diagnostic(JSON.stringify({evidence:'own headless Chrome plus independent local HTTP audit; no formal focus-monitor verdict',frames:{sameRenderer:true,crossRenderer:true,nested:true},heldDialogSeconds:20,directProductCalls:timings.length+reads.length,actions:timings.length,reads,timings}));
	}finally{
		try{await browser.close();if(child)assert.ok(child.exitCode!==null||child.signalCode!==null,'The held own Chrome child must actually exit');}
		finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
	}
});
