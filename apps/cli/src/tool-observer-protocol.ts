import { createHash } from "node:crypto";
import type { ToolObservationValue } from "@mountains/engine";

export const TOOL_OBSERVER_PROTOCOL = "mountains.tool-observer/1";
export type ObserverPhase = "start" | "model" | "before" | "after" | "finish";
export interface ObserverRequest {
	protocol: typeof TOOL_OBSERVER_PROTOCOL;
	kind: "request";
	id: string;
	phase: ObserverPhase;
	hash: string;
	payload: ToolObservationValue;
}
export interface ObserverReply {
	protocol: typeof TOOL_OBSERVER_PROTOCOL;
	kind: "reply";
	id: string;
	phase: ObserverPhase;
	hash: string;
	ok: boolean;
	receipt: ToolObservationValue;
}
export interface ObserverCancel {
	protocol: typeof TOOL_OBSERVER_PROTOCOL;
	kind: "cancel";
	id: string;
	phase: ObserverPhase;
	hash: string;
}
export type ObserverPacket = ObserverRequest | ObserverReply | ObserverCancel;
export const observerHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** No exception text crosses this boundary: input may contain secrets or hostile JS values. */
export function observerJson(value: unknown, maxBytes = 8 * 1024 * 1024): ToolObservationValue {
	try {
		const json = JSON.stringify(value);
		if (json === undefined || Buffer.byteLength(json) > maxBytes) throw null;
		const copy = JSON.parse(json) as ToolObservationValue;
		const freeze = (v: unknown): void => { if (v && typeof v === "object") { for (const item of Object.values(v)) freeze(item); Object.freeze(v); } };
		freeze(copy); return copy;
	} catch { throw new Error("Invalid tool observer JSON"); }
}
const phases = new Set(["start", "model", "before", "after", "finish"]);
export function observerPacket(value: unknown): ObserverPacket {
	const data = observerJson(value);
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid tool observer packet");
	const v = data as Record<string, unknown>;
	if (v.protocol !== TOOL_OBSERVER_PROTOCOL || typeof v.id !== "string" || !/^[a-f0-9-]{36}$/.test(v.id) ||
		typeof v.phase !== "string" || !phases.has(v.phase) || typeof v.hash !== "string" || !/^[a-f0-9]{64}$/.test(v.hash)) throw new Error("Invalid tool observer header");
	let keys: string[];
	if (v.kind === "request") {
		keys = ["protocol", "kind", "id", "phase", "hash", "payload"];
		if (observerHash({ phase: v.phase, payload: v.payload }) !== v.hash) throw new Error("Tool observer request hash mismatch");
	} else if (v.kind === "reply") {
		keys = ["protocol", "kind", "id", "phase", "hash", "ok", "receipt"];
		if (typeof v.ok !== "boolean" || !Object.hasOwn(v, "receipt") || !v.ok && v.receipt !== null) throw new Error("Invalid tool observer reply");
	} else if (v.kind === "cancel") keys = ["protocol", "kind", "id", "phase", "hash"];
	else throw new Error("Invalid tool observer kind");
	if (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))) throw new Error("Unexpected tool observer fields");
	return v as unknown as ObserverPacket;
}

export interface ObserverAgent { name: string; role: string; dataDir: string }
export interface ObserverStart {
	pid: number;
	runId: string;
	workspace: string;
	outDir: string;
	spendLedger: string;
	task: string;
	model: string;
	effectiveConfigSha256: string;
}
