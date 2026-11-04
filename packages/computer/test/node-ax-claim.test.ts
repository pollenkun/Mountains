import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { FileStateTracker, Workspace, type ToolContext, type ToolDefinition } from "@mountains/tools";
import { ComponentInputClaims, type ClaimState } from "../src/input-claim-mac.ts";
import { currentInput, InputCoordinator, InputTerminationUnverifiedError } from "../src/coordinator.ts";
import { createComputerTools, type Desktop, type UiElement, type UiApp } from "../src/index.ts";

const mac={skip:process.platform!=="darwin",timeout:15_000};
const signal=()=>new AbortController().signal;
const defer=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"mountains-node-ax-")),store=join(root,"store");
 await mkdir(store,{mode:0o700});
 const claims=new ComponentInputClaims(store);await claims.initialize();
 const coordinator=new InputCoordinator(join(root,"legacy"),claims);
 const state=async()=>JSON.parse(await readFile(join(store,"input-claim.state"),"utf8")) as ClaimState;
 const log=join(root,"actual-methods");await writeFile(log,"");
 return {root,store,log,claims,coordinator,state,async close(){await claims.close();await rm(root,{recursive:true,force:true});}};
}
function context():ToolContext {return {workspace:new Workspace(process.cwd()),files:new FileStateTracker(),signal:signal(),toolCallId:"node-ax-fixture",approve:async()=>"allow"};}
type MutableElement={-readonly [K in keyof UiElement]:UiElement[K]};
function element(name:string,role="button",kids:UiElement[]=[]):MutableElement {
 return {pid:process.pid,name,role,value:"old",description:null,stableId:name,actions:["press"],bounds:{x:10,y:10,width:100,height:30},visible:true,enabled:true,focused:false,selected:false,checked:null,expanded:null,editable:true,raw:{},children:async()=>kids,
 press:async()=>{},focus:async()=>{},toggle:async()=>{},expand:async()=>{},collapse:async()=>{},select:async()=>{},increment:async()=>{},decrement:async()=>{},setValue:async()=>{},typeText:async()=>{},scrollIntoView:async()=>{},selectText:async()=>{},performAction:async()=>{},showMenu:async()=>{}};
}
function desktopFor(item:UiElement,root=element("Own fixture","window",[item])){
 root.bounds={x:0,y:0,width:400,height:300};root.focused=true;
 const app:UiApp={name:"Own AX fixture",pid:process.pid,isForeground:false,windows:async()=>[root]};
 const desktop:Desktop={apps:async()=>[app],ownPids:()=>[],prepare:async()=>{},captureWindow:async()=>{throw new Error("no GUI captures in file fixture");},pointer:async()=>{throw new Error("unexpected pointer fallback");},key:async()=>{throw new Error("unexpected keyboard fallback");},showCursor:async()=>{},clipboardSet:async()=>{},clipboardRestore:async()=>{},menus:async()=>[],pressMenu:async()=>{throw new Error("unexpected menu fallback");},installedApps:async()=>[],launch:async()=>{throw new Error("no app launching in fixture");}};
 return {app,desktop,root};
}
async function controls(f:Awaited<ReturnType<typeof fixture>>,item:UiElement,root?:MutableElement){
 const d=desktopFor(item,root),tools=Object.fromEntries(createComputerTools({desktop:async()=>d.desktop,coordinator:f.coordinator,cursor:false,apps:{"*":"act"},settleMs:0,settleMaxMs:0}).map(t=>[t.name,t])) as Record<string,ToolDefinition>;
 const read=await tools.screen_read!.execute({app:d.app.name},context());
 assert.equal(read.ok,true,read.modelContent);
 const id=read.modelContent.split("\n").find(line=>line.includes(JSON.stringify(item.name)))?.match(/\be\d+\b/)?.[0];
 assert.ok(id,read.modelContent);
 return {...d,tools,id};
}

