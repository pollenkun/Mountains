import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { decodePng } from "./image.ts";
import { MacCapture } from "./capture-mac.ts";
import { MacWindowServer, type PopupChoice, type StatusItem, type StatusItemResult } from "./window-server-mac.ts";
import { MacPointer } from "./pointer-mac.ts";
import { appLauncher, parseAppLaunchReceipt, requiresManagedChromeLaunch, MANAGED_CHROME_LAUNCH_MESSAGE, type AppLaunchReceipt } from "./launcher-mac.ts";
import { interruptedInputTarget, interruptedPointer, PointerInputError, type NativeCommandRoute } from "./native-route.ts";
import { JsonHelper } from "./helper.ts";
import { currentInput } from "./coordinator.ts";
import { xa11yLoadError } from "./xa11y-load-error.ts";

/** What the model is told when the user used the app this action was driving. Codex does not end the turn. */
export function userInterventionReason(app: string): string {
	const name = app.replaceAll("'", "").trim() || "this app";
	return `The user changed '${name}'. Read the window again before sending more actions.`;
}

/**
 * The slice of a desktop accessibility library that computer use needs. The real one is xa11y
 * (macOS AXUIElement, Windows UI Automation, Linux AT-SPI2); tests use a fake desktop.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export class WindowUnavailableError extends Error {}

export interface UiElement {
	/** Actual AX handle owner; absent in old fake desktops. Never infer it from the host app. */
	readonly pid?: number | null;
	readonly role: string;
	readonly name: string | null;
	readonly value: string | null;
	readonly description: string | null;
	readonly stableId: string | null;
	readonly actions: string[];
	readonly bounds: Rect | null;
	readonly visible: boolean;
	readonly enabled: boolean;
	readonly focused: boolean;
	readonly active?: boolean;
	readonly selected: boolean;
	readonly checked: string | null;
	readonly expanded: boolean | null;
	readonly editable: boolean;
	readonly raw: Record<string, unknown>;
	children(): Promise<UiElement[]>;
	parent?(): Promise<UiElement | null>;
	press(): Promise<void>;
	focus(): Promise<void>;
	toggle(): Promise<void>;
	expand(): Promise<void>;
	collapse(): Promise<void>;
	select(): Promise<void>;
	increment(): Promise<void>;
	decrement(): Promise<void>;
	setValue(value: string): Promise<void>;
	typeText(text: string): Promise<void>;
	scrollIntoView(): Promise<void>;
	/** Select characters start..end (UTF-16 offsets); equal offsets place the caret. */
	selectText(start: number, end: number): Promise<void>;
	/** Run an action the element lists in `actions`, by name. */
	performAction(action: string): Promise<void>;
	/** Open the element's context menu (AXShowMenu). */
	showMenu(): Promise<void>;
}

export interface UiApp {
	readonly name: string;
	readonly pid: number | null;
	readonly isForeground: boolean;
	/** OS process start identity, so a reused PID cannot inherit a target. */
	readonly instance?: string;
	readonly bundleId?: string;
	readonly executableName?: string;
	windows(): Promise<UiElement[]>;
}

export interface WindowIdentity { id: string; bounds: Rect }

/** An image of one window, with a mapping from desktop points to image pixels. */
export interface Capture {
	readonly width: number;
	readonly height: number;
	/** RGBA, width * height * 4 bytes. */
	readonly pixels: Buffer;
	desktopRectToImage(rect: Rect): Rect[];
	imageToDesktop(x: number, y: number): [number, number];
	/** Menus, popovers and sheets of the same app drawn above the window, included in the image. */
	overlays?: number;
	windowId?: string;
	capturedAt?: number;
}

/** Pointer input at desktop points; it goes to one window, not to whatever lies under the user's pointer. */
export type Gesture = (
	| { kind: "click"; at: [number, number]; button?: "left" | "right"; count?: number }
	| { kind: "hover"; at: [number, number] }
	| { kind: "drag"; from: [number, number]; to: [number, number] }
	| { kind: "scroll"; at: [number, number]; dx: number; dy: number }
) & { /** Modifier keys held during it: "Meta", "Shift", "Alt", "Ctrl". */ held?: string[] };

/**
 * Platform adapter for exact-window observation, semantic operations and process-addressed input.
 * The tool layer verifies effects and guards the user's foreground and keyboard receiver.
 */
