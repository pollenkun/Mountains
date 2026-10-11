import type { ApprovalRequest, ToolContext } from "./types.ts";

/** Cancellation must not depend on an approval UI or callback eventually settling. */
export function waitForApproval(ctx: Pick<ToolContext, "signal" | "approve">, request: ApprovalRequest): Promise<"allow" | "deny"> {
	if (ctx.signal.aborted) return Promise.resolve("deny");
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => ctx.signal.removeEventListener("abort", abort);
		const finish = (decision: "allow" | "deny") => {
			if (settled) return;
			settled = true; cleanup(); resolve(decision);
		};
		const abort = () => finish("deny");
		ctx.signal.addEventListener("abort", abort, { once: true });
		// Install both handlers even when cancellation wins, so a late rejection is handled.
		Promise.resolve().then(() => ctx.signal.aborted ? "deny" as const : ctx.approve(request)).then(finish, error => {
			if (settled) return;
			settled = true; cleanup(); reject(error);
		});
	});
}
