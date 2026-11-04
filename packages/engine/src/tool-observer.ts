/** The settled model response which produced a group of tool calls, not an approval response. */
export interface ToolResponseSource {
	readonly sessionId: string;
	readonly runId: string;
	readonly turnId: string;
	readonly requestId: string;
	readonly attempt: number;
	/** Null is explicit for adapters without a provider response ID; never synthesize one. */
	readonly responseId: string | null;
}

export type ToolObservationValue = null | boolean | number | string | readonly ToolObservationValue[] | {
	readonly [key: string]: ToolObservationValue;
};

export interface ToolExecutionIdentity {
	/** Engine-generated; distinct even if a later model response reuses a call ID. */
	readonly executionId: string;
	readonly source: ToolResponseSource;
	readonly toolCallId: string;
	readonly name: string;
	readonly argumentsSha256: string;
	/** Same argument string after Recorder's redaction, for verifying the readable trace too. */
	readonly recordedArgumentsSha256: string;
}

export interface ToolExecutionInstant {
	readonly wallTimeMs: number;
	/** process.hrtime.bigint(), comparable only inside this engine process. */
	readonly monotonicNs: string;
}

export interface ToolExecutionOutcome {
	/** 'threw' still means execution started and may have produced side effects. */
	readonly dispatch: "not-started" | "returned" | "threw";
	readonly started: ToolExecutionInstant | null;
	readonly finished: ToolExecutionInstant | null;
	readonly ok: boolean;
	readonly modelContentSha256: string;
	/** Commitment to the redacted recording text, computed with Recorder's same secret snapshot. */
	readonly recordedModelContentSha256: string;
	readonly details: ToolObservationValue;
	readonly reads: ToolObservationValue;
	readonly writes: ToolObservationValue;
	readonly control: ToolObservationValue;
}

/**
 * Trusted, opt-in runtime callbacks around actual tool.execute, not an event playback.
 * Inputs are independent frozen copies. Arguments/details may contain sensitive data:
 * select/redact fields before persisting; modelContent and image bytes are omitted.
 * A receipt must acknowledge completed observation (and durable storage if required).
 * Honor the supplied signal; never start detached observation or retry a tool here.
 * CLI configuration cannot load callbacks. Existing callers incur no observer work.
 */
export interface ToolExecutionObserver {
	/** Default 5 seconds per callback; finite, between 1 and 30,000 milliseconds. */
	readonly timeoutMs?: number;
	before(identity: ToolExecutionIdentity, args: ToolObservationValue, signal: AbortSignal): Promise<ToolObservationValue>;
	/** Also called after a successful before when dispatch was cancelled or revoked. */
	after(identity: ToolExecutionIdentity, prepared: ToolObservationValue, outcome: ToolExecutionOutcome, signal: AbortSignal): Promise<ToolObservationValue>;
}

const MAX_OBSERVATION_BYTES = 1_048_576;

type ObservationFailureCode = "cancelled" | "timeout" | "invalid-data" | "callback";
const failureCodes = new WeakMap<object, ObservationFailureCode>();
class ObservationFailure extends Error {
	readonly code: ObservationFailureCode;
	constructor(code: ObservationFailureCode) { super(`Tool observation failed: ${code}`); this.code = code; failureCodes.set(this, code); }
}

/** Callback exceptions and abort reasons may contain passwords. Never serialize their text. */
export function observationFailureCode(error: unknown): ObservationFailureCode {
	// No toString, property reads or instanceof: an arbitrary thrown value may have hostile getters/proxies.
	return error !== null && (typeof error === "object" || typeof error === "function") ? failureCodes.get(error) ?? "callback" : "callback";
}

/** JSON-only copies prevent a trusted observer accidentally changing approved input or real results. */
export function observationCopy(value: unknown): ToolObservationValue {
	try {
		const json = JSON.stringify(value);
		if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_OBSERVATION_BYTES) throw new ObservationFailure("invalid-data");
		const copy = JSON.parse(json) as ToolObservationValue;
		const freeze = (item: unknown): void => {
			if (item && typeof item === "object") {
				for (const child of Object.values(item)) freeze(child);
				Object.freeze(item);
			}
		};
		freeze(copy);
		return copy;
	} catch { throw new ObservationFailure("invalid-data"); }
}

export function observerTimeout(observer: ToolExecutionObserver): number {
	const ms = observer.timeoutMs ?? 5_000;
	if (!Number.isFinite(ms) || ms < 1 || ms > 30_000) throw new Error("Tool observer timeout must be between 1 and 30000 milliseconds");
	return ms;
}

/** After uses its own deadline: an already cancelled user signal must not erase completed work. */
export async function observeTool(
	observer: ToolExecutionObserver,
	work: (signal: AbortSignal) => Promise<ToolObservationValue>,
	signal?: AbortSignal,
): Promise<ToolObservationValue> {
	const timeoutMs = observerTimeout(observer);
	const deadline = performance.now() + timeoutMs;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort!: () => void;
	const stopped = new Promise<never>((_resolve, reject) => {
		const stop = (reason: ObservationFailure) => { controller.abort(reason); reject(reason); };
		abort = () => stop(new ObservationFailure("cancelled"));
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => stop(new ObservationFailure("timeout")), timeoutMs);
	});
	const operation = Promise.resolve().then(async () => {
		controller.signal.throwIfAborted();
		const receipt = await work(controller.signal);
		controller.signal.throwIfAborted();
		// Timers cannot fire during synchronous JS (for example copying a large result).
		// Reject a late completion even when it beats the queued timer callback.
		if (performance.now() >= deadline) throw new ObservationFailure("timeout");
		const copy = observationCopy(receipt);
		if (performance.now() >= deadline) throw new ObservationFailure("timeout");
		return copy;
	});
	try { return await Promise.race([operation, stopped]); }
	catch (error) { throw new ObservationFailure(observationFailureCode(error)); }
	finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		controller.abort(new Error("Tool observation callback finished"));
	}
}
