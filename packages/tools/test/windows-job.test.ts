import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createServer, Server, Socket } from "node:net";
import type { spawn, SpawnOptions } from "node:child_process";
import {
	quoteWindowsJobArgument, resolveWindowsJobProgram, spawnWindowsJob,
	WINDOWS_JOB_BOOTSTRAP, WINDOWS_JOB_SOURCE, type WindowsJobProcess, type WindowsJobHost,
} from "../src/windows-job.ts";

const cwd = "C:\\workspace";

class FakeSocket extends EventEmitter {
	destroyed = false;
	writes: string[] = [];
	setEncoding(_encoding: string) { return this; }
	write(value: string) { this.writes.push(value); return true; }
	destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
	message(value: string) { this.emit("data", `${value}\n`); }
}

function fixture(override: WindowsJobHost = {}) {
	const child = new EventEmitter() as WindowsJobProcess;
	const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
	Object.assign(child, {
		pid: 42, exitCode: null, signalCode: null,
		stdin, stdout, stderr,
	});
	let killed = 0;
	child.kill = () => { killed++; return true; };
	const server = new EventEmitter() as Server;
	let listener!: (socket: Socket) => void;
	let address = "", payload = "", command = "", args: readonly string[] = [];
	let options: unknown;
	child.stdin.on("data", chunk => { payload += chunk.toString(); });
	let resolvePayload!: () => void;
	const payloadReady = new Promise<void>(resolve => { resolvePayload = resolve; });
	child.stdin.on("finish", resolvePayload);
	server.listen = ((value: string, callback: () => void) => {
		address = value; queueMicrotask(callback); return server;
	}) as Server["listen"];
	server.close = (() => server) as Server["close"];
	const host: WindowsJobHost = {
		platform: "win32", inheritedEnvironment: { SystemRoot: "C:\\Windows" },
		isFile: path => ["c:\\tools\\node.exe", "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe"].includes(path.toLowerCase()),
		createServer: ((callback: (socket: Socket) => void) => { listener = callback; return server; }) as typeof createServer,
		// Node's other overloads can return null streams. This fixture accepts only
		// the helper's validated three-pipe call, whose streams are the PassThroughs above.
		spawn: ((program: string, argvOrOptions?: readonly string[] | SpawnOptions, spawnOptions?: SpawnOptions) => {
			assert.ok(Array.isArray(argvOrOptions), "the helper must receive a direct argument list");
			assert.deepEqual(spawnOptions?.stdio, ["pipe", "pipe", "pipe"], "the fake streams require the helper's piped stdio contract");
			command = program; args = argvOrOptions; options = spawnOptions; return child;
		}) as unknown as typeof spawn,
		startupMs: 1000, stopMs: 1000, exitMs: 1000,
		...override,
	};
	const launched = spawnWindowsJob("node", ["参数", "two words", "$() & | > ;", ""], { cwd, env: { Path: "C:\\tools", SystemRoot: "C:\\Windows" } }, host);
	const data = async () => {
		await payloadReady;
		return JSON.parse(payload) as { source: string; program: string; commandLine: string; cwd: string; environment: string[]; pipe: string; token: string };
	};
	const connect = async () => {
		const request = await data();
		const socket = new FakeSocket();
		listener(socket as unknown as Socket);
		socket.message(`${request.token}\tHELLO`);
		return { socket, request };
	};
	const close = (code = 0) => { Object.assign(child, { exitCode: code }); child.emit("exit", code, null); child.emit("close", code, null); };
	return { child: launched, stdout, stderr, server, data, connect, close, killed: () => killed, invocation: () => ({ command, args, options, address }) };
}

test("Windows argv quoting matches fixed libuv CRT examples, including empty and trailing slash arguments", () => {
	const cases: Array<[string, string]> = [
		["", '""'], ["plain", "plain"], ["two words", '"two words"'],
		[String.raw`hello"world`, String.raw`"hello\"world"`],
		[String.raw`hello\"world`, String.raw`"hello\\\"world"`],
		[String.raw`hello\\"world`, String.raw`"hello\\\\\"world"`],
		["hello world\\", '"hello world\\\\"'],
		["中文\t参数", '"中文\t参数"'],
		["$()&|>;", "$()&|>;"],
	];
	for (const [input, expected] of cases) assert.equal(quoteWindowsJobArgument(input), expected, input);
	assert.throws(() => quoteWindowsJobArgument("bad\0arg"), /NUL/);
});

