import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {closeSync,existsSync,linkSync,mkdirSync,mkdtempSync,openSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ownedOfficeImage,parseOfficeWindowInventory} from './acceptance/office-window-proof.ts';
import {installedSwiftCompiler,installedMacSDK} from './acceptance/cold-prepare.ts';

const birth={schema:'macos-kinfo-starttime-v1' as const,pid:100,bootId:'12345678-1234-1234-1234-123456789abc',startSeconds:'1792300000',startMicroseconds:100};
function fixture(){
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-office-proof-')));mkdirSync(join(root,'workspace'));
	const image=join(root,'workspace','rotate.png');writeFileSync(image,'only our temporary image');
	const executable=realpathSync(process.execPath),observation={status:'alive',identity:birth};
	const owned={root,birth,executable,window:'w:45'},raw={schema:'macos-office-windows-v1',pid:100,executable,before:observation,after:observation,complete:true,cgWindowNumbers:[45],windows:[{number:45,role:'AXWindow',documentURL:pathToFileURL(image).href,edited:false}]};
	return{root,image,raw,owned,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('office binding uses exact process birth, real document path and current window; replacement file inode is permitted',()=>{
	const f=fixture();try{
		const actual=ownedOfficeImage(f.raw,f.owned);assert.equal(actual.window,'w:45');assert.equal(actual.file,f.image);assert.equal(actual.edited,false);
		const replacement=join(f.root,'workspace','replacement');writeFileSync(replacement,'rotated own image');renameSync(replacement,f.image);
		assert.equal(ownedOfficeImage(f.raw,f.owned).window,'w:45');
	}finally{f.cleanup();}
});
for(const scenario of ['missing document','wrong document','nonfile document','document query','document fragment','ambiguous number','replaced window','extra window','no windows','nonwindow role','unknown before','different after','reused pid','changed executable','incomplete','additional keys','invalid edited','invalid number','wrong pid','CG-only window','CG missing own window','repeated CG number','invalid CG number','missing CG list'] as const){
	test('office binding rejects '+scenario,()=>{
		const f=fixture();try{
			const raw=structuredClone(f.raw) as Record<string,any>;
			switch(scenario){
				case 'missing document':delete raw.windows[0].documentURL;break;
				case 'wrong document':raw.windows[0].documentURL=pathToFileURL(join(f.root,'another.png')).href;break;
				case 'nonfile document':raw.windows[0].documentURL='https://example.test/rotate.png';break;
				case 'document query':raw.windows[0].documentURL+='?other';break;
				case 'document fragment':raw.windows[0].documentURL+='#other';break;
				case 'ambiguous number':delete raw.windows[0].number;break;
				case 'replaced window':raw.windows[0].number=46;break;
				case 'extra window':raw.windows.push({...raw.windows[0]});break;
				case 'no windows':raw.windows=[];break;
				case 'nonwindow role':raw.windows[0].role='AXSheet';break;
				case 'unknown before':raw.before={status:'unknown',reason:'process-query-failed'};break;
				case 'different after':raw.after.identity.startMicroseconds++;break;
				case 'reused pid':raw.before.identity.startMicroseconds++;raw.after=structuredClone(raw.before);break;
				case 'changed executable':raw.executable='/some/other/Preview';break;
				case 'incomplete':raw.complete=false;break;
				case 'additional keys':raw.activeWindowOnly=true;break;
				case 'invalid edited':raw.windows[0].edited='false';break;
				case 'invalid number':raw.windows[0].number=-1;break;
				case 'wrong pid':raw.pid=101;break;
				case 'CG-only window':raw.cgWindowNumbers.push(46);break;
				case 'CG missing own window':raw.cgWindowNumbers=[];break;
				case 'repeated CG number':raw.cgWindowNumbers.push(45);break;
				case 'invalid CG number':raw.cgWindowNumbers=[-1];break;
				case 'missing CG list':delete raw.cgWindowNumbers;break;
			}
			assert.throws(()=>ownedOfficeImage(raw,f.owned));
		}finally{f.cleanup();}
	});
}
test('unreported AXEdited remains unknown, never silently converted into safe to close',()=>{
	const f=fixture();try{
		const raw=structuredClone(f.raw) as Record<string,any>;delete raw.windows[0].edited;
		assert.equal(parseOfficeWindowInventory(raw).windows[0]!.edited,null);
		assert.equal(ownedOfficeImage(raw,f.owned).edited,null);
	}finally{f.cleanup();}
});
test('office image cannot be a hard link to any other file',()=>{
	const f=fixture();try{linkSync(f.image,join(f.root,'outside.png'));assert.throws(()=>ownedOfficeImage(f.raw,f.owned),/hard link/);}finally{f.cleanup();}
});
for(const scenario of ['file link','workspace link','root link'] as const){
	test('office binding rejects '+scenario+' redirection',()=>{
		const f=fixture();try{
			if(scenario==='file link'){renameSync(f.image,join(f.root,'outside.png'));symlinkSync(join(f.root,'outside.png'),f.image);}
			if(scenario==='workspace link'){renameSync(join(f.root,'workspace'),join(f.root,'outside'));symlinkSync(join(f.root,'outside'),join(f.root,'workspace'));}
			const owned={...f.owned};if(scenario==='root link'){const alias=join(f.root,'alias');symlinkSync(f.root,alias);owned.root=alias;}
			assert.throws(()=>ownedOfficeImage(f.raw,owned));
		}finally{f.cleanup();}
	});
}
test('new independent office reader compiles in Swift 6 without launching any app',{skip:process.platform!=='darwin',timeout:30_000},context=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});
	if(selected.status!==0){context.skip('No installed selected toolchain; no installer is started');return;}
	let compiler:string,sdk:string;try{compiler=installedSwiftCompiler(selected.stdout.trim());sdk=installedMacSDK(selected.stdout.trim());}catch{context.skip('No installed compiler/SDK; no installer is started');return;}
	const root=mkdtempSync(join(tmpdir(),'mountains-office-reader-build-'));
	try{
		const source=(name:string)=>fileURLToPath(new URL('./acceptance/native/'+name,import.meta.url));
		const build=spawnSync(compiler,['-sdk',sdk,'-swift-version','6','-warnings-as-errors','-parse-as-library',source('ProcessIdentity.swift'),source('OfficeDocumentTree.swift'),source('ReadOfficeWindows.swift'),'-o',join(root,'Reader')],{encoding:'utf8',timeout:20000});
		assert.equal(build.status,0,build.stderr);assert.ok(existsSync(join(root,'Reader')));
		// Only argument validation runs. A valid PID/AX read would be a separate
		// explicitly monitored real-machine component, not a unit test.
		const invalid=spawnSync(join(root,'Reader'),[],{encoding:'utf8',timeout:3000});assert.equal(invalid.status,2);assert.equal(invalid.stdout,'');
	}finally{rmSync(root,{recursive:true,force:true});}
});
test('the actual office subtree algorithm rejects nested sheets, partial reads and truncation',{skip:process.platform!=='darwin',timeout:60_000},context=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});
	if(selected.status!==0){context.skip('No selected installed toolchain');return;}
	let compiler:string;try{compiler=installedSwiftCompiler(selected.stdout.trim());installedMacSDK(selected.stdout.trim());}catch{context.skip('No installed compiler/SDK; no installer is started');return;}
	const swift=join(dirname(compiler),'swift');if(!existsSync(swift)){context.skip('Installed Swift package driver is unavailable');return;}
	const root=mkdtempSync(join(tmpdir(),'mountains-office-tree-tests-'));
	try{
		mkdirSync(join(root,'Sources'));mkdirSync(join(root,'Tests'));
		writeFileSync(join(root,'Package.swift'),'// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "OfficeTree", targets: [.target(name: "OfficeTree", path: "Sources"), .testTarget(name: "OfficeTreeTests", dependencies: ["OfficeTree"], path: "Tests")])\n');
		writeFileSync(join(root,'Sources','OfficeDocumentTree.swift'),readFileSync(new URL('./acceptance/native/OfficeDocumentTree.swift',import.meta.url)));
		writeFileSync(join(root,'Tests','OfficeTreeTests.swift'),readFileSync(new URL('./fixtures/office-tree-tests.swift',import.meta.url)));
		// Local package only, no dependencies, network resolution, app launch or AX.
		// A compiler descendant must not keep a capture pipe open after the
		// package driver's deadline. Use one private regular log and a hard stop.
		const log=join(root,'swift-test.log'),fd=openSync(log,'wx',0o600);
		let run;try{run=spawnSync(swift,['test','--package-path',root,'--scratch-path',join(root,'build'),'--disable-sandbox','-Xswiftc','-warnings-as-errors'],{timeout:50000,killSignal:'SIGKILL',stdio:['ignore',fd,fd],env:{...process.env,DEVELOPER_DIR:selected.stdout.trim()}});}finally{closeSync(fd);}
		const output=readFileSync(log,'utf8');assert.equal(run.status,0,String(run.error??run.signal??'')+'\n'+output);
		// Swift Testing counts the parameterized function once and lists its
		// three inputs separately for each parameterized function.
		assert.match(output,/Test run with 13 tests in 0 suites passed/);
		assert.match(output,/nestedWindowIsNotAPlainDocument\(_:\) with 3 test cases passed/);
		assert.match(output,/declaredButUnreadableAttributeIsNotAnEmptyLeaf\(_:\) with 3 test cases passed/);
		assert.match(output,/sharedChildOrCycleIsNotACompleteTree\(_:\) with 2 test cases passed/);
	}finally{rmSync(root,{recursive:true,force:true});}
});
