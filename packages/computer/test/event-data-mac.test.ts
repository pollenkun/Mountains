import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { MacEventData } from "../src/event-data-mac.ts";

test("native mouse events survive the JXA boundary with their type, window and modifiers", { skip:process.platform !== "darwin" }, async () => {
	const helper = await MacEventData.open();
	try {
		const events = await helper.mouse(1234, ["Shift"]);
		// Decode only. This test posts no input and opens no windows.
		const script = `ObjC.import("Cocoa");ObjC.import("CoreGraphics");function run(argv){const input=JSON.parse(argv[0]),out={};for(const kind of Object.keys(input)){const data=$.NSData.alloc.initWithBase64EncodedStringOptions($(input[kind]),0),event=$.CGEventCreateFromData(null,data);out[kind]={type:Number($.CGEventGetType(event)),window:Number($.CGEventGetIntegerValueField(event,51)),flags:Number($.CGEventGetFlags(event))};}return JSON.stringify(out);}`;
		const { stdout } = await promisify(execFile)("osascript", ["-l","JavaScript","-e",script,JSON.stringify(events)], { timeout:15_000 });
		const observed = JSON.parse(stdout) as Record<string,{type:number;window:number;flags:number}>;
		for (const [kind, type] of Object.entries({down:1,up:2,rdown:3,rup:4,move:5,drag:6})) {
			assert.equal(observed[kind]?.type,type);
			assert.equal(observed[kind]?.window,1234);
			assert.equal(observed[kind]?.flags,0x20000);
		}
	} finally { await helper.close(); }
});

test("a fresh native event serializer starts without swiftc or any PATH commands", {skip:process.platform!=="darwin"},async()=>{
 const {mkdtempSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const directory=mkdtempSync(join(tmpdir(),"mountains-no-compiler-"));
 try{
  const moduleURL=new URL("../src/event-data-mac.ts",import.meta.url).href;
  const code=`import {MacEventData} from ${JSON.stringify(moduleURL)};const helper=await MacEventData.open();try{const events=await helper.mouse(4321);console.log(JSON.stringify({kinds:Object.keys(events).sort()}));}finally{await helper.close();}`;
  const {stdout}=await promisify(execFile)(process.execPath,["--input-type=module","-e",code],{env:{...process.env,PATH:directory,MOUNTAINS_HOME:directory},timeout:10000});
  assert.deepEqual(JSON.parse(stdout).kinds,["down","drag","move","rdown","rup","up"]);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test("native Return, Tab and Escape preserve Cocoa characters and the addressed window",{skip:process.platform!=="darwin"},async()=>{
 const helper=await MacEventData.open();
 try{
  for(const [code,characters]of [[36,"\r"],[48,"\t"],[53,"\x1b"]] as const){
   const events=await helper.key(1234,code,characters);
   const script=`ObjC.import("Cocoa");ObjC.import("CoreGraphics");function run(argv){const input=JSON.parse(argv[0]),out={};for(const name of Object.keys(input)){const data=$.NSData.alloc.initWithBase64EncodedStringOptions($(input[name]),0),event=$.CGEventCreateFromData(null,data),native=$.NSEvent.eventWithCGEvent(event);out[name]={type:Number($.CGEventGetType(event)),window:Number(native.windowNumber),key:Number(native.keyCode),characters:String(native.characters.js)};}return JSON.stringify(out);}`;
   const {stdout}=await promisify(execFile)("osascript",["-l","JavaScript","-e",script,JSON.stringify(events)],{timeout:10000});
   const actual=JSON.parse(stdout);for(const [name,type]of [["down",10],["up",11]] as const)assert.deepEqual(actual[name],{type,window:1234,key:code,characters});
  }
 }finally{await helper.close();}
});