test("Windows program lookup prefers .com, uses PATH case-insensitively, and keeps quoted semicolons", () => {
	const files = new Set(["c:\\tools;v2\\node.com", "c:\\tools;v2\\node.exe"]);
	const isFile = (path: string) => files.has(path.toLowerCase());
	assert.equal(resolveWindowsJobProgram("node", cwd, { Path: '"C:\\tools;v2";C:\\other' }, isFile), "C:\\tools;v2\\node.com");
	assert.equal(resolveWindowsJobProgram("C:\\tools;v2\\node.exe", cwd, {}, isFile), "C:\\tools;v2\\node.exe");
	assert.throws(() => resolveWindowsJobProgram("npm.cmd", cwd, { Path: "C:\\tools" }, () => true), /\.cmd/);
	assert.throws(() => resolveWindowsJobProgram("node", cwd, {}, () => false), { code: "ENOENT" });
});

test("Windows program lookup obeys the no-current-directory rule and does not search PATHEXT scripts", () => {
	const files = new Set(["c:\\workspace\\node.exe", "c:\\tools\\node.exe", "c:\\tools\\npm.cmd"]);
	const isFile = (path: string) => files.has(path.toLowerCase());
	assert.equal(resolveWindowsJobProgram("node", cwd, { PATH: "C:\\tools" }, isFile), "C:\\workspace\\node.exe");
	assert.equal(resolveWindowsJobProgram("node", cwd, { PATH: "C:\\tools", NoDefaultCurrentDirectoryInExePath: "1" }, isFile), "C:\\tools\\node.exe");
	assert.throws(() => resolveWindowsJobProgram("npm", cwd, { PATH: "C:\\tools", PATHEXT: ".CMD" }, isFile), { code: "ENOENT" });
});

