// Real-desktop check for Computer use on Windows (semantic actions, background only). It runs inside the user's
// interactive desktop session; a plain SSH session is session 0 and sees no windows, so start it through a scheduled
// task set to run as the logged-on user ("Run only when user is logged on"):
//
//   MOUNTAINS_WINDOWS_LIVE=1 node packages/computer/test/windows-live.ts <witness.exe> <report.json>
//
//   <witness.exe>  built on the Mac by: node scripts/build-windows-witness.mjs <output.exe>
//                  (or MOUNTAINS_WINDOWS_WITNESS=<path>)
//   <report.json>  where the JSON report is written (or MOUNTAINS_WINDOWS_LIVE_OUT=<path>); the report also goes to
//                  stdout. The timestamped step log goes to stderr and to <report.json>.log. Pictures of what
//                  screen_look and the capture returned are saved as <report.json>.look.png and <report.json>.capture.png.
//
// What it does, and what it starts (only these, and only these PIDs are closed again at the end):
//   1. Notepad, with a temporary file, so an ordinary app is in front. If Windows refuses to put it in front for a
//      background process, the harness (not the product) asks PowerShell's AppActivate to do it, before any measuring.
//   2. The witness app (test/fixtures/windows-witness), started with --no-activate so starting it takes no focus, and
//      placed under Notepad's window. The witness writes its own state file after every change; that file, not what
//      Mountains says, is what the steps are judged by.
//   3. Mountains' own tools on the default Windows desktop: screen_read the witness, then screen_act press, toggle,
//      select, set_value, increment (twice) and expand by element number, and one refused key press; then screen_look
//      at the witness while Notepad covers it.
// A second bundled helper samples the foreground about every 20 ms. This is sampling, not a Windows event hook:
// it can miss a shorter change. The witness also records every activation independently. Sampling errors and gaps
// over 250 ms make the run unverified. Every step has a 60 s cap; a timeout ends the run, never starts another action.
// Full tool replies, before/after states, trees, foreground samples and final witness files are kept in
// <report.json>.evidence. A timed-out native UIA call may still be running until cleanup terminates our witness.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { FileStateTracker, Workspace, type ToolContext, type ToolDefinition, type ToolResult } from "@mountains/tools";
import { InputCoordinator } from "../src/coordinator.ts";
import { createComputerTools, decodePng, defaultDesktop, encodePng, openWindowsHelper, windowHandle, type Desktop, type Rect, type WindowsHelper } from "../src/index.ts";

/** What the check needs from the machine. The real ones are `realEnv` below; a rehearsal on another OS can swap them. */
export interface LiveEnv {
	openHelper(): WindowsHelper;
	openDesktop(): Promise<Desktop>;
	spawn(command: string, args: string[]): ChildProcess;
	/** Harness setup only, never part of what is measured: put a process's window in front. */
	activate(pid: number): Promise<void>;
	kill(pid: number, identity: ProcessIdentity): Promise<void>;
}
export interface LiveConfig { witnessExe: string; out?: string }
export interface ProcessIdentity { name: string; path: string; start: string }

const completeProcessIdentity = (identity: Partial<ProcessIdentity> | undefined): identity is ProcessIdentity =>
	!!identity && [identity.name, identity.path, identity.start].every(value => typeof value === "string" && value.length > 0) && Number.isFinite(Date.parse(identity.start!));
export function sameProcessIdentity(expected: ProcessIdentity | undefined, actual: Partial<ProcessIdentity> | undefined): actual is ProcessIdentity {
	return completeProcessIdentity(expected) && completeProcessIdentity(actual) && expected.start === actual.start && expected.name === actual.name && expected.path.toLowerCase() === actual.path.toLowerCase();
}
export const startedDuringLaunch = (identity: Partial<ProcessIdentity> | undefined, launchAt: number): identity is ProcessIdentity =>
	completeProcessIdentity(identity) && Number.isFinite(launchAt) && Date.parse(identity.start) >= launchAt;

interface WinInfo { hwnd: number; pid: number; title: string; bounds: Rect; minimized: boolean; cloaked: boolean }
interface Witness {
	pid: number; hwnd: number; title: string; stamp: string; revision: number;
	counter: number; checked: boolean; size: string; note: string; volume: number; folderExpanded: boolean;
	active: boolean; containsFocus: boolean; activations: number; deactivations: number;
	keyDown: number; keyPress: number; keyUp: number; mouseDown: number; mouseUp: number;
	bounds: Rect; backColor: [number, number, number]; writeFailures: number; events: { at: string; event: string }[];
}
const FIELDS = ["counter", "checked", "size", "note", "volume", "folderExpanded"] as const;
const controlsOf = (w: Witness) => Object.fromEntries(FIELDS.map(f => [f, w[f]]));
const sameControls = (a: Witness, b: Witness) => FIELDS.every(f => a[f] === b[f]);
const INPUT_FIELDS = ["keyDown", "keyPress", "keyUp", "mouseDown", "mouseUp"] as const;
const sameInputs = (a: Witness, b: Witness) => INPUT_FIELDS.every(f => a[f] === b[f]);
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);
const brief = (text: string, n = 700): string => text.length > n ? `${text.slice(0, n)}…` : text;
const hex = (n: number) => `0x${n.toString(16)}`;
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const execAsync = promisify(execFile);

export interface StepRecord {
	name: string; action: string; element: string | null; outcome: string; ok: boolean; ms: number; readMs: number;
	appSays: Record<string, unknown>; confirmedByApp: boolean; frontStillNotepad: boolean; witnessActivated: boolean; activationDelta: number; deactivationDelta: number;
	foregroundSeen: string[]; toolForeground: unknown; dispatched: unknown; message: string; elementRead: string[]; why: string | null;
}

/** No product failure can be hidden by the witness having changed anyway. Invoke/RangeValue have no expected
 * property in screen_act: an ok=true, unconfirmed reply can report its visible change. Keep that distinction. */