for(const [action,method,op,extra] of [
 ["set_value","setValue","set_value",{text:"secret fixture value"}],
 ["type","typeText","type_text",{text:"secret fixture value"}],
 ["select_text","selectText","select_text",{text:"old"}],
 ["perform","performAction","perform",{text:"press"}],
 ["scroll_to_visible","scrollIntoView","scroll_to_visible",{}],
 ["toggle","toggle","toggle",{}], ["select","select","select",{}],
 ["focus","focus","focus",{}], ["expand","expand","expand",{}],
 ["collapse","collapse","collapse",{}], ["increment","increment","increment",{}],
 ["decrement","decrement","decrement",{}], ["press","press","press",{}],
 ["click","press","press",{}], ["right_click","showMenu","show_menu",{}],
 ["scroll","scrollIntoView","scroll_to_visible",{}],
] as const)test(`actual screen_act ${action} has persisted begin before the method and receipt afterwards`,mac,async()=>{
 const f=await fixture();let called=0;const item=element("Only fixture control");item.actions=["press","show_menu","set_value","focus"];item.checked="false";item.expanded=false;
 const implementation=async()=>{
  called++;const current=await f.state(),command=current.lease!.commands.at(-1)!;
  assert.equal(command.phase,"executing");assert.equal(command.address.operation,op);
  assert.equal(command.senderId,current.lease!.senders[0]!.id);assert.equal(current.lease!.senders[0]!.birth.pid,process.pid);
  assert.equal(command.address.kind,"process");if(command.address.kind==="process")assert.equal(command.address.target.process.pid,item.pid);
  assert.doesNotMatch(JSON.stringify(current),/secret fixture value/);
  await appendFile(f.log,`${action}\n`);
 };
 Object.defineProperty(item,method,{value:implementation,writable:true});
 const original=f.claims.call.bind(f.claims);let receipts=0;
 f.claims.call=async request=>{const state=await original(request);if(request.op==="receipt"){assert.equal(await readFile(f.log,"utf8"),`${action}\n`);assert.equal(state.lease!.commands.at(-1)!.phase,"clean");receipts++;}return state;};
 try {const c=await controls(f,item);await c.tools.screen_act!.execute({app:c.app.name,id:c.id,action,...extra},context());assert.equal(called,1);assert.equal(receipts,1);assert.equal((await f.state()).lease,undefined);}
 finally{await f.close();}
});

test("explicit activation records the window AX call after test-script approval",mac,async()=>{
 const f=await fixture(),item=element("control"),root=element("Own fixture","window",[item]);let called=0;
 root.performAction=async action=>{assert.equal(action,"activate");called++;assert.equal((await f.state()).lease!.commands.at(-1)!.phase,"executing");};
 try{const c=await controls(f,item,root);await c.tools.screen_act!.execute({app:c.app.name,action:"bring_to_front"},context());assert.equal(called,1);assert.equal((await f.state()).lease,undefined);}finally{await f.close();}
});

test("cancelled in-flight AX waits its actual promise and receipt before releasing either claim",mac,async()=>{
 const f=await fixture(),entered=defer(),finish=defer(),stop=new AbortController();let second=0,returned=false;
 const running=f.coordinator.run(stop.signal,async lease=>{try{await lease.ax(process.pid,process.pid,"press",async()=>{await appendFile(f.log,"start\n");entered.resolve();await finish.promise;await appendFile(f.log,"end\n");});}catch{}await assert.rejects(lease.ax(process.pid,process.pid,"press",async()=>{second++;}));}).finally(()=>{returned=true;});
 try{await entered.promise;stop.abort(new Error("cancel own fixture"));await delay(30);assert.equal(returned,false);assert.equal((await f.state()).lease!.commands.at(-1)!.phase,"executing");assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());finish.resolve();await running;assert.equal(second,0);assert.equal((await f.state()).lease,undefined);assert.equal(await readFile(f.log,"utf8"),"start\nend\n");}
 finally{finish.resolve();await running.catch(()=>{});await f.close();}
});

test("cancel immediately after durable begin sends no actual AX and still records cleanup",mac,async()=>{
 const f=await fixture(),stop=new AbortController();let called=0;const original=f.claims.call.bind(f.claims);
 f.claims.call=async request=>{const state=await original(request);if(request.op==="begin")stop.abort(new Error("before actual call"));return state;};
 try{await assert.rejects(f.coordinator.run(stop.signal,lease=>lease.ax(process.pid,process.pid,"press",async()=>{called++;})),/before actual call/);assert.equal(called,0);assert.equal((await f.state()).lease,undefined);}finally{await f.close();}
});

for(const kind of ["sync","async","unprintable"] as const)test(`AX ${kind} failure preserves original error, one effect, and a clean sender receipt`,mac,async()=>{
 const f=await fixture(),primary=kind==="unprintable"?Object.create(null):new Error("actual AX failure");let called=0,receipts=0;const original=f.claims.call.bind(f.claims);
 f.claims.call=async request=>{const state=await original(request);if(request.op==="receipt")receipts++;return state;};
 const invoke=()=>{called++;if(kind==="sync")throw primary;return appendFile(f.log,"one effect\n").then(()=>{throw primary;});};
 try{await assert.rejects(f.coordinator.run(signal(),lease=>lease.ax(process.pid,process.pid,"press",invoke)),error=>error===primary);assert.equal(called,1);assert.equal(receipts,1);assert.equal((await f.state()).lease,undefined);if(kind!=="sync")assert.equal(await readFile(f.log,"utf8"),"one effect\n");}finally{await f.close();}
});

