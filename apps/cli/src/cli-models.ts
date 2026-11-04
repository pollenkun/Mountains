import { suggestModels } from "@mountains/providers";

export function searchModels(args: string[]): void {
	if (args[0] !== "search") throw new Error("用法：mountains models search <关键词>");
	const query = args.slice(1).join(" ").trim();
	if (!query) throw new Error("用法：mountains models search <关键词>");
	const hits = suggestModels(query);
	if (!hits.length) {
		process.stdout.write("没有匹配的模型。\n");
		return;
	}
	for (const hit of hits) {
		const note = hit.keywordOnly ? "  只匹配关键词，不能调用" : "";
		process.stdout.write(`${hit.displayName}  ${hit.provider}/${hit.id}${note}\n`);
	}
}
