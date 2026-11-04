import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,mkdtempSync,openSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {installedSwiftCompiler,installedMacSDK} from './acceptance/cold-prepare.ts';
import {officeSignalsLinkFlags} from './acceptance/office-signals-build.ts';

test('the actual office session waits for ownership and actual cleanup, including cancelled and late launch',{skip:process.platform!=='darwin',timeout:60_000},context=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});
	if(selected.status!==0){context.skip('No selected installed toolchain');return;}
	let compiler:string;try{compiler=installedSwiftCompiler(selected.stdout.trim());installedMacSDK(selected.stdout.trim());}catch{context.skip('No installed compiler/SDK; no installer is started');return;}
	const swift=join(dirname(compiler),'swift');if(!existsSync(swift)){context.skip('Installed Swift package driver is unavailable');return;}
	const root=mkdtempSync(join(tmpdir(),'mountains-office-session-tests-'));
	try{
		mkdirSync(join(root,'Sources'));mkdirSync(join(root,'Tests'));
		writeFileSync(join(root,'Package.swift'),'// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "OfficeTree", targets: [.target(name: "OfficeTree", path: "Sources"), .testTarget(name: "OfficeTreeTests", dependencies: ["OfficeTree"], path: "Tests")])\n');
		for(const name of ['ProcessIdentity.swift','OfficeSessionCore.swift'])writeFileSync(join(root,'Sources',name),readFileSync(new URL('./acceptance/native/'+name,import.meta.url)));
		writeFileSync(join(root,'Tests','OfficeSessionTests.swift'),readFileSync(new URL('./fixtures/office-session-tests.swift',import.meta.url)));
		const log=join(root,'swift-test.log'),fd=openSync(log,'wx',0o600);let result;
		try{result=spawnSync(swift,['test','--package-path',root,'--scratch-path',join(root,'build'),'--disable-sandbox','-Xswiftc','-warnings-as-errors'],{timeout:50000,killSignal:'SIGKILL',stdio:['ignore',fd,fd],env:{...process.env,DEVELOPER_DIR:selected.stdout.trim()}});}finally{closeSync(fd);}
		const output=readFileSync(log,'utf8');assert.equal(result.status,0,String(result.error??result.signal??'')+'\n'+output);
		assert.match(output,/Test run with 25 tests in 0 suites passed/);
		assert.match(output,/acceptedOrRefusedQuitWithoutActualExitDoesNotConfirmCleanup\(_:\) with 2 test cases passed/);
		assert.match(output,/unknownOrEditedDocumentCannotBeClosed\(_:\) with 2 test cases passed/);
		assert.match(output,/preludeCancellationOrDeadlineIsCheckedBeforeActualCreation\(_:\) with 2 test cases passed/);
	}finally{rmSync(root,{recursive:true,force:true});}
});
test('the real nonactivating Office guardian builds in Swift 6 without launching Preview',{skip:process.platform!=='darwin',timeout:30_000},context=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});
	if(selected.status!==0){context.skip('No installed selected toolchain');return;}
	let compiler:string,sdk:string;try{compiler=installedSwiftCompiler(selected.stdout.trim());sdk=installedMacSDK(selected.stdout.trim());}catch{context.skip('No installed compiler/SDK; no installer is started');return;}
	const root=mkdtempSync(join(tmpdir(),'mountains-office-guardian-build-'));
	try{
		const sources=['ProcessIdentity.swift','OfficeDocumentTree.swift','ReadOfficeWindows.swift','OfficeSessionCore.swift','OfficeSessionMain.swift'].map(name=>fileURLToPath(new URL('./acceptance/native/'+name,import.meta.url)));
		const binary=join(root,'Guardian'),build=spawnSync(compiler,['-sdk',sdk,'-swift-version','6','-warnings-as-errors','-parse-as-library','-D','OFFICE_SESSION',...officeSignalsLinkFlags(compiler,sdk,root),...sources,'-o',binary],{encoding:'utf8',timeout:20000,killSignal:'SIGKILL'});
		assert.equal(build.status,0,build.stdout+build.stderr);
		const invalid=spawnSync(binary,[],{encoding:'utf8',timeout:3000,killSignal:'SIGKILL'});assert.equal(invalid.status,2);assert.equal(invalid.stdout,'');
	}finally{rmSync(root,{recursive:true,force:true});}
});
test('the actual guardian consumes earlier pipe closure and received signals before any launch',{skip:process.platform!=='darwin',timeout:30_000},async context=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});
	if(selected.status!==0){context.skip('No installed selected toolchain');return;}
	let compiler:string,sdk:string;try{compiler=installedSwiftCompiler(selected.stdout.trim());sdk=installedMacSDK(selected.stdout.trim());}catch{context.skip('No installed compiler/SDK; no installer is started');return;}
	const root=mkdtempSync(join(tmpdir(),'mountains-office-control-tests-'));
	try{
		const main=readFileSync(new URL('./acceptance/native/OfficeSessionMain.swift',import.meta.url),'utf8');
		const start=main.indexOf('@MainActor\nprivate final class GuardianInput {'),end=main.indexOf('@MainActor\nprivate func applicationPort(');
		assert.ok(start>=0&&end>start,'actual control class boundaries changed');
		const error=main.match(/^private enum GuardianError: Error \{.*\}$/m);assert.ok(error);
		const source=join(root,'Control.swift'),binary=join(root,'Control');
		writeFileSync(source,'import Foundation\nimport Darwin\nimport Dispatch\n'+error[0]+'\n'+main.slice(start,end)+readFileSync(new URL('./fixtures/office-control-tests.swift',import.meta.url),'utf8'),{flag:'wx',mode:0o600});
		const actual=['ProcessIdentity.swift','OfficeSessionCore.swift'].map(name=>fileURLToPath(new URL('./acceptance/native/'+name,import.meta.url)));
		const build=spawnSync(compiler,['-sdk',sdk,'-swift-version','6','-warnings-as-errors','-parse-as-library',...officeSignalsLinkFlags(compiler,sdk,root),...actual,source,'-o',binary],{encoding:'utf8',timeout:15000,killSignal:'SIGKILL'});assert.equal(build.status,0,build.stdout+build.stderr);
		for(const input of ['', 'close\n', 'invalid\n', 'clos', 'close\ntrailing', 'close\nclose\n', 'x'.repeat(513)]){
			const result=spawnSync(binary,[],{input,encoding:'utf8',timeout:3000,killSignal:'SIGKILL'});assert.equal(result.status,0,result.stderr);
			const row=JSON.parse(result.stdout);assert.equal(row.created,false);assert.equal(row.closes,0);assert.equal(row.quits,0);assert.equal(row.outcome.cleanupConfirmed,true);assert.equal(row.outcome.readyPublished,false);assert.equal(row.outcome.owner,undefined);
			if(input==='close\n')assert.equal(row.outcome.problem,undefined);else assert.equal(typeof row.outcome.problem,'string');
		}
		for(const signal of ['SIGINT','SIGTERM'] as const){
			const child=spawn(binary,['signal-pending'],{stdio:['pipe','pipe','pipe']});let out='',err='',sent=false;
			child.stdin.on('error',()=>{});child.stderr.on('data',value=>err+=String(value));
			child.stdout.on('data',value=>{out+=String(value);if(!sent&&out.startsWith('INPUT_READY\n')){sent=child.kill(signal);}});
			const timer=setTimeout(()=>child.kill('SIGKILL'),4000);
			try{
				const ended=await new Promise<{code:number|null;signal:string|null}>((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});
				assert.deepEqual(ended,{code:0,signal:null},err);assert.equal(sent,true);assert.ok(out.startsWith('INPUT_READY\n'));
				const row=JSON.parse(out.slice('INPUT_READY\n'.length));assert.equal(row.created,false);assert.equal(row.closes,0);assert.equal(row.quits,0);
				assert.equal(row.receivedSignal,signal==='SIGINT'?2:15);assert.equal(row.outcome.cleanupConfirmed,true);assert.equal(row.outcome.readyPublished,false);assert.match(row.outcome.problem,/guardian signal/);
			}finally{clearTimeout(timer);child.stdin.destroy();}
		}
	}finally{rmSync(root,{recursive:true,force:true});}
});