for(const op of ["stage","permit","begin","receipt"] as const)test(`lost ${op} reply retains physical claim and refuses further input even if caller catches it`,mac,async()=>{
 const f=await fixture(),original=f.claims.call.bind(f.claims);let called=0;
 f.claims.call=async request=>{const state=await original(request);if(request.op===op)throw new Error("lost native reply");return state;};
 try{await assert.rejects(f.coordinator.run(signal(),async lease=>{try{await lease.ax(process.pid,process.pid,"press",async()=>{called++;});}catch{} }),InputTerminationUnverifiedError);assert.equal(called,op==="receipt"?1:0);assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());assert.ok((await f.state()).lease);await assert.rejects(f.coordinator.run(signal(),async()=>{called++;}),/earlier input helper termination/);assert.equal(called,op==="receipt"?1:0);}finally{await f.close();}
});

test("unawaited AX is tracked before admission; ending the scope forbids its late call",mac,async()=>{
 const f=await fixture();let called=0,pending:Promise<void>|undefined;
 try{await assert.rejects(f.coordinator.run(signal(),async lease=>{pending=lease.ax(process.pid,process.pid,"press",async()=>{called++;});void pending.catch(()=>{});}),/unawaited/);await pending?.catch(()=>{});assert.equal(called,0);assert.equal((await f.state()).lease,undefined);}finally{await f.close();}
});

test("missing actual AX pid never borrows the host pid",mac,async()=>{
 const f=await fixture(),item=element("No actual pid");delete item.pid;let called=0;item.press=async()=>{called++;};
 try{const c=await controls(f,item);const result=await c.tools.screen_act!.execute({app:c.app.name,action:"press",id:c.id},context());assert.equal(called,0);assert.match(result.modelContent,/actual AX process id/);assert.equal((await f.state()).lease,undefined);}finally{await f.close();}
});

test("dropdown choice records its own remote process; Node AX calls are separate tickets",mac,async()=>{
 const f=await fixture(),child=spawn(process.execPath,["-e","process.stdin.resume()"],{stdio:["pipe","ignore","ignore"]}),closed=once(child,"close");assert.ok(child.pid);
 const choice=element("Choose fixture","menu_item");choice.pid=child.pid;choice.actions=["pick"];const item=element("Dropdown fixture","combo_box",[choice]);item.actions=["press"];let called=0;
 choice.performAction=async action=>{assert.equal(action,"pick");called++;const c=(await f.state()).lease!.commands.at(-1)!;assert.equal(c.address.kind,"process");if(c.address.kind==="process"){assert.equal(c.address.owner.process.pid,process.pid);assert.equal(c.address.target.process.pid,child.pid);assert.equal(c.address.target.window,undefined);}assert.equal(c.phase,"executing");};
 try{const c=await controls(f,item);await c.tools.screen_act!.execute({app:c.app.name,action:"select",id:c.id,text:"Choose fixture"},context());assert.equal(called,1);assert.equal((await f.state()).lease,undefined);}finally{child.stdin.end();await closed;await f.close();}
});

test("same candidate store refuses nested aliases even with different legacy directories",mac,async()=>{
 const f=await fixture(),binding=(await f.state()).binding,alias=new ComponentInputClaims(await realpath(f.store),binding),other=new InputCoordinator(join(f.root,"other"),alias);
 try{await f.coordinator.run(signal(),async()=>{await assert.rejects(other.run(signal(),async()=>assert.fail("must not reenter")),/recursive/);});assert.equal((await f.state()).lease,undefined);}finally{await alias.close();await f.close();}
});

test("AX lifetime tracking also protects the default path without enabling persistent claims",async()=>{
 const coordinator=new InputCoordinator(),stop=new AbortController(),entered=defer(),finish=defer();let done=false;
 const running=coordinator.run(stop.signal,lease=>lease.ax(null,undefined,"press",async()=>{assert.equal(currentInput(),lease);entered.resolve();await finish.promise;})).finally(()=>{done=true;});
 try{await entered.promise;stop.abort(new Error("cancel"));await delay(15);assert.equal(done,false);finish.resolve();await running;assert.equal(stop.signal.aborted,true);}finally{finish.resolve();await running.catch(()=>{});}
});

