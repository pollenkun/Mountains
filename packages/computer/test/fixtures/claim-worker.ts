// Process-only protocol client. No desktop, account or browser code is loaded.
import { ComponentInputClaims, type ClaimStorageBinding } from "../../src/input-claim-mac.ts";
let claims: ComponentInputClaims | undefined;
process.on("message", async (value: { id: number; op: string; directory?: string; binding?: ClaimStorageBinding; command?: Record<string, unknown> }) => {
	try {
		let result: unknown;
		if (value.op === "connect") {
			claims = new ComponentInputClaims(value.directory!, value.binding);
			result = { pid: process.pid };
		} else if (value.op === "initialize") result = await claims!.initialize();
		else if (value.op === "close") { await claims?.close(); process.send?.({ id: value.id, result: {} }); process.disconnect(); return; }
		else result = await claims!.call(value.command!);
		process.send?.({ id: value.id, result });
	} catch (error) { process.send?.({ id: value.id, error: error instanceof Error ? error.message : String(error) }); }
});
