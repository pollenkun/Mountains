import assert from 'node:assert/strict';
import {test} from 'node:test';
import {POSIX_ONLY} from './fixtures/platform.ts';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createFreshRunDirectory,installedSwiftCompiler,installedMacSDK} from './acceptance/cold-prepare.ts';

test('cold preparation accepts only a fresh canonical child of the material base',()=>{
	const temporary=realpathSync(mkdtempSync(join(tmpdir(),'mountains-cold-prepare-')));
	try{
		const base=join(temporary,'materials');mkdirSync(base);
		const own=join(base,'run');assert.equal(createFreshRunDirectory(own,base),own);
		assert.throws(()=>createFreshRunDirectory(own,base),/EEXIST/);
		assert.throws(()=>createFreshRunDirectory('relative',base),/absolute/);
		const lookalike=join(temporary,'materials-escape');mkdirSync(lookalike);
		assert.throws(()=>createFreshRunDirectory(join(lookalike,'run'),base),/outside/);
		symlinkSync(lookalike,join(base,'redirect'));
		assert.throws(()=>createFreshRunDirectory(join(base,'redirect','run'),base),/outside/);
		mkdirSync(join(base,'nested'));symlinkSync(join(base,'nested'),join(base,'alias'));
		assert.throws(()=>createFreshRunDirectory(join(base,'alias','run'),base),/canonical/);
		assert.equal(existsSync(join(lookalike,'run')),false);assert.equal(existsSync(join(base,'nested','run')),false);
	}finally{rmSync(temporary,{recursive:true,force:true});}
});

test('compiler discovery uses installed executables and never falls back to the install shim',POSIX_ONLY,()=>{
	const temporary=realpathSync(mkdtempSync(join(tmpdir(),'mountains-installed-swift-')));
	try{
		assert.throws(()=>installedSwiftCompiler(temporary),/No installed Swift compiler/);
		const binary=join(temporary,'usr/bin');mkdirSync(binary,{recursive:true});writeFileSync(join(binary,'swift'),'not executed');chmodSync(join(binary,'swift'),0o700);symlinkSync('swift',join(binary,'swiftc'));
		assert.equal(installedSwiftCompiler(temporary),join(binary,'swiftc'));
		chmodSync(join(binary,'swift'),0o600);assert.throws(()=>installedSwiftCompiler(temporary),/No installed Swift compiler/);
	}finally{rmSync(temporary,{recursive:true,force:true});}
});

test('compiler discovery rejects links outside the selected developer directory',()=>{
	const temporary=realpathSync(mkdtempSync(join(tmpdir(),'mountains-external-swift-')));
	try{
		const developer=join(temporary,'developer'),binary=join(developer,'usr/bin');mkdirSync(binary,{recursive:true});
		const outside=join(temporary,'external-compiler');writeFileSync(outside,'not executed');chmodSync(outside,0o700);
		symlinkSync(outside,join(binary,'swiftc'));
		assert.throws(()=>installedSwiftCompiler(developer),/No installed Swift compiler/);
		rmSync(join(binary,'swiftc'));
		if(existsSync('/usr/bin/swiftc')){
			symlinkSync('/usr/bin/swiftc',join(binary,'swiftc'));
			assert.throws(()=>installedSwiftCompiler(developer),/No installed Swift compiler/);
		}
		assert.throws(()=>installedSwiftCompiler('/'),/No installed Swift compiler/);
	}finally{rmSync(temporary,{recursive:true,force:true});}
});

test('the installed swiftc alias actually compiles and runs a non-UI probe',{skip:process.platform!=='darwin',timeout:30000},()=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});assert.equal(selected.status,0);
	const compiler=installedSwiftCompiler(selected.stdout.trim()),sdk=installedMacSDK(selected.stdout.trim()),temporary=realpathSync(mkdtempSync(join(tmpdir(),'mountains-swift-alias-')));
	try{
		const source=join(temporary,'main.swift'),binary=join(temporary,'cold-probe');writeFileSync(source,'print("cold-compiler-ok")\n');
		const build=spawnSync(compiler,['-sdk',sdk,source,'-o',binary],{encoding:'utf8',timeout:20000});assert.equal(build.status,0,build.stderr);
		const run=spawnSync(binary,[],{encoding:'utf8',timeout:3000});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout,'cold-compiler-ok\n');
	}finally{rmSync(temporary,{recursive:true,force:true});}
});

test('SDK discovery refuses a missing SDK and links outside the selected developer directory',()=>{
	const temporary=realpathSync(mkdtempSync(join(tmpdir(),'mountains-swift-sdk-')));
	try{
		const developer=join(temporary,'developer');mkdirSync(join(developer,'SDKs'),{recursive:true});
		assert.throws(()=>installedMacSDK(developer),/No installed macOS SDK/);
		const outside=join(temporary,'outside-sdk');mkdirSync(outside);writeFileSync(join(outside,'SDKSettings.json'),'{}');symlinkSync(outside,join(developer,'SDKs/MacOSX.sdk'));
		assert.throws(()=>installedMacSDK(developer),/No installed macOS SDK/);
		rmSync(join(developer,'SDKs/MacOSX.sdk'));mkdirSync(join(developer,'SDKs/MacOSX.sdk'));writeFileSync(join(developer,'SDKs/MacOSX.sdk/SDKSettings.json'),'{}');assert.equal(installedMacSDK(developer),join(developer,'SDKs/MacOSX.sdk'));
	}finally{rmSync(temporary,{recursive:true,force:true});}
});
