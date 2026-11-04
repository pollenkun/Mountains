import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const electron = createRequire(import.meta.url)("electron") as string;
const shots = "/Users/beluga383/Documents/ChatGPT/Mountains-Desktop-截图/第0步";
const boardShots = "/Users/beluga383/Documents/ChatGPT/Mountains-Desktop-截图/第1步";

function launch(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ code: number | null; stderr: string }> {
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		...env,
		MOUNTAINS_DESKTOP_HIDDEN: "1",
		DEEPSEEK_API_KEY: "desktop-test-key",
		MOUNTAINS_TEST_KEYS: "1",
		MOUNTAINS_BUDGET: "5",
	};
	delete childEnv.ELECTRON_RUN_AS_NODE;
	delete childEnv.NODE_OPTIONS;
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("launch aborted"));
			return;
		}
		const child = spawn(electron, [join(root, "apps/desktop/test/fixture-main.ts")], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		const stop = () => child.kill("SIGKILL");
		signal.addEventListener("abort", stop, { once: true });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.on("error", (error) => {
			signal.removeEventListener("abort", stop);
			reject(error);
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", stop);
			resolve({ code, stderr });
		});
	});
}

test("hidden window stays isolated, and screenshots cover both themes and cancel", { timeout: 600_000 }, async (t) => {
	const home = mkdtempSync(join(tmpdir(), "mountains-desktop-shell-"));
	const workspace = mkdtempSync(join(tmpdir(), "mountains-desktop-shell-ws-"));
	const config = join(home, "config.json");
	writeFileSync(config, `${JSON.stringify({
		model: "deepseek-flash",
		baseUrl: "https://offline.invalid/v1",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		checkpoints: false,
		skills: { enabled: false, dirs: [], enable: [], permissions: {} },
		retry: { maxAttempts: 1, baseDelayMs: 0 },
		limits: { maxTurns: 4, maxRequests: 4, maxCost: 5 },
	})}\n`);
	mkdirSync(shots, { recursive: true });
	mkdirSync(boardShots, { recursive: true });
	const built = spawnSync(process.execPath, [join(root, "apps/desktop/scripts/build.ts")], { cwd: root, encoding: "utf8" });
	assert.equal(built.status, 0, built.stderr);
	const base = {
		MOUNTAINS_HOME: home,
		MOUNTAINS_DESKTOP_WORKSPACE: workspace,
		MOUNTAINS_DESKTOP_CONFIG: config,
		MOUNTAINS_DESKTOP_LEDGER: join(home, "spend.jsonl"),
	};

	const securityPath = join(home, "security.json");
	const security = await launch({
		...base,
		MOUNTAINS_DESKTOP_PROBE: "security",
		MOUNTAINS_DESKTOP_RESULT: securityPath,
		MOUNTAINS_DESKTOP_OUT: join(home, "security-out"),
	}, t.signal);
	assert.equal(security.code, 0, security.stderr);
	const report = JSON.parse(readFileSync(securityPath, "utf8")) as {
		page: { require: string; process: string; mountains: string; send: string };
		droppedCommands: number;
		runsStarted: number;
		urlBefore: string;
		urlAfter: string;
		navigationBlocked: number;
		windowsDenied: number;
	};
	assert.equal(report.page.require, "undefined");
	assert.equal(report.page.process, "undefined");
	assert.equal(report.page.mountains, "object");
	assert.equal(report.page.send, "function");
	assert.ok(report.droppedCommands >= 2);
	assert.equal(report.runsStarted, 0);
	assert.equal(report.urlAfter, report.urlBefore);
	assert.ok(report.navigationBlocked >= 1);
	assert.ok(report.windowsDenied >= 1);

	for (const [theme, name] of [["dark", "深色-流式完成.png"], ["light", "浅色-流式完成.png"]] as const) {
		const shot = join(shots, name);
		const result = await launch({
			...base,
			MOUNTAINS_DESKTOP_PROBE: "screenshot",
			MOUNTAINS_DESKTOP_THEME: theme,
			MOUNTAINS_DESKTOP_FAKE: "stream",
			MOUNTAINS_DESKTOP_SHOT: shot,
			MOUNTAINS_DESKTOP_OUT: join(home, `out-${theme}`),
			MOUNTAINS_DESKTOP_TASK: "这个文件夹是做什么的？",
		}, t.signal);
		assert.equal(result.code, 0, result.stderr);
		const meta = JSON.parse(readFileSync(`${shot}.json`, "utf8")) as { status: string; reply: string };
		assert.equal(meta.status, "completed");
		assert.ok(meta.reply.length > 0, "the reply was not drawn before the shot");
		assert.ok(statSync(shot).size > 30_000);
	}

	const terminal = join(shots, "终端输出.png");
	const ran = await launch({
		...base,
		MOUNTAINS_DESKTOP_PROBE: "screenshot",
		MOUNTAINS_DESKTOP_THEME: "dark",
		MOUNTAINS_DESKTOP_FAKE: "command",
		MOUNTAINS_DESKTOP_EXPAND: "1",
		MOUNTAINS_DESKTOP_SHOT: terminal,
		MOUNTAINS_DESKTOP_OUT: join(home, "out-command"),
		MOUNTAINS_DESKTOP_TASK: "跑一下 echo。",
	}, t.signal);
	assert.equal(ran.code, 0, ran.stderr);
	const terminalMeta = JSON.parse(readFileSync(`${terminal}.json`, "utf8")) as { status: string; output: string };
	assert.equal(terminalMeta.status, "completed");
	assert.match(terminalMeta.output, /hello from mountains/);

	// A file dropped on the composer becomes an attachment; its path goes with the message when it is sent.
	const dropped = join(home, "季度 报告.txt");
	writeFileSync(dropped, "quarterly\n");
	const dropResult = join(home, "drop.json");
	const drop = await launch({ ...base, MOUNTAINS_DESKTOP_PROBE: "drop", MOUNTAINS_DESKTOP_DROP_FILE: dropped, MOUNTAINS_DESKTOP_RESULT: dropResult, MOUNTAINS_DESKTOP_OUT: join(home, "out-drop") }, t.signal);
	assert.equal(drop.code, 0, drop.stderr);
	assert.deepEqual(JSON.parse(readFileSync(dropResult, "utf8")), { highlighted: true, text: dropped, after: false });

	// The thinking tier is dragged, not only clicked: the knob follows the pointer and the last stop is chosen.
	const sliderResult = join(home, "slider.json");
	const slid = await launch({ ...base, MOUNTAINS_DESKTOP_PROBE: "slider", MOUNTAINS_DESKTOP_RESULT: sliderResult, MOUNTAINS_DESKTOP_OUT: join(home, "out-slider") }, t.signal);
	assert.equal(slid.code, 0, slid.stderr);
	const slider = JSON.parse(readFileSync(sliderResult, "utf8")) as { before: string; after: string; path: number[] };
	assert.notEqual(slider.after, slider.before);
	assert.ok(slider.path.every((x, i) => i === 0 || x >= slider.path[i - 1]!) && slider.path.at(-1)! - slider.path[0]! > 100, JSON.stringify(slider.path));

	// A SIUI reply can be played with: the slider recomputes the results, and its button only fills the composer.
	const siuiResult = join(home, "siui.json");
	const played = await launch({ ...base, MOUNTAINS_DESKTOP_PROBE: "siui", MOUNTAINS_DESKTOP_RESULT: siuiResult, MOUNTAINS_DESKTOP_OUT: join(home, "out-siui") }, t.signal);
	assert.equal(played.code, 0, played.stderr);
	const siui = JSON.parse(readFileSync(siuiResult, "utf8")) as { before: string[]; after: string[]; draft: string; sent: number };
	assert.deepEqual(siui.before.slice(0, 2), ["210 万", "9430 元"]);
	assert.deepEqual(siui.after.slice(0, 2), ["350 万", "15717 元"]);
	assert.equal(siui.draft, "按总价 500 万、利率 3.5% 再算一下提前还款");
	assert.equal(siui.sent, 1, "the button sends nothing by itself");

	const stopped = join(shots, "停止.png");
	const cancel = await launch({
		...base,
		MOUNTAINS_DESKTOP_PROBE: "screenshot",
		MOUNTAINS_DESKTOP_THEME: "dark",
		MOUNTAINS_DESKTOP_FAKE: "partial",
		MOUNTAINS_DESKTOP_SHOT: stopped,
		MOUNTAINS_DESKTOP_OUT: join(home, "out-cancel"),
		MOUNTAINS_DESKTOP_TASK: "写一段说明，写到一半就停。",
	}, t.signal);
	assert.equal(cancel.code, 0, cancel.stderr);
	const cancelMeta = JSON.parse(readFileSync(`${stopped}.json`, "utf8")) as { status: string };
	assert.equal(cancelMeta.status, "cancelled");
	assert.ok(statSync(stopped).size > 10_000);

	const boards = [
		["payments", "true", "last", "dark", "工具折叠.png"],
		["payments", "true", "last", "light", "工具折叠-浅色.png"],
		["payments", "false", "", "dark", "工具不折叠.png"],
		["payments", "false", "", "light", "工具不折叠-浅色.png"],
		["payments", "false", "src/webhook.ts+18", "dark", "改动.png"],
		["payments", "true", "css:.di[data-k=approval]", "dark", "审批方式.png"],
		["payments", "true", "css:.di[data-k=model]", "dark", "强度.png"],
		["payments", "true", "css:.di[data-k=model]", "light", "强度-浅色.png"],
		["empty", "true", "", "dark", "新对话.png"],
		["empty", "true", "", "light", "新对话-浅色.png"],
		["empty", "true", "css:.di[data-k=history]", "dark", "聊天记录.png"],
		["empty", "true", "css:.di[data-k=settings]", "dark", "设置.png"],
		["siui", "true", "", "dark", "SIUI.png"],
		["siui", "true", "", "light", "SIUI-浅色.png"],
		["approval", "false", "", "dark", "审批.png"],
		["approval", "false", "", "light", "审批-浅色.png"],
	] as const;
	for (const [board, folded, open, theme, name] of boards) {
		const shot = join(boardShots, name);
		const result = await launch({
			...base,
			MOUNTAINS_DESKTOP_PROBE: "board",
			MOUNTAINS_DESKTOP_BOARD: board,
			MOUNTAINS_DESKTOP_FOLDED: folded,
			MOUNTAINS_DESKTOP_OPEN: open,
			MOUNTAINS_DESKTOP_THEME: theme,
			MOUNTAINS_DESKTOP_SHOT: shot,
			MOUNTAINS_DESKTOP_OUT: join(home, `out-${name}`),
		}, t.signal);
		assert.equal(result.code, 0, result.stderr);
		const { rows } = JSON.parse(readFileSync(`${shot}.json`, "utf8")) as { rows: string[] };
		if (board === "payments") assert.ok(rows.some((row) => row.includes(folded === "true" ? "读取了文件，运行了命令" : "src/stripe.ts")), rows.join(" | "));
		else if (board === "approval") assert.ok(rows.some((row) => row.includes("正在读取.github/pull_request_template.md")), rows.join(" | "));
		assert.ok(statSync(shot).size > 10_000);
	}
});
