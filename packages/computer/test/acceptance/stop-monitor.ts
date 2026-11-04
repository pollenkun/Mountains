import type {ChildProcess} from 'node:child_process';

/** EOF asks the exact child to write its final sample and flush its journal.
 * A forced stop is cleanup only and must never yield passing monitor evidence. */
export async function stopFocusMonitor(child:ChildProcess,timeoutMs=2000):Promise<void>{
	if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('invalid monitor shutdown timeout');
	if(!child.pid||child.exitCode!==null||child.signalCode!==null)throw new Error('focus monitor exited before shutdown was requested');
	await new Promise<void>((resolve,reject)=>{
		let forced=false;
		const timer=setTimeout(()=>{forced=true;child.kill('SIGKILL');},timeoutMs);
		const fail=(error:Error)=>{clearTimeout(timer);reject(error);};
		child.once('error',fail);
		child.once('close',(code,signal)=>{
			clearTimeout(timer);child.removeListener('error',fail);
			if(forced||code!==0||signal!==null)reject(new Error('focus monitor did not flush a final observation and exit normally'));
			else resolve();
		});
		if(!child.stdin||child.stdin.destroyed){forced=true;child.kill('SIGKILL');return;}
		// A broken pipe must still be followed through exact child close.
		child.stdin.once('error',()=>{forced=true;child.kill('SIGKILL');});
		child.stdin.end();
	});
}
