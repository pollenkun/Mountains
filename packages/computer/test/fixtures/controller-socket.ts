import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

/** Test-fixture lifetime only. Never carries UI input or authorizes a task.
 * Closing the owning process closes the stream even after SIGKILL. */
export async function fixtureControllerSocket(): Promise<{ path: string; connected: Promise<void>; close(): Promise<void> }> {
	const root=realpathSync(mkdtempSync("/tmp/mcu-fixture-")),path=join(root,"controller.sock");
	let peer: Socket | undefined, resolve!:()=>void, reject!:(error:Error)=>void, closing:Promise<void>|undefined;
	const connected=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void connected.catch(()=>{});
	const server=createServer(socket=>{
		if(peer||closing){socket.destroy();return;}
		peer=socket;socket.on("error",()=>{});socket.resume();resolve();
	});
	try{await new Promise<void>((yes,no)=>{server.once("error",no);server.listen(path,()=>{server.removeListener("error",no);yes();});});}
	catch(error){server.close();rmSync(root,{recursive:true,force:true});throw error;}
	server.on("error",error=>{reject(error);});
	return {path,connected,close(){
		return closing??=(async()=>{
			reject(new Error("fixture controller closed before connection"));
			let timer:ReturnType<typeof setTimeout>|undefined,forced=false;
			try{
				await new Promise<void>((yes,no)=>{
					timer=setTimeout(()=>{forced=true;peer?.destroy();},2000);
					server.close(error=>error?no(error):yes());
					peer?.end();
				});
				if(forced)throw new Error("fixture ignored controller EOF; closure is unverified");
			}finally{clearTimeout(timer);peer?.destroy();rmSync(root,{recursive:true,force:true});}
		})();
	}};
}
