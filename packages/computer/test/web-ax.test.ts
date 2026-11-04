import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readBoundedAx,validateFullAx,validatePartialAx,validateAxAncestors,type AxNode,type AxRead} from '../src/web-ax.ts';

function tree(nodes:AxNode[]){
	const requests:string[]=[],byId=new Map(nodes.map(node=>[node.nodeId,node]));
	const read:AxRead=async(method,params)=>{
		requests.push(method);
		if(method==='Accessibility.getRootAXNode')return{node:byId.get('root')};
		if(method==='Accessibility.getChildAXNodes')return{nodes:(byId.get(String(params.id))?.childIds??[]).map(id=>byId.get(id))};
		throw new Error('Unexpected whole-tree request '+method);
	};
	return{read,requests,byId};
}
const show=(node:AxNode)=>!node.ignored&&node.role?.value==='button';
test('a wide page stops expansion honestly; sibling headers can still arrive in one large reply',async()=>{
	const buttons=Array.from({length:5000},(_,i)=>({nodeId:'b'+i,role:{value:'button'},name:{value:'Own '+i}})),fixture=tree([{nodeId:'root',childIds:buttons.map(node=>node.nodeId)},...buttons]);
	const result=await readBoundedAx(fixture.read,'frame',show,()=>false);
	assert.equal(result.limited,true);assert.equal(result.nodes.filter(show).length,400);assert.equal(result.nodes.some(node=>node.nodeId==='b4999'),false);assert.deepEqual(fixture.requests,['Accessibility.getRootAXNode','Accessibility.getChildAXNodes']);
});
test('each observation actively reads changed children without waiting for an AX event',async()=>{
	const fixture=tree([{nodeId:'root',childIds:['b']},{nodeId:'b',role:{value:'button'},name:{value:'Before'}}]);
	const first=await readBoundedAx(fixture.read,'frame',show,()=>false);fixture.byId.set('b',{nodeId:'b',role:{value:'button'},name:{value:'After'}});
	const second=await readBoundedAx(fixture.read,'frame',show,()=>false);assert.equal(first.nodes[1]!.name?.value,'Before');assert.equal(second.nodes[1]!.name?.value,'After');assert.equal(fixture.requests.length,4);
});
test('depth, request and traversal limits all report a partial range',async()=>{
	for(const limits of [{elements:400,requests:1,nodes:4096,depth:12},{elements:400,requests:128,nodes:1,depth:12},{elements:400,requests:128,nodes:4096,depth:1}]){
		const fixture=tree([{nodeId:'root',childIds:['container']},{nodeId:'container',childIds:['b']},{nodeId:'b',role:{value:'button'}}]);assert.equal((await readBoundedAx(fixture.read,'frame',show,()=>false,limits)).limited,true);
	}
});
test('known protected ignored parents are included but their editor descendants are never requested',async()=>{
	const fixture=tree([{nodeId:'root',childIds:['password']},{nodeId:'password',ignored:true,backendDOMNodeId:2,childIds:['editor']},{nodeId:'editor',name:{value:'own synthetic secret'}}]);
	const result=await readBoundedAx(fixture.read,'frame',show,node=>node.backendDOMNodeId===2);assert.equal(result.nodes.some(node=>node.nodeId==='editor'),false);assert.equal(fixture.requests.length,2);
});
test('missing children and cyclic scope never become a successful complete observation',async()=>{
	for(const nodes of [[{nodeId:'root',childIds:['missing']}],[{nodeId:'root',childIds:['root']}]] as AxNode[][]){
		const fixture=tree(nodes);await assert.rejects(readBoundedAx(fixture.read,'frame',show,()=>false));
	}
});
test('an embedded document never inherits its parent frame identity',async()=>{
	const fixture=tree([{nodeId:'root',frameId:'parent',childIds:['embedded']},{nodeId:'embedded',frameId:'child',childIds:['b']},{nodeId:'b',role:{value:'button'}}]);
	const result=await readBoundedAx(fixture.read,'parent',show,()=>false);assert.deepEqual(result.nodes.map(node=>node.nodeId),['root']);assert.equal(fixture.requests.length,2);
	await assert.rejects(readBoundedAx(fixture.read,'different',show,()=>false),/another frame/);
});

