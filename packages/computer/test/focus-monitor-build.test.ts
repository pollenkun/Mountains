import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

test('the independent focus monitor compiles with Swift 6 actor isolation and birth identity',{skip:process.platform!=='darwin',timeout:30_000},context=>{
	// Build only. Never run AppKit/AX, request permission, or launch an app.
	const selected=spawnSync('/usr/bin/xcode-select',['--print-path'],{encoding:'utf8',timeout:3000}),developer=selected.status===0?selected.stdout.trim():'';
	const compiler=developer?[join(developer,'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'),join(developer,'usr/bin/swiftc')].find(existsSync):undefined;
	const sdk=developer?[join(developer,'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'),join(developer,'SDKs/MacOSX.sdk')].find(existsSync):undefined;
	if(!compiler||!sdk){context.skip('Requires an already installed Swift compiler/SDK; no installer is started');return;}
	const root=mkdtempSync(join(tmpdir(),'mountains-focus-monitor-build-'));
	try{
		const source=(name:string)=>fileURLToPath(new URL('./acceptance/native/'+name,import.meta.url));
		const build=spawnSync(compiler,['-sdk',sdk,'-swift-version','6','-warnings-as-errors','-parse-as-library',...['ProcessIdentity.swift','FocusSubscriptions.swift','Monitor.swift'].map(source),'-o',join(root,'OwnMonitor')],{encoding:'utf8',timeout:20_000});
		assert.equal(build.status,0,build.stderr);assert.ok(existsSync(join(root,'OwnMonitor')));
	}finally{rmSync(root,{recursive:true,force:true});}
});
