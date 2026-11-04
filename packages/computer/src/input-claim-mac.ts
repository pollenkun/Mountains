import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HelperAdmissionError, HelperResponseError, JsonHelper } from "./helper.ts";
import { outsideInputScope } from "./coordinator.ts";

export interface ClaimStorageBinding {
	format: 3;
	componentOnly: true;
	storageId: string;
	directory: { device: string; inode: string };
	guardFile: { device: string; inode: string };
}
export interface ClaimProcessBirth {
	schema: "macos-kinfo-starttime-v1";
	pid: number;
	bootId: string;
	startSeconds: string;
	startMicroseconds: number;
}
export interface ClaimState {
	binding: ClaimStorageBinding;
	revision: string;
	lease?: {
		id: string;
		epoch:string;
		owner: ClaimProcessBirth;
		phase: "open" | "sealed";
		tainted: boolean;
		senders: { id: string; birth: ClaimProcessBirth; kind:ClaimSenderKind; retired: boolean }[];
		commands: { id: string; token: string; route: string; address:ClaimInputAddress; openedObligations:ClaimRestoreObligation[]; senderId: string; phase: "registered" | "permitted" | "executing" | "notStarted" | "clean" | "unknown"; receipt?: ClaimCleanupReceipt }[];
		focusFinalization?:ClaimFocusFinalization;
		restorations:{senderId:string;commandId:string;obligation:ClaimRestoreObligation;phase:"pending"|"restoring"|"restored"|"resolved"|"unknown";receipt?:ClaimRestorationReceipt}[];
	};
}
export interface ClaimProcessAddress {
	process:ClaimProcessBirth;
	window?:number;
	bounds?:{x:number;y:number;width:number;height:number};
}
/** Address metadata only. No typed text, secrets, clipboard bytes or GUI labels. */
export type ClaimInputAddress = {schema:"mac-input-address-v1";operation:string}&(
	{kind:"process";owner:ClaimProcessAddress;target:ClaimProcessAddress}|
	{kind:"clipboard";clipboard:"general"}|
	{kind:"application";application:string}
);
export type ClaimSenderKind = "file_only" | "node_ax" | "ui_input";
export interface ClaimFocusBaseline {
 schema:"input-claim-focus-baseline-v1";scopeId:string;resource:"frontmost_application"|"keyboard_focus";
 reference:string;keyboardAtCapture:"present"|"absent";uiSender?:ClaimProcessBirth;
}
export interface ClaimFocusDestination {process:ClaimProcessBirth;reference:string}
export interface ClaimFocusObservation {
 schema:"input-claim-focus-observation-v1";id:string;scopeId:string;front:ClaimFocusDestination;
 keyboard:{status:"present";destination:ClaimFocusDestination}|{status:"absent"|"unreadable";destination:null};
}
export interface ClaimFocusResolution {
 restorationId:string;address:ClaimInputAddress;action:"no_write";
 reason:"already_at_original"|"preserve_current_destination"|"destination_ended";
}
export interface ClaimFocusFinalization {observation:ClaimFocusObservation;resolutions:ClaimFocusResolution[]}
export type ClaimRestoreObligation = {id:string;address:ClaimInputAddress}&(
 {kind:"clipboard";focusBaseline?:never}|{kind:"focus";focusBaseline:ClaimFocusBaseline}
);
export interface ClaimRestorationReceipt {schema:"input-claim-restoration-v1";complete:boolean;failed:boolean}
export interface ClaimCleanupReceipt {
	schema: "input-claim-cleanup-v2";
	pendingKeys: number;
	pendingButtons: number;
	failed: boolean;
	complete: boolean;
}

function pinBinding(value: ClaimStorageBinding): ClaimStorageBinding {
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const identity = (file: { device: string; inode: string } | undefined) => {
		const device = file?.device, inode = file?.inode;
		if (typeof device !== "string" || !/^-?(0|[1-9][0-9]{0,9})$/.test(device) ||
			typeof inode !== "string" || !/^[1-9][0-9]{0,19}$/.test(inode) ||
			BigInt(device) < -2_147_483_648n || BigInt(device) > 2_147_483_647n || BigInt(inode) > 18_446_744_073_709_551_615n) {
			throw new Error("invalid component storage file identity");
		}
		return Object.freeze({ device, inode });
	};
	if (!value) throw new Error("invalid component storage binding");
	const { format, componentOnly, storageId, directory, guardFile } = value;
	if (format !== 3 || componentOnly !== true || typeof storageId !== "string" || !uuid.test(storageId)) throw new Error("invalid v3 component storage binding; no automatic v1/v2 migration");
	// Read and copy once. Neither the argument nor a returned state aliases it.
	return Object.freeze({ format: 3, componentOnly: true, storageId, directory: identity(directory), guardFile: identity(guardFile) });
}

