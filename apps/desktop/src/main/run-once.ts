import { createEngineHost } from "./engine-host.ts";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		task: { type: "string" },
		workspace: { type: "string" },
		config: { type: "string" },
		out: { type: "string" },
		"run-id": { type: "string" },
		"spend-ledger": { type: "string" },
	},
	strict: true,
});

if (!values.task || !values.workspace || !values.out || !values.config || !values["spend-ledger"]) {
	process.stderr.write("run-once needs --task --workspace --config --out --spend-ledger\n");
	process.exit(2);
}

const host = createEngineHost({
	workspace: values.workspace,
	configPath: values.config,
	outDir: values.out,
	spendLedger: values["spend-ledger"],
	...(values["run-id"] ? { runId: values["run-id"] } : {}),
});

let status = "";
host.onEvent((event) => {
	if (event.type === "run.completed") status = event.status;
	if (event.type === "error") process.stderr.write(`${event.message}\n`);
});
host.handleCommand({ protocolVersion: "0.1.0", type: "run.start", task: values.task });
await host.whenIdle();
await host.dispose();
if (status !== "completed") {
	process.stderr.write(`run-once status ${status || "missing"}\n`);
	process.exit(1);
}
