import { randomUUID } from "node:crypto";
import { url as inspectorUrl } from "node:inspector";
import type { RunSummary, ToolExecutionObserver, ToolObservationValue, ModelLedgerWitness } from "@mountains/engine";
import { observerHash, observerJson, observerPacket, TOOL_OBSERVER_PROTOCOL, type ObserverAgent, type ObserverPhase, type ObserverStart, type ObserverRequest } from "./tool-observer-protocol.ts";

interface Pending {
	request: ObserverRequest;
	bytes: number;
	resolve(value: ToolObservationValue): void;
	reject(error: Error): void;
	cleanup(): void;
}

/** A private inherited Node IPC connection. No port, token file, config-loaded JS or tool RPC. */
export class ToolObserverIpcClient {
	private readonly pending = new Map<string, Pending>();
	private readonly history = new Map<string, { phase: ObserverPhase; hash: string; state: "cancelled" | "replied" }>();
	private readonly modelNotes = new Set<Promise<void>>();
	private failure: Error | null = null;
	private readonly fatal = new AbortController();
	private pendingBytes = 0;
	private started = false;
	private startRequested = false;
	private finished = false;
	private disposed = false;
	private readonly host: NodeJS.Process;
	constructor(host: NodeJS.Process = process) {
		if (!host.connected || !host.send || !host.channel) throw new Error("Tool observation requires an inherited parent IPC channel");
		if (host.env.NODE_OPTIONS || host.env.NODE_PATH || host.execArgv.length !== 1 || host.execArgv[0] !== "--disable-sigusr1" || inspectorUrl()) {
			throw new Error("Tool observation requires a clean Node startup with only --disable-sigusr1 and no inspector");
		}
		this.host = host;
		host.on("message", this.onMessage);
		host.on("disconnect", this.onDisconnect);
	}
	get healthy(): boolean { return !this.failure && !this.disposed && this.host.connected === true; }
	get fatalSignal(): AbortSignal { return this.fatal.signal; }
	private fault(): Error {
		if (this.failure) return this.failure;
		this.failure = new Error("Tool observation channel failed");
		const pending = [...this.pending.values()]; this.pending.clear(); this.pendingBytes = 0;
		for (const entry of pending) { entry.cleanup(); entry.reject(this.failure); }
		this.fatal.abort(this.failure);
		return this.failure;
	}
	private onDisconnect = (): void => { this.fault(); };
	private onMessage = (message: unknown): void => {
		try {
			const reply = observerPacket(message);
			if (reply.kind !== "reply") throw null;
			const entry = this.pending.get(reply.id);
			if (!entry) {
				const prior = this.history.get(reply.id);
				// A valid late ACK for a cancelled wait is not a new permission or a channel fault.
				if (!prior || prior.state !== "cancelled" || prior.phase !== reply.phase || prior.hash !== reply.hash) throw null;
				prior.state = "replied"; return;
			}
			if (entry.request.phase !== reply.phase || entry.request.hash !== reply.hash) throw null;
			const receipt = observerJson(reply.receipt, 1024 * 1024);
			this.pending.delete(reply.id); this.pendingBytes -= entry.bytes; entry.cleanup();
			this.history.set(reply.id, { phase: reply.phase, hash: reply.hash, state: "replied" });
			if (!reply.ok) { entry.reject(this.fault()); return; }
			entry.resolve(receipt);
		} catch { this.fault(); }
	};
	private request(phase: ObserverPhase, input: unknown, signal: AbortSignal): Promise<ToolObservationValue> {
		if (!this.healthy || this.finished || this.history.size + this.pending.size >= 8192) return Promise.reject(this.fault());
		if (signal.aborted) return Promise.reject(new Error("Tool observation wait cancelled"));
		let request: ObserverRequest, bytes: number;
		try {
			const payload = observerJson(input);
			request = { protocol: TOOL_OBSERVER_PROTOCOL, kind: "request", id: randomUUID(), phase, hash: observerHash({ phase, payload }), payload };
			bytes = Buffer.byteLength(JSON.stringify(request));
		} catch { return Promise.reject(this.fault()); }
		if (signal.aborted) return Promise.reject(new Error("Tool observation wait cancelled"));
		if (this.pending.size >= 256 || this.pendingBytes + bytes > 32 * 1024 * 1024) return Promise.reject(this.fault());
		return new Promise((resolve, reject) => {
			const abort = () => {
				if (!this.pending.delete(request.id)) return;
				this.pendingBytes -= bytes; signal.removeEventListener("abort", abort);
				this.history.set(request.id, { phase, hash: request.hash, state: "cancelled" });
				reject(new Error("Tool observation wait cancelled"));
				try { this.host.send!({ protocol: TOOL_OBSERVER_PROTOCOL, kind: "cancel", id: request.id, phase, hash: request.hash }, error => { if (error) this.fault(); }); }
				catch { this.fault(); }
			};
			this.pending.set(request.id, { request, bytes, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) });
			this.pendingBytes += bytes; signal.addEventListener("abort", abort, { once: true });
			try {
				// false means backpressure, not rejection. Never resend an observation or a tool.
				this.host.send!(request, error => { if (error) this.fault(); });
			} catch { this.fault(); }
		});
	}
	async start(metadata: ObserverStart): Promise<void> {
		if (this.startRequested) throw this.fault();
		this.startRequested = true;
		await this.request("start", metadata, AbortSignal.timeout(5000)); if (!this.healthy) throw this.fault(); this.started = true;
	}
	noteModelLedger(agent: ObserverAgent, witness: ModelLedgerWitness): void {
		if (!this.started || !this.healthy) throw this.fault();
		const pending = this.request("model", { agent, witness }, AbortSignal.timeout(5000)).then(() => {
			if (!this.healthy) throw this.fault();
		}).catch(() => { this.fault(); }).finally(() => this.modelNotes.delete(pending));
		this.modelNotes.add(pending);
	}
	private async flushModels(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted(); if (!this.healthy) throw this.fault();
		if (!this.modelNotes.size) return;
		let abort!: () => void;
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Tool observation wait cancelled"));
			if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		});
		try {
			while (this.modelNotes.size) await Promise.race([Promise.all([...this.modelNotes]), cancelled]);
			signal.throwIfAborted(); if (!this.healthy) throw this.fault();
		} finally { signal.removeEventListener("abort", abort); }
	}
	forAgent(agent: ObserverAgent): ToolExecutionObserver {
		const binding = observerJson(agent);
		return {
			before: async (identity, args, signal) => {
				if (!this.started) throw this.fault();
				await this.flushModels(signal);
				const receipt = await this.request("before", { agent: binding, identity, args }, signal);
				if (!this.healthy || this.finished) throw this.fault(); return receipt;
			},
			after: async (identity, prepared, outcome, signal) => {
				if (!this.started) throw this.fault();
				const receipt = await this.request("after", { agent: binding, identity, prepared, outcome }, signal);
				if (!this.healthy || this.finished) throw this.fault(); return receipt;
			},
		};
	}
	async finish(summary: RunSummary): Promise<void> {
		if (!this.started) throw this.fault();
		await this.flushModels(AbortSignal.timeout(5000)); if (this.pending.size) throw this.fault();
		await this.request("finish", summary, AbortSignal.timeout(5000)); if (!this.healthy) throw this.fault(); this.finished = true;
	}
	dispose(): void {
		if (this.disposed) return;
		if (this.pending.size) this.fault();
		this.disposed = true; this.host.off("message", this.onMessage); this.host.off("disconnect", this.onDisconnect);
	}
}
