import { randomUUID } from "node:crypto";
import type { Capture, Desktop, Rect, UiApp, UiElement, WindowIdentity } from "./backend.ts";
import { WindowUnavailableError } from "./backend.ts";
import { coordinatorFor, nativeCoordinator, type InputCoordinator } from "./coordinator.ts";
import { ElementIds, lineWithValue, readSnapshot, type Snapshot, type SnapshotEntry, isDropdown, type DropdownOwner,anchoredEntry,entryIdentity } from "./snapshot.ts";

export interface WindowTarget { handle: string; element: UiElement; identity: WindowIdentity }
export interface Observation {
	id: string; appKey: string; window: WindowTarget; tree: Snapshot; revision: string; revisionKey: string; windowSet: string; observedAt: number;
	root?: UiElement; rootPath?: string; dropdownOwner?: DropdownOwner; region?: Rect; consumed: boolean;
	/** Handles of sheets open on this window. */
	sheets?: string[];
}
export interface ImageObservation { id: string; observation: Observation; capture: Capture; region?: Rect }

export const appKey = (app: UiApp): string => `${app.pid ?? "unknown"}:${app.instance ?? app.name}`;
export const sameRect = (a: Rect | null, b: Rect | null): boolean => JSON.stringify(a) === JSON.stringify(b);
const objectIds = new WeakMap<object, string>();
function objectId(object: object): string { let id = objectIds.get(object); if (!id) { id = randomUUID(); objectIds.set(object, id); } return id; }