export interface Desktop {
	/** Native popup menus can own the user's keyboard while open. */
	menusMayTakeFocus?: boolean;
	readonly native?: boolean;
	/**
	 * What input this desktop takes. Absent or "all": everything screen_act has. "semantic" (Windows): only
	 * accessibility pattern actions on a numbered control (press, toggle, expand, collapse, select, set_value,
	 * increment, decrement, scroll_to_visible, and click where it becomes a press). Whatever needs the keyboard, the
	 * mouse, the clipboard, the foreground or a launch is refused before anything is sent.
	 */
	readonly inputs?: "all" | "semantic";
	/** Release only helpers owned by this desktop instance. No apps are terminated. */
	close?(): Promise<void>;
	apps(): Promise<UiApp[]>;
	windowIdentity?(app: UiApp, window: UiElement): Promise<WindowIdentity>;
	/** Bind observed editable controls to retained native AX objects before a later keyboard write. */
	retainTextReceivers?(app: UiApp, window: UiElement, receivers: UiElement[]): Promise<void>;
	beginInput?(app: UiApp): Promise<void>;
	/** Refresh the target's main-window role without activating or raising the app. */
	wakeApp?(app: UiApp): Promise<void>;
	/** byUser: the user's own input during the action explains the change. */
	endInput?(): Promise<{ unchanged: boolean; byUser?: boolean; reason?: string; frontChanged?: boolean; focusChanged?: boolean; restored?: boolean; attributionUnknown?: boolean; inputTargetPids?: number[]; inputRoutes?: NativeCommandRoute[]; inputRoutesComplete?: boolean }>;
	/** Prime the exact background window before a semantic AX action, without activation. */
	prepareInput?(app: UiApp, window: UiElement): Promise<void>;
	selection?(app: UiApp, window: UiElement, receiver: UiElement): Promise<[number, number] | null>;
	/** Values a provider cannot serialize, such as native NSDate-backed fields. */
	controlValues?(app: UiApp, window: UiElement, elements: UiElement[]): Promise<Map<UiElement,string>>;
	/** Recover the original case-sensitive AX name before dispatch on the retained element. */
	canonicalAction?(app:UiApp,window:UiElement,element:UiElement,action:string):Promise<string>;
	/** One window's own pixels, even where other windows cover it, at most `maxWidth` wide. */
	captureWindow(app: UiApp, window: UiElement, maxWidth: number, region?: Rect): Promise<Capture>;
	/** The app's menu bar commands, e.g. "File > Save" with ⌘S; they stand in for keyboard shortcuts. */
	menus(app: UiApp): Promise<MenuItem[]>;
	/** Press a menu command by its path without bringing the app forward. */
	pressMenu(app: UiApp, path: string, window?: UiElement): Promise<void>;
	/** Default input keeps the real pointer still. Explicitly authorized foreground drag may move it. */
	pointer(app: UiApp, window: UiElement, gesture: Gesture, realPointerAuthorized?: boolean): Promise<void>;
	/** A key or shortcut to the focused element of this window, e.g. ("s", ["Meta"]). */
	key(app: UiApp, window: UiElement, key: string, held: string[], foregroundAuthorized?: boolean, receiver?: UiElement): Promise<void>;
	text?(app: UiApp, window: UiElement, receiver: UiElement, text: string, range?: [number, number], foregroundAuthorized?: boolean): Promise<void>;
	/** Text typed at the keyboard focus of an app brought to the front with approval. */
	typeAtFocus?(app: UiApp, window: UiElement, text: string): Promise<void>;
	/** Move the on-screen cursor that shows the user where the model acts; no input. */
	showCursor(app: UiApp, window: UiElement, at: [number, number]): Promise<void>;
	/** Save the user's whole clipboard and put this content on it, for one paste. */
	clipboardSet(text: string, html?: string): Promise<void>;
	/** Put the saved clipboard back exactly. */
	clipboardRestore(): Promise<void | { restored: boolean; userChanged: boolean }>;
	/** Ask an app to expose its whole accessibility tree (Electron keeps web content hidden otherwise). */
	prepare(app: UiApp): Promise<void>;
	/** Names of installed apps, for the model to know what it can open. */
	installedApps(): Promise<string[]>;
	/** Resolve an installed filename, localized display name, or bundle identifier. */
	resolveInstalledApp?(name: string): Promise<{ name: string; bundleId: string; path: string } | null>;
	/** Request background startup and report observed foreground changes when supported. */
	launch(name: string): Promise<void | { bundleId: string; launchReceipt?: AppLaunchReceipt }>;
	/** Processes of Mountains' own helpers, never offered as apps. */
	ownPids(): number[];
	/** Keep a visible web-engine window drawing after other windows cover it. Never activates or moves it. */
	keepVisible?(app: UiApp, window: UiElement): Promise<string | undefined>;
	/** Choose one item of a native popup button without leaving its menu holding the keyboard. */
	popupSelect?(app: UiApp, window: UiElement, element: UiElement, choice: string): Promise<PopupChoice>;
	/** Menu bar status items of every app (Wi-Fi, VPN, input method, third-party icons). */
	menubarItems?(): Promise<StatusItem[]>;
	menubarAction?(item: StatusItem, path: readonly string[]): Promise<StatusItemResult>;
	/** Windows not on this screen (minimized, or on another desktop), and restoring a minimized one. */
	offscreenWindows?(app: UiApp): Promise<{ title: string; minimized: boolean }[]>;
	unminimize?(app: UiApp, title: string): Promise<boolean>;
	/** A file panel's field or button by identifier, through the window server's bounded requests. */
	panelField?(app: UiApp, window: UiElement, identifier: string, value?: string): Promise<string>;
	panelPress?(app: UiApp, window: UiElement, identifier: string): Promise<boolean>;
	/** The name a file panel shows for a folder. */
	displayName?(path: string): Promise<string>;
	/** Identity of the app's window that holds its keyboard focus (a sheet when one is open), or null. */
	activeWindow?(app: UiApp): Promise<string | null>;
	/** True when the app draws web pages (Chromium) and other windows cover all of its windows: Chromium stops drawing pages then. */
	coveredWeb?(app: UiApp): Promise<boolean>;
}

/** `shortcut` is written as menus show it, e.g. "⇧⌘Z"; `enabled` can be stale while the app is in the background. */
export interface MenuItem { path: string; shortcut: string | null; enabled: boolean }

/** Thrown when the operating system has not granted accessibility or screen recording. */
export class DesktopPermissionError extends Error {}

const MAC_PERMISSION = "macOS has not granted Accessibility (and, on macOS 26, Screen & System Audio Recording) to the app running Mountains";

/** Window numbers of a process, for capturing a window by number rather than the screen area it covers. */
const MAC_WINDOW_LIST = `ObjC.import("CoreGraphics"); ObjC.import("ApplicationServices");
ObjC.bindFunction("_AXUIElementGetWindow", ["int", ["id", "unsigned int *"]]);
function attr(el,name){const r=Ref();return $.AXUIElementCopyAttributeValue(el,$(name),r)===0?ObjC.castRefToObject(r[0]):null;}
function run(argv) {
	const pid = Number(argv[0]), list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID)), out = [];
    // CG retains closed windows. Intersect with the app's live AX windows/sheets
    // before matching geometry; a closed panel must not shadow its replacement.
    const live=new Set(),pending=[],windows=attr($.AXUIElementCreateApplication(pid),"AXWindows");
    for(let i=0;windows&&i<windows.count;i++)pending.push(windows.objectAtIndex(i));
    for(let i=0;i<pending.length;i++){
        if(i>=128)throw new Error("too many live accessibility windows");
        const w=pending[i],number=Ref();if($._AXUIElementGetWindow(w,number)===0)live.add(Number(number[0]));
        const children=attr(w,"AXChildren");for(let j=0;children&&j<children.count;j++){
            const child=children.objectAtIndex(j),role=attr(child,"AXRole");if(role&&String(role.js)==="AXSheet")pending.push(child);
        }
    }
	for (let i = 0; i < list.count; i++) {
		const w = ObjC.deepUnwrap(list.objectAtIndex(i));
		if (w.kCGWindowOwnerPID === pid && live.has(w.kCGWindowNumber)) out.push({ id: w.kCGWindowNumber, title: w.kCGWindowName || "", x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height });
	}
	return JSON.stringify(out);
}`;

