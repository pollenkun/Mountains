import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Execute the real helper's clipboard functions against a private in-memory
// pasteboard. These fault injections never access the system clipboard.
const source=readFileSync(new URL("../src/pointer-mac.ts",import.meta.url),"utf8");
const start=source.indexOf("const pasteboard = $.NSPasteboard.generalPasteboard;"),end=source.indexOf("// Observe activation.",start);
const setStart=source.indexOf('case "clip_set": {'),setEnd=source.indexOf('case "clip_restore"',setStart);
assert.ok(start>0&&end>start&&setStart>0&&setEnd>setStart);
const setBody=source.slice(setStart,setEnd).replace(/^case "clip_set": \{/,"").replace(/\}\s*$/,"");
const finishStart=source.indexOf("function finishHelper()"),finishEnd=source.indexOf("ObjC.registerSubclass",finishStart);
assert.ok(finishStart>0&&finishEnd>finishStart);
type Value={js:string;isNil:()=>boolean};
const value=(js:string):Value=>({js,isNil:():boolean=>false});
const array=<T>(items:T[])=>({count:items.length,objectAtIndex:(index:number)=>items[index]});
const original=[new Map([["public.utf8-plain-text","Original 中文"],["public.html","<b>Original 中文</b>"]]),new Map([["public.png","own binary representation"]])];
interface Fault {prepare?:"text"|"html"|"marker";write?:"refuse"|"throw";clearThrows?:boolean;userCopyDuringPreparation?:boolean;userCopyAfterClear?:boolean;backupNil?:boolean;writeChangesCount?:boolean;writeCountReadThrows?:boolean}
function fixture(fault:Fault={}){
 let current=original.map(item=>new Map(item)),count=7,clears=0,writes=0,once=false,clearCalled=false;
 const userCopy=()=>{count++;current=[new Map([["public.utf8-plain-text","new user copy"]])];};
 const board={
  get changeCount(){if(fault.writeCountReadThrows&&writes>0)throw new Error("own clipboard post-write count unavailable");return count;},
  get pasteboardItems(){return array(current.map(fields=>({types:array([...fields.keys()].map(value)),dataForType:(type:Value):Value|{isNil:()=>boolean}=>fault.backupNil&&type.js==="public.png"?{isNil:():boolean=>true}:value(fields.get(type.js)!)})));},
  stringForType:(type:string)=>{const text=current[0]?.get(type);return text===undefined?{isNil:():boolean=>true}:value(text);},
  setStringForType(text:Value,type:string){
   // Compatibility with the old three unchecked pasteboard writes, so a
   // pre-fix run fails for the defect rather than an incomplete fake API.
   writes++;
   const which=type==="public.html"?"html":type==="org.mountains.clipboard-transaction"?"marker":"text";
   if(fault.prepare===which||fault.write==="refuse")return false;
   if(fault.write==="throw")throw new Error("own clipboard write threw");
   if(!current.length)current=[new Map()];current[0]!.set(type,text.js);return true;
  },
  get clearContents(){clearCalled=true;clears++;current=[];const own=++count;if(fault.clearThrows)throw new Error("own clear lost its reply");if(fault.userCopyAfterClear)userCopy();return own;},
  writeObjects:(objects:{values:{fields:Map<string,string>}[]})=>{
   writes++;
   if(fault.writeChangesCount&&writes===1){current=objects.values.map(item=>new Map(item.fields));count++;}
   // The first attempted temporary write can fail after taking ownership.
   if(writes===1&&fault.write){if(fault.write==="throw")throw new Error("own temporary clipboard write threw");return false;}
   current=objects.values.map(item=>new Map(item.fields));return true;
  },
 };
 const dollar=Object.assign((text:string)=>value(text),{
  NSPasteboard:{generalPasteboard:board},
  NSData:{alloc:{initWithBase64EncodedStringOptions:(text:Value)=>value(Buffer.from(text.js,"base64").toString())}},
  NSPasteboardItem:{alloc:{get init(){return {fields:new Map<string,string>(),
   setStringForType(text:Value,type:string){
    if(fault.userCopyDuringPreparation&&!clearCalled&&!once){once=true;userCopy();}
    const which=type==="public.html"?"html":type==="org.mountains.clipboard-transaction"?"marker":"text";
    if(fault.prepare===which)return false;this.fields.set(type,text.js);return true;
   },
   setDataForType(data:Value,type:Value){this.fields.set(type.js,data.js);return true;},
  };}}},
  NSMutableArray:{get array(){return {values:[] as unknown[],get count(){return this.values.length;},addObject(item:unknown){this.values.push(item);}};}},
 });
 const exits:number[]=[];Object.assign(dollar,{exit:(code:number)=>exits.push(code)});
 const fresh=()=>runInNewContext(source.slice(start,end)+source.slice(finishStart,finishEnd)+`;function oldSet(c){${setBody}};({set:typeof clipSet==="function"?clipSet:oldSet,restore:clipRestore,finish:finishHelper,saved:()=>saved!==null,failed:()=>clipRestoreFailure!==null})`,{$:dollar,pendingCommand:null,guard:null,inputKeys:[],inputButtons:[],inputKeyReleaseFailed:false,inputButtonReleaseFailed:false}) as {set:(c:unknown)=>{changeCount:number};restore:(c?:unknown)=>{restored:boolean;userChanged:boolean};finish:()=>void;saved:()=>boolean;failed:()=>boolean};
 const api=fresh();
 return {set:()=>api.set({text:"temporary 中文 🌍",html:"<b>temporary 中文 🌍</b>",token:"ours",changeCount:7}),restore:(c?:unknown)=>api.restore(c),freshRestore:(c:unknown)=>fresh().restore(c),finish:api.finish,exits,saved:api.saved,failed:api.failed,userCopy,changeMarker:(marker:string|null)=>{if(marker===null)current[0]!.delete("org.mountains.clipboard-transaction");else current[0]!.set("org.mountains.clipboard-transaction",marker);},get contents(){return current.map(item=>[...item]);},get clears(){return clears;},get writes(){return writes;}};
}

