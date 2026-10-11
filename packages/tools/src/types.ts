import type { BlobStore, FileStateTracker, Workspace } from "./workspace.ts";

export type Risk = "read-only" | "workspace-write" | "network" | "dangerous";

export interface ApprovalRequest {
	toolCallId: string;
	command: string;
	cwd: string;
	risk: Risk;
	explanation: string;
}

export interface ReadRecord {
	path: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	hash: string;
}

export interface WriteRecord {
	path: string;
	beforeHash: string | null;
	afterHash: string;
}

export interface ToolResult {
	ok: boolean;
	/** 发给模型的内容 */
	modelContent: string;
	/** 一句话模板摘要（给界面折叠视图，不调用模型） */
	summary: string;
	/** 给界面的完整详情 */
	details: Record<string, unknown>;
	/** Complete source lines actually present in modelContent, never merely requested/omitted ranges. */
	reads?: ReadRecord[];
	writes?: WriteRecord[];
	/** 不可变的完整原始字节引用。与驱动另存的模型展示文字引用不同。 */
	fullOutputRef?: string;
}

export interface ToolContext {
	workspace: Workspace;
	files: FileStateTracker;
	blobs?: BlobStore;
	signal: AbortSignal;
	toolCallId: string;
	/** The engine will mark returned reads delivered only after publishing the result. Defaults to legacy immediate tracking. */
	deferReadPublication?: boolean;
	/** 操作审批（命令必须通过；文件写入在 approveFileWrites 开启时必须通过）。 */
	approve(req: ApprovalRequest): Promise<"allow" | "deny">;
	/** 写文件前的快照钩子（检查点） */
	beforeWrite?(absPath: string): Promise<void>;
	/** Optional final authorization check, immediately before a mutation or spawn. */
	assertExecutionAllowed?(): void;
}

export interface ToolDefinition {
	/** 发给模型的名字（DeepSeek 要求 ^[a-zA-Z0-9_-]+$） */
	name: string;
	/** 对外的逻辑名，例如 file.read */
	logicalName: string;
	description: string;
	parameters: Record<string, unknown>;
	readOnly: boolean;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
