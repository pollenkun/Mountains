import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BrowserFrames} from '../src/web-frames.ts';
import type {CdpEvent,CdpLike} from '../src/web.ts';

class FramesCdp implements CdpLike{
	readonly calls:{method:string;params:Record<string,unknown>;session?:string}[]=[];
	readonly listeners=new Set<(event:CdpEvent)=>void>();
	readonly trees=new Map<string,unknown>();
	answer:((method:string,session:string|undefined)=>Promise<unknown>|undefined)|undefined;
	async send(method:string,params:Record<string,unknown>={},session?:string):Promise<unknown>{
		this.calls.push({method,params,...(session?{session}:{})});const response=this.answer?.(method,session);if(response)return response;
		if(method==='Page.getFrameTree')return{frameTree:this.trees.get(session??'')};
		if(method==='Page.createIsolatedWorld')return{executionContextId:session==='root'?1:2};return{};
	}
	on(listener:(event:CdpEvent)=>void):()=>void{this.listeners.add(listener);return()=>this.listeners.delete(listener);}
	async close():Promise<void>{}
	emit(sessionId:string,method:string,params:Record<string,unknown>):void{for(const listener of this.listeners)listener({sessionId,method,params});}
	attach(parent='root',child='child'):void{this.emit(parent,'Target.attachedToTarget',{sessionId:child,targetInfo:{targetId:'iframe-target-'+child,type:'iframe'},waitingForDebugger:false});}
}
function fixture(){
	const cdp=new FramesCdp(),changes:string[]=[],frames=new BrowserFrames(cdp,target=>changes.push(target));
	cdp.trees.set('root',{frame:{id:'main',url:'http://local.test/',loaderId:'load-main'},childFrames:[{frame:{id:'same',url:'http://local.test/inner',loaderId:'load-same'}},{frame:{id:'cross',url:'http://other.test/',loaderId:'load-cross'}}]});
	cdp.trees.set('child',{frame:{id:'cross',url:'http://other.test/',loaderId:'load-cross'},childFrames:[{frame:{id:'nested',url:'http://third.test/',loaderId:'load-nested'}}]});
	cdp.trees.set('grandchild',{frame:{id:'nested',url:'http://third.test/',loaderId:'load-nested'}});
	return{cdp,changes,frames};
}
test('same-renderer and nested cross-site frames retain their exact CDP session and parent',async()=>{
	const f=fixture();try{
		await f.frames.addRoot('page','root');f.cdp.attach();f.cdp.attach('child','grandchild');
		assert.deepEqual(await f.frames.list('root'),[
			{frameId:'main',sessionId:'root',url:'http://local.test/',loaderId:'load-main'},
			{frameId:'same',sessionId:'root',url:'http://local.test/inner',loaderId:'load-same',parentId:'main'},
			{frameId:'cross',sessionId:'child',url:'http://other.test/',loaderId:'load-cross',parentId:'main'},
			{frameId:'nested',sessionId:'grandchild',url:'http://third.test/',loaderId:'load-nested',parentId:'cross'}
		]);
		assert.ok(f.cdp.calls.some(call=>call.method==='Accessibility.enable'&&call.session==='grandchild'));
		for(const call of f.cdp.calls.filter(call=>call.method==='Target.setAutoAttach'))assert.deepEqual(call.params,{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false},{exclude:true}]});
		assert.ok(f.cdp.calls.every(call=>!/^Input\.|bringToFront|activateTarget/.test(call.method)));
	}finally{f.frames.close();}
});
test('frame observation contexts use the owning renderer and are invalidated by navigation',async()=>{
	const f=fixture();try{
		await f.frames.addRoot('page','root');f.cdp.attach();await f.frames.list('root');
		assert.deepEqual(await f.frames.context('root','cross'),{sessionId:'child',contextId:2});await f.frames.context('root','cross');
		assert.equal(f.cdp.calls.filter(call=>call.method==='Page.createIsolatedWorld').length,1);
		f.cdp.emit('child','Page.frameNavigated',{frame:{id:'cross',url:'http://other.test/new'}});await assert.rejects(f.frames.context('root','cross'),/read the page again/);await f.frames.list('root');await f.frames.context('root','cross');
		assert.equal(f.cdp.calls.filter(call=>call.method==='Page.createIsolatedWorld').length,2);assert.ok(f.changes.every(target=>target==='page'));
	}finally{f.frames.close();}
});
test('a frame failure is reported rather than publishing an incomplete full read',async()=>{
	const f=fixture();try{
		await f.frames.addRoot('page','root');f.cdp.answer=(method,session)=>method==='Accessibility.enable'&&session==='child'?Promise.reject(new Error('PRIVATE-PROBE-CONTENT')):undefined;
		f.cdp.attach();await assert.rejects(f.frames.list('root'),error=>String(error)==='Error: An iframe could not be initialized; no complete page read is available');
		f.cdp.emit('root','Target.detachedFromTarget',{sessionId:'child'});f.cdp.answer=undefined;
		assert.ok((await f.frames.list('root')).some(frame=>frame.frameId==='cross'&&frame.sessionId==='root'));
	}finally{f.frames.close();}
});
test('a detached renderer or a mid-read navigation cannot leave a valid-looking stale frame tree',async()=>{
	const f=fixture();try{
		await f.frames.addRoot('page','root');f.cdp.attach();await f.frames.list('root');
		let first=true;f.cdp.answer=(method,session)=>{if(first&&method==='Page.getFrameTree'&&session==='child'){first=false;f.cdp.emit('root','Target.detachedFromTarget',{sessionId:'child'});}return undefined;};
		await assert.rejects(f.frames.list('root'),/frame tree changed/);assert.throws(()=>f.frames.locate('root','cross'),/no longer/);
		f.cdp.answer=(method,session)=>{if(method==='Page.getFrameTree'&&session==='root')f.cdp.emit('root','Page.navigatedWithinDocument',{frameId:'main'});return undefined;};
		await assert.rejects(f.frames.list('root'),/frame tree changed/);
	}finally{f.frames.close();}
});
test('missing roots, orphaned frames and closed registries never claim a complete page',async()=>{
	const f=fixture();try{
		await f.frames.addRoot('page','root');f.cdp.trees.set('root',{});await assert.rejects(f.frames.list('root'),/incomplete/);
		f.cdp.trees.set('root',{frame:{id:'main',url:'http://local.test/'}});f.cdp.attach();await assert.rejects(f.frames.list('root'),/incomplete/);
		f.frames.close();await assert.rejects(f.frames.list('root'),/unavailable/);assert.equal(f.cdp.listeners.size,0);
	}finally{f.frames.close();}
});
test('unrelated page sessions cannot introduce frames into another client page',async()=>{
	const f=fixture();try{
		await f.frames.addRoot('page','root');f.cdp.attach('foreign','foreign-child');assert.equal((await f.frames.list('root')).length,3);assert.deepEqual(f.changes,[]);
	}finally{f.frames.close();}
});
test('real OOPIF tree shape supplies its own parentId even when omitted by the main renderer',async()=>{
	const f=fixture();try{
		f.cdp.trees.set('root',{frame:{id:'main',url:'http://local.test/'},childFrames:[{frame:{id:'same',url:'http://local.test/inner'}}]});
		f.cdp.trees.set('child',{frame:{id:'cross',parentId:'main',url:'http://other.test/'}});
		await f.frames.addRoot('page','root');f.cdp.attach();const seen=await f.frames.list('root');
		assert.equal(seen.length,3);assert.deepEqual(seen.find(frame=>frame.frameId==='cross'),{frameId:'cross',parentId:'main',sessionId:'child',url:'http://other.test/'});
	}finally{f.frames.close();}
});
test('a detached event from one page cannot remove another page renderer',async()=>{
	const f=fixture();try{
		await f.frames.addRoot('page','root');await f.frames.addRoot('other-page','other-root');f.cdp.trees.set('other-root',{frame:{id:'other-main',url:'http://second.test/'}});
		f.cdp.attach('other-root','foreign-child');f.cdp.trees.set('foreign-child',{frame:{id:'other-child',parentId:'other-main',url:'http://other.test/'}});
		await f.frames.list('other-root');f.cdp.emit('root','Target.detachedFromTarget',{sessionId:'foreign-child'});
		assert.equal(f.frames.locate('other-root','other-child').sessionId,'foreign-child');
	}finally{f.frames.close();}
});
test('navigation during context creation cannot cache a context from the old document',async()=>{
	const f=fixture();try{
		await f.frames.addRoot('page','root');await f.frames.list('root');f.cdp.answer=method=>{
			if(method==='Page.createIsolatedWorld'){f.cdp.emit('root','Page.frameNavigated',{frame:{id:'main',loaderId:'new'}});return Promise.resolve({executionContextId:17});}return undefined;
		};
		await assert.rejects(f.frames.context('root','same'),/navigated while creating/);await assert.rejects(f.frames.context('root','same'),/read the page again/);
		f.cdp.answer=undefined;await f.frames.list('root');assert.equal((await f.frames.context('root','same')).contextId,1);
	}finally{f.frames.close();}
});
