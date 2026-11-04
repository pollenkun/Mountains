export interface AxNode{
	nodeId?:string;ignored?:boolean;role?:{value?:unknown};name?:{value?:unknown};value?:{value?:unknown};
	properties?:{name?:string;value?:{value?:unknown}}[];childIds?:string[];parentId?:string;backendDOMNodeId?:number;frameId?:string;
}
export type AxRead=(method:string,params:Record<string,unknown>)=>Promise<unknown>;
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

function axNode(value:unknown):AxNode&{nodeId:string}{
	const node=record(value) as AxNode;
	if(typeof node.nodeId!=='string'||!node.nodeId||node.childIds!==undefined&&(!Array.isArray(node.childIds)||node.childIds.some(id=>typeof id!=='string'||!id)))throw new Error('The page accessibility node identity or children were invalid');
	if(new Set(node.childIds??[]).size!==(node.childIds??[]).length)throw new Error('The page accessibility hierarchy repeats a child');
	return node as AxNode&{nodeId:string};
}
const documentNode=(node:AxNode)=>String(node.role?.value).toLowerCase()==='rootwebarea';

/** A full read can prove absence only if it is one closed, connected document.
 * Missing references are not silently treated as removed elements. Frames are
 * fetched separately, so a foreign document is never assigned this frame. */
function validateAxGraph(input:readonly unknown[],frameId:string,complete:boolean):AxNode[]{
	const nodes=input.map(axNode),byId=new Map<string,AxNode>(),parents=new Map<string,string>();
	for(const node of nodes){if(byId.has(node.nodeId!))throw new Error('The page accessibility hierarchy repeats a node');byId.set(node.nodeId!,node);}
	const roots=nodes.filter(documentNode);
	if(roots.length!==1||roots[0]!.frameId!==frameId)throw new Error('The page accessibility document identity is unavailable or belongs to another frame');
	const root=roots[0]!;
	for(const node of nodes){
		if(node.frameId&&node.frameId!==frameId)throw new Error('The page accessibility tree includes another frame');
		for(const id of node.childIds??[]){if(complete&&!byId.has(id))throw new Error('The page accessibility children were incomplete; no complete read was published');if(parents.has(id))throw new Error('The page accessibility hierarchy has multiple parents');parents.set(id,node.nodeId!);}
	}
	if(parents.has(root.nodeId!)||root.parentId)throw new Error('The page accessibility document has an unexpected parent');
	for(const node of nodes)if(node!==root&&(!parents.has(node.nodeId!)||node.parentId!==undefined&&node.parentId!==parents.get(node.nodeId!)))throw new Error('The page accessibility hierarchy is disconnected or changed');
	const visited=new Set<string>(),pending=[root.nodeId!];
	while(pending.length){const id=pending.pop()!;if(!byId.has(id))continue;if(visited.has(id))throw new Error('The page accessibility hierarchy contains a cycle');visited.add(id);for(const child of byId.get(id)!.childIds??[])pending.push(child);}
	if(visited.size!==nodes.length)throw new Error('The page accessibility hierarchy is disconnected or contains a cycle');
	return nodes;
}
export const validateFullAx=(input:readonly unknown[],frameId:string):AxNode[]=>validateAxGraph(input,frameId,true);
/** Missing children are allowed in a bounded scope, conflicting parents are
 * not. Validate again after merging precise target/expectation ancestors. */
export const validatePartialAx=(input:readonly unknown[],frameId:string):AxNode[]=>validateAxGraph(input,frameId,false);

/** CDP can include ancestors beyond a child document's root. Keep only the
 * target-to-nearest-document segment, and verify that document's frame. */
export function validateAxAncestors(input:readonly unknown[],backendNodeId:number,frameId:string):AxNode[]{
	const nodes:AxNode[]=[],seen=new Set<string>();
	for(const value of input){const node=axNode(value);if(seen.has(node.nodeId!))throw new Error('The acted-on accessibility ancestry repeats a node');seen.add(node.nodeId!);nodes.push(node);if(documentNode(node))break;}
	if(nodes[0]?.backendDOMNodeId!==backendNodeId||!documentNode(nodes.at(-1)??{})||nodes.at(-1)!.frameId!==frameId)throw new Error('The acted-on element belongs to another document or could not be read back; read the current page again');
	for(let i=0;i<nodes.length-1;i++){const child=nodes[i]!,parent=nodes[i+1]!;if(child.frameId&&child.frameId!==frameId||child.parentId!==parent.nodeId||!parent.childIds?.includes(child.nodeId!))throw new Error('The acted-on accessibility ancestry changed; read the current page again');}
	return nodes;
}

