import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export interface MouseProbeOptions {
	throwAfter?: { kind: string; occurrence: number };
	throwBeforeDown?: boolean;
	rejectDownValidationAt?: number;
	switchDuringUpCreation?: boolean;
	switchDuringCreation?:"down"|"drag";
	failUp?: boolean;
	wait?: "eof" | "pipe-eof" | "reentrant-command" | "error" | "new-birth" | "other-front" | "pointer-moved" | "buttons-changed" | "button-repressed";
	interruptAt?: number;
}
export interface MouseEvent { kind: string; x: number; y: number; target: number; route: "PID" | "HID" }

/** Actual production mouse, gesture, ledger and reply code. Quartz/AX are array
 * models only; this never loads AppKit, touches the desktop or posts input. */
export function mouseProbe(options: MouseProbeOptions = {}) {
	const source = readFileSync(new URL("../../src/pointer-mac.ts", import.meta.url), "utf8");
	const mouseStart = source.indexOf("const TYPES ="), mouseEnd = source.indexOf("// Keyboard text", mouseStart);
	const keysStart = source.indexOf("const inputKeys ="), performEnd = source.indexOf('let buffer = ""', keysStart);
	const dataStart = source.indexOf('implementation: n => {', source.indexOf('"onData:":')), dataEnd = source.indexOf('\n} } } });', dataStart);
	const finishStart = source.indexOf("function finishHelper()"), finishEnd = source.indexOf("ObjC.registerSubclass", finishStart);
	for (const index of [mouseStart, mouseEnd, keysStart, performEnd, dataStart, dataEnd, finishStart, finishEnd]) assert.ok(index > 0);
	const events: MouseEvent[] = [], attempts: MouseEvent[] = [], records: Record<string, unknown>[] = [], lifecycle: string[] = [], held = new Set<string>(), trace: {kind:string;x?:number;y?:number}[]=[];
	let birth = "original", front = 30, position = { x: 10, y: 20 }, buttons = 0, waits = 0, sequence = 0,validatedDowns=0;
	const counts = new Map<string, number>();
	const hardwareCounters=new Map<number,number>();
	type Event = { type: number; location: { x: number; y: number } };
	const kinds: Record<number, string> = { 1: "down", 2: "up", 3: "rdown", 4: "rup", 5: "move", 6: "drag" };
	const types: Record<string, number> = { down: 1, up: 2, rdown: 3, rup: 4, move: 5, drag: 6 };
	const verify = (c: { instance: string }) => { if (c.instance !== birth) throw new Error("original process generation changed"); };
	const post = (route: "PID" | "HID", target: number, e: Event) => {
		const kind = kinds[e.type]!, event = { kind, x: e.location.x, y: e.location.y, target, route }; attempts.push(event);
		if ((kind === "up" || kind === "rup") && options.failUp) throw new Error("injected mouse up failed");
		if ((kind === "down" || kind === "rdown") && options.throwBeforeDown) throw new Error("down bridge threw before applying input");
		events.push(event);trace.push({kind,x:event.x,y:event.y});
		const button = kind.startsWith("r") ? "right" : "left", key = target + ":" + button;
		if (kind === "down" || kind === "rdown") held.add(key);
		if (kind === "up" || kind === "rup") held.delete(key);
		if (route === "HID") { position = { ...e.location }; if (kind === "down") buttons = 1; if (kind === "up") buttons = 0; }
		const occurrence = (counts.get(kind) ?? 0) + 1; counts.set(kind, occurrence);
		if (options.throwAfter?.kind === kind && options.throwAfter.occurrence === occurrence) throw new Error("post applied " + kind + " then threw");
	};
	let api: { raw(text: string): void; finish(): void },armed=true;
	const deliver=(text:string)=>{assert.equal(armed,true,"stdin must be rearmed during a gesture");armed=false;api.raw(text);};
	const context: Record<string, unknown> = {
		helperClosing: false, activeCommand: null, inputSent: false, inputPointer: null, deadline: 0, guard: null, at: null, shownOn: -1,
		FLAGS: {}, workspace: { get frontmostApplication() { return { processIdentifier: front }; } },
		checkGuard: () => { if (context.helperClosing) throw new Error("input controller closed"); },
		verifyProcess: verify, windowRecord: verify, verifyKeyWindow: () => {}, stamp: (event: Event, c: { instance: string }) => {verify(c);if([1,3].includes(event.type)&&++validatedDowns===options.rejectDownValidationAt)throw new Error("validation refused before posting down");},
		resolveInputTarget: (c: unknown) => c, axAttribute: (element: unknown) => element, Ref: () => [], ObjC: { castRefToObject: (value: unknown) => value },
		think: () => {}, clipRestore: () => {lifecycle.push("restore");trace.push({kind:"restore"});}, input: {get readInBackgroundAndNotify(){assert.equal(armed,false);armed=true;return undefined;}}, handler: {},
		reply: (value: Record<string, unknown>) => records.push(JSON.parse(JSON.stringify(value))),
		wait: () => {
			if (++waits !== (options.interruptAt ?? 1)) return;
			if(options.wait==="pipe-eof"||options.wait==="reentrant-command"){
				trace.push({kind:options.wait==="pipe-eof"?"eof":"command"});
				deliver(options.wait==="pipe-eof"?"":JSON.stringify({id:99,op:"ping"})+"\n");return;
			}
			if (options.wait === "eof") { context.helperClosing = true; throw new Error("input controller closed"); }
			if (options.wait === "error") throw new Error("injected RunLoop failure");
			if (options.wait === "new-birth") birth = "replacement";
			if (options.wait === "other-front") front = 30;
			if (options.wait === "pointer-moved") position = { x: 300, y: 400 };
			if (options.wait === "buttons-changed") buttons = 2;
			if(options.wait==="button-repressed"){hardwareCounters.set(1,1);hardwareCounters.set(2,1);buttons=1;}
		},
		$: Object.assign((value: unknown) => value, {
			NSData: { alloc: { initWithBase64EncodedStringOptions: (kind: string) => ({ kind }) } },
			CGEventCreateFromData: (_source: unknown, data: { kind: string }) => ({ type: types[data.kind], location: { x: 0, y: 0 } }),
			CGEventCreateMouseEvent: (_source: unknown, type: number, point: { x: number; y: number }) => {if(type===2&&options.switchDuringUpCreation||options.switchDuringCreation&&type===types[options.switchDuringCreation])front=30;return { type, location: { ...point } };},
			CGEventGetType: (event: Event) => event.type, CGEventSetIntegerValueField: () => {}, CGEventSetTimestamp: () => {}, CGEventSetFlags: () => {},
			CGEventSourceCreate: (state:number)=>{assert.equal(state,-1);return {privateSource:true};},CGEventSourceCounterForEventType:(state:number,type:number)=>{assert.equal(state,1);return hardwareCounters.get(type)??0;},
			CGEventSetLocation: (event: Event, point: { x: number; y: number }) => { event.location = { ...point }; },
			CGEventPostToPid: (pid: number, event: Event) => post("PID", pid, event), CGEventPost: (_tap: unknown, event: Event) => post("HID", front, event),
			CGEventCreate: () => ({ location: { ...position } }), CGEventGetLocation: (event: Event) => event.location,
			AXUIElementCreateSystemWide: () => ({}), AXUIElementCopyElementAtPosition: (_system: unknown, _x: number, _y: number, result: unknown[]) => { result[0] = {}; return 0; },
			AXUIElementGetPid: (_element: unknown, result: number[]) => { result[0] = front; return 0; },
			_AXUIElementGetWindow: (_element: unknown, result: number[]) => { result[0] = 100; return 0; },
			NSProcessInfo: { processInfo: { systemUptime: 100, processIdentifier: 999 } }, NSEvent: { get pressedMouseButtons() { return buttons; } },
			NSString: { alloc: { initWithDataEncoding: (data: { text: string }) => ({ js: data.text }) } }, NSUTF8StringEncoding: 4,
			NSTimer: { scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats: () => null }, exit: (status: number) => { lifecycle.push("exit:" + status);trace.push({kind:"exit"}); throw new Error("own-helper-exit:" + status); },
		}),
	};
	api = runInNewContext(`(()=>{${source.slice(mouseStart, mouseEnd)};${source.slice(keysStart, performEnd)};let buffer='',idle=null,pendingCommand=null;${source.slice(finishStart, finishEnd)}const onData=${source.slice(dataStart + 'implementation: '.length, dataEnd)}\n};return {raw(text){onData({userInfo:{objectForKey:()=>({length:text.length,text})}});},finish:finishHelper};})()`, context) as typeof api;
	return { events, attempts, records, held, lifecycle,trace,
		finish: () => api.finish(),
		send(op: "click" | "drag" | "ping" | "release_pointer", changes: Record<string, unknown> = {}) {
			const id = ++sequence, command = { id, op, pid: 10, instance: "original", window: 100, bounds: { x: 0, y: 0, width: 500, height: 500 }, x: 10, y: 20, x2: 130, y2: 140, cursor: false, routeToken: "own-mouse-array-route-123", nativeEvents: Object.fromEntries(Object.keys(types).map(kind => [kind, kind])), ...changes };
			if (changes.foregroundAuthorized) front = 10;
			deliver(JSON.stringify(command) + "\n");
			if (records.at(-1)?.kind === "input-route") deliver(JSON.stringify({ op: "route_ack", id, routeToken: command.routeToken, route: records.at(-1)!.route }) + "\n");
			return records.at(-1)!;
		},
	};
}