test("recursive AX is rejected immediately while independent calls can still queue",mac,async()=>{
 const f=await fixture(),events:string[]=[];
 try{await f.coordinator.run(AbortSignal.timeout(1000),async lease=>{
  const first=lease.ax(process.pid,process.pid,"press",async()=>{
   events.push("first");await assert.rejects(lease.ax(process.pid,process.pid,"press",async()=>assert.fail("recursive send")),/recursive AX/);
  });
  const second=lease.ax(process.pid,process.pid,"press",async()=>{events.push("second");});
  await Promise.all([first,second]);
 });assert.deepEqual(events,["first","second"]);assert.equal((await f.state()).lease,undefined);}finally{await f.close();}
});

test("candidate window revisions are shared across independent legacy directories and aliases",mac,async()=>{
 const f=await fixture(),alias=new ComponentInputClaims(await realpath(f.store),(await f.state()).binding),other=new InputCoordinator(join(f.root,"different-legacy"),alias),key="own-fixture-window";
 try{const initial=await f.coordinator.revision(key);assert.equal(initial,await other.revision(key));await f.coordinator.changed(key);assert.notEqual(initial,await other.revision(key));assert.equal(await f.coordinator.revision(key),await other.revision(key));await other.changed(key);assert.equal(await f.coordinator.revision(key),await other.revision(key));assert.equal((await f.state()).lease,undefined);}finally{await alias.close();await f.close();}
});

test("process identity queries are read-only and never register target apps as senders",mac,async()=>{
 const f=await fixture();try{const before=await f.state(),birth=await f.claims.processIdentity(process.pid);assert.equal(birth.pid,process.pid);assert.equal(birth.schema,"macos-kinfo-starttime-v1");assert.deepEqual(await f.state(),before);for(const pid of [0,-1,1.5,NaN,2_147_483_648])await assert.rejects(f.claims.processIdentity(pid),/missing or invalid/);await assert.rejects(f.claims.processIdentity(2_147_483_647),/absent or cannot be verified/);assert.deepEqual(await f.state(),before);}finally{await f.close();}
});

test("AX selected text completes and writes receipt before the following non-AX text sender",mac,async()=>{
 const f=await fixture(),item=element("Web fixture field","text_field"),area=element("Web area","web_area",[item]),root=element("Own fixture","window",[area]);item.focused=true;let selected=0,typed=0;
 item.selectText=async()=>{selected++;assert.equal((await f.state()).lease!.commands.at(-1)!.phase,"executing");};
 try{const c=await controls(f,item,root);c.desktop.text=async()=>{typed++;const commands=(await f.state()).lease!.commands;assert.equal(commands.length,1);assert.equal(commands[0]!.address.operation,"select_text");assert.equal(commands[0]!.phase,"clean");};await c.tools.screen_act!.execute({app:c.app.name,id:c.id,action:"set_value",text:"fixture text"},context());assert.equal(selected,1);assert.equal(typed,1);assert.equal((await f.state()).lease,undefined);}finally{await f.close();}
});

test("ending a lease while a read-only identity query is pending cannot authorize late AX",mac,async()=>{
 const f=await fixture(),entered=defer(),resume=defer(),original=f.claims.processIdentity.bind(f.claims);let called=0,pending:Promise<void>|undefined;
 f.claims.processIdentity=async pid=>{entered.resolve();await resume.promise;return original(pid);};
 const running=f.coordinator.run(signal(),async lease=>{pending=lease.ax(process.pid,process.pid,"press",async()=>{called++;});void pending.catch(()=>{});await entered.promise;});
 try{await entered.promise;await delay(10);resume.resolve();await assert.rejects(running,/unawaited/);await pending?.catch(()=>{});assert.equal(called,0);assert.equal((await f.state()).lease,undefined);}finally{resume.resolve();await running.catch(()=>{});await f.close();}
});

test("another candidate's completed AX invalidates the first client's old snapshot",mac,async()=>{
 const f=await fixture(),alias=new ComponentInputClaims(await realpath(f.store),(await f.state()).binding),other=new InputCoordinator(join(f.root,"other-legacy"),alias),item=element("Shared fixture");let calls=0;item.press=async()=>{calls++;};
 try{
  const a=await controls(f,item),otherTools=Object.fromEntries(createComputerTools({desktop:async()=>a.desktop,coordinator:other,cursor:false,apps:{"*":"act"},settleMs:0,settleMaxMs:0}).map(t=>[t.name,t])) as Record<string,ToolDefinition>;
  const read=await otherTools.screen_read!.execute({app:a.app.name},context());const id=read.modelContent.split("\n").find(line=>line.includes(JSON.stringify(item.name)))!.match(/\be\d+\b/)![0];
  await otherTools.screen_act!.execute({app:a.app.name,id,action:"press"},context());assert.equal(calls,1);
  const stale=await a.tools.screen_act!.execute({app:a.app.name,id:a.id,action:"press"},context());assert.equal(calls,1);assert.equal(stale.ok,false);assert.match(stale.modelContent,/changed|outdated|another.*action|read.*again|stale/i);
  const fresh=await a.tools.screen_read!.execute({app:a.app.name},context());assert.equal(fresh.ok,true);await a.tools.screen_act!.execute({app:a.app.name,id:a.id,action:"press"},context());assert.equal(calls,2);assert.equal((await f.state()).lease,undefined);
 }finally{await alias.close();await f.close();}
});

