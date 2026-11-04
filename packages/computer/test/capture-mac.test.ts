import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MacCapture, verifyCaptureHelper } from "../src/capture-mac.ts";

const source = fileURLToPath(new URL("../native/capture.swift", import.meta.url));
const binary = fileURLToPath(new URL("../native/darwin-universal/capture", import.meta.url));

test("the bundled capture helper matches its manifest, and a changed byte or another architecture is refused", () => {
	for (const arch of ["arm64", "x64"]) verifyCaptureHelper(source, binary, arch);
	assert.throws(() => verifyCaptureHelper(source, binary, "ia32"), /missing or invalid/);
	const dir = mkdtempSync(join(tmpdir(), "mountains-capture-check-"));
	try {
		const copy = join(dir, "capture");
		copyFileSync(binary, copy); copyFileSync(binary + ".json", copy + ".json");
		verifyCaptureHelper(source, copy, "arm64");
		const bytes = readFileSync(binary);
		bytes[0] = bytes[0]! ^ 0xff;
		writeFileSync(copy, bytes);
		assert.throws(() => verifyCaptureHelper(source, copy, "arm64"), /missing or invalid/);
		const edited = join(dir, "capture.swift");
		writeFileSync(edited, "// changed\n");
		assert.throws(() => verifyCaptureHelper(edited, binary, "arm64"), /missing or invalid/);
		assert.throws(() => verifyCaptureHelper(source, join(dir, "absent"), "arm64"), /missing or invalid/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("capture opens from the bundled binary with no compiler and builds nothing", { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-capture-open-"));
	const saved = { PATH: process.env.PATH, MOUNTAINS_HOME: process.env.MOUNTAINS_HOME };
	try {
		process.env.PATH = dir; process.env.MOUNTAINS_HOME = dir;
		const capture = await MacCapture.open();
		assert.ok(capture, "the shipped binary is used as it is");
		await capture.close();
		assert.equal(existsSync(join(dir, "bin")), false, "nothing is compiled or cached at run time");
	} finally {
		for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		rmSync(dir, { recursive: true, force: true });
	}
});
