import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,readFileSync,writeFileSync,renameSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
assert.equal(process.platform,'darwin','Build this release artifact on macOS; runtime users do not need a compiler.');
const repo=dirname(dirname(fileURLToPath(import.meta.url)));
const destination=join(repo,'packages/computer/native/darwin-universal');
const temporary=mkdtempSync(join(tmpdir(),'mountains-native-build-'));
const run=(command,args)=>{
 const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});
 if(result.status!==0)throw new Error(result.stderr||String(result.error));
};
const shaBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=path=>shaBytes(readFileSync(path));
try{
 // Both architectures compile identical captured bytes. A later source edit
 // cannot silently become the manifest for an earlier architecture's binary.
 // Pass names to rebuild only those artifacts; the others keep their published bytes.
 // topLevel sources use top-level code, not @main. swift5 sources keep the language mode they were written and tested in.
 const all=['capture','event-data','input-claim','launch-app','process-identity','window-server'],topLevel=['capture','event-data'],swift5=['capture'],chosen=process.argv.slice(2);
 for(const name of chosen)assert.ok(all.includes(name),`unknown native artifact ${name}`);
 const artifacts=(chosen.length?chosen:all).map(name=>{
  const source=join(repo,'packages/computer/native',name+'.swift');
  const bytes=readFileSync(source),snapshot=join(temporary,name+'.swift');
  writeFileSync(snapshot,bytes,{flag:'wx',mode:0o600});
  return {name,source,snapshot,sourceSha256:shaBytes(bytes),binary:join(temporary,name)};
 });
 for(const artifact of artifacts){
  const {name,snapshot,binary,sourceSha256}=artifact;
  for(const arch of ['arm64','x86_64'])run('swiftc',['-O',...(!topLevel.includes(name)?['-parse-as-library']:[]),'-swift-version',swift5.includes(name)?'5':'6','-warnings-as-errors','-target',arch+'-apple-macos13.0',snapshot,'-o',join(temporary,name+'.'+arch)]);
  run('lipo',['-create',join(temporary,name+'.arm64'),join(temporary,name+'.x86_64'),'-output',binary]);
  run('codesign',['--force','--sign','-',binary]);
  const info={format:1,sourceSha256,binarySha256:sha(binary),architectures:['arm64','x64'],minimumMacOS:'13.0'};
  writeFileSync(binary+'.json',JSON.stringify(info,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 for(const {source,sourceSha256} of artifacts)assert.equal(sha(source),sourceSha256,'Native source changed during build; no artifacts were published.');
 mkdirSync(destination,{recursive:true});
 for(const {name,binary} of artifacts){
  chmodSync(binary,0o755);chmodSync(binary+'.json',0o644);
  renameSync(binary,join(destination,name));renameSync(binary+'.json',join(destination,name+'.json'));
 }
 process.stdout.write(`Built universal macOS ${artifacts.map(a=>a.name).join(', ')}; no runtime compiler is needed.\n`);
}finally{rmSync(temporary,{recursive:true,force:true});}
