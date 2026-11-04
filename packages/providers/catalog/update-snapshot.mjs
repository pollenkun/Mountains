#!/usr/bin/env node
// 重新拉取 https://models.dev/api.json ，写成精简快照。不改手写的 8 个模型。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const response = await fetch("https://models.dev/api.json");
if (!response.ok) throw new Error(`models.dev ${response.status}`);
const src = await response.json();
const providers = {};
for (const [prov, block] of Object.entries(src)) {
	const models = {};
	for (const [id, model] of Object.entries(block.models ?? {})) {
		const limit = model.limit ?? {};
		const inputs = (model.modalities?.input ?? []).filter(item => item === "text" || item === "image");
		const cost = model.cost;
		const entry = {
			name: model.name || id,
			reasoning: Boolean(model.reasoning),
			context: Number(limit.context || 0),
			output: Number(limit.output || 0),
			input: inputs.length ? inputs : ["text"],
			interleaved: Boolean(model.interleaved?.field),
		};
		if (cost && Number.isFinite(cost.input) && Number.isFinite(cost.output)) {
			entry.cost = { input: cost.input, output: cost.output };
			if (Number.isFinite(cost.cache_read)) entry.cost.cache_read = cost.cache_read;
			if (Number.isFinite(cost.cache_write)) entry.cost.cache_write = cost.cache_write;
		}
		models[id] = entry;
	}
	if (Object.keys(models).length) providers[prov] = { name: block.name || prov, models };
}
const dest = join(dirname(fileURLToPath(import.meta.url)), "models.dev.snapshot.json");
writeFileSync(dest, JSON.stringify({
	source: "https://models.dev/api.json",
	license: "MIT",
	fetchedAt: new Date().toISOString(),
	providers,
}));
process.stdout.write(`wrote ${dest}\n`);
