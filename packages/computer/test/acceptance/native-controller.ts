import assert from 'node:assert/strict';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {createServer,type Socket} from 'node:net';
import {join} from 'node:path';

/** No UI commands use this stream. Its only messages are a one-time signing
 * key from the newly built app, and controller EOF to end that exact app. */
export async function signedNativeController(verifyPeer:(socket:Socket,pid:number)=>Promise<void>){
	const root=realpathSync(mkdtempSync('/tmp/mcu-signed-fixture-')),path=join(root,'controller.sock');
	let peer:Socket|undefined,key:Buffer|undefined,pid:number|undefined,failure:Error|undefined,closing:Promise<void>|undefined,observedPrefix='';
	let accept!:(value:{pid:number})=>void,reject!:(error:Error)=>void;
	const connected=new Promise<{pid:number}>((yes,no)=>{accept=yes;reject=no;});void connected.catch(()=>{});
	const fail=(error:Error)=>{failure??=error;reject(error);};
	const server=createServer(socket=>{
		if(peer||closing){socket.destroy();fail(new Error('unexpected second fixture connection'));return;}
		peer=socket;let bytes='',handshakeReceived=false;socket.setEncoding('utf8');socket.on('error',fail);
		socket.on('data',(data:string)=>{void(async()=>{
			let decoded:Buffer|undefined;
			try{
				assert.ok(!handshakeReceived,'fixture sent data after its one-time handshake');bytes+=data;assert.ok(bytes.length<=1024,'fixture handshake too large');
				const end=bytes.indexOf('\n');if(end<0)return;assert.equal(end,bytes.length-1,'fixture handshake contains trailing messages');
				const hello=JSON.parse(bytes) as {pid:number;key:string};assert.deepEqual(Object.keys(hello).sort(),['key','pid']);
				assert.ok(Number.isSafeInteger(hello.pid)&&hello.pid>0);assert.ok(typeof hello.key==='string');
				handshakeReceived=true;decoded=Buffer.from(hello.key,'base64');assert.equal(decoded.length,32);assert.equal(decoded.toString('base64'),hello.key);
				await verifyPeer(socket,hello.pid);assert.ok(!closing&&!failure&&!socket.destroyed,'fixture controller stopped during peer validation');
				key=decoded;decoded=undefined;pid=hello.pid;bytes='';accept({pid});
			}catch(error){decoded?.fill(0);fail(error instanceof Error?error:new Error(String(error)));socket.destroy();}
		})();});
		socket.once('end',()=>{if(!closing)fail(new Error('fixture lifetime stream ended unexpectedly'));});
	});
	try{await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(path,()=>{server.removeListener('error',no);yes();});});}
	catch(error){server.close();rmSync(root,{recursive:true,force:true});throw error;}
	server.on('error',fail);
	return{path,connected,verify(text:string):Record<string,unknown>[]{
		if(failure)throw failure;
		try{assert.ok(key&&pid,'fixture handshake is not complete');assert.ok(text.length<=50*1024*1024,'native journal too large');
		assert.ok(text.startsWith(observedPrefix),'previously observed native journal prefix was truncated or rewritten');
		assert.ok(text.endsWith('\n'),'native journal has an incomplete record');
		const rows=text.trimEnd().split('\n').map((line,index)=>{
			const row=JSON.parse(line) as Record<string,unknown>;assert.ok(row&&typeof row==='object'&&!Array.isArray(row));
			const {signedPayload,signature,...plain}=row;assert.ok(typeof signedPayload==='string'&&typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature),'missing native journal signature');
			const payload=Buffer.from(signedPayload,'base64');assert.equal(payload.toString('base64'),signedPayload);
			assert.deepEqual(JSON.parse(payload.toString('utf8')),plain,'native journal fields differ from the signed payload');
			assert.ok(timingSafeEqual(createHmac('sha256',key!).update(payload).digest(),Buffer.from(signature,'hex')),'native journal signature differs');
			assert.equal(plain.sequence,index+1,'native journal sequence differs');assert.equal(plain.pid,pid,'native journal process differs');return plain;
		});
		observedPrefix=text;return rows;
		}catch(error){failure=error instanceof Error?error:new Error(String(error));throw failure;}
	},forgetKey():void{key?.fill(0);key=undefined;},close():Promise<void>{
		return closing??=(async()=>{
			reject(new Error('fixture controller closed'));let timer:ReturnType<typeof setTimeout>|undefined,forced=false;
			try{
				await new Promise<void>((yes,no)=>{
					timer=setTimeout(()=>{forced=true;peer?.destroy();},2000);server.close(error=>error?no(error):yes());peer?.end();
				});
				assert.equal(forced,false,'fixture did not close after controller EOF');
			}finally{clearTimeout(timer);peer?.destroy();rmSync(root,{recursive:true,force:true});}
		})();
	}};
}
