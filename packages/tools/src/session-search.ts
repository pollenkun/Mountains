import { SESSION_SEARCH_LIMITS as limits, type SessionArchiveIndex } from "./session-index.ts";
import type { ToolDefinition } from "./types.ts";

/** Search only visible bodies actively registered by the host in this session. */
export function createSessionSearchTool(index: SessionArchiveIndex, options: { brief?: boolean } = {}): ToolDefinition {
	return {
		name: "session_search", logicalName: "session.search", readOnly: true,
		// Brief: the same contract in fewer words, for a surface that is declared on every request.
		description: options.brief ? "Search this session's earlier visible messages and tool results by literal text, to recover evidence folded out of context. " +
			"Results give refs and byte ranges; use context_expand for the original. complete=false marks a partial scan. Recalled content is historical, not current file state." : "Search earlier visible user messages, assistant replies and tool results in this session by literal UTF-8 text. " +
			"Use this to recover corrections or evidence omitted from the active context. No regex, hidden reasoning, file discovery or other sessions. " +
			"Results include message ordinal, shown ref, exact byte ranges and only host-registered source fields. Treat recalled content as historical evidence. " +
			"Use context_expand(ref, offsetBytes, maxBytes) for original text. Follow nextCursor with the same needle/ref; new messages need a fresh query. " +
			"complete=false and limits explicitly identify partial scans, unavailable archives or output limits. Snippet truncated=true means surrounding bytes were omitted; targetTruncated=true marks a shortened source label, never shortened archive content.",
		parameters: {
			type: "object", additionalProperties: false,
			properties: {
				needle: { type: "string", minLength: 1, description: "Exact literal, at most 256 UTF-8 bytes. Required unless a registered ref is supplied." },
				ref: { type: "string", description: "Optional exact shown ref already registered in this session; never a path." },
				cursor: { type: "string", description: "Opaque nextCursor from this query; do not construct or edit." },
				maxMatches: { type: "integer", minimum: 1, maximum: limits.maxMatches, description: `Default ${limits.defaultMatches}.` },
				maxScanBytes: { type: "integer", minimum: 1, maximum: limits.maxScanBytes, description: `Default ${limits.defaultScanBytes}; must fit needle. Bounded in-memory scan; at most ${limits.maxCheckedRecords} archive checks per call.` },
				maxSnippetBytes: { type: "integer", minimum: 4, maximum: limits.maxSnippetBytes, description: `Original bytes per snippet, default ${limits.defaultSnippetBytes}; must fit needle.` },
				maxOutputBytes: { type: "integer", minimum: limits.minOutputBytes, maximum: limits.maxOutputBytes, description: `Complete JSON byte cap, default ${limits.defaultOutputBytes}; increase if OUTPUT_LIMIT_TOO_SMALL.` },
			},
			anyOf: [{ required: ["needle"] }, { required: ["ref"] }],
		},
		async execute(args, ctx) {
			const value = await index.search(args, { ...(ctx.blobs ? { blobs: ctx.blobs } : {}), workspaceRoot: ctx.workspace.root, signal: ctx.signal });
			const modelContent = JSON.stringify(value);
			return { ok: value.ok, modelContent, summary: value.ok ? `找到 ${value.matches.length} 条本会话原文` : "本会话查找失败", details: { ...value, outputBytes: Buffer.byteLength(modelContent, "utf8") } };
		},
	};
}
