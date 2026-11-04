import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {toolTrace} from './trace.mjs';
import {checkFrozenVersion,duration,timedInterval} from './integrity.ts';
import {computerUseInstructions} from '../../src/skill.ts';
import {checkRuntimeTasks} from './runtime-pin.ts';
import {verifyFocusEvidence} from './focus-proof.ts';

const root=resolve(process.argv[2]||''),runner=process.argv[3];
assert.ok(process.argv[2]&&['self','deepseek'].includes(runner),'usage: assess-run.mjs root self|deepseek');
const json=path=>JSON.parse(readFileSync(path,'utf8')),lines=path=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const freeze=json(join(root,'evidence/freeze.json')),manifest=json(join(root,'manifest.json'));
const tasks=json(join(dirname(fileURLToPath(import.meta.url)),'cases.json'));
const findings=[],requireCheck=(name,run)=>{try{return run();}catch(error){findings.push(name+': '+error.message);return null;}};
const trace=requireCheck('tool trace',()=>toolTrace(root,runner))??[];
const journal=requireCheck('controller journal',()=>lines(join(root,'evidence',runner==='self'?'operator.jsonl':'controller.jsonl')))??[];
const start=journal.find(item=>item.sessionStart),end=journal.findLast(item=>item.sessionEnd);
requireCheck('fixed version',()=>{assert.ok(start?.freezeSha256,'session did not pin freeze.json');checkFrozenVersion(join(root,'evidence/freeze.json'),start.freezeSha256,{repo:resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),root});assert.ok(freeze.at<=start.at);});
requireCheck('frozen task delivery',()=>{
 const pinned=journal.filter(item=>item.runtimePin);assert.equal(pinned.length,1,'runtime tasks must be pinned exactly once');
 const runtime=checkRuntimeTasks(root,start.freezeSha256,pinned[0].runtimePin.sha256),prompts=runtime.prompts;
 const serverStart=journal.find(item=>item.fixtureStart==='web');assert.ok(serverStart&&runtime.at>=serverStart.at&&runtime.at>=start.startedAt,'server startup and prompt pin must fall inside the measured lifetime');assert.equal(journal.filter(item=>item.fixtureStart==='web').length,1,'server must be started exactly once');const actualPin=json(join(root,'evidence/runtime-pin.json'));assert.equal(actualPin.server.pid,serverStart.pid,'runtime server was not the controller-owned child');
 assert.ok(trace.every(call=>call.at>=pinned[0].at),'tool input occurred before exact task text was pinned');
 assert.equal(prompts.length,20);
 for(const spec of tasks.cases){const expected=prompts.find(item=>item.id===spec.id);assert.ok(expected?.text,'missing generated prompt');const delivered=journal.filter(item=>item.taskDelivered?.id===spec.id);assert.equal(delivered.length,1,'missing or repeated task delivery');assert.equal(delivered[0].taskDelivered.text,expected.text,'actual prompt differed from the frozen task');}
});
requireCheck('whole run',()=>{
 assert.ok(start&&end,'missing startup or cleanup receipt');assert.equal(start.diagnostic,false,'diagnostic sessions cannot count as formal acceptance');assert.ok(Number.isFinite(start.startedAt));assert.ok(Math.abs(duration(end.wallMs,'whole lifetime')-timedInterval(start.startedMonotonicMs,end.monotonicMs,'whole lifetime'))<100,'whole lifetime clock disagrees');assert.ok(end.wallMs<=tasks.gates.speed.suiteDeadlineMs,'suite too slow');
 assert.ok(trace.every(call=>Number.isInteger(call.case)&&call.case>=1&&call.case<=20),'every call must belong to exactly one case');
 assert.equal(journal.filter(item=>item.sessionStart).length,1);assert.equal(journal.filter(item=>item.sessionEnd).length,1);
 assert.deepEqual(end.cleanupErrors,[],'cleanup incomplete');assert.ok(trace.length<=tasks.gates.economy.modelToolCallsMax,'too many calls');
 assert.equal(journal.filter(item=>item.caseEnd).length,20,'not exactly 20 completed cases');
 assert.ok(!journal.some(item=>item.error||item.monitorError),'errors occurred outside verified results');
 const created=journal.filter(item=>item.fixtureStart);for(const fixture of created)assert.ok(journal.some(item=>item.fixtureExit===fixture.fixtureStart&&item.pid===fixture.pid),'fixture did not exit');
});
for(const spec of tasks.cases)requireCheck('case '+spec.id,()=>{
 const begins=journal.filter(item=>item.caseStart?.id===spec.id),ends=journal.filter(item=>item.caseEnd?.id===spec.id);
 assert.equal(begins.length,1);assert.equal(ends.length,1);
 const actual=ends[0].caseEnd,verdict=json(join(root,'evidence',`case-${String(spec.id).padStart(2,'0')}-data-verdict.json`));
 const recheck=spawnSync(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'verify.mjs'),root,String(spec.id),'--check','--runner',runner],{encoding:'utf8',timeout:30000});
 assert.equal(recheck.status,0,'independent data recheck failed: '+recheck.stdout+recheck.stderr);
 assert.equal(verdict.passed,true);assert.equal(actual.dataVerdict.passed,true);const elapsed=timedInterval(begins[0].caseStart.startedMonotonicMs,ends[0].monotonicMs,'case');assert.ok(Math.abs(duration(actual.wallMs,'case')-elapsed)<100,'reported case clock disagrees with journal');assert.ok(elapsed<=spec.deadlineMs,'case too slow');
 assert.ok(actual.calls<=spec.maxToolCalls,'case used too many calls');
 const calls=trace.filter(call=>call.at>=begins[0].at&&call.end<=ends[0].at);
 assert.equal(calls.length,actual.calls,'case tool count disagrees');assert.ok(calls.length>0,'no genuine calls');
});
const focus=lines(join(root,'evidence/focus.jsonl')),samples=focus.filter(item=>item.kind==='sample');
requireCheck('foreground and global focus',()=>verifyFocusEvidence({focus,journal,trace,maxSampleGapMs:freeze.policy.focusSampleGapMaxMs}));

