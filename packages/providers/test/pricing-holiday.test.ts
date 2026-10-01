import assert from "node:assert/strict";
import { test } from "node:test";
import { isPeak, pricePeriod } from "../src/pricing.ts";

test("DeepSeek 峰谷：工作日北京 9–12、14–18 点为高峰；周末与法定节假日全天低谷", () => {
	assert.equal(isPeak(new Date("2026-09-30T01:30:00Z")), true, "周三北京 9:30");
	assert.equal(isPeak(new Date("2026-09-30T05:00:00Z")), false, "周三北京 13:00 午间");
	assert.equal(isPeak(new Date("2026-09-30T07:00:00Z")), true, "周三北京 15:00");
	assert.equal(isPeak(new Date("2026-09-30T11:00:00Z")), false, "周三北京 19:00");
	assert.equal(isPeak(new Date("2026-10-01T01:30:00Z")), false, "国庆周四北京 9:30");
	assert.equal(isPeak(new Date("2026-10-07T07:00:00Z")), false, "国庆周三北京 15:00");
	assert.equal(isPeak(new Date("2026-10-09T01:30:00Z")), true, "节后周五北京 9:30");
	assert.equal(isPeak(new Date("2026-10-03T03:00:00Z")), false, "周六");
	assert.equal(pricePeriod(new Date("2026-10-01T02:00:00Z")), "off-peak");
});
