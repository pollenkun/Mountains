import { homedir } from "node:os";
import { posix, win32 } from "node:path";

function paths(platform: NodeJS.Platform) {
	return platform === "win32" ? win32 : posix;
}

export function expandHome(path: string, home = homedir(), platform = process.platform): string {
	if (path === "~") return home;
	return path.startsWith("~/") || platform === "win32" && path.startsWith("~\\")
		? paths(platform).join(home, path.slice(2)) : path;
}

/** Preserve the existing default while allowing all CLI state to be relocated. */
export function mountainsHome(env = process.env, home = homedir(), platform = process.platform): string {
	return paths(platform).resolve(expandHome(env.MOUNTAINS_HOME || paths(platform).join(home, ".mountains"), home, platform));
}

/** OS-native cache parent; relative environment overrides must not follow the workspace. */
export function compileCacheParent(env = process.env, home = homedir(), platform = process.platform): string {
	const path = paths(platform);
	if (platform === "win32") {
		return env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(home, "AppData", "Local");
	}
	if (platform === "darwin") return path.join(home, "Library", "Caches");
	return env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(home, ".cache");
}
