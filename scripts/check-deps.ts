/**
 * 依赖方向检查：
 * - Pi 的模型适配库只出现在 providers
 * - context 不依赖界面；CLI 通过各包的公开接口连接引擎
 * - 每个包 import 的外部包必须在自己的 package.json 中声明（弥补 npm 提升造成的幽灵依赖）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOWED: Record<string, string[]> = {
	protocol: ["typebox"],
	context: ["@mountains/protocol"],
	providers: ["@mountains/protocol", "@earendil-works/pi-ai"],
	tools: ["@mountains/protocol"],
	checkpoints: [],
	telemetry: ["@mountains/protocol"],
	engine: ["@mountains/protocol", "@mountains/context", "@mountains/providers", "@mountains/tools", "@mountains/telemetry", "@mountains/checkpoints"],
	cli: ["@mountains/protocol", "@mountains/engine", "@mountains/providers", "@mountains/tools", "@mountains/telemetry", "@mountains/context"],
};

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
	});
}

const problems: string[] = [];
const roots = [
	...readdirSync("packages").map(pkg => ({ pkg, dir: join("packages", pkg) })),
	{ pkg: "cli", dir: join("apps", "cli") },
];
for (const { pkg, dir } of roots) {
	const src = join(dir, "src");
	let files: string[];
	try {
		files = walk(src);
	} catch {
		continue;
	}
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
	const declared = new Set(Object.keys(manifest.dependencies ?? {}));
	const allowed = new Set(ALLOWED[pkg] ?? []);
	for (const f of files) {
		const text = readFileSync(f, "utf8");
		// ObjC.import in a native bridge is a method call, not an npm dynamic import.
		for (const m of text.matchAll(/(?:import|export)[^'"]*from\s+["']([^"']+)["']|(?<![\w$.])import\(["']([^"']+)["']\)/g)) {
			const spec = m[1] ?? m[2] ?? "";
			if (spec.startsWith(".") || spec.startsWith("node:")) continue;
			const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);
			if (!allowed.has(name)) problems.push(`${f}: ${pkg} 不允许依赖 ${name}`);
			else if (!declared.has(name)) problems.push(`${f}: 使用了 ${name} 但 ${dir}/package.json 未声明`);
		}
	}
}
if (problems.length) {
	console.error(problems.join("\n"));
	process.exit(1);
}
console.log("依赖方向检查通过");
