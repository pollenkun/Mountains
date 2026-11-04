import assert from 'node:assert/strict';
import {test,describe} from 'node:test';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync,chmodSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {AccountCreationJournal,createAccountFingerprintKey,loadAccountFingerprintKey,recoverAccountCreations} from './acceptance/account-journal.ts';
import type {ContainerAttempt} from './acceptance/container-outcome.ts';
import type {WriterProcessIdentity} from './acceptance/process-identity.ts';

const staged={id:'fresh-list-id',sourceId:'local-source-id',parentId:null,kind:'container' as const,fingerprint:'a'.repeat(64)};
describe('private Unix account preparation journal',{skip:process.platform==='win32'},()=>{
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-account-journal-'))),workspace=join(root,'workspace'),directory=join(root,'controller-private');mkdirSync(workspace,{mode:0o700});mkdirSync(directory,{mode:0o700});
 const key=createAccountFingerprintKey(directory,workspace),identity={runId:'frozen-run',sourceId:staged.sourceId,workspace,originalIds:['original-user-list'],fingerprintKeySha256:key.sha256};
 return{root,directory,workspace,key,identity,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('a durable grant preserves the exact candidate after a lost commit reply, never claiming it was absent',()=>{
 const f=fixture(),journal=AccountCreationJournal.create(f.directory,f.identity);
 try{
  const id=journal.stage(staged);assert.deepEqual(recoverAccountCreations(journal.file,f.identity).candidates,[]);
  journal.allowCommit(id);assert.deepEqual(recoverAccountCreations(journal.file,f.identity).candidates,[{requestId:id,record:staged,outcome:'unknown'}]);
  assert.throws(()=>journal.notCommitted(id),/granted write/);
  assert.throws(()=>journal.committed(id,{...staged,id:'different-id'}),/differ/);
  assert.equal(recoverAccountCreations(journal.file,f.identity).candidates[0]!.outcome,'unknown');
  journal.committed(id,staged);assert.equal(recoverAccountCreations(journal.file,f.identity).candidates[0]!.outcome,'committed');
 }finally{journal.close();f.cleanup();}
});
test('pre-existing IDs, another source, duplicate grants and changed initial fields cannot confer ownership',()=>{
 const f=fixture(),journal=AccountCreationJournal.create(f.directory,f.identity);
 try{
  assert.throws(()=>journal.stage({...staged,id:f.identity.originalIds[0]!}),/present before/);
  assert.throws(()=>journal.stage({...staged,sourceId:'icloud'}),/another account/);
  const input={...staged},id=journal.stage(input);input.fingerprint='b'.repeat(64);
  assert.throws(()=>journal.stage(staged),/another creation/);journal.allowCommit(id);
  assert.throws(()=>journal.allowCommit(id),/already granted/);assert.throws(()=>journal.committed(id,input),/fields differ/);
  journal.committed(id,staged);
 }finally{journal.close();f.cleanup();}
});
test('an ungranted staged operation can be cancelled, and close cannot issue a late commit',()=>{
 const f=fixture(),journal=AccountCreationJournal.create(f.directory,f.identity);
 try{const id=journal.stage(staged);journal.notCommitted(id);assert.throws(()=>journal.allowCommit(id));assert.deepEqual(recoverAccountCreations(journal.file,f.identity).candidates,[]);journal.close();assert.throws(()=>journal.stage({...staged,id:'late'}),/closed/);}
 finally{journal.close();f.cleanup();}
});
test('a truncated or modified journal and a different frozen run never recover as empty success',()=>{
 const f=fixture(),journal=AccountCreationJournal.create(f.directory,f.identity);
 try{
  journal.allowCommit(journal.stage(staged));const original=readFileSync(journal.file,'utf8');journal.close();
  for(const bytes of [original.slice(0,-1),original+'{',original.replace('fresh-list-id','original-user-list')]){
   writeFileSync(journal.file,bytes);assert.throws(()=>recoverAccountCreations(journal.file,f.identity),/incomplete or invalid/);
  }
  writeFileSync(journal.file,original);assert.throws(()=>recoverAccountCreations(journal.file,{...f.identity,runId:'another-run'}),/incomplete or invalid/);
  assert.throws(()=>recoverAccountCreations(journal.file,{...f.identity,fingerprintKeySha256:'0'.repeat(64)}),/incomplete or invalid/);
 }finally{journal.close();f.cleanup();}
});
test('the original fingerprint key survives process loss and a changed or missing key is never regenerated',()=>{
 const f=fixture();try{
  assert.deepEqual(Buffer.from(loadAccountFingerprintKey(f.directory,f.workspace,f.key.sha256)),Buffer.from(f.key.key));
  assert.throws(()=>createAccountFingerprintKey(f.directory,f.workspace),/EEXIST/);
  const path=join(f.directory,'account-fingerprint.key');writeFileSync(path,Buffer.alloc(32));assert.throws(()=>loadAccountFingerprintKey(f.directory,f.workspace,f.key.sha256),/unavailable or changed/);
  unlinkSync(path);assert.throws(()=>loadAccountFingerprintKey(f.directory,f.workspace,f.key.sha256),/unavailable or changed/);
 }finally{f.cleanup();}
});
test('account keys cannot be placed in the model workspace and existing or linked logs are not overwritten',()=>{
 const f=fixture();try{
  assert.throws(()=>createAccountFingerprintKey(f.workspace,f.workspace),/outside/);
  const target=join(f.directory,'unrelated.txt');writeFileSync(target,'keep',{mode:0o600});symlinkSync(target,join(f.directory,'account-creations.jsonl'));
  assert.throws(()=>AccountCreationJournal.create(f.directory,f.identity),/EEXIST/);assert.equal(readFileSync(target,'utf8'),'keep');
  unlinkSync(join(f.directory,'account-creations.jsonl'));chmodSync(f.directory,0o755);assert.throws(()=>AccountCreationJournal.create(f.directory,f.identity),/private/);
 }finally{f.cleanup();}
});
test('a real controller crash keeps its exact granted ID and original key for later inspection',async()=>{
 const f=fixture(),module=new URL('./acceptance/account-journal.ts',import.meta.url).href;
 const code=`import {AccountCreationJournal} from ${JSON.stringify(module)};import {writeFileSync} from 'node:fs';const [dir,identity,record]=process.argv.slice(1);const journal=AccountCreationJournal.create(dir,JSON.parse(identity)),value=JSON.parse(record);journal.allowCommit(journal.stage(value));writeFileSync(dir+'/fake-store.json',JSON.stringify(value));process.stdout.write('commit-reply-lost\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,f.directory,JSON.stringify(f.identity),JSON.stringify(staged)],{stdio:['ignore','pipe','pipe']});
 try{
  const ready=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('fake controller exited before its durable grant');})]);assert.match(String(ready[0]),/commit-reply-lost/);
  child.kill('SIGKILL');await once(child,'close');
  const recovered=recoverAccountCreations(join(f.directory,'account-creations.jsonl'),f.identity);assert.equal(recovered.candidates[0]!.record.id,staged.id);assert.equal(recovered.candidates[0]!.outcome,'unknown');
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'fake-store.json'),'utf8')),staged);assert.deepEqual(Buffer.from(loadAccountFingerprintKey(f.directory,f.workspace,f.key.sha256)),Buffer.from(f.key.key));
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}f.cleanup();}
});
test('truncating whole valid journal records is detected by its separately synced high-water file',()=>{
 const f=fixture(),journal=AccountCreationJournal.create(f.directory,f.identity);
 try{
  journal.allowCommit(journal.stage(staged));journal.close();const original=readFileSync(journal.file,'utf8'),rows=original.trimEnd().split('\n');
  for(const count of [1,2]){writeFileSync(journal.file,rows.slice(0,count).join('\n')+'\n');assert.throws(()=>recoverAccountCreations(journal.file,f.identity),/incomplete or invalid/);}
  writeFileSync(journal.file,original);const head=join(f.directory,'account-creations.head.jsonl');writeFileSync(head,readFileSync(head,'utf8').split('\n').slice(0,1).join('\n')+'\n');assert.throws(()=>recoverAccountCreations(journal.file,f.identity),/incomplete or invalid/);
 }finally{journal.close();f.cleanup();}
});
test('even an empty candidate list explicitly requires native-outcome and independent-data reconciliation',()=>{
 const f=fixture(),journal=AccountCreationJournal.create(f.directory,f.identity);
 try{const recovery=recoverAccountCreations(journal.file,f.identity);assert.deepEqual(recovery.candidates,[]);assert.equal(recovery.needsIndependentReconciliation,true);}
 finally{journal.close();f.cleanup();}
});
test('a native writer birth is bound once and synced before staging, with no mutable identity aliases',()=>{
 const f=fixture(),journal=AccountCreationJournal.create(f.directory,f.identity);
 const attempt:ContainerAttempt={nonce:'11111111-1111-1111-1111-111111111111',writerPath:'/test/writer',writerSha256:'a'.repeat(64),requestSha256:'b'.repeat(64),outcomeDevice:'1',outcomeInode:'2'};
 const birth:WriterProcessIdentity={schema:'macos-kinfo-starttime-v1',pid:12345,bootId:'01234567-89ab-cdef-0123-456789abcdef',startSeconds:'1790000000',startMicroseconds:123456};
 try{
  assert.throws(()=>journal.registerAttempt({...attempt,writer:birth}),/after spawn/);
  journal.registerAttempt(attempt);assert.throws(()=>journal.stage(staged,attempt),/before staging/);
  const proof=journal.bindWriter(attempt.nonce,birth),expected=structuredClone(proof);birth.startMicroseconds=654321;proof.writer!.startMicroseconds=654321;
  assert.throws(()=>journal.bindWriter(attempt.nonce,birth),/already bound/);assert.throws(()=>journal.stage(staged,proof),/binding changed/);
  const requestId=journal.stage(staged,expected);journal.allowCommit(requestId);
  const recovered=recoverAccountCreations(journal.file,f.identity);assert.deepEqual(recovered.attempts,[expected]);assert.deepEqual(recovered.candidates[0]!.attempt,expected);
  recovered.attempts[0]!.writer!.startMicroseconds=999999;assert.equal(recovered.candidates[0]!.attempt!.writer!.startMicroseconds,123456);
  assert.equal(recoverAccountCreations(journal.file,f.identity).attempts[0]!.writer!.startMicroseconds,123456);
  const second={...attempt,nonce:'22222222-2222-2222-2222-222222222222'};journal.registerAttempt(second);const next=journal.bindWriter(second.nonce,{...birth,pid:12346});
  journal.allowCommit(journal.stage({...staged,id:'second-test-list'},next));assert.equal(recoverAccountCreations(journal.file,f.identity).candidates.length,2);
 }finally{journal.close();f.cleanup();}
});
test('writer binding failure cannot authorize staging or send a grant after the journal closes',()=>{
 const f=fixture(),journal=AccountCreationJournal.create(f.directory,f.identity);
 const attempt:ContainerAttempt={nonce:'11111111-1111-1111-1111-111111111111',writerPath:'/test/writer',writerSha256:'a'.repeat(64),requestSha256:'b'.repeat(64),outcomeDevice:'1',outcomeInode:'2'};
 try{
  journal.registerAttempt(attempt);journal.close();
  assert.throws(()=>journal.bindWriter(attempt.nonce,{schema:'macos-kinfo-starttime-v1',pid:12345,bootId:'01234567-89ab-cdef-0123-456789abcdef',startSeconds:'1790000000',startMicroseconds:123456}),/closed/);
  assert.equal(recoverAccountCreations(journal.file,f.identity).attempts[0]!.writer,undefined);assert.deepEqual(recoverAccountCreations(journal.file,f.identity).candidates,[]);
 }finally{journal.close();f.cleanup();}
});
});