test('a child reply cannot overwrite an already read ancestor or change protected hierarchy',async()=>{
	const root:AxNode={nodeId:'root',childIds:['public','password']};
	await assert.rejects(readBoundedAx(async(method,p)=>{
		if(method==='Accessibility.getRootAXNode')return{node:root};
		if(p.id==='root')return{nodes:[{nodeId:'public',role:{value:'button'},childIds:['leaf']},{nodeId:'password',childIds:['secret'],properties:[{name:'protected',value:{value:true}}]}]};
		return{nodes:[{nodeId:'leaf',role:{value:'button'}},{...root,childIds:[]}]};
	},'frame',show,node=>node.properties?.some(p=>p.name==='protected'&&p.value?.value===true)===true),/ancestor/);
});

test('a protected child presented under another parent cannot escape privacy filtering in a partial read',async()=>{
	const root:AxNode={nodeId:'root',childIds:['password','editor']};
	const password:AxNode={nodeId:'password',parentId:'root',childIds:['editor'],properties:[{name:'protected',value:{value:true}}]};
	const editor:AxNode={nodeId:'editor',parentId:'password',role:{value:'button'},name:{value:'own-synthetic-secret'}};
	await assert.rejects(readBoundedAx(async(method)=>method==='Accessibility.getRootAXNode'?{node:root}:{nodes:[password,editor]},'frame',show,node=>node===password),/conflicting parents|different parent/);
});

test('only a closed, connected, unambiguous full document can prove absence',()=>{
	const root:AxNode={nodeId:'root',frameId:'frame',role:{value:'RootWebArea'},childIds:['a']},a:AxNode={nodeId:'a',parentId:'root',role:{value:'textbox'},backendDOMNodeId:10};
	assert.deepEqual(validateFullAx([root,a],'frame'),[root,a]);
	const malformed:AxNode[][]=[
		[root], [root,a,{...a,name:{value:'Replacement'}}], [root,{...a,childIds:['root']}],
		[root,a,{nodeId:'orphan'}], [{...root,frameId:'foreign'},a],
		[{...root,childIds:['a','a']},a], [root,{...a,parentId:'different'}],
		[{...root,childIds:['a','b']},a,{nodeId:'b',childIds:['a']}],
	];
	for(const nodes of malformed)assert.throws(()=>validateFullAx(nodes,'frame'));
});

test('precise readback binds to the nearest document and excludes legitimate outer-frame ancestors',()=>{
	const child:AxNode={nodeId:'input',parentId:'child-root',backendDOMNodeId:10},root:AxNode={nodeId:'child-root',frameId:'child',role:{value:'RootWebArea'},childIds:['input']};
	const outer:AxNode={nodeId:'outer-root',frameId:'parent',role:{value:'RootWebArea'},childIds:['child-root']};
	assert.deepEqual(validateAxAncestors([child,root,outer],10,'child'),[child,root]);
	assert.throws(()=>validateAxAncestors([child,{...root,frameId:'different'},outer],10,'child'),/another document/);
	assert.throws(()=>validateAxAncestors([child,root],11,'child'),/another document/);
	assert.throws(()=>validateAxAncestors([{...child,parentId:'wrong'},root],10,'child'),/ancestry changed/);
	assert.throws(()=>validateAxAncestors([child,child,root],10,'child'),/repeats/);
});

test('a merged partial scope may omit children but cannot have conflicting ancestry around a protected node',()=>{
	const root:AxNode={nodeId:'root',frameId:'frame',role:{value:'RootWebArea'},childIds:['public','password','unread']};
	const password:AxNode={nodeId:'password',parentId:'root',childIds:['editor'],properties:[{name:'protected',value:{value:true}}]};
	const pub:AxNode={nodeId:'public',parentId:'root',role:{value:'button'}};
	assert.deepEqual(validatePartialAx([root,pub,password],'frame'),[root,pub,password]);
	const editor:AxNode={nodeId:'editor',parentId:'root',name:{value:'synthetic secret'}};
	assert.throws(()=>validatePartialAx([{...root,childIds:[...root.childIds!,'editor']},pub,password,editor],'frame'),/multiple parents/);
});
