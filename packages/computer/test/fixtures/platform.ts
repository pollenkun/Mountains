/** Tests of the macOS helpers and acceptance harness: POSIX signals and sockets, /tmp, Unix file modes, osascript.
 * They do not apply on Windows, where computer use reads and captures windows only. */
export const POSIX_ONLY = { skip: process.platform === "win32" && "macOS helper or acceptance harness (POSIX signals and sockets, /tmp, Unix modes); Windows computer use is read-only" };
