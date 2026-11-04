import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, interpolate } from "../src/renderer/siui/expr.ts";
import { parseMath, type MathNode } from "../src/renderer/siui/math.ts";
import { controlParts, parse, type UiNode } from "../src/renderer/siui/parse.ts";
import { defaults, problems, styleOf, withDerived } from "../src/renderer/siui/state.ts";

test("SIUI expressions do arithmetic, comparisons and the named functions, and nothing else", () => {
	const vars = { price: 300, years: 30, name: "甲" };
	assert.equal(evaluate("round(price*0.7/(years*12), 2)", vars), 0.58);
	assert.equal(evaluate("price > 200 ? '贵' : '便宜'", vars), "贵");
	assert.equal(evaluate("2 ** 3 ** 2", {}), 512);
	assert.equal(evaluate("-price + 1", vars), -299);
	assert.equal(evaluate("pct(0.256, 1)", {}), "25.6%");
	assert.equal(interpolate("{0.1 + 0.2} 和 {name}", vars).text, "0.3 和 甲");
	for (const bad of ["constructor", "price.toString()", "alert(1)", "this", "price[0]", "`x`"]) assert.throws(() => evaluate(bad, vars), bad);
	const failed = interpolate("月供 {nope * 2}", vars);
	assert.equal(failed.text, "月供 ⚠");
	assert.match(failed.errors[0]!, /unknown nope/);
});

test("old replies: :: lines still draw, with children and data by indent", () => {
	const blocks = parse([
		"三个方案：",
		"",
		"::slider 总价 price 100..1000 =300 万",
		"::row",
		"  ::stat 月供 {price} · green huge",
		"  ::button 选这个 -> send \"总价 {price}\"",
		"::chart bar 对比",
		"  甲: 3",
		"  乙: 5",
		"",
		"再说一句。",
		"```",
		"::slider 这是代码",
		"```",
	].join("\n"));
	const shape = (n: UiNode): unknown => ({ name: n.name, attrs: n.attrs, text: n.text, styles: n.styles, action: n.action, data: n.data, children: n.children.filter((c) => c.name !== "#text").map(shape) });
	assert.deepEqual(blocks.map((b) => b.kind === "md" ? b.text.trim() : shape(b.node)), [
		"三个方案：",
		{ name: "slider", attrs: { label: "总价", name: "price", min: "100", max: "1000", value: "300", unit: "万" }, text: "", styles: [], action: null, data: [], children: [] },
		{ name: "row", attrs: {}, text: "", styles: [], action: null, data: [], children: [
			{ name: "stat", attrs: { label: "月供" }, text: "{price}", styles: ["green", "huge"], action: null, data: [], children: [] },
			{ name: "button", attrs: {}, text: "选这个", styles: [], action: "send \"总价 {price}\"", data: [], children: [] },
		] },
		{ name: "chart", attrs: { type: "bar", title: "对比" }, text: "", styles: [], action: null, data: ["甲: 3", "乙: 5"], children: [] },
		"再说一句。\n```\n::slider 这是代码\n```",
	]);
});

test("while streaming, a component line waits until it is finished", () => {
	assert.deepEqual(parse("看：\n::stat 月供 {pri", true).map((b) => b.kind), ["md"]);
	assert.deepEqual(parse("看：\n::stat 月供 {price}\n", true).map((b) => b.kind), ["md", "ui"]);
	assert.equal((parse("正在写的一句", true)[0] as { text: string }).text, "正在写的一句");
});

test("a control's variable is the word before its range, options or default, so labels may have spaces", () => {
	assert.deepEqual(controlParts("Monthly payment amt 0..9 =3"), { label: "Monthly payment", name: "amt", rest: ["0..9", "=3"] });
	assert.deepEqual(controlParts("五险一金比例 rate 5..30 =22 % step=0.5")?.name, "rate");
	assert.deepEqual(controlParts("城市 city 北京|上海 =上海")?.name, "city");
	assert.deepEqual(controlParts("夜间模式 dark =on")?.name, "dark");
	assert.deepEqual(defaults(parse("::slider 月薪 salary 5000..60000 =20000 元\n::toggle 夜间 dark =on\n::select 城市 city 北京|上海\n").flatMap((b) => b.kind === "ui" ? [b.node] : [])), { salary: 20000, dark: true, city: "北京" });
});

