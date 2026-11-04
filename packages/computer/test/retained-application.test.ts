import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,mkdtempSync,openSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {installedSwiftCompiler,installedMacSDK} from './acceptance/cold-prepare.ts';

test('retained application candidate compiles its actual AppKit adapter and checks close behavior without launching applications',{skip:process.platform!=='darwin',timeout:60_000},context=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});
	if(selected.status!==0){context.skip('No selected installed toolchain');return;}
	let compiler:string;
	try{compiler=installedSwiftCompiler(selected.stdout.trim());installedMacSDK(selected.stdout.trim());}catch{context.skip('No installed compiler/SDK; no installer is started');return;}
	const swift=join(dirname(compiler),'swift');
	if(!existsSync(swift)){context.skip('Installed Swift package driver is unavailable');return;}
	const root=mkdtempSync(join(tmpdir(),'mountains-retained-application-tests-'));
	try{
		mkdirSync(join(root,'Sources'));mkdirSync(join(root,'Tests'));
		writeFileSync(join(root,'Package.swift'),'// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "RetainedApplication", targets: [.target(name: "RetainedApplication", path: "Sources"), .testTarget(name: "RetainedApplicationTests", dependencies: ["RetainedApplication"], path: "Tests")])\n');
		writeFileSync(join(root,'Sources','ProcessIdentity.swift'),readFileSync(new URL('./acceptance/native/ProcessIdentity.swift',import.meta.url)));
		writeFileSync(join(root,'Sources','RetainedApplication.swift'),readFileSync(new URL('../native/retained-application.swift',import.meta.url)));
		writeFileSync(join(root,'Tests','RetainedApplicationTests.swift'),readFileSync(new URL('./fixtures/retained-application-tests.swift',import.meta.url)));
		const log=join(root,'swift-test.log'),fd=openSync(log,'wx',0o600);let result;
		try{result=spawnSync(swift,['test','--package-path',root,'--scratch-path',join(root,'build'),'--disable-sandbox','-Xswiftc','-warnings-as-errors'],{timeout:50000,killSignal:'SIGKILL',stdio:['ignore',fd,fd],env:{...process.env,DEVELOPER_DIR:selected.stdout.trim()}});}finally{closeSync(fd);}
		const output=readFileSync(log,'utf8');
		assert.equal(result.status,0,String(result.error??result.signal??'')+'\n'+output);
		assert.match(output,/Test run with 22 tests in 0 suites passed/);
		assert.match(output,/closeDeadlineIncludesActualMainActorQueueDelay\(\) passed/);
		assert.match(output,/quitRequestAloneNeverProvesExit\(_:\) with 2 test cases passed/);
		assert.match(output,/OSAndAppKitDisagreementNeverGrantsSignalAuthority\(_:\) with 2 test cases passed/);
		assert.match(output,/failedRequestDoesNotSkipOriginalObjectCleanup\(_:\) with 2 test cases passed/);
		context.diagnostic('The actual Swift sources compiled; 22 Swift Testing functions passed. No application was launched.');
	}finally{rmSync(root,{recursive:true,force:true});}
});
