import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonHelper } from "./helper.ts";

/** Built at release time. It only serializes NSEvents, never posts input or activates apps. */
export class MacEventData {
	private readonly helper: JsonHelper;
	private constructor(helper: JsonHelper) { this.helper = helper; }
	static async open(): Promise<MacEventData> {
		if(process.platform!=="darwin"||!["arm64","x64"].includes(process.arch))throw new Error("native mouse serialization is available on supported macOS hosts only");
		const source=fileURLToPath(new URL("../native/event-data.swift",import.meta.url));
		const binary=fileURLToPath(new URL("../native/darwin-universal/event-data",import.meta.url));
		try{
			const manifest=JSON.parse(readFileSync(binary+".json","utf8")) as {format:number;sourceSha256:string;binarySha256:string;architectures:string[]};
			const sha=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
			if(manifest.format!==1||!manifest.architectures.includes(process.arch)||manifest.sourceSha256!==sha(source)||manifest.binarySha256!==sha(binary))throw new Error("native event serializer does not match this release");
		}catch(error){throw new Error(`The bundled native event serializer is missing or invalid. Reinstall the complete Mountains package. ${error instanceof Error?error.message:String(error)}`);}
		return new MacEventData(new JsonHelper(binary, []));
	}
	async mouse(window: number, held: readonly string[] = [], cancellable = true): Promise<Record<string, string>> {
		const masks: Record<string, number> = { Meta:0x100000, Shift:0x20000, Ctrl:0x40000, Alt:0x80000 };
		const reply = await this.helper.send({ window, flags:held.reduce((value, key) => value | (masks[key] ?? 0), 0) }, 15_000, cancellable);
		if (!reply.events || typeof reply.events !== "object") throw new Error("native event data was not returned");
		const events = reply.events as Record<string, unknown>;
		for (const kind of ["down", "up", "rdown", "rup", "move", "drag"]) {
			if (typeof events[kind] !== "string" || !events[kind]) throw new Error(`missing native ${kind} event data`);
		}
		return events as Record<string, string>;
	}
	close(): Promise<void> { return this.helper.dispose(); }
	async key(window:number,keyCode:number,characters:string,held:readonly string[]=[]):Promise<Record<string,string>>{
		const masks:Record<string,number>={Meta:0x100000,Shift:0x20000,Ctrl:0x40000,Alt:0x80000};
		const reply=await this.helper.send({window,keyCode,characters,flags:held.reduce((v,key)=>v|(masks[key]??0),0)});
		const events=reply.events as Record<string,unknown>|undefined;
		if(!events||typeof events.down!=="string"||typeof events.up!=="string")throw new Error("native keyboard event data was not returned");
		return events as Record<string,string>;
	}
}
