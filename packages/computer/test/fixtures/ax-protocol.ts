import type {AxNode} from '../../src/web-ax.ts';

/** Serve the same mutable fixture tree through the real CDP AX read shapes.
 * Older fixtures are forests; attach their roots to a document, rather than
 * making the product skip its production bounded-reader path in tests. */
export function axFixtureNodes(input:readonly AxNode[],frameId:string):AxNode[]{
	const nodes=input.map(node=>({...node,childIds:[...(node.childIds??[])]})),byId=new Map(nodes.map(node=>[node.nodeId,node]));
	const children=new Set(nodes.flatMap(node=>node.childIds)),roots=nodes.filter(node=>!children.has(node.nodeId!));
	let root=nodes.find(node=>String(node.role?.value).toLowerCase()==='rootwebarea');
	if(!root){root={nodeId:'fixture-document-root',role:{value:'RootWebArea'},childIds:roots.map(node=>node.nodeId!)};nodes.unshift(root);byId.set(root.nodeId,root);}
	else for(const extra of roots)if(extra!==root&&!root.childIds.includes(extra.nodeId!))root.childIds.push(extra.nodeId!);
	root.frameId=frameId;
	for(const parent of nodes)for(const id of parent.childIds??[]){const child=byId.get(id);if(child)child.parentId=parent.nodeId!;}
	return nodes;
}
export function axFixtureReply(input:readonly AxNode[],method:string,params:Record<string,unknown>={},frameId='f1'):unknown{
	const nodes=axFixtureNodes(input,frameId),byId=new Map(nodes.map(node=>[node.nodeId,node])),root=nodes.find(node=>String(node.role?.value).toLowerCase()==='rootwebarea')!;
	if(method==='Accessibility.getRootAXNode')return{node:root};
	if(method==='Accessibility.getChildAXNodes'){
		const parent=byId.get(String(params.id));if(!parent)throw new Error('Fixture accessibility parent is no longer present');
		return{nodes:(parent.childIds??[]).map(id=>{const child=byId.get(id);if(!child)throw new Error('Fixture accessibility child is missing');return child;})};
	}
	if(method==='Accessibility.getAXNodeAndAncestors'){
		const result:AxNode[]=[],seen=new Set<string>();let node=nodes.find(node=>node.backendDOMNodeId===params.backendNodeId);
		while(node){if(seen.has(node.nodeId!))throw new Error('Fixture accessibility cycle');seen.add(node.nodeId!);result.push(node);const id=node.nodeId;node=nodes.find(parent=>parent.childIds?.includes(id!));}
		return{nodes:result};
	}
	throw new Error('Unsupported fixture AX method '+method);
}
