import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const [rootArg,idArg,phase='complete',windowArg]=process.argv.slice(2),root=resolve(rootArg||''),id=Number(idArg);
if(!rootArg||!Number.isInteger(id)||id<1||id>20||!/^[a-z0-9-]+$/.test(phase))throw new Error('usage: checkpoint.mjs root case-number phase');
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
if(manifest.root!==root)throw new Error('wrong run directory');
if([12,15,16,19].includes(id))throw new Error('Account-backed checkpoints are disabled: no independent local-account/object-ID inventory adapter exists');
const json=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
const lines=path=>existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const evidence={id,phase,at:Date.now(),native:{},web:json(join(root,'web','web-state.json')),
 nativeEvents:lines(join(root,'native','native-events.jsonl')),webEvents:lines(join(root,'web','web-events.jsonl'))};
for(const name of readdirSync(join(root,'native'))){if(name.endsWith('.json'))evidence.native[name]=json(join(root,'native',name));}
if(id>=6&&id<=10&&phase!=='before'){
 if(!/^[a-zA-Z0-9_-]{1,256}$/.test(windowArg||''))throw new Error('pass the exact controller-owned Web target as the fourth argument');
 evidence.webTarget=windowArg;
 const raw=spawnSync(process.execPath,[new URL('./read-web.mjs',import.meta.url).pathname,root,windowArg],{encoding:'utf8',timeout:10000});
 if(raw.status!==0)throw new Error('independent Web read failed: '+raw.stderr);
 evidence.page=JSON.parse(raw.stdout);
}
if(id>=11&&id<=19&&(phase!=='before'||windowArg)){
 if(!/^w:[0-9]+$/.test(windowArg||''))throw new Error('pass the exact current owned window handle as the fourth argument');
 const mod=await import('@crowecawcaw/xa11y'),x=mod.default??mod;
 const names={11:'TextEdit',12:'Notes',13:'Finder',14:'Preview',15:'Calendar',16:'Reminders',17:'TextEdit',18:'System Settings',19:'Notes'};
 const aliases={TextEdit:'文本编辑',Notes:'备忘录',Finder:'访达',Preview:'预览',Calendar:'日历',Reminders:'提醒事项','System Settings':'系统设置'};
 const wanted=names[id],apps=await x.App.list(),app=apps.find(app=>app.name===wanted||app.name===aliases[wanted]);
 if(!app)throw new Error('independent AX provider cannot find '+wanted);
 const raw=spawnSync(join(root,'build','ReadAX'),[String(app.pid),windowArg.slice(2)],{encoding:'utf8',timeout:20000});
 if(raw.status!==0)throw new Error('independent AX reader failed: '+raw.stderr);
 evidence.app={...JSON.parse(raw.stdout),name:app.name,provider:'independent Swift AXUIElement'};
 if(evidence.app.windows.some(window=>!window.complete))throw new Error('independent AX traversal was incomplete');
 const entries=evidence.app.windows.flatMap(window=>window.entries);
 if(id===15&&phase==='persisted'){
  const start=entries.find(entry=>entry.identifier==='start-datepicker');
  const end=entries.find(entry=>entry.identifier==='end-datepicker');
  if(start?.value)evidence.calendarDates={start:new Date(start.value).toISOString(),end:end?.value?new Date(end.value).toISOString():null};
 }
 if(id===16&&phase==='completed'){
  const values=manifest.values.reminderItems;
  evidence.reminderStates=values.map(name=>{
   const label=entries.find(entry=>entry.value===name||entry.name===name||entry.description===name);
   if(!label)throw new Error('independent reminder title missing: '+name);
   const row=label.path.split('/').slice(0,-1).join('/');
   const checkboxes=entries.filter(entry=>entry.path.startsWith(row+'/')&&entry.role==='AXCheckBox');
   if(checkboxes.length!==1)throw new Error('independent reminder checkbox is ambiguous: '+name);
   const value=checkboxes[0].value;if(value!==0&&value!==1)throw new Error('unknown reminder state');
   return {name,completed:value===1};
  });
 }

}
if(id===17&&(phase==='clipboard-before'||phase==='pdf')){
 const clip=spawnSync(join(root,'build','ReadAX'),['--clipboard'],{encoding:'utf8',timeout:10000});
 if(clip.status!==0)throw new Error('independent clipboard fingerprint failed');
 evidence.clipboard=JSON.parse(clip.stdout);
 if(phase==='pdf'){
  const before=JSON.parse(readFileSync(join(root,'evidence','case-17-clipboard-before.json'),'utf8')).clipboard;
  evidence.clipboard.sameItems=JSON.stringify(before.items)===JSON.stringify(evidence.clipboard.items);
  const python=process.env.MOUNTAINS_TEST_PYTHON||'/Users/beluga383/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
  const pdf=spawnSync(python,[new URL('./inspect-pdf.py',import.meta.url).pathname,root],{encoding:'utf8',timeout:30000});
  if(pdf.status!==0)throw new Error('independent PDF inspection failed: '+pdf.stderr);
  evidence.pdf=JSON.parse(pdf.stdout);
  const source=spawnSync(python,[new URL('./inspect-source.py',import.meta.url).pathname,root],{encoding:'utf8',timeout:30000});
  if(source.status!==0)throw new Error('independent saved source inspection failed: '+source.stderr);
  evidence.source=JSON.parse(source.stdout);
 }
}
evidence.files={};
for(const name of ['case11.txt','rotate.png','case17.rtf','case17.rtfd','case17.pdf','move-me.txt','已改名/move-me.txt']){
 const path=join(root,'workspace',name);if(!existsSync(path))continue;
 try{
  const data=readFileSync(path);
  evidence.files[name]={sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length};
  if(name.endsWith('.txt'))evidence.files[name].text=data.toString('utf8');
 }catch{evidence.files[name]={directory:true};}
}
mkdirSync(join(root,'evidence'),{recursive:true});
evidence.capturedAt=Date.now();
const path=join(root,'evidence',`case-${String(id).padStart(2,'0')}-${phase}.json`);
writeFileSync(path,JSON.stringify(evidence,null,2),{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({saved:path,independentProvider:'xa11y raw window / native file / server journal',notAVerdict:true})+'\n');
