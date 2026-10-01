import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_PLAN_LIMITS, executeQueryPlan, publishQueryResult, QUERY_PLAN_VERSION, queryEnvironment, validateQueryPlan, verifyQueryResultCurrent, type PlanOptions, type QueryEnvironment, type QueryPlan } from "./plan.ts";
import type { ToolDefinition, ToolResult } from "./types.ts";
import { sha256, ToolError } from "./workspace.ts";

const MAX_RECIPES = 40;
const MAX_STORE_BYTES = 256 * 1024;
export interface QueryRecipe {
	id: string;
	name: string;
	createdAt: string;
	parameterization: "current-workspace-relative-v1";
	plan: QueryPlan;
	environment: QueryEnvironment;
}
interface RecipeFile { version: 1; recipes: QueryRecipe[] }
export function recipeFileFor(workspaceRoot: string, home = process.env.MOUNTAINS_HOME ?? join(homedir(), ".mountains")): string {
	return join(home, "projects", sha256(realpathSync(workspaceRoot)).slice(0, 16), "query-recipes.json");
}
function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + sep); }
function realDestination(path: string): string {
	let ancestor = resolve(path);
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)));
}
/** Resolve the nearest existing ancestor so an external symlink cannot point the store into the repository. */
function assertExternal(file: string, workspaceRoot: string): void {
	const root = realpathSync(workspaceRoot); const destination = realDestination(file);
	const boundaries = new Set([root]);
	// Keep the repository boundary even if Git is missing, misconfigured or busy.
	for (let ancestor = root; ; ancestor = dirname(ancestor)) {
		if (existsSync(join(ancestor, ".git"))) { boundaries.add(ancestor); break; }
		if (dirname(ancestor) === ancestor) break;
	}
	try { boundaries.add(realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000, maxBuffer: 4096 }).trim())); }
	catch { /* Non-Git workspaces still have the same root boundary. */ }
	if ([...boundaries].some((boundary) => inside(destination, boundary))) throw new ToolError("Query methods must be stored outside the workspace and its repository");
}
function sameEnvironment(a: QueryEnvironment, b: QueryEnvironment): boolean {
	// Methods contain no cached answers. A new commit on the same branch is safe
	// because every query is executed again; HEAD is retained only for auditing.
	// Detached HEAD has no stable branch binding, so it remains commit-specific.
	return Object.keys(a).length === Object.keys(b).length && (Object.keys(b) as (keyof QueryEnvironment)[]).every((key) => key === "gitHead" && a.gitBranch !== "DETACHED" ? true : a[key] === b[key]);
}
/** Bounded, atomic method storage. No result bodies, inferred facts or success claims are retained. */
export class QueryRecipeStore {
	readonly file: string;
	constructor(file: string) { this.file = resolve(file); }

	entries(workspaceRoot: string): QueryRecipe[] {
		assertExternal(this.file, workspaceRoot);
		if (!existsSync(this.file)) return [];
		if (!statSync(this.file).isFile()) throw new ToolError("Query method store is not a regular file");
		const fd = openSync(this.file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		let content: string;
		try {
			if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_STORE_BYTES) throw new ToolError("Query method store is too large or not a regular file");
			const data = Buffer.alloc(MAX_STORE_BYTES + 1); let offset = 0;
			while (offset < data.length) { const count = readSync(fd, data, offset, data.length - offset, null); if (!count) break; offset += count; }
			if (offset > MAX_STORE_BYTES) throw new ToolError("Query method store is too large");
			content = data.subarray(0, offset).toString("utf8");
		} finally { closeSync(fd); }
		const data = JSON.parse(content) as RecipeFile;
		if (!data || typeof data !== "object" || Object.keys(data).some((k) => !["version", "recipes"].includes(k)) || data.version !== 1 || !Array.isArray(data.recipes) || data.recipes.length > MAX_RECIPES) throw new ToolError("Invalid query method store");
		const ids = new Set<string>();
		for (const recipe of data.recipes) {
			if (!recipe || typeof recipe !== "object" || Object.keys(recipe).some((k) => !["id", "name", "createdAt", "parameterization", "plan", "environment"].includes(k)) ||
				!/^q_[0-9a-f]{16}$/.test(recipe.id) || ids.has(recipe.id) || typeof recipe.name !== "string" || recipe.name.length < 1 || recipe.name.length > 120 ||
				typeof recipe.createdAt !== "string" || recipe.parameterization !== "current-workspace-relative-v1") throw new ToolError("Invalid query method entry");
			validateQueryPlan(recipe.plan, 20);
			if (!recipe.environment || typeof recipe.environment !== "object" || recipe.environment.version !== QUERY_PLAN_VERSION || recipe.environment.workspace !== sha256(realpathSync(workspaceRoot))) throw new ToolError("Query method version or workspace is no longer applicable");
			for (const step of recipe.plan.steps) {
				if ("path" in step && typeof step.path === "string" && (isAbsolute(step.path) || step.path.split(/[\\/]/).includes(".."))) throw new ToolError("Stored method path is not workspace-relative");
			}
			ids.add(recipe.id);
		}
		return data.recipes;
	}

