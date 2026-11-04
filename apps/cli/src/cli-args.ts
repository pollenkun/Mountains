import { parseArgs } from "node:util";

export const USAGE = "用法：\n  mountains run --task <描述> | --task-file <路径> --workspace <路径> [--config <json>] [--json] [--out <目录>] [--run-id <id>] [--base-url <url>] [--spend-ledger <路径>]\n" +
	"  mountains models search <关键词>（最多 3 个模型）\n" +
	"  mountains replay --recording <recording.jsonl> --workspace <路径> [--out <目录>] [--json]\n" +
	"  mountains secret add|list|remove …（Computer-use 用的保存密码，见 mountains secret）\n" +
	"  mountains computer-history [--days <天数>]（Computer-use 做过的操作，只记元数据）\n";

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
			"tool-observer-ipc": { type: "boolean", default: false },
		},
		strict: true,
});

export const parseReplayArgs = (argv: string[]) => parseArgs({
		args: argv,
		options: { help: { type: "boolean", short: "h" }, recording: { type: "string" }, workspace: { type: "string" }, out: { type: "string" }, json: { type: "boolean", default: false } },
		strict: true,
});
