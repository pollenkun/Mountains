import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PassThrough} from 'node:stream';
import {controllerInput} from './acceptance/controller-input.ts';
const turn=()=>new Promise<void>(yes=>setImmediate(yes));
function own(){const stream=new PassThrough(),abort=new AbortController(),loss:Error[]=[];return{stream,abort,loss,input:controllerInput(stream,abort.signal,error=>loss.push(error))};}
test('interactive controller retains lines before and after a read starts',async()=>{
	const {stream,input,loss}=own();try{stream.write('first\n');assert.equal(await input.next(),'first');const second=input.next();stream.write('second\n');assert.equal(await second,'second');assert.equal(loss.length,0);}finally{input.close();stream.destroy();}
});
for(const early of [true,false])test('interactive controller remembers '+(early?'early EOF before its read':'EOF while awaiting a read'),async()=>{
	const {stream,input,loss}=own();try{const next=early?undefined:input.next();if(next)void next.catch(()=>{});stream.end();await turn();await assert.rejects(next??input.next(),/input ended/);await assert.rejects(input.next(),/input ended/);assert.equal(loss.length,1);}finally{input.close();stream.destroy();}
});
test('interactive controller cannot miss a stream that ended before construction',async()=>{
	const stream=new PassThrough();stream.end();stream.resume();await turn();const loss:Error[]=[],input=controllerInput(stream,new AbortController().signal,error=>loss.push(error));try{await assert.rejects(input.next(),/input ended/);assert.equal(loss.length,1);}finally{input.close();}
});
test('controller cancellation rejects the actual pending read and discards queued late lines',async()=>{
	const {stream,input,abort,loss}=own();try{const next=input.next();abort.abort(new Error('own cancellation'));await assert.rejects(next,/own cancellation/);stream.write('late\n');await assert.rejects(input.next(),/own cancellation/);assert.equal(loss.length,0);}finally{input.close();stream.destroy();}
});
test('controller close is idempotent and does not report voluntary finish as lost input',async()=>{
	const {stream,input,loss}=own();const next=input.next();input.close();input.close();await assert.rejects(next,/input is closed/);await assert.rejects(input.next(),/input is closed/);stream.destroy();await turn();assert.equal(loss.length,0);
});
test('controller stream errors stop a pending read exactly once',async()=>{
	const {stream,input,loss}=own();try{const next=input.next();stream.emit('error',new Error('test stream error'));await assert.rejects(next,/input failed/);assert.equal(loss.length,1);}finally{input.close();stream.destroy();}
});
test('controller refuses unbounded queued input instead of retaining a fixed script',async()=>{
	const {stream,input,loss}=own();try{stream.write(Array.from({length:17},(_,i)=>String(i)).join('\n')+'\n');await assert.rejects(input.next(),/exceeded its bound/);assert.equal(loss.length,1);}finally{input.close();stream.destroy();}
});
test('late input EIO after voluntary finish is recorded and cannot interrupt resource cleanup',async()=>{
	const {stream,input,loss}=own(),closed:string[]=[];
	try{
		input.close();assert.equal(stream.listenerCount('error'),1);
		await Promise.resolve();assert.doesNotThrow(()=>stream.emit('error',Object.assign(new Error('own late EIO'),{code:'EIO'})));
		for(const resource of ['browser','HTTP','monitor']){await Promise.resolve();closed.push(resource);}
		assert.deepEqual(closed,['browser','HTTP','monitor']);assert.equal(loss.length,1);assert.match(loss[0]!.message,/during cleanup/);
		stream.emit('error',new Error('duplicate late error'));assert.equal(loss.length,1);await assert.rejects(input.next(),/input is closed/);
	}finally{input.close();stream.destroy();}
});
