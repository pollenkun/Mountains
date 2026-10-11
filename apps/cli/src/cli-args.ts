import { parseArgs } from "node:util";

export const USAGE = "用法：\n  mountains run --task <描述> | --task-file <路径> --workspace <路径> [--config <json>] [--json] [--out <目录>] [--run-id <id>] [--base-url <url>] [--spend-ledger <路径>]\n" +
	"  mountains replay --recording <recording.jsonl> --workspace <路径> [--out <目录>] [--json]\n";

export const parseRunArgs = (argv: string[]) => parseArgs({
		args: argv,
		options: {
			help: { type: "boolean", short: "h" },
			task: { type: "string" },
			"task-file": { type: "string" },
			workspace: { type: "string" },
			config: { type: "string" },
			json: { type: "boolean", default: false },
			out: { type: "string" },
			"run-id": { type: "string" },
			"base-url": { type: "string" },
			"spend-ledger": { type: "string" },
		},
		strict: true,
});

export const parseReplayArgs = (argv: string[]) => parseArgs({
		args: argv,
		options: { help: { type: "boolean", short: "h" }, recording: { type: "string" }, workspace: { type: "string" }, out: { type: "string" }, json: { type: "boolean", default: false } },
		strict: true,
});
