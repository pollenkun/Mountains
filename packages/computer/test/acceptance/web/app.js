'use strict';
const token=document.querySelector('meta[name=qa-token]').content;
const app=document.querySelector('#app'),status=document.querySelector('#status');
let state,jobId,page=1,sortDesc=false;
const element=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;};
const button=(label,run)=>{const node=element('button',label,{type:'button'});node.addEventListener('click',()=>Promise.resolve(run()).catch(showError));return node;};
const field=(label,type='text',value='')=>{
 const wrapper=element('label',label+' '),input=element('input',undefined,{type,'aria-label':label});
 input.value=value;wrapper.append(input);return {wrapper,input};
};
const showError=error=>{status.textContent='Error: '+error.message;};
async function api(path,body){
 const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-qa-token':token},body:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw new Error(data.error);
 status.textContent=data.message||'Done';return data;
}
async function load(){state=await(await fetch('/api/state')).json();}
window.addEventListener('error',event=>{void api('/api/console',{kind:'error',message:event.message});});
window.addEventListener('unhandledrejection',event=>{void api('/api/console',{kind:'unhandledrejection',message:String(event.reason)});});
function form(){
 app.append(element('h1','Form validation'));
 const name=field('Name'),select=element('select',undefined,{'aria-label':'Color'});
 for(const color of ['Blue','Green','Red'])select.append(element('option',color,{value:color}));
 const color=element('label','Color ');color.append(select);
 const agree=field('I agree','checkbox');
 app.append(name.wrapper,color,agree.wrapper,button('Submit form',async()=>{
  await api('/api/form',{name:name.input.value,color:select.value,agree:agree.input.checked});
 }));
}
function asynchronous(){
 app.append(element('h1','Failure retry and cancellation'),button('Load data',()=>api('/api/retry',{})),
 button('Start delayed operation',async()=>{jobId=(await api('/api/job/start',{})).id;}),
 button('Cancel operation',async()=>{await api('/api/job/cancel',{id:jobId});jobId=null;}));
}
function tasks(){
 app.append(element('h1','Own tasks'));
 const name=field('New task');
 const list=element('section',undefined,{'aria-label':'Task list'});
 const render=()=>{
  list.replaceChildren();const rows=[...state.tasks].sort((a,b)=>sortDesc?b.name.localeCompare(a.name):a.name.localeCompare(b.name));
  for(const item of rows){
   const row=element('article'),name=field('Task '+item.id,'text',item.name);
   row.append(element('h2',item.id),name.wrapper,
   button('Save '+item.id,async()=>{await api('/api/tasks',{action:'edit',id:item.id,name:name.input.value});await load();render();}),
   button('Delete '+item.id,async()=>{await api('/api/tasks',{action:'delete',id:item.id});await load();render();}));
   list.append(row);
  }
 };
 app.append(name.wrapper,button('Add task',async()=>{await api('/api/tasks',{action:'create',name:name.input.value});name.input.value='';await load();render();}),
 button('Reverse sort',()=>{sortDesc=!sortDesc;render();status.textContent=sortDesc?'Descending':'Ascending';}),list);render();
}
function records(){
 app.append(element('h1','Paged records'));
 const filter=field('Filter records'),list=element('section'),pageLabel=element('p');
 const render=()=>{
  const matches=state.records.filter(item=>(item.name+' '+item.id).toLowerCase().includes(filter.input.value.toLowerCase()));
  const pages=Math.max(1,Math.ceil(matches.length/4));page=Math.min(page,pages);
  list.replaceChildren();pageLabel.textContent='Page '+page+' of '+pages+' / '+matches.length+' records';
  for(const item of matches.slice((page-1)*4,page*4)){
   const row=element('article'),comment=field('Comment '+item.id,'text',item.comment);
   row.append(element('h2',item.name+' / '+item.id),comment.wrapper,
   button('Save '+item.id,async()=>{await api('/api/records',{id:item.id,comment:comment.input.value});await load();render();}));
   list.append(row);
  }
 };
 app.append(filter.wrapper,button('Apply filter',()=>{page=1;render();}),button('Clear filter',()=>{filter.input.value='';page=1;render();}),
 button('Previous page',()=>{page=Math.max(1,page-1);render();}),button('Next page',()=>{page++;render();}),pageLabel,list);render();
}
function detail(){
 app.append(element('h1','Detail page'));
 const shown=element('p','Stored detail: '+state.detail),dialog=element('dialog'),value=field('Detail value','text',state.detail);
 const close=()=>dialog.close();
 dialog.append(element('h2','Edit detail'),value.wrapper,button('Cancel edit',close),
 button('Save detail',async()=>{
  if(!confirm('Save this test detail?')){status.textContent='Confirmation cancelled';return;}
  await api('/api/detail',{value:value.input.value});shown.textContent='Stored detail: '+value.input.value;dialog.close();
  alert('Saved test detail');
 }));
 dialog.addEventListener('cancel',()=>{status.textContent='Edit cancelled';});
 app.append(shown,button('Edit detail',()=>{value.input.value=state.detail;dialog.showModal();}),dialog,
 button('Refresh page',()=>location.reload()),button('Test delayed focus',()=>{
  setTimeout(()=>{window.focus();value.input.focus();status.textContent='Delayed page focus attempted';},300);
 }));
}
function reconcile(){
 app.append(element('h1','Reconcile native receipt'));
 const receipt=field('Native receipt'),amount=field('Quantity'),note=field('Native content');
 app.append(receipt.wrapper,amount.wrapper,note.wrapper,button('Record reconciliation',()=>api('/api/reconcile',{
  receipt:receipt.input.value,amount:amount.input.value,note:note.input.value
 })));
}
function technical(){
 app.append(element('h1','Technical fault and concurrency fixture'));
 for(const [label,type]of [['Field A','text'],['Field B','text'],['Secret','password']])app.append(field(label,type).wrapper);
 const payment=field('Card reference');payment.input.autocomplete='cc-number';app.append(payment.wrapper);
 app.append(button('Sequential dialogs',()=>{
  const first=confirm('First technical decision'),second=confirm('Second technical decision');
  status.textContent='Decisions '+first+' / '+second;
 }),button('Delayed focus and popup',()=>{
  setTimeout(()=>{window.focus();window.open('/technical?popup=1','technical-popup');status.textContent='Popup attempted';},300);
 }));
}
(async()=>{
 await load();app.replaceChildren();
 const routes={'/':form,'/form':form,'/async':asynchronous,'/tasks':tasks,'/records':records,'/detail':detail,'/reconcile':reconcile,'/technical':technical};
 (routes[location.pathname]||form)();status.textContent='Ready';
})().catch(showError);
