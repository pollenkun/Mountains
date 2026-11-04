/** Desktop's own settings (memory on or off) and the user's global AGENTS.md, which the CLI reads too. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AddedModel } from "@mountains/cli/run-session";
import type { SearchService, WebChoice } from "./web.ts";

export interface DesktopSettings { /** The user skipped initial model setup; keep it dismissed across restarts. */ setupSkipped?: boolean; /** 模式: absent follows the system. */ mode?: "system" | "light" | "dark"; /** 联网搜索和读网页, on unless turned off; the search service chosen, absent to follow the platform; those connected from their docs. */ web?: boolean; search?: string | null; searchCustom?: SearchService[]; /** The model the user last chose. */ model?: string; /** UltraCode, and how many agents may work at once; none means no limit. */ team?: boolean; maxAgents?: number | null; /** Models the user added: ones of their own, and the ids of built-in ones. */ models?: AddedModel[]; kept?: string[]; /** The look the user kept: a theme's JSON; absent is the default. */ theme?: string | null; memory?: boolean; approval?: "ask" | "auto" | "full"; /** 自动审批's model; absent follows the run's model. */ approvalModel?: string | null; /** 自动审批's thinking effort; absent/null uses the model's lowest thinking. */ approvalEffort?: string | null; /** 概括标题, on unless turned off, and its model; absent follows the run's model. */ titles?: boolean; titleModel?: string | null; /** Super Intelligent UI, on unless turned off. */ siui?: boolean; /** The model may replace AGENTS.md. Absent means on. */ agentsWrite?: boolean; /** Turn that permission on when the next conversation is created. */ agentsNext?: boolean; /** Where 检查更新 looks. Absent means there is nowhere to look. */ updateFeed?: string; /** 正式版 or 预览版. Absent is preview, which is this build. */ updateChannel?: "stable" | "preview"; /** Download a newer build when a check finds one. */ autoUpdate?: boolean; updateSource?: "auto" | "hk" | "github"; /** Per-skill 允许 / 询问. Absent keeps the built-in default. */ skillMode?: Record<string, "allow" | "ask"> }

export type { AddedModel };

/** On unless the user turned it off. A missing value is the default, which is on. */
export function agentsWriteAllowed(saved: DesktopSettings): boolean {
	return saved.agentsWrite !== false;
}

export function webChoice(saved: DesktopSettings): WebChoice {
	return { enabled: saved.web !== false, service: saved.search ?? null, custom: saved.searchCustom ?? [] };
}

export function createSettings(path: string) {
	return {
		read(): DesktopSettings {
			try { return JSON.parse(readFileSync(path, "utf8")) as DesktopSettings; } catch { return {}; }
		},
		write(change: DesktopSettings): void {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, `${JSON.stringify({ ...this.read(), ...change }, null, 1)}\n`, { mode: 0o600 });
		},
	};
}
export type Settings = ReturnType<typeof createSettings>;

export function globalAgentsPath(): string {
	return join(process.env.MOUNTAINS_HOME ?? join(homedir(), ".mountains"), "AGENTS.md");
}

export function readGlobalAgents(): string {
	return existsSync(globalAgentsPath()) ? readFileSync(globalAgentsPath(), "utf8") : "";
}

/** Written whole through a temporary file, so a crash never leaves half a file. */
export function writeGlobalAgents(text: string): void {
	const path = globalAgentsPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}
