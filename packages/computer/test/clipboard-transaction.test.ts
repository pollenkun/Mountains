import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../src/pointer-mac.ts',import.meta.url),'utf8');
const start=source.indexOf('const pasteboard = $.NSPasteboard.generalPasteboard;');
const end=source.indexOf('// Observe activation.',start);
assert.ok(start>0&&end>start);
const finishStart=source.indexOf('function finishHelper()'),finishEnd=source.indexOf('ObjC.registerSubclass',finishStart);assert.ok(finishStart>0&&finishEnd>finishStart);
interface Options{token?:string;markerCount?:number;count?:number;items?:string[][][];writeResult?:boolean;itemResult?:boolean;writeThrows?:boolean;userCopyDuringPreparation?:boolean;useSaved?:boolean}
function recoveryFixture({token='ours',markerCount=7,count=7,items=[],writeResult=true,itemResult=true,writeThrows=false,userCopyDuringPreparation=false,useSaved=false}:Options={}){
 let clears=0,writes=0,current:string[][][]=[[['public.utf8-plain-text',Buffer.from('temporary paste').toString('base64')]]],marker:string|null=JSON.stringify({token,changeCount:markerCount}),copied=false;
 const userItems=[[['public.utf8-plain-text',Buffer.from('new user copy').toString('base64')]]];
 const board={changeCount:count,stringForType:()=>marker===null?{isNil:()=>true}:{isNil:()=>false,js:marker},get clearContents(){clears++;current=[];marker=null;board.changeCount++;return board.changeCount;},writeObjects:(objects:{values:{values:string[][]}[]})=>{writes++;if(writeThrows)throw new Error('own injected write exception after clear');if(writeResult)current=objects.values.map(item=>item.values);return writeResult;}};
 const lifecycle:string[]=[];
 const dollar=Object.assign((v:unknown)=>v,{exit:(status:number)=>lifecycle.push('exit:'+status),NSPasteboard:{generalPasteboard:board},
  NSData:{alloc:{initWithBase64EncodedStringOptions:(data:string)=>Buffer.from(data,'base64')}},
  NSPasteboardItem:{alloc:{get init(){return{values:[] as string[][],setDataForType(data:Buffer,type:string){if(userCopyDuringPreparation&&!copied){copied=true;board.changeCount++;marker=null;current=userItems;}if(itemResult)this.values.push([type,data.toString('base64')]);return itemResult;}};}}},
  NSMutableArray:{get array(){return{values:[] as unknown[],get count(){return this.values.length;},addObject(value:unknown){this.values.push(value);}};}}});
 const api=runInNewContext(source.slice(start,end)+source.slice(finishStart,finishEnd)+';({restore:clipRestore,finish:finishHelper,prime(items,count){saved=items;savedCount=count;savedToken="ours";},hasSaved:()=>saved!==null,failed:()=>clipRestoreFailure!==null})',{$:dollar,pendingCommand:null,guard:{ownFile:true},inputKeys:[],inputKeyReleaseFailed:false,inputButtons:[],inputButtonReleaseFailed:false,finishGuard:()=>{lifecycle.push('focus');return {restored:true,byUser:false,attributionUnknown:false};}}) as{restore:(c:unknown)=>{restored:boolean;userChanged:boolean};finish:()=>void;prime:(items:unknown,count:number)=>void;hasSaved:()=>boolean;failed:()=>boolean};
 if(useSaved)api.prime(items.map(item=>item.map(([type,data])=>[type,Buffer.from(data!,'base64')])),count);
 return{restore:()=>api.restore(useSaved?undefined:{items,token:'ours'}),finish:api.finish,lifecycle,hasSaved:api.hasSaved,failed:api.failed,get clears(){return clears;},get writes(){return writes;},get items(){return current;}};
}
function recovery(options:Options={}){const f=recoveryFixture(options),result=f.restore();return{result,get clears(){return f.clears;},get items(){return f.items;}};}
const original=[[['public.utf8-plain-text',Buffer.from('Original 中文').toString('base64')],['public.html',Buffer.from('<b>Original 中文</b>').toString('base64')]],[['public.png',Buffer.from([0,255,10,23,0]).toString('base64')]]];

test('a lost clipboard acknowledgement can recover through the ownership marker',()=>{const f=recovery();assert.equal(f.result.restored,true);assert.equal(f.clears,1);});
test('a newer user clipboard is preserved even when it carries an old marker',()=>{const f=recovery({count:8});assert.equal(f.result.restored,false);assert.equal(f.result.userChanged,true);assert.equal(f.clears,0);});
test('a different clipboard owner is never restored over',()=>{const f=recovery({token:'user'});assert.equal(f.result.restored,false);assert.equal(f.clears,0);});
test('clipboard recovery restores every original representation instead of merely clearing',()=>{const f=recovery({items:original});assert.equal(f.result.restored,true);assert.deepEqual(f.items,original);assert.ok(f.items.length>0);});

for(const fault of [{writeResult:false},{writeThrows:true}])test('a failed post-clear write stays unknown and cannot be washed clean by the next restoration: '+JSON.stringify(fault),()=>{
 const f=recoveryFixture({...fault,items:original,useSaved:true});let first:unknown;
 assert.throws(()=>f.restore(),error=>{first=error;return true;});assert.equal(f.failed(),true);assert.equal(f.hasSaved(),true);assert.equal(f.clears,1);assert.equal(f.writes,1);assert.deepEqual(f.items,[]);
 assert.throws(()=>f.restore(),error=>error===first);assert.equal(f.hasSaved(),true);assert.equal(f.clears,1);assert.equal(f.writes,1);
});
test('a failed original representation is detected before clearing and keeps the saved items',()=>{const f=recoveryFixture({items:original,itemResult:false,useSaved:true});assert.throws(()=>f.restore(),/representation could not be prepared/);assert.equal(f.clears,0);assert.equal(f.writes,0);assert.equal(f.hasSaved(),true);assert.equal(f.failed(),true);});
test('a user copy made while original representations are prepared is checked again before clear',()=>{const f=recoveryFixture({items:original,userCopyDuringPreparation:true,useSaved:true});assert.equal(f.restore().userChanged,true);assert.equal(f.clears,0);assert.equal(f.writes,0);assert.equal(f.hasSaved(),false);assert.equal(f.failed(),false);assert.equal(Buffer.from(f.items[0]![0]![1]!,'base64').toString(),'new user copy');});

for(const fault of [{writeResult:false},{writeThrows:true},{itemResult:false}])test('production EOF still attempts focus and cannot erase a failed clipboard restoration: '+JSON.stringify(fault),()=>{const f=recoveryFixture({...fault,items:original,useSaved:true});assert.throws(()=>f.restore());const clears=f.clears,writes=f.writes;f.finish();assert.deepEqual(f.lifecycle,['focus','exit:1']);assert.equal(f.hasSaved(),true);assert.equal(f.failed(),true);assert.equal(f.clears,clears);assert.equal(f.writes,writes);});
