import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Test the actual release build script using fake compilers and only own files.
// No compiler installation, native execution, input, GUI, or account access.
for (const scenario of ["stable", "edit", "edit-and-restore"] as const) {
	test("release native build pins identical architecture sources: " + scenario, { skip: process.platform !== "darwin", timeout: 20_000 }, () => {
		const root = mkdtempSync(join(tmpdir(), "mountains-native-build-check-"));
		try {
			const scripts = join(root, "scripts"), native = join(root, "packages/computer/native"), destination = join(native, "darwin-universal"), bin = join(root, "bin"), log = join(root, "commands.jsonl");
			for (const path of [scripts, native, destination, bin]) mkdirSync(path, { recursive: true, mode: 0o700 });
			const build = join(scripts, "build-computer-native.mjs");
			writeFileSync(build, readFileSync(new URL("../../../scripts/build-computer-native.mjs", import.meta.url)));
			for (const name of ["capture", "event-data", "input-claim", "launch-app", "process-identity", "window-server"]) {
				writeFileSync(join(native, name + ".swift"), "source-A-" + name);
				writeFileSync(join(destination, name), "previous-binary-" + name);
				writeFileSync(join(destination, name + ".json"), "previous-manifest-" + name);
			}
			for (const command of ["swiftc", "lipo", "codesign"]) {
				const path = join(bin, command);
				writeFileSync(path, `#!${process.execPath}\n` + `
const fs=require('node:fs'),path=require('node:path');
const command=path.basename(process.argv[1]),args=process.argv.slice(2),log=process.env.BUILD_TEST_LOG;
if(command==='swiftc'){
 const source=args.find(value=>value.endsWith('.swift')),bytes=fs.readFileSync(source,'utf8'),arch=args[args.indexOf('-target')+1];
 fs.appendFileSync(log,JSON.stringify({command,source,bytes,arch,args})+'\\n');
 fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({bytes,arch}));
 if(source.endsWith('event-data.swift')&&process.env.BUILD_TEST_SCENARIO!=='stable'){
  const original=process.env.BUILD_TEST_ORIGINAL;
  if(arch.startsWith('arm64'))fs.writeFileSync(original,'source-B-event-data');
  else if(process.env.BUILD_TEST_SCENARIO==='edit-and-restore')fs.writeFileSync(original,'source-A-event-data');
 }
}else if(command==='lipo'){
 fs.writeFileSync(args[args.indexOf('-output')+1],JSON.stringify(args.slice(1,args.indexOf('-output')).map(value=>JSON.parse(fs.readFileSync(value,'utf8')))));
}else if(command!=='codesign')process.exit(2);
`, { mode: 0o700 });
				chmodSync(path, 0o700);
			}
			const result = spawnSync(process.execPath, [build], { env: { ...process.env, PATH: bin, BUILD_TEST_LOG: log, BUILD_TEST_SCENARIO: scenario, BUILD_TEST_ORIGINAL: join(native, "event-data.swift") }, encoding: "utf8", timeout: 15_000 });
			const captured = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { source: string; bytes: string; arch: string; args: string[] });
			assert.equal(captured.length, 12);
			for (const name of ["capture", "event-data", "input-claim", "launch-app", "process-identity", "window-server"]) {
				const builds = captured.filter(value => value.source.endsWith(name + ".swift"));
				assert.equal(builds.length, 2); assert.equal(builds[0]!.bytes, "source-A-" + name); assert.equal(builds[1]!.bytes, builds[0]!.bytes);
				// Top-level-code sources are not libraries; capture keeps the Swift 5 mode it was written and tested in.
				for (const build of builds) {
					assert.equal(build.args.includes("-parse-as-library"), !["capture", "event-data"].includes(name), name);
					assert.equal(build.args[build.args.indexOf("-swift-version") + 1], name === "capture" ? "5" : "6", name);
				}
				assert.notEqual(builds[0]!.source, join(native, name + ".swift"));
				assert.equal(existsSync(builds[0]!.source), false, "private build snapshots must be removed after either outcome");
				if (scenario === "edit") {
					assert.notEqual(result.status, 0); assert.match(result.stderr, /Native source changed during build/);
					assert.equal(readFileSync(join(destination, name), "utf8"), "previous-binary-" + name);
					assert.equal(readFileSync(join(destination, name + ".json"), "utf8"), "previous-manifest-" + name);
				} else {
					assert.equal(result.status, 0, result.stderr);
					const binary = readFileSync(join(destination, name)), manifest = JSON.parse(readFileSync(join(destination, name + ".json"), "utf8"));
					assert.equal(manifest.sourceSha256, sha("source-A-" + name)); assert.equal(manifest.binarySha256, sha(binary));
					assert.equal(statSync(join(destination, name)).mode & 0o777, 0o755); assert.equal(statSync(join(destination, name + ".json")).mode & 0o777, 0o644);
					assert.deepEqual(JSON.parse(binary.toString()).map((value: { bytes: string }) => value.bytes), ["source-A-" + name, "source-A-" + name]);
				}
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}