test("the TeX in a reply becomes text, sub- and superscripts and fractions; an unknown command stays visible", () => {
	const flat = (nodes: MathNode[]): string => nodes.map((n) => n.kind === "text" ? n.text : n.kind === "frac" ? `(${flat(n.over)})/(${flat(n.under)})` : n.kind === "group" ? flat(n.children) : `${n.kind}[${flat(n.children)}]`).join("");
	assert.equal(flat(parseMath("L_1")), "Lsub[1]");
	assert.equal(flat(parseMath("H_{10} \\to x^2")), "Hsub[10] → xsup[2]");
	assert.equal(flat(parseMath("12\\times2=24")), "12×2=24");
	assert.equal(flat(parseMath("\\frac{a+b}{2}\\quad\\alpha")), "(a+b)/(2) α");
	assert.equal(flat(parseMath("\\unknown{x}")), "\\unknownx");
	assert.equal(flat(parseMath("\\left( a-b \\right)")), "( a−b )");
	assert.equal(flat(parseMath("x_")), "xsub[]", "a formula cut off mid-stream does not fail");
});

test("what models really write: a label run into its variable, a score only buttons set, a bare ::", () => {
	assert.deepEqual(controlParts("房价（万元）price 100..800 =300 万 step=10"), { label: "房价（万元）", name: "price", rest: ["100..800", "=300", "万", "step=10"] });
	assert.equal(controlParts("月租金 rent 1500..12000 =5000 元")?.name, "rent");
	const blocks = parse("::slider 目标 goal 10..100 =30\n::\n::row\n  ::button 点击 -> set 分 = 分+1\n  ::button 重开 -> set goal = 10\n", false);
	const nodes = blocks.flatMap((b) => b.kind === "ui" ? [b.node] : []);
	assert.deepEqual(nodes.map((n) => n.name), ["slider", "row"]);
	assert.deepEqual(defaults(nodes), { goal: 30, 分: 0 });
});

const tags = (source: string, live = false) => parse(source, live).flatMap((b) => b.kind === "ui" ? [b.node] : []);

test("short HTML: components, nesting across lines, text around them", () => {
	const blocks = parse([
		"这三个方案差别不小：",
		"",
		"<slider name=price min=100 max=1000 value=300 unit=万 label=总价>",
		"<stat label=月供 class=\"green huge\">",
		"  {round(price*0.7/360, 2)} 万",
		"</stat>",
		"<row>",
		"  <button send=\"总价 {price} 万\">选这个方案</button>",
		"  <button reset>重置</button>",
		"</row>",
		"",
		"**结论**在后面。",
	].join("\n"));
	assert.deepEqual(blocks.map((b) => b.kind === "md" ? "md" : b.node.name), ["md", "slider", "stat", "row", "md"]);
	const [slider, stat, row] = blocks.flatMap((b) => b.kind === "ui" ? [b.node] : []);
	assert.deepEqual(defaults([slider!]), { price: 300 });
	assert.deepEqual([stat!.attrs.label, stat!.styles, stat!.text], ["月供", ["green", "huge"], "{round(price*0.7/360, 2)} 万"]);
	assert.deepEqual(row!.children.map((c) => [c.name, c.action, c.text]), [["button", "send \"总价 {price} 万\"", "选这个方案"], ["button", "reset", "重置"]]);
});

test("HTML habits are read: input types, options, braces, className, a chart's lines", () => {
	const [range, box, select, big, chart] = tags([
		"<input type=range name=n min=1 max=9 value={3}>",
		"<input type=checkbox name=on checked>",
		"<select name=c><option>甲</option><option value=b>乙</option></select>",
		"<big className=\"green\">{a > 1 ? \"多\" : \"少\"}</big>",
		"<chart type=bar title=销售>",
		"  一月: 3",
		"  二月: {n*2}",
		"</chart>",
	].join("\n"));
	assert.deepEqual([range!.name, box!.name, select!.attrs.options, big!.styles, chart!.data], ["slider", "toggle", "甲|b", ["green"], ["一月: 3", "二月: {n*2}"]]);
	assert.deepEqual(defaults([range!, box!, select!]), { n: 3, on: true, c: "甲" });
});