// This process only lists windows. It never sends input or changes AX focus.
const MAC_WINDOW_READER = MAC_WINDOW_LIST.replace("function run(argv)", "function listWindows(argv)") + `
ObjC.import("Foundation");
function run(){
 const input=$.NSFileHandle.fileHandleWithStandardInput,output=$.NSFileHandle.fileHandleWithStandardOutput;let buffer="";
 for(;;){const data=input.readDataOfLength(1);if(Number(data.length)===0)return;buffer+=$.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding).js;if(!buffer.endsWith("\\n"))continue;
  let c={};try{c=JSON.parse(buffer);const windows=JSON.parse(listWindows([String(c.pid)]));output.writeData($(JSON.stringify({id:c.id,ok:true,windows})+"\\n").dataUsingEncoding($.NSUTF8StringEncoding));}
  catch(e){output.writeData($(JSON.stringify({id:c.id,ok:false,error:String(e.message||e)})+"\\n").dataUsingEncoding($.NSUTF8StringEncoding));}buffer="";
 }
}`;

/** Menus through the accessibility API, which reaches a background app's menu bar (xa11y shows only the front app's). */
const MAC_MENUS = `ObjC.import("ApplicationServices"); ObjC.import("Cocoa"); ObjC.import("CoreGraphics");
ObjC.bindFunction("_AXUIElementGetWindow", ["int", ["id", "unsigned int *"]]);
function attr(el, name) { const r = Ref(); return $.AXUIElementCopyAttributeValue(el, $(name), r) === 0 ? ObjC.castRefToObject(r[0]) : null; }
function str(el, name) { const v = attr(el, name); return v ? String(v.js ?? "") : ""; }
function kids(el) { const a = attr(el, "AXChildren"); const out = []; if (a) for (let i = 0; i < a.count; i++) out.push(a.objectAtIndex(i)); return out; }
function run(argv) {
	const bar = attr($.AXUIElementCreateApplication(Number(argv[0])), "AXMenuBar");
	if (!bar) return JSON.stringify({ error: "no menu bar" });
	const want = argv[1] === "press" ? argv[2] : null, items = [];
 const target = want && argv[3] ? JSON.parse(argv[3]) : null;
 const validate = () => {
  if(!target)throw new Error("menu dispatch requires an exact window");
  const running=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if(!running || running.isNil() || (running.launchDate && !running.launchDate.isNil() ? String(Number(running.launchDate.timeIntervalSince1970)) : "since-login")!==target.instance)throw new Error("menu process generation changed");
  // An app with no windows (Finder after its last window closed) takes app-wide commands such as New Window.
  if(target.window===undefined){if(attr($.AXUIElementCreateApplication(Number(argv[0])),"AXFocusedWindow"))throw new Error("the app opened a window; read it before using its menus");return;}
  const appEl=$.AXUIElementCreateApplication(Number(argv[0])),focused=attr(appEl,"AXFocusedWindow")||attr(appEl,"AXMainWindow"),id=Ref();
  if(!focused || $._AXUIElementGetWindow(focused,id)!==0 || Number(id[0])!==target.window)throw new Error("menu keyboard destination changed before dispatch");
  const windows=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(8,target.window));let found=false;
  for(let i=0;i<windows.count;i++){const w=ObjC.deepUnwrap(windows.objectAtIndex(i)),b=w.kCGWindowBounds;if(w.kCGWindowNumber===target.window && w.kCGWindowOwnerPID===Number(argv[0]))found=Math.abs(b.X-target.bounds.x)<=1&&Math.abs(b.Y-target.bounds.y)<=1&&Math.abs(b.Width-target.bounds.width)<=1&&Math.abs(b.Height-target.bounds.height)<=1;}
  if(!found)throw new Error("menu window moved or disappeared");
 };
	let pressed = null;
	const walk = (el, path, depth) => {
		for (const k of kids(el)) {
			if (pressed !== null || items.length >= 2000) return;
			const title = str(k, "AXTitle"), role = str(k, "AXRole");
			if (depth === 0 && title === "Apple") continue;
			const p = title ? [...path, title] : path;
			if (role === "AXMenuItem" && title && p.length > 1) {
				const full = p.join(" > ");
				if (want === full) {
					validate();
					const enabled = attr(k, "AXEnabled");
					// A disabled item still accepts AXPress and returns success, without doing anything.
					if (enabled && !enabled.js) { pressed = false; return; }
					pressed = $.AXUIElementPerformAction(k, $("AXPress"));
					return;
				}
				const ch = str(k, "AXMenuItemCmdChar"), enabled = attr(k, "AXEnabled"), m = attr(k, "AXMenuItemCmdModifiers");
				// Modifiers: 1 shift, 2 option, 4 control, 8 no command; written the way macOS menus show them.
				const mods = m ? Number(m.js) : 0;
				const shortcut = ch ? (mods & 4 ? "⌃" : "") + (mods & 2 ? "⌥" : "") + (mods & 1 ? "⇧" : "") + (mods & 8 ? "" : "⌘") + ch.toUpperCase() : null;
				if (!want) items.push({ path: full, shortcut, enabled: enabled ? !!enabled.js : true });
			}
			if (depth < 5 && (role === "AXMenuBarItem" || role === "AXMenu" || role === "AXMenuItem")) walk(k, p, depth + 1);
		}
	};
	walk(bar, [], 0);
	return JSON.stringify(want ? { pressed } : { items });
}`;

async function scopedCommand(command: string, args: string[], timeout: number): Promise<{ stdout: string }> {
    const lease = currentInput(); lease?.check();
    const pending=new Promise<{stdout:string}>((resolve, reject) => {
        let unwatch: (() => void) | undefined;
        let outcome:{stdout:string;error?:Error}|undefined;
        let stopReason:"timeout"|"lease"|undefined,stopping:Promise<void>|undefined,force:ReturnType<typeof setTimeout>|undefined;
        let resolveClosed!:()=>void;
        const closed=new Promise<void>(done=>{resolveClosed=done;});
        // The lease owns cancellation and waits for close. execFile's AbortSignal
        // callback can arrive before close and must not release the input claim early.
        const child = execFile(command, args, {}, (error, stdout, stderr) => {
            // The script's own error, not the command line (which carries the whole script).
            outcome=stopReason?{stdout,error:new Error(stopReason==="timeout"?"the helper timed out":"the helper was stopped because its input lease ended or was cancelled")}:error?{stdout,error:new Error(/Error: (?:Error: )?(.+?)(?: \(-?\d+\))?$/m.exec(String(stderr))?.[1] ?? `the helper failed (${error.code ?? error.signal})`)}:{stdout};
        });
        const terminate=(reason:"timeout"|"lease"):Promise<void>=>{
            if(stopping)return stopping;stopReason=reason;
            if(child.exitCode===null&&child.signalCode===null){
                child.kill("SIGTERM");
                force=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");},200);
            }
            return stopping=closed;
        };
        const timer=setTimeout(()=>{void terminate("timeout");},timeout);
        child.once("close",()=>{clearTimeout(timer);clearTimeout(force);unwatch?.();resolveClosed();if(!outcome)reject(new Error("the helper closed without a result"));else if(outcome.error)reject(outcome.error);else resolve({stdout:outcome.stdout});});
        unwatch = lease?.watch(()=>terminate("lease"));
    });
    lease?.track(pending);
    return pending;
}

