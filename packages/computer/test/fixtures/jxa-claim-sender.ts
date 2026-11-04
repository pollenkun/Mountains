import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ClaimStorageBinding } from "../../src/input-claim-mac.ts";

/** Actual Foundation/Darwin process protocol. Never loads AppKit, AX or CG.
 * Tickets use private stdin, including for each direct native child. The native
 * program observes this JXA's kernel birth as its actual calling parent. */
const source=String.raw`function run(argv){
ObjC.import("Foundation");ObjC.import("stdlib");
const input=$.NSFileHandle.fileHandleWithStandardInput,out=$.NSFileHandle.fileHandleWithStandardOutput;
let count=0;
function emit(value){out.writeData($(JSON.stringify(value)+"\n").dataUsingEncoding($.NSUTF8StringEncoding));}
function line(){let value="";for(;;){const byte=input.readDataOfLength(1);if(Number(byte.length)===0)return null;value+=$.NSString.alloc.initWithDataEncoding(byte,$.NSUTF8StringEncoding).js;if(value.endsWith("\n"))return JSON.parse(value);}}
function claim(command,binding){
 const file=argv[0]+"/native-reply-"+(++count)+".json";
 if(!$.NSFileManager.defaultManager.createFileAtPathContentsAttributes($(file),$.NSData.data,$({NSFilePosixPermissions:384})))throw new Error("cannot create own reply file");
 const output=$.NSFileHandle.fileHandleForWritingAtPath($(file)),pipe=$.NSPipe.pipe,task=$.NSTask.alloc.init;
 task.launchPath=$(argv[1]);task.arguments=$(["--component-only",argv[2]]);task.standardInput=pipe;task.standardOutput=output;task.standardError=$.NSFileHandle.fileHandleWithStandardError;
 task.launch;
 pipe.fileHandleForWriting.writeData($(JSON.stringify(Object.assign({id:count,binding},command))+"\n").dataUsingEncoding($.NSUTF8StringEncoding));pipe.fileHandleForWriting.closeFile;
 task.waitUntilExit;output.closeFile;
 if(Number(task.terminationStatus)!==0)throw new Error("native file protocol process failed");
 const bytes=$.NSData.dataWithContentsOfFile($(file));if(Number(bytes.length)>65536)throw new Error("fixture reply size exceeds its small-state bound");
 const reply=JSON.parse(String($.NSString.alloc.initWithDataEncoding(bytes,$.NSUTF8StringEncoding).js));
 if(reply.id!==count||reply.ok!==true)throw new Error(reply.error||"native reply refused");
 return reply.state;
}
emit({id:0,ready:true,pid:Number($.NSProcessInfo.processInfo.processIdentifier)});
for(;;){const message=line();if(message===null)return;
 try{
  if(message.op==="close"){emit({id:message.id,closed:true});return;}
  if(message.op!=="execute")throw new Error("unexpected file-only command");
  const state=claim(Object.assign({op:"begin",openObligations:[]},message.ticket),message.binding);
  const command=state.lease.commands.filter(c=>c.id===message.ticket.commandId)[0];
  if(!command||command.phase!=="executing")throw new Error("actual begin was not durable");
  const file=$.NSFileHandle.fileHandleForWritingAtPath($(argv[0]+"/methods"));file.seekToEndOfFile;file.writeData($("jxa-method\n").dataUsingEncoding($.NSUTF8StringEncoding));file.synchronizeFile;file.closeFile;
  claim(Object.assign({op:"receipt",receipt:{schema:"input-claim-cleanup-v2",pendingKeys:0,pendingButtons:0,failed:false,complete:true}},message.ticket),message.binding);
  // Intentionally false metadata: the owner must inspect its own fixed store.
  emit({id:message.id,executed:true,revision:"0"});
 }catch(error){emit({id:message.id,error:String(error.message||error)});}
}
}`;

export async function jxaClaimSender(directory:string,store:string,binding:ClaimStorageBinding){
 const binary=fileURLToPath(new URL("../../native/darwin-universal/input-claim",import.meta.url));
 const child=spawn("/usr/bin/osascript",["-l","JavaScript","-e",source,directory,binary,store],{stdio:["pipe","pipe","pipe"]});
 let sequence=0,diagnostic="";const pending=new Map<number,{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void}>();
 const ready=new Promise<void>((resolve,reject)=>pending.set(0,{resolve:()=>resolve(),reject}));
 child.stderr.on("data",data=>{diagnostic+=String(data);});const closed=once(child,"close");void closed.catch(()=>{});
 createInterface({input:child.stdout}).on("line",line=>{let reply:Record<string,unknown>;try{reply=JSON.parse(line);}catch{return;}const item=pending.get(Number(reply.id));if(!item)return;pending.delete(Number(reply.id));if(reply.error)item.reject(new Error(String(reply.error)));else item.resolve(reply);});
 child.on("error",error=>{for(const item of pending.values())item.reject(error);pending.clear();});
 child.on("close",()=>{for(const item of pending.values())item.reject(new Error("own Foundation sender closed: "+diagnostic));pending.clear();});
 const send=(message:Record<string,unknown>)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);child.kill("SIGKILL");reject(new Error("own Foundation sender request exceeded its fixture deadline"));},10_000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  child.stdin.write(JSON.stringify({...message,binding,id})+"\n");
 });
 const startup=setTimeout(()=>{child.kill("SIGKILL");},10_000);
 try{await ready;}catch(error){if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed.catch(()=>{});throw error;}finally{clearTimeout(startup);}
 return {pid:child.pid!,execute:(ticket:Record<string,unknown>)=>send({op:"execute",ticket}),async close(){if(child.exitCode===null&&child.signalCode===null){await send({op:"close"});child.stdin.end();}await closed;},async kill(){if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed;}};
}
