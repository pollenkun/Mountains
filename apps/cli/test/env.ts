import { join } from "node:path";

/** Keep child processes away from real credentials, home directories and caches. */
export function isolatedEnv(home: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: home,
		TEMP: home,
		TMP: home,
		MOUNTAINS_HOME: join(home, ".mountains"),
		XDG_CACHE_HOME: join(home, ".cache"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
	};
}
