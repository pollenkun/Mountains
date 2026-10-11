import { statSync } from "node:fs";
import { win32 } from "node:path";

/** Trusted filesystem seam. Executable selection never comes from model arguments. */
export interface WindowsCommandHost { isFile(path: string): boolean }

function envValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
	return Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

/** Select Git for Windows rather than a PATH bash which may be WSL or a different shell. */
export function findWindowsGitBash(environment: NodeJS.ProcessEnv, host: WindowsCommandHost): string | undefined {
	const roots: string[] = [];
	for (const name of ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]) {
		const base = envValue(environment, name);
		if (base && win32.isAbsolute(base)) roots.push(win32.join(base, "Git"));
	}
	const local = envValue(environment, "LOCALAPPDATA");
	if (local && win32.isAbsolute(local)) roots.push(win32.join(local, "Programs", "Git"));
	for (const entry of (envValue(environment, "PATH") ?? "").split(";")) {
		const path = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!win32.isAbsolute(path) || !host.isFile(win32.join(path, "git.exe"))) continue;
		// Support cmd/bin and Git's nested mingw64/bin in custom installations.
		let root = path;
		for (let depth = 0; depth < 3; depth++) { roots.push(root); root = win32.dirname(root); }
	}
	for (const root of new Set(roots)) {
		if (!host.isFile(win32.join(root, "cmd", "git.exe")) && !host.isFile(win32.join(root, "bin", "git.exe"))) continue;
		// bin/bash.exe is Git's wrapper and sets its runtime environment.
		const bash = win32.join(root, "bin", "bash.exe");
		if (host.isFile(bash)) return bash;
	}
	return undefined;
}

export function nativeWindowsCommandHost(): WindowsCommandHost {
	return { isFile(path) { try { return statSync(path).isFile(); } catch { return false; } } };
}