/** `false` means the command was disabled. Anything other than `0` was not sent. */
export function menuPressFailure(pressed: unknown, path: string): string | undefined {
	if (pressed === false) return `menu command is disabled: ${JSON.stringify(path)}`;
	if (pressed === null || pressed === undefined) return `no menu command ${JSON.stringify(path)}; list them with screen_read menus`;
	if (pressed !== 0) return `the menu command did not run (accessibility error ${String(pressed)})`;
	return undefined;
}

async function macMenus(app: UiApp, press?: string, target?: { window?: number; instance: string; bounds?: Rect }): Promise<{ items?: MenuItem[]; pressed?: number | false | null; error?: string }> {
	if (app.pid === null) throw new Error(`${app.name} has no process id`);
	const { stdout } = await scopedCommand("osascript", ["-l", "JavaScript", "-e", MAC_MENUS, String(app.pid), ...(press ? ["press", press, JSON.stringify(target)] : [])], 20_000);
	return JSON.parse(stdout);
}

/** Process start times are independent of app names and survive title changes. `front` marks the app macOS
 * has in front: the accessibility focus can sit in another process (a sandboxed app's open panel) meanwhile. */
const MAC_INSTANCES = `ObjC.import("Cocoa");
const result = {}, list = $.NSWorkspace.sharedWorkspace.runningApplications;
for (let i = 0; i < list.count; i++) {
 const a = list.objectAtIndex(i), date = a.launchDate;
 // Apps started with the session (Finder, Dock) have no launch date; they are bound by process id alone.
 result[Number(a.processIdentifier)] = { instance: date && !date.isNil() ? String(Number(date.timeIntervalSince1970)) : "since-login", bundleId: String(a.bundleIdentifier.js || ""), executableName: a.executableURL && !a.executableURL.isNil() ? String(a.executableURL.lastPathComponent.js) : "", localizedName: String(a.localizedName.js || ""), ...(a.active ? { front: true } : {}) };
}
JSON.stringify(result);`;

/** The window number of the app's focused window, else its main window; 0 when it reports neither. */
const MAC_ACTIVE_WINDOW = `ObjC.import("ApplicationServices");
ObjC.bindFunction("_AXUIElementGetWindow", ["int", ["id", "unsigned int *"]]);
function run(argv) {
	const app = $.AXUIElementCreateApplication(Number(argv[0]));
	for (const name of ["AXFocusedWindow", "AXMainWindow"]) {
		const r = Ref(), id = Ref();
		if ($.AXUIElementCopyAttributeValue(app, $(name), r) === 0 && $._AXUIElementGetWindow(ObjC.castRefToObject(r[0]), id) === 0) return String(id[0]);
	}
	return "0";
}`;

/** "true" when every sizeable window of the process lies wholly under one window of another app (not Mountains' own). */
const MAC_COVERED = `ObjC.import("CoreGraphics");
function run(argv) {
	const pid = Number(argv[0]), own = argv.slice(1).map(Number), list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID));
	const above = [];
	let mine = 0, covered = 0;
	for (let i = 0; i < list.count; i++) {
		const w = ObjC.deepUnwrap(list.objectAtIndex(i)), b = w.kCGWindowBounds;
		if (w.kCGWindowLayer !== 0 || (w.kCGWindowAlpha ?? 1) < 1 || own.includes(w.kCGWindowOwnerPID)) continue;
		if (w.kCGWindowOwnerPID === pid) {
			if (b.Width < 100 || b.Height < 100) continue;
			mine++;
			if (above.some(a => a.X <= b.X && a.Y <= b.Y && a.X + a.Width >= b.X + b.Width && a.Y + a.Height >= b.Y + b.Height)) covered++;
		} else above.push(b);
	}
	return String(mine > 0 && covered === mine);
}`;

/** The window number macOS uses for this accessibility window, matched by process, position and title. */
async function macWindowIdentity(app: UiApp, window: UiElement, query: JsonHelper): Promise<{ id: number; bounds: Rect }> {
	const b = window.bounds;
	if (app.pid === null || !b) throw new Error(`${app.name}'s window has no position`);
	const listed = (await query.send({pid:app.pid},5_000)).windows as (Rect & { id: number; title: string })[];
	const near = (w: Rect) => Math.abs(w.x - b.x) <= 2 && Math.abs(w.y - b.y) <= 2 && Math.abs(w.width - b.width) <= 2 && Math.abs(w.height - b.height) <= 2;
	const candidates = listed.filter(near);
	const titled = candidates.filter(w => w.title === (window.name ?? ""));
	const matches = titled.length ? titled : candidates;
	if (matches.length > 1) throw new Error("window identity is ambiguous; no input was sent");
	const match = matches[0];
	if (!match) throw new WindowUnavailableError(`${app.name}'s window is not on this screen: minimized, or on another desktop, which Mountains does not switch to. Read the app again to see which`);
	return { id: match.id, bounds: b };
}