/** Observation receipts are local to one agent. Coordination/revisions are shared by the desktop. */
export class ComputerState {
	private loading: Promise<Desktop> | undefined;
	readonly observations = new Map<string, Observation>();
	readonly images = new Map<string, ImageObservation>();
	readonly refusedRoutes = new Set<string>();
	/** Windows already offered to the visibility keep-alive (or not web windows). */
	private readonly keptVisible = new Set<string>();
	private readonly drawing = new Set<string>();
	/** True once the window server pinned this window visible, so its page draws while covered. */
	keptDrawing(app: UiApp, handle: string): boolean { return this.drawing.has(`${appKey(app)}/${handle}`); }
    private readonly focusFailures=new Map<string,number>();
    recordFocusFailure(route:string):void {this.refusedRoutes.add(route);this.focusFailures.set(route,(this.focusFailures.get(route)??0)+1);}
    clearFocusFailures(route:string):void {this.refusedRoutes.delete(route);this.focusFailures.delete(route);}
    retryAfterRead(app:UiApp,fresh?:Observation):void {
        const route=appKey(app);
        if(!this.refusedRoutes.has(route)||(this.focusFailures.get(route)??0)>=3)return;
        for(const [id,view] of this.observations)if(view.appKey===route&&view!==fresh)this.observations.delete(id);
        for(const [id,image] of this.images)if(image.observation.appKey===route)this.images.delete(id);
        this.refusedRoutes.delete(route);
    }
	readonly foregroundWindows = new Map<string, string>();
	/** The window each sheet is attached to, by handle. */
	readonly sheetOf = new Map<string, string>();
	/** True when `window` is `active`, or a sheet on it (a sheet on a sheet included): the app reports the outer one as focused. */
	within(window: string, active: string | undefined): boolean {
		for (let h: string | undefined = window, n = 0; h && n < 16; h = this.sheetOf.get(h), n++) if (h === active) return true;
		return false;
	}
	/** Element numbers per window, kept across reads so that an action's result can list just what changed. */
	private readonly numbering = new Map<string, ElementIds>();
	private readonly factory: () => Promise<Desktop>;
	private readonly excluded: number[];
	private readonly coordinator: InputCoordinator | undefined;
	constructor(factory: () => Promise<Desktop>, excluded: number[], coordinator?: InputCoordinator) { this.factory = factory; this.excluded = excluded; this.coordinator = coordinator; }
	desktop(): Promise<Desktop> { return this.loading ??= this.factory(); }
	async scheduler(): Promise<InputCoordinator> { const d = await this.desktop(); return this.coordinator ?? (d.native ? nativeCoordinator : coordinatorFor(d)); }
	async apps(): Promise<UiApp[]> {
		const d = await this.desktop(), excluded = [...this.excluded, ...d.ownPids()];
		// A sandboxed app's open and save panels are drawn by this system service; they are read as sheets of the app that opened them.
		return (await d.apps()).filter(a => (a.pid === null || !excluded.includes(a.pid)) && a.bundleId !== "com.apple.appkit.xpc.openAndSavePanelService");
	}
	async app(query: string): Promise<UiApp> {
		const apps = await this.apps(), q = query.trim(), pid = /^\d+$/.test(q) ? Number(q) : /\(pid (\d+)\)/.exec(q)?.[1];
		let found = pid !== undefined ? apps.filter(a => a.pid === Number(pid)) : apps.filter(a => [a.name, a.bundleId, a.executableName].some(n => n?.toLowerCase() === q.toLowerCase()));
		if (!found.length && pid === undefined) found = apps.filter(a => a.name.toLowerCase().includes(q.toLowerCase()));
		if (!found.length) {
            const similar=apps.filter(a=>[a.name,a.executableName,a.bundleId].some(n=>n&&q.toLowerCase().split(/[ ._-]+/).some(part=>part.length>1&&n.toLowerCase().includes(part)))).slice(0,8);
            throw new Error(`no running app matches ${JSON.stringify(q)}; ${similar.length ? "similar names: "+similar.map(a=>`${a.name} (${a.pid})`).join(", ") : "screen_read without app lists running and installed apps"}`);
        }
		if (found.length !== 1) throw new Error(`app is ambiguous; use one exact PID: ${found.map(a => `${a.name} (${a.pid})`).join(", ")}`);
		return found[0]!;
	}
	async identity(app: UiApp, window: UiElement): Promise<WindowIdentity> {
		const d = await this.desktop();
		if (d.native && (!app.instance || app.pid === null)) throw new Error("the OS did not provide a process start identity; cannot bind this target safely");
		if (d.windowIdentity) return d.windowIdentity(app, window);
		if (!window.bounds) throw new Error("window has no geometry");
		// In-memory desktops retain real object identity; native adapters must implement windowIdentity.
		return { id: objectId(window), bounds: { ...window.bounds } };
	}
	async windows(app: UiApp): Promise<WindowTarget[]> {
		const out: WindowTarget[] = [];
		const pending: { element: UiElement; parent?: string }[] = (await app.windows()).map(element => ({ element }));
		for (let index = 0; index < pending.length; index++) {
			if (index >= 128) throw new Error("too many nested window sheets; cannot enumerate safely");
			const { element, parent } = pending[index]!;
			let identity:WindowIdentity;
			try {identity=await this.identity(app,element);}catch(error){if(error instanceof WindowUnavailableError)continue;throw error;}
			const children = await element.children();
			if (children.length === 1 && children[0]?.name === "WindowSharingSessionButton") continue;
			const handle = `w:${identity.id}`;
			// AppKit sheets are real windows but AXWindows only lists their parent.
			// Give each sheet its own receipt and keyboard destination.
			pending.push(...children.filter(child => child.raw.ax_role === "AXSheet").map(child => ({ element: child, parent: handle })));
			if (parent) this.sheetOf.set(handle, parent);
			else this.sheetOf.delete(handle);
			out.push({ handle, element, identity });
		}
		if (new Set(out.map(w => w.handle)).size !== out.length) throw new Error("several windows have the same identity; cannot choose one safely");
		return out;
	}
	async window(app: UiApp, handle?: string, observedWindows?: WindowTarget[]): Promise<WindowTarget> {
		const windows = observedWindows ?? await this.windows(app);
		const matches = handle ? windows.filter(w => w.handle === handle || w.identity.id === handle) : windows;
		if (matches.length !== 1) throw new Error(`choose one exact window with the window argument: ${windows.map(w => `${w.handle} ${JSON.stringify(w.element.name)}`).join(", ") || "none available"}`);
		return matches[0]!;
	}
	async observe(app: UiApp, window: WindowTarget, options: { offset?: number; root?: UiElement; rootPath?: string; dropdownOwner?: DropdownOwner; region?: Rect; full?: boolean } = {}, observedWindows?: WindowTarget[]): Promise<Observation> {
		const scheduler = await this.scheduler(), key = appKey(app), revisionKey = `${key}/${window.handle}`, revision = await scheduler.revision(revisionKey);
		// Reuse a window enumeration made by this same read/settle iteration.
		// The final identity check and every action still query the live OS.
		const all = observedWindows ?? await this.windows(app), windowSet = all.map(w => w.handle).sort().join(",");
		const desktop = await this.desktop();
		await desktop.prepare(app);
		// The first time a window is read while it is in view, a web engine's window is pinned visible, so its
		// page keeps drawing after other windows cover it. Best effort: a refusal never blocks the read.
		if (desktop.keepVisible && !this.keptVisible.has(revisionKey)) {
			this.keptVisible.add(revisionKey);
			const reason = await desktop.keepVisible(app, window.element).catch(() => undefined);
			if (reason === "covered") this.keptVisible.delete(revisionKey);
			if (reason === "pinned" || reason === "already") this.drawing.add(revisionKey);
		}
		let ids = this.numbering.get(revisionKey);
		if (!ids) { ids = new ElementIds(); this.numbering.set(revisionKey, ids); while (this.numbering.size > 64) this.numbering.delete(this.numbering.keys().next().value!); }
		const tree = await readSnapshot([window.element], ids, options);
		await this.controlValues(app,window,tree);
		// Typing requires an observed focused field. Binding every filename cell in
		// an open/save panel made each read scan the file list again for no benefit.
		await (await this.desktop()).retainTextReceivers?.(app, window.element, tree.entries.filter(e => (e.secure || e.element.editable) && e.observed?.focused).map(e => e.element));
		const current = await this.identity(app, window.element);
		if (current.id !== window.identity.id || !sameRect(current.bounds, window.identity.bounds) || revision !== await scheduler.revision(revisionKey)) throw new Error("window changed during observation; read it again");
		const sheets = (tree.sheets ?? []).map(sheet => all.find(w => w.element.raw.ax_role === "AXSheet" && sameRect(w.element.bounds, sheet.bounds) && w.element.name === sheet.name)?.handle).filter((h): h is string => !!h);
		const observation: Observation = { id: `s:${randomUUID()}`, appKey: key, window, tree, revision, revisionKey, windowSet, observedAt: Date.now(), consumed: false, ...(sheets.length ? { sheets } : {}),
			...(options.root ? { root: options.root, ...(options.rootPath ? { rootPath: options.rootPath } : {}), ...(options.dropdownOwner ? {dropdownOwner:options.dropdownOwner} : {}) } : {}), ...(options.region ? { region: options.region } : {}) };
		this.observations.set(observation.id, observation);
		while (this.observations.size > 32) this.observations.delete(this.observations.keys().next().value!);
		return observation;
	}
	private async controlValues(app:UiApp,window:WindowTarget,tree:Snapshot):Promise<void> {
		const values=await (await this.desktop()).controlValues?.(app,window.element,tree.entries.filter(entry=>!entry.secure).map(entry=>entry.element));
		if(!values)return;
		for(const entry of tree.entries){const value=values.get(entry.element);if(value===undefined||!entry.observed)continue;entry.observed.value=value;entry.line=lineWithValue(entry,value);}
	}
	/** Newest observation of one window, or of the app when no handle is given. */
	latest(app: UiApp, handle?: string): Observation | undefined {
		let found: Observation | undefined;
		for (const observation of this.observations.values()) {
			if (observation.appKey !== appKey(app)) continue;
			if (handle && observation.window.handle !== handle) continue;
			if (!found || observation.observedAt >= found.observedAt) found = observation;
		}
		return found;
	}
	/**
	 * The window state an action should use. Omitting the snapshot uses the latest read.
	 * A snapshot already used by an action follows that window's newer read, so the model does not spend a turn copying ids.
	 */
	actionView(app: UiApp, id: unknown, handle?: string): Observation {
		if (typeof id === "string") {
			const named = this.observations.get(id);
			if (!named || named.appKey !== appKey(app)) throw new Error("snapshot belongs to another agent/process or has expired; read again");
			if (!named.consumed) return named;
			const next = this.latest(app, named.window.handle);
			if (next && next.id !== named.id && !next.consumed) return next;
			throw new Error("snapshot was already used by an action; use the snapshot that action returned, or read again");
		}
		if (id !== undefined) throw new Error("read the window first");
		let window = handle;
		if (!window) {
			const handles = new Set([...this.observations.values()].filter(observation => observation.appKey === appKey(app)).map(observation => observation.window.handle));
			if (handles.size !== 1) {
				const latest=this.latest(app);
				throw new Error(latest ? `several windows were read; pass window ${JSON.stringify(latest.window.handle)} for the latest read, or another exact handle from screen_read` : "read the window first");
			}
			window = [...handles][0];
		}
		const next = window ? this.latest(app, window) : undefined;
		if (!next || next.consumed) throw new Error("read the window first");
		return next;
	}
	receipt(app: UiApp, id: unknown): Observation {
		if (typeof id !== "string") throw new Error("snapshot is required; copy the receipt from screen_read or screen_look");
		const observation = this.observations.get(id);
		if (!observation || observation.appKey !== appKey(app)) throw new Error("snapshot belongs to another agent/process or has expired; read again");
		// Reading the window again does not make an earlier snapshot stale; an action on it does (its revision).
		if (observation.consumed) throw new Error("snapshot was already used by an action; use the snapshot that action returned, or read again");
		return observation;
	}
	async validate(app: UiApp, observation: Observation, ids: string[] = []): Promise<WindowTarget> {
		if (appKey(app) !== observation.appKey) throw new Error("process identity changed; read again");
		if (observation.revision !== await (await this.scheduler()).revision(observation.revisionKey)) throw new Error("another action changed this window; read again before acting");
		// A new window or dialog may change what input does; a tooltip or small untitled popover does not.
		const known = new Set(observation.windowSet.split(","));
		if ((await this.windows(app)).some(w => !known.has(w.handle) && (!!w.element.name?.trim() || !w.element.bounds || w.element.bounds.width * w.element.bounds.height >= 120 * 120))) throw new Error("the app opened a window or dialog; read again");
		const current = await this.window(app, observation.window.handle);
		if (!sameRect(current.identity.bounds, observation.window.identity.bounds)) throw new Error("window moved or resized; read/look again before acting");
		if (ids.length) {
			let root: UiElement | undefined, dropdownOwner: DropdownOwner | undefined;
                if (observation.rootPath) {
                    root = current.element;
                    let path="w0";
                    for (const component of observation.rootPath.split("/").slice(1)) {
                        if(isDropdown(root))dropdownOwner={path,bounds:root.bounds ? {...root.bounds}:null};
                        path+="/"+component;
                        root = (await root.children())[Number(component)];
                        if (!root) throw new Error("scope changed; read again");
                    }
                }
                const fresh = await readSnapshot([current.element], new ElementIds(), { offset: observation.tree.offset ?? 0, full:!!observation.tree.full, ...(root ? { root, rootPath: observation.rootPath!, ...(dropdownOwner?{dropdownOwner}:{}) } : {}), ...(observation.region ? { region: observation.region } : {}) });
			await this.controlValues(app,current,fresh);
			for (const id of ids) {
				const before = observation.tree.byId.get(id);
				if(before?.observed?.ambiguous)throw new Error(`${id} is in indistinguishable rows without a unique identity; no action was sent`);
				const after = before && fresh.entries.find(e => e.path === before.path);
				if (!before || !after || !sameRect(before.bounds ?? null, after.bounds ?? null) || JSON.stringify(before.observed) !== JSON.stringify(after.observed)) {
					const changes = !before || !after ? ["missing element"] : [
						...(!sameRect(before.bounds ?? null, after.bounds ?? null) ? [`bounds ${JSON.stringify(before.bounds)} -> ${JSON.stringify(after.bounds)}`] : []),
						...Object.keys(before.observed ?? {}).filter(key => before.observed?.[key as keyof NonNullable<typeof before.observed>] !== after.observed?.[key as keyof NonNullable<typeof after.observed>]),
					];
					throw new Error(`${id} changed since it was read; read again (${changes.join(", ")})`);
				}
				// Fake adapters can prove identity by the retained object. Native semantic actions use the
				// retained AX handle, never a new element resolved from the old number or tree position.
				if (!(await this.desktop()).native && before.element !== after.element) throw new Error(`${id} was replaced; read again`);
			}
		}
		return current;
	}
	remember(observation: Observation, capture: Capture, region?: Rect): ImageObservation {
		const image: ImageObservation = { id: `img:${randomUUID()}`, observation, capture, ...(region ? { region } : {}) };
		this.images.set(image.id, image);
		while (this.images.size > 24) this.images.delete(this.images.keys().next().value!);
		return image;
	}
	/** An image by its id; without one, the latest image taken with this snapshot, or of this window. */
	image(app: UiApp, id: unknown, of?: { snapshot?: string; window?: string }): ImageObservation {
		let image = typeof id === "string" ? this.images.get(id) : undefined;
		if (id === undefined && of) {
			// The whole-window image before any zoom of it: coordinates are usually read off that one.
			const candidates = [...this.images.values()].reverse().filter(i => i.observation.appKey === appKey(app) && (of.snapshot ? i.observation.id === of.snapshot : !of.window || i.observation.window.handle === of.window));
			image = candidates.find(i => !i.region) ?? candidates[0];
		}
		if (!image) throw new Error("pixel coordinates need an image from screen_look: pass its image and snapshot");
		this.receipt(app, image.observation.id);
		return image;
	}
}

