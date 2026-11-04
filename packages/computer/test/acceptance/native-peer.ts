import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import type {Socket} from 'node:net';
import {sha256} from './integrity.ts';
import {writerProcessIdentity} from './process-identity.ts';

export async function readNativePeer(binary:{path:string;sha256:string},socket:Socket){
	assert.equal(process.platform,'darwin');assert.equal(realpathSync(binary.path),binary.path);assert.ok(lstatSync(binary.path).isFile());assert.equal(sha256(readFileSync(binary.path)),binary.sha256);
	assert.ok(!socket.destroyed,'fixture stream is closed');
	const text=await new Promise<string>((yes,no)=>{
		const child=spawn(binary.path,[],{stdio:['ignore','pipe','pipe',socket]});let out='',error:Error|undefined,expired=false;
		const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},3000);
		child.stdout!.on('data',value=>{out+=value;if(out.length>8192){error=new Error('peer probe response too large');child.kill('SIGKILL');}});child.stderr!.resume();child.once('error',value=>{error=value;});
		child.once('close',(code,signal)=>{clearTimeout(timer);if(error||expired||code!==0||signal!==null)no(error??new Error('OS socket peer observation failed'));else yes(out);});
	});
	const row=JSON.parse(text) as Record<string,unknown>;assert.deepEqual(Object.keys(row).sort(),['executable','observation','pid']);
	assert.ok(Number.isSafeInteger(row.pid)&&Number(row.pid)>0&&typeof row.executable==='string'&&row.executable.startsWith('/'));
	const observation=row.observation as Record<string,unknown>;assert.equal(observation.status,'alive');assert.deepEqual(Object.keys(observation).sort(),['identity','status']);
	const birth=writerProcessIdentity(observation.identity);assert.equal(birth.pid,row.pid);
	return{pid:birth.pid,birth,executable:row.executable};
}
