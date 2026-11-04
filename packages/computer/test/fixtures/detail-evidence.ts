import {sha256} from '../acceptance/integrity.ts';
type Row=Record<string,any>;
// Synthetic positive evidence, used only by pure verifier tests.
export function detailEvidence(){
	const origin='http://127.0.0.1:12345',expected={targetId:'owned-target',url:origin+'/detail',value:'Saved own detail'};
	const frame=(generation:number,url:string,loaderId:string)=>({generation,id:'main-frame',loaderId,url});
	const blank=frame(0,'about:blank','blank-loader'),form=frame(1,origin+'/form','form-loader'),detail=frame(2,expected.url,'detail-loader'),back=frame(3,origin+'/form','form-loader'),forward=frame(4,expected.url,'detail-loader'),reload=frame(5,expected.url,'reload-loader');
	const clock={targetId:'clock-target',sessionId:'clock-session'},events:Row[]=[];
	const event=(at:number,kind:string,rest:Row)=>events.push({sequence:events.length+1,at,kind,...structuredClone(rest)});
	event(90,'observer-ready',{targetId:expected.targetId,sessionId:'permanent-session',frame:blank,clock});event(100,'navigation',{frame:form});event(110,'navigation',{frame:detail});
	const confirm1={serial:1,generation:2,url:expected.url,type:'confirm',message:'Save this test detail?'},confirm2={...confirm1,serial:2},alert={serial:3,generation:2,url:expected.url,type:'alert',message:'Saved test detail'};
	event(120,'dialog-opened',{dialog:confirm1});event(121,'dialog-closed',{dialog:confirm1,result:false});event(130,'dialog-opened',{dialog:confirm2});event(131,'dialog-closed',{dialog:confirm2,result:true});event(134,'dialog-opened',{dialog:alert});event(135,'dialog-closed',{dialog:alert,result:true});
	event(140,'navigation',{frame:back});event(150,'navigation',{frame:forward});event(160,'navigation',{frame:reload});
	const scope=(doc:Row,sessionId:string)=>({origin,pageURL:doc.url,targetId:expected.targetId,sessionId,frameId:doc.id,loaderId:doc.loaderId});
	const proof={permissionExecutionId:'case10-call-7',browserNotBefore:100,browserRequestTimestamp:100.1,...scope(detail,'request-detail'),fetchRequestId:'fetch-one',networkRequestId:'network-one',method:'POST',url:origin+'/api/detail',bodySha256:sha256(JSON.stringify({value:expected.value})),nonceSha256:sha256('private-one')};delete (proof as Row).origin;delete (proof as Row).pageURL;
	const committed={stage:'committed',proof},preparation={id:proof.permissionExecutionId,browserNotBefore:100,observation:{document:detail}};
	const start={kind:'service-start',sequence:1,at:80,web:{detail:'Original detail'}},received={kind:'request-received',sequence:2,at:132,url:proof.url,bodySha256:proof.bodySha256,nonceSha256:proof.nonceSha256},outcome={kind:'detail-saved',sequence:3,at:133,proof,web:{detail:expected.value}};
	const epoch=(index:number,doc:Row,sessionId:string,closed:boolean,wrote=false)=>({index,document:doc,scope:scope(doc,sessionId),closed,requestProofs:wrote?[committed]:[],preparations:wrote?[preparation]:[]});
	const nav=[{id:'case10-call-2',stage:'revoked',at:105,document:form},{id:'case10-call-2',stage:'attached',at:111,before:form,document:detail},{id:'case10-call-9',stage:'revoked',at:139,document:detail},{id:'case10-call-9',stage:'attached',at:161,before:detail,document:reload}];
	const checkpoint=(phase:string,at:number,status:string):Row=>{
		const cancelled=phase==='cancelled',doc=cancelled?detail:reload;
		return structuredClone({id:10,phase,at,capturedAt:at+2,webTarget:expected.targetId,web:{detail:cancelled?'Original detail':expected.value},webEvents:cancelled?[start]:[start,received,outcome],
			page:{provider:'separate raw CDP read-only connection',target:expected.targetId,url:expected.url,at:at+1,document:{id:doc.id,loaderId:doc.loaderId,url:doc.url},detailStored:'Stored detail: '+(cancelled?'Original detail':expected.value),status,dialogs:[{open:cancelled,text:cancelled?'Edit detail':''}],fields:[{label:'Detail value',type:'text',value:expected.value}]},
			browserObserver:{targetId:expected.targetId,sessionId:'permanent-session',failure:null,dialog:null,frame:doc,clock,events:events.filter(row=>row.at<=at)},
			documentRequests:{targetId:expected.targetId,failure:null,active:null,transition:null,epochs:cancelled?[epoch(1,form,'request-form',true),epoch(2,detail,'request-detail',false)]:[epoch(1,form,'request-form',true),epoch(2,detail,'request-detail',true,true),epoch(3,reload,'request-reload',false)],navigations:cancelled?nav.slice(0,2):nav},
			...(phase==='complete'?{requestProofs:[committed]}:{})});
	};
	const cancelled=checkpoint('cancelled',122,'Confirmation cancelled'),refreshed=checkpoint('refreshed',170,'Ready'),escaped=checkpoint('escaped',180,'Edit cancelled'),end=checkpoint('complete',210,'Delayed page focus attempted');
	const calls:Row[]=[
		{id:2,tool:'web_act',at:105,end:112,args:{action:'click',id:'actual-detail-link'},result:{ok:true,details:{action:'click',dispatched:true,outcome:'unconfirmed'}},observedControls:[{action:'click',id:'actual-detail-link',name:'Detail'}]},
		{id:9,tool:'web_act',at:139,end:162,args:{steps:[{action:'back'},{action:'forward'},{action:'reload'}]},result:{ok:true,details:{dispatched:true,steps:['back','forward','reload'].map(action=>({action,dispatched:true,outcome:'unconfirmed'}))}},observedControls:['back','forward','reload'].map(action=>({action}))},
		{id:11,tool:'web_act',at:175,end:177,args:{action:'key',key:'Escape'},result:{ok:true,details:{action:'key',dispatched:true,outcome:'confirmed'}},observedControls:[{action:'key'}]},
		{id:12,tool:'web_act',at:190,end:195,args:{action:'click',id:'actual-focus-button'},result:{ok:true,details:{action:'click',dispatched:true,outcome:'unconfirmed'}},observedControls:[{action:'click',name:'Test delayed focus',id:'actual-focus-button'}]},
	];
	return{expected,input:{before:{detail:'Original detail'},cancelled,refreshed,escaped,end,calls}};
}
