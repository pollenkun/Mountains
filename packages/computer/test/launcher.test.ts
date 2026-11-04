import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,mkdtempSync,openSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {installedSwiftCompiler,installedMacSDK} from './acceptance/cold-prepare.ts';

test('launcher rejects unsafe Chromium startup and counts observed returns without launching applications',{skip:process.platform!=='darwin',timeout:120_000},context=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});
	if(selected.status!==0){context.skip('No selected installed toolchain');return;}
	let compiler:string;
	try{compiler=installedSwiftCompiler(selected.stdout.trim());installedMacSDK(selected.stdout.trim());}catch{context.skip('No installed compiler/SDK; no installer is started');return;}
	const swift=join(dirname(compiler),'swift');
	if(!existsSync(swift)){context.skip('Installed Swift package driver is unavailable');return;}
	const root=mkdtempSync(join(tmpdir(),'mountains-launcher-tests-'));
	try{
		mkdirSync(join(root,'Sources'));mkdirSync(join(root,'Tests'));
		writeFileSync(join(root,'Package.swift'),'// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Launcher", targets: [.target(name: "Launcher", path: "Sources", swiftSettings: [.define("LAUNCH_APP_TEST")]), .testTarget(name: "LauncherTests", dependencies: ["Launcher"], path: "Tests")])\n');
		writeFileSync(join(root,'Sources','LaunchApp.swift'),readFileSync(new URL('../native/launch-app.swift',import.meta.url)));
		writeFileSync(join(root,'Tests','LauncherTests.swift'),readFileSync(new URL('./fixtures/launcher-tests.swift',import.meta.url)));
		const log=join(root,'swift-test.log'),fd=openSync(log,'wx',0o600);let result;
		try{result=spawnSync(swift,['test','--package-path',root,'--scratch-path',join(root,'build'),'--disable-sandbox','-Xswiftc','-warnings-as-errors'],{timeout:100000,killSignal:'SIGKILL',stdio:['ignore',fd,fd],env:{...process.env,DEVELOPER_DIR:selected.stdout.trim()}});}finally{closeSync(fd);}
		const output=readFileSync(log,'utf8');
		assert.equal(result.status,0,String(result.error??result.signal??'')+'\n'+output);
		assert.match(output,/Test run with 25 tests in 0 suites passed/);
		assert.match(output,/preflightRefusalExplicitlyReportsNoLaunchWasDispatched\(\) passed/);
		assert.match(output,/activationRequestAloneNeverCountsAsReturn\(\) passed/);
		assert.match(output,/userInputBeforeLaunchCallbackAlsoCancelsRestoration\(\) passed/);
		assert.match(output,/thirdAppSeenBeforeCallbackIsNotForgottenWhenChromeTakesOver\(\) passed/);
		context.diagnostic('The actual Swift source compiled; 25 Swift Testing functions passed, including parameterized Chromium preflight checks. No application was launched.');
	}finally{rmSync(root,{recursive:true,force:true});}
});
