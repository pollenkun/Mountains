import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {ChildProcess} from 'node:child_process';
import type { BrowserProcess } from "./browser-process.ts";
import type { InputCoordinator } from "./coordinator.ts";

export interface BrowserChildLifetime {child:ChildProcess;isBrowser:boolean;closed:Promise<void>}
interface RetainedChild {owner:BrowserProcess;lifetime:BrowserChildLifetime}
const local = new WeakMap<InputCoordinator, { clients: Set<string>; endpoint?: string; process?: BrowserProcess; retained?:string[];downloadDir?:string;children:Map<string,RetainedChild> }>();
// A ChildProcess handle cannot be serialized to another client process. Keep
// its real OS lifetime only inside this process, across independent coordinators
// that hold the same private directory. Never reconstruct one from a PID file.
const childrenByDirectory=new Map<string,Map<string,RetainedChild>>();

/** Called only while the profile's input lock is held. A connection is not a browser lifetime. */
export class BrowserClients {
	private readonly token = randomUUID();
	private joined = false;
	private readonly coordinator: InputCoordinator;
	constructor(coordinator: InputCoordinator) { this.coordinator = coordinator; }
	private get memory() {
		let value = local.get(this.coordinator);
		if (!value) { value = { clients: new Set(),children:new Map() }; local.set(this.coordinator, value); }
		return value;
	}
	private get directory(): string | undefined {
		return this.coordinator.directory && join(this.coordinator.directory, "browser-clients");
	}
	async join(): Promise<void> {
		if (this.joined) return;
		if (this.directory) {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			await writeFile(join(this.directory, `${this.token}.json`), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: "wx" });
		} else this.memory.clients.add(this.token);
		this.joined = true;
	}
	async owned(endpoint: string, process?: BrowserProcess,lifetime?:BrowserChildLifetime): Promise<void> {
		const owner=process&&{...process};
		// Bind child and cached exit together before the first await. Caller
		// mutation during a disk write must never substitute another child.
		const child=lifetime&&Object.freeze({...lifetime});
		let records:Map<string,RetainedChild>|undefined;
		if(child){
			if(!owner||!child.isBrowser||child.child.pid!==owner.pid)throw new Error('browser child does not match the attested browser process');
			const {children}=await this.childRecords(),old=children.get(endpoint);
			if(old&&(old.lifetime.child!==child.child||old.owner.pid!==owner.pid||old.owner.identity!==owner.identity))throw new Error('the original browser child cannot be replaced');
			records=children;
		}
		if (this.directory) await writeFile(join(this.directory, "owner.json"), JSON.stringify({ endpoint, process:owner }), { mode: 0o600 });
		else { this.memory.endpoint = endpoint; if(owner)this.memory.process=owner;else delete this.memory.process; }
		if(records&&owner&&child)records.set(endpoint,{owner,lifetime:child});
	}
	private async childRecords():Promise<{children:Map<string,RetainedChild>;key?:string}>{
		if(!this.directory)return{children:this.memory.children};
		const info=await lstat(this.directory),path=await realpath(this.directory);
		if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077))throw new Error('browser child records require the original private client directory');
		const key=`${path}:${info.dev}:${info.ino}`;let children=childrenByDirectory.get(key);
		if(!children){children=new Map();childrenByDirectory.set(key,children);}return{children,key};
	}
	async childLifetime(endpoint:string,owner:BrowserProcess):Promise<BrowserChildLifetime|undefined>{
		const record=(await this.childRecords()).children.get(endpoint);
		return record&&record.owner.pid===owner.pid&&record.owner.identity===owner.identity?record.lifetime:undefined;
	}
	async forgetChild(endpoint:string,lifetime:BrowserChildLifetime):Promise<void>{
		const {children,key}=await this.childRecords(),record=children.get(endpoint);
		if(record?.lifetime.child!==lifetime.child)return;
		children.delete(endpoint);if(key&&children.size===0)childrenByDirectory.delete(key);
	}
	async process(endpoint: string): Promise<BrowserProcess | undefined> {
		if (!this.directory) return this.memory.endpoint === endpoint && this.memory.process ? {...this.memory.process} : undefined;
		try {
			const owner = JSON.parse(await readFile(join(this.directory, "owner.json"), "utf8")) as { endpoint?: string; process?: BrowserProcess };
			if (owner.endpoint === endpoint && Number.isSafeInteger(owner.process?.pid) && typeof owner.process?.identity === "string") return owner.process;
		} catch { /* no verified birth identity */ }
		return undefined;
	}
    async downloadDirectory(endpoint:string,directory:string):Promise<void>{
        if(!this.directory){if(this.memory.endpoint!==endpoint)throw new Error("download ownership changed");if(this.memory.downloadDir&&this.memory.downloadDir!==directory)throw new Error("this browser profile already uses another download directory");this.memory.downloadDir=directory;return;}
        const file=join(this.directory,"owner.json"),owner=JSON.parse(await readFile(file,"utf8"));
        if(owner.endpoint!==endpoint)throw new Error("download ownership changed");
        if(owner.downloadDir&&owner.downloadDir!==directory)throw new Error("this browser profile already uses another download directory");
        await writeFile(file,JSON.stringify({...owner,downloadDir:directory}),{mode:0o600});
    }

    async retained(endpoint:string):Promise<string[]>{
        if(!this.directory)return this.memory.endpoint===endpoint?[...this.memory.retained??[]]:[];
        try{const owner=JSON.parse(await readFile(join(this.directory,"owner.json"),"utf8"));return owner.endpoint===endpoint&&Array.isArray(owner.retained)?owner.retained.filter((id:unknown)=>typeof id==="string"):[];}catch{return [];}
    }
    async retain(endpoint:string,target:string,keep=true):Promise<void>{
        const process=await this.process(endpoint);if(!process)throw new Error("page handoff has no verified browser ownership");
        const targets=new Set(await this.retained(endpoint));if(keep)targets.add(target);else targets.delete(target);
        if(this.directory)await writeFile(join(this.directory,"owner.json"),JSON.stringify({...JSON.parse(await readFile(join(this.directory,"owner.json"),"utf8")),endpoint,process,retained:[...targets]}),{mode:0o600});
        else this.memory.retained=[...targets];
    }

	/** Only the last registered client may close the exact endpoint Mountains started. */
	async leave(endpoint?: string): Promise<boolean> {
		if (!this.joined) return false;
		this.joined = false;
		if (!this.directory) {
			this.memory.clients.delete(this.token);
			return this.memory.clients.size === 0 && !!endpoint && this.memory.endpoint === endpoint;
		}
		await rm(join(this.directory, `${this.token}.json`), { force: true });
		for (const name of await readdir(this.directory)) {
			if (name === "owner.json" || !name.endsWith(".json")) continue;
			try {
				const { pid } = JSON.parse(await readFile(join(this.directory, name), "utf8")) as { pid?: number };
				if (!Number.isSafeInteger(pid) || !pid || pid < 1) return false;
				try { process.kill(pid, 0); return false; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
				await rm(join(this.directory, name), { force: true });
			} catch { return false; }
		}
		try {
			const owner = JSON.parse(await readFile(join(this.directory, "owner.json"), "utf8")) as { endpoint?: string };
			return !!endpoint && owner.endpoint === endpoint;
		} catch { return false; }
	}
}
