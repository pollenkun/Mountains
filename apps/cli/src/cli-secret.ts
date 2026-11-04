import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { KeychainSecrets, SECRET_SERVICE, type SecretScope } from "@mountains/computer";
import { mountainsHome } from "./paths.ts";

export const SECRET_USAGE = "  mountains secret add <名字> --domain <网站> [--domain <网站>] [--app <应用或 bundle id>]\n  mountains secret list\n  mountains secret remove <名字>\n";

/**
 * Saved credentials for computer use. The value is typed into /usr/bin/security's own hidden prompt and kept in
 * the macOS Keychain; Mountains stores only the name and where it may be used, and the model only sees the name.
 */
export async function cmdSecret(argv: string[]): Promise<void> {
	const [action, ...rest] = argv;
	const store = new KeychainSecrets(mountainsHome());
	const scopes = await store.list();
	if (action === "list" && rest.length === 0) {
		if (!scopes.length) { process.stdout.write("还没有保存的密码。\n"); return; }
		for (const s of scopes) process.stdout.write(`${s.name}  ${[...s.domains.map(d => `网站 ${d}`), ...s.apps.map(a => `应用 ${a}`)].join("，")}\n`);
		return;
	}
	if (action === "add") {
		const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { domain: { type: "string", multiple: true }, app: { type: "string", multiple: true } } });
		const name = positionals[0];
		if (positionals.length !== 1 || !name || !KeychainSecrets.validName(name)) throw new Error("名字只能用字母、数字、空格、点、下划线和连字符，最长 64 个字符");
		const domains = values.domain ?? [], apps = values.app ?? [];
		if (!domains.length && !apps.length) throw new Error("至少给一个 --domain 或 --app，密码只会在那里使用");
		if (process.platform !== "darwin") throw new Error("保存的密码使用 macOS 钥匙串");
		process.stdout.write(`为“${name}”输入密码（不会显示，也不会经过 Mountains）：\n`);
		const added = spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-s", SECRET_SERVICE, "-a", name, "-l", `${SECRET_SERVICE}: ${name}`, "-w"], { stdio: "inherit" });
		if (added.status !== 0) throw new Error("钥匙串没有保存这个密码");
		const next: SecretScope[] = [...scopes.filter(s => s.name !== name), { name, domains, apps }];
		store.save(next);
		process.stdout.write(`已保存。模型在 ${[...domains, ...apps].join("、")} 里可以写 <secret>${name}</secret> 来填它。\n`);
		return;
	}
	if (action === "remove" && rest.length === 1) {
		const name = rest[0]!;
		spawnSync("/usr/bin/security", ["delete-generic-password", "-s", SECRET_SERVICE, "-a", name], { stdio: "ignore" });
		store.save(scopes.filter(s => s.name !== name));
		process.stdout.write(`已删除“${name}”。\n`);
		return;
	}
	throw new Error(`用法：\n${SECRET_USAGE}`);
}
