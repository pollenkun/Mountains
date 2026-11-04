import { release } from "node:os";

/** NAPI's generic missing-binding error can wrap the real dlopen failure several causes deep. */
export function xa11yLoadError(error: unknown, platform: NodeJS.Platform = process.platform, kernelRelease = release()): Error {
	if (platform === "darwin" && /^22(?:\.|$)/.test(kernelRelease)) {
		const seen = new Set<unknown>();
		let current = error;
		while (current !== null && typeof current === "object" && !seen.has(current)) {
			seen.add(current);
			const message = "message" in current && typeof current.message === "string" ? current.message : "";
			if (/Symbol not found:\s*_OBJC_CLASS_\$_SCScreenshotManager\b/.test(message)) {
				return new Error("无法加载 xa11y：当前原生组件引用了 macOS 14 才提供的 SCScreenshotManager，无法在 macOS 13 上加载。请换用兼容 macOS 13 的组件构建，或在 macOS 14 及以上重试。重新安装同一组件或修改辅助功能权限无法解决此错误。", { cause: error });
			}
			current = "cause" in current ? current.cause : undefined;
		}
	}
	return new Error(`无法加载 xa11y（这个平台可能没有预编译版本）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
