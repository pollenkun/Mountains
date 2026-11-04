import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CdpConnection} from '../src/web.ts';

class Socket{
	static last:Socket;
	readyState=0;readonly sent:{id:number;method:string;sessionId?:string}[]=[];
	private readonly listeners=new Map<string,Set<(event:unknown)=>void>>();
	constructor(){Socket.last=this;queueMicrotask(()=>{this.readyState=1;this.emit('open',{});});}
	addEventListener(type:string,listener:(event:unknown)=>void):void{const set=this.listeners.get(type)??new Set();set.add(listener);this.listeners.set(type,set);}
	send(data:string):void{this.sent.push(JSON.parse(data));}
	close():void{this.readyState=3;this.emit('close',{});}
	emit(type:string,value:unknown):void{for(const listener of this.listeners.get(type)??[])listener(value);}
	message(value:unknown):void{this.emit('message',{data:JSON.stringify(value)});}
	event(sessionId:string,method:string,params:Record<string,unknown>):void{this.message({sessionId,method,params});}
	ack(id:number):void{this.message({id,result:{}});}
}
async function fixture(){
	const cdp=await CdpConnection.open('ws://127.0.0.1/own-test',15000,()=>new Socket());
	return{cdp,socket:Socket.last,close:async()=>{await cdp.close();}};
}
test('a root dialog suspends child and nested-child input deadlines but leaves another page bounded',async()=>{
	const f=await fixture();try{
		f.socket.event('root','Target.attachedToTarget',{sessionId:'child'});f.socket.event('child','Target.attachedToTarget',{sessionId:'nested'});
		await new Promise(resolve=>setImmediate(resolve));
		const pending=f.cdp.send('Input.dispatchMouseEvent',{},'nested',30);let finished=false;void pending.then(()=>{finished=true;},()=>{finished=true;});
		f.socket.event('root','Page.javascriptDialogOpening',{type:'confirm',message:'own fixture'});
		const other=f.cdp.send('DOM.describeNode',{},'other-page',30),refused=assert.rejects(other,/timed out calling/);
		await new Promise(resolve=>setTimeout(resolve,85));assert.equal(finished,false);await refused;
		f.socket.event('root','Page.javascriptDialogClosed',{result:true});f.socket.ack(f.socket.sent[0]!.id);await pending;
	}finally{await f.close();}
});
test('a child dialog suspends its parent input and can still send an explicit dialog response',async()=>{
	const f=await fixture();try{
		f.socket.event('root','Target.attachedToTarget',{sessionId:'child'});await new Promise(resolve=>setImmediate(resolve));
		const pending=f.cdp.send('Input.dispatchKeyEvent',{},'root',25);let failed=false;void pending.catch(()=>{failed=true;});
		f.socket.event('child','Page.javascriptDialogOpening',{type:'confirm'});await new Promise(resolve=>setTimeout(resolve,60));assert.equal(failed,false);
		const accepted=f.cdp.send('Page.handleJavaScriptDialog',{accept:true},'child',100);f.socket.ack(f.socket.sent.at(-1)!.id);await accepted;
		f.socket.event('child','Page.javascriptDialogClosed',{result:true});f.socket.ack(f.socket.sent[0]!.id);await pending;
	}finally{await f.close();}
});
test('timeouts discard old responses and closing rejects every pending request immediately',async()=>{
	const f=await fixture();try{
		await assert.rejects(f.cdp.send('Runtime.evaluate',{},'root',15),/timed out calling/);f.socket.ack(f.socket.sent[0]!.id);
		const pending=f.cdp.send('Runtime.evaluate',{},'root',1000),rejected=assert.rejects(pending,/connection closed/);f.socket.close();await rejected;
		await assert.rejects(f.cdp.send('Runtime.evaluate',{},'root'),/not open/);
	}finally{await f.close();}
});
test('detaching a dialog issuer rejects its child requests and restores parent deadlines',async()=>{
	const f=await fixture();try{
		f.socket.event('root','Target.attachedToTarget',{sessionId:'child'});f.socket.event('child','Target.attachedToTarget',{sessionId:'nested'});await new Promise(resolve=>setImmediate(resolve));
		f.socket.event('nested','Page.javascriptDialogOpening',{type:'confirm'});await new Promise(resolve=>setImmediate(resolve));
		const abandoned=f.cdp.send('Input.dispatchKeyEvent',{},'nested',25),gone=assert.rejects(abandoned,/session detached/);
		f.socket.event('root','Target.detachedFromTarget',{sessionId:'child'});await gone;
		await assert.rejects(f.cdp.send('DOM.describeNode',{},'root',25),/timed out calling/);
	}finally{await f.close();}
});
