import type { Rect, UiElement } from "./backend.ts";

/**
 * A compact, numbered view of an app's windows. Only what can be acted on or read is kept: elements
 * with a real action (press, toggle, type…), input fields, and text. Unnamed containers are flattened.
 * Numbers are local to an observation bound to a process, exact window and receipt.
 */
export const SNAPSHOT_LIMITS = { nodes: 4000, depth: 40, lines: 400, chars: 24_000, name: 80, value: 160, fanout: 40 } as const;

const ACTIONS = ["press", "toggle", "expand", "collapse", "select", "increment", "decrement", "set_value", "type_text"];
/** Actions nearly every element offers, or that act on windows; left out of the listing. Anything else an app adds is shown. */
const COMMON = ["focus", "scroll_to_visible", "show_menu", "activate", "minimize", "restore", "enter_fullscreen", "exit_fullscreen", "move_to", "resize_to", "close", "raise", "show_default_ui", "show_alternate_ui"];
export function readableAction(action: string): string {
	const label=/^name:([^\n]+)\n_target:0x[0-9a-f]+\n_selector:[^\n]+$/i.exec(action)?.[1];
	return label === undefined ? action : label.replace(/_/g," ").trim();
}
export function resolveAction(el: UiElement, name: string): string | undefined {
	const matches=el.actions.filter(action=>action===name || readableAction(action)===name);
	return matches.length===1 ? matches[0] : undefined;
}
const ownActions = (el: UiElement) => el.actions.filter(a => !ACTIONS.includes(a) && !COMMON.includes(a)).map(readableAction);
/** Controls kept by role even when they list no press: Chrome's web buttons and links offer only show_menu and
 * scroll_to_visible, and are clicked with the pointer. */
const CONTROLS = ["button", "link", "menu_item", "tab", "menu_button", "pop_up_button", "toggle_button", "disclosure_triangle"];
const INPUTS = ["text_field", "text_area", "combo_box", "check_box", "radio_button", "slider", "switch", "search_field", "spin_button", "secure_text_field"];
const DISCLOSURE = ["disclosure_triangle", "combo_box", "tree_item", "outline_row", "row", "pop_up_button", "menu_button"];
/** Controls a file list must not crowd out, however long the list is. */
const PINNED = new Set([...INPUTS, "button", "link", "menu_item", "check_box", "radio_button", "pop_up_button", "menu_button"]);
const pinned = (el: UiElement) => el.focused || el.selected || el.editable || PINNED.has(el.role);
export const isDropdown = (el: UiElement): boolean => ["combo_box", "pop_up_button", "menu_button"].includes(el.role) || ["AXPopUpButton", "AXComboBox", "AXMenuButton"].includes(String(el.raw.ax_role));
export interface DropdownOwner { path: string; bounds: Rect | null }

/** `web`: inside web content (Chromium, Electron, WebKit), where accessibility presses often do nothing. */
export interface SnapshotEntry {
	id: string; element: UiElement; line: string; depth: number; secure: boolean; web: boolean;
	/** Captured facts; never getters on a live/fake object that might later change. */
	path?: string; window?: UiElement; bounds?: Rect | null;
	observed?: { value: string | null; focused: boolean; selected: boolean; checked: string | null; expanded: boolean | null; stableId: string | null; role: string; name: string | null; label?: string; context?: string; ambiguous?:boolean; dropdown?: DropdownOwner };
}
export interface Snapshot { entries: SnapshotEntry[]; byId: Map<string, SnapshotEntry>; visited: number; truncated: boolean; /** The read ran out of its time budget. */ slow?: boolean; fanoutClipped?:boolean; nextOffset?: number; offset?: number; full?: boolean;
	/** False for a region, subtree or continuation, even when that range was read completely. */
	wholeWindow?:boolean;
	/** Hidden branches were not traversed, so visible labels cannot prove uniqueness. */
	hiddenSkipped?:boolean;identityComplete?:boolean;
	/** Sheets (an open or save panel, a confirmation) attached to the window: windows of their own, read and acted on separately. */
	sheets?: UiElement[]; dropdowns?: DropdownOwner[] }

