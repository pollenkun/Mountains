/** These are addresses selected by the native helper, not proof of delivery.
 * Keep the original resolved address when releasing interrupted input. */
export interface NativeInputAddress {
	pid: number;
	instance: string;
	window: number;
	bounds: { x: number; y: number; width: number; height: number };
}
export interface NativeCommandRoute {
	schema: "mac-command-target-v1";
	op: string;
	owner: NativeInputAddress;
	target: NativeInputAddress;
}
export interface NativePointerPosition { x: number; y: number; button: "left" | "right"; released: boolean }
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid native command target record");
	return value as Record<string, unknown>;
}
function address(value: unknown): NativeInputAddress {
	const item = object(value), box = object(item.bounds);
	if (![item.pid, item.window].every(n => typeof n === "number" && Number.isSafeInteger(n) && n > 0)
		|| typeof item.instance !== "string" || !item.instance || item.instance.length > 256
		|| ![box.x, box.y, box.width, box.height].every(n => typeof n === "number" && Number.isFinite(n))
		|| (box.width as number) <= 0 || (box.height as number) <= 0) throw new Error("invalid native command target identity");
	return Object.freeze({ pid: item.pid as number, instance: item.instance, window: item.window as number,
		bounds: Object.freeze({ x: box.x as number, y: box.y as number, width: box.width as number, height: box.height as number }) });
}
/** Bind the side record to the actual queued command; never accept a new owner. */
export function nativeCommandRoute(value: unknown, command: NativeInputAddress & { op: string }): NativeCommandRoute {
	const item = object(value), owner = address(item.owner), target = address(item.target), expected = address(command);
	if (item.schema !== "mac-command-target-v1" || item.op !== command.op || JSON.stringify(owner) !== JSON.stringify(expected)) throw new Error("native command target belongs to a different command");
	return Object.freeze({ schema: "mac-command-target-v1", op: command.op, owner, target });
}
export class PointerInputError extends Error {
	readonly route: NativeCommandRoute | null;
	readonly inputMayHaveBeenSent: boolean;
	readonly pointer: NativePointerPosition | null;
	constructor(error: unknown, route: NativeCommandRoute | null, inputMayHaveBeenSent: boolean, lastPointer?: unknown) {
		const candidate=lastPointer&&typeof lastPointer==="object"&&!Array.isArray(lastPointer)?lastPointer as Record<string,unknown>:null;
		const pointer:NativePointerPosition|null=candidate&&typeof candidate.x==="number"&&Number.isFinite(candidate.x)&&typeof candidate.y==="number"&&Number.isFinite(candidate.y)
			&&(candidate.button==="left"||candidate.button==="right")&&typeof candidate.released==="boolean"&&(!("positionVerified" in candidate)||candidate.positionVerified===true)
			?Object.freeze({x:candidate.x,y:candidate.y,button:candidate.button,released:candidate.released}):null;
		super((error instanceof Error ? error.message : "native input helper failed")
			+ (inputMayHaveBeenSent && !route ? "; input target was not recorded; no release will be guessed, inspect the target before retrying" : "")
			+ (inputMayHaveBeenSent && route && ["click","drag"].includes(route.op) && !pointer ? "; button release is unverified; no drop position was guessed" : ""), { cause: error });
		this.route = route; this.inputMayHaveBeenSent = inputMayHaveBeenSent; this.pointer=pointer;
	}
}
export function interruptedInputTarget(error: unknown): NativeInputAddress | null {
	return error instanceof PointerInputError && error.inputMayHaveBeenSent ? error.route?.target ?? null : null;
}
export function interruptedPointer(error: unknown): { target: NativeInputAddress; at: [number,number]; button: "left"|"right" } | null {
	const target=interruptedInputTarget(error);
	return target&&error instanceof PointerInputError&&error.pointer&&!error.pointer.released
		?{target,at:[error.pointer.x,error.pointer.y],button:error.pointer.button}:null;
}
