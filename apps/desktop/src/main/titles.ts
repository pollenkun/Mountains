/**
 * Conversation titles summarized by a model: after a conversation's first finished run, its first request and
 * reply are turned into a few words by the chosen model (the run's own by default) with the least thinking.
 * The cost goes into the spend ledger as a plain spent row: it was never reserved, and a budget.settle row without
 * its reservation would stop the ledger from being read at all. A conversation the user has named is left alone.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { keyEnvFor, previewRun, summarizeTitle } from "@mountains/cli/run-session";
import type { Desk } from "./desk.ts";
import type { HostOptions } from "./engine-host.ts";
import { loadKey } from "./keys.ts";

export interface TitleChoice { enabled: boolean; model?: string }

export function bindTitles(desk: Desk, options: HostOptions, choice: () => TitleChoice & { runModel?: string }): void {
	const asked = new Set<string>();
	desk.onEvent((id, event) => {
		if (event.agent || event.type !== "run.completed" || event.status !== "completed" || asked.has(id)) return;
		const { enabled, model, runModel } = choice();
		const conversation = desk.list().find((c) => c.id === id);
		if (!enabled || !conversation || conversation.named) return;
		asked.add(id);
		const history = desk.history(id);
		const request = history.find((e) => !e.agent && e.type === "run.started");
		const reply = history.find((e) => !e.agent && e.type === "message.completed" && e.text.trim());
		if (!request || request.type !== "run.started") return;
		const text = `User: ${request.task}${reply && reply.type === "message.completed" ? `\nAssistant: ${reply.text}` : ""}`.slice(0, 3000);
		const { config, spendLedger } = previewRun(options.configPath, runModel ? { model: runModel } : {}, options.spendLedger);
		const using = model ?? config.model;
		const env = keyEnvFor(using, config);
		if (env) loadKey(env);
		void summarizeTitle(using, config, text, options.fetch ? { fetch: options.fetch } : {}).then(({ title, cost, currency }) => {
			desk.nameAuto(id, title);
			if (cost !== null) appendFileSync(spendLedger, `${JSON.stringify({ at: new Date().toISOString(), currency, runId: `title_${id}_${randomUUID().slice(0, 8)}`, amount: cost })}\n`);
		}).catch((error: unknown) => console.error(`mountains: no title for ${id}: ${error instanceof Error ? error.message : String(error)}`));
	});
}
