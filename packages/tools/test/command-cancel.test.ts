import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCommandTool } from "../src/command.ts";
import type { ToolContext } from "../src/types.ts";
import { FileStateTracker, Workspace } from "../src/workspace.ts";

// Exercise the POSIX process-group fallback explicitly; native scope ownership
// and graceful cancellation are covered separately in linux-scope.test.ts.
const unsupportedPlatform = process.platform !== "darwin" && process.platform !== "linux";

interface ProcessState {
	pid: number;
	ppid: number;
	pgid: number;
	state: string;
	command: string;
}

function states(pids: number[]): Map<number, ProcessState> {
	if (pids.length === 0) return new Map();
	// Query only the exact PIDs recorded by this fixture, never unrelated processes.
	const result = spawnSync("ps", ["-p", pids.join(","), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "command="], { encoding: "utf8" });
	assert.ifError(result.error);
	assert.ok(result.status === 0 || result.status === 1, result.stderr);
	const found = new Map<number, ProcessState>();
	for (const line of result.stdout.trim().split("\n")) {
		if (!line) continue;
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		assert.ok(match, `unrecognized ps output: ${line}`);
		const pid = Number(match[1]);
		found.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), state: match[4]!, command: match[5]! });
	}
	return found;
}

function isRunning(state: ProcessState | undefined): boolean {
	// On Linux an orphan can briefly remain as a zombie until init reaps it.
	// A zombie has already exited and cannot run or respond to signals.
	return state !== undefined && !state.state.startsWith("Z");
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
	const until = Date.now() + 5000;
	while (Date.now() < until) {
		if (check()) return;
		await delay(25);
	}
	assert.ok(check(), description);
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

for (const entrypoint of ["argv", "shellScript"] as const) {
	test(`Cancellation stops a real ${entrypoint} process tree, including a SIGTERM-resistant grandchild`, { skip: unsupportedPlatform, timeout: 15_000 }, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "mountains-command-cancel-"));
		const fixture = join(root, "tree.cjs");
		const pidFiles = ["parent.pid", "child.pid", "grandchild.pid", ...(entrypoint === "shellScript" ? ["shell.pid"] : [])].map((name) => join(root, name));
		const ac = new AbortController();
		const ctx: ToolContext = {
			workspace: new Workspace(root), files: new FileStateTracker(),
			signal: ac.signal, toolCallId: t.name, approve: async () => "allow",
		};
		const recordedPids = () => pidFiles.filter(existsSync).map((path) => {
			const text = readFileSync(path, "utf8").trim();
			assert.match(text, /^\d+$/);
			const pid = Number(text);
			assert.ok(pid > 1 && pid !== process.pid, "fixture must not target the test runner or init");
			return pid;
		});
		let running: ReturnType<ReturnType<typeof createCommandTool>["execute"]> | undefined;
		t.after(async () => {
			try {
				ac.abort();
				try {
					// Failure cleanup is limited to this fixture's own recorded processes.
					for (const state of states(recordedPids()).values()) {
						if (!isRunning(state) || !state.command.includes(root)) continue;
						try { process.kill(state.pid, "SIGKILL"); }
						catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
					}
				} finally {
					if (running) await running;
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
		writeFileSync(fixture, `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [root, mode, stageText] = process.argv.slice(2);
const stage = Number(stageText);
if (mode === "ignore-all" || stage === 2) process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
if (stage < 2) spawn(process.execPath, [__filename, root, mode, String(stage + 1)], { stdio: "ignore" });
writeFileSync(join(root, ["parent.pid", "child.pid", "grandchild.pid"][stage]), String(process.pid));
`);
		const argv = [process.execPath, fixture, root, entrypoint === "argv" ? "ignore-all" : "ignore-grandchild", "0"];
		const args = entrypoint === "argv"
			? { argv, timeoutMs: 10_000 }
			: { shellScript: `printf '%s\\n' "$$" > ${quoteShell(join(root, "shell.pid"))}\n${argv.map(quoteShell).join(" ")} &\nwait`, timeoutMs: 10_000 };
		running = createCommandTool(undefined, {}, { probeLinuxScope: async () => false }).execute(args, ctx);
		await waitFor(() => pidFiles.every(existsSync), "parent, child and grandchild must start before cancellation");
		const pids = recordedPids();
		assert.equal(new Set(pids).size, pids.length);
		const before = states(pids);
		for (const pid of pids) assert.ok(isRunning(before.get(pid)), `fixture PID ${pid} must be running before cancellation`);
		const [parentPid, childPid, grandchildPid, shellPid] = pids;
		assert.equal(before.get(childPid!)?.ppid, parentPid, "fixture must contain a real child process");
		assert.equal(before.get(grandchildPid!)?.ppid, childPid, "fixture must contain a real grandchild process");
		const leader = shellPid ?? parentPid!;
		assert.equal(before.get(parentPid!)?.ppid, shellPid ?? process.pid);
		for (const pid of pids) assert.equal(before.get(pid)?.pgid, leader, "the tree must inherit the command's independent Unix process group");

		ac.abort();
		const result = await running;
		assert.equal(result.ok, false);
		assert.equal(result.details.cancelled, true);
		assert.equal(result.details.timedOut, false, "this must exercise cancellation, not the command timeout");
		assert.equal(result.details.signal, entrypoint === "argv" ? "SIGKILL" : "SIGTERM");
		await waitFor(() => {
			const remaining = states(pids);
			return pids.every((pid) => !isRunning(remaining.get(pid)));
		}, `cancelled command left a running process from this fixture: ${pids.join(", ")}`);
	});
}