for(const prepare of ["text","html"] as const)test(`temporary ${prepare} refusal is caught before clearing the original clipboard`,()=>{
 const f=fixture({prepare});assert.throws(f.set,/clipboard|representation/);assert.equal(f.clears,0);assert.deepEqual(f.contents,original.map(item=>[...item]));
});
test("successful clipboard setup preserves all original representations for restoration",()=>{
 const f=fixture();assert.equal(f.set().changeCount,8);assert.equal(f.clears,1);assert.equal(f.writes,1);assert.equal(f.restore().restored,true);assert.deepEqual(f.contents,original.map(item=>[...item]));assert.equal(f.saved(),false);
});
for(const fault of [{prepare:"marker"},{write:"refuse"},{write:"throw"}] as const)test(`partial setup without a usable marker restores from its own known clear: ${JSON.stringify(fault)}`,()=>{
 const f=fixture(fault);assert.throws(f.set,/clipboard|representation/);assert.equal(f.saved(),true);assert.equal(f.restore().restored,true);assert.deepEqual(f.contents,original.map(item=>[...item]));assert.equal(f.saved(),false);
});
test("a newer user copy after failed setup wins over the original backup",()=>{
 const f=fixture({write:"refuse"});assert.throws(f.set);f.userCopy();const clears=f.clears,writes=f.writes;assert.equal(f.restore().userChanged,true);assert.equal(f.clears,clears);assert.equal(f.writes,writes);assert.deepEqual(f.contents,[[["public.utf8-plain-text","new user copy"]]]);
});
test("a user copy while temporary representations are prepared is preserved without clearing",()=>{
 const f=fixture({userCopyDuringPreparation:true});assert.throws(f.set,/clipboard changed/);assert.equal(f.clears,0);assert.equal(f.writes,0);assert.deepEqual(f.contents,[[["public.utf8-plain-text","new user copy"]]]);
});
test("the count returned by clear cannot be replaced by a newer user's count",()=>{
 const f=fixture({userCopyAfterClear:true});assert.throws(f.set,/clipboard changed/);assert.equal(f.writes,0);assert.equal(f.restore().restored,false);assert.deepEqual(f.contents,[[["public.utf8-plain-text","new user copy"]]]);
});
test("a clear with a lost reply stays unknown instead of discarding the backup",()=>{
 const f=fixture({clearThrows:true});assert.throws(f.set,/clear/);assert.equal(f.saved(),true);assert.equal(f.failed(),true);assert.throws(f.restore);assert.equal(f.saved(),true);assert.equal(f.writes,0);
});
test("external recovery items and a fabricated count cannot replace the live partial setup's private originals",()=>{
 const f=fixture({write:"refuse"});assert.throws(f.set);assert.equal(f.restore({token:"ours",changeCount:999,items:[]}).restored,true);assert.deepEqual(f.contents,original.map(item=>[...item]));
});
test("a mismatching transaction cannot discard the live partial setup's original backup",()=>{
 const f=fixture({prepare:"marker"});assert.throws(f.set);assert.throws(()=>f.restore({token:"another",items:[],changeCount:8}),/transaction changed/);assert.equal(f.saved(),true);assert.equal(f.restore().restored,true);assert.deepEqual(f.contents,original.map(item=>[...item]));
});
test("an advertised representation with unavailable data refuses setup before clearing",()=>{
 const f=fixture({backupNil:true});assert.throws(f.set,/clipboard|representation/);assert.equal(f.clears,0);assert.equal(f.writes,0);assert.deepEqual(f.contents,original.map(item=>[...item]));
});
test("external items without a transaction token cannot restore over current clipboard contents",()=>{
 const f=fixture();assert.throws(()=>f.freshRestore({items:[],changeCount:7}),/clipboard|transaction|marker/);assert.equal(f.clears,0);assert.deepEqual(f.contents,original.map(item=>[...item]));
});
test("external recovery cannot replace the marker's clear generation with the caller's count",()=>{
 const f=fixture();f.set();const before=f.contents;assert.throws(()=>f.freshRestore({items:[],token:"ours",changeCount:999}),/clipboard|generation|count/);assert.equal(f.clears,1);assert.deepEqual(f.contents,before);
});
test("valid external recovery still restores original representations after a lost acknowledgement",()=>{
 const f=fixture();f.set();const items=original.map(item=>[...item].map(([type,text])=>[type,Buffer.from(text).toString("base64")]));assert.equal(f.freshRestore({items,token:"ours"}).restored,true);assert.deepEqual(f.contents,original.map(item=>[...item]));
});
test("a wrong restoration token after successful setup cannot discard private originals",()=>{
 const f=fixture();f.set();assert.throws(()=>f.restore({token:"another",items:[],changeCount:8}),/transaction/);assert.equal(f.saved(),true);assert.equal(f.restore().restored,true);assert.deepEqual(f.contents,original.map(item=>[...item]));
});
for(const write of ["refuse","throw"] as const)test(`an uncertain generation inside a ${write} write cannot be called a user copy or a clean EOF`,()=>{
 const f=fixture({write,writeChangesCount:true});assert.throws(f.set);assert.equal(f.failed(),true);assert.equal(f.saved(),true);const before=f.contents;assert.throws(f.restore);f.finish();assert.deepEqual(f.exits,[1]);assert.equal(f.clears,1);assert.deepEqual(f.contents,before);assert.equal(f.saved(),true);
});
test("an unreadable generation after writing remains unknown and fails EOF",()=>{
 const f=fixture({writeCountReadThrows:true});assert.throws(f.set);assert.equal(f.failed(),true);assert.equal(f.saved(),true);assert.throws(f.restore);f.finish();assert.deepEqual(f.exits,[1]);assert.equal(f.clears,1);
});
for(const marker of [null,JSON.stringify({token:"another",changeCount:8}),JSON.stringify({token:"ours",changeCount:7})])test(`an invalid marker at the live private generation retains uncertainty: ${marker}`,()=>{
 const f=fixture();f.set();f.changeMarker(marker);assert.throws(f.restore,/clipboard/);assert.equal(f.saved(),true);assert.equal(f.failed(),true);f.finish();assert.deepEqual(f.exits,[1]);assert.equal(f.clears,1);
});
test("a newer user copy after successful setup is preserved even without the old marker",()=>{
 const f=fixture();f.set();f.userCopy();assert.equal(f.restore().userChanged,true);assert.equal(f.saved(),false);assert.equal(f.failed(),false);assert.deepEqual(f.contents,[[["public.utf8-plain-text","new user copy"]]]);
});

