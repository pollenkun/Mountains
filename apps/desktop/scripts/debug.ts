/**
 * Debug entry (npm run desktop:debug): the real app, on this Mac's own key from the Keychain
 * (mountains-deepseek / api), with its developer tools in their own window.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktop } from "../src/main/app.ts";

startDesktop({ root: join(dirname(fileURLToPath(import.meta.url)), ".."), devTools: true });
