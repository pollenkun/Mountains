import assert from 'node:assert/strict';
import type {RequestProof} from './request-witness.ts';
export interface RecordItem{id:string;name:string;amount:number;comment:string}
export interface RecordsState{records:RecordItem[]}
/** Original case9 dataset and update shape. No user account or old run data. */
export class RecordsFixture{
 private state:RecordsState={records:Array.from({length:13},(_,index)=>({id:'record-'+(101+index),name:index===2||index===10?'Quarterly report':'Record '+(101+index),amount:index+1,comment:'Initial '+(101+index)}))};
 private readonly append:(kind:string,fields:Record<string,unknown>)=>void;
 constructor(append:(kind:string,fields:Record<string,unknown>)=>void){this.append=append;}
 snapshot():RecordsState{return structuredClone(this.state);}
 apply(value:unknown,proof:Readonly<RequestProof>):{code:number;body:Record<string,unknown>}{
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value));const body=value as Record<string,unknown>;assert.deepEqual(Object.keys(body).sort(),['comment','id']);assert.equal(typeof body.id,'string');assert.equal(typeof body.comment,'string');assert.equal(new URL(proof.url).pathname,'/api/records');
  const next=this.snapshot(),item=next.records.find(row=>row.id===body.id);
  if(!item){this.append('record-rejected',{id:body.id,proof,web:next});return{code:404,body:{error:'Exact record ID not found'}};}
  item.comment=body.comment as string;this.append('record-edited',{id:item.id,proof,web:structuredClone(next)});this.state=next;return{code:200,body:{message:'Updated '+item.id}};
 }
}
// Same pagination, filtering, fields and handlers as original web/app.js records().
// Its POST needs private browser proof; the page contains no authorization token.
export const RECORDS_PAGE=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mountains Web QA</title>
<style>body{font:17px system-ui;margin:28px}label{display:block;margin:12px 0}input,button{font:inherit;padding:7px}article{margin:12px 0;padding:10px;border:1px solid #aaa}</style>
<main id="app"></main><p id="status" role="status">Ready</p><script>
const app=document.querySelector('#app'),status=document.querySelector('#status');let state,page=1;
const element=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;};
const button=(label,run)=>{const node=element('button',label,{type:'button'});node.addEventListener('click',()=>Promise.resolve(run()).catch(error=>{status.textContent='Error: '+error.message;}));return node;};
const field=(label,value='')=>{const wrapper=element('label',label+' '),input=element('input',undefined,{type:'text','aria-label':label});input.value=value;wrapper.append(input);return{wrapper,input};};
async function api(body){const response=await fetch('/api/records',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error);status.textContent=data.message||'Done';return data;}
async function load(){state=await(await fetch('/api/state')).json();}
(async()=>{await load();app.append(element('h1','Paged records'));const filter=field('Filter records'),list=element('section'),pageLabel=element('p');
 const render=()=>{const matches=state.records.filter(item=>(item.name+' '+item.id).toLowerCase().includes(filter.input.value.toLowerCase())),pages=Math.max(1,Math.ceil(matches.length/4));page=Math.min(page,pages);list.replaceChildren();pageLabel.textContent='Page '+page+' of '+pages+' / '+matches.length+' records';
  for(const item of matches.slice((page-1)*4,page*4)){const row=element('article'),comment=field('Comment '+item.id,item.comment);row.append(element('h2',item.name+' / '+item.id),comment.wrapper,button('Save '+item.id,async()=>{await api({id:item.id,comment:comment.input.value});await load();render();}));list.append(row);}};
 app.append(filter.wrapper,button('Apply filter',()=>{page=1;render();}),button('Clear filter',()=>{filter.input.value='';page=1;render();}),button('Previous page',()=>{page=Math.max(1,page-1);render();}),button('Next page',()=>{page++;render();}),pageLabel,list);render();status.textContent='Ready';})().catch(error=>{status.textContent='Error: '+error.message;});
</script></html>`;
