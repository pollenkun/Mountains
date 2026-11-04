import assert from "node:assert/strict";
import { test } from "node:test";
import { chosenSearch, pageText, pick, runSearch, SEARCH_SERVICES, webRun, webTools, type SearchService, type WebChoice } from "../src/main/web.ts";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const context = (decision: "allow" | "deny" = "allow") => ({ signal: new AbortController().signal, toolCallId: "t1", approve: async () => decision }) as never;
const run = { model: "glm-5", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY", platform: "zhipu" };
const nothing: WebChoice = { enabled: true, service: null, custom: [] };

test("a path reaches into lists, and the sources of a nested reply come out flat", () => {
	const answer = { output: [{ content: [{ annotations: [{ url: "a" }, { url: "b" }] }] }, { content: [{ annotations: [{ url: "c" }] }] }], list: [1, 2], choices: [{ message: { content: "hi" } }] };
	assert.deepEqual(pick(answer, "output.*.content.*.annotations.*").map((item) => (item as { url: string }).url), ["a", "b", "c"]);
	assert.deepEqual(pick(answer, "list"), [1, 2]);
	assert.deepEqual(pick(answer, "choices.0.message.content"), ["hi"]);
	assert.deepEqual(pick(answer, "missing.path"), []);
});

test("a page becomes its text: no scripts, styles or tags, entities read", () => {
	const page = pageText("<html><head><title>x</title><style>a{}</style></head><body><script>steal()</script><h1>标题</h1><p>one &amp; two&#33;</p><!-- hidden --><div>next</div></body></html>");
	assert.equal(page, "标题\n\none & two!\n\nnext");
});

test("the run's platform follows its address, and a service chosen takes over from it", () => {
	assert.equal(webRun({ model: "m", baseUrl: "https://api.moonshot.cn/v1/", apiKeyEnv: "MOONSHOT_API_KEY" }).platform, "moonshot");
	assert.equal(webRun({ model: "m", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "X" }).platform, null);
	assert.equal(chosenSearch(nothing, { ...run, platform: "deepseek" }), null);
	assert.equal(chosenSearch(nothing, run)?.keyEnv, "ZHIPU_API_KEY");
	assert.equal(chosenSearch({ ...nothing, service: "tavily" }, run)?.name, SEARCH_SERVICES[0]!.name);
});

test("web_search asks each query, drops repeats, and fills the key only into the service's own request", async () => {
	process.env.ZHIPU_API_KEY = "zk-test-key-000000";
	const seen: { url: string; auth: string; query: string }[] = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		seen.push({ url, auth: (init.headers as Record<string, string>).Authorization!, query: JSON.parse(init.body as string).search_query });
		return reply({ search_result: [{ title: "T", link: "https://a.example/", content: "body" }, { title: "again", link: "https://a.example/", content: "" }, { title: "no link", link: "ftp://x", content: "" }] });
	}) as typeof fetch;
	const [search] = webTools({ fetch: fetcher, choice: () => nothing, run: () => run, connect: () => {} });
	const result = await search!.execute({ queries: ["一", "二"] }, context());
	assert.equal(result.ok, true);
	assert.deepEqual(seen.map((one) => one.query), ["一", "二"]);
	assert.equal(seen[0]!.url, "https://open.bigmodel.cn/api/paas/v4/web_search");
	assert.equal(seen[0]!.auth, "Bearer zk-test-key-000000");
	assert.equal(result.modelContent.match(/https:\/\/a\.example/g)!.length, 2, "one source per query");
	assert.ok(!result.modelContent.includes("zk-test"));
	delete process.env.ZHIPU_API_KEY;
});

test("a platform with no search says what to do, and a failing one gives the service's own words", async () => {
	const [none] = webTools({ fetch: fetch, choice: () => nothing, run: () => ({ ...run, platform: "deepseek" }), connect: () => {} });
	assert.match((await none!.execute({ queries: ["x"] }, context())).modelContent, /web_search_setup/);
	process.env.ZHIPU_API_KEY = "zk-test-key-000000";
	const [broken] = webTools({ fetch: (async () => reply({ error: "no balance" }, 402)) as typeof fetch, choice: () => nothing, run: () => run, connect: () => {} });
	const failed = await broken!.execute({ queries: ["x"] }, context());
	assert.equal(failed.ok, false);
	assert.match(failed.modelContent, /402.*no balance/);
	delete process.env.ZHIPU_API_KEY;
});

test("Kimi's own tool call is sent back once, and its reply is the answer", async () => {
	const service: SearchService = { id: "own", name: "", url: "{base}/chat/completions", body: { model: "{model}", messages: [{ role: "user", content: "{query}" }] }, echoTools: true, results: "none", title: "t", link: "l", answer: "choices.0.message.content" };
	const bodies: { messages: { role: string; content?: string }[] }[] = [];
	const fetcher = (async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(init.body as string));
		return bodies.length === 1
			? reply({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", function: { name: "$web_search", arguments: "{\"q\":1}" } }] } }] })
			: reply({ choices: [{ message: { role: "assistant", content: "答案" } }] });
	}) as typeof fetch;
	const found = await runSearch(service, "问题", { ...run, platform: "moonshot" }, fetcher);
	assert.equal(found.answer, "答案");
	assert.equal(bodies.length, 2);
	assert.deepEqual(bodies[1]!.messages.at(-1), { role: "tool", tool_call_id: "c1", name: "$web_search", content: "{\"q\":1}" });
});

test("web_fetch goes through approval, reads text, and refuses what is not a page", async () => {
	const fetcher = (async () => new Response("<p>hello</p>", { headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
	const [, read] = webTools({ fetch: fetcher, choice: () => nothing, run: () => run, connect: () => {} });
	assert.equal((await read!.execute({ url: "https://a.example/" }, context())).modelContent, "hello");
	assert.equal((await read!.execute({ url: "https://a.example/" }, context("deny"))).ok, false);
	assert.equal((await read!.execute({ url: "file:///etc/passwd" }, context())).ok, false);
	const [, image] = webTools({ fetch: (async () => new Response("x", { headers: { "content-type": "image/png" } })) as unknown as typeof fetch, choice: () => nothing, run: () => run, connect: () => {} });
	assert.match((await image!.execute({ url: "https://a.example/a.png" }, context())).modelContent, /not a text page/);
});

test("a service is connected only after a trial search finds sources", async () => {
	const connected: SearchService[] = [];
	const args = { name: "Mine", url: "https://search.example/api?q={query}", method: "GET", results: "hits", title: "name", link: "href" };
	const empty = webTools({ fetch: (async () => reply({ hits: [] })) as typeof fetch, choice: () => nothing, run: () => run, connect: (service) => connected.push(service) })[2]!;
	assert.equal((await empty.execute(args, context())).ok, false);
	assert.equal(connected.length, 0);
	const urls: string[] = [];
	const good = webTools({ fetch: (async (url: string) => { urls.push(url); return reply({ hits: [{ name: "A", href: "https://a.example/" }] }); }) as typeof fetch, choice: () => nothing, run: () => run, connect: (service) => connected.push(service) })[2]!;
	assert.equal((await good.execute(args, context())).ok, true);
	assert.equal(connected[0]!.name, "Mine");
	assert.equal(connected[0]!.keyEnv, undefined);
	assert.equal(urls[0], "https://search.example/api?q=weather");
	assert.equal((await good.execute(args, context("deny"))).ok, false);
	const keyed = await good.execute({ ...args, headers: { "X-Key": "{key}" } }, context());
	assert.match(keyed.modelContent, /needs a key/);
});
