import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Recorder, redactText } from "../src/index.ts";

// Review B19 and B03: newer key shapes are masked, and recordings are owner-only.
test("B19: OpenAI project/service keys and GitHub fine-grained tokens are masked; ordinary words are not", () => {
	for (const secret of ["sk-proj-abcdefghijklmnopqrstuvwx", "sk-svcacct-abcdefghijklmnopqrstuv", "github_pat_abcdefghijklmnopqrstuvwx", "gho_abcdefghijklmnopqrstuvwxyz", "ghp_abcdefghijklmnopqrstuvwxyz"]) {
		assert.equal(redactText(`key=${secret} end`, []), "key=[REDACTED] end", secret);
	}
	for (const plain of ["risk-assessment-checklist-items-long", "task-reporter-something-long-enough", "git hub_pat notes"]) assert.equal(redactText(plain, []), plain);
});

test("OpenRouter, Anthropic and Stripe keys read from a file are masked whole, tail included", () => {
	for (const secret of [`sk-or-v1-${"1234567890abcdef".repeat(4)}`, "sk-ant-api03-1234567890abcdef1234567890abcdef-AbC_dEf",
		"sk-1234567890abcdef_SECRET_TAIL", "sk_live_1234567890abcdefGHIJ", "rk_test_1234567890abcdefGHIJ"]) {
		assert.equal(redactText(`KEY=${secret}\n`, []), "KEY=[REDACTED]\n", secret);
	}
});

test("B03: a recording is created owner-only and its secrets are masked on disk", { skip: process.platform === "win32" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "mountains-review-recorder-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "run", "recording.jsonl");
	new Recorder(path).write("tool.output", { text: "token sk-proj-abcdefghijklmnopqrstuvwx" });
	assert.equal(statSync(join(root, "run")).mode & 0o777, 0o700);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.ok(!readFileSync(path, "utf8").includes("sk-proj-"));
});