async function macCaptureWindow(app: UiApp, window: UiElement, maxWidth: number, region: Rect | undefined, server: MacWindowServer | null, stream: () => Promise<MacCapture | null>, query: JsonHelper): Promise<Capture> {
 const identity = await macWindowIdentity(app, window, query), area = region ?? identity.bounds;
 const dir = mkdtempSync(join(tmpdir(), "mountains-look-"));
 try {
  const file = join(dir, "window.png");
  // WindowServer's copy of the window: about 15-40 ms, works for covered windows and other Spaces.
  // Without it, the ScreenCaptureKit stream's frame from after this request.
  let frame = server ? await server.capture(identity.id, file).catch(() => null) : null;
  if (!frame) {
   const fallback = await stream();
   if (!fallback) throw new Error("no window capture is available; no shell screenshot fallback is used");
   // A helper that hangs is stopped at its deadline; one fresh start usually answers.
   frame = await fallback.frame(identity.id, file).catch(error => { if (!/timed out/.test(String(error))) throw error; return fallback.frame(identity.id, file); });
  }
  let image = decodePng(readFileSync(file));
  const current = await macWindowIdentity(app, window, query);
  if (current.id !== identity.id || JSON.stringify(current.bounds) !== JSON.stringify(identity.bounds)) throw new Error("window changed while captured; look again");
  const b = identity.bounds, sx = image.width / b.width, sy = image.height / b.height;
  if (region) {
   if (region.x < b.x || region.y < b.y || region.x + region.width > b.x + b.width || region.y + region.height > b.y + b.height) throw new Error("zoom is outside the exact window");
   const px = Math.round((region.x-b.x)*sx), py = Math.round((region.y-b.y)*sy);
   const width = Math.max(1, Math.min(image.width-px, Math.round(region.width*sx))), height = Math.max(1, Math.min(image.height-py, Math.round(region.height*sy)));
   const rgba = Buffer.alloc(width*height*4);
   for (let y=0; y<height; y++) image.rgba.copy(rgba, y*width*4, ((py+y)*image.width+px)*4, ((py+y)*image.width+px+width)*4);
   image = { width, height, rgba };
  }
  if (image.width > maxWidth) {
   const width = maxWidth, height = Math.max(1, Math.round(image.height*width/image.width)), rgba = Buffer.alloc(width*height*4);
   for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const source = (Math.min(image.height-1, Math.floor(y*image.height/height))*image.width + Math.min(image.width-1, Math.floor(x*image.width/width)))*4;
    image.rgba.copy(rgba, (y*width+x)*4, source, source+4);
   }
   image = { width, height, rgba };
  }
  const scaleX = image.width/area.width, scaleY = image.height/area.height;
  return { width:image.width, height:image.height, pixels:image.rgba, windowId:String(identity.id), capturedAt:frame.capturedAt,
   desktopRectToImage:r=>[{x:(r.x-area.x)*scaleX,y:(r.y-area.y)*scaleY,width:r.width*scaleX,height:r.height*scaleY}],
   imageToDesktop:(x,y)=>[area.x+x/scaleX,area.y+y/scaleY] };
 } finally { rmSync(dir, {recursive:true,force:true}); }
}

