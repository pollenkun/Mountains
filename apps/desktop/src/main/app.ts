import { app, nativeTheme, net, safeStorage, type BrowserWindow } from "electron";
import { PLATFORMS } from "@mountains/cli/run-session";
import { homedir } from "node:os";
import { join } from "node:path";
import { createEngineHost, type HostOptions } from "./engine-host.ts";
import { createDesk, type Desk } from "./desk.ts";
import { bindCommands, createDesktopWindow } from "./window.ts";
import { bindShell } from "./shell.ts";
import { bindBackground } from "./background.ts";
import { bindMenu } from "./menu.ts";
import { bindTitles } from "./titles.ts";
import { openKeys } from "./keys.ts";
import { agentsWriteAllowed, createSettings, webChoice } from "./settings.ts";
import { startUpdates } from "./update-runtime.ts";
import { SEARCH_SERVICES, type SearchService } from "./web.ts";

export interface DesktopOptions {
	/** apps/desktop; `npm run build` puts the page and preload under dist/. */
	root: string;
	host?: HostOptions;
	hidden?: boolean;
	/** Overrides the 概括标题 setting (the hidden-window tests keep titles as typed). */
	titles?: boolean;
	/** Debug (npm run desktop:debug): the developer tools open in their own window. */
	devTools?: boolean;
	theme?: "dark" | "light" | "system";
	/** Runs after the window exists; the app exits when it settles. */
	drive?: (window: BrowserWindow, desk: Desk) => Promise<void>;
	/** Conversations live here; ~/.mountains/desktop by default. */
	dataDir?: string;
}

export function startDesktop(options: DesktopOptions): void {
	if (options.theme) nativeTheme.themeSource = options.theme;
	void app.whenReady().then(async () => {
		if (process.platform === "win32") app.setAppUserModelId("app.mountains.desktop");
		if (process.platform === "darwin" && options.hidden) app.dock?.hide();
		// The model and thinking tier chosen in the page apply to every conversation's next session.
		const dataDir = options.dataDir ?? join(process.env.MOUNTAINS_HOME ?? join(homedir(), ".mountains"), "desktop");
		const settings = createSettings(join(dataDir, "settings.json"));
		openKeys(dataDir, { available: () => safeStorage.isEncryptionAvailable(), encrypt: (text) => safeStorage.encryptString(text), decrypt: (data) => safeStorage.decryptString(data) },
			[...PLATFORMS.map((platform) => platform.apiKeyEnv), "OPENAI_COMPATIBLE_API_KEY", ...SEARCH_SERVICES.flatMap((service) => service.keyEnv ?? [])]);
		const saved = settings.read();
		if (!options.theme && saved.mode) nativeTheme.themeSource = saved.mode;
		const prefs: { model?: string; effort?: string; memory?: boolean; approval?: "ask" | "auto" | "full"; approvalModel?: string; approvalEffort?: string; siui?: boolean; team?: boolean; maxAgents?: number | null } = { ...(saved.model ? { model: saved.model } : {}), ...(saved.team ? { team: true } : {}), ...(saved.maxAgents !== undefined ? { maxAgents: saved.maxAgents } : {}), ...(saved.memory ? { memory: true } : {}), approval: saved.approval ?? "ask", ...(saved.approvalModel ? { approvalModel: saved.approvalModel } : {}), ...(saved.approvalEffort ? { approvalEffort: saved.approvalEffort } : {}), siui: saved.siui !== false };
		// Through Chromium's network, so a page is reached the way the browser reaches it: the system proxy included.
		const web = {
			fetch: options.host?.fetch ?? ((url, init) => net.fetch(url as string, init)) as typeof fetch,
			choice: () => webChoice(settings.read()),
			connect: (service: SearchService) => settings.write({ search: service.id, searchCustom: [...webChoice(settings.read()).custom.filter((other) => other.id !== service.id), service] }),
		};
		const desk = createDesk({
			...options.host,
			dataDir,
			createHost: (hostOptions) => {
				const host = createEngineHost({
					...hostOptions, web,
					agentsWrite: () => agentsWriteAllowed(settings.read()),
					skillModes: () => settings.read().skillMode ?? {},
					onAsk: (question) => {
						if (window.isDestroyed()) return;
						const conversation = hostOptions.session?.id.replace(/^ses_/, "");
						window.webContents.send("mountains:ask", { ...question, ...(conversation ? { conversation } : {}) });
					},
				});
				host.choose(prefs);
				return host;
			},
		});
		const window = createDesktopWindow(desk, { root: options.root, hidden: options.hidden ?? false });
		bindCommands(desk, window);
		const updates = startUpdates({
			preferences: () => { const saved = settings.read(); return { channel: saved.updateChannel === "stable" ? "stable" : "preview", source: saved.updateSource === "hk" || saved.updateSource === "github" ? saved.updateSource : "auto", automatic: saved.autoUpdate === true }; },
			isBusy: () => desk.running().length > 0 || desk.list().some(c => c.goal?.status === "active" || c.goal?.status === "verifying"),
			changed: state => { if (!window.isDestroyed()) window.webContents.send("mountains:updates", state); },
			enabled: app.isPackaged && !options.hidden && !options.drive,
		});
		app.once("will-quit", () => updates.dispose());
		desk.onChange(() => { if (!window.isDestroyed()) window.webContents.send("mountains:updates", updates.state()); });
		bindShell(desk, window, options.host ?? {}, prefs, settings, updates);
		bindBackground(desk, window, { tray: !options.hidden && !options.drive });
		bindMenu(window);
		bindTitles(desk, options.host ?? {}, () => { const now = settings.read(); return { enabled: options.titles ?? now.titles !== false, ...(now.titleModel ? { model: now.titleModel } : {}), ...(prefs.model ? { runModel: prefs.model } : {}) }; });
		if (options.devTools && !options.hidden) window.webContents.openDevTools({ mode: "detach" });
		window.on("closed", () => { void desk.dispose(); });
		app.on("activate", () => { if (!window.isDestroyed()) window.show(); });
		if (options.drive) {
			await options.drive(window, desk);
			await desk.dispose();
			app.exit(0);
		}
	}).catch((error: unknown) => {
		console.error(error instanceof Error ? error.stack ?? error.message : error);
		app.exit(1);
	});
	app.on("window-all-closed", () => { app.quit(); });
}
