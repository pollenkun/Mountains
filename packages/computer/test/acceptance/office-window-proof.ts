import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseProcessObservation,writerProcessIdentity,type WriterProcessIdentity} from './process-identity.ts';

export interface OfficeWindowInventory {
	schema:'macos-office-windows-v1';pid:number;executable:string;
	before:{status:'alive';identity:WriterProcessIdentity};after:{status:'alive';identity:WriterProcessIdentity};
	windows:{number:number|null;role:string;documentURL:string|null;edited:boolean|null}[];
	cgWindowNumbers:number[];
	complete:true;
}
function object(value:unknown):Record<string,unknown>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function keys(value:Record<string,unknown>,required:string[],optional:string[]=[]):void{
	assert.ok(required.every(name=>Object.hasOwn(value,name)));assert.ok(Object.keys(value).every(name=>required.includes(name)||optional.includes(name)));
}
/** Missing AXDocument, window number or AXEdited remains unknown. None is
 * guessed from a title or from which application happens to be listed first. */
export function parseOfficeWindowInventory(raw:unknown):OfficeWindowInventory{
	const value=object(raw);keys(value,['schema','pid','executable','before','after','windows','cgWindowNumbers','complete']);
	assert.equal(value.schema,'macos-office-windows-v1');assert.equal(value.complete,true);
	assert.ok(typeof value.pid==='number'&&Number.isSafeInteger(value.pid)&&value.pid>0&&value.pid<=2_147_483_647);
	assert.ok(typeof value.executable==='string'&&isAbsolute(value.executable)&&!value.executable.includes('\0'));
	const before=parseProcessObservation(JSON.stringify(value.before)),after=parseProcessObservation(JSON.stringify(value.after));
	assert.equal(before.status,'alive');assert.equal(after.status,'alive');assert.ok(before.status==='alive'&&after.status==='alive');
	assert.equal(before.identity.pid,value.pid);assert.deepEqual(before,after,'office process changed during the independent read');
	assert.ok(Array.isArray(value.windows)&&value.windows.length<=128);
	assert.ok(Array.isArray(value.cgWindowNumbers)&&value.cgWindowNumbers.length<=4096&&new Set(value.cgWindowNumbers).size===value.cgWindowNumbers.length);
	assert.ok(value.cgWindowNumbers.every(number=>typeof number==='number'&&Number.isSafeInteger(number)&&number>0&&number<=0xffff_ffff));
	const windows=value.windows.map(raw=>{
		const row=object(raw);keys(row,['role'],['number','documentURL','edited']);
		assert.ok(typeof row.role==='string'&&row.role.length>0);
		assert.ok(row.number===undefined||row.number===null||typeof row.number==='number'&&Number.isSafeInteger(row.number)&&row.number>0&&row.number<=0xffff_ffff);
		assert.ok(row.documentURL===undefined||row.documentURL===null||typeof row.documentURL==='string'&&row.documentURL.length<=16384&&!row.documentURL.includes('\0'));
		assert.ok(row.edited===undefined||row.edited===null||typeof row.edited==='boolean');
		return{number:row.number as number|null??null,role:row.role,documentURL:row.documentURL as string|null??null,edited:row.edited as boolean|null??null};
	});
	return{schema:'macos-office-windows-v1',pid:value.pid,executable:value.executable,before,after,windows,cgWindowNumbers:[...value.cgWindowNumbers],complete:true};
}
export interface OwnedOfficeImage {
	root:string;birth:WriterProcessIdentity;executable:string;window?:string;
}
/** Controller-only boundary for the fresh case14 image. This places no new
 * restriction on the product's application or window support. */
export function ownedOfficeImage(raw:unknown,owned:OwnedOfficeImage):{window:string;file:string;edited:boolean|null;inventory:OfficeWindowInventory}{
	const inventory=parseOfficeWindowInventory(raw),birth=writerProcessIdentity(owned.birth);
	assert.deepEqual(inventory.before.identity,birth,'this is not the originally launched office instance');
	assert.equal(inventory.executable,owned.executable);assert.equal(realpathSync(owned.executable),owned.executable,'office executable was redirected');
	const root=realpathSync(owned.root);assert.equal(root,owned.root);assert.ok(lstatSync(root).isDirectory());
	const workspace=join(root,'workspace'),file=join(workspace,'rotate.png');
	assert.equal(realpathSync(workspace),workspace,'office workspace was redirected');assert.ok(lstatSync(workspace).isDirectory());
	const image=lstatSync(file);assert.ok(image.isFile(),'the owned image is not a regular file');assert.equal(image.nlink,1,'the owned image has a hard link outside this ownership proof');assert.equal(realpathSync(file),file,'the owned image was redirected');
	assert.equal(inventory.windows.length,1,'unexpected, missing or restored office windows');
	const window=inventory.windows[0]!;assert.equal(window.role,'AXWindow');assert.ok(window.number!==null,'exact owned window is unavailable or ambiguous');
	assert.deepEqual(inventory.cgWindowNumbers,[window.number],'the process has CG windows missing from the exact AX document inventory');
	assert.ok(window.documentURL,'the actual AXDocument is unknown');const document=new URL(window.documentURL);
	assert.equal(document.protocol,'file:');assert.equal(document.search,'');assert.equal(document.hash,'');assert.equal(document.username,'');assert.equal(document.password,'');
	assert.equal(fileURLToPath(document),file,'AXDocument belongs to another file');
	const handle='w:'+window.number;if(owned.window)assert.equal(handle,owned.window,'the owned document window was replaced');
	return{window:handle,file,edited:window.edited,inventory};
}
/** Execute a pinned read-only helper, not xa11y's cached tree. Helper shutdown
 * is awaited before this returns. No AX permission prompt is requested. */
export async function readOfficeWindowInventory(binary:{path:string;sha256:string},pid:number,signal?:AbortSignal):Promise<OfficeWindowInventory>{
	assert.equal(process.platform,'darwin');assert.equal(realpathSync(binary.path),binary.path);assert.ok(lstatSync(binary.path).isFile());
	assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'),binary.sha256);
	assert.ok(Number.isSafeInteger(pid)&&pid>0&&pid<=2_147_483_647);signal?.throwIfAborted();
	const bytes=await new Promise<string>((yes,no)=>{
		let result:{error:Error|null;stdout:string;stderr:string}|undefined;
		const child=execFile(binary.path,[String(pid)],{encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:2*1024*1024,...(signal?{signal}:{})},(error,stdout,stderr)=>{result={error,stdout,stderr};});
		child.once('close',()=>{if(!result||result.error)no(new Error('independent office window inventory failed'+(result?.stderr?': '+result.stderr.slice(0,512):'')));else yes(result.stdout);});child.stdin?.end();
	});
	signal?.throwIfAborted();const value=parseOfficeWindowInventory(JSON.parse(bytes));assert.equal(value.pid,pid);return value;
}
