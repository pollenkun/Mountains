import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertDiagnosticRequest,diagnosticApproval} from './acceptance/diagnostic-policy.ts';

test('diagnostic harness rejects real apps even without foreground activation',()=>{
 const owned={nativePid:1234,webURL:'http://127.0.0.1:3001/',workspace:'/unused'};
 for(const app of ['Notes','Calendar','Reminders','Finder','1235',1234,undefined])for(const tool of ['screen_act','screen_look'])assert.throws(()=>assertDiagnosticRequest(tool,{app,action:'press',id:'e1'},owned),/exact newly created/);
 assert.doesNotThrow(()=>assertDiagnosticRequest('screen_act',{app:'1234',action:'press',id:'e1'},owned));
 assert.throws(()=>assertDiagnosticRequest('screen_act',{app:'1234',steps:[{action:'bring_to_front'}]},owned),/foreground/);
 assert.throws(()=>assertDiagnosticRequest('web_read',{url:'http://127.0.0.1:3002/'},owned),/loopback/);
 assert.throws(()=>assertDiagnosticRequest('web_read',{url:'http://user@127.0.0.1:3001/'},owned),/loopback/);
 assert.doesNotThrow(()=>assertDiagnosticRequest('web_read',{url:'http://127.0.0.1:3001/form'},owned));
});
test('diagnostic clipboard approval never also permits foreground or global pointer',()=>{
 assert.equal(diagnosticApproval({command:'Use computer use in this conversation'}),'allow');
 assert.equal(diagnosticApproval({command:'Use computer use in this conversation',explanation:'Background input; bringing an app to the front and using clipboard ask each time'}),'allow');
 assert.equal(diagnosticApproval({command:'Paste',explanation:'Use clipboard for this paste'}),'allow');
 for(const command of ['Activate app and clipboard','bring_to_front and clipboard','real_pointer and clipboard'])assert.equal(diagnosticApproval({command}),'deny');
 assert.equal(diagnosticApproval({command:'unknown action'}),'deny');
});
test('diagnostic upload rejects symlinks out of this run workspace',()=>{
 const root=mkdtempSync(join(tmpdir(),'mountains-policy-'));try{
  const workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'own.txt'),'own');writeFileSync(join(root,'private.txt'),'private');symlinkSync(join(root,'private.txt'),join(workspace,'shortcut.txt'));
  const owned={nativePid:1234,webURL:'http://127.0.0.1:3001/',workspace};
  assert.doesNotThrow(()=>assertDiagnosticRequest('web_act',{action:'upload',files:[join(workspace,'own.txt')]},owned));
  assert.throws(()=>assertDiagnosticRequest('web_act',{action:'upload',files:[join(workspace,'shortcut.txt')]},owned),/outside/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
