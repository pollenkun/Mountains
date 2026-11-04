import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
// Builds the Windows witness app (packages/computer/test/fixtures/windows-witness) that test/windows-live.ts operates,
// with the .NET SDK on any host (set DOTNET, DOTNET_CLI_HOME and NUGET_PACKAGES for an existing SDK/package cache).
// Offline only: no package sources, no NuGet audit, no SDK workload downloads. Missing packages are an error.
// The exe is a test tool and is never committed: it is built in a temporary folder and copied to the path you give.
//   node scripts/build-windows-witness.mjs <output.exe | output-folder>
const repo=dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir=join(repo,'packages/computer/test/fixtures/windows-witness');
const name='mountains-windows-witness.exe';
const target=process.argv[2]??process.env.MOUNTAINS_WINDOWS_WITNESS_OUT;
if(!target||process.argv.length>3){process.stderr.write('usage: node scripts/build-windows-witness.mjs <output.exe | output-folder>\n');process.exit(2);}
const asFolder=/[\\/]$/.test(target)||(existsSync(target)&&statSync(target).isDirectory());
const destination=asFolder?join(resolve(target),name):resolve(target);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const temporary=mkdtempSync(join(tmpdir(),'mountains-windows-witness-'));
try{
 // Build from a snapshot, so an edit during the build cannot end up half in the binary.
 const files=['Program.cs','windows-witness.csproj'];
 mkdirSync(join(temporary,'src'));
 const hashes={};
 for(const file of files){const bytes=readFileSync(join(sourceDir,file));hashes[file]=sha(bytes);writeFileSync(join(temporary,'src',file),bytes,{flag:'wx',mode:0o600});}
 const packages=resolve(process.env.NUGET_PACKAGES||join(homedir(),'.nuget','packages'));
 for(const packageName of ['microsoft.netframework.referenceassemblies','microsoft.netframework.referenceassemblies.net48']){
  assert.ok(existsSync(join(packages,packageName,'1.0.3',`${packageName}.1.0.3.nupkg`)),`offline package missing: ${packageName} 1.0.3 in ${packages}`);
 }
 const nuget=join(temporary,'NuGet.Config');
 writeFileSync(nuget,'<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear /></packageSources><auditSources><clear /></auditSources></configuration>\n');
 const out=join(temporary,'out');
 const result=spawnSync(process.env.DOTNET||'dotnet',['build',join(temporary,'src','windows-witness.csproj'),'-c','Release','-o',out,'-nologo',`-p:RestoreConfigFile=${nuget}`,'-p:NuGetAudit=false','-p:RestoreIgnoreFailedSources=false','-p:MSBuildEnableWorkloadResolver=false'],{encoding:'utf8',timeout:300000,env:{...process.env,NUGET_PACKAGES:packages,DOTNET_NOLOGO:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE:'true',MSBuildEnableWorkloadResolver:'false'}});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
 if(result.status!==0)throw new Error((result.stdout??'')+(result.stderr??'')||String(result.error));
 // One exe and nothing it would need beside it.
 assert.deepEqual(readdirSync(out).sort(),[name],'the build produced files other than the witness exe');
 for(const file of files)assert.equal(sha(readFileSync(join(sourceDir,file))),hashes[file],'Witness source changed during build; nothing was published.');
 const bytes=readFileSync(join(out,name));
 mkdirSync(dirname(destination),{recursive:true});
 // Copy beside the destination first, then rename, so a failed copy never leaves a half-written exe at the path.
 const partial=join(dirname(destination),`.${basename(destination)}.partial`);
 copyFileSync(join(out,name),partial);
 renameSync(partial,destination);
 writeFileSync(destination+'.json',JSON.stringify({format:1,sourceSha256:hashes['Program.cs'],projectSha256:hashes['windows-witness.csproj'],binarySha256:sha(bytes),framework:'net48',architectures:['arm64','x64'],offline:true},null,2)+'\n');
 process.stdout.write(`Built ${basename(destination)} -> ${destination}\n${bytes.length} bytes, sha256 ${sha(bytes)}\n`);
}finally{rmSync(temporary,{recursive:true,force:true});}
