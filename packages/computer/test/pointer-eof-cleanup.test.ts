import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp,readFile,writeFile,rm,lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { JsonHelper } from "../src/helper.ts";
import { InputCoordinator,InputTerminationUnverifiedError } from "../src/coordinator.ts";
import { foundationFileGesture } from "./fixtures/jxa-file-gesture.ts";

const source=readFileSync(new URL("../src/pointer-mac.ts",import.meta.url),"utf8"),start=source.indexOf("function finishHelper()"),end=source.indexOf("ObjC.registerSubclass",start);
assert.ok(start>0&&end>start);const production=source.slice(start,end);
interface Options{clipboardThrows?:boolean;guardThrows?:boolean;guard?:unknown;focus?:unknown;keys?:number;keyFailed?:boolean;buttons?:number;buttonFailed?:boolean}
function exercise(options:Options={}){
 const events:string[]=[],context={pendingCommand:{id:1},guard:options.guard===undefined?{}:options.guard,inputKeys:Array(options.keys??0),inputKeyReleaseFailed:options.keyFailed??false,inputButtons:Array(options.buttons??0),inputButtonReleaseFailed:options.buttonFailed??false,
  clipRestore:()=>{events.push("clipboard");if(options.clipboardThrows)throw new Error("own clipboard restore threw");return {restored:true,userChanged:false};},finishGuard:()=>{events.push("focus");if(options.guardThrows)throw new Error("own focus restore threw");return options.focus===undefined?{restored:true,byUser:false,attributionUnknown:false}:options.focus;},$:{exit:(status:number)=>events.push("exit:"+status)}};
 runInNewContext(production+";finishHelper();",context);return {events,pending:context.pendingCommand};
}

test("clipboard failure must not skip the original focus cleanup",()=>{const f=exercise({clipboardThrows:true});assert.deepEqual(f.events,["clipboard","focus","exit:1"]);assert.equal(f.pending,null);});
for(const focus of [{restored:false,byUser:false,attributionUnknown:false},{restored:true,byUser:false,attributionUnknown:true},{restored:false,byUser:true,attributionUnknown:true},null,{}, {restored:"true",byUser:"true",attributionUnknown:false}])test("a missing, uncertain or unsuccessful focus cleanup cannot exit cleanly: "+JSON.stringify(focus),()=>{assert.deepEqual(exercise({focus}).events,["clipboard","focus","exit:1"]);});
test("focus cleanup failure keeps the clipboard attempt and fails exit",()=>{assert.deepEqual(exercise({guardThrows:true}).events,["clipboard","focus","exit:1"]);});
test("a verified restored focus can finish cleanup without claiming the background constraint passed",()=>{assert.deepEqual(exercise({focus:{restored:true,byUser:false,attributionUnknown:false,unchanged:false,frontChanged:true}}).events,["clipboard","focus","exit:0"]);});
test("the user's explicitly owned destination is preserved instead of restoring over it",()=>{assert.deepEqual(exercise({focus:{restored:false,byUser:true,attributionUnknown:false,unchanged:false}}).events,["clipboard","focus","exit:0"]);});
test("no active focus guard needs no focus cleanup",()=>{assert.deepEqual(exercise({guard:null}).events,["clipboard","exit:0"]);});
for(const dirty of [{keys:1},{keyFailed:true},{buttons:1},{buttonFailed:true}])test("pending input cannot be washed clean by successful global cleanup: "+JSON.stringify(dirty),()=>{assert.deepEqual(exercise(dirty).events,["clipboard","focus","exit:1"]);});

async function ownFoundationCleanup(log:string,mode:"clipboard-throws"|"focus-unverified"){
 const launch=await foundationFileGesture(log),index=launch.args.indexOf("-e");let program=launch.args[index+1]!;
 const globals="let inputSent=false,inputPointer=null,guard=null,deadline=0,at=null,shownOn=-1;",clip='function clipRestore(){record("restore");}';assert.equal(program.split(globals).length,2);assert.equal(program.split(clip).length,2);
 program=program.replace(globals,globals.replace("guard=null","guard={ownFileFixture:true}"));
 program=program.replace(clip,`function clipRestore(){record("restore");${mode==="clipboard-throws"?'throw new Error("own file clipboard fault");':'return {restored:true,userChanged:false};'}} function finishGuard(){record("focus-cleanup");return {restored:${mode==="clipboard-throws"},byUser:false,attributionUnknown:${mode==="focus-unverified"}};}`);
 launch.args[index+1]=program;return launch;
}
for(const mode of ["clipboard-throws","focus-unverified"] as const)for(const handling of ["direct","caught","wrapped","unawaited"])test("real Foundation EOF uses production cleanup and retains its failure, handling="+handling+": "+mode,{skip:process.platform!=="darwin",timeout:10_000},async()=>{
 const root=await mkdtemp(join(tmpdir(),"mountains-eof-global-cleanup-")),log=join(root,"events"),directory=join(root,"claim");await writeFile(log,"");const launch=await ownFoundationCleanup(log,mode),helper=new JsonHelper(launch.command,launch.args,process.env,"eof"),coordinator=new InputCoordinator(directory);
 try{await assert.rejects(coordinator.run(new AbortController().signal,async()=>{await helper.send({op:"ping"},5000);if(handling==="caught")await helper.dispose().catch(()=>{});else if(handling==="wrapped")await helper.dispose().catch(error=>{throw new AggregateError([error],"own wrapper");});else if(handling==="unawaited"){void helper.dispose().catch(()=>{});}else await helper.dispose();}),InputTerminationUnverifiedError);assert.equal(helper.pid,null);const lines=(await readFile(log,"utf8")).trim().split("\n");assert.deepEqual(lines,["controller-eof","restore","focus-cleanup","helper-exit:1"]);assert.ok((await lstat(join(directory,"input.lock"))).isDirectory());let next=false;await assert.rejects(coordinator.run(new AbortController().signal,async()=>{next=true;}),/earlier input helper termination is unverified/);assert.equal(next,false);}finally{await helper.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});}
});