export function semanticPassed(step: Pick<StepRecord, "ok" | "outcome" | "dispatched" | "confirmedByApp" | "frontStillNotepad" | "witnessActivated">): boolean {
	return step.ok && ["confirmed", "unconfirmed"].includes(step.outcome) && step.dispatched === true && step.confirmedByApp && step.frontStillNotepad && !step.witnessActivated;
}
export const MAX_FOREGROUND_GAP_MS = 250;
export function samplingVerified(samples: { at: number }[], errors: { at: number }[], from: number, to: number): { verified: boolean; count: number; maxGapMs: number; errors: number } {
	const inside = samples.filter(s => s.at >= from && s.at <= to), failed = errors.filter(s => s.at >= from && s.at <= to).length;
	const times = [from, ...inside.map(s => s.at), to];
	const maxGapMs = Math.max(...times.slice(1).map((t, i) => t - times[i]!));
	const ordered = times.every((t, i) => Number.isFinite(t) && (i === 0 || t >= times[i - 1]!));
	return { verified: ordered && inside.length > 0 && failed === 0 && maxGapMs <= MAX_FOREGROUND_GAP_MS, count: inside.length, maxGapMs, errors: failed };
}
export function witnessImageStats(image: { width: number; height: number; pixels: Uint8Array }, back: readonly number[]) {
	const { width, height, pixels: px } = image, count = width * height, colors = new Map<number, number>();
	if (!Number.isSafeInteger(count) || width <= 0 || height <= 0 || px.length !== count * 4) throw new Error("the screenshot has invalid dimensions or pixels");
	let different = 0, near = 0;
	for (let i = 0; i < count; i++) {
		const r = px[4 * i]!, g = px[4 * i + 1]!, b = px[4 * i + 2]!;
		if (r !== px[0] || g !== px[1] || b !== px[2]) different++;
		if (px[4 * i + 3]! >= 250 && Math.abs(r - back[0]!) <= 6 && Math.abs(g - back[1]!) <= 6 && Math.abs(b - back[2]!) <= 6) near++;
		const key = (r << 16) | (g << 8) | b; colors.set(key, (colors.get(key) ?? 0) + 1);
	}
	const [topColor] = [...colors.entries()].sort((a, b) => b[1] - a[1]);
	return { width, height, pixelsDifferentFromTheFirst: different, nonBlank: different > 0, distinctColors: colors.size, mostCommonColor: topColor ? `#${topColor[0].toString(16).padStart(6, "0")}` : null,
		witnessBackgroundShare: Math.round(1000 * near / count) / 1000, witnessBackground: `#${back.map(v => v.toString(16).padStart(2, "0")).join("")}` };
}
export function witnessLookChecks(look: Record<string, unknown>) {
	const capture = look.capture as ReturnType<typeof witnessImageStats> | undefined, image = look.returnedImage as ReturnType<typeof witnessImageStats> | undefined;
	const covered = (value: unknown) => { const c = value as { notepadAboveWitness?: boolean; notepadContainsWitness?: boolean } | undefined; return c?.notepadAboveWitness === true && c.notepadContainsWitness === true; };
	return {
		returnedImage: look.ok === true && look.returnedImages === 1 && !!image && image.width > 0 && image.height > 0,
		covered: covered(look.coverage) && covered(look.coverageAfter),
		nonBlank: capture?.nonBlank === true && image?.nonBlank === true,
		showsWitness: (capture?.witnessBackgroundShare ?? 0) >= 0.2 && (image?.witnessBackgroundShare ?? 0) >= 0.2,
	};
}
export class StepTimeoutError extends Error {}
/** Preserve the timeout even when aborting the operation rejects its promise first. */
export async function boundedStep<T>(label: string, run: (signal: AbortSignal) => Promise<T>, limitMs: number, onTimeout: () => void): Promise<T> {
	const control = new AbortController(), timer = new AbortController();
	let expired: StepTimeoutError | undefined;
	try {
		return await Promise.race([run(control.signal), delay(limitMs, undefined, { signal: timer.signal }).then(() => {
			expired = new StepTimeoutError(`step timed out after ${limitMs / 1000} s: ${label}; no following action will run`);
			onTimeout(); control.abort(expired); throw expired;
		})]);
	} catch (error) { throw expired ?? error; }
	finally { timer.abort(); }
}

