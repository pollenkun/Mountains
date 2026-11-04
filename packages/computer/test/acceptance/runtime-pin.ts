import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './integrity.ts';
import {taskPrompts} from './prompts.ts';

/** Cold source freeze precedes the measured lifetime. Actual task text is pinned
 * once the controller has started its one server under the independent monitor. */
export function pinRuntimeTasks(root:string,baseFreezeSha256:string,serverPid:number,casesPath:string):{path:string;sha256:string}{
 const serverPath=join(root,'web/server.json'),serverBytes=readFileSync(serverPath),server=JSON.parse(serverBytes.toString());
 assert.equal(server.pid,serverPid,'runtime server must be the exact child started by this controller');
 const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')),cases=JSON.parse(readFileSync(casesPath,'utf8'));
 const pin={version:1,at:Date.now(),baseFreezeSha256,server:{path:serverPath,sha256:sha256(serverBytes),pid:serverPid,url:server.url},prompts:taskPrompts(cases,manifest,server.url)};
 const path=join(root,'evidence/runtime-pin.json'),bytes=JSON.stringify(pin,null,2);writeFileSync(path,bytes,{flag:'wx',mode:0o600});
 return{path,sha256:sha256(bytes)};
}
export function checkRuntimeTasks(root:string,baseFreezeSha256:string,pinnedHash:string):{prompts:{id:number;text:string}[];at:number}{
 const bytes=readFileSync(join(root,'evidence/runtime-pin.json'));assert.equal(sha256(bytes),pinnedHash,'runtime task pin changed');
 const pin=JSON.parse(bytes.toString());assert.equal(pin.baseFreezeSha256,baseFreezeSha256,'runtime tasks used a different source freeze');
 assert.equal(pin.server.path,join(root,'web/server.json'),'runtime server receipt must stay inside this run');
 assert.equal(sha256(readFileSync(pin.server.path)),pin.server.sha256,'the one owned server was replaced or restarted');
 const server=JSON.parse(readFileSync(pin.server.path,'utf8'));assert.equal(server.pid,pin.server.pid);assert.equal(server.url,pin.server.url);
 const cases=JSON.parse(readFileSync(fileURLToPath(new URL('./cases.json',import.meta.url)),'utf8')),manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
 assert.deepEqual(pin.prompts,taskPrompts(cases,manifest,server.url),'runtime prompts do not match frozen cases and manifest values');
 return pin;
}
