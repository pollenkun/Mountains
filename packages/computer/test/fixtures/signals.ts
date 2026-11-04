/** Repeated Ctrl-C must not bypass cleanup. SIGKILL cannot be handled here;
 * owned fixtures additionally watch the parent's pipe for EOF. */
export function onTestTermination(controller:AbortController,shutdown:()=>Promise<void>,host:{on:(name:string,fn:()=>void)=>unknown;off:(name:string,fn:()=>void)=>unknown;exit:(code:number)=>unknown}=process):()=>void{
 let stopping=false;
 const stop=()=>{
  if(stopping)return;stopping=true;
  controller.abort(new Error('test terminated'));
  void Promise.resolve().then(shutdown).then(()=>host.exit(130),()=>host.exit(130));
 };
 for(const name of ['SIGINT','SIGTERM'])host.on(name,stop);
 return()=>{for(const name of ['SIGINT','SIGTERM'])host.off(name,stop);};
}