test("Windows command data uses private stdin JSON, not PowerShell syntax or argv", async () => {
	const run = fixture();
	const { socket, request } = await run.connect();
	const invocation = run.invocation();
	assert.equal(invocation.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(invocation.args[3], "-EncodedCommand");
	assert.equal(Buffer.from(invocation.args[4]!, "base64").toString("utf16le"), WINDOWS_JOB_BOOTSTRAP);
	assert.ok(invocation.args[4]!.length < 30000, "helper bootstrap fits CreateProcess's command-line limit");
	assert.equal(invocation.args.some(arg => arg.includes("参数") || arg.includes("$()")), false);
	assert.equal(request.program, "C:\\tools\\node.exe");
	assert.equal(request.commandLine, 'node 参数 "two words" "$() & | > ;" ""');
	assert.equal(request.cwd, cwd);
	assert.equal(request.source, WINDOWS_JOB_SOURCE);
	assert.equal(invocation.address, `\\\\.\\pipe\\${request.pipe}`);
	assert.deepEqual(socket.writes, [`${request.token}\tRUN\n`]);
	// Fake output is deliberately untouched, including Chinese and nonzero exit 253.
	let output = "";
	run.child.stdout.on("data", chunk => { output += chunk.toString(); });
	run.stdout.write("中文 stdout\n");
	socket.message(`${request.token}\tDONE\t253\t1`);
	run.close(253);
	assert.deepEqual(await run.child.windowsJob.finish(), { confirmed: true });
	assert.equal(run.child.exitCode, 253);
	assert.equal(output, "中文 stdout\n");
	assert.equal(run.killed(), 0);
});

test("Windows close can arrive before final control status without a false cleanup failure", async () => {
	const run = fixture();
	const { socket, request } = await run.connect();
	run.close(0);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(socket.destroyed, false);
	socket.message(`${request.token}\tDONE\t0\t1`);
	assert.deepEqual(await run.child.windowsJob.finish(), { confirmed: true });
});

test("Windows cancellation before the control handshake sends STOP instead of RUN and is idempotent", async () => {
	const run = fixture();
	const first = run.child.windowsJob.stop();
	assert.equal(first, run.child.windowsJob.stop());
	const { socket, request } = await run.connect();
	assert.deepEqual(socket.writes, [`${request.token}\tSTOP\n`]);
	socket.message(`${request.token}\tDONE\t1223\t1`);
	run.close(1223);
	assert.deepEqual(await first, { confirmed: true });
	assert.equal(run.killed(), 0);
});

test("Windows cancellation sends a private stop and waits for confirmed whole-job termination", async () => {
	const run = fixture();
	const { socket, request } = await run.connect();
	socket.message(`${request.token}\tREADY`);
	const stopped = run.child.windowsJob.stop();
	assert.equal(socket.writes.at(-1), `${request.token}\tSTOP\n`);
	let resolved = false; void stopped.then(() => { resolved = true; });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(resolved, false);
	socket.message(`${request.token}\tDONE\t1223\t1`);
	run.close(1223);
	assert.deepEqual(await stopped, { confirmed: true });
});

test("Windows job setup failure is separate from a command's ordinary nonzero exit", async () => {
	const run = fixture();
	const { socket, request } = await run.connect();
	socket.message(`${request.token}\tFAIL\t2\t87`);
	run.close(253);
	const result = await run.child.windowsJob.finish();
	assert.equal(result.confirmed, false);
	assert.match(result.error!, /创建命令进程失败（系统错误 87）/);
});

test("Windows output cannot spoof the control result, and unauthenticated pipe clients are rejected", async () => {
	const run = fixture();
	const { socket, request } = await run.connect();
	run.stdout.write(`${request.token}\tDONE\t0\t1\n`);
	socket.message("wrong-token\tDONE\t0\t1");
	assert.equal(socket.destroyed, true);
	run.close(0);
	const result = await run.child.windowsJob.finish();
	assert.equal(result.confirmed, false);
	assert.ok(run.killed() > 0);
});

test("Windows helper timeout forcibly closes the helper and returns even if pipe close never arrives", async () => {
	const run = fixture({ startupMs: 10, exitMs: 10 });
	await run.data();
	const result = await run.child.windowsJob.finish();
	assert.equal(result.confirmed, false);
	assert.match(result.error!, /启动超时/);
	assert.match(result.error!, /未建立控制连接/);
	assert.equal(run.killed(), 1);
	assert.equal(run.child.stdout.destroyed, true);
	assert.equal(run.child.stderr.destroyed, true);
});

test("Windows startup diagnostics distinguish a connected control channel from missing READY", async () => {
	const run = fixture({ startupMs: 10, exitMs: 10 });
	await run.connect();
	const result = await run.child.windowsJob.finish();
	assert.equal(result.confirmed, false);
	assert.match(result.error!, /控制连接已建立，但未收到命令就绪/);
	assert.equal(run.killed(), 1);
});

test("Windows control status timeout has its own bounded drain timer after child exit", async () => {
	const run = fixture({ exitMs: 10 });
	const { socket, request } = await run.connect();
	socket.message(`${request.token}\tREADY`);
	run.child.emit("exit", 0, null);
	const result = await run.child.windowsJob.finish();
	assert.equal(result.confirmed, false);
	assert.match(result.error!, /未及时收到/);
	assert.equal(run.killed(), 1);
	assert.equal(run.child.stdout.destroyed, true);
});

test("Windows cancellation deadline also ends an unresponsive helper with no close event", async () => {
	const run = fixture({ stopMs: 10, exitMs: 10 });
	const { socket, request } = await run.connect();
	socket.message(`${request.token}\tREADY`);
	const result = await run.child.windowsJob.stop();
	assert.equal(result.confirmed, false);
	assert.match(result.error!, /取消命令超时/);
	assert.equal(run.killed(), 1);
	assert.equal(socket.destroyed, true);
});

test("Windows helper rejects missing, relative or UNC system directories before any spawn", () => {
	for (const SystemRoot of [undefined, "", "relative", "C:Windows", "\\\\server\\Windows"]) {
		const inheritedEnvironment = SystemRoot === undefined ? {} : { SystemRoot };
		assert.throws(() => fixture({ inheritedEnvironment }), /系统目录无效/);
	}
});

test("Windows helper rejects loss of the original command exit code", async () => {
	const run = fixture();
	const { socket, request } = await run.connect();
	socket.message(`${request.token}\tDONE\t17\t1`);
	run.close(253);
	const result = await run.child.windowsJob.finish();
	assert.equal(result.confirmed, false);
	assert.match(result.error!, /没有保留命令的退出码/);
});

test("Windows native helper contract prevents unowned startup, shell interpretation and inherited Job handles", () => {
	assert.match(WINDOWS_JOB_SOURCE, /NamedPipeClientStream\("\.", pipeName, PipeDirection\.InOut, PipeOptions\.Asynchronous\)/);
	assert.ok(WINDOWS_JOB_BOOTSTRAP.indexOf("$ProgressPreference='SilentlyContinue'") < WINDOWS_JOB_BOOTSTRAP.indexOf("ConvertFrom-Json"), "module-loading progress must never contaminate raw command stderr");
	assert.ok(WINDOWS_JOB_BOOTSTRAP.indexOf("AssignProcessToJobObject($bootstrapJob") < WINDOWS_JOB_BOOTSTRAP.indexOf("Add-Type -TypeDefinition"));
	assert.match(WINDOWS_JOB_BOOTSTRAP, /DefinePInvokeMethod/);
	assert.match(WINDOWS_JOB_BOOTSTRAP, /WriteInt32\(\$limits, 16, 0x2000\)/);
	assert.match(WINDOWS_JOB_SOURCE, /CreateJobObjectW\(IntPtr\.Zero, null\)/);
	assert.match(WINDOWS_JOB_SOURCE, /UpdateProcThreadAttribute\(attributes, 0, JOB_LIST/);
	assert.match(WINDOWS_JOB_SOURCE, /CREATE_SUSPENDED \| CREATE_UNICODE_ENVIRONMENT \| EXTENDED_STARTUPINFO_PRESENT/);
	assert.ok(WINDOWS_JOB_SOURCE.indexOf("Check(CreateProcessW(program") < WINDOWS_JOB_SOURCE.indexOf("ResumeThread(process.hThread)"));
	assert.match(WINDOWS_JOB_SOURCE, /HandleArray\(new IntPtr\[\] \{ input, output, error \}\)/);
	assert.match(WINDOWS_JOB_SOURCE, /CreateFileW\("NUL"/);
	assert.match(WINDOWS_JOB_SOURCE, /DuplicateStandard\(-11\)/);
	assert.match(WINDOWS_JOB_SOURCE, /DuplicateStandard\(-12\)/);
	assert.match(WINDOWS_JOB_SOURCE, /if \(info.ActiveProcesses == 0\) return;/);
	assert.match(WINDOWS_JOB_SOURCE, /ClearJob\(job\);\s+cleaned = true;/);
	assert.equal(WINDOWS_JOB_SOURCE.includes("BREAKAWAY_OK"), false);
	assert.equal(/cmd\.exe|powershell\.exe|ProcessStartInfo/.test(WINDOWS_JOB_SOURCE), false);
});

for (const code of [0, 7]) test(`native Windows helper finishes without STOP and preserves only target bytes (exit ${code})`, { skip: process.platform !== "win32", timeout: 20_000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "windows-job-native-"));
	const expectedOut = Buffer.from([0, 0x81, 0x40, 13, 10, 0xe4, 0xb8, 0xad]);
	const expectedError = Buffer.from("target stderr\r\n");
	const script = `setTimeout(()=>{process.stdout.write(Buffer.from(${JSON.stringify([...expectedOut])}));process.stderr.write(Buffer.from(${JSON.stringify([...expectedError])}));process.exitCode=${code};},100);`;
	const child = spawnWindowsJob(process.execPath, ["-e", script], { cwd: root, env: {} }, { startupMs: 10_000 });
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	});
	const stdout: Buffer[] = [], stderr: Buffer[] = [];
	child.stdout.on("data", chunk => stdout.push(chunk));
	child.stderr.on("data", chunk => stderr.push(chunk));
	const cleanup = await child.windowsJob.finish();
	assert.equal(cleanup.confirmed, true, `${JSON.stringify(cleanup)}; stderr=${Buffer.concat(stderr).toString()}`);
	assert.equal(child.exitCode, code, "READY and DONE must not wait for a cancellation request");
	assert.deepEqual(Buffer.concat(stdout), expectedOut, "helper initialization must not add stdout bytes");
	assert.deepEqual(Buffer.concat(stderr), expectedError, "PowerShell progress must not enter command stderr");
});
