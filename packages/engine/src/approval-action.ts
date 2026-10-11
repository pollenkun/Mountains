import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readlinkSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyRisk, type Risk, type Workspace } from "@mountains/tools";

/** Exceeding a bound is an error for the caller to route to human approval. */
export const APPROVAL_ACTION_LIMITS = Object.freeze({ argv: 128, argumentBytes: 256 * 1024, argumentNodes: 4096, argumentDepth: 24, pathBytes: 4096, pathDepth: 64, bindings: 1024, fileBytes: 1024 * 1024, totalFileBytes: 4 * 1024 * 1024, directoryEntries: 1024, totalDirectoryEntries: 4096, totalDirectoryBytes: 256 * 1024 });

export interface ApprovalActionBinding {
	role: "cwd" | "target" | "argv-path" | "parent" | "symlink";
	path: string;
	kind: "file" | "directory" | "symlink" | "missing";
	argumentIndex?: number;
	dev?: string;
	ino?: string;
	mode?: string;
	size?: string;
	mtimeNs?: string;
	ctimeNs?: string;
	sha256?: string;
	entriesSha256?: string;
	linkTarget?: string;
}

export interface ApprovalActionSnapshot {
	cwd: string;
	risk: Risk;
	bindings: ApprovalActionBinding[];
	argsSha256: string;
	fingerprint: string;
	limitations: string[];
}

