import type {CdpEvent,CdpLike} from './web.ts';

export interface BrowserFrame{
	frameId:string;sessionId:string;url:string;parentId?:string;loaderId?:string;
}
type Tree={frame?:Record<string,unknown>;childFrames?:unknown[]};
type Root={targetId:string;sessionId:string;sessions:Set<string>;pending:Set<Promise<void>>;errors:Map<string,string>;frames:Map<string,BrowserFrame>;closed:boolean;revision:number;viewRevision:number};
type Session={root:Root;parent?:string;ready?:Promise<void>};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** CDP iframe targets can run in another renderer. A backend DOM number alone
 * is therefore not a node identity: every read/action also needs its session.
 * Auto-attachment never activates a tab or pauses page JavaScript. */
export class BrowserFrames{
	private readonly roots=new Map<string,Root>();
	private readonly sessions=new Map<string,Session>();
	private readonly contexts=new Map<string,number>();
	private readonly off:()=>void;
	private readonly cdp:CdpLike;
	private readonly changed:(targetId:string)=>void;
	private readonly observed:((rootSession:string,event:CdpEvent)=>void)|undefined;
	private closed=false;
	constructor(cdp:CdpLike,changed:(targetId:string)=>void,observed?:(rootSession:string,event:CdpEvent)=>void){this.cdp=cdp;this.changed=changed;this.observed=observed;this.off=cdp.on(event=>this.event(event));}
	async addRoot(targetId:string,sessionId:string):Promise<void>{
		if(this.closed)throw new Error('The frame registry is closed');
		const existing=this.roots.get(sessionId);if(existing){await this.ready(existing);return;}
		const root:Root={targetId,sessionId,sessions:new Set([sessionId]),pending:new Set(),errors:new Map(),frames:new Map(),closed:false,revision:0,viewRevision:-1};
		this.roots.set(sessionId,root);this.sessions.set(sessionId,{root});
		try{await this.autoAttach(sessionId);await this.ready(root);}
		catch(error){this.removeRoot(sessionId);throw error;}
	}
	private autoAttach(sessionId:string):Promise<unknown>{
		return this.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false},{exclude:true}]},sessionId);
	}
	private async initialize(sessionId:string):Promise<void>{
		for(const method of ['Page.enable','Runtime.enable','DOM.enable','Accessibility.enable']){this.requireSession(sessionId);await this.cdp.send(method,{},sessionId);}
		this.requireSession(sessionId);
		await this.cdp.send('Page.setLifecycleEventsEnabled',{enabled:true},sessionId);
		this.requireSession(sessionId);
		await this.autoAttach(sessionId);
	}
	private requireSession(sessionId:string):void{const session=this.sessions.get(sessionId);if(!session||session.root.closed)throw new Error('The iframe was detached while being initialized');}
	private bump(root:Root):void{root.revision++;this.changed(root.targetId);}
	private event(event:CdpEvent):void{
		const session=event.sessionId?this.sessions.get(event.sessionId):undefined;if(!session||session.root.closed)return;
		const root=session.root;
		this.observed?.(root.sessionId,event);
		if(event.method==='Target.attachedToTarget'){
			const child=event.params.sessionId,info=object(event.params.targetInfo);
			if(typeof child!=='string'||info.type!=='iframe'||this.sessions.has(child))return;
			root.sessions.add(child);this.sessions.set(child,{root,parent:event.sessionId!});this.bump(root);
			// Event handlers cannot await. Keep every initialization promise until
			// capture waits for it; a failed frame is never silently omitted.
			const ready=this.initialize(child);this.sessions.get(child)!.ready=ready;root.pending.add(ready);
			void ready.then(()=>root.pending.delete(ready),()=>{root.pending.delete(ready);if(this.sessions.has(child)&&!root.closed)root.errors.set(child,'An iframe could not be initialized; no complete page read is available');});return;
		}
		if(event.method==='Target.detachedFromTarget'){
			const child=event.params.sessionId;if(typeof child==='string'&&this.sessions.get(child)?.root===root&&this.sessions.get(child)?.parent===event.sessionId){this.removeSession(child);this.bump(root);}return;
		}
		if(['Page.frameNavigated','Page.navigatedWithinDocument','Page.frameAttached','Page.frameDetached'].includes(event.method)){
			this.contexts.clear();this.bump(root);
		}
	}
	private async ready(root:Root):Promise<void>{
		while(root.pending.size)await Promise.allSettled([...root.pending]);
		if(root.closed)throw new Error('The page closed while reading its frames');
		if(root.errors.size)throw new Error(root.errors.values().next().value);
	}
	/** Refresh each renderer once. Root frames are collected first; a child
 * renderer's own frame tree supplies the authoritative session for its nodes. */
	async list(rootSession:string):Promise<BrowserFrame[]>{
		const root=this.roots.get(rootSession);if(!root||root.closed)throw new Error('The page frame session is unavailable');
		await this.ready(root);
		const revision=root.revision,ordered=[...root.sessions].sort((a,b)=>this.depth(a)-this.depth(b));
		const trees=await Promise.all(ordered.map(async sessionId=>({sessionId,tree:object(object(await this.cdp.send('Page.getFrameTree',{},sessionId)).frameTree) as Tree})));
		await this.ready(root);
		// An attachment arriving during the reads changes the scope. Capture can
		// retry after the enclosing page generation changes, without publishing a
		// partial child tree as full:true.
		if(revision!==root.revision||ordered.length!==root.sessions.size||ordered.some(id=>!root.sessions.has(id)))throw new Error('The page frame tree changed while being read; read the page again');
		const frames=new Map<string,BrowserFrame>();let main:string|undefined;
		for(const {sessionId,tree}of trees){
			const collect=(item:Tree,parentId?:string):void=>{
				const value=object(item.frame),id=value.id;if(typeof id!=='string')return;
				if(sessionId===rootSession&&!parentId)main=id;
				const previous=frames.get(id),parent=typeof value.parentId==='string'?value.parentId:parentId??previous?.parentId;
				frames.set(id,{frameId:id,sessionId,url:typeof value.url==='string'?value.url:'',...(parent?{parentId:parent}:{}),...(typeof value.loaderId==='string'?{loaderId:value.loaderId}:{})});
				for(const child of item.childFrames??[])collect(object(child) as Tree,id);
			};collect(tree);
		}
		const reachable=(frame:BrowserFrame):boolean=>{
			const seen=new Set<string>();let current:BrowserFrame|undefined=frame;
			while(current){if(current.frameId===main)return true;if(seen.has(current.frameId))return false;seen.add(current.frameId);current=current.parentId?frames.get(current.parentId):undefined;}return false;
		};
		if(!main||[...frames.values()].some(frame=>!reachable(frame)))throw new Error('The iframe parent tree is incomplete; no complete page read is available');
		root.frames=frames;root.viewRevision=revision;
		return [...root.frames.values()];
	}
	private depth(sessionId:string):number{
		let depth=0,current=this.sessions.get(sessionId);const seen=new Set<string>();
		while(current?.parent){if(seen.has(current.parent))throw new Error('Invalid iframe session hierarchy');seen.add(current.parent);depth++;current=this.sessions.get(current.parent);}return depth;
	}
	locate(rootSession:string,frameId:string):BrowserFrame{
		const root=this.roots.get(rootSession),frame=root?.frames.get(frameId);if(!frame||root!.closed||root!.viewRevision!==root!.revision)throw new Error('The observed frame is no longer available; read the page again');return{...frame};
	}
	mainFrame(rootSession:string):BrowserFrame{
		const root=this.roots.get(rootSession),frame=root&&[...root.frames.values()].find(frame=>!frame.parentId&&frame.sessionId===rootSession);
		if(!frame)throw new Error('The main frame has not been observed');return this.locate(rootSession,frame.frameId);
	}
	rootSession(sessionId:string):string{return this.sessions.get(sessionId)?.root.sessionId??sessionId;}
	withinSession(sessionId:string,parent:string):boolean{const seen=new Set<string>();for(;;){if(sessionId===parent)return true;const current=this.sessions.get(sessionId);if(!current?.parent||seen.has(sessionId))return false;seen.add(sessionId);sessionId=current.parent;}}
	async context(rootSession:string,frameId:string):Promise<{sessionId:string;contextId:number}>{
		const root=this.roots.get(rootSession),frame=this.locate(rootSession,frameId),revision=root!.revision,key=JSON.stringify([frame.sessionId,frameId,frame.loaderId??'']);
		let id=this.contexts.get(key);
		if(id===undefined){const value=object(await this.cdp.send('Page.createIsolatedWorld',{frameId,worldName:'mountains-frame-observation'},frame.sessionId));if(root!.closed||root!.revision!==revision)throw new Error('The frame navigated while creating its observation context');if(typeof value.executionContextId!=='number'||!Number.isSafeInteger(value.executionContextId))throw new Error('The frame observation context is unavailable');id=value.executionContextId;this.contexts.set(key,id);}
		return{sessionId:frame.sessionId,contextId:id};
	}
	private removeSession(sessionId:string):void{
		for(const [child,entry]of [...this.sessions])if(entry.parent===sessionId)this.removeSession(child);
		const entry=this.sessions.get(sessionId);if(!entry)return;entry.root.sessions.delete(sessionId);entry.root.errors.delete(sessionId);this.sessions.delete(sessionId);this.contexts.clear();
		for(const [id,frame]of entry.root.frames)if(frame.sessionId===sessionId)entry.root.frames.delete(id);
	}
	removeRoot(sessionId:string):void{const root=this.roots.get(sessionId);if(!root)return;root.closed=true;this.removeSession(sessionId);this.roots.delete(sessionId);}
	close():void{this.closed=true;this.off();for(const session of [...this.roots.keys()])this.removeRoot(session);this.contexts.clear();}
}
