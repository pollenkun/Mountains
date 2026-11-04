import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=process.argv[2];
if(!root||basename(root)!=='web')throw new Error('usage: node server.mjs run-root/web');
const manifest=JSON.parse(readFileSync(join(root,'../manifest.json'),'utf8'));
if(join(manifest.root,'web')!==root)throw new Error("not this fixture's Web output directory");
mkdirSync(root,{recursive:true});
if(readdirSync(root).length)throw new Error('Web fixture output already exists; use a fresh run');
const token=randomUUID(),webRoot=dirname(fileURLToPath(import.meta.url));
const state={forms:[],tasks:[],records:Array.from({length:13},(_,i)=>({
 id:'record-'+(101+i),name:i===10||i===2?'Quarterly report':'Record '+(101+i),
 amount:i+1,comment:'Initial '+(101+i)
})),detail:'Original detail',retryAttempts:0,retries:[],jobs:{},reconciliations:[]};
let taskId=0;
const pending=new Map();
const save=()=>{const temporary=join(root,'web-state.next');writeFileSync(temporary,JSON.stringify(state,null,2));renameSync(temporary,join(root,'web-state.json'));};
const journal=(kind,fields={})=>appendFileSync(join(root,'web-events.jsonl'),JSON.stringify({at:Date.now(),kind,...fields})+'\n');
save();journal('server-start');
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
 if(req.method==='GET'){
  if(url.pathname==='/api/state')return send(200,state);
  if(url.pathname==='/app.js'){
   res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});
   return res.end(readFileSync(join(webRoot,'app.js')));
  }
 if(['/','/form','/async','/tasks','/records','/detail','/reconcile','/technical'].includes(url.pathname)){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
   return res.end(readFileSync(join(webRoot,'index.html'),'utf8').replace('__TOKEN__',token));
  }
  return send(404,{error:'not found'});
 }
 if(req.method!=='POST'||req.headers['x-qa-token']!==token)return send(403,{error:'same-fixture UI token required'});
 let raw='';for await(const part of req){raw+=part;if(raw.length>32000)return send(413,{error:'too large'});}
 let body;try{body=JSON.parse(raw||'{}');}catch{return send(400,{error:'invalid JSON'});}
 journal('request',{path:url.pathname,body});
 if(url.pathname==='/api/form'){
  if(typeof body.name!=='string'||!body.name.trim()||!['Blue','Green','Red'].includes(body.color)||body.agree!==true){
   journal('form-invalid');return send(400,{error:'Name, color and agreement are required'});
  }
  const record={id:randomUUID(),name:body.name,color:body.color,agree:body.agree};
  state.forms.push(record);save();return send(200,{message:'Submitted '+body.name+' / '+body.color+' / agreed',record});
 }
 if(url.pathname==='/api/retry'){
  state.retryAttempts++;save();
  if(state.retryAttempts===1)return send(503,{error:'Temporary failure. Retry once.'});
  state.retries.push({attempt:state.retryAttempts,receipt:randomUUID()});save();return send(200,{message:'Retry succeeded'});
 }
 if(url.pathname==='/api/job/start'){
  const id=randomUUID();state.jobs[id]={status:'pending',startedAt:Date.now()};save();
  pending.set(id,setTimeout(()=>{state.jobs[id].status='completed';pending.delete(id);save();journal('job-completed',{id});},5000));
  return send(200,{id,message:'Job running'});
 }
 if(url.pathname==='/api/job/cancel'){
  const timer=pending.get(body.id);if(!timer)return send(409,{error:'Job is no longer pending'});
  clearTimeout(timer);pending.delete(body.id);state.jobs[body.id].status='cancelled';save();journal('job-cancelled',{id:body.id});
  return send(200,{message:'Job cancelled'});
 }
 if(url.pathname==='/api/tasks'){
  if(body.action==='create'){
   if(typeof body.name!=='string'||!body.name.trim())return send(400,{error:'Task name required'});
   const task={id:'own-'+(++taskId),name:body.name,comment:''};state.tasks.push(task);save();return send(200,{message:'Created '+task.id});
  }
  const task=state.tasks.find(item=>item.id===body.id);
  if(!task)return send(404,{error:'Exact task ID not found'});
  if(body.action==='edit')task.name=String(body.name);
  else if(body.action==='delete')state.tasks=state.tasks.filter(item=>item.id!==body.id);
  else return send(400,{error:'Unknown action'});
  save();return send(200,{message:body.action+' '+body.id});
 }
 if(url.pathname==='/api/records'){
  const item=state.records.find(item=>item.id===body.id);
  if(!item)return send(404,{error:'Exact record ID not found'});
  item.comment=String(body.comment);save();return send(200,{message:'Updated '+item.id});
 }
 if(url.pathname==='/api/detail'){
  state.detail=String(body.value);save();return send(200,{message:'Detail saved'});
 }
 if(url.pathname==='/api/reconcile'){
  let native;
  try{native=JSON.parse(readFileSync(join(root,'../native/case20-source.json'),'utf8'));}
  catch{return send(409,{error:'Native source has not been saved'});}
  if(body.receipt!==native.receipt||Number(body.amount)!==native.quantity||body.note!==native.body)
   return send(400,{error:'Reconciliation does not match saved native source'});
  if(state.reconciliations.some(item=>item.receipt===body.receipt))return send(409,{error:'Receipt already reconciled'});
  state.reconciliations.push({receipt:String(body.receipt),amount:Number(body.amount),note:String(body.note)});
  save();return send(200,{message:'Reconciliation recorded'});
 }
 if(url.pathname==='/api/console'){journal('browser-console',body);return send(200,{});}
 return send(404,{error:'not found'});
});
server.listen(0,'127.0.0.1',()=>{
 const address=server.address();
 writeFileSync(join(root,'server.json'),JSON.stringify({url:'http://127.0.0.1:'+address.port,pid:process.pid}));
 process.stdout.write('http://127.0.0.1:'+address.port+'\n');
});
const close=()=>{for(const timer of pending.values())clearTimeout(timer);server.close(()=>process.exit(0));};
process.on('SIGTERM',close);process.on('SIGINT',close);

// The controller owns this pipe. A killed controller cannot leave its server.
process.stdin.resume();
process.stdin.on('end',()=>{for(const timer of pending.values())clearTimeout(timer);server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),500).unref();});
