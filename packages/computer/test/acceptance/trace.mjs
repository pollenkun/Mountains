import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const lines=path=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const when=value=>typeof value==='number'?value:Date.parse(value);
export function toolTrace(root,runner){
 assert.ok(['self','deepseek'].includes(runner),'choose the actual self or deepseek trace explicitly');
 const operator=join(root,'evidence','operator.jsonl');
 const cli=join(root,'evidence','cli-source.json');
 assert.ok(!(existsSync(operator)&&existsSync(cli)),'mixed human and model trace sources');
 if(runner==='self'){
  assert.ok(existsSync(operator)&&!existsSync(cli),'self run has no unique operator trace');
  const requests=new Map(),calls=[];
  const completed=new Set();
  for(const entry of lines(operator)){
   if(entry.call&&entry.request){assert.ok(!requests.has(entry.call),'duplicate operator input');requests.set(entry.call,entry);}
   if(entry.call&&(entry.result||entry.error)){const before=requests.get(entry.call);assert.ok(before&&!completed.has(entry.call),'orphan or duplicate operator result');completed.add(entry.call);calls.push({id:entry.call,at:before.at,end:entry.at,startMonotonicMs:before.monotonicMs,endMonotonicMs:entry.monotonicMs,execution:entry.execution,targetBefore:entry.targetBefore,targetAfter:entry.targetAfter,...(entry.observedControls?{observedControls:entry.observedControls}:{}),case:entry.case,tool:before.request.tool,args:before.request.args??{},result:entry.result??{ok:false,modelContent:entry.error,details:{outcome:'unconfirmed',dispatchUnknown:true}},durationMs:entry.elapsedMs});}
  }
  assert.equal(completed.size,requests.size,'unfinished operator calls cannot be omitted from acceptance');
  return calls;
 }
 assert.ok(existsSync(cli)&&!existsSync(operator),'model run has no unique CLI trace');
 const source=JSON.parse(readFileSync(cli,'utf8'));
 const requests=new Map(),calls=[],completed=new Set();
 for(const entry of lines(source.recording)){
  const data=entry.data??{};
  if(entry.kind==='tool.input'){assert.ok(data.toolCallId&&!requests.has(data.toolCallId),'duplicate or missing CLI tool ID');requests.set(data.toolCallId,{at:when(entry.at),tool:data.name,args:JSON.parse(data.arguments||'{}')});}
  if(entry.kind==='tool.output'){
   const request=requests.get(data.toolCallId);if(!request)throw new Error('tool output has no matching request');
   assert.ok(!completed.has(data.toolCallId),'duplicate CLI output');completed.add(data.toolCallId);
   calls.push({id:data.toolCallId,...request,end:when(entry.at),durationMs:data.durationMs,result:{ok:data.ok,modelContent:data.modelContent,details:data.details}});
  }
 }
 assert.equal(completed.size,requests.size,'unfinished CLI calls cannot be omitted from acceptance');
 return calls;
}
