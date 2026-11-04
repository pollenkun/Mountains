import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {FileStateTracker,Workspace,type ToolContext} from '@mountains/tools';
import {CdpConnection,WebBrowser,createWebTools} from '../src/web.ts';

const chrome=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',join(homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')].find(existsSync);
// Product regression, not the formal 20 tasks: no account app, global input,
// clipboard, user profile, paid model or claimed global-focus verdict.
test('headless Chrome reads a 5000-record page cheaply without losing full search, pagination or moved input',{skip:!chrome,timeout:90_000},async context=>{
	const root=await mkdtemp(join(tmpdir(),'mountains-large-page-test-')),rows=5000,events:string[]=[],protocol:{method:string;bytes:number}[]=[],samples:{tool:string;phase:string;ms:number}[]=[];
	const approvals:unknown[]=[],html=`<!doctype html><meta charset="utf-8"><title>Own large page</title><h1>Own large page</h1><label id="edit-label">Own edit<input id="own-edit"></label><p id="status">No edit yet</p><main>${Array.from({length:rows},(_,i)=>`<section><h2>Own record ${i}</h2><p>Fresh synthetic details ${i}</p><button>Inspect record ${i}</button></section>`).join('')}</main><script>document.getElementById('own-edit').addEventListener('input',event=>{document.getElementById('status').textContent='Length '+event.target.value.length;fetch('/audit',{method:'POST',body:JSON.stringify(event.target.value)})})</script>`;
	const server=createServer(async(req,res)=>{if(req.url==='/audit'){let body='';for await(const part of req)body+=part;events.push(JSON.parse(body) as string);res.end('ok');return;}res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);});
	await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
	const browser=new WebBrowser({headless:true,chromePath:chrome!,profileDir:join(root,'profile'),downloadDir:join(root,'downloads'),idleMs:100});
	const internal=browser as unknown as {child:import('node:child_process').ChildProcess|null;connection():Promise<import('../src/web.ts').CdpLike>};
	const tools=Object.fromEntries(createWebTools({browser}).map(tool=>[tool.name,tool]));let call=0;
	const original=CdpConnection.prototype.send;
	CdpConnection.prototype.send=async function(method,params,session,timeout){const reply=await original.call(this,method,params,session,timeout);protocol.push({method,bytes:Buffer.byteLength(JSON.stringify(reply)??'')});return reply;};
	const invoke=async(tool:string,args:Record<string,unknown>,phase:string)=>{
		const ctx:ToolContext={workspace:new Workspace(root),files:new FileStateTracker(),signal:new AbortController().signal,toolCallId:'large-'+ ++call,approve:async request=>{approvals.push({request,answer:'allow',answeredBy:'test script for this individual approval, not standing human permission'});return 'allow';}};
		const began=performance.now(),result=await tools[tool]!.execute(args,ctx);samples.push({tool,phase,ms:performance.now()-began});assert.equal(result.ok,true,result.modelContent);return result;
	};
	const observed=async(expected:string)=>{const until=performance.now()+3000;while(events.at(-1)!==expected){assert.ok(performance.now()<until,'Independent HTTP edit audit missing');await delay(5);}};
	try{
		const first=await invoke('web_read',{url:`http://127.0.0.1:${address.port}/`},'cold'),tab=first.details.tab;
		assert.equal(first.details.complete,false);assert.equal(first.details.bounded,true);assert.match(first.modelContent,/full:true|find/);
		const id=first.modelContent.match(/(e\d+) textbox "Own edit"/)?.[1];assert.ok(id,first.modelContent);
		for(let i=0;i<30;i++){const read=await invoke('web_read',{tab},'warm');assert.equal(read.details.diff,true);assert.equal(read.details.complete,false);assert.match(read.modelContent,/partial|absence/);}
		let expected='';for(let i=0;i<30;i++){expected+='x';const edited=await invoke('web_act',{tab,action:'type',id,text:'x'},'action');assert.equal(edited.details.outcome,'confirmed');assert.match(edited.modelContent,new RegExp('Length '+expected.length));await observed(expected);}
		assert.equal(protocol.some(entry=>entry.method==='Accessibility.getFullAXTree'),false,'ordinary calls must not read the full page');
		const defaultAxBytes=protocol.filter(entry=>entry.method.startsWith('Accessibility.')).reduce((sum,entry)=>sum+entry.bytes,0);
		const p95=(phase:string)=>samples.filter(sample=>sample.phase===phase).map(sample=>sample.ms).sort((a,b)=>a-b)[28]!;
		assert.ok(p95('warm')<=1500,'30-sample warm-read p95 exceeded 1.5 seconds');assert.ok(p95('action')<=4000,'30-sample ordinary-action p95 exceeded 4 seconds');
		let page=await invoke('web_read',{tab,full:true},'full'),pages=1;const found=new Set<number>();
		for(;;){for(const match of page.modelContent.matchAll(/button "Inspect record (\d+)"/g))found.add(Number(match[1]));if(!page.details.nextCursor)break;assert.ok(++pages<=100,'full continuation did not finish');page=await invoke('web_read',{cursor:page.details.nextCursor},'cursor');}
		assert.equal(page.details.complete,true);assert.equal(found.size,rows);for(let i=0;i<rows;i++)assert.ok(found.has(i),'full read omitted record '+i);
		const search=await invoke('web_read',{tab,find:'Inspect record 4999'},'search');assert.match(search.modelContent,/Inspect record 4999/);
		const bounded=await invoke('web_read',{tab},'after-search');assert.equal(bounded.details.diff,true);assert.doesNotMatch(bounded.modelContent,/^\+ /m);assert.ok(bounded.modelContent.length<20_000,'a filtered prior read must not make the whole page newly added');
		// Controller-only fixture change: move the same DOM input beyond the
		// default range, then use the previously observed exact backend node.
		const cdp=await internal.connection(),shot=browser.latest(String(tab))!;
		const moved=await cdp.send('Runtime.evaluate',{expression:"document.body.appendChild(document.getElementById('edit-label'))",returnByValue:true},shot.sessionId) as {exceptionDetails?:unknown};assert.equal(moved.exceptionDetails,undefined);
		expected+='moved';const edited=await invoke('web_act',{tab,action:'type',id,text:'moved',expect:{id,property:'value',value:expected}},'moved-action');assert.equal(edited.details.outcome,'confirmed',edited.modelContent);await observed(expected);
		context.diagnostic(JSON.stringify({evidence:'public product tools, exact own headless child, independent HTTP edits; no formal global-focus verdict',rows,ordinarySamples:30,coldReadMs:samples[0]!.ms,warmReadP95Ms:p95('warm'),actionP95Ms:p95('action'),defaultAxBytes,defaultFullTreeRequests:0,fullPages:pages,verifiedRecords:found.size,independentEdits:events.length,approvals:approvals.length}));
	}finally{
		const child=internal.child;
		try{await browser.close();if(child)assert.ok(child.exitCode!==null||child.signalCode!==null,'Exact own Chrome child did not exit');}
		finally{CdpConnection.prototype.send=original;await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
	}
});
