import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

/** Execute test-only JS stubs with Node on every OS, preserving real pipes and process lifecycle. */
export function useNodeFixture(t: TestContext, path: string): void {
	const original = childProcess.spawn;
	const mocked = t.mock.method(childProcess, "spawn", (...args: unknown[]) => {
		if (args[0] === path) {
			const argv = args[1];
			if (!Array.isArray(argv)) throw new Error("Node fixture requires an argument list");
			return Reflect.apply(original, childProcess, [process.execPath, [path, ...argv], ...args.slice(2)]);
		}
		return Reflect.apply(original, childProcess, args);
	});
	syncBuiltinESMExports();
	t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}