/** Element numbers for one window: the same element (by place, identity, role and name) keeps its number from read to read. */
export class ElementIds {
	private readonly byKey = new Map<string, string>();
	private next = 1;
	private semantic = new Map<string,string>();
	idFor(key: string): string {
		let id = this.byKey.get(key);
		if (!id) { id = `e${this.next++}`; this.byKey.set(key, id); }
		return id;
	}
	semanticSnapshot(complete:boolean):(key:string)=>string{
		const previous=this.semantic,current=new Map<string,string>();this.semantic=complete?current:new Map();
		return key=>{let id=current.get(key);if(!id){id=complete?previous.get(key):undefined;id??=`e${this.next++}`;current.set(key,id);}return id;};
	}
}

/** A virtualized slot identifier never overrides changed neighboring labels. */
export function anchoredEntry(entry:SnapshotEntry):boolean{
	if(entry.observed?.stableId)return true;
	try{return (JSON.parse(entry.observed?.context??'[]') as string[]).some(value=>(JSON.parse(value) as unknown[]).some(part=>typeof part==='string'&&part.trim().length>0));}catch{return false;}
}
export const entryIdentity=(entry:SnapshotEntry):string=>JSON.stringify([entry.path?.split('/')[0],entry.observed?.role,entry.observed?.stableId,entry.observed?.name,entry.observed?.label,entry.observed?.context,entry.secure,entry.web]);

const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const quote = (s: string) => JSON.stringify(s);
const rowIdentityLabels=(labels:string[]):string[]=>labels.filter((text,index)=>index===0||! /^(?:\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?|\d+(?:\.\d+)?\s*%|\d+\s*\/\s*\d+)$/i.test(text));

/** Password values stay hidden; entering text is permitted after model-side consent. */
export function isSecure(element: UiElement): boolean {
	const raw = element.raw ?? {};
	return /secure|password/i.test(element.role) || (raw.ax_subrole === "AXSecureTextField" || raw.subrole === "AXSecureTextField") || raw.isPassword === true || raw.IsPassword === true;
}

export function isPayment(element:UiElement):boolean {
 const raw=element.raw??{};
 const label=[element.name,element.description,raw.ax_title,raw.ax_description,raw.ax_help].filter(v=>typeof v==='string').join(' ');
 const named=/卡号|信用卡|安全码|有效期|到期日|card[ _-]*(?:number|no\b|expiry|expiration)|\b(?:cvv2?|cvc2?|expiry|expiration date)\b/i.test(label)&&(/text|input|entry|secure|password/i.test(element.role)||element.editable);
 return named||raw.isPayment===true||raw.IsPayment===true||/cc-(?:number|csc|exp)|credit[-_ ]?card/i.test([raw.autocomplete,raw.ax_autocomplete,raw.ax_identifier,element.stableId].filter(v=>typeof v==='string').join(' '));
}

function describe(el: UiElement, depth: number): { line: (id: string) => string; keep: boolean; secure: boolean } {
	const name = tidy(el.name) || tidy(el.description) || (el.role === "unknown" ? tidy(el.stableId) : "");
	const secure = isSecure(el);
	const value = secure ? "" : tidy(el.value);
	const actions = el.actions.filter(a => ACTIONS.includes(a));
	if (isDropdown(el) && !actions.includes("select")) actions.push("select");
	if (["list","table","tree","table_cell","table_row","cell","row","tree_item","list_item"].includes(el.role) && name && el.actions.includes("focus")) actions.push("focus");
	// An app's own actions (Archive, Cancel, Open, Show Details...) are listed too, for screen_act perform.
	const own = ownActions(el);
	const role = el.role === "unknown" && typeof el.raw.ax_role === "string" ? el.raw.ax_role.replace(/^AX/, "").replace(/([a-z])([A-Z])/g,"$1_$2").toLowerCase() : el.role;
	const isText = (role === "static_text" || role === "heading") && Boolean(name || value);
	const keep = (actions.length + own.length > 0 && Boolean(name || value || role === "button" || role === "link" || INPUTS.includes(role))) || actions.some(action=>action==="increment"||action==="decrement") || own.some(action => action.startsWith("scroll_")) || INPUTS.includes(role) || (CONTROLS.includes(role) && Boolean(name || value)) || el.editable || isText || secure;
	const flags = [
		el.focused && "focused", !el.enabled && "disabled", el.selected && "selected",
		el.checked && el.checked !== "off" && el.checked !== "false" && "checked",
		DISCLOSURE.includes(role) && el.expanded === true && "expanded", DISCLOSURE.includes(role) && el.expanded === false && "collapsed",
		secure && "password",
	].filter(Boolean);
	const line = (id: string) => `${"  ".repeat(Math.min(depth, 12))}${id} ${role}${name ? ` ${quote(clip(name, SNAPSHOT_LIMITS.name))}` : ""}` +
		`${value && value !== name ? ` = ${quote(clip(value, SNAPSHOT_LIMITS.value))}` : ""}${flags.length ? ` [${flags.join(",")}]` : ""}${actions.length || own.length ? ` {${[...actions, ...own].join(",")}}` : ""}`;
	return { line, keep, secure };
}

