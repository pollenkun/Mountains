import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktop } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
startDesktop({ root: basename(here) === "dist" ? join(here, "..") : join(here, "..", "..") });
