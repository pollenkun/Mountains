import assert from 'node:assert/strict';
import type {RequestProof} from './request-witness.ts';
export interface TaskItem{id:string;name:string;comment:string}
export interface TaskState{tasks:TaskItem[]}
export type DeleteTaskAuthorization=(task:Readonly<TaskItem>,state:Readonly<TaskState>,proof:Readonly<RequestProof>)=>Record<string,unknown>;
/** Original case8 task CRUD. The private service validates browser proof first;
 * every state is signed durably before it becomes the current in-memory state. */
export class TaskFixture{
 private state:TaskState={tasks:[]};private counter=0;
 private readonly append:(kind:string,fields:Record<string,unknown>)=>void;
 private readonly authorizeDelete:DeleteTaskAuthorization;
 constructor(append:(kind:string,fields:Record<string,unknown>)=>void,authorizeDelete:DeleteTaskAuthorization){this.append=append;this.authorizeDelete=authorizeDelete;}
 snapshot():TaskState{return structuredClone(this.state);}
 apply(value:unknown,proof:Readonly<RequestProof>):{code:number;body:Record<string,unknown>}{
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value));const body=value as Record<string,unknown>,next=this.snapshot();assert.equal(new URL(proof.url).pathname,'/api/tasks');
  const save=(kind:string,fields:Record<string,unknown>)=>{this.append(kind,{...fields,proof,web:structuredClone(next)});this.state=next;};
  if(body.action==='create'){
   assert.deepEqual(Object.keys(body).sort(),['action','name']);assert.ok(typeof body.name==='string'&&body.name.trim());
   const task={id:'own-'+(++this.counter),name:body.name,comment:''};next.tasks.push(task);save('task-created',{id:task.id});return{code:200,body:{message:'Created '+task.id}};
  }
  assert.ok(body.action==='edit'||body.action==='delete');assert.ok(typeof body.id==='string');
  assert.deepEqual(Object.keys(body).sort(),body.action==='edit'?['action','id','name']:['action','id']);const task=next.tasks.find(item=>item.id===body.id);
  if(!task){save('task-rejected',{id:body.id,action:body.action});return{code:404,body:{error:'Exact task ID not found'}};}
  if(body.action==='edit'){assert.ok(typeof body.name==='string');task.name=body.name;save('task-edited',{id:task.id});return{code:200,body:{message:'edit '+task.id}};}
  const approval=this.authorizeDelete({...task},this.snapshot(),proof);assert.ok(approval&&typeof approval==='object'&&!Array.isArray(approval)&&typeof approval.then!=='function','deletion authorization must complete synchronously');
  next.tasks=next.tasks.filter(item=>item.id!==task.id);save('task-deleted',{id:task.id,approval});return{code:200,body:{message:'delete '+task.id}};
 }
}
// Same controls, stable task IDs, sorting and request shapes as web/app.js tasks().
// The server supplies initial state. No credential is exposed in this page.
export const TASK_PAGE=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mountains Web QA</title>
<style>body{font:17px system-ui;margin:28px}label{display:block;margin:12px 0}input,button{font:inherit;padding:7px}article{margin:12px 0;padding:10px;border:1px solid #aaa}</style>
<main id="app"></main><p id="status" role="status">Ready</p><script>
const app=document.querySelector('#app'),status=document.querySelector('#status');let state,sortDesc=false;
const element=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;};
const showError=error=>{status.textContent='Error: '+error.message;};
const button=(label,run)=>{const node=element('button',label,{type:'button'});node.addEventListener('click',()=>Promise.resolve(run()).catch(showError));return node;};
const field=(label,value='')=>{const wrapper=element('label',label+' '),input=element('input',undefined,{type:'text','aria-label':label});input.value=value;wrapper.append(input);return{wrapper,input};};
async function api(body){const response=await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error);status.textContent=data.message||'Done';return data;}
async function load(){state=await(await fetch('/api/state')).json();}
(async()=>{await load();app.append(element('h1','Own tasks'));const name=field('New task'),list=element('section',undefined,{'aria-label':'Task list'});
 const render=()=>{list.replaceChildren();for(const item of [...state.tasks].sort((a,b)=>sortDesc?b.name.localeCompare(a.name):a.name.localeCompare(b.name))){const row=element('article'),name=field('Task '+item.id,item.name);row.append(element('h2',item.id),name.wrapper,button('Save '+item.id,async()=>{await api({action:'edit',id:item.id,name:name.input.value});await load();render();}),button('Delete '+item.id,async()=>{await api({action:'delete',id:item.id});await load();render();}));list.append(row);}};
 app.append(name.wrapper,button('Add task',async()=>{await api({action:'create',name:name.input.value});name.input.value='';await load();render();}),button('Reverse sort',()=>{sortDesc=!sortDesc;render();status.textContent=sortDesc?'Descending':'Ascending';}),list);render();status.textContent='Ready';})().catch(showError);
</script></html>`;
