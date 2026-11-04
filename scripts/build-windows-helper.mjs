import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,renameSync,rmSync,mkdirSync,readdirSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
// Builds the read-only Windows helper with the .NET SDK (on any host; set DOTNET to its dotnet).
// Runtime users need no compiler: Windows 10/11 already has the .NET Framework 4.8 it runs on.
const repo=dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir=join(repo,'packages/computer/native/windows-helper');
const destination=join(repo,'packages/computer/native/win-anycpu');
const name='mountains-windows-helper.exe';
const temporary=mkdtempSync(join(tmpdir(),'mountains-windows-helper-'));
const shaBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=path=>shaBytes(readFileSync(path));
try{
 // Build from a snapshot, so a later edit cannot become the manifest of an earlier binary.
 const files=['Program.cs','windows-helper.csproj'],hashes={};
 mkdirSync(join(temporary,'src'));
 for(const file of files){const bytes=readFileSync(join(sourceDir,file));hashes[file]=shaBytes(bytes);writeFileSync(join(temporary,'src',file),bytes,{flag:'wx',mode:0o600});}
 const out=join(temporary,'out');
 const result=spawnSync(process.env.DOTNET||'dotnet',['build',join(temporary,'src','windows-helper.csproj'),'-c','Release','-o',out,'-nologo'],{encoding:'utf8',timeout:300000,env:{...process.env,DOTNET_NOLOGO:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1'}});
 if(result.status!==0)throw new Error(result.stdout+result.stderr||String(result.error));
 // One exe and nothing it would need beside it; the Windows Runtime and UI libraries are part of Windows.
 assert.deepEqual(readdirSync(out).sort(),[name],'the build produced files other than the helper exe');
 const binary=join(out,name);
 const info={format:1,sourceSha256:hashes['Program.cs'],projectSha256:hashes['windows-helper.csproj'],binarySha256:sha(binary),architectures:['arm64','x64'],framework:'net48'};
 for(const file of files)assert.equal(sha(join(sourceDir,file)),hashes[file],'Helper source changed during build; nothing was published.');
 writeFileSync(binary+'.json',JSON.stringify(info,null,2)+'\n',{flag:'wx',mode:0o600});
 mkdirSync(destination,{recursive:true});
 chmodSync(binary,0o644);chmodSync(binary+'.json',0o644);
 renameSync(binary,join(destination,name));renameSync(binary+'.json',join(destination,name+'.json'));
 process.stdout.write(`Built ${name} (${info.binarySha256.slice(0,12)}); no runtime compiler is needed.\n`);
}finally{rmSync(temporary,{recursive:true,force:true});}
