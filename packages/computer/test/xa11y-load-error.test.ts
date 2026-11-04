import assert from "node:assert/strict";
import { test } from "node:test";
import { xa11yLoadError } from "../src/xa11y-load-error.ts";

// Same nested cause shape as the xa11y 0.15.2 loader failure recorded on macOS 13.6.
const missingScreenshotClass = new Error("dlopen(xa11y.darwin-arm64.node, 0x0001): Symbol not found: _OBJC_CLASS_$_SCScreenshotManager\nExpected in: ScreenCaptureKit.framework");
const loadFailure = new Error("Cannot find native binding. Please try npm i again.", {
	cause: new Error("Cannot find module '@crowecawcaw/xa11y-wasm32-wasi'", {
		cause: new Error("Cannot find module './xa11y.wasi.cjs'", { cause: missingScreenshotClass }),
	}),
});

test("macOS 13 exposes the incompatible native symbol hidden under missing-module fallbacks", () => {
	const error = xa11yLoadError(loadFailure, "darwin", "22.6.0");
	assert.match(error.message, /macOS 14.*SCScreenshotManager.*macOS 13/);
	assert.match(error.message, /兼容 macOS 13 的组件构建/);
	assert.match(error.message, /重新安装同一组件或修改辅助功能权限无法解决/);
	assert.doesNotMatch(error.message, /npm i|可能没有预编译版本/);
	assert.equal(error.cause, loadFailure);
});

for (const [platform, kernel] of [["win32", "22.6.0"], ["linux", "22.6.0"], ["darwin", "23.6.0"], ["darwin", "25.0.0"]] as const) {
	test(`does not impose macOS 13 diagnostics on ${platform} ${kernel}`, () => {
		const error = xa11yLoadError(loadFailure, platform, kernel);
		assert.match(error.message, /Cannot find native binding/);
		assert.doesNotMatch(error.message, /无法在 macOS 13 上加载/);
		assert.equal(error.cause, loadFailure);
	});
}

test("an actually missing package and an unrelated symbol retain their original diagnosis", () => {
	for (const failure of [new Error("Cannot find module '@crowecawcaw/xa11y'"), new Error("Symbol not found: _OBJC_CLASS_$_OtherClass"), new Error("SCScreenshotManager capture failed")]) {
		const error = xa11yLoadError(failure, "darwin", "22.6.0");
		assert.ok(error.message.includes(failure.message));
		assert.doesNotMatch(error.message, /无法在 macOS 13 上加载/);
		assert.equal(error.cause, failure);
	}
});

test("cyclic and non-Error causes do not hide or hang a load failure", () => {
	const cyclic = new Error("native loader failed");
	cyclic.cause = cyclic;
	assert.match(xa11yLoadError(cyclic, "darwin", "22.6.0").message, /native loader failed/);
	assert.equal(xa11yLoadError("plain failure", "darwin", "22.6.0").cause, "plain failure");
	const wrapped = { message: "wrapper", cause: { message: missingScreenshotClass.message } };
	assert.match(xa11yLoadError(wrapped, "darwin", "22.6.0").message, /无法在 macOS 13 上加载/);
});
