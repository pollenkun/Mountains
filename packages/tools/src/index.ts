import { createCommandTool } from "./command.ts";
import { createCodeLookupTool } from "./code-lookup.ts";
import { createArchiveSearchTool } from "./archive-search.ts";
import { createEditTool, createReadTool, createWriteTool, DEFAULT_READ_LIMITS, type ReadLimits } from "./files.ts";
import { createOutlineTool } from "./outline.ts";
import { createMemoryTool, createMemoryQueryTool, type MemoryStore } from "./memory.ts";
import { createPlanTool } from "./plan.ts";
import { createRecipeTool, type QueryRecipeStore } from "./recipes.ts";
import { createExpandTool } from "./recall.ts";
import { createGlobTool, createSearchTool, type SearchLimits } from "./search.ts";
import type { ToolDefinition } from "./types.ts";

export * from "./command.ts";
export * from "./code-lookup.ts";
export * from "./archive-search.ts";
export * from "./files.ts";
export * from "./outline.ts";
export * from "./memory.ts";
export * from "./plan.ts";
export * from "./recipes.ts";
export * from "./recall.ts";
export * from "./search.ts";
export * from "./types.ts";
export * from "./workspace.ts";

/** 默认工具集合。顺序固定（工具定义属于稳定前缀）。 */
export interface DefaultToolOptions {
	read?: Partial<ReadLimits>;
	outline?: boolean;
	expand?: boolean;
	/** Optional immutable command-output lookup; requires expand for full recovery. */
	archiveSearch?: boolean;
	search?: Partial<SearchLimits>;
	/** 可选配置：content_search 支持 path 作用域并拒绝未知参数。 */
	searchPath?: boolean;
	/** 工具回执不给模型看哈希和审计引用（仍记录在 details 与归档中）；没有取回工具时这些对模型无用。 */
	leanOutput?: boolean;
	/** 可选配置：content_search 搜的是代码标识符时，附带同名定义的位置。 */
	searchSymbols?: boolean;
	/** 可选配置：code_lookup（Python 符号的定义、调用与被调用，一次返回）。 */
	codeLookup?: boolean;
	batchEdit?: boolean;
	queryPlans?: boolean;
	recipes?: QueryRecipeStore;
	memory?: MemoryStore;
	verifiedMemory?: boolean;
}

export function defaultTools(options: DefaultToolOptions = {}): ToolDefinition[] {
	if (options.archiveSearch !== undefined && typeof options.archiveSearch !== "boolean") throw new Error("archiveSearch 必须是布尔值");
	if (options.archiveSearch && options.expand !== true) throw new Error("archiveSearch 需要 expand");
	const recovery = { contextExpand: options.expand ?? false, archiveSearch: options.archiveSearch ?? false, lean: options.leanOutput === true };
	return [
		createReadTool({ ...DEFAULT_READ_LIMITS, ...options.read }, recovery),
		// 可选配置：结构大纲工具放在 file_read 之后（工具定义顺序固定，属于稳定前缀）
		...(options.outline ? [createOutlineTool()] : []),
		createSearchTool(options.search, { pathScope: options.searchPath === true, symbolHints: options.searchSymbols === true }),
		// 可选配置：放在 content_search 之后，工具目录在一次运行内固定
		...(options.codeLookup ? [createCodeLookupTool()] : []),
		createGlobTool(),
		createEditTool({ batch: options.batchEdit ?? false, lean: options.leanOutput === true }),
		createWriteTool({ lean: options.leanOutput === true }),
		createCommandTool(undefined, recovery),
		// 可选：取回被移出上下文的工具结果（放在最后，不改变其他配置的工具前缀）
		...(options.expand ? [createExpandTool()] : []),
		// 可选：记录带证据的项目笔记（记忆层开启时）
		...(options.memory ? [createMemoryTool(options.memory, { verifiedFacts: options.verifiedMemory ?? false })] : []),
		...(options.memory && options.verifiedMemory ? [createMemoryQueryTool(options.memory)] : []),
		...(options.queryPlans ? [createPlanTool({ ...(options.read ? { read: options.read } : {}), ...(options.recipes ? { recipes: options.recipes } : {}) })] : []),
		...(options.queryPlans && options.recipes ? [createRecipeTool(options.recipes, options.read ? { read: options.read } : {})] : []),
		...(options.archiveSearch ? [createArchiveSearchTool()] : []),
	];
}
