/** Explicit opt-in: touches the real clipboard; never logs or saves its original contents. */
import {requireRealMachineAcceptanceSafety} from './acceptance/safety-gate.ts';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { computerUseSkill } from '../src/skill.ts';
import { cleanupAll } from './fixtures/cleanup.ts';
import {onTestTermination} from './fixtures/signals.ts';
import type {UiApp,UiElement} from '../src/backend.ts';
import { xa11yDesktop } from '../src/backend.ts';
import { MacPointer } from '../src/pointer-mac.ts';
import { FileStateTracker, Workspace, type ToolContext, type ToolResult } from '@mountains/tools';

requireRealMachineAcceptanceSafety();
if (process.platform !== 'darwin' || process.env.MOUNTAINS_ACCEPTANCE_CLIPBOARD !== '1') throw new Error('Requires macOS and MOUNTAINS_ACCEPTANCE_CLIPBOARD=1; this run uses the real clipboard and foreground.');
const run = promisify(execFile), pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const directory = process.argv[2] ?? await mkdtemp(join(tmpdir(), 'mountains-clipboard-acceptance-'));
await mkdir(directory, { recursive: true });
const helper = new MacPointer(), desktop = await xa11yDesktop({ cursor: false });
const lifecycle=new AbortController();
const records: { name: string; passed: boolean; error?: string }[] = [], receipts: unknown[] = [];
const sourceHashes: Record<string, string> = {};
const cleanupToken=randomUUID();
for (const name of await readdir(new URL('../src/', import.meta.url))) if (name.endsWith('.ts')) sourceHashes[`src/${name}`] = createHash('sha256').update(await readFile(new URL(`../src/${name}`, import.meta.url))).digest('hex');
for (const name of ['verify-clipboard-macos.ts', 'fixtures/paste-app.swift']) sourceHashes[name] = createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex');
const skill=computerUseSkill({desktop:async()=>desktop,imageInput:true,cursor:false});
const tools=Object.fromEntries(skill.tools!.map(t=>[t.name,t]));
let foregroundApprovalAllowed=false;
const approvals: {request:unknown;decision:string;answeredBy:string}[] = [];
const context = (): ToolContext => ({ workspace: new Workspace(process.cwd()), files: new FileStateTracker(), signal:lifecycle.signal, toolCallId: 'clipboard-acceptance', approve: async request => { const foreground=request.command!=='Use computer use in this conversation'&&/front|foreground|activate/i.test(request.explanation??'');const decision=foreground&&!foregroundApprovalAllowed?'deny':'allow';approvals.push({request,decision,answeredBy:'test-script: this individual approval only'});return decision; } });
async function call(tool: string, args: Record<string, unknown>, ctx = context()) {
    lifecycle.signal.throwIfAborted();const r = await tools[tool]!.execute(args,{...ctx,signal:AbortSignal.any([ctx.signal,lifecycle.signal])}); receipts.push({ tool, args, result: { ...r, images: undefined } }); return r;
}
const model = () => readFile(join(directory, 'model.json'), 'utf8').then(JSON.parse);
async function control(op: string, extra: Record<string, unknown> = {}) {
    lifecycle.signal.throwIfAborted();
    const nonce = randomUUID(); await writeFile(join(directory, 'control.json'), JSON.stringify({ nonce, op, cleanupToken,...extra }));
    for (let n = 0; n < 100; n++) { if ((await model()).lastCommand === nonce) return; await pause(30); }
    throw new Error('clipboard fixture control timeout');
}
function editorId(r: ToolResult) { const line = r.modelContent.split('\n').find(l => l.includes('Rich editor')); const id = line?.match(/^\s*(e\d+) /)?.[1]; assert.ok(id, r.modelContent); return id; }
// Compare without ever including private clipboard data in assertions or receipts.
const fingerprint = (items: unknown) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
let original: Record<string, unknown> | undefined, pid = 0, window = 0, executable = '', restoreStatus = 'not touched',fixture:ChildProcess|undefined;
let originalFront:UiApp|undefined,originalWindow:UiElement|undefined,originalWindowId:string|undefined;
let restoreIssued=false;
async function restoreFront(signal:AbortSignal){
 signal.throwIfAborted();
 if(!originalFront||!originalWindow||!originalWindowId)throw new Error('original front window identity missing');
 const apps=await desktop.apps();signal.throwIfAborted();const current=apps.find(app=>app.isForeground);
 if(current?.pid===originalFront.pid){
  if(current.instance!==originalFront.instance||await desktop.activeWindow?.(current)!==originalWindowId)throw new Error('original app/window changed externally; did not override it');
  signal.throwIfAborted();return;
 }
 if(current?.pid!==pid)throw new Error('foreground changed externally; did not override it');
 const same=apps.find(app=>app.pid===originalFront!.pid&&app.instance===originalFront!.instance);
 if(!same)throw new Error('original app ended or its PID was reused');
 const windows=await same.windows();signal.throwIfAborted();let found:UiElement|undefined;
 for(const candidate of windows){const identity=await desktop.windowIdentity!(same,candidate);signal.throwIfAborted();if(identity.id===originalWindowId){found=candidate;break;}}
 if(!found)throw new Error('original window closed or was replaced');
 const latest=await desktop.apps();signal.throwIfAborted();
 if(!latest.some(app=>app.pid===pid&&app.isForeground)||!latest.some(app=>app.pid===same.pid&&app.instance===same.instance))throw new Error('foreground or original app changed while preparing restoration; no activation sent');
 if(restoreIssued)throw new Error('an earlier restore was already sent; did not repeat uncertain activation');
 restoreIssued=true;await found.performAction('activate');signal.throwIfAborted();
 const after=await desktop.apps();signal.throwIfAborted();const restored=after.find(app=>app.pid===same.pid&&app.instance===same.instance&&app.isForeground);
 if(!restored||await desktop.activeWindow?.(restored)!==originalWindowId)throw new Error('exact original foreground window was not restored');
 signal.throwIfAborted();
}
async function test(name: string, fn: () => Promise<void>) { try { await fn(); records.push({ name, passed: true }); console.log(`PASS ${name}`); } catch (e) { records.push({ name, passed: false, error: String(e) }); console.log(`FAIL ${name}: ${String(e)}`); } }
async function read() { const r = await call('screen_read', { app: String(pid), window: `w:${window}` }); assert.equal(r.ok, true, r.modelContent); return r; }
async function seed() { assert.notEqual((await model()).front,pid,'negative and background clipboard cases must run in the background');await control('seed'); const r = await helper.send({ op: 'clip_read' }); return r; }
async function paste(format: string, text: string, ctx = context()) {
    const r = await read(), approvalCount = approvals.length;
    const result = await call('screen_act', { app: String(pid), snapshot: r.details?.snapshot, action: 'paste', id: editorId(r), format, text }, ctx);
    assert.equal(approvals.length, approvalCount + 1, 'each paste asks separately'); return result;
}
let shutdownPromise:Promise<void>|undefined;
const shutdown=()=>shutdownPromise??=(async()=>{
    const cleanupErrors=await cleanupAll([
      {name:'restore foreground',async run(signal){const apps=await desktop.apps();signal.throwIfAborted();if(pid&&apps.some(app=>app.pid===pid&&app.isForeground))await restoreFront(signal);}},
      {name:'restore original clipboard',async run(signal){
        if(!original)return;
        const current=await helper.send({op:'clip_read'});signal.throwIfAborted();
        if(fingerprint(current.items)===fingerprint(original.items)){restoreStatus='original clipboard already present';return;}
        const r=await helper.send({op:'clip_restore',items:original.items as string[][][],token:cleanupToken});signal.throwIfAborted();
        if(r.userChanged===true){restoreStatus='newer external clipboard preserved; test ownership lost';throw new Error(restoreStatus);}
        const after=await helper.send({op:'clip_read'});
        if(r.restored!==true||fingerprint(after.items)!==fingerprint(original.items))throw new Error('original clipboard was not restored');
        restoreStatus='original clipboard restored; contents not recorded';
      }},
      {name:'dispose tools',run:()=>skill.dispose!()},
      {name:'close desktop',run:()=>desktop.close?.()??Promise.resolve()},
      {name:'close clipboard helper',run:()=>helper.close()},
      {name:'stop owned fixture',async run(){
        if(!fixture||fixture.exitCode!==null||fixture.signalCode!==null)return;
        await new Promise<void>((accept,reject)=>{
          const timer=setTimeout(()=>{fixture!.kill('SIGKILL');},1000);
          fixture!.once('exit',()=>{clearTimeout(timer);accept();});
          fixture!.once('error',reject);fixture!.kill('SIGTERM');
        });
      }},
    ]);
    if(cleanupErrors.length){records.push({name:'cleanup restores original state and stops owned resources',passed:false,error:JSON.stringify(cleanupErrors)});process.exitCode=1;}
    await writeFile(join(directory,'acceptance.json'),JSON.stringify({diagnostic:true,sourceHashes,records,approvals,receipts,restoreStatus,cleanupErrors},null,2));
    console.log(`Clipboard cleanup: ${restoreStatus}\nEvidence: ${join(directory,'acceptance.json')}`);

})();
const removeTerminationHandlers=onTestTermination(lifecycle,shutdown);
try {
    originalFront=(await desktop.apps()).find(app=>app.isForeground);
    if(!originalFront)throw new Error('cannot identify original foreground');
    originalWindowId=await desktop.activeWindow?.(originalFront)??undefined;
    for(const candidate of await originalFront.windows())if((await desktop.windowIdentity!(originalFront,candidate)).id===originalWindowId){originalWindow=candidate;break;}
    if(!originalWindow)throw new Error('cannot identify original keyboard window');
    original = await helper.send({ op: 'clip_read' });
    const bundle = join(directory, 'MountainsPasteAcceptance.app'), contents = join(bundle, 'Contents');
    executable = join(contents, 'MacOS', 'MountainsPasteAcceptance');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await run('swiftc', ['-O', '-o', executable, fileURLToPath(new URL('fixtures/paste-app.swift', import.meta.url))]);
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.mountains.paste.${randomUUID()}</string><key>CFBundleExecutable</key><string>MountainsPasteAcceptance</string><key>LSUIElement</key><true/></dict></plist>`);
    lifecycle.signal.throwIfAborted();fixture=spawn(executable,[directory],{stdio:['pipe','ignore','ignore']});
    await new Promise<void>((accept,reject)=>{fixture!.once('spawn',()=>accept());fixture!.once('error',reject);});pid=fixture.pid!;
    for (let n = 0; n < 100; n++) { try { const m = await model(); assert.equal(m.pid,pid,'model PID must be the exact owned child');window = m.window; break; } catch { await pause(100); } }
    assert.ok(window, 'owned fixture must report its window before tests');
    await test('background HTML paste keeps bold and italic and restores every clipboard item', async () => {
        await control('reset'); const before = await seed(), state = await model();
        const r = await paste('html', '<b>Bold 中文</b> <i>Italic</i> 🌍');
        assert.equal(r.details?.error, undefined, r.modelContent);
        assert.equal((r.details?.foreground as { unchanged?: boolean })?.unchanged, true, r.modelContent);
        await pause(150); const after = await model();
        assert.equal(after.value, 'Bold 中文 Italic 🌍'); assert.equal(after.bold, 'Bold 中文'); assert.equal(after.italic, 'Italic');
        assert.equal(after.pastes, state.pastes + 1); assert.equal(after.front, state.front); assert.deepEqual(after.mouse, state.mouse); assert.equal(after.buttons, 0);
        assert.equal(fingerprint((await helper.send({ op: 'clip_read' })).items), fingerprint(before.items), 'all test items and representations restored');
        assert.deepEqual(r.details?.clipboard, { restored: true, userChanged: false });
    });
    await test('authorized foreground Markdown paste preserves formatting', async () => {
      foregroundApprovalAllowed=true;const approvalStart=approvals.length;try{
        await control('reset'); const before = await seed(); let r = await read();
        r = await call('screen_act', { app: String(pid), snapshot: r.details?.snapshot, action: 'bring_to_front' }); assert.equal(r.details?.outcome, 'confirmed', r.modelContent);
        r = await paste('md', '**Bold 中文** *Italic* 🌍'); assert.equal(r.details?.error, undefined, r.modelContent);
        await pause(150); const after = await model(); assert.equal(after.value.trim(), 'Bold 中文 Italic 🌍'); assert.ok(after.bold.includes('Bold 中文')); assert.ok(after.italic.includes('Italic'));
        assert.equal(fingerprint((await helper.send({ op: 'clip_read' })).items), fingerprint(before.items), 'test clipboard restored');
        assert.ok(approvals.slice(approvalStart).some(entry=>entry.decision==='allow'&&/front/i.test(JSON.stringify(entry.request))),'foreground permission must be requested');
      }finally{foregroundApprovalAllowed=false;await restoreFront(AbortSignal.timeout(5000));}
    });
    await test('a new copy during real paste wins over clipboard restoration', async () => {
        await control('reset', { copyDuringPaste: true }); await seed();
        const r = await paste('text', 'Pasted once'); await pause(100);
        const after = await helper.send({ op: 'clip_read' });
        const items = after.items as string[][][];
        assert.ok(items.some(item => item.some(pair => pair[0] === 'public.utf8-plain-text' && Buffer.from(pair[1]!, 'base64').toString() === 'New copy during paste — 保留')), 'new fixture copy survives');
        assert.deepEqual(r.details?.clipboard, { restored: false, userChanged: true }); assert.equal((await model()).value, 'Pasted once');
    });
    await test('cancellation after installing real paste content restores the clipboard without typing', async () => {
        await control('reset'); const before = await seed(), state = await model(), abort = new AbortController();
        const originalSet = desktop.clipboardSet;
        desktop.clipboardSet = async (...args) => { await originalSet(...args); abort.abort(); };
        try { const r = await paste('text', 'Must not be pasted', { ...context(), signal: abort.signal }); assert.equal(r.details?.cancelled, true); assert.deepEqual(r.details?.clipboard, { restored: true, userChanged: false }); }
        finally { desktop.clipboardSet = originalSet; }
        await pause(100); assert.equal((await model()).pastes, state.pastes); assert.equal((await model()).value, '');
        assert.equal(fingerprint((await helper.send({ op: 'clip_read' })).items), fingerprint(before.items), 'test clipboard restored after cancellation');
    });
    await test('a receiver replaced during clipboard installation cannot receive the paste', async () => {
        await control('reset'); const before = await seed(), state = await model(), originalSet = desktop.clipboardSet;
        desktop.clipboardSet = async (...args) => { await originalSet(...args); await control('replace'); };
        try {
            const r = await paste('text', 'Must not reach the replacement');
            assert.notEqual(r.details?.outcome, 'confirmed'); assert.match(String(r.details?.error), /receiver|replaced/);
            assert.deepEqual(r.details?.clipboard, { restored: true, userChanged: false });
        } finally { desktop.clipboardSet = originalSet; }
        await pause(100); const after = await model(); assert.equal(after.pastes, state.pastes); assert.equal(after.value, '');
        assert.equal(fingerprint((await helper.send({ op: 'clip_read' })).items), fingerprint(before.items), 'test clipboard restored after receiver replacement');
    });
    await test('a clipboard change before installation refuses the stale replacement', async () => {
        const stale = await seed(); await control('seed'); const current = await helper.send({ op: 'clip_read' });
        await assert.rejects(helper.send({ op: 'clip_set', text: 'Must not replace', changeCount: Number(stale.changeCount), token:randomUUID() }), /clipboard changed/);
        const after = await helper.send({ op: 'clip_read' }); assert.equal(after.changeCount, current.changeCount); assert.equal(fingerprint(after.items), fingerprint(current.items));
    });
}finally{try{await shutdown();}finally{removeTerminationHandlers();}}
if (records.some(r => !r.passed)) process.exitCode = 1;