/** xa11y, loaded only when computer use is first used, so other sessions never load the native module. */
export async function xa11yDesktop(options: { cursorLabel?: string; cursorColor?: string; cursor?: boolean;phasedInput?:boolean } = {}): Promise<Desktop> {
	let x: typeof import("@crowecawcaw/xa11y");
	// A CommonJS package: under dynamic import everything sits on `default`.
	try { const mod = await import("@crowecawcaw/xa11y") as unknown as { default?: typeof import("@crowecawcaw/xa11y") }; x = mod.default ?? (mod as unknown as typeof import("@crowecawcaw/xa11y")); }
	catch (error) { throw xa11yLoadError(error); }
	const permission = (error: unknown): never => {
		if (error instanceof x.PermissionDeniedError || error instanceof x.AccessibilityNotEnabledError) {
			throw new DesktopPermissionError(process.platform === "darwin" ? MAC_PERMISSION : "the operating system has not granted accessibility access");
		}
		throw error;
	};
	const macOnly = () => { if (process.platform !== "darwin") throw new Error("pointer and key input are available on macOS only for now"); };
	const windowQuery=new JsonHelper("osascript",["-l","JavaScript","-e",MAC_WINDOW_READER]);
    const macWindowNumber=(app:UiApp,window:UiElement)=>{if(closed)throw new Error("desktop was closed");return macWindowIdentity(app,window,windowQuery);};
    let pointer: MacPointer | null = null;
    let closed = false, closing: Promise<void> | undefined;
	const prepared = new Set<number>();
	const helper = () => { if (closed) throw new Error("desktop input was closed"); return pointer ??= new MacPointer(options.cursorLabel ?? "Mountains",{phasedInput:options.phasedInput===true,...(options.cursorColor?{color:options.cursorColor}:{})}); };
	let capture: Promise<MacCapture | null> | null = null;
	// Opened on first use; a missing or mismatched binary leaves the older paths in place.
	let windowServer: Promise<MacWindowServer | null> | null = null;
	const server = () => (windowServer ??= process.platform === "darwin" ? MacWindowServer.open().catch(() => null) : Promise.resolve(null));
	// Scanning every app's menu bar can take seconds; it gets its own process so images and popups never wait on it.
	let menubarServer: Promise<MacWindowServer | null> | null = null;
	const scanner = () => (menubarServer ??= process.platform === "darwin" ? MacWindowServer.open().catch(() => null) : Promise.resolve(null));
    const installedCache=new Map<string,{at:number;value:{name:string;bundleId:string;path:string}}>();
	let clipboard: { items: string[][][]; changeCount?: number; token: string } | null = null;
	const receiverTokens = new WeakMap<UiElement, string>();
	const resolveInstalledApp = async (name: string): Promise<{name:string;bundleId:string;path:string} | null> => {
		if (process.platform !== "darwin") return null;
        const cached=installedCache.get(name.toLowerCase());if(cached&&Date.now()-cached.at<30000)return cached.value;
		const script = `ObjC.import("Cocoa");function run(argv){const q=argv[0].toLowerCase(),fm=$.NSFileManager.defaultManager,ws=$.NSWorkspace.sharedWorkspace,matches=[];
		const inspect=p=>{const b=$.NSBundle.bundleWithPath(p);if(!b||b.isNil()||!b.bundleIdentifier||b.bundleIdentifier.isNil())return;const id=b.bundleIdentifier.js,base=p.split("/").pop().replace(/\\.app$/i,""),display=fm.displayNameAtPath(p).js,local=b.localizedInfoDictionary;const aliases=[id,base,display];for(const k of ["CFBundleName","CFBundleDisplayName"]){const v=local&&!local.isNil()&&local.objectForKey(k);if(v&&!v.isNil())aliases.push(v.js);}if(aliases.some(x=>x.toLowerCase()===q)&&!matches.some(x=>x.path===p))matches.push({name:base,bundleId:id,path:p});};
		const direct=ws.URLForApplicationWithBundleIdentifier(argv[0]);if(direct&&!direct.isNil()){inspect(direct.path.js);if(matches.length===1)return JSON.stringify(matches[0]);}
		for(const dir of ["/Applications","/Applications/Utilities","/System/Applications","/System/Applications/Utilities",$.NSHomeDirectory().js+"/Applications"]){const entries=fm.contentsOfDirectoryAtPathError(dir,null);for(let i=0;entries&&!entries.isNil()&&i<entries.count;i++){const n=entries.objectAtIndex(i).js;if(n.endsWith(".app"))inspect(dir+"/"+n);}}
		if(matches.length>1)throw new Error("installed app is ambiguous; use its bundle identifier");return JSON.stringify(matches[0]||null);}`;
		const {stdout} = await scopedCommand("osascript",["-l","JavaScript","-e",script,name],15_000);
		const value=JSON.parse(stdout) as {name:string;bundleId:string;path:string}|null;
        if(value)for(const key of [name,value.name,value.bundleId])installedCache.set(key.toLowerCase(),{at:Date.now(),value});
        return value;
	};
	const receiverDescriptor = (receiver: UiElement, token: string) => ({ token, bounds: receiver.bounds!, stableId: receiver.stableId, value: receiver.value, axRole: String(receiver.raw.ax_role ?? "") });
	// xa11y's getters are snapshots. parent() re-queries the retained AX handle, so
	// a removed control cannot be rebound to a lookalike at the same tree position.
	const receiverIsAttached = async (app: UiApp, receiver: UiElement, windowId: number): Promise<boolean> => {
		let current: UiElement | null = receiver;
		for (let depth = 0; depth < 64 && current; depth++) {
			if (current.role === "window" || current.raw.ax_role === "AXSheet") return (await macWindowNumber(app, current)).id === windowId;
			if (!current.parent) return false;
			current = await current.parent();
		}
		return false;
	};
	const boundReceiver = async (app: UiApp, receiver: UiElement, windowId: number) => {
		const token = receiverTokens.get(receiver);
		if (!token || !receiver.bounds || !await receiverIsAttached(app, receiver, windowId)) throw new Error("observed text receiver was replaced or cannot be retained; read the window again");
		return receiverDescriptor(receiver, token);
	};
	return {
        native: true,
        close() { currentInput()?.assertOpen();pointer?.assertClosable();closed = true; return closing ??= Promise.all([windowQuery.dispose(), pointer?.close(), capture?.then(value=>value?.close()), windowServer?.then(value=>value?.close()), menubarServer?.then(value=>value?.close())]).then(()=>{}); },
		menusMayTakeFocus:true,
        async retainTextReceivers(app, window, receivers) {
            if (process.platform !== "darwin" || app.pid === null || !receivers.length) return;
            const { id, bounds } = await macWindowNumber(app, window);
            const targets = [];
            for (const receiver of receivers) {
                receiverTokens.delete(receiver);
                if (receiver.bounds && await receiverIsAttached(app, receiver, id)) targets.push({ receiver, token: randomUUID() });
            }
            if (!targets.length) return;
            const result = await helper().send({ op: "retain_receivers", pid: app.pid, instance: app.instance!, window: id, bounds,
                receivers: targets.map(({ receiver, token }) => receiverDescriptor(receiver, token)) });
            const retained = new Set(result.retained as string[]);
            for (const { receiver, token } of targets) if (retained.has(token) && await receiverIsAttached(app, receiver, id)) receiverTokens.set(receiver, token);
        },
        async windowIdentity(app, window) {
            if (process.platform !== "darwin") throw new Error("exact native window identity is available on macOS only for now");
            const identity = await macWindowNumber(app, window);
            return { id: String(identity.id), bounds: identity.bounds };
        },
        async beginInput(app) { macOnly(); await helper().send({ op: "guard_start", pid: app.pid ?? 0 }); },
        async prepareInput(app, window) {
            macOnly();
            if (app.pid === null || !app.instance) throw new Error("input target has no process identity");
            const { id, bounds } = await macWindowNumber(app, window);
            await helper().send({ op:"prepare_key", pid:app.pid, instance:app.instance, window:id, bounds });
        },
        async selection(app, window, receiver) {
            if (process.platform !== "darwin" || app.pid === null || !receiver.bounds) return null;
            const { id, bounds } = await macWindowNumber(app, window);
            const target = await boundReceiver(app, receiver, id);
            const result = await helper().send({op:"selection",pid:app.pid,instance:app.instance!,window:id,bounds,receiver:target});
            const range = result.range;
            if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < 0 || range[1] < range[0] || range[1] > (receiver.value?.length ?? 0)) return null;
            return range as [number,number];
        },
		async controlValues(app,window,elements) {
			const controls=elements.filter(el=>el.raw.ax_role==="AXDateTimeArea"&&el.bounds);
			const values=new Map<UiElement,string>();
			if(!controls.length||process.platform!=="darwin"||app.pid===null)return values;
			const {id,bounds}=await macWindowNumber(app,window);
			const result=await helper().send({op:"date_values",pid:app.pid,instance:app.instance!,window:id,bounds,controls:controls.map(el=>({identifier:el.stableId??String(el.raw.ax_identifier??""),bounds:el.bounds!}))});
			if(Array.isArray(result.values))for(let i=0;i<controls.length;i++)if(typeof result.values[i]==="string")values.set(controls[i]!,result.values[i]);
			return values;
		},
		async canonicalAction(app,window,element,action) {
			if(process.platform!=="darwin")return action;
			if(app.pid===null||!element.bounds||typeof element.raw.ax_role!=="string")throw new Error("native action target lacks identity");
			const {id,bounds}=await macWindowNumber(app,window);
			const result=await helper().send({op:"canonical_action",pid:app.pid,instance:app.instance!,window:id,bounds,action,control:{role:element.raw.ax_role,identifier:element.stableId??String(element.raw.ax_identifier??""),bounds:element.bounds}});
			if(typeof result.action!=="string"||!result.action)throw new Error("the native action changed or is ambiguous; read the control again");
			return result.action;
		},
        async wakeApp(app) { macOnly(); if (app.pid !== null) await helper().send({ op: "wake", pid: app.pid }); },
        async endInput() {
            const reply = await helper().send({ op: "guard_end" });
            const routing={inputTargetPids:reply.inputTargetPids as number[],inputRoutes:reply.inputRoutes as NativeCommandRoute[],inputRoutesComplete:reply.inputRoutesComplete===true};
            if (reply.byUser === true) {
                const app = typeof reply.app === "string" ? reply.app : "this app";
                return { ...routing, unchanged: false, byUser: true, reason: userInterventionReason(app), frontChanged: reply.frontChanged === true, focusChanged: reply.focusChanged === true,restored:reply.restored===true,attributionUnknown:reply.attributionUnknown===true };
            }
            return { ...routing, unchanged: reply.unchanged === true, frontChanged: reply.frontChanged === true, focusChanged: reply.focusChanged === true, restored:reply.restored===true, attributionUnknown:reply.attributionUnknown===true, ...(typeof reply.reason === "string" && reply.unchanged !== true ? { reason: reply.reason } : {}) };
        },
		ownPids: () => (pointer?.pid ? [pointer.pid] : []),
		async keepVisible(app, window) {
			if (process.platform !== "darwin" || app.pid === null || closed) return undefined;
			const ws = await server();
			if (!ws) return undefined;
			const { id } = await macWindowNumber(app, window);
			// Mountains' own cursor overlays sit above every window; they never hide a page.
			return ws.keepVisible(app.pid, id, [process.pid, ...(pointer?.pid ? [pointer.pid] : [])]);
		},
		async offscreenWindows(app) {
			if (process.platform !== "darwin" || app.pid === null || closed) return [];
			const ws = await server();
			return ws ? ws.offscreenWindows(app.pid).catch(() => []) : [];
		},
		async unminimize(app, title) {
			macOnly();
			const ws = await server();
			if (!ws || app.pid === null) throw new Error("the window server is unavailable; no window was restored");
			return ws.unminimize(app.pid, title);
		},
		async panelField(app, window, identifier, value) {
			macOnly();
			const ws = await server();
			if (!ws || app.pid === null) throw new Error("the window server is unavailable; nothing was typed");
			const { id } = await macWindowNumber(app, window);
			return ws.panelField(app.pid, id, identifier, value);
		},
		async panelPress(app, window, identifier) {
			macOnly();
			const ws = await server();
			if (!ws || app.pid === null) throw new Error("the window server is unavailable; nothing was pressed");
			const { id } = await macWindowNumber(app, window);
			return ws.panelPress(app.pid, id, identifier);
		},
		async displayName(path) {
			const ws = process.platform === "darwin" ? await server() : null;
			return ws ? ws.displayName(path).catch(() => "") : "";
		},
		async menubarItems() {
			macOnly();
			const ws = await scanner();
			if (!ws) throw new Error("the window server is unavailable");
			return ws.menubarList([process.pid, ...(pointer?.pid ? [pointer.pid] : [])]);
		},
		async menubarAction(item, path) {
			macOnly();
			const ws = await scanner();
			if (!ws) throw new Error("the window server is unavailable; nothing was opened");
			return ws.menubarAction(item, path);
		},
		async popupSelect(app, window, element, choice) {
			macOnly();
			if (app.pid === null || !element.bounds) throw new Error("the popup has no process or position");
			const ws = await server();
			if (!ws) throw new Error("the window server is unavailable; no choice was sent");
			const { id } = await macWindowNumber(app, window);
			return ws.popupSelect(app.pid, id, element.bounds, choice);
		},
		async clipboardSet(text, html) {
			macOnly();
			const before = await helper().send({ op: "clip_read" });
            clipboard = { items: before.items as string[][][], token:randomUUID() };
            const after = await helper().send({ op: "clip_set", text, ...(html ? { html } : {}), changeCount: Number(before.changeCount),token:clipboard.token });
            clipboard.changeCount = Number(after.changeCount);
		},
		async clipboardRestore() {
			if (process.platform !== "darwin") return;
			const result = await helper().send({ op: "clip_restore", ...(clipboard ?? {}) });
			clipboard = null;
			return { restored: result.restored === true, userChanged: result.userChanged === true };
		},
		async prepare(app) {
			if (process.platform !== "darwin" || app.pid === null || prepared.has(app.pid)) return;
			prepared.add(app.pid);
			// AXManualAccessibility is Electron's documented switch; other apps ignore the unknown attribute.
			await promisify(execFile)("osascript", ["-l", "JavaScript", "-e", `ObjC.import("ApplicationServices"); $.AXUIElementSetAttributeValue($.AXUIElementCreateApplication(${app.pid}), $("AXManualAccessibility"), $(true));`]).catch(() => {});
		},
		async activeWindow(app) {
			if (process.platform !== "darwin" || app.pid === null) return null;
			const out = await promisify(execFile)("osascript", ["-l", "JavaScript", "-e", MAC_ACTIVE_WINDOW, String(app.pid)], { timeout: 5000 });
			const id = Number(out.stdout.trim());
			return id > 0 ? String(id) : null;
		},
		async coveredWeb(app) {
			if (process.platform !== "darwin" || app.pid === null) return false;
			const run = promisify(execFile);
			// Chromium draws pages in renderer processes it starts itself.
			const renderer = await run("pgrep", ["-P", String(app.pid), "-f", "--", "--type=renderer"]).then(() => true, () => false);
			if (!renderer) return false;
			const out = await run("osascript", ["-l", "JavaScript", "-e", MAC_COVERED, String(app.pid), ...(pointer?.pid ? [String(pointer.pid)] : [])]).catch(() => null);
			return out?.stdout.trim() === "true";
		},
		resolveInstalledApp,
		async installedApps() {
			if (process.platform !== "darwin") return [];
			const dirs = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")];
			const names = new Set<string>();
			for (const dir of dirs) {
				try { for (const entry of readdirSync(dir)) if (entry.endsWith(".app")) names.add(entry.slice(0, -4)); } catch { /* missing folder */ }
			}
			return [...names].sort((a, b) => a.localeCompare(b));
		},
        async launch(name) {
            if (process.platform !== "darwin") throw new Error("opening apps is available on macOS only for now");
            currentInput()?.check();
			const installed = await resolveInstalledApp(name);
			if (!installed) throw new Error(`no installed app matches ${JSON.stringify(name)}`);
			if (requiresManagedChromeLaunch(installed.bundleId)) throw new Error(MANAGED_CHROME_LAUNCH_MESSAGE);
			const {stdout} = await scopedCommand(appLauncher(),["--watch","2",installed.path],20_000);
			return {bundleId:installed.bundleId,launchReceipt:parseAppLaunchReceipt(stdout)};
        },
		async pointer(app, window, gesture, realPointerAuthorized = false) {
			macOnly();
			if (realPointerAuthorized && gesture.kind !== "drag") throw new Error("real pointer input is available only for explicitly authorized drag");
			if (app.pid === null) throw new Error(`${app.name} has no process id`);
			const { id, bounds } = await macWindowNumber(app, window);
			const base = { pid: app.pid, instance: app.instance!, window: id, bounds, cursor: options.cursor !== false, ...(gesture.held?.length ? { held: gesture.held } : {}) };
            try {
			if (gesture.kind === "click") await helper().send({ op: "click", ...base, x: gesture.at[0], y: gesture.at[1], button: gesture.button ?? "left", count: gesture.count ?? 1 });
			else if (gesture.kind === "hover") await helper().send({ op: "hover", ...base, x: gesture.at[0], y: gesture.at[1] });
			else if (gesture.kind === "drag") await helper().send({ op: "drag", ...base, x: gesture.from[0], y: gesture.from[1], x2: gesture.to[0], y2: gesture.to[1], foregroundAuthorized: realPointerAuthorized });
			else await helper().send({ op: "scroll", ...base, x: gesture.at[0], y: gesture.at[1], dx: gesture.dx, dy: gesture.dy });
            } catch (error) {
                // Only the helper's normal finally owns a real-pointer release.
                // Its disappearance does not prove that a currently held button is ours.
                if ((gesture.kind === "click" || gesture.kind === "drag") && error instanceof PointerInputError && error.inputMayHaveBeenSent) {
                    if (realPointerAuthorized) {
                        throw error;
                    }
                    const cleanup=interruptedPointer(error);
                    if (cleanup) {
                        await helper().send({ op: "release_pointer", ...cleanup.target, x: cleanup.at[0], y: cleanup.at[1], button: cleanup.button, cursor: false }).catch(() => {});
                    }
                }
                throw error;
            }
		},
		async key(app, window, key, held, foregroundAuthorized = false, receiver) {
			macOnly();
			if (app.pid === null) throw new Error(`${app.name} has no process id`);
			const { id, bounds } = await macWindowNumber(app, window);
			const target = receiver ? await boundReceiver(app, receiver, id) : undefined;
			try { await helper().send({ op: "key", pid: app.pid, instance: app.instance!, window: id, bounds, key, held, foregroundAuthorized, ...(target ? { receiver: target } : {}) }); }
            catch (error) {
                const address=interruptedInputTarget(error);
                if (!address) throw error;
                // A foreground key-down can close its own dialog. Release only our
                // synthetic key even when that exact window no longer exists.
                if (foregroundAuthorized) {
                    await helper().send({ op: "release_key", ...address, key, held: [], foregroundAuthorized: true }).catch(() => {});
                    throw error;
                }
                await helper().send({ op: "release_key", ...address, key, held: [] }).catch(() => {});
                throw error;
            }
		},
        async text(app, window, receiver, text, range, foregroundAuthorized = false) {
            macOnly();
            if (app.pid === null || !receiver.bounds) throw new Error("text receiver lacks exact identity or bounds");
            const { id, bounds } = await macWindowNumber(app, window);
            const target = await boundReceiver(app, receiver, id);
            try {
                await helper().send({ op: "text", pid: app.pid, instance: app.instance!, window: id, bounds, text, foregroundAuthorized,
                    receiver: { ...target, ...(range ? { range } : {}) } });
            } catch (error) {
                const address=interruptedInputTarget(error);
                if (address) {
                    await helper().send({ op: "release_key", ...address, key: "a", held: [], foregroundAuthorized }).catch(() => {});
                }
                throw error;
            }
        },
        async typeAtFocus(app, window, text) {
            macOnly();
            if (app.pid === null) throw new Error(`${app.name} has no process id`);
            const { id, bounds } = await macWindowNumber(app, window);
            try { await helper().send({ op: "type_focus", pid: app.pid, instance: app.instance!, window: id, bounds, text, foregroundAuthorized: true }); }
            catch (error) {
                const address=interruptedInputTarget(error);
                if (address) await helper().send({ op: "release_key", ...address, key: "a", held: [], foregroundAuthorized: true }).catch(() => {});
                throw error;
            }
        },
		async showCursor(app, window, at) {
			if (process.platform !== "darwin" || options.cursor === false) return;
			const { id } = await macWindowNumber(app, window);
			await helper().send({ op: "cursor", window: id, x: at[0], y: at[1] });
		},
		async apps() {
			try {
				const list = await x.App.list();
                const instances: Record<string, { instance?: string; bundleId: string; executableName: string; localizedName?: string; front?: boolean }> = process.platform === "darwin" ? JSON.parse((await promisify(execFile)("osascript", ["-l", "JavaScript", "-e", MAC_INSTANCES], { timeout: 10_000 })).stdout) : {};
				return list.map(app => {
					const known = app.pid !== null ? instances[app.pid] : undefined;
					const localized = known?.localizedName?.trim();
					const name = localized || app.name;
					return { name, pid: app.pid, isForeground: process.platform === "darwin" ? known?.front === true : app.isForeground, ...(known ? { ...(known.instance ? { instance: known.instance } : {}), bundleId: known.bundleId, executableName: known.executableName || app.name } : {}), windows: () => app.windows() as unknown as Promise<UiElement[]> };
				});
			} catch (error) { return permission(error); }
		},
		async menus(app) {
			if (process.platform !== "darwin") throw new Error("menus are available on macOS only for now");
			const result = await macMenus(app);
			if (result.error) throw new Error(`${app.name} has no menu bar to read`);
			return result.items ?? [];
		},
		async pressMenu(app, path, window) {
			if (process.platform !== "darwin") throw new Error("menus are available on macOS only for now");
            if (app.pid === null || !app.instance) throw new Error("menu target has no process identity");
            let target: { window?: number; instance: string; bounds?: Rect } = { instance: app.instance };
            if (window) {
                const { id, bounds } = await macWindowNumber(app, window);
                target = { window: id, instance: app.instance, bounds };
                await helper().send({ op: "prepare_key", pid: app.pid, window: id, instance: app.instance, bounds });
            }
			const result = await macMenus(app, path, target);
			if (result.error) throw new Error(`${app.name} has no menu bar`);
			const failure = menuPressFailure(result.pressed, path);
			if (failure) throw new Error(failure);
		},
		async captureWindow(app, window, maxWidth, region) {
            if (closed) throw new Error("desktop input was closed");
			if (process.platform === "darwin") return macCaptureWindow(app, window, maxWidth, region, await server(), () => (capture ??= MacCapture.open()), windowQuery);
			// Elsewhere this is the screen area under the window; not yet checked for covered windows.
			try {
				let shot = await x.screenshot({ element: window as never });
				if (shot.width > maxWidth) shot = shot.resize(maxWidth, Math.round(shot.height * maxWidth / shot.width));
				const taken = shot;
				return { width: taken.width, height: taken.height, pixels: taken.pixels, desktopRectToImage: rect => taken.desktopRectToImage(rect), imageToDesktop: (px, py) => taken.imageToDesktop(px, py) as [number, number] };
			} catch (error) { return permission(error); }
		},
	};
}
