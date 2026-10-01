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
	/** 命令审批（未批准不得启动进程） */
	approve(req: ApprovalRequest): Promise<"allow" | "deny">;
	/** 写文件前的快照钩子（检查点） */
	beforeWrite?(absPath: string): Promise<void>;
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
