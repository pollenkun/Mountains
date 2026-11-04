import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {connect} from 'node:net';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installedSwiftCompiler,installedMacSDK} from './acceptance/cold-prepare.ts';
import {signedNativeController} from './acceptance/native-controller.ts';
import {readNativePeer} from './acceptance/native-peer.ts';
import {sha256} from './acceptance/integrity.ts';

test('the OS socket probe identifies its actual peer and rejects a forged handshake PID',{skip:process.platform!=='darwin',timeout:30000},async()=>{
	const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});assert.equal(selected.status,0);
	const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-native-peer-'))),path=join(root,'ReadFixturePeer');
	try{
		const source=(name:string)=>fileURLToPath(new URL('./acceptance/native/'+name,import.meta.url));
		const build=spawnSync(installedSwiftCompiler(selected.stdout.trim()),['-sdk',installedMacSDK(selected.stdout.trim()),'-swift-version','6','-warnings-as-errors','-parse-as-library',source('ProcessIdentity.swift'),source('ReadFixturePeer.swift'),'-o',path],{encoding:'utf8',timeout:20000});assert.equal(build.status,0,build.stderr);
		const binary={path,sha256:sha256(readFileSync(path))};
		for(const forged of [false,true]){
			let observed=false;const controller=await signedNativeController(async(socket,pid)=>{
				const actual=await readNativePeer(binary,socket);observed=true;assert.equal(actual.pid,process.pid);assert.equal(actual.executable,realpathSync(process.execPath));assert.equal(pid,actual.pid,'forged handshake PID');
			}),socket=connect(controller.path);socket.on('error',()=>{});socket.resume();socket.on('end',()=>socket.end());
			try{
				socket.write(JSON.stringify({pid:forged?process.pid+1:process.pid,key:randomBytes(32).toString('base64')})+'\n');
				if(forged)await assert.rejects(controller.connected,/forged handshake PID/);else assert.deepEqual(await controller.connected,{pid:process.pid});assert.equal(observed,true);
			}finally{await controller.close();controller.forgetKey();socket.destroy();}
		}
	}finally{rmSync(root,{recursive:true,force:true});}
});