test("the real AppKit bridge can set and restore a newly named private pasteboard",{skip:process.platform!=="darwin",timeout:8000},async()=>{
 // Only the first accessor is replaced. No system/general clipboard is read
 // or written, and no application/window/event-loop startup is performed.
 const production=source.slice(start,end),accessor="$.NSPasteboard.generalPasteboard";
 assert.equal(production.split(accessor).length,2);
 const script=`function run(){ObjC.import("Cocoa");const own=$.NSPasteboard.pasteboardWithUniqueName;
 try{
  ${production.replace(accessor,"own")}
  const original=$.NSPasteboardItem.alloc.init,objects=$.NSMutableArray.array;
  if(original.setStringForType($("Original 中文 🌍"),"public.utf8-plain-text")!==true||original.setStringForType($("<b>Original 中文 🌍</b>"),"public.html")!==true)throw new Error("own named pasteboard seed refused");
  objects.addObject(original);own.clearContents;if(own.writeObjects(objects)!==true)throw new Error("own named pasteboard seed write refused");
  const snapshot=()=>clipSave().map(item=>item.map(pair=>[String(pair[0].js),String(pair[1].base64EncodedStringWithOptions(0).js)]));
  const before=snapshot(),count=Number(own.changeCount),set=clipSet({text:"Temporary 临时",html:"<i>Temporary 临时</i>",token:"private-named-test",changeCount:count}),temporary=String(own.stringForType("public.utf8-plain-text").js),restored=clipRestore(),after=snapshot();
  return JSON.stringify({privatePasteboard:true,before,temporary,after,set,restored});
 }finally{own.releaseGlobally;}}`;
 const {stdout}=await promisify(execFile)("/usr/bin/osascript",["-l","JavaScript","-e",script],{timeout:5000});
 const result=JSON.parse(stdout);assert.equal(result.privatePasteboard,true);assert.equal(result.temporary,"Temporary 临时");assert.deepEqual(result.after,result.before);assert.equal(result.before.length,1);assert.equal(result.restored.restored,true);assert.equal(result.restored.userChanged,false);
});
