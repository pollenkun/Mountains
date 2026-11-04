import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

// Independent, read-only CDP client. It neither imports WebBrowser nor sends input.
const root=resolve(process.argv[2]||'');
const exactTarget=process.argv[3];
if(!process.argv[2]||!exactTarget||!/^[a-zA-Z0-9_-]{1,256}$/.test(exactTarget))throw new Error('usage: read-web.mjs run-root exact-controller-owned-target');
const server=JSON.parse(readFileSync(join(root,'web/server.json'),'utf8'));
const [port,path]=readFileSync(join(root,'browser/DevToolsActivePort'),'utf8').trim().split('\n');
if(!/^\d+$/.test(port)||!path.startsWith('/devtools/browser/'))throw new Error('invalid own debugging endpoint');
const socket=new WebSocket('ws://127.0.0.1:'+port+path),pending=new Map();let next=0;
socket.addEventListener('message',event=>{
 const message=JSON.parse(String(event.data)),wait=pending.get(message.id);if(!wait)return;
 pending.delete(message.id);clearTimeout(wait.timer);
 if(message.error)wait.reject(new Error(message.error.message));else wait.accept(message.result);
});
const send=(method,params,sessionId)=>new Promise((accept,reject)=>{
 const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('independent read timed out: '+method));},3000);
 pending.set(id,{accept,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));
});
try{
 await new Promise((accept,reject)=>{socket.addEventListener('open',accept,{once:true});socket.addEventListener('error',reject,{once:true});});
 const command=await send('Browser.getBrowserCommandLine');
 if(!command.arguments.includes('--user-data-dir='+join(root,'browser')))throw new Error('not this run\'s own Chrome profile');
 const targets=(await send('Target.getTargets')).targetInfos.filter(target=>target.type==='page'&&target.targetId===exactTarget&&target.url.startsWith(server.url+'/'));
 if(targets.length!==1)throw new Error('own page is missing or ambiguous');
 const target=targets[0],{sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 const frameBefore=(await send('Page.getFrameTree',{},sessionId)).frameTree.frame;
 const observed=await send('Runtime.evaluate',{expression:`(()=>{
 const recordRows=[...document.querySelectorAll('#app article')].filter(row=>row.querySelector('input[aria-label^="Comment record-"]')).map(row=>{const field=row.querySelector('input[aria-label^="Comment record-"]'),id=field.getAttribute('aria-label').slice('Comment '.length),heading=row.querySelector('h2')?.textContent??'';return{id,name:heading.endsWith(' / '+id)?heading.slice(0,-(' / '+id).length):null,comment:field.value};});
 return{url:location.href,title:document.title,text:document.body.innerText,status:document.querySelector('#status')?.textContent??null,recordRows,recordPage:document.querySelector('#app > p')?.textContent??null,detailStored:document.querySelector('#app > p')?.textContent??null,dialogs:[...document.querySelectorAll('dialog')].map(d=>({open:d.open,text:d.innerText})),taskRows:[...document.querySelectorAll('[aria-label="Task list"] article')].map(row=>({id:row.querySelector('h2')?.textContent??null,fields:[...row.querySelectorAll('input')].map(input=>({label:input.getAttribute('aria-label'),value:input.value}))})),fields:[...document.querySelectorAll('input,textarea,select')].map(e=>({label:e.getAttribute('aria-label')||'',type:e.type,value:e.type==='password'?'[redacted]':e.value,valueLength:e.value.length,checked:e.checked??null}))};})()`,returnByValue:true},sessionId);
 if(observed.exceptionDetails||!observed.result?.value)throw new Error('own page could not be independently read');
 const frameAfter=(await send('Page.getFrameTree',{},sessionId)).frameTree.frame;
 for(const key of ['id','loaderId','url'])if(typeof frameBefore[key]!=='string'||frameBefore[key]!==frameAfter[key])throw new Error('independent document changed during read');
 process.stdout.write(JSON.stringify({...observed.result.value,document:{id:frameBefore.id,loaderId:frameBefore.loaderId,url:frameBefore.url},at:Date.now(),target:target.targetId,provider:'separate raw CDP read-only connection'})+'\n');
}finally{
 socket.close();for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error('independent reader closed'));}
}
