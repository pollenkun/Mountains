import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { win32 } from "node:path";

export interface WindowsJobCleanup { confirmed: boolean; error?: string; trackedDescendants?: number }
export type WindowsCleanupResult = WindowsJobCleanup;
export interface WindowsJobProcess extends ChildProcessWithoutNullStreams {
	windowsJob: { stop(): Promise<WindowsJobCleanup>; finish(): Promise<WindowsJobCleanup> };
}

/** Trusted host seam, never supplied by a model's command arguments. */
export interface WindowsJobHost {
	platform?: NodeJS.Platform;
	spawn?: typeof spawn;
	createServer?: typeof createServer;
	randomBytes?: typeof randomBytes;
	isFile?: (path: string) => boolean;
	inheritedEnvironment?: NodeJS.ProcessEnv;
	startupMs?: number;
	stopMs?: number;
	exitMs?: number;
}

function envValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(environment).sort().find(key => key.toUpperCase() === name.toUpperCase());
	return key === undefined ? undefined : environment[key];
}

function windowsPathEntries(path: string): string[] {
	const entries: string[] = [];
	let start = 0;
	while (start < path.length) {
		let end = start;
		if (path[start] === '"' || path[start] === "'") {
			const quoteEnd = path.indexOf(path[start]!, start + 1);
			end = quoteEnd < 0 ? path.length : quoteEnd;
		}
		end = path.indexOf(";", end);
		if (end < 0) end = path.length;
		if (end > start) entries.push(path.slice(start, end).replace(/^["']/, "").replace(/["']$/, ""));
		start = end + 1;
	}
	return entries;
}

/** The quoting rules used by libuv's quote_cmd_arg, not cmd.exe or PowerShell syntax. */
export function quoteWindowsJobArgument(value: string): string {
	if (value.includes("\0")) throw new TypeError("命令参数不能含 NUL");
	if (value === "") return '""';
	if (!/[ \t"]/.test(value)) return value;
	return `"${value.replace(/(\\*)"/g, (_match, slash: string) => `${slash}${slash}\\"`).replace(/(\\+)$/, "$1$1")}"`;
}

/** Node/libuv searches .com then .exe; PATHEXT and shell-script execution are not enabled. */
export function resolveWindowsJobProgram(program: string, cwd: string, environment: NodeJS.ProcessEnv, isFile: (path: string) => boolean): string {
	if (!program || program === "." || program.includes("\0")) throw new TypeError("命令程序无效");
	if (!win32.isAbsolute(cwd) || cwd.includes("\0")) throw new TypeError("Windows 工作目录必须是绝对路径");
	if (/\.(cmd|bat)$/i.test(program)) throw new TypeError("直接程序调用不能运行 .cmd 或 .bat；请明确调用解释器");
	const filename = program.slice(Math.max(program.lastIndexOf("\\"), program.lastIndexOf("/"), program.lastIndexOf(":")) + 1);
	const dot = filename.indexOf(".");
	const suffixes = dot >= 0 && dot < filename.length - 1 ? ["", ".com", ".exe"] : [".com", ".exe"];
	const paths = /[\\/:]/.test(program) ? [win32.resolve(cwd, program)] : [
		...(envValue(environment, "NoDefaultCurrentDirectoryInExePath") === undefined ? [win32.join(cwd, program)] : []),
		...windowsPathEntries(envValue(environment, "PATH") ?? "").map(directory => win32.resolve(cwd, directory, program)),
	];
	for (const path of paths) for (const suffix of suffixes) {
		const candidate = path + (path.endsWith(".") ? suffix.replace(/^\./, "") : suffix);
		if (isFile(candidate)) return candidate;
	}
	const error = new Error("Windows 找不到要运行的程序");
	Object.assign(error, { code: "ENOENT" });
	throw error;
}

// Windows 10+ / Windows 11: JOB_LIST attaches the process atomically at creation.
// CREATE_SUSPENDED alone followed by AssignProcessToJobObject leaves a cancellation
// window containing an unowned suspended process. No fallback launches outside a Job.
// HANDLE_LIST deliberately excludes the Job and private control channel handles.
// Sources: Microsoft UpdateProcThreadAttribute / Job Objects / redirected I/O docs;
// libuv src/win/process.c (CRT quoting, .com/.exe search, inherited std handles).
export const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MountainsWindowsJob {
    const uint KILL_ON_JOB_CLOSE = 0x2000;
    const uint CREATE_SUSPENDED = 4;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const uint CREATE_NO_WINDOW = 0x8000000;
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint DUPLICATE_SAME_ACCESS = 2;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const uint WAIT_FAILED = 0xffffffff;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);
    static readonly IntPtr HANDLE_LIST = new IntPtr(0x20002);
    static readonly IntPtr JOB_LIST = new IntPtr(0x2000d);

    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
        public BASIC_LIMITS BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public uint cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
        public uint nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMITS info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNTING info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool DuplicateHandle(IntPtr fromProcess, IntPtr fromHandle, IntPtr toProcess, out IntPtr toHandle, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static IntPtr DuplicateStandard(int number) {
        IntPtr original = GetStdHandle(number), copy;
        if (original == IntPtr.Zero || original == INVALID_HANDLE) throw new Win32Exception(6);
        Check(DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), out copy, 0, true, DUPLICATE_SAME_ACCESS));
        return copy;
    }
    static IntPtr HandleArray(IntPtr[] handles) {
        IntPtr memory = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
        for (int index = 0; index < handles.Length; index++) Marshal.WriteIntPtr(memory, index * IntPtr.Size, handles[index]);
        return memory;
    }
    static void ClearJob(IntPtr job) {
        Check(TerminateJobObject(job, 1223));
        Stopwatch deadline = Stopwatch.StartNew();
        while (true) {
            ACCOUNTING info;
            Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
            if (info.ActiveProcesses == 0) return;
            if (deadline.ElapsedMilliseconds >= 5000) throw new Win32Exception(1460);
            Thread.Sleep(10);
        }
    }

    public static int Run(string program, string commandLine, string directory, string[] environment, string pipeName, string token) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero, env = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool initialized = false, created = false, cleaned = false;
        int phase = 1, nativeError = 0;
        uint code = 253;
        NamedPipeClientStream channel = null;
        StreamWriter writer = null;
        ManualResetEvent stop = new ManualResetEvent(false);
        try {
            channel = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None);
            channel.Connect(10000);
            writer = new StreamWriter(channel, new UTF8Encoding(false), 1024, true);
            writer.AutoFlush = true;
            writer.WriteLine(token + "\tHELLO");
            StreamReader reader = new StreamReader(channel, new UTF8Encoding(false), false, 1024, true);
            string permission = reader.ReadLine();
            if (permission != token + "\tRUN") stop.Set();
            Thread control = new Thread(delegate() {
                try {
                    while (true) {
                        string line = reader.ReadLine();
                        if (line == null || line == token + "\tSTOP") { stop.Set(); return; }
                    }
                } catch { stop.Set(); }
                  finally { reader.Dispose(); }
            });
            control.IsBackground = true;
            if (!stop.WaitOne(0)) control.Start();
            else reader.Dispose();
            if (stop.WaitOne(0)) { cleaned = true; code = 1223; }
            else {
                // NULL security attributes make the only Job handle non-inheritable.
                job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                EXTENDED_LIMITS limits = new EXTENDED_LIMITS();
                limits.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE;
                Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
                SECURITY_ATTRIBUTES inputSecurity = new SECURITY_ATTRIBUTES();
                inputSecurity.nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                inputSecurity.bInheritHandle = true;
                input = CreateFileW("NUL", 0x80000000, 3, ref inputSecurity, 3, 0, IntPtr.Zero);
                if (input == INVALID_HANDLE) { input = IntPtr.Zero; throw new Win32Exception(Marshal.GetLastWin32Error()); }
                output = DuplicateStandard(-11);
                error = DuplicateStandard(-12);
                UIntPtr bytes = UIntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
                if (bytes == UIntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                attributes = Marshal.AllocHGlobal(checked((int)bytes.ToUInt64()));
                Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes));
                initialized = true;
                jobs = HandleArray(new IntPtr[] { job });
                handles = HandleArray(new IntPtr[] { input, output, error });
                Check(UpdateProcThreadAttribute(attributes, 0, JOB_LIST, jobs, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
                Check(UpdateProcThreadAttribute(attributes, 0, HANDLE_LIST, handles, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero));
                Array.Sort(environment, StringComparer.OrdinalIgnoreCase);
                env = Marshal.StringToHGlobalUni(String.Join("\0", environment) + "\0\0");
                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = input;
                startup.StartupInfo.hStdOutput = output;
                startup.StartupInfo.hStdError = error;
                startup.lpAttributeList = attributes;
                phase = 2;
                if (stop.WaitOne(0)) { cleaned = true; code = 1223; }
                else {
                    Check(CreateProcessW(program, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                        env, directory, ref startup, out process));
                    created = true;
                    phase = 3;
                    if (stop.WaitOne(0)) code = 1223;
                    else {
                        if (ResumeThread(process.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
                        writer.WriteLine(token + "\tREADY");
                        while (true) {
                            if (stop.WaitOne(0)) { code = 1223; break; }
                            uint waited = WaitForSingleObject(process.hProcess, 25);
                            if (waited == WAIT_OBJECT_0) { Check(GetExitCodeProcess(process.hProcess, out code)); break; }
                            if (waited == WAIT_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error());
                            if (waited != WAIT_TIMEOUT) throw new Win32Exception(31);
                        }
                    }
                    phase = 4;
                    ClearJob(job);
                    cleaned = true;
                }
            }
        } catch (Win32Exception exception) { nativeError = exception.NativeErrorCode; }
          catch { nativeError = 31; }
        finally {
            // A failed resume/configuration never releases an unowned runnable child.
            // On wrapper termination the kernel closes this same non-inherited Job.
            if (created && !cleaned && job != IntPtr.Zero) {
                try { ClearJob(job); cleaned = true; } catch { nativeError = nativeError == 0 ? 31 : nativeError; }
            }
            if (!created) cleaned = true;
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            if (job != IntPtr.Zero && !CloseHandle(job)) { cleaned = false; nativeError = nativeError == 0 ? 31 : nativeError; }
            try {
                if (writer != null) {
                    if (nativeError != 0) writer.WriteLine(token + "\tFAIL\t" + phase + "\t" + nativeError);
                    else writer.WriteLine(token + "\tDONE\t" + code + "\t" + (cleaned ? "1" : "0"));
                }
            } catch { nativeError = nativeError == 0 ? 31 : nativeError; }
            if (writer != null) writer.Dispose();
            if (channel != null) channel.Dispose();
            // The background reader can still unwind when channel closes. Do not
            // dispose its stop event until process exit; no outstanding foreground thread.
        }
        return nativeError == 0 && cleaned ? unchecked((int)code) : 253;
    }
}
`;

// Keep EncodedCommand small. The static C# source and all command data travel only
// through stdin: neither secrets nor long user arguments enter PowerShell syntax.
export const WINDOWS_JOB_BOOTSTRAP = String.raw`
$ErrorActionPreference='Stop'
try {
    # Reflection.Emit runs inside PowerShell; it does not launch a C# compiler.
    # First put this wrapper in a Job, so even Add-Type's compiler descendants
    # are killed if Node cancels us before the C# control channel is ready.
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('MountainsJobBootstrap'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module = $assembly.DefineDynamicModule('Native')
    $builder = $module.DefineType('MountainsJobBootstrapNative', [Reflection.TypeAttributes]'Public,Abstract,Sealed')
    function Add-KernelMethod([string]$name, [Type]$returnType, [Type[]]$parameters) {
        $method = $builder.DefinePInvokeMethod($name, 'kernel32.dll', $name, [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, $returnType, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
        $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
    }
    Add-KernelMethod 'CreateJobObjectW' ([IntPtr]) @([IntPtr],[string])
    Add-KernelMethod 'SetInformationJobObject' ([int]) @([IntPtr],[int],[IntPtr],[uint32])
    Add-KernelMethod 'AssignProcessToJobObject' ([int]) @([IntPtr],[IntPtr])
    Add-KernelMethod 'GetCurrentProcess' ([IntPtr]) @()
    $kernel = $builder.CreateType()
    $bootstrapJob = $kernel::CreateJobObjectW([IntPtr]::Zero, $null)
    if ($bootstrapJob -eq [IntPtr]::Zero) { throw 'Cannot create wrapper Job' }
    $limitSize = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
    $limits = [Runtime.InteropServices.Marshal]::AllocHGlobal($limitSize)
    try {
        [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($limitSize), 0, $limits, $limitSize)
        [Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x2000)
        if ($kernel::SetInformationJobObject($bootstrapJob, 9, $limits, [uint32]$limitSize) -eq 0) { throw 'Cannot configure wrapper Job' }
        if ($kernel::AssignProcessToJobObject($bootstrapJob, $kernel::GetCurrentProcess()) -eq 0) { throw 'Cannot assign wrapper Job' }
    } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($limits)
    }
    # Do not CloseHandle this Job early: it includes this wrapper. Kernel process
    # exit closes the non-inherited handle without changing the requested exit code.
    # Decode only the private input pipe. Console.InputEncoding's setter calls
    # SetConsoleCP on .NET Framework and can fail without an attached console.
    $inputReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false, $true), $true, 4096, $true)
    try {
        $p = $inputReader.ReadToEnd() | ConvertFrom-Json
    } finally {
        $inputReader.Dispose()
    }
    Add-Type -TypeDefinition $p.source -Language CSharp -ErrorAction Stop
    $code = [MountainsWindowsJob]::Run([string]$p.program,[string]$p.commandLine,[string]$p.cwd,[string[]]$p.environment,[string]$p.pipe,[string]$p.token)
    exit $code
} catch {
    [Console]::Error.WriteLine('Windows job helper failed to initialize; command was not started.')
    exit 253
}
`;

function fileExists(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }

/** Windows-only command process, with bounded cleanup separate from raw command output. */
export function spawnWindowsJob(program: string, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, host: WindowsJobHost = {}): WindowsJobProcess {
	if ((host.platform ?? process.platform) !== "win32") throw new Error("Windows Job 启动器只能在 Windows 使用");
	const effectiveEnvironment: NodeJS.ProcessEnv = {};
	// Node keeps the first key in lexical order when Windows environment names
	// differ only in case. libuv also restores these specific OS/Cygwin variables.
	const names = new Set<string>();
	for (const name of Object.keys(options.env).sort()) {
		const value = options.env[name];
		if (value === undefined || names.has(name.toUpperCase())) continue;
		if (!name || name.includes("=") || name.includes("\0") || value.includes("\0")) throw new TypeError("Windows 命令环境变量无效");
		names.add(name.toUpperCase()); effectiveEnvironment[name] = value;
	}
	for (const name of ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]) {
		if (names.has(name)) continue;
		// Read only named OS metadata, never enumerate the real parent environment.
		const value = host.inheritedEnvironment ? envValue(host.inheritedEnvironment, name) : process.env[name];
		if (value !== undefined) { effectiveEnvironment[name] = value; names.add(name); }
	}
	const executable = resolveWindowsJobProgram(program, options.cwd, effectiveEnvironment, host.isFile ?? fileExists);
	const commandLine = [program, ...argv].map(quoteWindowsJobArgument).join(" ");
	if (commandLine.length >= 32767) throw new TypeError("Windows 命令行过长");
	const environment: string[] = [];
	for (const [name, value] of Object.entries(effectiveEnvironment)) environment.push(`${name}=${value}`);
	// The helper path comes from trusted host OS metadata, never the target's env.
	const systemRoot = host.inheritedEnvironment ? envValue(host.inheritedEnvironment, "SystemRoot") : process.env.SystemRoot;
	if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot) || systemRoot.includes("\0") || /["']/.test(systemRoot)) {
		throw new Error("Windows 系统目录无效，无法安全启动进程管理器");
	}
	const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	if (!(host.isFile ?? fileExists)(powershell)) throw new Error("找不到 Windows 系统自带的 PowerShell，命令未执行");
	const wrapperEnvironment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(effectiveEnvironment)) if (name.toUpperCase() !== "SYSTEMROOT") wrapperEnvironment[name] = value;
	wrapperEnvironment.SYSTEMROOT = systemRoot;
	const token = (host.randomBytes ?? randomBytes)(32).toString("hex");
	const pipe = `mountains-job-${(host.randomBytes ?? randomBytes)(24).toString("hex")}`;
	let child: WindowsJobProcess;
	let socket: Socket | undefined;
	let report: WindowsJobCleanup | undefined;
	let reportedExitCode: number | undefined;
	let stopRequested = false, closed = false, settled = false, ready = false, forced = false;
	let startup: NodeJS.Timeout | undefined, stopTimer: NodeJS.Timeout | undefined;
	let statusTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
	let resolveResult!: (result: WindowsJobCleanup) => void;
	const result = new Promise<WindowsJobCleanup>(resolve => { resolveResult = resolve; });
	const sockets = new Set<Socket>();
	const finish = () => {
		// ChildProcess 'close' and the independent control pipe can be delivered in
		// either order. Keep the pipe until its final status arrives or its deadline.
		if (settled || !closed || !report) return;
		if (report.confirmed && reportedExitCode !== undefined && child.exitCode !== null && (child.exitCode >>> 0) !== reportedExitCode) {
			report = { confirmed: false, error: "Windows 进程管理器没有保留命令的退出码，结果不能当作正常完成" };
		}
		settled = true;
		clearTimeout(startup); clearTimeout(stopTimer); clearTimeout(statusTimer); clearTimeout(drainTimer);
		for (const current of sockets) current.destroy();
		try { server.close(); } catch { /* Listening may have failed. */ }
		resolveResult(report ?? { confirmed: false, error: "Windows 未收到进程树清理结果，命令没有正常完成" });
	};
	const forceStop = (message: string) => {
		if (settled || forced) return;
		forced = true;
		report = { confirmed: false, error: message };
		clearTimeout(startup); clearTimeout(stopTimer); clearTimeout(statusTimer);
		// This deadline is independent of the status deadline which called us.
		drainTimer = setTimeout(() => {
			if (child) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
			closed = true; finish();
		}, host.exitMs ?? 2000);
		try { child.kill("SIGKILL"); } catch { /* Result still reports cleanup failure. */ }
		finish();
	};
	const expectExit = () => {
		if (!statusTimer && !settled && !forced) statusTimer = setTimeout(() => {
			statusTimer = undefined;
			forceStop("Windows 未及时收到命令结束和进程树清理结果，已停止命令");
		}, host.exitMs ?? 2000);
	};
	const sendStop = () => { if (socket && !socket.destroyed) socket.write(`${token}\tSTOP\n`); };
	const server: Server = (host.createServer ?? createServer)(current => {
		sockets.add(current);
		current.setEncoding("utf8");
		let buffer = "", authenticated = false;
		current.on("data", chunk => {
			buffer += chunk;
			if (buffer.length > 4096) { current.destroy(); if (authenticated) forceStop("Windows 进程控制消息过长，已停止命令"); return; }
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
				const [secret, event, first, second] = line.split("\t");
				if (secret !== token) { current.destroy(); return; }
				if (!authenticated) {
					if (event !== "HELLO" || socket) { current.destroy(); return; }
					authenticated = true; socket = current;
					current.write(`${token}\t${stopRequested ? "STOP" : "RUN"}\n`);
					continue;
				}
				if (event === "READY") { ready = true; clearTimeout(startup); }
				else if (event === "DONE" && /^\d+$/.test(first ?? "") && Number(first) <= 0xffffffff && (second === "0" || second === "1") && !forced) {
					reportedExitCode = Number(first);
					report = second === "1" ? { confirmed: true } : { confirmed: false, error: "Windows 未确认全部后台进程已结束" };
					clearTimeout(startup); clearTimeout(stopTimer);
					expectExit(); finish();
				} else if (event === "FAIL" && /^\d+$/.test(first ?? "") && /^\d+$/.test(second ?? "") && !forced) {
					const phase = ({ "1": "配置进程保护", "2": "创建命令进程", "3": "启动命令", "4": "结束后台进程" } as Record<string, string>)[first!] ?? "管理命令进程";
					report = { confirmed: false, error: `Windows ${phase}失败（系统错误 ${second}），命令已停止` };
					clearTimeout(startup); clearTimeout(stopTimer);
					expectExit(); finish();
				} else if (!forced) { forceStop("Windows 进程控制消息无效，已停止命令"); }
			}
		});
		current.on("error", () => { if (authenticated && !report && !closed) forceStop("Windows 进程控制连接出错，已停止命令"); });
		current.on("close", () => {
			sockets.delete(current);
			if (authenticated && !report) {
				if (!closed) forceStop("Windows 进程控制连接中断，已停止命令");
				else { report = { confirmed: false, error: "Windows 进程控制连接提前结束，未收到清理结果" }; finish(); }
			}
		});
	});
	server.on("error", () => forceStop("Windows 无法建立私有进程控制连接，命令未正常开始"));
	server.listen(`\\\\.\\pipe\\${pipe}`, () => {
		if (!child || closed) return;
		child.stdin.end(JSON.stringify({ source: WINDOWS_JOB_SOURCE, program: executable, commandLine, cwd: options.cwd, environment, pipe, token }), "utf8");
	});
	try {
		child = (host.spawn ?? spawn)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_JOB_BOOTSTRAP, "utf16le").toString("base64")], {
			cwd: options.cwd, env: wrapperEnvironment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
		}) as WindowsJobProcess;
	} catch (error) {
		closed = true;
		server.removeAllListeners("error"); server.on("error", () => { /* No child was spawned. */ });
		try { server.close(); } catch { /* Failed before listen. */ }
		throw error;
	}
	child.windowsJob = {
		finish: () => result,
		stop: () => {
			if (!stopRequested && !closed) {
				stopRequested = true; sendStop();
				stopTimer = setTimeout(() => forceStop("Windows 取消命令超时，已强制关闭进程管理器；后台进程结束情况未确认"), host.stopMs ?? 8000);
			}
			return result;
		},
	};
	child.stdin.on("error", () => { if (!closed && !report) forceStop("Windows 无法传入命令数据，命令未正常开始"); });
	child.once("error", () => { report = { confirmed: false, error: "Windows 进程管理器无法启动，命令未执行" }; });
	child.once("exit", expectExit);
	child.once("close", () => {
		closed = true;
		expectExit(); finish();
	});
	startup = setTimeout(() => { if (!ready && !closed && !report) forceStop("Windows 进程管理器启动超时，已停止命令"); }, host.startupMs ?? 30000);
	return child;
}