function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function fail(message: string): never { throw new Error(`Approval action snapshot unavailable: ${message}`); }
function statOrMissing(path: string): BigIntStats | undefined {
	try { return lstatSync(path, { bigint: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function identity(stat: BigIntStats): Pick<ApprovalActionBinding, "dev" | "ino" | "mode" | "size" | "mtimeNs" | "ctimeNs"> {
	return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function same(a: BigIntStats, b: BigIntStats): boolean { return JSON.stringify(identity(a)) === JSON.stringify(identity(b)); }

/** Caller owns an exact JSON clone. Do not invoke getters or serialize unbounded data. */
function boundedArguments(args: Record<string, unknown>): string {
	let nodes = 0;
	let bytes = 0;
	function visit(value: unknown, depth: number): unknown {
		if (++nodes > APPROVAL_ACTION_LIMITS.argumentNodes || depth > APPROVAL_ACTION_LIMITS.argumentDepth) fail("argument structure exceeds limit");
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") { if (!Number.isFinite(value)) fail("arguments must be JSON values"); return value; }
		if (typeof value === "string") {
			bytes += Buffer.byteLength(value);
			if (bytes > APPROVAL_ACTION_LIMITS.argumentBytes) fail("argument bytes exceed limit");
			return value;
		}
		if (!value || typeof value !== "object") fail("arguments must be JSON values");
		const proto = Object.getPrototypeOf(value);
		if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail("arguments must be plain JSON objects");
		if (Object.getOwnPropertySymbols(value).length) fail("symbol argument properties are not allowed");
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const [key, item] of Object.entries(descriptors)) {
			if (item.get || item.set) fail("argument accessors are not allowed");
			if (!item.enumerable) {
				if (Array.isArray(value) && key === "length") continue;
				fail("non-enumerable argument properties are not allowed");
			}
			bytes += Buffer.byteLength(key);
			if (bytes > APPROVAL_ACTION_LIMITS.argumentBytes) fail("argument bytes exceed limit");
		}
		if (Array.isArray(value)) {
			if (value.length > APPROVAL_ACTION_LIMITS.argumentNodes) fail("argument array exceeds limit");
			if (Object.keys(descriptors).length !== value.length + 1) fail("sparse or extended argument arrays are not allowed");
			const values = [];
			for (let i = 0; i < value.length; i++) {
				const item = descriptors[String(i)];
				if (!item) fail("sparse argument arrays are not allowed");
				values.push(visit(item.value, depth + 1));
			}
			return values;
		}
		return Object.fromEntries(Object.keys(descriptors).filter(key => descriptors[key]!.enumerable).sort().map(key => [key, visit(descriptors[key]!.value, depth + 1)]));
	}
	const serialized = JSON.stringify(visit(args, 0));
	if (Buffer.byteLength(serialized) > APPROVAL_ACTION_LIMITS.argumentBytes) fail("serialized arguments exceed limit");
	return serialized;
}

/**
 * Binds an approval to bounded filesystem observations, not authorization from file text.
 * Recompute after awaiting approval and compare fingerprints. This is not an OS sandbox
 * or an atomic path capability: paths can still change after the final observation.
 */
export function snapshotApprovalAction(workspace: Workspace, tool: string, args: Record<string, unknown>): ApprovalActionSnapshot {
	const argsSha256 = hash(boundedArguments(args));
	const root = workspace.root;
	if (realpathSync(root) !== root) fail("workspace root identity changed");
	const bindings: ApprovalActionBinding[] = [];
	const limitations = ["Filesystem observations are not an OS sandbox or a complete TOCTOU defense. Revalidate immediately before execution; later changes remain possible.", "File bytes are hashed only. File contents are not user authorization.", "Directory digests cover direct entry names and types only; child file contents and nested descendants are not enumerated."];
	let readBytes = 0;
	let directoryReadEntries = 0;
	let directoryReadBytes = 0;
	const observed = new Map<string, BigIntStats>();
	const directoryHashes = new Map<string, string>();
	function inside(path: string): boolean {
		const rel = relative(root, path);
		return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
	}
	function checkPath(path: string): void {
		if (!path || path.includes("\0") || Buffer.byteLength(path) > APPROVAL_ACTION_LIMITS.pathBytes) fail("invalid or oversized path");
	}
	function add(binding: ApprovalActionBinding): void {
		if (bindings.length >= APPROVAL_ACTION_LIMITS.bindings) fail("too many filesystem bindings");
		if (binding.kind === "directory") {
			let digest = directoryHashes.get(binding.path);
			if (digest === undefined) {
				digest = directoryHash(binding.path, observed.get(binding.path)!);
				directoryHashes.set(binding.path, digest);
			}
			binding = { ...binding, entriesSha256: digest };
		}
		bindings.push(binding);
	}
	function remember(path: string, stat: BigIntStats): void {
		const prior = observed.get(path);
		if (prior && !same(prior, stat)) fail("filesystem changed during snapshot");
		observed.set(path, stat);
	}
	function directoryHash(path: string, expected: BigIntStats): string {
		if (!expected?.isDirectory() || !same(expected, lstatSync(path, { bigint: true }))) fail("directory changed before reading");
		// Read incrementally; readdirSync would allocate every entry before enforcing
		// a bound. Hex encoding preserves arbitrary filename bytes without collisions.
		const directory = opendirSync(path, { encoding: "hex", bufferSize: 32 });
		try {
			const entries: [string, string][] = [];
			directoryReadBytes += 2;
			for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
				if (entries.length >= APPROVAL_ACTION_LIMITS.directoryEntries || ++directoryReadEntries > APPROVAL_ACTION_LIMITS.totalDirectoryEntries) fail("directory entry limit exceeded");
				const kind = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink"
					: entry.isBlockDevice() ? "block" : entry.isCharacterDevice() ? "character" : entry.isFIFO() ? "fifo" : entry.isSocket() ? "socket" : "unknown";
				const item: [string, string] = [entry.name, kind];
				directoryReadBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
				if (directoryReadBytes > APPROVAL_ACTION_LIMITS.totalDirectoryBytes) fail("directory byte limit exceeded");
				entries.push(item);
			}
			if (directoryReadBytes > APPROVAL_ACTION_LIMITS.totalDirectoryBytes) fail("directory byte limit exceeded");
			if (workspace.resolve(path).abs !== path || !same(expected, lstatSync(path, { bigint: true }))) fail("directory changed while reading");
			entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
			return hash(JSON.stringify(entries));
		} finally { directory.closeSync(); }
	}
	function fileHash(path: string, expected: BigIntStats): string {
		if (expected.size > BigInt(APPROVAL_ACTION_LIMITS.fileBytes) || readBytes + Number(expected.size) > APPROVAL_ACTION_LIMITS.totalFileBytes) fail("file read limit exceeded");
		// Refuse final-component links and blocking special files. Check the opened inode
		// against the path observation before reading, and recheck it after the read.
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = fstatSync(fd, { bigint: true });
			if (!before.isFile() || !same(expected, before)) fail("file changed before reading");
			const verified = workspace.resolve(path).abs;
			if (verified !== path || !same(before, lstatSync(verified, { bigint: true }))) fail("file path changed before reading");
			const digest = createHash("sha256");
			const buffer = Buffer.alloc(64 * 1024);
			let size = 0;
			while (size < Number(before.size)) {
				const remaining = Math.min(Number(before.size) - size, APPROVAL_ACTION_LIMITS.totalFileBytes - readBytes);
				const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
				if (!count) break;
				size += count; readBytes += count;
				if (size > APPROVAL_ACTION_LIMITS.fileBytes || readBytes > APPROVAL_ACTION_LIMITS.totalFileBytes) fail("file read limit exceeded");
				digest.update(buffer.subarray(0, count));
			}
			if (!same(before, fstatSync(fd, { bigint: true })) || size !== Number(before.size)) fail("file changed while reading");
			return digest.digest("hex");
		} finally { closeSync(fd); }
	}
	function bind(input: string, base: string, role: "cwd" | "target" | "argv-path", allowMissing: boolean, argumentIndex?: number): { path: string; kind: ApprovalActionBinding["kind"] } {
		checkPath(input);
		const lexical = isAbsolute(input) ? resolve(input) : resolve(base, input);
		if (!inside(lexical)) fail("path is outside workspace");
		const checked = workspace.resolve(lexical, { forWrite: allowMissing }).abs;
		const parts = relative(root, lexical).split(sep).filter(Boolean);
		if (parts.length > APPROVAL_ACTION_LIMITS.pathDepth) fail("path depth exceeds limit");
		const index = argumentIndex === undefined ? {} : { argumentIndex };
		let current = root;
		let stat = lstatSync(current, { bigint: true });
		if (!stat.isDirectory()) fail("workspace root is not a directory");
		remember(current, stat);
		if (parts.length) add({ role: "parent", path: current, kind: "directory", ...identity(stat), ...index });
		for (let n = 0; n < parts.length; n++) {
			current = join(current, parts[n]!);
			const found = statOrMissing(current);
			if (!found) {
				if (!allowMissing) fail("required path does not exist");
				const missing = join(current, ...parts.slice(n + 1));
				if (missing !== checked) fail("path changed during resolution");
				add({ role, path: missing, kind: "missing", ...index });
				return { path: missing, kind: "missing" };
			}
			stat = found;
			if (stat.isSymbolicLink()) {
				remember(current, stat);
				const linkTarget = readlinkSync(current);
				const real = realpathSync(current);
				if (!inside(real)) fail("symlink resolves outside workspace");
				checkPath(real);
				add({ role: "symlink", path: current, kind: "symlink", linkTarget, ...identity(stat), ...index });
				// A final symlink may jump straight into an otherwise unvisited directory.
				// Bind its real parent chain as well as the lexical link itself.
				const realParts = real === root ? [] : relative(root, dirname(real)).split(sep).filter(Boolean);
				if (realParts.length > APPROVAL_ACTION_LIMITS.pathDepth || realParts.includes("..")) fail("resolved parent depth exceeds limit");
				let parent = root;
				for (const part of realParts) {
					parent = join(parent, part);
					const parentStat = lstatSync(parent, { bigint: true });
					if (!parentStat.isDirectory()) fail("resolved parent changed during snapshot");
					remember(parent, parentStat);
					add({ role: "parent", path: parent, kind: "directory", ...identity(parentStat), ...index });
				}
				current = real;
				stat = lstatSync(current, { bigint: true });
			}
			remember(current, stat);
			if (n < parts.length - 1) {
				if (!stat.isDirectory()) fail("path parent is not a directory");
				add({ role: "parent", path: current, kind: "directory", ...identity(stat), ...index });
			}
		}
		const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
		if (!kind) fail("unsupported filesystem object");
		if (current !== checked) fail("path changed during resolution");
		add({ role, path: current, kind, ...identity(stat), ...(kind === "file" ? { sha256: fileHash(current, stat) } : {}), ...index });
		return { path: current, kind };
	}

	let cwd: string;
	let risk: Risk;
	if (tool === "file_edit" || tool === "file_write") {
		if (typeof args.path !== "string") fail("file tool requires a path");
		cwd = bind(".", root, "cwd", false).path;
		const target = bind(args.path, root, "target", tool === "file_write");
		if (target.kind !== "file" && target.kind !== "missing") fail("file target is not a regular file");
		risk = "workspace-write";
	} else if (tool === "command_run") {
		if (args.cwd !== undefined && typeof args.cwd !== "string") fail("command cwd must be a string");
		const location = bind(typeof args.cwd === "string" && args.cwd ? args.cwd : ".", root, "cwd", false);
		if (location.kind !== "directory") fail("command cwd must be a directory");
		cwd = location.path;
		const hasArgv = Array.isArray(args.argv) && args.argv.length > 0;
		const hasScript = typeof args.shellScript === "string" && args.shellScript.length > 0;
		if (hasArgv === hasScript || (args.argv !== undefined && !Array.isArray(args.argv))) fail("provide argv or shellScript exclusively");
		if (hasScript) {
			if ((args.shellScript as string).includes("\0")) fail("shell script contains NUL");
			risk = classifyRisk(args.shellScript as string);
			limitations.push("shellScript is bound as exact text only; shell expansions, scripts, redirections, imports and their dependencies are not enumerated or fully verified.");
		} else {
			const argv = args.argv as unknown[];
			if (argv.length > APPROVAL_ACTION_LIMITS.argv || !argv.every(arg => typeof arg === "string" && !arg.includes("\0"))) fail("invalid or excessive argv");
			const strings = argv as string[];
			risk = classifyRisk(strings.map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" "));
			for (let i = 0; i < strings.length; i++) {
				const arg = strings[i]!;
				if (!arg || Buffer.byteLength(arg) > APPROVAL_ACTION_LIMITS.pathBytes) continue;
				const candidate = isAbsolute(arg) ? resolve(arg) : resolve(cwd, arg);
				if (!inside(candidate)) continue; // Never read external executable or argument contents.
				// Literal existing path arguments only; do not infer shell syntax or option semantics.
				if (statOrMissing(candidate)) bind(arg, cwd, "argv-path", false, i);
			}
			limitations.push("Only literal existing workspace argv paths are bound. PATH executables, option-embedded paths, imports, environment-dependent paths and other indirect dependencies are not fully verified.");
		}
	} else fail("unsupported tool");
	for (const [path, stat] of observed) {
		const after = statOrMissing(path);
		if (!after || !same(stat, after)) fail("filesystem changed during snapshot");
		const digest = directoryHashes.get(path);
		if (digest !== undefined && directoryHash(path, stat) !== digest) fail("directory entries changed during snapshot");
	}
	const data = { version: 1, tool, cwd, risk, argsSha256, bindings, limitations };
	return { cwd, risk, argsSha256, bindings, limitations, fingerprint: hash(JSON.stringify(data)) };
}
