import assert from "node:assert/strict";
import { test } from "node:test";
import { billingLabel, isUnbilledCatalogModel } from "../src/catalog.ts";

test("a catalog model without a price is labelled unbilled, and an unknown id is not", () => {
	assert.equal(isUnbilledCatalogModel("gpt-image-1"), true);
	assert.equal(billingLabel("gpt-image-1"), "未计费");
	assert.equal(billingLabel("deepseek-flash"), null);
	assert.equal(isUnbilledCatalogModel("qwythos-9b"), false);
});