const p95=values=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
const cold=new Set(),coldSamples=[],reads=[],actions=[];
requireCheck('timing records',()=>{for(const call of trace){
 duration(call.durationMs,'tool call');timedInterval(call.at,call.end,'tool wall clock');const measured=timedInterval(call.startMonotonicMs,call.endMonotonicMs,'tool clock');assert.ok(Math.abs(measured-call.durationMs)<100,'call duration disagrees with controller clock');
 if(['screen_read','web_read'].includes(call.tool)){
  const key=call.tool+':'+(call.result.details?.app??(call.tool==='web_read'?'browser':'inventory'));
  if(cold.has(key))reads.push(call.durationMs);else{cold.add(key);coldSamples.push({tool:call.tool,app:key,pid:call.result.details?.pid??null,durationMs:call.durationMs});}
 }
 if(['screen_act','web_act'].includes(call.tool)){
  const steps=call.result.details?.steps;
  if(Array.isArray(steps))for(const step of steps){duration(step.durationMs,'step');throw new Error('independent controller step intervals are not implemented; product step durations cannot count as proof');}
  else actions.push(call.durationMs);
 }
}});
requireCheck('speed',()=>{assert.ok(reads.length>=freeze.policy.minWarmReads,'too few real warm read samples');assert.ok(actions.length>=freeze.policy.minOrdinaryActions,'too few real action samples');assert.ok(p95(reads)<=tasks.gates.speed.warmReadP95Ms,'warm reads too slow');assert.ok(p95(actions)<=tasks.gates.speed.ordinaryActionP95Ms,'ordinary actions too slow');});
requireCheck('wasted calls',()=>{
 const audit=json(join(root,'evidence/call-audit.json'));assert.equal(audit.entries.length,trace.length);
 const ids=new Set(trace.map(call=>String(call.id)));for(const entry of audit.entries){assert.ok(ids.delete(String(entry.id)),'unknown/duplicate audited call');assert.equal(typeof entry.wasted,'boolean');assert.ok(entry.reason);}
 assert.equal(ids.size,0);assert.ok(audit.entries.filter(entry=>entry.wasted).length/trace.length<=tasks.gates.speed.wastedCallRatioMax,'too many wasted calls');
});
requireCheck('technical checks',()=>{
 const technical=json(join(root,'evidence/technical.json'));assert.equal(technical.checks.length,freeze.policy.requiredTechnicalChecks.length);
 const ids=new Set();for(const check of technical.checks){assert.ok(freeze.policy.requiredTechnicalChecks.includes(check.id),'unknown technical check ID');assert.ok(!ids.has(check.id));ids.add(check.id);assert.equal(check.passed,true);assert.equal(check.execution,'real local tools');assert.ok(check.evidence.length);for(const proof of check.evidence)assert.equal(sha(proof.path),proof.sha256,'technical evidence changed');const recheck=spawnSync(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'technical-verify.mjs'),root,check.id],{encoding:'utf8',timeout:30000});assert.equal(recheck.status,0,'technical verifier is missing or failed: '+check.id+' '+recheck.stderr);}
});
requireCheck('automated code checks',()=>{
 const check=json(join(root,'evidence/automated-check.json')),ready=focus.find(item=>item.kind==='ready'),stop=journal.find(item=>item.monitorStopRequested);
 assert.equal(check.exitCode,0);assert.equal(check.command,'npm run check');assert.equal(sha(check.log),check.logSha256);assert.deepEqual(check.sourceHashes,freeze.files,'checks used a different source version');
 assert.equal(check.monitored,true);assert.equal(check.monitorError,null);assert.ok(check.started>=ready.at&&check.finished>=check.started&&check.finished<=stop.at,'checks were outside the actual focus-monitor lifetime');
 assert.equal(check.monitorPid,journal.find(item=>item.monitorStart)?.monitorStart.pid);
 assert.deepEqual(check.monitorIdentity,journal.find(item=>item.monitorStart)?.monitorStart.process?.identity,'automated checks used another monitor birth');assert.deepEqual(check.monitorIdentityAfter,check.monitorIdentity,'monitor changed while running checks');
 const covered=samples.filter((item,i)=>item.at>=check.started&&item.at<=check.finished||samples[i+1]?.at>=check.started&&item.at<=check.started||samples[i-1]?.at<=check.finished&&item.at>=check.finished);
 assert.ok(covered.length>1&&covered[0].at<=check.started&&covered.at(-1).at>=check.finished,'missing check-time samples');for(let i=1;i<covered.length;i++)assert.ok(covered[i].uptimeMs-covered[i-1].uptimeMs<=freeze.policy.focusSampleGapMaxMs,'check-time sampling gap');
});
requireCheck('commands and screenshots',()=>{
 for(const call of trace){assert.ok(call.args?.action!=='bring_to_front');assert.ok(!call.args?.allow_real_pointer);assert.ok(!call.args?.steps?.some(step=>step.action==='bring_to_front'||step.allow_real_pointer));}
 if(runner==='deepseek'){
  const audit=json(join(root,'evidence/command-audit.json'));assert.equal(audit.passed,true);assert.ok(audit.recordingSha256);assert.equal(audit.recordingSha256,sha(json(join(root,'evidence/cli-source.json')).recording));
  assert.ok(trace.every(call=>!['screen_look','web_look'].includes(call.tool)),'screenshots were disabled for DeepSeek');
 }
});
const skillCharacters=Array.from(computerUseInstructions(runner==='self')).length;
const skillOverage=Math.max(0,skillCharacters-tasks.gates.economy.skillCharactersMax);
let totalCost=0;
requireCheck('cumulative cost',()=>{
 const prior=readFileSync(freeze.priorSpendLedger),prefix=freeze.priorSpendPrefix;
 assert.ok(prefix&&prior.length>=prefix.bytes,'prior paid ledger was truncated');assert.equal(createHash('sha256').update(prior.subarray(0,prefix.bytes)).digest('hex'),prefix.sha256,'prior paid history changed');
 const ledgers=new Set([freeze.priorSpendLedger,...(json(join(root,'evidence/cost-sources.json')).ledgers??[])]),reservations=new Map();
 for(const path of ledgers)for(const row of lines(path)){
  assert.equal(row.currency,'CNY');if(row.kind==='budget.run-claim')continue;
  const key=row.runId+'/'+row.requestId;
  if(row.kind==='budget.reserve'){assert.ok(!reservations.has(key));assert.ok(Number.isFinite(row.worstCost));reservations.set(key,{reserved:row.worstCost});}
  else if(row.kind==='budget.settle'){const item=reservations.get(key);assert.ok(item&&item.settled===undefined);assert.ok(Number.isFinite(row.amount)&&row.amount>=0);item.settled=row.amount;}
  else throw new Error('unknown cost ledger row');
 }
 totalCost=[...reservations.values()].reduce((sum,item)=>sum+(item.settled??item.reserved),0);assert.ok(totalCost<=tasks.gates.economy.totalModelBudgetCNY,'cumulative budget exceeded');
 if(runner==='deepseek'){
  const source=json(join(root,'evidence/cli-source.json'));assert.ok(ledgers.has(source.spendLedger),'current paid ledger was omitted');
  const modelRequests=lines(source.modelLedger);assert.ok(modelRequests.length>0,'no real model requests');
  for(const request of modelRequests){assert.equal(request.currency,'CNY');const entry=reservations.get(request.runId+'/'+request.requestId);assert.ok(entry&&entry.settled!==undefined,'a model or approval request is missing its settlement');}
  const wallet=json(join(root,'evidence/wallet-after.json'));assert.equal(wallet.provider,'DeepSeek live balance API');assert.ok(wallet.at>=end.at);assert.ok(wallet.availableCNY>=tasks.gates.economy.walletReserveCNY,'wallet reserve below minimum');}
});
const result={runner,root,passed:findings.length===0,at:Date.now(),cases:20,findings,metrics:{toolCalls:trace.length,wallMs:end?.wallMs,warmReadSamples:reads.length,coldSamples,ordinaryActionSamples:actions.length,warmReadP95Ms:p95(reads),ordinaryActionP95Ms:p95(actions),totalConservativeCNY:totalCost,skillCharacters,skillLimit:tasks.gates.economy.skillCharactersMax,skillOverage},taskHash:freeze.taskHash};
writeFileSync(join(root,'evidence/run-verdict.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});process.stdout.write(JSON.stringify(result)+'\n');if(!result.passed)process.exitCode=1;
