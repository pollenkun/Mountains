/**
 * 脱敏：录制、账本、日志落盘前统一经过这里。
 * - 删除敏感字段（鉴权头、Key、令牌、密码等）
 * - 抹掉已知密钥值（来自环境变量）与常见密钥形态
 */
const SENSITIVE_KEY = /^(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret|cookie|set-cookie)$/i;
const SENSITIVE_ENV = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const PATTERNS: RegExp[] = [/sk-[A-Za-z0-9]{16,}/g, /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, /ghp_[A-Za-z0-9]{20,}/g, /AKIA[0-9A-Z]{16}/g];

export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
	return Object.entries(env)
		.filter(([k, v]) => SENSITIVE_ENV.test(k) && typeof v === "string" && v.length >= 8 && v !== "proxy-injected")
		.map(([, v]) => v as string);
}

export function redactText(text: string, secrets: readonly string[] = knownSecrets()): string {
	let out = text;
	for (const s of secrets) if (s) out = out.split(s).join("[REDACTED]");
	for (const p of PATTERNS) out = out.replace(p, "[REDACTED]");
	return out;
}

export function redactValue(value: unknown, secrets: readonly string[] = knownSecrets()): unknown {
	if (typeof value === "string") return redactText(value, secrets);
	if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redactValue(v, secrets);
		return out;
	}
	return value;
}
