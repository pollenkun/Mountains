import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, keychainService, mask, validKey } from "../src/main/keys.ts";

test("keys map to their Keychain item, show only a masked form, and refuse characters a key never has", () => {
	assert.equal(keychainService("DEEPSEEK_API_KEY"), "mountains-deepseek");
	assert.equal(keychainService("OPENAI_COMPATIBLE_API_KEY"), null, "only PROVIDER_API_KEY names map");
	assert.equal(keychainService("PATH"), null);
	assert.equal(mask("sk-1234567890abcdef3f9a"), "sk-••••••••3f9a");
	assert.ok(validKey("sk-1234567890abcdef"));
	for (const bad of ["short", "sk-abc def ghij", "sk-abc\"def-ghij", "sk-abc\ndef-ghij", "sk-abc;rm -rf"]) assert.equal(validKey(bad), false, bad);
});

test("the key file holds only what the system encrypted, and another opening reads it back", () => {
	const dir = mkdtempSync(join(tmpdir(), "mountains-keys-"));
	const cipher = { available: () => true, encrypt: (text: string) => Buffer.from([...text].reverse().join("")), decrypt: (data: Buffer) => [...data.toString()].reverse().join("") };
	try {
		const path = join(dir, "keys.json");
		fileStore(path, cipher).write("DEEPSEEK_API_KEY", "sk-1234567890abcdef");
		fileStore(path, cipher).write("ZHIPU_API_KEY", "zk-1234567890abcdef");
		assert.ok(!readFileSync(path, "utf8").includes("sk-1234567890abcdef"));
		const reopened = fileStore(path, cipher);
		assert.equal(reopened.read("DEEPSEEK_API_KEY"), "sk-1234567890abcdef");
		reopened.remove("DEEPSEEK_API_KEY");
		assert.equal(fileStore(path, cipher).read("DEEPSEEK_API_KEY"), null);
		assert.equal(fileStore(path, cipher).read("ZHIPU_API_KEY"), "zk-1234567890abcdef");
		assert.throws(() => fileStore(path, { ...cipher, available: () => false }).write("ZHIPU_API_KEY", "zk-1234567890abcdef"), /不能加密/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
