import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/pointer-mac.ts", import.meta.url), "utf8");
const start = source.indexOf("let menuShortcutReady = null;");
const end = source.indexOf("// Paste:", start);
const keysStart=source.indexOf("const inputKeys ="),keysEnd=source.indexOf("const ROUTED_OPS=",keysStart);
assert.ok(start > 0 && end > start&&keysStart>0&&keysEnd>keysStart);

function fixture(menuEnabled?: boolean, stopAt = Infinity, confirm = false, exactWindow = true, unrelatedMenu = false) {
	const events: { key: number; down: boolean; flags: number; type?: number }[] = [];
	let presses = 0, checks = 0;
	const menu = { AXRole: "AXMenuItem", AXMenuItemCmdVirtualKey: 1, AXMenuItemCmdModifiers: 0, AXEnabled: menuEnabled };
	const bar = { AXRole: "AXMenuBar", AXChildren: [menu] };
	if (unrelatedMenu) {
		const file = { AXRole: "AXMenuBarItem", AXChildren: [{ AXRole: "AXMenu", AXChildren: [menu] }] };
		const edit = { AXRole: "AXMenuBarItem", get AXChildren(): unknown[] { throw new Error("unrelated menu was opened"); } };
		Object.assign(bar, { AXChildren: [file, edit] });
	}
	const receiver = {AXRole:"AXTextField"};
	const convert = (v: unknown): unknown => Array.isArray(v)
		? { count: v.length, objectAtIndex: (i: number) => v[i] }
		: v === undefined ? null : { js: v };
	const dollar = Object.assign((v: unknown) => v, {
		AXUIElementCreateApplication: () => menuEnabled === undefined ? null : bar,
		AXUIElementPerformAction: () => { presses++; return 0; },
		AXUIElementCopyActionNames: (_el:unknown,ref:unknown[]) => { ref[0]={count:1,objectAtIndex:()=>({js:"AXConfirm"})};return 0; },
		CFEqual:(a:unknown,b:unknown)=>a===b,
		NSMutableData: { dataWithLength: () => ({ mutableBytes: { pid: 42 } }) },
		GetProcessForPID: () => 0,
		CGEventCreateKeyboardEvent: (_source: unknown, key: number, down: boolean) => ({ key, down, flags: 0 }),
		NSProcessInfo: { processInfo: { systemUptime: 1 } },
		NSEvent: { keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode:
			(type: number, _location: unknown, flags: number, _time: number, window: number, _context: unknown, _characters: string, _plain: string, _repeat: boolean, key: number) => {
				assert.equal(window, 99);
				return { isNil: () => false, CGEvent: () => ({ key, down: type === 10, flags }) };
			} },
		CGEventSetFlags: (e: { flags: number }, flags: number) => { e.flags = flags; },
		CGEventSetType: (e: { type?: number }, type: number) => { e.type = type; },
		CGEventPostToPSN: (target: { pid: number }, event: typeof events[number]) => { assert.equal(target.pid, 42); events.push({ ...event }); },
		CGEventPost: () => { throw new Error("background input entered the global queue"); },
		CGEventPostToPid: () => { throw new Error("a shortcut fell back to ordinary character delivery"); },
	});
	const key = runInNewContext(`${source.slice(keysStart,keysEnd)};${source.slice(start, end)}; postMenuShortcut`, {
		$: dollar, Ref:()=>[], ObjC: { bindFunction: () => {},castRefToObject:(value:unknown)=>value },
		FLAGS: { Meta: 0x100000, Shift: 0x20000, Ctrl: 0x40000, Alt: 0x80000 }, KEYS: { s: 1 },
		axAttribute: (el: Record<string, unknown> | null, name: string) => name === "AXFocusedUIElement" && confirm ? receiver : name === "AXMenuBar" ? el : convert(el?.[name]),
		insideWindow:()=>exactWindow,
		elementRole: (el: { AXRole: string }) => el.AXRole,
		checkGuard: () => { if (++checks === stopAt) throw new Error("cancelled"); },
		exactAXWindow: () => null, windowRecord: () => {}, verifyKeyWindow: () => {}, verifyProcess:()=>{}, rejectKnownPaymentReceiver:()=>{}, stamp: () => {}, wait: () => {}, inputSent: false,
	}) as (c: { pid: number; window: number; key?:string }, code: number, flags: number) => boolean;
	return { key: (code: number, flags = 0, name?:string) => key({ pid: 42, window: 99,...(name?{key:name}:{}) }, code, flags), events, get presses() { return presses; } };
}

test("an enabled menu shortcut uses AX and never types its letter", () => {
	const f = fixture(true);
	assert.equal(f.key(1, 0x100000), true);
	assert.equal(f.presses, 1);
	assert.deepEqual(f.events, []);
});

test("a disabled shortcut sends neither a menu press nor a character", () => {
	const f = fixture(false);
	assert.throws(() => f.key(1, 0x100000), /disabled/);
	assert.equal(f.presses, 0);
	assert.deepEqual(f.events, []);
});

test("a shortcut does not open an unrelated menu before reaching its command", () => {
	const f = fixture(true, Infinity, false, true, true);
	assert.equal(f.key(1, 0x100000), true);
	assert.equal(f.presses, 1);
	assert.deepEqual(f.events, []);
});

test("dialog shortcuts keep modifiers and releases in the addressed process", () => {
	const f = fixture();
	f.key(5, 0x120000);
	assert.deepEqual(f.events.map(e => [e.key, e.down, e.flags, e.type ?? null]), [
		[55, true, 0x100000, 12], [56, true, 0x120000, 12],
		[5, true, 0x120000, null], [5, false, 0x120000, null],
		[56, false, 0x100000, 12], [55, false, 0, 12],
	]);
});

test("cancellation before the key still releases every modifier already pressed", () => {
	const f = fixture(undefined, 2);
	assert.throws(() => f.key(5, 0x120000), /cancelled/);
	assert.deepEqual(f.events.map(e => [e.key, e.down, e.flags]), [[55, true, 0x100000], [55, false, 0]]);
});

test("Return remains a key event even when a field advertises AXConfirm",()=>{
 const f=fixture(undefined,Infinity,true);
 assert.equal(f.key(36,0,"Enter"),true);
 assert.equal(f.presses,0);assert.deepEqual(f.events.map(e=>[e.key,e.down,e.flags]),[[36,true,0],[36,false,0]]);
 const cancelled=fixture(undefined,1,true);
 assert.throws(()=>cancelled.key(36,0,"Enter"),/cancelled/);assert.equal(cancelled.presses,0);assert.deepEqual(cancelled.events,[]);
});
