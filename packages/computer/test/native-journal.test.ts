import assert from 'node:assert/strict';
import {test} from 'node:test';
import {POSIX_ONLY} from './fixtures/platform.ts';
import {connect} from 'node:net';
import {createHmac,randomBytes} from 'node:crypto';
import {signedNativeController} from './acceptance/native-controller.ts';

test('native controller verifies signed exact process/sequence and rejects edited evidence',POSIX_ONLY,async()=>{
	const controller=await signedNativeController(async()=>{}),key=randomBytes(32),socket=connect(controller.path);socket.on('error',()=>{});socket.resume();socket.on('end',()=>socket.end());
	try{
		socket.write(JSON.stringify({pid:1234,key:key.toString('base64')})+'\n');assert.deepEqual(await controller.connected,{pid:1234});
		const sign=(row:Record<string,unknown>)=>{const payload=Buffer.from(JSON.stringify(row));return JSON.stringify({...row,signedPayload:payload.toString('base64'),signature:createHmac('sha256',key).update(payload).digest('hex')})+'\n';};
		const row={pid:1234,sequence:1,kind:'saved',tag:'case01'},valid=sign(row);assert.deepEqual(controller.verify(valid),[row]);
		assert.throws(()=>controller.verify(valid.replace('case01','case02')),/prefix.*rewritten/);
		assert.throws(()=>controller.verify(valid),/prefix.*rewritten/,'a rejected journal must never become trusted again');
	}finally{await controller.close();socket.destroy();key.fill(0);}
});

test('native journal cannot remove an already verified complete tail record',POSIX_ONLY,async()=>{
	const controller=await signedNativeController(async()=>{}),key=randomBytes(32),socket=connect(controller.path);socket.on('error',()=>{});socket.resume();socket.on('end',()=>socket.end());
	try{
		socket.write(JSON.stringify({pid:1234,key:key.toString('base64')})+'\n');await controller.connected;
		const sign=(sequence:number)=>{const row={pid:1234,sequence,kind:'state'},payload=Buffer.from(JSON.stringify(row));return JSON.stringify({...row,signedPayload:payload.toString('base64'),signature:createHmac('sha256',key).update(payload).digest('hex')})+'\n';};
		const first=sign(1),both=first+sign(2);assert.equal(controller.verify(first).length,1);assert.equal(controller.verify(both).length,2);
		assert.throws(()=>controller.verify(first),/prefix.*truncated/);assert.throws(()=>controller.verify(both),/prefix.*truncated/);
	}finally{await controller.close();controller.forgetKey();socket.destroy();key.fill(0);}
});

test('unsigned, wrong-process, replayed, incomplete and incorrectly signed initial logs fail',POSIX_ONLY,async()=>{
	for(const bad of ['unsigned','process','sequence','replayed','incomplete','signature']){
		const controller=await signedNativeController(async()=>{}),key=randomBytes(32),socket=connect(controller.path);socket.on('error',()=>{});socket.resume();socket.on('end',()=>socket.end());
		try{
			socket.write(JSON.stringify({pid:1234,key:key.toString('base64')})+'\n');await controller.connected;
			const row={pid:bad==='process'?1235:1234,sequence:bad==='sequence'?2:1,kind:'state'},payload=Buffer.from(JSON.stringify(row));
			const signed=JSON.stringify({...row,signedPayload:payload.toString('base64'),signature:(bad==='signature'?Buffer.alloc(32):createHmac('sha256',key).update(payload).digest()).toString('hex')})+'\n';
			const text=bad==='unsigned'?JSON.stringify(row)+'\n':bad==='replayed'?signed+signed:bad==='incomplete'?signed.trimEnd():signed;
			assert.throws(()=>controller.verify(text));assert.throws(()=>controller.verify(signed),'verification failure is sticky');
		}finally{await controller.close();controller.forgetKey();socket.destroy();key.fill(0);}
	}
});

test('an extra handshake invalidates a native controller instead of replacing its in-memory key',POSIX_ONLY,async()=>{
	const controller=await signedNativeController(async()=>{}),key=randomBytes(32),socket=connect(controller.path);socket.on('error',()=>{});socket.resume();
	try{
		socket.write(JSON.stringify({pid:1234,key:key.toString('base64')})+'\n');await controller.connected;
		socket.write('{}\n');await new Promise<void>(resolve=>socket.once('close',()=>resolve()));assert.throws(()=>controller.verify('\n'),/one-time handshake/);
	}finally{await controller.close();socket.destroy();key.fill(0);}
});