	private write(recipes: QueryRecipe[], workspaceRoot: string): void {
		assertExternal(this.file, workspaceRoot);
		const content = JSON.stringify({ version: 1, recipes } satisfies RecipeFile);
		if (recipes.length > MAX_RECIPES || Buffer.byteLength(content) > MAX_STORE_BYTES) throw new ToolError("Query method store limit reached; forget unused methods first");
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		assertExternal(this.file, workspaceRoot);
		const temp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
		let fd: number | undefined;
		try {
			fd = openSync(temp, "wx", 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined;
			renameSync(temp, this.file);
		} finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
	}

	private withLock<T>(workspaceRoot: string, action: () => T): T {
		assertExternal(this.file, workspaceRoot);
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		assertExternal(this.file, workspaceRoot);
		const lock = `${this.file}.lock`;
		let fd: number;
		try { fd = openSync(lock, "wx", 0o600); }
		catch { throw new ToolError("Query method store is locked; retry later (a crashed writer may require removing its stale lock)"); }
		try { writeFileSync(fd, String(process.pid)); return action(); }
		finally { closeSync(fd); unlinkSync(lock); }
	}

	save(name: string, plan: QueryPlan, environment: QueryEnvironment, workspaceRoot: string): QueryRecipe {
		return this.withLock(workspaceRoot, () => {
		if (!name.trim() || name.length > 120) throw new ToolError("Invalid query method name");
		const validated = validateQueryPlan(plan, 20);
		for (const step of validated.steps) if ("path" in step && typeof step.path === "string" && (isAbsolute(step.path) || step.path.split(/[\\/]/).includes(".."))) throw new ToolError("Stored method path must be workspace-relative");
		const existing = this.entries(workspaceRoot);
		const id = `q_${sha256(JSON.stringify({ plan: validated, environment })).slice(0, 16)}`;
		const recipe: QueryRecipe = { id, name, plan: validated, environment, createdAt: new Date().toISOString(), parameterization: "current-workspace-relative-v1" };
		this.write([...existing.filter((r) => r.id !== id), recipe], workspaceRoot);
		return recipe;
		});
	}

	forget(id: string, workspaceRoot: string): boolean {
		return this.withLock(workspaceRoot, () => {
		const entries = this.entries(workspaceRoot); const remaining = entries.filter((r) => r.id !== id);
		if (entries.length === remaining.length) return false;
		this.write(remaining, workspaceRoot); return true;
		});
	}
}
function failure(e: unknown): ToolResult {
	const error = e instanceof Error ? e.message : String(e);
	return { ok: false, modelContent: `Query method stopped: ${error}`, summary: `查证方法已停止：${error}`, details: { complete: false, error } };
}
export function createRecipeTool(store: QueryRecipeStore, options: Omit<PlanOptions, "recipes"> = {}): ToolDefinition {
	return { name: "query_recipe", logicalName: "query.recipe", readOnly: false,
		description: "List, replay or forget saved deterministic query methods. List returns method descriptions only, never old answers. Replay checks workspace, branch, identity, permissions and tool versions, then runs every step against current files. Same-branch commits are rechecked, not cached. Forget only writes the external method store.",
		parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "replay", "forget"] }, id: { type: "string" } }, required: ["action"], additionalProperties: false },
		async execute(args, ctx) {
			try {
				const deadline = Date.now() + (options.limits?.maxDurationMs ?? DEFAULT_PLAN_LIMITS.maxDurationMs);
				if (Object.keys(args).some((k) => !["action", "id"].includes(k))) throw new ToolError("Unknown query method argument");
				if (args.action === "list") {
					const entries = store.entries(ctx.workspace.root).map((r) => ({ id: r.id, name: r.name, steps: r.plan.steps.length, createdAt: r.createdAt }));
					return { ok: true, modelContent: entries.length ? entries.map((r) => `${r.id}: ${r.name} (${r.steps} steps; applicability checked on replay)`).join("\n") : "No saved query methods.", summary: `${entries.length} 个查证方法`, details: { methods: entries } };
				}
				if (typeof args.id !== "string" || !/^q_[0-9a-f]{16}$/.test(args.id)) throw new ToolError("Invalid query method id");
				if (args.action === "forget") {
					if (!store.forget(args.id, ctx.workspace.root)) throw new ToolError("Query method not found or revoked");
					return { ok: true, modelContent: `Forgot query method ${args.id}.`, summary: "已移除查证方法", details: { id: args.id } };
				}
				if (args.action !== "replay") throw new ToolError("Invalid query method action");
				const recipe = store.entries(ctx.workspace.root).find((r) => r.id === args.id);
				if (!recipe) throw new ToolError("Query method not found or revoked");
				const environment = await queryEnvironment(ctx, deadline);
				if (!sameEnvironment(recipe.environment, environment)) throw new ToolError("Query method no longer applies: workspace, environment, permissions, branch/commit or implementation changed; make a new plan");
				const result = await executeQueryPlan(recipe.plan, ctx, options, deadline);
				if (result.ok) {
					if (!sameEnvironment(environment, await queryEnvironment(ctx, deadline))) throw new ToolError("Environment changed while replaying; results are not current");
					if (!store.entries(ctx.workspace.root).some((entry) => entry.id === recipe.id)) throw new ToolError("Query method was revoked during replay");
					verifyQueryResultCurrent(result, ctx);
					result.details.recipeId = recipe.id; result.details.replayed = true;
					result.modelContent = `Replayed method ${recipe.id}; the following evidence was read now.\n${result.modelContent}`;
				}
				return publishQueryResult(result, ctx);
			} catch (e) { return failure(e); }
		} };
}