/** Read actively, never from delayed nodesUpdated events. CDP has no sibling
 * offset/limit: a reply can still contain many child headers. These limits
 * bound expansion, not the byte size of an individual protocol reply. */
export async function readBoundedAx(read:AxRead,frameId:string,show:(node:AxNode)=>boolean,protectedNode:(node:AxNode)=>boolean,
	limits:{elements:number;requests:number;nodes:number;depth:number}={elements:400,requests:128,nodes:4096,depth:12}):Promise<{nodes:AxNode[];limited:boolean;requests:number}>{
	for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid accessibility read limit');
	const root=axNode(record(await read('Accessibility.getRootAXNode',{frameId})).node);
	if(root.frameId&&root.frameId!==frameId)throw new Error('The page accessibility root belongs to another frame');
	const known=new Map<string,AxNode>([[root.nodeId,root]]),included=new Set<string>(),expanded=new Set<string>();
	const parents=new Map<string,string>(),connected=new Set([root.nodeId]);
	const attach=(nodes:readonly AxNode[])=>{
		// Even an unread/protected subtree's declared edges matter: otherwise a
		// secret child could be presented again as an innocent root child.
		for(const node of nodes)for(const id of node.childIds??[]){
			if(id===root.nodeId||parents.has(id)&&parents.get(id)!==node.nodeId)throw new Error('The page accessibility hierarchy has conflicting parents');
			parents.set(id,node.nodeId!);
			const child=known.get(id);if(child?.parentId!==undefined&&child.parentId!==node.nodeId)throw new Error('The page accessibility child belongs to a different parent');
		}
		for(const node of nodes){
			if(node.nodeId===root.nodeId)continue;
			if(!parents.has(node.nodeId!)||node.parentId!==undefined&&node.parentId!==parents.get(node.nodeId!))throw new Error('The page accessibility child belongs to a different parent');
			const path=new Set<string>();let id=node.nodeId!;
			while(!connected.has(id)){
				if(path.has(id))throw new Error('The page accessibility hierarchy contains a cycle');path.add(id);
				const parent=parents.get(id);if(!parent||!known.has(parent))throw new Error('The page accessibility hierarchy is disconnected');id=parent;
			}
			for(const id of path)connected.add(id);
		}
	};
	attach([root]);
	const pending=[{id:root.nodeId,depth:0}];let visible=0,requests=1,limited=false;
	while(pending.length){
		if(visible>=limits.elements||included.size>=limits.nodes){limited=true;break;}
		const current=pending.pop()!;if(included.has(current.id))throw new Error('The page accessibility hierarchy changed or contains repeated nodes');
		const node=known.get(current.id);if(!node)throw new Error('The page accessibility children were incomplete; no complete read was published');
		// Embedded documents are read separately through their owning session.
		if(node.frameId&&node.frameId!==frameId)continue;
		included.add(current.id);if(show(node))visible++;
		if(protectedNode(node)||!node.childIds?.length)continue;
		if(current.depth>=limits.depth){limited=true;continue;}
		if(!expanded.has(current.id)){
			if(requests>=limits.requests){limited=true;break;}
			requests++;
			const reply=record(await read('Accessibility.getChildAXNodes',{id:current.id,frameId}));
			if(!Array.isArray(reply.nodes))throw new Error('The page accessibility children were unavailable');
			const replyIds=new Set<string>(),children:AxNode[]=[];
			for(const child of reply.nodes){const value=axNode(child),id=value.nodeId!;
				if(replyIds.has(id)||included.has(id))throw new Error('The page accessibility children repeated or replaced an observed ancestor');replyIds.add(id);
				const previous=known.get(id);if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw new Error('The page accessibility hierarchy changed during observation; read again');
				known.set(id,value);children.push(value);
			}
			attach(children);
			expanded.add(current.id);
		}
		const children=known.get(current.id)!.childIds??[];
		for(const id of [...children].reverse())pending.push({id,depth:current.depth+1});
	}
	return{nodes:[...included].map(id=>known.get(id)!),limited,requests};
}
