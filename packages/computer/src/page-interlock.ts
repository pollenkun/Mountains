import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InputCoordinator } from "./coordinator.ts";

interface Pause { owner: string; pid: number; endpoint: string; target: string; operation: string }
const memory = new WeakMap<InputCoordinator, Pause>();

/** A paused input belongs to its originating client until it has released every held input.
 * All methods run under the browser profile's input lock. Other clients fail before dispatch.
 */
export class PageInterlock {
	private readonly coordinator: InputCoordinator;
	private readonly owner: string;
	constructor(coordinator: InputCoordinator, owner: string) { this.coordinator = coordinator; this.owner = owner; }
	private get path(): string | undefined { return this.coordinator.directory && join(this.coordinator.directory, "page-input-pause.json"); }
	private async read(): Promise<Pause | undefined> {
		if (!this.path) return memory.get(this.coordinator);
		try {
			const pause = JSON.parse(await readFile(this.path, "utf8")) as Pause;
			if (![pause.owner, pause.endpoint, pause.target, pause.operation].every(value => typeof value === "string")) throw new Error("invalid page input pause");
			return pause;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	}
	async check(endpoint: string, target?: string): Promise<boolean> {
		const pause = await this.read();
		if (!pause) return false;
		if (pause.endpoint !== endpoint) { await this.clear(true); return false; }
		if (pause.owner !== this.owner) throw new Error(`another browser client (pid ${pause.pid}) must resolve its dialog and release its input before this client can act`);
		if (target && target !== pause.target) throw new Error("resolve the dialog in the original tab before acting on another tab");
		return true;
	}
	async mine(endpoint: string): Promise<Pause | undefined> {
		const pause = await this.read();
		return pause?.endpoint === endpoint && pause.owner === this.owner ? pause : undefined;
	}
	async hold(endpoint: string, target: string): Promise<void> {
		if (await this.check(endpoint, target)) return;
		const pause: Pause = { owner: this.owner, pid: process.pid, endpoint, target, operation: randomUUID() };
		if (!this.path) { memory.set(this.coordinator, pause); return; }
		const temporary = `${this.path}.${randomUUID()}`;
		await writeFile(temporary, JSON.stringify(pause), { mode: 0o600, flag: "wx" });
		await rename(temporary, this.path);
	}
	async clear(browserExited = false): Promise<void> {
		const pause = await this.read();
		if (!pause || !browserExited && pause.owner !== this.owner) return;
		if (this.path) await rm(this.path, { force: true });
		else memory.delete(this.coordinator);
	}
}