test("lazily opened dropdown journals the opening and chosen item as two sequential AX calls",mac,async()=>{
 const f=await fixture(),children:UiElement[]=[],item=element("Lazy dropdown","combo_box",children),choice=element("Own option","menu_item");choice.actions=["pick"];const phases:string[]=[];
 item.press=async()=>{const c=(await f.state()).lease!.commands;assert.equal(c.length,1);assert.equal(c[0]!.phase,"executing");phases.push("open");children.push(choice);};
 choice.performAction=async()=>{const c=(await f.state()).lease!.commands;assert.equal(c.length,2);assert.equal(c[0]!.phase,"clean");assert.equal(c[1]!.phase,"executing");phases.push("choose");};
 try{const c=await controls(f,item);await c.tools.screen_act!.execute({app:c.app.name,id:c.id,action:"select",text:"Own option"},context());assert.deepEqual(phases,["open","choose"]);assert.equal((await f.state()).lease,undefined);}finally{await f.close();}
});

test("candidate binding must be pinned before any coordinator can use it",mac,async()=>{
 const root=await mkdtemp(join(tmpdir(),"mountains-uninitialized-ax-")),claims=new ComponentInputClaims(root);
 try{assert.throws(()=>new InputCoordinator(undefined,claims),/initialized original binding/);assert.deepEqual(await import("node:fs/promises").then(fs=>fs.readdir(root)),[]);}finally{await claims.close();await rm(root,{recursive:true,force:true});}
});

for(const opaque of [false,true])test(`AX error and lost receipt keep both original causes (opaque=${opaque})`,mac,async()=>{
 const f=await fixture(),primary=opaque?Object.create(null):new Error("original AX error"),lost=new Error("receipt acknowledgement lost"),original=f.claims.call.bind(f.claims);
 f.claims.call=async request=>{const state=await original(request);if(request.op==="receipt")throw lost;return state;};
 const contains=(error:unknown,needle:unknown):boolean=>error===needle||error instanceof AggregateError&&error.errors.some(e=>contains(e,needle))||error instanceof Error&&contains(error.cause,needle);
 try{await assert.rejects(f.coordinator.run(signal(),lease=>lease.ax(process.pid,process.pid,"press",async()=>{await appendFile(f.log,"only once\n");throw primary;})),error=>{assert.ok(contains(error,primary));assert.ok(contains(error,lost));return error instanceof InputTerminationUnverifiedError;});assert.equal(await readFile(f.log,"utf8"),"only once\n");assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());await assert.rejects(f.coordinator.run(signal(),async()=>assert.fail("unknown input must not repeat")),/earlier input helper termination/);}finally{await f.close();}
});

for(const op of ["seal","retire","release"] as const)for(const opaque of [false,true])test(`AX original error survives lost ${op} finalization reply (opaque=${opaque})`,mac,async()=>{
 const f=await fixture(),primary=opaque?Object.create(null):new Error("original AX error"),lost=new Error("finalization acknowledgement lost"),original=f.claims.call.bind(f.claims);
 f.claims.call=async request=>{const state=await original(request);if(request.op===op)throw lost;return state;};
 const contains=(error:unknown,needle:unknown):boolean=>error===needle||error instanceof AggregateError&&error.errors.some(e=>contains(e,needle))||error instanceof Error&&contains(error.cause,needle);
 try{await assert.rejects(f.coordinator.run(signal(),lease=>lease.ax(process.pid,process.pid,"press",async()=>{await appendFile(f.log,"one actual method\n");throw primary;})),error=>{assert.ok(contains(error,primary));assert.ok(contains(error,lost));return error instanceof InputTerminationUnverifiedError;});assert.equal(await readFile(f.log,"utf8"),"one actual method\n");assert.ok((await lstat(join(f.root,"legacy","input.lock"))).isDirectory());assert.equal((await f.state()).lease===undefined,op==="release");await assert.rejects(f.coordinator.run(signal(),async()=>assert.fail("must not replay")),/earlier input helper termination/);}finally{await f.close();}
});
