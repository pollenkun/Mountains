import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { ToolError } from "./workspace.ts";

/** Reject special files before opening; nonblocking open also covers a FIFO swap. */
export function readRegularFile(abs: string): Buffer {
	const before = lstatSync(abs);
	if (!before.isFile()) throw new ToolError("Not a regular file; refusing to read a directory, link, or special file");
	const fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new ToolError("File changed before read or is not a regular file");
		return readFileSync(fd);
	} finally { closeSync(fd); }
}