export async function runWindowsLive(config: LiveConfig, env: LiveEnv): Promise<{ report: Record<string, unknown>; accepted: boolean }> {
	const startedAt = Date.now(), stamp = startedAt.toString(36);
	const root = mkdtempSync(join(tmpdir(), "mountains-windows-live-"));
	const statePath = join(root, "witness.json"), notepadFile = join(root, `mountains-notepad-${stamp}.txt`);
	const logFile = config.out ? `${config.out}.log` : undefined;
	const evidence = config.out ? `${config.out}.evidence` : join(root, "evidence");
	mkdirSync(evidence, { recursive: true });
	const log = (text: string) => {
		const line = `${new Date().toISOString().slice(11, 23)} ${text}`;
		console.error(line);
		if (logFile) try { appendFileSync(logFile, `${line}\n`); } catch { /* stderr has it */ }
	};
	const report: Record<string, unknown> = { acceptance: null, environment: null, preconditions: null, steps: [], look: null, refusedKey: null, foreground: null, desktopInputCalls: [], approvalsAsked: [], initialRead: null, witnessFinal: null, fatal: null, cleanup: null, evidenceDirectory: evidence, timeout: null };
	const artifactErrors: string[] = [];
	const artifact = (name: string, data: unknown) => {
		try { const file = join(evidence, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n"); }
		catch (error) { artifactErrors.push(`${name}: ${message(error)}`); }
	};
	const save = () => {
		if (!config.out) return;
		try { mkdirSync(dirname(config.out), { recursive: true }); writeFileSync(config.out, JSON.stringify(report, null, 2)); } catch (error) { artifactErrors.push(`report: ${message(error)}`); log(`cannot write ${config.out}: ${message(error)}`); }
	};
	/** One bounded step: logged, capped, and its AbortSignal fires at the cap so a tool call can stop. */
	const step = async <T,>(label: string, run: (signal: AbortSignal) => Promise<T>, limitMs = 60_000): Promise<T> => {
		const started = Date.now();
		log(`… ${label}`);
			try {
				const value = await boundedStep(label, run, limitMs, () => { report.timeout ??= { step: label, limitMs, at: new Date().toISOString(), nativeCallMayStillBeRunning: true }; });
				log(`finished ${label} ${Date.now() - started} ms (verdict is in the report)`);
				return value;
			} catch (error) { log(`✗ ${label} ${Date.now() - started} ms: ${message(error)}`); throw error; }
	};
	const waitFor = async <T,>(find: () => Promise<T | undefined | false>, limitMs: number, everyMs = 200): Promise<T | undefined> => {
		for (const until = Date.now() + limitMs; ; await delay(everyMs)) { const found = await find(); if (found) return found; if (Date.now() >= until) return undefined; }
	};

	// ---- instruments: two helpers of their own, so what measures is not what is measured ----
	const helpers: WindowsHelper[] = [];
	try { helpers.push(env.openHelper()); helpers.push(env.openHelper()); }
	catch (error) {
		for (const helper of helpers) await helper.dispose().catch(() => {});
		report.fatal = message(error); report.acceptance = { accepted: false, checks: {}, failures: [{ check: "helperStart", reason: message(error) }] }; save();
		return { report, accepted: false };
	}
	const probe = helpers[0]!, watcher = helpers[1]!;
	const foreground = async (helper: WindowsHelper = probe) => { const r = await helper.send({ op: "foreground" }, 3_000); return { hwnd: Number(r.hwnd), pid: Number(r.pid) }; };
	const windows = async (): Promise<WinInfo[]> => ((await probe.send({ op: "windows" }, 10_000)).windows as WinInfo[]);
	const processes = async (pids: number[]) => ((await probe.send({ op: "processes", pids }, 10_000)).processes ?? {}) as Record<string, { name?: string; path?: string; start?: string }>;
	const fgLog: { at: number; hwnd: number; pid: number }[] = [];
	const fgSamples: { at: number; hwnd: number; pid: number }[] = [], fgErrors: { at: number; error: string }[] = [];
	let sampling = true, samples = 0, samplerErrors = 0, maxGapMs = 0;
	const sampler = (async () => {
		let previous: number | undefined, lastAt = Date.now();
		while (sampling) {
			try {
					const f = await foreground(watcher), at = Date.now();
					if (!Number.isFinite(f.hwnd) || !Number.isFinite(f.pid) || f.hwnd <= 0 || f.pid <= 0) throw new Error("foreground reply did not identify a window");
					fgSamples.push({ at, ...f });
				samples++; maxGapMs = Math.max(maxGapMs, at - lastAt); lastAt = at;
				if (f.hwnd !== previous) { fgLog.push({ at, ...f }); previous = f.hwnd; }
				} catch (error) { samplerErrors++; fgErrors.push({ at: Date.now(), error: message(error) }); }
			await delay(20);
		}
	})();
	/** Every window that was in front between two instants, the one in front at the start included. */
	const foregroundDuring = (from: number, to: number): number[] => {
		const seen = new Set<number>();
		let current: number | undefined;
		for (const s of fgLog) { if (s.at <= from) current = s.hwnd; else if (s.at <= to) seen.add(s.hwnd); }
		if (current !== undefined) seen.add(current);
		return [...seen];
	};

	let desktop: Desktop | undefined, notepadChild: ChildProcess | undefined, witnessChild: ChildProcess | undefined;
	const preNotepadPids = new Set<number>();
	let notepad: { pid: number; hwnd: number; title: string; reusedExisting: boolean } | undefined;
	const notepadIdentities = new Map<number, ProcessIdentity>();
	let witnessExit: string | undefined;
	let baseline: { hwnd: number; pid: number } | undefined, baselineAt = startedAt;
	const steps: StepRecord[] = [];
	report.steps = steps;
	const preconditions: Record<string, unknown> = {};
	report.preconditions = preconditions;
	const failures: { check: string; reason: string }[] = [];
	const checks: Record<string, boolean> = {};
	const check = (name: string, ok: boolean, reason: string) => { checks[name] = ok; if (!ok) failures.push({ check: name, reason }); };

	const witnessName = basename(config.witnessExe);
	report.environment = { platform: process.platform, arch: arch(), osRelease: release(), node: process.version, user: process.env.USERNAME ?? null, sessionName: process.env.SESSIONNAME ?? null,
		startedAt: new Date(startedAt).toISOString(), stamp, witnessExe: config.witnessExe, witnessBytes: existsSync(config.witnessExe) ? statSync(config.witnessExe).size : null,
		witnessSha256: existsSync(config.witnessExe) ? createHash("sha256").update(readFileSync(config.witnessExe)).digest("hex") : null, report: config.out ?? null };

	const readState = async (): Promise<Witness> => {
		let last: unknown;
		for (let i = 0; i < 10; i++) {
			try {
				if (existsSync(statePath + ".error")) throw new Error(`witness error: ${readFileSync(statePath + ".error", "utf8")}`);
				const state = JSON.parse(readFileSync(statePath, "utf8")) as Witness;
				if (state.stamp !== stamp || state.pid !== witnessChild?.pid || !Number.isFinite(state.revision) || state.hwnd <= 0 || !INPUT_FIELDS.every(f => Number.isFinite(state[f]))) throw new Error("witness state has the wrong identity or incomplete counters");
				return state;
			} catch (error) { last = error; await delay(30); }
		}
		throw new Error(`cannot read the witness state file ${statePath}: ${message(last)}`);
	};

	try {
		// Bind this run to the executable built from these exact fixture sources; no unverified stale binary.
		const manifest = JSON.parse(readFileSync(config.witnessExe + ".json", "utf8")) as Record<string, unknown>;
		const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
		if (manifest.format !== 1 || manifest.binarySha256 !== sha(readFileSync(config.witnessExe)) || manifest.sourceSha256 !== sha(readFileSync(new URL("./fixtures/windows-witness/Program.cs", import.meta.url))) || manifest.projectSha256 !== sha(readFileSync(new URL("./fixtures/windows-witness/windows-witness.csproj", import.meta.url)))) throw new Error("witness executable or source does not match its build manifest");
		artifact("witness-build.json", manifest);
		// ---- 1. Notepad in front ----
		const notepadLaunch = await step("start Notepad and find its window", async signal => {
			const before = await windows();
			if (!before.length) throw new Error("no window is visible to the helper: this is not the user's interactive desktop session (an SSH session is session 0). Start the check through a scheduled task that runs as the logged-on user.");
			const known = await processes([...new Set(before.map(w => w.pid))]);
			for (const w of before) if (/^notepad/i.test(known[String(w.pid)]?.name ?? "")) preNotepadPids.add(w.pid);
			writeFileSync(notepadFile, "Mountains Windows live check. This Notepad is the app in front.\r\n");
			const notepadStartedAt = Date.now();
			notepadChild = env.spawn("notepad.exe", [notepadFile]);
			notepadChild.once("error", error => log(`Notepad could not start: ${message(error)}`));
			const wanted = basename(notepadFile).toLowerCase();
			const found = await waitFor(async () => (await windows()).find(w => w.title.toLowerCase().includes(wanted)), 25_000, 250);
			if (!found) throw new Error(`no Notepad window titled with ${basename(notepadFile)} appeared within 25 s`);
			notepad = { pid: found.pid, hwnd: found.hwnd, title: found.title, reusedExisting: before.some(w => w.hwnd === found.hwnd) };
			const launched = await processes([found.pid]);
			const identity = launched[String(found.pid)];
			if (completeProcessIdentity(identity) && Date.parse(identity.start) < notepadStartedAt) preNotepadPids.add(found.pid);
			if (!notepad.reusedExisting && !preNotepadPids.has(found.pid) && startedDuringLaunch(identity, notepadStartedAt) && /^notepad$/i.test(identity.name)) {
				notepadIdentities.set(found.pid, { name: identity.name, path: identity.path, start: identity.start });
			}
			let front = await foreground(), activatedByHarness = false;
			if (front.hwnd !== found.hwnd) {
				// Windows may refuse a background process the front; the harness sets the scene by other means, before measuring.
				activatedByHarness = true;
				signal.throwIfAborted();
				try { await env.activate(found.pid); } catch (error) { log(`harness activation of Notepad failed: ${message(error)}`); }
				await waitFor(async () => (front = await foreground()).hwnd === found.hwnd, 4_000, 150);
			}
			return { found, front, activatedByHarness };
		});
		baseline = notepadLaunch.front; baselineAt = Date.now();
		fgSamples.push({ at: baselineAt, ...baseline }); fgLog.push({ at: baselineAt, ...baseline });
		preconditions.notepad = { pid: notepad!.pid, hwnd: hex(notepad!.hwnd), title: notepad!.title, reusedExistingWindow: notepad!.reusedExisting, startedPid: notepadChild?.pid ?? null, activatedByHarness: notepadLaunch.activatedByHarness, foregroundAtBaseline: { hwnd: hex(baseline.hwnd), pid: baseline.pid } };
		const notepadInFront = baseline.hwnd === notepad!.hwnd;
		check("notepadWasInFront", notepadInFront, `Notepad (window ${hex(notepad!.hwnd)}, process ${notepad!.pid}) was not the foreground window when measuring began; the window in front was ${hex(baseline.hwnd)} of process ${baseline.pid}. Click Notepad and run again.`);
		if (!notepadInFront) throw new Error("Notepad could not be placed in front; no witness action was attempted");

		// ---- 2. the witness, started without activation, under Notepad ----
		const witnessStart = await step("start the witness app (--no-activate)", async () => {
			const rect = notepadLaunch.found.bounds;
			const args = [stamp, statePath, "--no-activate", "--parent", String(process.pid), "--at", `${rect.x + 24},${rect.y + 24}`];
			const startedWitnessAt = Date.now();
			witnessChild = env.spawn(config.witnessExe, args);
			witnessChild.once("error", error => { witnessExit = `could not start: ${message(error)}`; });
			witnessChild.once("exit", (code, signal) => { witnessExit = `exited with code ${code} signal ${signal}`; });
			const ready = await waitFor(async () => {
				if (witnessExit) throw new Error(`the witness app ${witnessExit} before it wrote its state file`);
				try { const s = JSON.parse(readFileSync(statePath, "utf8")) as Witness; return s.events.some(e => e.event === "Shown") ? s : undefined; } catch { return undefined; }
			}, 20_000, 150);
			if (!ready) throw new Error(`the witness app wrote no state file within 20 s (${witnessExit ?? "still running"})`);
			await delay(600);
			return { state: await readState(), front: await foreground(), startedWitnessAt };
		});
		const startState = witnessStart.state;
		artifact("witness-start.json", startState);
		const witnessPid = startState.pid, witnessHwnd = startState.hwnd;
		const startFront = witnessStart.front;
		const startedInactive = startState.activations === 0 && !startState.active && startFront.hwnd === baseline.hwnd;
		check("witnessStartedInactive", startedInactive, `starting the witness app changed the foreground or activated it: activations ${startState.activations}, active ${startState.active}, window in front ${hex(startFront.hwnd)} (Notepad is ${hex(baseline.hwnd)}). The witness's own events: ${startState.events.map(e => e.event).join(", ")}`);
		if (!startedInactive) throw new Error("the witness did not start in the background; no semantic action was attempted");
			const coverage = async () => {
				const list = await windows(), ni = list.findIndex(w => w.hwnd === notepad!.hwnd), wi = list.findIndex(w => w.hwnd === witnessHwnd), n = list[ni], w = list[wi];
				return { notepadAboveWitness: ni >= 0 && wi >= 0 && ni < wi && !n!.minimized && !n!.cloaked && !w!.minimized && !w!.cloaked, notepadContainsWitness: !!n && !!w && contains(n.bounds, w.bounds), notepadIndex: ni, witnessIndex: wi, notepadBounds: n?.bounds ?? null, witnessBounds: w?.bounds ?? null };
		};
		let covered = await coverage();
		if (!covered.notepadAboveWitness && notepadInFront) {
			// A window shown without activation can still land above the front window. Raise Notepad again (harness setup).
			try { await env.activate(notepad!.pid); } catch (error) { log(`raising Notepad failed: ${message(error)}`); }
			await delay(700); covered = await coverage();
			preconditions.raisedNotepadAgain = true;
		}
		preconditions.witness = { pid: witnessPid, hwnd: hex(witnessHwnd), title: startState.title, startedInactive, foregroundAfterStart: { hwnd: hex(startFront.hwnd), pid: startFront.pid }, activationsAtStart: startState.activations, bounds: startState.bounds, coverage: covered };
		check("witnessUnderNotepad", covered.notepadAboveWitness && covered.notepadContainsWitness, `the witness window is not completely covered by Notepad (Notepad above witness: ${covered.notepadAboveWitness}, Notepad's rectangle contains the witness's: ${covered.notepadContainsWitness}; Notepad ${JSON.stringify(covered.notepadBounds)}, witness ${JSON.stringify(covered.witnessBounds)}). Make the Notepad window larger or move it, and run again; the other results still stand.`);

		// ---- 3. Mountains' tools on the default desktop ----
			desktop = await step("open the Windows desktop", async signal => {
				const opened = await env.openDesktop();
				if (signal.aborted) { await opened.close?.(); signal.throwIfAborted(); }
				return opened;
			}, 30_000);
		const inputCalls: string[] = [];
		report.desktopInputCalls = inputCalls;
		for (const method of ["pointer", "key", "text", "typeAtFocus", "clipboardSet", "launch", "pressMenu"] as const) {
			const original = desktop[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
			const target = desktop;
			if (original) (target as unknown as Record<string, unknown>)[method] = (...a: unknown[]) => { inputCalls.push(method); return original.apply(target, a); };
		}
		const witnessStem = witnessName.replace(/\.exe$/i, "");
		const tools = Object.fromEntries(createComputerTools({ imageInput: true, coordinator: new InputCoordinator(), apps: { [witnessName]: "act", [witnessStem]: "act" }, consent: { granted: true }, desktop: async () => desktop! }).map(t => [t.name, t])) as Record<string, ToolDefinition>;
		const asked = report.approvalsAsked as string[];
		const ctx = (signal: AbortSignal): ToolContext => ({ workspace: new Workspace(root), files: new FileStateTracker(), signal, toolCallId: "windows-live", approve: async request => { asked.push(request.command); return "deny"; } });
		const app = String(witnessPid);
		const timed = async (run: () => Promise<ToolResult>) => { const started = performance.now(); const result = await run(); return { result, ms: Math.round(performance.now() - started) }; };

		/** screen_read of the witness window in full; a second window (there should be none) is picked by its title. */
		const readTree = async (signal: AbortSignal): Promise<{ text: string; window: string; ms: number; snapshot: string }> => {
			const { result: first, ms } = await timed(() => tools.screen_read!.execute({ app, full: true }, ctx(signal)));
			let read = first, spent = ms;
			if (/^Choose window/.test(read.modelContent)) {
				const handle = read.modelContent.split("\n").find(line => line.includes(stamp))?.split(" ")[0];
				if (!handle) throw new Error(`the witness has several windows and none is titled with ${stamp}: ${brief(read.modelContent)}`);
				const second = await timed(() => tools.screen_read!.execute({ app, window: handle, full: true }, ctx(signal)));
				read = second.result; spent += second.ms;
			}
			if (!read.ok) throw new Error(`screen_read failed: ${brief(read.modelContent)}`);
			return { text: read.modelContent, window: String(read.details.window), ms: spent, snapshot: String(read.details.snapshot) };
		};
		/** The element numbered in a read, found by role and exact name; the first of the preferred roles wins. */
		const pick = (text: string, name: string, roles: string[]) => {
			const lines = text.split("\n"), found: { id: string; role: string; line: number }[] = [];
			lines.forEach((line, index) => {
				const m = /^\s*(e\d+) (\S+) ("(?:[^"\\]|\\.)*")/.exec(line);
				if (m && JSON.parse(m[3]!) === name) found.push({ id: m[1]!, role: m[2]!, line: index });
			});
			const best = [...found].sort((a, b) => (roles.indexOf(a.role) + 1 || 99) - (roles.indexOf(b.role) + 1 || 99))[0];
			if (!best) throw new Error(`no element named ${JSON.stringify(name)} in the read (looked for roles ${roles.join("/")}). The UI Automation name WinForms gave it may differ; the read was:\n${brief(text, 3000)}`);
			// Its own line and the lines indented under it, for the report.
			const indent = (lines[best.line]!.match(/^\s*/) ?? [""])[0].length, block = [lines[best.line]!];
			for (let i = best.line + 1; i < lines.length && block.length < 14 && (lines[i]!.match(/^\s*/) ?? [""])[0].length > indent; i++) block.push(lines[i]!);
			return { id: best.id, role: best.role, ambiguous: found.length > 1 ? found.map(f => `${f.id} ${f.role}`) : null, block };
		};

		// The tree can take a moment to appear after the window does.
		const first = await step("screen_read the witness (waits for its controls)", async signal => {
			let last = "";
			const read = await waitFor(async () => {
				try { const r = await readTree(signal); last = r.text; return /"Add one"/.test(r.text) ? r : undefined; } catch (error) { last = message(error); return undefined; }
			}, 25_000, 400);
			if (!read) throw new Error(`the witness's controls never appeared in screen_read; last answer: ${brief(last, 1500)}`);
			return read;
		});
		report.initialRead = { ms: first.ms, window: first.window, text: first.text };
		artifact("initial-read.txt", first.text);
		const found: Record<string, unknown> = {};
		for (const [name, roles] of [["Add one", ["button"]], ["Remember me", ["check_box"]], ["Size", ["combo_box"]], ["Note", ["text_field", "text_area"]], ["Volume", ["slider"]], ["Folders", ["tree_item"]]] as const) {
			try { const p = pick(first.text, name, [...roles]); found[name] = { id: p.id, role: p.role, ambiguous: p.ambiguous, read: p.block }; } catch (error) { found[name] = { missing: brief(message(error), 300) }; }
		}
		(report.initialRead as Record<string, unknown>).elements = found;

		const semantic = async (spec: { name: string; action: string; element: { name: string; roles: string[] }; extra?: Record<string, unknown>; confirms: (before: Witness, after: Witness) => string | null; says: (after: Witness) => Record<string, unknown> }) => {
			let record: StepRecord;
			const folder = `${String(steps.length + 1).padStart(2, "0")}-${spec.name.replace(/[^a-z0-9]+/gi, "-")}`;
			try {
				record = await step(spec.name, async signal => {
					const before = await readState(), tree = await readTree(signal), target = pick(tree.text, spec.element.name, spec.element.roles);
					artifact(`${folder}/before.json`, before); artifact(`${folder}/read.txt`, tree.text);
					artifact(`${folder}/request.json`, { app, window: tree.window, action: spec.action, id: target.id, ...spec.extra });
					const from = Date.now();
					signal.throwIfAborted();
					const { result, ms } = await timed(() => tools.screen_act!.execute({ app, window: tree.window, action: spec.action, id: target.id, ...spec.extra }, ctx(signal)));
					artifact(`${folder}/tool.json`, result);
					// The app's own file is the judge: wait for it, then a short quiet period for late events (a delayed activation).
					let after = await readState(), why = spec.confirms(before, after);
					for (const until = Date.now() + 3_000; why && Date.now() < until; ) { await delay(100); after = await readState(); why = spec.confirms(before, after); }
					await delay(300); after = await readState(); why = spec.confirms(before, after);
					artifact(`${folder}/after.json`, after);
					const to = Date.now(), seen = foregroundDuring(from, to), front = await foreground();
					const outcome = String(result.details.outcome ?? (result.ok ? "ok" : "failed")), activationDelta = after.activations - before.activations, deactivationDelta = after.deactivations - before.deactivations;
					const frontStillNotepad = seen.every(h => h === baseline!.hwnd) && front.hwnd === baseline!.hwnd;
					return { name: spec.name, action: spec.action, element: `${target.id} ${target.role} ${JSON.stringify(spec.element.name)}`, outcome, ok: result.ok, ms, readMs: tree.ms, appSays: spec.says(after), confirmedByApp: why === null,
						frontStillNotepad, witnessActivated: activationDelta > 0 || after.active, activationDelta, deactivationDelta, foregroundSeen: [...seen, front.hwnd].filter((h, i, all) => all.indexOf(h) === i).map(hex), toolForeground: result.details.foreground ?? null, dispatched: result.details.dispatched ?? null,
						message: brief(result.modelContent), elementRead: target.block, why: why === null ? null : `${why}. The tool said ${outcome}${result.ok ? "" : ` (not ok): ${brief(String(result.details.error ?? result.modelContent), 400)}`}` } satisfies StepRecord;
				});
			} catch (error) {
				record = { name: spec.name, action: spec.action, element: null, outcome: "harness_error", ok: false, ms: 0, readMs: 0, appSays: {}, confirmedByApp: false, frontStillNotepad: false, witnessActivated: false, activationDelta: 0, deactivationDelta: 0,
					foregroundSeen: [], toolForeground: null, dispatched: null, message: "", elementRead: [], why: message(error) };
				artifact(`${folder}/error.json`, { error: message(error), timeout: error instanceof StepTimeoutError });
				if (existsSync(statePath)) artifact(`${folder}/last-state.json`, readFileSync(statePath, "utf8"));
				if (error instanceof StepTimeoutError) { steps.push(record); save(); throw error; }
			}
			steps.push(record); save();
			return record;
		};

		const NOTE = "Mountains 你好";
		await semantic({ name: "press Add one", action: "press", element: { name: "Add one", roles: ["button"] },
			confirms: (b, a) => a.counter === b.counter + 1 ? null : `the app's counter is ${a.counter}, expected ${b.counter + 1}`, says: a => ({ counter: a.counter }) });
		await semantic({ name: "toggle Remember me", action: "toggle", element: { name: "Remember me", roles: ["check_box"] },
			confirms: (b, a) => a.checked === !b.checked ? null : `the app's checkbox is ${a.checked}, expected ${!b.checked}`, says: a => ({ checked: a.checked }) });
		// A refusal here is a result, not something to work around: it is reported as the tool said it.
		await semantic({ name: "select Size=Large", action: "select", element: { name: "Size", roles: ["combo_box"] }, extra: { text: "Large" },
			confirms: (_b, a) => a.size === "Large" ? null : `the app's size is ${JSON.stringify(a.size)}, expected "Large"`, says: a => ({ size: a.size }) });
		await semantic({ name: "set_value Note", action: "set_value", element: { name: "Note", roles: ["text_field", "text_area"] }, extra: { text: NOTE },
			confirms: (_b, a) => a.note === NOTE ? null : `the app's note is ${JSON.stringify(a.note)}, expected ${JSON.stringify(NOTE)}`, says: a => ({ note: a.note }) });
		for (const n of [1, 2])
			await semantic({ name: `increment Volume ${n}`, action: "increment", element: { name: "Volume", roles: ["slider", "spin_button"] },
				confirms: (b, a) => b.volume === 49 + n && a.volume === 50 + n ? null : `the app's volume was ${b.volume} and is ${a.volume}, expected ${49 + n} -> ${50 + n} (one SmallChange)`, says: a => ({ volume: a.volume }) });
		await semantic({ name: "expand Folders", action: "expand", element: { name: "Folders", roles: ["tree_item"] },
			confirms: (_b, a) => a.folderExpanded ? null : "the app's Folders node is not expanded", says: a => ({ folderExpanded: a.folderExpanded }) });

		// ---- a refused action: nothing sent, nothing changed ----
		const refused = await step("refused key a", async signal => {
			const before = await readState(), tree = await readTree(signal), calls = inputCalls.length, from = Date.now();
			artifact("08-refused-key/before.json", before); artifact("08-refused-key/read.txt", tree.text);
			signal.throwIfAborted();
			const { result, ms } = await timed(() => tools.screen_act!.execute({ app, window: tree.window, action: "key", key: "a" }, ctx(signal)));
			artifact("08-refused-key/tool.json", result);
			await delay(500);
			const after = await readState(), seen = foregroundDuring(from, Date.now()), front = await foreground();
			artifact("08-refused-key/after.json", after);
			const outcome = String(result.details.outcome ?? "?"), unchanged = sameControls(before, after) && sameInputs(before, after) && after.revision === before.revision;
			return { outcome, dispatched: result.details.dispatched ?? null, ok: result.ok, ms, notExecuted: outcome === "not_executed" && result.details.dispatched === false && result.ok === false, appUnchanged: unchanged, appRevisionBefore: before.revision, appRevisionAfter: after.revision,
				desktopInputCalls: inputCalls.slice(calls), appSays: controlsOf(after), frontStillNotepad: seen.every(h => h === baseline!.hwnd) && front.hwnd === baseline!.hwnd, witnessActivated: after.activations > before.activations || after.active, message: brief(result.modelContent) };
		}).catch(error => { if (error instanceof StepTimeoutError) throw error; return { outcome: "harness_error", notExecuted: false, appUnchanged: false, desktopInputCalls: [] as string[], frontStillNotepad: false, witnessActivated: false, error: message(error) }; });
		report.refusedKey = refused; save();

		// ---- screen_look while Notepad covers the witness ----
		const look = await step("screen_look the witness while Notepad covers it", async signal => {
			const coveredNow = await coverage(), before = await readState();
			const { result, ms } = await timed(() => tools.screen_look!.execute({ app }, ctx(signal)));
			const image = result.images?.[0];
			// The picture screen_look returns has element boxes drawn on it, so it is never blank. The capture beneath it,
			// taken the same way, is what shows whether the covered window's own pixels came back.
			const uiApp = (await desktop!.apps()).find(a => a.pid === witnessPid);
			const uiWindow = uiApp ? (await uiApp.windows()).find(w => { try { return windowHandle(w) === witnessHwnd; } catch { return false; } }) : undefined;
			const result2: Record<string, unknown> = { ok: result.ok, ms, width: result.details.width ?? null, height: result.details.height ?? null, returnedImages: result.images?.length ?? 0, coverage: coveredNow, message: brief(result.modelContent, 300) };
				if (image) {
					const decoded = decodePng(Buffer.from(image.data, "base64"));
					result2.returnedImageSize = `${decoded.width}x${decoded.height}`;
					result2.returnedImage = witnessImageStats({ width: decoded.width, height: decoded.height, pixels: decoded.rgba }, before.backColor);
					if (config.out) try { writeFileSync(`${config.out}.look.png`, Buffer.from(image.data, "base64")); } catch (error) { artifactErrors.push(`look.png: ${message(error)}`); }
				}
				if (uiApp && uiWindow) {
					const capture = await desktop!.captureWindow(uiApp, uiWindow, 1280);
					result2.capture = witnessImageStats(capture, before.backColor);
					if (config.out) try { writeFileSync(`${config.out}.capture.png`, encodePng(capture.width, capture.height, Buffer.from(capture.pixels))); } catch (error) { artifactErrors.push(`capture.png: ${message(error)}`); }
				} else result2.captureError = "the witness window was not found among the desktop's windows, so its raw capture was not taken";
				result2.coverageAfter = await coverage();
				return result2;
		}).catch(error => { if (error instanceof StepTimeoutError) throw error; return { ok: false, error: message(error) } as Record<string, unknown>; });
		report.look = look; save();

		// ---- the verdicts ----
		const measuredTo = Date.now();
		sampling = false; await sampler;
		const seenAll = foregroundDuring(baselineAt, measuredTo);
		const named = await processes([...new Set(fgLog.filter(s => s.at >= baselineAt - 1_000).map(s => s.pid).filter(p => p > 0))]).catch(() => ({}) as Record<string, { name?: string }>);
		const changes = fgLog.filter(s => s.at > baselineAt && s.at <= measuredTo).map(s => ({ at: new Date(s.at).toISOString().slice(11, 23), hwnd: hex(s.hwnd), pid: s.pid, process: named[String(s.pid)]?.name ?? null }));
		const finalState = await readState().catch(() => undefined);
		const observation = samplingVerified(fgSamples, fgErrors, baselineAt, measuredTo);
		report.foreground = { baseline: { hwnd: hex(baseline.hwnd), pid: baseline.pid }, samples, samplerErrors, longestGapBetweenSamplesMs: maxGapMs, measuredObservation: observation, maximumAllowedGapMs: MAX_FOREGROUND_GAP_MS, method: "20 ms polling plus witness activation events; shorter unrelated foreground changes may be missed", windowsSeenInFront: seenAll.map(hex), changesAfterBaseline: changes };
		report.witnessFinal = finalState ?? null;
		check("foregroundObservationVerified", observation.verified, `foreground observation was incomplete: ${observation.errors} errors, ${observation.count} samples, longest gap ${observation.maxGapMs} ms (maximum ${MAX_FOREGROUND_GAP_MS} ms)`);
		check("witnessStateWritesSucceeded", !!finalState && finalState.writeFailures === 0, `witness state file write failures: ${finalState?.writeFailures ?? "unknown"}`);
		check("noApprovalsAsked", asked.length === 0, `the background actions unexpectedly requested approvals: ${JSON.stringify(asked)}`);

		const stepChecks: Record<string, boolean> = {};
		check("allSemanticStepsRan", steps.length === 7, `ran ${steps.length} of the seven required semantic action calls`);
		for (const s of steps) {
			stepChecks[s.name] = semanticPassed(s);
			check(`semantic: ${s.name}`, stepChecks[s.name]!, s.why ?? `tool ok=${s.ok}, outcome=${s.outcome}, dispatched=${String(s.dispatched)}, app confirmed=${s.confirmedByApp}, Notepad stayed in front=${s.frontStillNotepad}, witness activated=${s.witnessActivated}; ${s.message}`);
		}
		const stolen = steps.filter(s => !s.frontStillNotepad).map(s => `${s.name} (windows in front: ${s.foregroundSeen.join(", ")})`);
		const toolSaidFront = steps.filter(s => (s.toolForeground as { frontChanged?: boolean } | null)?.frontChanged === true).map(s => s.name);
		check("noForegroundChange", seenAll.length === 1 && seenAll[0] === baseline.hwnd && stolen.length === 0 && toolSaidFront.length === 0,
			`the foreground did not stay on Notepad (${hex(baseline.hwnd)}): windows in front during the run ${seenAll.map(hex).join(", ")}; steps with another window in front: ${stolen.join("; ") || "none"}; steps where the product itself reported a foreground change: ${toolSaidFront.join(", ") || "none"}; changes seen: ${JSON.stringify(changes)}`);
		const activations = finalState?.activations ?? -1, deactivations = finalState?.deactivations ?? -1;
		check("noWitnessActivation", !!finalState && activations === startState.activations && deactivations === startState.deactivations && !finalState.active && steps.every(s => !s.witnessActivated),
			`the witness was activated: activations ${activations} (${startState.activations} at start), deactivations ${deactivations}, active at the end ${finalState?.active}; steps that activated it: ${steps.filter(s => s.witnessActivated).map(s => s.name).join(", ") || "none"}`);
		const rk = refused as Record<string, unknown>;
		check("refusedKeyNotExecuted", rk.notExecuted === true && rk.appUnchanged === true && (rk.desktopInputCalls as string[]).length === 0 && rk.frontStillNotepad === true && rk.witnessActivated === false,
			`the refused key press was not cleanly refused: outcome ${String(rk.outcome)}, dispatched ${String(rk.dispatched)}, the app unchanged ${String(rk.appUnchanged)} (revision ${String(rk.appRevisionBefore)} -> ${String(rk.appRevisionAfter)}), desktop input calls ${JSON.stringify(rk.desktopInputCalls)}${rk.error ? `, error ${String(rk.error)}` : ""}`);
			const lk = look as Record<string, unknown>, capture = lk.capture as { nonBlank: boolean; witnessBackgroundShare: number } | undefined;
			const lookChecks = witnessLookChecks(lk);
			check("lookReturnedImage", lookChecks.returnedImage, `screen_look did not return one valid image: ${JSON.stringify({ ok: lk.ok, returnedImages: lk.returnedImages, returnedImage: lk.returnedImage })}`);
			check("lookWhileCovered", lookChecks.covered, `the witness was not fully covered before and after capture: ${JSON.stringify({ before: lk.coverage, after: lk.coverageAfter })}`);
			check("lookNonBlank", lookChecks.nonBlank, `screen_look or the capture of the covered witness failed or came back blank: ${JSON.stringify({ returnedImage: lk.returnedImage, capture: lk.capture, error: lk.error ?? lk.captureError })}`);
			check("lookShowsTheWitness", lookChecks.showsWitness, `the returned image and raw capture must both show the witness background: ${JSON.stringify({ returnedImage: lk.returnedImage, capture })}`);
		if (desktop) {
			const calls = report.desktopInputCalls as string[];
			check("noDesktopInputCalls", calls.length === 0, `these desktop input methods were called during the run: ${calls.join(", ")}`);
		}
		report.stepChecks = stepChecks;
	} catch (error) {
		report.fatal = message(error);
		failures.push({ check: "run", reason: `the check could not complete: ${message(error)}` });
	} finally {
		sampling = false;
		await Promise.race([sampler, delay(4_000)]);
		artifact("foreground-samples.json", { samples: fgSamples, errors: fgErrors, changes: fgLog });
		for (const [source, name] of [[statePath, "witness-final.json"], [statePath + ".error", "witness.error.txt"]]) {
			if (source && name && existsSync(source)) try { copyFileSync(source, join(evidence, name)); } catch (error) { artifactErrors.push(`${name}: ${message(error)}`); }
		}
		if (!report.witnessFinal && existsSync(statePath)) try { report.witnessFinal = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* the unparsed file is preserved above */ }
		report.acceptance = { accepted: false, checks, failures, cleanupPending: true };
		save();
		// ---- clean up: only the processes this run started, and only after they are checked to be what we think ----
		const cleanup: Record<string, unknown> = { witnessKilled: false, notepadKilled: [] as number[], notes: [] as string[], errors: [] as string[] };
		report.cleanup = cleanup;
		const errors = cleanup.errors as string[], notes = cleanup.notes as string[];
		// End our witness first: this also breaks an outstanding UIA call after a timeout. Never continue the sequence.
		try {
			if (witnessChild && witnessChild.exitCode === null && witnessChild.signalCode === null && witnessChild.pid) {
				witnessChild.kill();
				const stopped = await waitFor(async () => witnessChild!.exitCode !== null || witnessChild!.signalCode !== null, 3_000, 50);
				cleanup.witnessKilled = stopped === true;
				if (!stopped) errors.push("witness termination was requested but its exit was not observed");
			}
		} catch (error) { errors.push(`witness: ${message(error)}`); }
		// Capture again after exit: a native call that was already in progress may have completed during shutdown.
		for (const [source, name] of [[statePath, "witness-after-stop.json"], [statePath + ".error", "witness.error.txt"]]) {
			if (source && name && existsSync(source)) try { copyFileSync(source, join(evidence, name)); } catch (error) { artifactErrors.push(`${name}: ${message(error)}`); }
		}
		await step("close the desktop", async () => { await desktop?.close?.(); }, 20_000).catch(error => errors.push(`desktop: ${message(error)}`));
		try {
			const candidates = new Set(notepadIdentities.keys());
			if (notepad && (notepad.reusedExisting || preNotepadPids.has(notepad.pid))) notes.push(`Notepad opened our file in a Notepad that was already running (process ${notepad.pid}), so it was left running; close the tab ${basename(notepadFile)} yourself.`);
			else if (notepad && !candidates.has(notepad.pid)) errors.push(`Notepad ${notepad.pid} has no complete launch identity; it was left running`);
			if (candidates.size) {
				const info = await processes([...candidates]);
				for (const pid of candidates) {
					const expected = notepadIdentities.get(pid), actual = info[String(pid)];
					if (!sameProcessIdentity(expected, actual)) { errors.push(`Notepad ${pid} identity changed or could not be read; left alone`); continue; }
					try { await env.kill(pid, expected!); (cleanup.notepadKilled as number[]).push(pid); } catch (error) { errors.push(`Notepad ${pid}: ${message(error)}`); }
				}
			}
		} catch (error) { errors.push(`notepad: ${message(error)}`); }
		await delay(300);
			for (const [name, helper] of [["probe", probe], ["watcher", watcher]] as const) await helper.dispose().catch(error => errors.push(`${name}: ${message(error)}`));
		check("cleanupCompleted", errors.length === 0, errors.join("; "));
		check("evidenceSaved", artifactErrors.length === 0, artifactErrors.join("; "));
		report.artifactErrors = artifactErrors;
		// Keep the original files if copying evidence failed, or if no destination was supplied.
		if (config.out && artifactErrors.length === 0) rmSync(root, { recursive: true, force: true });
		else report.retainedTemporaryDirectory = root;
		report.acceptance = { accepted: failures.length === 0 && Object.keys(checks).length > 0 && Object.values(checks).every(Boolean), checks, failures };
		save();
		if (artifactErrors.length > 0) (report.acceptance as { accepted: boolean }).accepted = false;
	}
	return { report, accepted: (report.acceptance as { accepted: boolean }).accepted };
}

const realEnv: LiveEnv = {
	openHelper: openWindowsHelper,
	openDesktop: () => defaultDesktop(),
	spawn: (command, args) => spawn(command, args, { stdio: "ignore", windowsHide: false }),
	// WScript.Shell.AppActivate asks Windows for the front the way a user's own click would; it is used only to set the scene.
	activate: async pid => { await execAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[void](New-Object -ComObject WScript.Shell).AppActivate(${pid})`], { timeout: 20_000, windowsHide: true }); },
	kill: async (pid, identity) => {
		// Open and retain the Windows process handle before checking identity. All
		// later checks and termination use that same Process object, not a reused PID.
		const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
		const script = `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById(${pid}); try { $null=$p.Handle; if ($p.StartTime.ToUniversalTime().ToString('o') -cne ${literal(identity.start)} -or $p.ProcessName -cne ${literal(identity.name)} -or $p.MainModule.FileName -ine ${literal(identity.path)}) { throw 'Notepad identity changed; no termination sent' }; $p.Kill(); if (-not $p.WaitForExit(5000)) { throw 'Notepad exit was not observed' } } finally { $p.Dispose() }`;
		await execAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 10_000, windowsHide: true });
	},
};

// Run directly (not when imported): the guard first, then the check, then the report on stdout.
if (process.argv[1] && basename(process.argv[1]).toLowerCase() === "windows-live.ts") {
	if (process.env.MOUNTAINS_WINDOWS_LIVE !== "1") { console.error("Set MOUNTAINS_WINDOWS_LIVE=1 to run this real-desktop check."); process.exit(2); }
	if (process.platform !== "win32") { console.error("This check runs on Windows only."); process.exit(2); }
	const witnessExe = process.argv[2] ?? process.env.MOUNTAINS_WINDOWS_WITNESS, out = process.argv[3] ?? process.env.MOUNTAINS_WINDOWS_LIVE_OUT;
	if (!witnessExe || !existsSync(witnessExe)) { console.error(`The witness app is missing${witnessExe ? `: ${witnessExe}` : ""}. Build it on the Mac (node scripts/build-windows-witness.mjs <output.exe>) and pass its path as the first argument or in MOUNTAINS_WINDOWS_WITNESS.`); process.exit(2); }
	if (out) { try { mkdirSync(dirname(out), { recursive: true }); writeFileSync(`${out}.log`, ""); } catch { /* the log is optional */ } }
	let code = 1;
	try {
		const { report, accepted } = await runWindowsLive({ witnessExe, ...(out ? { out } : {}) }, realEnv);
		code = accepted ? 0 : 1;
		await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => resolve()));
	} catch (error) {
		console.error(`windows-live failed before it could report: ${message(error)}`);
		code = 1;
	}
	process.exit(code);
}
