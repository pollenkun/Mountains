import {createInterface} from 'node:readline';
import type {Readable} from 'node:stream';

/** Interactive acceptance transport only. It retains EOF/cancellation before
 * next() is called; readline's late async iterator can miss an earlier close. */
export function controllerInput(stream:Readable,signal:AbortSignal,onLoss:(error:Error)=>void){
	let failure:Error|undefined,disposed=false,lateErrorReported=false,pending:{yes:(line:string)=>void;no:(error:Error)=>void}|undefined;
	const queue:string[]=[],lines=createInterface({input:stream,crlfDelay:Infinity});
	const cancel=(error:Error)=>{if(failure)return;failure=error;queue.length=0;pending?.no(error);pending=undefined;lines.close();stream.pause();};
	const lose=(error:Error)=>{if(disposed||failure)return;cancel(error);onLoss(error);};
	const ended=()=>lose(new Error('interactive controller input ended before completion'));
	const errored=()=>{
		if(disposed){if(!lateErrorReported){lateErrorReported=true;onLoss(new Error('interactive controller input failed during cleanup'));}return;}
		lose(new Error('interactive controller input failed'));
	};
	const aborted=()=>cancel(signal.reason instanceof Error?signal.reason:new Error('interactive controller cancelled'));
	lines.on('line',line=>{
		if(disposed||failure)return;
		if(Buffer.byteLength(line)>65536||queue.length>=16){lose(new Error('interactive controller input exceeded its bound'));return;}
		if(pending){const waiter=pending;pending=undefined;waiter.yes(line);}else queue.push(line);
	});
	lines.on('close',ended);lines.on('error',errored);stream.on('end',ended);stream.on('close',ended);stream.on('error',errored);signal.addEventListener('abort',aborted,{once:true});
	if(signal.aborted)aborted();else if(stream.readableEnded||stream.destroyed)ended();
	return{
		next():Promise<string>{
			if(failure)return Promise.reject(failure);if(disposed)return Promise.reject(new Error('interactive controller input is closed'));
			if(pending)return Promise.reject(new Error('interactive controller already awaits an input line'));
			const line=queue.shift();if(line!==undefined)return Promise.resolve(line);
			return new Promise<string>((yes,no)=>{pending={yes,no};});
		},
		cancel,
		close():void{if(disposed)return;disposed=true;cancel(new Error('interactive controller input is closed'));signal.removeEventListener('abort',aborted);stream.removeListener('end',ended);stream.removeListener('close',ended);
			// Keep one fixed error listener for this controller stream's lifetime.
			// A late TTY EIO must be recorded without crashing resource cleanup.
		},
	};
}
