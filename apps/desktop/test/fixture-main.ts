/** Electron entry for the hidden-window tests. The shipped entry is src/main/index.ts and reads none of these variables. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktop } from "../src/main/app.ts";
import { installDesktopFakeFetch } from "./fake-fetch.ts";
import { runProbe } from "./probe.ts";

const env = process.env;
if (env.MOUNTAINS_DESKTOP_FAKE) installDesktopFakeFetch(env.MOUNTAINS_DESKTOP_FAKE);
const theme = env.MOUNTAINS_DESKTOP_THEME;

startDesktop({
	root: join(dirname(fileURLToPath(import.meta.url)), ".."),
	hidden: env.MOUNTAINS_DESKTOP_VISIBLE !== "1",
	titles: env.MOUNTAINS_DESKTOP_TITLES === "1",
	...(theme === "dark" || theme === "light" || theme === "system" ? { theme } : {}),
	host: {
		...(env.MOUNTAINS_DESKTOP_WORKSPACE ? { workspace: env.MOUNTAINS_DESKTOP_WORKSPACE } : {}),
		...(env.MOUNTAINS_DESKTOP_CONFIG ? { configPath: env.MOUNTAINS_DESKTOP_CONFIG } : {}),
		...(env.MOUNTAINS_DESKTOP_OUT ? { outDir: env.MOUNTAINS_DESKTOP_OUT } : {}),
		...(env.MOUNTAINS_DESKTOP_LEDGER ? { spendLedger: env.MOUNTAINS_DESKTOP_LEDGER } : {}),
	},
	drive: runProbe,
});