test("hidden state, and tags inside prose or code stay as they are", () => {
	assert.deepEqual(defaults(tags("<var name=score value=2>\n<var name=who value=甲>\n<button set=\"lives = lives-1\">扣</button>\n")), { score: 2, who: "甲", lives: 0 });
	assert.deepEqual(parse("用 <div> 包起来，再写 <slider>。\n").map((b) => b.kind), ["md"]);
	assert.deepEqual(parse("\`\`\`html\n<slider name=a>\n\`\`\`\n").map((b) => b.kind), ["md"]);
});

test("streaming: an open container draws what it has, a tag being written waits", () => {
	const part = tags("<row>\n  <button reset>重置</button>\n  <but", true);
	assert.deepEqual(part.map((n) => [n.name, n.children.map((c) => c.name)]), [["row", ["button"]]]);
	assert.deepEqual(parse("看：\n<sli", true).map((b) => b.kind), ["md"]);
	assert.equal(tags("<big>省下 {fixed(pri", true)[0]!.children[0]!.text, "省下");
});

test("a style says only what is allowed, and never more than 72 px", () => {
	assert.deepEqual(styleOf("color: red; position: fixed; background: url(x); font-size: 200px; z-index: 9; padding: 4px", {}), { color: "red", fontSize: "72px", padding: "4px" });
	assert.equal(styleOf("position: absolute", {}), undefined);
});

test("the slips of real replies: a close for a void tag, several tags on a line, a button at the end of a sentence", () => {
	assert.deepEqual(parse("<slider name=a min=0 max=9></slider>\n<slider name=b min=0 max=9>\n</slider>\n").map((b) => b.kind === "ui" ? b.node.name : "md"), ["slider", "slider"]);
	assert.deepEqual(tags("<var name=a value=1><var name=b value=2>\n<big>{a+b}</big>\n").map((n) => n.name), ["var", "var", "big"]);
	assert.deepEqual(parse("要换成国内三家吗？<button send=\"换\">换</button>\n").map((b) => b.kind === "ui" ? b.node.name : b.text.trim()), ["要换成国内三家吗？", "button"]);
});

test("a variable can be a formula of others, and a button can change several at once", () => {
	const nodes = tags("<slider name=price min=0 max=9 value=4>\n<var name=down value=\"price/2\">\n<var name=who value=甲>\n<big>{down}</big>\n");
	assert.deepEqual(withDerived(defaults(nodes), { price: 8 }), { price: 8, down: 4, who: "甲" });
	assert.deepEqual(problems(nodes), []);
	assert.equal(tags("<button set=\"a = 1; b = a+1\">走</button>")[0]!.action, "set a = 1\nset b = a+1");
	assert.deepEqual(problems(tags("<big>{missing}</big>\n<glow>x</glow>\n")).length, 1, "an unknown tag is plain text; a failed expression is reported");
});

test("a formula may lean on one written after it, and a stray closing tag is dropped", () => {
	const nodes = tags("<var name=diff value=\"buy-rent\">\n<var name=rent value=\"buy/2\">\n<var name=buy value=8>\n");
	assert.deepEqual(withDerived(defaults(nodes), {}), { diff: 4, rent: 4, buy: 8 });
	assert.deepEqual(parse("告诉我配置，我再缩小范围。</note>\n").map((b) => b.kind === "md" ? b.text.trim() : ""), ["告诉我配置，我再缩小范围。"]);
});

test("a label or title left unquoted keeps all its words", () => {
	const [bar, card] = tags("<progress value={done/4} label=总进度 {done}/4>\n<card title=1 · 需求与接口 style=\"color:{done>=1 ? '#22c55e' : '#999'}\" class=green>完成</card>\n");
	assert.deepEqual([bar!.name, bar!.attrs.label, bar!.attrs.value], ["progress", "总进度 {done}/4", "{done/4}"]);
	assert.deepEqual([card!.attrs.title, card!.styles, card!.text], ["1 · 需求与接口", ["green"], "完成"]);
});