/** Read every window of an app into a numbered snapshot. */
/** How long one read may take. A slow app (a file panel's browser drawn by another process) can take seconds per
 * element; the read stops there and says it is partial instead of holding every later action. */
export const READ_BUDGET_MS = { normal: 4_000, full: 12_000 } as const;
export async function readSnapshot(windows: UiElement[], ids: ElementIds, options: { offset?: number; root?: UiElement; rootPath?: string; region?: Rect; full?: boolean; dropdownOwner?: DropdownOwner; budgetMs?: number } = {}): Promise<Snapshot> {
	const readUntil = Date.now() + (options.budgetMs ?? (options.full ? READ_BUDGET_MS.full : READ_BUDGET_MS.normal));
	let outOfTime = false;
	const entries: SnapshotEntry[] = [];
	const draftIds=new ElementIds();
	const rowContexts=new Map<string,{name:string;stableId:string|null;labels:{path:string;text:string}[]}>();
	const windowKeys=new Map<SnapshotEntry,string>();
	const offset = options.offset ?? 0;
	let visited = 0, truncated = false, more = false,fanoutClipped=false,hiddenSkipped=false;
	let window: UiElement;
	const sheets: UiElement[] = [];
	type Holder={el:UiElement;path:string;used?:boolean;labels:string[];entry?:SnapshotEntry};
	const holders:Holder[]=[];
	const holderByPath=new Map<string,Holder>();
	const dropdowns = new Map<string, DropdownOwner>();
	if (options.dropdownOwner) dropdowns.set(options.dropdownOwner.path, options.dropdownOwner);
	const ownerAt = (path: string) => [...dropdowns.values()].filter(owner => path === owner.path || path.startsWith(owner.path + "/")).sort((a,b) => b.path.length-a.path.length)[0];
	const facts = (el: UiElement, path: string) => ({ path, window, bounds: el.bounds ? { ...el.bounds } : null,
		observed: { value: isSecure(el) ? null : el.value, focused: el.focused, selected: el.selected, checked: el.checked, expanded: el.expanded, stableId: el.stableId, role: el.role, name: el.name, ...(ownerAt(path) ? { dropdown: ownerAt(path)! } : {}) } });
	// `holder`: an unnamed element with actions of its own (a sidebar or list cell that opens); its first text
	// stands for it, so the model sees "Downloads" {open} rather than a bare label and a nameless cell.
	const walk = async (el: UiElement, path: string, depth: number, level: number, web: boolean, holder: Holder | null, context: string[] = []): Promise<void> => {
		if (visited >= offset + SNAPSHOT_LIMITS.nodes) { truncated = true; more = true; return; }
		if (Date.now() >= readUntil) { truncated = true; outOfTime = true; return; }
		if (level > SNAPSHOT_LIMITS.depth) { truncated = true; return; }
		visited++;
		if (!el.visible) {hiddenSkipped=true;return;}
		if (isDropdown(el)) dropdowns.set(path, { path, bounds: el.bounds ? { ...el.bounds } : null });
		const { line, keep, secure } = describe(el, depth);
		if (!keep && !tidy(el.name) && !tidy(el.description) && [...el.actions.filter(a=>ACTIONS.includes(a)),...ownActions(el)].some(a => !a.startsWith("scroll"))) {holder = { el, path,labels:[] };holders.push(holder);holderByPath.set(path,holder);}
		const region = options.region, bounds = el.bounds;
		const inRegion = !region || !!bounds && bounds.x < region.x + region.width && region.x < bounds.x + bounds.width && bounds.y < region.y + region.height && region.y < bounds.y + bounds.height;
		if (keep && visited > offset && inRegion) {
			const rowInput=holder && ["table_cell","table_row","row","list_item","tree_item"].includes(holder.el.role) && ["text_field","text_area"].includes(el.role) && !secure;
			const childLabel=rowInput ? tidy(el.value)||tidy(el.name) : tidy(el.name)||tidy(el.value);
			if(holder&&(el.role==="static_text"||el.role==="heading"||rowInput))holder.labels.push(childLabel);
			// A row can name itself through an editable label. Keep both the row
			// (selection) and its text field (editing); focusing the field is not selection.
			if(holder && rowInput && childLabel && !holder.used) {
				holder.used=true;
				const target=holder.el,key=holder.path,id=draftIds.idFor(`${key}|${target.stableId??""}|${target.role}|${childLabel}`),captured=facts(target,key);
				if(context.length)Object.assign(captured.observed,{context:JSON.stringify(context)});
				const entry={id,element:target,line:"",depth:Math.max(1,depth-1),secure:false,web,...captured};
				entry.line=lineWithValue(entry,"",childLabel);entries.push(entry);holder.entry=entry;
			}
			const text = holder && !holder.used && (el.role === "static_text" || el.role === "heading") ? holder : null;
			if(text)text.used=true;
			// Only shown elements get a number, so the numbers the model sees have no gaps.
			const target = text?.el ?? el, key = text?.path ?? path;
			const id = draftIds.idFor(`${key}|${target.stableId ?? ""}|${target.role}|${tidy(text ? el.name || el.value : el.name)}`);
			const shown = text ? lineWithValue({ id, element: target, line: "", depth, secure: false, web }, "", tidy(el.name) || tidy(el.value)) : line(id);
			const captured=facts(target,key);
			if(context.length)Object.assign(captured.observed,{context:JSON.stringify(context)});
			const entry={ id, element: target, line: shown, depth, secure, web, ...captured, ...(text ? {observed:{...captured.observed,label:tidy(el.name)||tidy(el.value)}} : {}) };
			entries.push(entry);if(text)text.entry=entry;
			holder = null;
		}
		// A collapsed outline row or menu button already names itself. Its hidden rows are not part of this read.
		// Only those: Chrome reports its web area (and every element in it) as not expanded.
		if (el.expanded === false && DISCLOSURE.includes(el.role)) return;
		let kids: UiElement[] = [];
		try { kids = await el.children(); } catch { truncated = true; }
		const inWeb = web || el.role === "web_area";
		const rowName=["table_cell","table_row","row","list_item","tree_item"].includes(el.role) ? tidy(el.name)||tidy(el.description) : "";
		const childContext=rowName ? [...context,rowName] : context;
		const firstChild=entries.length;
		for (const i of shownChildren(kids)) await walk(kids[i]!, `${path}/${i}`, keep ? depth + 1 : depth, level + 1, inWeb, holder,childContext);
		if(["table_cell","table_row","row","list_item","tree_item"].includes(el.role)) {
			const labels=entries.slice(firstChild).filter(e=>!e.secure && ["static_text","heading","text_field","text_area"].includes(e.element.role)).flatMap(e=>{
				const text=tidy(e.observed?.value)||tidy(e.observed?.name);
				return text&&e.path?[{path:e.path,text}]:[];
			});
			for(const [index,text]of (holderByPath.get(path)?.labels??[]).entries())if(text&&!labels.some(label=>label.text===text))labels.push({path:`${path}/promoted-${index}`,text});
			rowContexts.set(path,{name:rowName,stableId:el.stableId,labels});
		}
	};
	// Every control stays. A long list, grid or sidebar keeps a bounded run of ordinary rows.
	const shownChildren = (kids: UiElement[]): number[] => {
		if (options.full || kids.length <= SNAPSHOT_LIMITS.fanout) return kids.map((_, i) => i);
		const pin: number[] = [], rest: number[] = [];
		for (let i = 0; i < kids.length; i++) (pinned(kids[i]!) ? pin : rest).push(i);
		const chosen = [...pin, ...rest.slice(0, SNAPSHOT_LIMITS.fanout)];
		if (chosen.length < kids.length) {truncated = true;fanoutClipped=true;}
		return chosen.sort((a, b) => a - b);
	};
	for (let w = 0; w < windows.length; w++) {
		const win = windows[w]!;
		window = win;
		let kids: UiElement[] = [];
		try { kids = await win.children(); } catch { truncated = true; }
		// The button macOS puts on a window while it is recorded is for the user, not part of the app.
		if (kids.length === 1 && kids[0]!.name === "WindowSharingSessionButton") continue;
		// The window itself is always shown, so the model knows which window an element belongs to.
		const windowKey=win.stableId ? `id:${win.stableId}` : `w${w}|${tidy(win.name)}`;
		const id = draftIds.idFor(windowKey);
		entries.push({ id, element: win, line: `${id} window ${quote(clip(tidy(win.name) || "(untitled)", SNAPSHOT_LIMITS.name))}${win.focused ? " [focused]" : ""}`, depth: 0, secure: false, web: false, ...facts(win, `w${w}`) });
		windowKeys.set(entries.at(-1)!,windowKey);
		if (options.root) await walk(options.root, options.rootPath ?? `w${w}/scope`, 1, 1, false, null);
		else for (let i = 0; i < kids.length; i++) {
			// Input meant for a sheet must name the sheet's own window, so its controls are numbered only there.
			// The window's own children stay in visit order, so a later page can continue a long read.
			if (kids[i]!.raw.ax_role === "AXSheet") { sheets.push(kids[i]!); continue; }
			await walk(kids[i]!, `w${w}/${i}`, 1, 1, false, null);
		}
	}
	for(const holder of holders)if(holder.entry?.observed){holder.entry.observed.label=JSON.stringify(rowIdentityLabels(holder.labels));holder.entry.line=lineWithValue(holder.entry,"",holder.labels.join(" "));}
	const rowSignatures=new Map<string,number>(),stableIds=new Map<string,number>();
	for(const [path,row] of rowContexts)if(!row.stableId){const signature=JSON.stringify([path.split("/").slice(0,-1).join("/"),row.name,...rowIdentityLabels(row.labels.map(l=>l.text))]);rowSignatures.set(signature,(rowSignatures.get(signature)??0)+1);}
	for(const e of entries)if(e.observed?.stableId)stableIds.set(e.observed.stableId,(stableIds.get(e.observed.stableId)??0)+1);
	for(const entry of entries){
		const contexts:string[]=[];
		for(let path=entry.path?.split('/').slice(0,-1).join('/');path;path=path.split('/').slice(0,-1).join('/')){
			const row=rowContexts.get(path);
			if(row){
				contexts.unshift(JSON.stringify([row.stableId,row.name,...rowIdentityLabels(row.labels.filter(label=>label.path!==entry.path).map(label=>label.text))]));
				const uniqueId=entry.observed?.stableId && stableIds.get(entry.observed.stableId)===1;
				if(!uniqueId && !row.stableId && (rowSignatures.get(JSON.stringify([path.split("/").slice(0,-1).join("/"),row.name,...rowIdentityLabels(row.labels.map(l=>l.text))]))??0)>1 && entry.observed)entry.observed.ambiguous=true;
			}
		}
		if(entry.observed){if(contexts.length)entry.observed.context=JSON.stringify(contexts);else delete entry.observed.context;}
	}
	const wholeWindow=offset===0&&!options.root&&!options.region;
	const identityComplete=wholeWindow&&!truncated&&!hiddenSkipped;
	const semanticCounts=new Map<string,number>();
	for(const entry of entries)if(anchoredEntry(entry)){const key=entryIdentity(entry);semanticCounts.set(key,(semanticCounts.get(key)??0)+1);}
	const semanticId=ids.semanticSnapshot(identityComplete);
	for(const entry of entries){
		const old=entry.id,o=entry.observed,key=entryIdentity(entry);
		entry.id=identityComplete&&!windowKeys.has(entry)&&!o?.ambiguous&&anchoredEntry(entry)&&semanticCounts.get(key)===1?semanticId(key):ids.idFor(windowKeys.get(entry)??`${entry.path}|${o?.stableId??''}|${o?.role}|${o?.name??''}|${o?.label??''}|${o?.context??''}`);
		entry.line=entry.line.replace(new RegExp(`^(\\s*)${old}\\b`),(_match,space:string)=>space+entry.id);
	}
	return { entries, byId: new Map(entries.map(e => [e.id, e])), visited, truncated, offset,wholeWindow,...(outOfTime?{slow:true}:{}),hiddenSkipped,identityComplete,...(fanoutClipped?{fanoutClipped:true}:{}), dropdowns: [...dropdowns.values()], ...(options.full ? {full:true} : {}), ...(more ? { nextOffset: visited } : {}), ...(sheets.length ? { sheets } : {}) };
}

