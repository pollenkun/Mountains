import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseReminderInventory} from './acceptance/reminder-reader.ts';
import {AccountCreationJournal} from './acceptance/account-journal.ts';

test('the actual Swift account record includes an explicit null root and is accepted by both JS consumers',{skip:process.platform!=='darwin',timeout:20_000},context=>{
 // /usr/bin/swiftc can offer to install developer tools. Locate an already
 // installed compiler directly; a test must never trigger an installer UI.
 const selected=spawnSync('/usr/bin/xcode-select',['--print-path'],{encoding:'utf8',timeout:3000});
 const developer=selected.status===0?selected.stdout.trim():'';
 const compiler=developer?[join(developer,'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'),join(developer,'usr/bin/swiftc')].find(existsSync):undefined;
 const sdk=developer?[join(developer,'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'),join(developer,'SDKs/MacOSX.sdk')].find(existsSync):undefined;
 if(!compiler||!sdk){context.skip('An installed Swift compiler/SDK is unavailable for the Foundation-only serialization probe');return;}
 const version=spawnSync(compiler,['--version'],{encoding:'utf8',timeout:5000});
 assert.equal(version.status,0,version.stderr);
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mountains-account-record-'))),source=join(root,'Probe.swift'),binary=join(root,'Probe');
 let journal:AccountCreationJournal|undefined;
 try{
  const dto=fileURLToPath(new URL('./acceptance/native/AccountRecord.swift',import.meta.url));
  writeFileSync(source,`import Foundation\n@main struct Probe {static func main() throws {let value=NativeAccountRecord(id:"fixture-list-id",sourceId:"fixture-local-id",parentId:nil,kind:"container",fingerprint:String(repeating:"a",count:64));FileHandle.standardOutput.write(try JSONEncoder().encode(value))}}\n`);
  const build=spawnSync(compiler,['-sdk',sdk,'-swift-version','6','-warnings-as-errors','-parse-as-library',dto,source,'-o',binary],{encoding:'utf8',timeout:15_000});assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:3000});assert.equal(run.status,0,run.stderr);
  const item=JSON.parse(run.stdout);assert.equal(Object.hasOwn(item,'parentId'),true);assert.equal(item.parentId,null);
  const result=parseReminderInventory(JSON.stringify({version:1,kind:'reminders',authorization:'full',coverage:'all-objects',complete:true,fieldScope:'EventKit-public-reminder-v1',sources:[{id:item.sourceId,storage:'local',proof:'EventKit.sourceType'}],records:[item]}));
  const workspace=join(root,'workspace'),directory=join(root,'controller-private');mkdirSync(workspace,{mode:0o700});mkdirSync(directory,{mode:0o700});
  journal=AccountCreationJournal.create(directory,{runId:'frozen-serialization-probe',sourceId:item.sourceId,workspace,originalIds:[],fingerprintKeySha256:'0'.repeat(64)});
  assert.ok(journal.stage(result.records[0]!));
 }finally{journal?.close();rmSync(root,{recursive:true,force:true});}
});
