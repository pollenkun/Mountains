import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {frozenFiles,requiredFreezeScopes} from './integrity.ts';
const root=resolve(process.argv[2]||''),repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
assert.ok(process.argv[2]);const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
assert.equal(manifest.root,root);const sha=data=>createHash('sha256').update(data).digest('hex');
for(const [path,hash]of Object.entries(manifest.fixtureHashes))assert.equal(sha(readFileSync(path)),hash,'fixture changed after build: '+path);
const cases=JSON.parse(readFileSync(join(repo,'packages/computer/test/acceptance/cases.json'),'utf8'));
// Cold preparation contains no server or browser startup. Actual destinations
// and exact task text are pinned by the same measured controller after startup.
const scopes=requiredFreezeScopes(repo,root);
const files=frozenFiles(scopes);
const priorSpendLedger='/Users/beluga383/Movies/Mountains 测试素材/codex-final-results-20261018-165635/deepseek-run-1/spend.jsonl';
const priorBytes=readFileSync(priorSpendLedger);
const freeze={version:3,at:Date.now(),root,scopes,files,fixtures:manifest.fixtureHashes,taskHash:sha(readFileSync(join(repo,'packages/computer/test/acceptance/cases.json'))),gates:cases.gates,
 policy:{focusSampleGapMaxMs:150,minWarmReads:30,minOrdinaryActions:30,requiredTechnicalChecks:['native-concurrency','web-concurrency-lifetime','cancellation','dialogs-and-delayed-focus','cli-cleanup','focus-monitor-agreement','stale-receipts']},
 priorSpendLedger,priorSpendPrefix:{bytes:priorBytes.length,sha256:sha(priorBytes)}};
writeFileSync(join(root,'evidence/freeze.json'),JSON.stringify(freeze,null,2),{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({frozen:true,files:Object.keys(files).length,taskHash:freeze.taskHash})+'\n');