/** Render observed child text on its actionable unnamed container; never synthesize write results. */
export function lineWithValue(entry: SnapshotEntry, value: string, name?: string): string {
	// A plain copy: native elements' getters cannot be read through another object.
	const e = entry.element;
	const shown = { role: e.role, name: name ?? e.name, value, description: name === undefined ? e.description : null, actions: e.actions, focused: name === undefined && e.focused, enabled: e.enabled,
		selected: e.selected, checked: e.checked, expanded: e.expanded, editable: e.editable, stableId:e.stableId, raw: e.raw } as UiElement;
	return describe(shown, entry.depth).line(entry.id);
}

/** The snapshot as text, within the line and character limits. */
export function renderSnapshot(snapshot: Snapshot, find?: string, offset = 0): { text: string; shown: number; omitted: number } {
	const needle = find?.trim().toLowerCase();
	const lines = snapshot.entries.filter(e => !needle || e.line.toLowerCase().includes(needle)).map(e => (needle ? e.line.trimStart() : e.line));
	const out: string[] = [];
	let chars = 0;
	for (const line of lines.slice(offset)) {
		if (out.length >= SNAPSHOT_LIMITS.lines || chars + line.length + 1 > SNAPSHOT_LIMITS.chars) break;
		out.push(line); chars += line.length + 1;
	}
	return { text: out.join("\n"), shown: out.length, omitted: Math.max(0, lines.length - offset - out.length) };
}

