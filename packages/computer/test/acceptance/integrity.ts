import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,readlinkSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';

export const sha256=(data:string|Uint8Array):string=>createHash('sha256').update(data).digest('hex');
export function frozenFiles(scopes:readonly string[]):Record<string,string>{
 const files:Record<string,string>={};
 const roots=scopes.map(path=>resolve(path)),visited=new Set<string>();
 const inside=(path:string)=>roots.some(root=>{const part=relative(root,path);return part===''||part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);});
 const visit=(path:string)=>{
  if(visited.has(path))return;visited.add(path);
  const info=lstatSync(path);
  if(info.isSymbolicLink()){
   const target=realpathSync(path);assert.ok(inside(target),'frozen symlink escapes its declared scopes: '+path);
   files[path]=sha256('symlink\0'+readlinkSync(path));visit(target);
  }else if(info.isDirectory())for(const name of readdirSync(path).sort())visit(join(path,name));
  else if(info.isFIFO())files[path]=sha256('fifo\0'+(info.mode&0o777));
  else{assert.ok(info.isFile(),'unexpected source file type: '+path);files[path]=sha256(readFileSync(path));}
 };
 for(const scope of scopes)visit(resolve(scope));
 return files;
}

export function duration(value:unknown,label:string):number{
 assert.ok(typeof value==='number'&&Number.isFinite(value)&&value>=0,label+' must be a finite, nonnegative duration');return value;
}
export function timedInterval(start:unknown,end:unknown,label:string):number{
 return duration(duration(end,label+' end')-duration(start,label+' start'),label+' elapsed');
}
export interface FrozenVersion{version?:number;root:string;scopes:string[];files:Record<string,string>;fixtures:Record<string,string>}
export function requiredFreezeScopes(repo:string,root:string):string[]{
 return ['packages','apps/cli','scripts','node_modules','package.json','package-lock.json','tsconfig.json'].map(name=>join(resolve(repo),name)).concat([join(resolve(root),'manifest.json'),join(resolve(root),'build')]);
}
export function checkFrozenVersion(path:string,expectedHash?:string,expected?:{repo:string;root:string}):{freeze:FrozenVersion;sha256:string}{
 const bytes=readFileSync(path),hash=sha256(bytes);
 if(expectedHash)assert.equal(hash,expectedHash,'freeze.json changed during this session');
 const freeze=JSON.parse(bytes.toString()) as FrozenVersion;
 if(expected){
  assert.equal(freeze.version,3,'unsupported source freeze format');assert.equal(freeze.root,resolve(expected.root),'freeze belongs to another run');
  assert.equal(resolve(path),join(resolve(expected.root),'evidence/freeze.json'),'freeze record is outside this run');
  assert.deepEqual([...freeze.scopes].sort(),requiredFreezeScopes(expected.repo,expected.root).sort(),'freeze omitted or replaced a required source/dependency scope');
 }
 assert.ok(Array.isArray(freeze.scopes)&&freeze.scopes.length,'missing frozen directory scopes');
 assert.deepEqual(frozenFiles(freeze.scopes),freeze.files,'source was added, deleted or changed after freezing');
 for(const [file,expected]of Object.entries(freeze.fixtures))assert.equal(sha256(readFileSync(file)),expected,'fixture changed after freezing: '+file);
 return{freeze,sha256:hash};
}

export function focusNotificationVerdict(record:Record<string,unknown>):'changed'|'unknown'|'unrelated'{
 if(record.kind!=='AX-notification')return 'unrelated';
 if(record.inSystemFocusedApplication===true)return 'changed';
 // The callback is delivered later. Its current keyboard PID cannot prove
 // that a brief transfer did not happen before restoration.
 return record.notification==='AXFocusedUIElementChanged'||record.notification==='AXFocusedWindowChanged'?'unknown':'unrelated';
}
