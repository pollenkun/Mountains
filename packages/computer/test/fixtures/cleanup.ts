/** Cleanup stages are independent: a failed clipboard read or evidence write
 * must never prevent stopping the owned helpers and fixture processes. */
export async function cleanupAll(steps:{name:string;run:(signal:AbortSignal)=>Promise<unknown>;timeoutMs?:number}[]):Promise<{name:string;error:string}[]> {
 const errors:{name:string;error:string}[]=[];
 for(const step of steps){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const controller=new AbortController();
  try{await Promise.race([Promise.resolve().then(()=>step.run(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=new Error('cleanup deadline exceeded');controller.abort(error);reject(error);},step.timeoutMs??5000);})]);}
  catch(error){errors.push({name:step.name,error:String(error)});}
  finally{clearTimeout(timer);}
 }
 return errors;
}