/** What changed between two snapshots of the same app, by element number. */
export function diffSnapshots(before: Snapshot, after: Snapshot, limit = 60): string {
	const prev = new Map(before.entries.map(e => [e.id, e.line.trim()]));
	const oldEntries = new Map(before.entries.map(e => [e.id, e]));
	const next = new Map(after.entries.map(e => [e.id, e.line.trim()]));
	const lines: string[] = [];
	for (const [id, line] of next) {
		const old = prev.get(id);
		if (old === undefined) lines.push(`+ ${line}`);
		else if (old !== line) lines.push(`~ ${line}`);
		else {
			const oldBounds = oldEntries.get(id)?.bounds, newBounds = after.byId.get(id)?.bounds;
			if (oldBounds && newBounds && (oldBounds.x !== newBounds.x || oldBounds.y !== newBounds.y)) lines.push(`~ ${line} [position changed]`);
		}
	}
	for (const [id, line] of prev) if (!next.has(id)) lines.push(`- ${line}`);
	if (!lines.length) return "No visible change in the accessibility tree.";
	return lines.length > limit ? `${lines.slice(0, limit).join("\n")}\n… ${lines.length - limit} more changes; screen_read shows the whole window` : lines.join("\n");
}

/** True when the tree says too little to work from, so a screenshot should help. */
export function looksSparse(snapshot: Snapshot): boolean {
	const actionable = snapshot.entries.filter(e => e.line.includes("{"));
	const unnamed = actionable.filter(e => !/^\s*e\d+ \S+ (?:= )?"/.test(e.line));
	return actionable.length - unnamed.length < 2 || (actionable.length >= 6 && unnamed.length / actionable.length > 0.5);
}