/** File/process protocol component; only explicit test coordinators opt in.
 * A receipt here tests the protocol; it does not prove actual input was released.
 * Production needs a shared pinned directory and every sender's begin/finally hooks.
 */
export class ComponentInputClaims {
	private readonly helper: JsonHelper;
	readonly #directory: string;
	#binding: ClaimStorageBinding | undefined;
	constructor(directory: string, binding?: ClaimStorageBinding) {
		this.#directory = directory;
		if (process.platform !== "darwin") throw new Error("input-claim component requires macOS");
		const binary = fileURLToPath(new URL("../native/darwin-universal/input-claim", import.meta.url));
		const source = fileURLToPath(new URL("../native/input-claim.swift", import.meta.url));
		const manifest = JSON.parse(readFileSync(binary + ".json", "utf8")) as { format: number; sourceSha256: string; binarySha256: string; architectures: string[] };
		const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
		if (manifest.format !== 1 || !manifest.architectures.includes(process.arch) || manifest.sourceSha256 !== sha(source) || manifest.binarySha256 !== sha(binary)) {
			throw new Error("bundled input-claim component is missing or does not match this release");
		}
		this.helper = new JsonHelper(binary, ["--component-only", directory]);
		this.#binding = binding === undefined ? undefined : pinBinding(binding);
	}
	async initialize(): Promise<ClaimState> {
		if (this.#binding) throw new Error("component already has an original storage binding");
		const state = await this.call({ op: "initialize" });
		this.#binding = pinBinding(state.binding);
		return state;
	}
	get directory(): string { return this.#directory; }
	get domain(): string {
		if (!this.#binding) throw new Error("candidate input claims require an initialized original binding");
		const {directory} = this.#binding;
		return `component:${directory.device}:${directory.inode}`;
	}
	private async reply(command: Record<string, unknown>,timeoutMs=5000,beforeDispatch?:AbortSignal): Promise<Record<string, unknown>> {
		if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>5000)throw new Error("invalid bounded claim transaction deadline");
		// Binding cannot be overridden by a request. No tickets or secrets in argv.
		// Fixed file-only transport must still finish after the business lease is sealed.
		// AX callbacks never pass through this scope exit.
		const reply = await outsideInputScope(() => this.helper.send({ ...command, binding: this.#binding }, timeoutMs,true,undefined,undefined,undefined,{expiresAt:performance.now()+timeoutMs,...(beforeDispatch?{beforeDispatch}:{})}));
		if (reply.componentOnly !== true || !reply.state || typeof reply.state !== "object") throw new Error("invalid component claim response");
		return reply;
	}
	async call(command: Record<string, unknown>,timeoutMs=5000,beforeDispatch?:AbortSignal): Promise<ClaimState> { return (await this.reply(command,timeoutMs,beforeDispatch)).state as ClaimState; }
	isRevisionConflict(error:unknown):boolean {return error instanceof HelperResponseError&&error.reply.componentOnly===true&&error.reply.code==="revision_conflict";}
	isUnsentCancellation(error:unknown,signal:AbortSignal):boolean{return error instanceof HelperAdmissionError&&error.reason==="aborted"&&signal.aborted&&error.cause===signal.reason;}
	async processIdentity(pid: number): Promise<ClaimProcessBirth> {
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("actual AX process id is missing or invalid; no input was sent");
		const reply = await this.reply({op:"processIdentity",processPid:pid});
		const birth = reply.processBirth as ClaimProcessBirth | undefined;
		if (!birth || birth.schema !== "macos-kinfo-starttime-v1" || birth.pid !== pid) throw new Error("invalid native process identity");
		return birth;
	}
	get pid(): number | null { return this.helper.pid; }
	close(): Promise<void> { return outsideInputScope(() => this.helper.dispose()); }
}
