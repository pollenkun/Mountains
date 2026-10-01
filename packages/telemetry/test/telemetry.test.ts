import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { knownSecrets, readRecording, Recorder, redactText, redactValue, SpendLedger } from "../src/index.ts";

describe("脱敏", () => {
	test("鉴权头、Key 字段、环境变量中的密钥值与常见密钥形态都被抹掉", () => {
		const secrets = knownSecrets({ DEEPSEEK_API_KEY: "sk-abcdefghijklmnopqrstuvwx", MY_TOKEN: "tok_1234567890", PATH: "/usr/bin" });
		assert.deepEqual(secrets, ["sk-abcdefghijklmnopqrstuvwx", "tok_1234567890"]);
		const v = redactValue(
			{ headers: { Authorization: "Bearer xyz", "content-type": "json" }, apiKey: "k", note: "用 tok_1234567890 调用", other: "sk-zzzzzzzzzzzzzzzzzzzzzzzz" },
			secrets,
		) as Record<string, Record<string, string> | string>;
		assert.equal((v.headers as Record<string, string>).Authorization, "[REDACTED]");
		assert.equal((v.headers as Record<string, string>)["content-type"], "json");
		assert.equal(v.apiKey, "[REDACTED]");
		assert.equal(v.note, "用 [REDACTED] 调用");
		assert.equal(v.other, "[REDACTED]");
		assert.equal(redactText("Authorization: Bearer abcdefghijklmnopqrstu", []), "Authorization: [REDACTED]");
	});

	test("录制文件落盘前脱敏，且可读回", () => {
		process.env.TEST_SECRET_TOKEN = "super-secret-value-123";
		try {
			const path = join(mkdtempSync(join(tmpdir(), "rec-")), "r.jsonl");
			const rec = new Recorder(path);
			rec.write("tool.output", { content: "读到 super-secret-value-123", headers: { authorization: "Bearer a" } });
			const text = readFileSync(path, "utf8");
			assert.ok(!text.includes("super-secret-value-123"));
			assert.equal(readRecording(path)[0]?.kind, "tool.output");
		} finally {
			delete process.env.TEST_SECRET_TOKEN;
		}
	});
});

describe("累计花费台账", () => {
	test("跨实例累加", () => {
		const p = join(mkdtempSync(join(tmpdir(), "sp-")), "s.jsonl");
		new SpendLedger(p).add({ at: "x", runId: "r", requestId: "q", amount: 0.25, currency: "USD", partial: false });
		new SpendLedger(p).add({ at: "x", runId: "r", requestId: "q2", amount: 0.5, currency: "USD", partial: true });
		new SpendLedger(p).add({ at: "x", runId: "r", requestId: "q3", amount: 9, currency: "CNY", partial: false });
		assert.equal(new SpendLedger(p).total(), 0.75);
	});
});