export function readbackIdentity(before:SnapshotEntry,after:Snapshot,initial?:Snapshot):{entry?:SnapshotEntry;absent:boolean}{
	if(before.observed?.ambiguous)return{absent:false};
	const key=entryIdentity(before),anchored=anchoredEntry(before);
	if(initial){
		const old=initial.entries.filter(entry=>entryIdentity(entry)===key),next=after.entries.filter(entry=>entryIdentity(entry)===key);
		if(old.length!==1||old[0]!==before||next.length>1||next.some(entry=>entry.observed?.ambiguous))return{absent:false};
		if(anchored&&initial.identityComplete&&after.identityComplete&&initial.wholeWindow&&after.wholeWindow&&!initial.truncated&&!after.truncated){
			if(next.length===1)return{entry:next[0]!,absent:false};
			// The visible AX tree cannot prove physical deletion: a missing
			// control may be hidden or renamed. Object deletion needs separate
			// evidence; unknown must not turn expect exists:false into success.
			return{absent:false};
		}
	}
	const next = after.entries.find(e => e.path === before.path);
	if(next&&(initial?.hiddenSkipped||after.hiddenSkipped)&&before.element!==next.element)return{absent:false};
	return next && !next.observed?.ambiguous && next.secure===before.secure && next.web===before.web && next.observed?.role === before.observed?.role && next.observed?.stableId === before.observed?.stableId && next.observed?.name === before.observed?.name && next.observed?.label === before.observed?.label && next.observed?.context === before.observed?.context ? {entry:next,absent:false} : {absent:false};
}
export function corresponding(before: SnapshotEntry, after: Snapshot,initial?:Snapshot): SnapshotEntry | undefined {
	return readbackIdentity(before,after,initial).entry;
}
