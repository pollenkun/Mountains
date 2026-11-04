/** A question the model asks the user. The run waits until they pick, type, or skip. */
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@mountains/tools";

export interface UserQuestion {
	id: string;
	question: string;
	choices: { label: string; detail: string }[];
	/** Extra text, such as the lines that would be added to AGENTS.md. */
	body?: string;
}

const pending = new Map<string, (answer: string) => void>();

export function answerQuestion(id: string, text: string): boolean {
	const resolve = pending.get(id);
	if (!resolve) return false;
	pending.delete(id);
	resolve(text);
	return true;
}

/** The model may replace AGENTS.md only after the user approves the added lines. */
export function createAgentsTool(options: { allowed: () => boolean; read: () => string; write: (text: string) => void; notify: (question: UserQuestion) => void }): ToolDefinition {
	return {
		name: "update_agents",
		logicalName: "agents.write",
		readOnly: false,
		description: "Replace the user's global AGENTS.md, which later conversations will follow. Only call this when they asked you to remember a rule. They must approve the change; if they have not allowed it, say so and stop.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["text"],
			properties: { text: { type: "string", minLength: 1, maxLength: 64_000 } },
		},
		async execute(args) {
			if (!options.allowed()) return { ok: false, modelContent: "The user has not allowed changes to AGENTS.md.", summary: "未允许修改 AGENTS.md", details: {} };
			const next = typeof args.text === "string" ? args.text : "";
			if (!next.trim()) return { ok: false, modelContent: "text is empty", summary: "没有要写入的内容", details: {} };
			const before = options.read();
			const old = new Set(before.split("\n"));
			const added = next.split("\n").filter((line) => line.trim() && !old.has(line)).slice(0, 40);
			const id = `agents_${randomUUID().slice(0, 8)}`;
			const answer = await new Promise<string>((resolve) => {
				pending.set(id, resolve);
				options.notify({ id, question: "修改 ~/.mountains/AGENTS.md", choices: [{ label: "通过批准", detail: "" }, { label: "拒绝请求", detail: "" }], body: added.length ? added.map((line) => `+ ${line}`).join("\n") : next.slice(0, 2000) });
			});
			if (!answer.startsWith("A")) return { ok: false, modelContent: "The user declined the AGENTS.md change.", summary: "没有改 AGENTS.md", details: {} };
			options.write(next.slice(0, 64 * 1024));
			return { ok: true, modelContent: "AGENTS.md was updated and applies from now on.", summary: "已写入 AGENTS.md", details: {} };
		},
	};
}

export function createAskTool(notify: (question: UserQuestion) => void): ToolDefinition {
	return {
		name: "ask_user",
		logicalName: "user.ask",
		readOnly: true,
		description: "Ask the user one question when their choice changes what you should do. Give 2 to 4 choices. They may also type their own answer or skip. Do not use this for something you can look up yourself.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["question", "choices"],
			properties: {
				question: { type: "string", minLength: 1, maxLength: 200 },
				choices: {
					type: "array",
					minItems: 2,
					maxItems: 4,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["label"],
						properties: {
							label: { type: "string", minLength: 1, maxLength: 80 },
							detail: { type: "string", maxLength: 160 },
						},
					},
				},
			},
		},
		async execute(args) {
			const question = typeof args.question === "string" ? args.question.trim() : "";
			const raw = Array.isArray(args.choices) ? args.choices : [];
			const choices = raw.flatMap((item) => {
				if (!item || typeof item !== "object") return [];
				const row = item as { label?: unknown; detail?: unknown };
				const label = typeof row.label === "string" ? row.label.trim() : "";
				if (!label) return [];
				return [{ label: label.slice(0, 80), detail: typeof row.detail === "string" ? row.detail.trim().slice(0, 160) : "" }];
			}).slice(0, 4);
			if (!question || choices.length < 2) return { ok: false, modelContent: "A question needs a prompt and at least two choices.", summary: "提问不完整", details: {} };
			const id = `ask_${randomUUID().slice(0, 8)}`;
			const answer = await new Promise<string>((resolve) => {
				pending.set(id, resolve);
				notify({ id, question: question.slice(0, 200), choices });
			});
			return { ok: true, modelContent: answer, summary: "已回答", details: { id } };
		},
	};
}
