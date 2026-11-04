import type {CreationRecovery} from './account-journal.ts';
import {isDeepStrictEqual} from 'node:util';
import {writerProcessIdentity,writerState,type ProcessObservation} from './process-identity.ts';

export interface RecoveryWriterStatus{
 nonce:string;state:'alive'|'exited'|'unknown';
}
/** Read-only prerequisite, never a cleanup authorization or a rollback verdict.
 * A dead writer can have left a committed database object. The caller must
 * still reconcile the durable outcome and independently reread exact IDs.
 * No signals are delivered, including when a PID has been reused. */
export async function inspectRecoveryWriters(
 recovery:CreationRecovery,
 processes:{read(pid:number,signal?:AbortSignal):Promise<ProcessObservation>},
 signal?:AbortSignal
):Promise<{allWritersExited:boolean;writers:RecoveryWriterStatus[]}> {
 // Freeze nested birth records before the first asynchronous read. A provider
 // cannot mutate an expected start time into the process it happens to see now.
 const attempts=structuredClone(recovery.attempts),candidates=structuredClone(recovery.candidates),requiresReconciliation=recovery.needsIndependentReconciliation;
 const writers:RecoveryWriterStatus[]=[];
 for(const attempt of attempts){
  let state:RecoveryWriterStatus['state']='unknown';
  try{
   signal?.throwIfAborted();
   if(attempt.writer){const expected=writerProcessIdentity(attempt.writer),current=await processes.read(expected.pid,signal);signal?.throwIfAborted();state=writerState(expected,current);}
  }catch{ /* Missing evidence, cancellation and query errors all stay unknown. */ }
  writers.push({nonce:attempt.nonce,state});
 }
 // Historical records without a bound attempt must not become safe merely
 // because the list of independently queryable writers happens to be empty.
 const bound=requiresReconciliation===true&&new Set(attempts.map(attempt=>attempt.nonce)).size===attempts.length&&candidates.every(candidate=>candidate.attempt?.writer&&attempts.some(attempt=>isDeepStrictEqual(attempt,candidate.attempt)));
 return{allWritersExited:!signal?.aborted&&bound&&writers.every(writer=>writer.state==='exited'),writers};
}
