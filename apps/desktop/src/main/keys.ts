/**
 * API keys. A real app starts with none: a key is what the user typed into it, kept by the system (the macOS
 * Keychain; elsewhere a file the system encrypts, beside the settings) and put in process.env for the engine.
 * A test run (MOUNTAINS_TEST_KEYS=1) also takes the environment and the Keychain items the CLI benchmark uses.
 * Keys never reach the page; it sees only a masked form.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface KeyStore {
	read(envName: string): string | null;
	write(envName: string, key: string): void;
	remove(envName: string): void;
}
/** What the system encrypts with: Electron's safeStorage, which main hands in. */
export interface KeyCipher { available(): boolean; encrypt(text: string): Buffer; decrypt(data: Buffer): string }

const testing = () => process.env.MOUNTAINS_TEST_KEYS === "1";
const security = (args: string[], input?: string) => spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 10_000, ...(input ? { input } : {}) });

/** DEEPSEEK_API_KEY -> mountains-deepseek */
export function keychainService(envName: string, prefix = "mountains"): string | null {
	const match = /^([A-Z][A-Z0-9]*)_API_KEY$/.exec(envName);
	return match ? `${prefix}-${match[1]!.toLowerCase()}` : null;
}

/** One account per data directory, so an isolated run never meets the keys of the real one. */
function keychainStore(dataDir: string): KeyStore {
	const account = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
	const service = (envName: string) => {
		const name = keychainService(envName, "mountains-desktop");
		if (!name) throw new Error("这个名字存不了密钥");
		return name;
	};
	return {
		read(envName) {
			const found = security(["find-generic-password", "-s", service(envName), "-a", account, "-w"]);
			return found.status === 0 ? found.stdout.trim() || null : null;
		},
		// Through security's stdin, so the key never appears in a process list.
		write(envName, key) {
			const saved = security(["-i"], `add-generic-password -U -s ${service(envName)} -a ${account} -w ${key}\n`);
			if (saved.status !== 0) throw new Error(`钥匙串拒绝保存：${(saved.stderr || saved.stdout).trim().slice(0, 200)}`);
		},
		remove(envName) { security(["delete-generic-password", "-s", service(envName), "-a", account]); },
	};
}

/** The keys as one file of encrypted values, replaced whole so a crash never leaves half of it. */
export function fileStore(path: string, cipher: KeyCipher): KeyStore {
	const all = (): Record<string, string> => {
		try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>; } catch { return {}; }
	};
	const save = (keys: Record<string, string>) => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(`${path}.tmp`, `${JSON.stringify(keys, null, 1)}\n`, { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	};
	return {
		read(envName) {
			const saved = all()[envName];
			if (!saved || !cipher.available()) return null;
			try { return cipher.decrypt(Buffer.from(saved, "base64")); } catch { return null; }
		},
		write(envName, key) {
			if (!cipher.available()) throw new Error("这台电脑不能加密保存密钥");
			save({ ...all(), [envName]: cipher.encrypt(key).toString("base64") });
		},
		remove(envName) {
			const { [envName]: _gone, ...rest } = all();
			save(rest);
		},
	};
}

let store: KeyStore | null = null;
const absent = new Set<string>();

/** Keys inherited from the shell go, unless this is a test: what the app has is what it was given. */
export function openKeys(dataDir: string, cipher: KeyCipher, inherited: readonly string[]): void {
	store = process.platform === "darwin" ? keychainStore(dataDir) : fileStore(join(dataDir, "keys.json"), cipher);
	absent.clear();
	if (!testing()) for (const envName of inherited) delete process.env[envName];
}

export function mask(key: string): string {
	return key.length <= 8 ? "••••" : `${key.slice(0, 3)}••••••••${key.slice(-4)}`;
}

/** Fills process.env[envName] from the store when it is empty. Returns where the key is, if anywhere. */
export function loadKey(envName: string): "environment" | "keychain" | null {
	if (!envName) return null;
	if (process.env[envName]) return "environment";
	let key = store?.read(envName) ?? null;
	const borrowed = testing() && !key && process.platform === "darwin" ? keychainService(envName) : null;
	if (borrowed) {
		const found = security(["find-generic-password", "-s", borrowed, "-a", "api", "-w"]);
		key = found.status === 0 ? found.stdout.trim() || null : null;
	}
	if (!key) return null;
	process.env[envName] = key;
	return "keychain";
}

/** Whether a key is at hand. A missing one is remembered until a key is saved, so the store is not asked each time. */
export function hasKey(envName: string): boolean {
	if (absent.has(envName)) return false;
	const found = loadKey(envName) !== null;
	if (!found) absent.add(envName);
	return found;
}

/** Keys are printable ASCII without spaces or quotes, so one never escapes the Keychain command line. */
export function validKey(key: string): boolean {
	return /^[A-Za-z0-9._\-~+/=:]{8,300}$/.test(key);
}

export function saveKey(envName: string, key: string): void {
	if (!store) throw new Error("密钥存储还没打开");
	if (!validKey(key)) throw new Error("这不像密钥：有空格、引号，或者太短");
	store.write(envName, key);
	process.env[envName] = key;
	absent.delete(envName);
}

export function deleteKey(envName: string): void {
	store?.remove(envName);
	delete process.env[envName];
	absent.add(envName);
}