test("a component the stream has not closed says so", () => {
	const [open] = parse("<card title=A>\nhello", true);
	assert.equal(open?.kind === "ui" && open.node.open, true);
	const [closed] = parse("<card title=A>\nhello\n</card>\n", true);
	assert.equal(closed?.kind === "ui" && closed.node.open, undefined);
});

test("a scene holds boxes and keys and is known to the checker", () => {
	const [block] = parse('<var y=10>\n<scene w=100 h=100 every=30 set="y=y+1; v=0" press="y=0"><box x=1 y={y} w=5 h=5 color=gold><key code=left set="y=y-1"></scene>\n');
	const scene = parse('<scene w=100 h=100 set="y=y+1"><box x=1 y=2><key code=left set="y=y-1"></scene>\n').find((b) => b.kind === "ui");
	assert.equal(block?.kind, "ui");
	assert.equal(scene?.kind === "ui" && scene.node.name, "scene");
	assert.deepEqual(scene?.kind === "ui" && scene.node.children.map((c) => c.name), ["box", "key"]);
	assert.equal(scene?.kind === "ui" && scene.node.action, "set y=y+1");
	assert.deepEqual(scene?.kind === "ui" ? problems([scene.node]) : null, []);
});

test("a table shows only whole rows, and a head only once its rule has come", () => {
	const shown = (text: string) => parse(text, true).map((b) => b.kind === "md" ? b.text.trim() : b.kind);
	assert.deepEqual(shown("前文\n\n| 维度 | 咖"), ["前文"]);
	assert.deepEqual(shown("前文\n\n| 维度 | 咖啡 |\n"), ["前文"]);
	assert.deepEqual(shown("前文\n\n| 维度 | 咖啡 |\n| --"), ["前文"]);
	assert.deepEqual(shown("前文\n\n| 维度 | 咖啡 |\n| --- | --- |\n| 提神 | 快"), ["前文\n\n| 维度 | 咖啡 |\n| --- | --- |"]);
	assert.deepEqual(shown("前文\n\n| 维度 | 咖啡 |\n| --- | --- |\n| 提神 | 快 |\n"), ["前文\n\n| 维度 | 咖啡 |\n| --- | --- |\n| 提神 | 快 |"]);
});

test("SIUI examples inside inline code preserve the whole table and following prose", () => {
	const table = [
		"| 机制 | 说明 |", "|---|---|",
		'| 按钮 | `<button send="示例">` 起草文字 |',
		'| 场景 | `<scene>` 和 `<box>` 只是代码说明 |',
		"", "后面的正文应当保留。",
	].join("\n");
	for (const live of [false, true]) {
		const result = parse(table + "\n", live);
		assert.deepEqual(result.map(b => b.kind), ["md"]);
		assert.equal(result[0]?.kind === "md" && result[0].text.trim(), table);
	}
});

test("code delimiters can contain backticks without hiding an actual inline button", () => {
	const source = '示例 ``<button send="含 ` 单反引号">``；然后 <button send="真的">继续</button>';
	const blocks = parse(source);
	assert.deepEqual(blocks.map(b => b.kind === "ui" ? b.node.name : b.text), ['示例 ``<button send="含 ` 单反引号">``；然后 ', "button"]);
	assert.equal(blocks[1]?.kind === "ui" && blocks[1].node.action, 'send "真的"');
	assert.deepEqual(tags('`<slider name=n>` 和 `<button reset>重置</button>`'), []);
	assert.deepEqual(parse('`<button send="示例">` <button reset>重置</button>').map(b => b.kind === "ui" ? b.node.action : b.text), ['`<button send="示例">` ', "reset"]);
	assert.deepEqual(tags('```html\n<button send="示例">\n```\n<button reset>重置</button>').map(n => n.name), ["button"]);
});

test("an unfinished streamed inline example does not briefly become a control", () => {
	assert.deepEqual(tags('说明：`<button send="示例">', true), []);
	assert.deepEqual(tags('说明：`<button send="示例">`\n', true), []);
	assert.deepEqual(tags('说明：`<button send="示例">`\n<button reset>重置</button>\n', true).map(n => n.name), ["button"]);
});
