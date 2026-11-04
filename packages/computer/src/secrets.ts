import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Saved credentials the model refers to by name, never by value (the approach of browser-use's sensitive_data).
 * The model writes <secret>name</secret>; the tool puts the value in only on that secret's own sites or apps, and
 * every result shown to the model has the value replaced by the placeholder again.
 * Values live in the macOS Keychain; ~/.mountains/secrets.json holds only names and where each may be used.
 */
export interface SecretScope { name: string; domains: string[]; apps: string[] }
export interface SecretStore {
	list(): Promise<SecretScope[]>;
	value(name: string): Promise<string>;
}
/** Where the text is about to go: a page's address, or a native app. */
export interface SecretTarget { url?: string; app?: { name: string; bundleId?: string } }
export interface ResolvedText { text: string; used: string[]; values: Map<string, string> }
/** Secret values used in this conversation: every later result (console logs, request URLs, page text) is
 * scrubbed of them too, not only the result of the action that typed them. */
export class UsedSecrets { readonly values = new Map<string, string>(); }
/** Shorter values would match ordinary text everywhere once scrubbed. */
export const MIN_SECRET_LENGTH = 4;

export const SECRET_SERVICE = "Mountains secret";
const PLACEHOLDER = /<secret>([^<>]{1,64})<\/secret>/g;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

export function secretNames(text: string): string[] { return [...new Set([...text.matchAll(PLACEHOLDER)].map(m => m[1]!.trim()))]; }

/** example.com covers example.com and its subdomains; *.example.com only the subdomains. */
export function domainMatches(host: string, domain: string): boolean {
	const h = host.toLowerCase().replace(/\.$/, ""), d = domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
	if (!h || !d) return false;
	if (d.startsWith("*.")) return h.endsWith(d.slice(1)) && h !== d.slice(2);
	return h === d || h.endsWith(`.${d}`);
}

export function scopeAllows(scope: SecretScope, target: SecretTarget): boolean {
	if (target.url) {
		let url: URL;
		try { url = new URL(target.url); } catch { return false; }
		// A credential typed into a plain-http page can be read on the way; only https (and the local machine).
		const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return false;
		return scope.domains.some(domain => domainMatches(url.hostname, domain));
	}
	if (target.app) {
		const ids = [target.app.bundleId, target.app.name].filter((v): v is string => !!v).map(v => v.toLowerCase());
		return scope.apps.some(app => ids.includes(app.toLowerCase()));
	}
	return false;
}

/** Names usable here, for telling the model what it may write. */
export async function availableSecrets(store: SecretStore | undefined, target: SecretTarget): Promise<string[]> {
	if (!store) return [];
	try { return (await store.list()).filter(scope => scopeAllows(scope, target)).map(scope => scope.name); } catch { return []; }
}
export function secretsNote(names: string[]): string {
	return names.length ? `\nSaved secrets usable here (write them exactly as shown; you never see their values): ${names.map(n => `<secret>${n}</secret>`).join(", ")}` : "";
}

/** Put the values in. Refuses before any input when a name is unknown or not allowed for this target. */
export async function resolveSecrets(text: string, store: SecretStore | undefined, target: SecretTarget, used?: UsedSecrets): Promise<ResolvedText> {
	const names = secretNames(text);
	if (!names.length) return { text, used: [], values: new Map() };
	if (!store) throw new Error("no secret store is configured; no text was sent");
	const scopes = new Map((await store.list()).map(scope => [scope.name, scope]));
	const values = new Map<string, string>();
	for (const name of names) {
		const scope = scopes.get(name);
		if (!scope) throw new Error(`no saved secret named ${JSON.stringify(name)}; no text was sent. The user adds one with: mountains secret add ${JSON.stringify(name)} --domain <site>`);
		if (!scopeAllows(scope, target)) throw new Error(`secret ${JSON.stringify(name)} is not allowed ${target.url ? `on ${new URL(target.url).host}` : `in ${target.app?.name ?? "this app"}`}; no text was sent`);
		const value = await store.value(name);
		if (value.length < MIN_SECRET_LENGTH) throw new Error(`secret ${JSON.stringify(name)} is shorter than ${MIN_SECRET_LENGTH} characters and cannot be kept out of results; no text was sent`);
		values.set(name, value);
	}
	for (const [name, value] of values) used?.values.set(name, value);
	return { text: text.replace(PLACEHOLDER, (_, name: string) => values.get(name.trim())!), used: names, values };
}

/** Every string inside `value` with each secret value replaced by its placeholder. */
export function redactSecrets<T>(value: T, values: Map<string, string>): T {
	if (!values.size) return value;
	const pairs = [...values].filter(([, secret]) => secret.length > 0).sort((a, b) => b[1].length - a[1].length);
	const scrub = (text: string) => pairs.reduce((out, [name, secret]) => out.split(secret).join(`<secret>${name}</secret>`), text);
	const walk = (item: unknown): unknown => typeof item === "string" ? scrub(item)
		: Array.isArray(item) ? item.map(walk)
		: item && typeof item === "object" && !(item instanceof Buffer) && !(item instanceof Uint8Array) ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, walk(v)])) : item;
	return walk(value) as T;
}

/** The Keychain-backed store. Only /usr/bin/security touches the values. */
export class KeychainSecrets implements SecretStore {
	readonly file: string;
	constructor(home = process.env.MOUNTAINS_HOME ?? join(homedir(), ".mountains")) { this.file = join(home, "secrets.json"); }
	async list(): Promise<SecretScope[]> {
		let raw: unknown;
		try { raw = JSON.parse(readFileSync(this.file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}`); }
		const list = Array.isArray((raw as { secrets?: unknown })?.secrets) ? (raw as { secrets: unknown[] }).secrets : [];
		return list.flatMap(item => {
			const s = item as Partial<SecretScope>;
			if (typeof s.name !== "string" || !NAME.test(s.name)) return [];
			return [{ name: s.name, domains: (s.domains ?? []).filter((d): d is string => typeof d === "string"), apps: (s.apps ?? []).filter((a): a is string => typeof a === "string") }];
		});
	}
	async value(name: string): Promise<string> {
		if (process.platform !== "darwin") throw new Error("saved secrets use the macOS Keychain");
		try {
			const { stdout } = await promisify(execFile)("/usr/bin/security", ["find-generic-password", "-s", SECRET_SERVICE, "-a", name, "-w"], { timeout: 15_000 });
			return stdout.replace(/\n$/, "");
		} catch { throw new Error(`the Keychain has no value for secret ${JSON.stringify(name)}; no text was sent`); }
	}
	/** Write the scope list (names and places only; values never go in this file). */
	save(scopes: SecretScope[]): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ secrets: scopes }, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.file);
	}
	static validName(name: string): boolean { return NAME.test(name); }
}
