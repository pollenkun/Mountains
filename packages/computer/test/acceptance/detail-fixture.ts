import assert from 'node:assert/strict';
import type {RequestProof} from './request-witness.ts';

export interface DetailState{detail:string}
/** Original case10 state, body and response. The journal must be durable
 * before this disposable service publishes the resulting state. */
export class DetailFixture{
	private state:DetailState={detail:'Original detail'};
	private readonly append:(kind:string,fields:Record<string,unknown>)=>void;
	constructor(append:(kind:string,fields:Record<string,unknown>)=>void){this.append=append;}
	snapshot():DetailState{return structuredClone(this.state);}
	apply(value:unknown,proof:Readonly<RequestProof>):{code:number;body:{message:string}}{
		assert.ok(value&&typeof value==='object'&&!Array.isArray(value));const body=value as Record<string,unknown>;
		assert.deepEqual(Object.keys(body),['value']);assert.equal(typeof body.value,'string');assert.equal(new URL(proof.url).pathname,'/api/detail');
		const next={detail:body.value as string};this.append('detail-saved',{proof,web:structuredClone(next)});this.state=next;return{code:200,body:{message:'Detail saved'}};
	}
}
// Same original QA navigation, HTML dialog, JS confirm/alert and handlers.
// There is no public proof token and no replacement for the real 300ms focus.
export const DETAIL_NAV='<nav aria-label="QA pages"><a href="/form">Form</a><a href="/async">Async</a><a href="/tasks">Tasks</a><a href="/records">Records</a><a href="/detail">Detail</a><a href="/reconcile">Reconcile</a></nav>';
export const DETAIL_PAGE=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mountains Web QA</title>
<style>body{font:17px system-ui;max-width:920px;margin:28px auto}nav{display:flex;gap:18px;flex-wrap:wrap}nav a{padding:8px}main{border:1px solid #aaa;padding:26px;margin-top:22px}label{display:block;margin:14px 0}input,button{font:inherit;padding:7px;margin:4px}dialog{min-width:480px}</style>
${DETAIL_NAV}<main id="app"><h1>Loading QA page</h1></main><p id="status" role="status">Loading</p><script>
'use strict';
const app=document.querySelector('#app'),status=document.querySelector('#status');let state;
const element=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;};
const showError=error=>{status.textContent='Error: '+error.message;};
const button=(label,run)=>{const node=element('button',label,{type:'button'});node.addEventListener('click',()=>Promise.resolve(run()).catch(showError));return node;};
const field=(label,type='text',value='')=>{const wrapper=element('label',label+' '),input=element('input',undefined,{type,'aria-label':label});input.value=value;wrapper.append(input);return{wrapper,input};};
async function api(path,body){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error);status.textContent=data.message||'Done';return data;}
function detail(){
 app.append(element('h1','Detail page'));
 const shown=element('p','Stored detail: '+state.detail),dialog=element('dialog'),value=field('Detail value','text',state.detail);
 const close=()=>dialog.close();
 dialog.append(element('h2','Edit detail'),value.wrapper,button('Cancel edit',close),button('Save detail',async()=>{
  if(!confirm('Save this test detail?')){status.textContent='Confirmation cancelled';return;}
  await api('/api/detail',{value:value.input.value});shown.textContent='Stored detail: '+value.input.value;dialog.close();alert('Saved test detail');
 }));
 dialog.addEventListener('cancel',()=>{status.textContent='Edit cancelled';});
 app.append(shown,button('Edit detail',()=>{value.input.value=state.detail;dialog.showModal();}),dialog,button('Refresh page',()=>location.reload()),button('Test delayed focus',()=>{setTimeout(()=>{window.focus();value.input.focus();status.textContent='Delayed page focus attempted';},300);}));
}
(async()=>{state=await(await fetch('/api/state')).json();app.replaceChildren();detail();status.textContent='Ready';})().catch(showError);
</script></html>`;
