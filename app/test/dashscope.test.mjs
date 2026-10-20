import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { embed, embeddingCacheKey, listEmbeddingModels } from "../server/embed.mjs";
import { resetDb } from "../server/db.mjs";
import * as rag from "../server/rag.mjs";
import { saveProduct } from "../server/repo.mjs";

const realFetch = globalThis.fetch;
const calls = [];
const vector = (text) => {
  const out = new Array(32).fill(0);
  for (const ch of text) out[ch.codePointAt(0) % 32] += 1;
  return out;
};
const fakeFetch = async (url, options) => {
  const body = JSON.parse(options.body);
  calls.push({ url, body, auth: options.headers.Authorization });
  return new Response(JSON.stringify({ output: { embeddings: body.input.texts.map((text, text_index) => ({ text_index, embedding: vector(text) })).reverse() } }), { status: 200 });
};
beforeEach(() => {
  globalThis.fetch = fakeFetch; calls.length = 0;
  process.env.EMBED_PROVIDER = "dashscope";
  process.env.EMBED_BASE_URL = "https://workspace.example.com/api/v1/";
  process.env.EMBED_MODEL = "qwen3.7-text-embedding";
  process.env.EMBED_API_KEY = "sk-test-dashscope";
  process.env.APP_EMBED = "on";
});
after(() => { globalThis.fetch = realFetch; });

test("DashScope uses the native endpoint, raw texts, role parameters and restored text_index order", async () => {
  const result = await embed(["热成像无人机", "巡检闭环平台"]);
  assert.equal(calls[0].url, "https://workspace.example.com/api/v1/services/embeddings/text-embedding/text-embedding");
  assert.equal(calls[0].auth, "Bearer sk-test-dashscope");
  assert.deepEqual(calls[0].body.input, { texts: ["热成像无人机", "巡检闭环平台"] });
  assert.deepEqual(calls[0].body.parameters, { text_type: "document", output_type: "dense" });
  assert.deepEqual(result, [vector("热成像无人机"), vector("巡检闭环平台")]);
  await embed(["夜间道路事故"], { query: true });
  assert.equal(calls[1].body.input.texts[0], "夜间道路事故");
  assert.equal(calls[1].body.parameters.text_type, "query");
  assert.match(calls[1].body.parameters.instruct, /retrieve product capabilities/);
  assert.ok(!Object.hasOwn(calls[1].body, "encoding_format"));
});

test("native full endpoint is accepted without appending another path or querying /models", async () => {
  process.env.EMBED_BASE_URL += "services/embeddings/text-embedding/text-embedding/";
  await embed(["测试"]);
  assert.equal(calls[0].url, process.env.EMBED_BASE_URL.slice(0, -1));
  assert.deepEqual(await listEmbeddingModels(), []); assert.equal(calls.length, 1);
  delete process.env.EMBED_BASE_URL;
  await assert.rejects(embed(["测试"]), /requires EMBED_BASE_URL/);
});

test("native batches honor model limits and retain cross-batch input order", async () => {
  const texts = Array.from({ length: 41 }, (_, i) => `产品文本${i}`);
  const out = await embed(texts);
  assert.deepEqual(calls.map((c) => c.body.input.texts.length), [20, 20, 1]);
  assert.deepEqual(out, texts.map(vector));
  process.env.EMBED_MODEL = "text-embedding-v4"; calls.length = 0;
  await embed(texts.slice(0, 21));
  assert.deepEqual(calls.map((c) => c.body.input.texts.length), [10, 10, 1]);
});

test("native response checks reject duplicate indexes, malformed vectors and mixed dimensions", async () => {
  const responses = [
    [{ text_index: 0, embedding: [1] }, { text_index: 0, embedding: [2] }],
    [{ text_index: 0, embedding: [null] }, { text_index: 1, embedding: [2] }],
    [{ text_index: 0, embedding: [1] }, { text_index: 1, embedding: [2, 3] }],
  ];
  for (const embeddings of responses) {
    globalThis.fetch = async () => new Response(JSON.stringify({ output: { embeddings } }), { status: 200 });
    await assert.rejects(embed(["甲", "乙"]), /invalid|dimensions/);
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "InvalidApiKey", message: "sensitive response must not be echoed" }), { status: 401 });
  await assert.rejects(embed(["甲"]), (e) => /401.*InvalidApiKey/.test(e.message) && !e.message.includes("sensitive"));
});

test("service configuration changes isolate vector caches and native hybrid retrieval reuses document vectors", async () => {
  const firstKey = embeddingCacheKey();
  process.env.EMBED_BASE_URL = "https://another.example.com/api/v1"; assert.notEqual(embeddingCacheKey(), firstKey);
  process.env.EMBED_BASE_URL = "https://workspace.example.com/api/v1/";
  resetDb(":memory:");
  rag.indexProduct(saveProduct(null, { name: "热成像无人机", unit: "架", summary: "夜间道路事故巡查", capabilities: ["热成像取证"], limits: [], xinchuang: "", metadata: {} }));
  assert.equal((await rag.probeEmbeddings()).kind, "hybrid");
  calls.length = 0;
  const [hits] = await rag.search(["夜间道路事故"], { topK: 3 });
  assert.ok(hits.some((h) => h.vector !== null));
  assert.ok(calls.some((c) => c.body.parameters.text_type === "document"));
  assert.ok(calls.some((c) => c.body.parameters.text_type === "query"));
  calls.length = 0; await rag.search(["夜间道路事故"], { topK: 3 });
  assert.equal(calls.length, 1); assert.equal(calls[0].body.parameters.text_type, "query");
  process.env.EMBED_BASE_URL = "https://another.example.com/api/v1";
  calls.length = 0; await rag.search(["夜间道路事故"], { topK: 3 });
  assert.ok(calls.some((c) => c.body.parameters.text_type === "document"), "new endpoint must not reuse vectors from old endpoint");
});

test("invalid input is refused before transmission and query dimension mismatches fall back to keyword search", async () => {
  await assert.rejects(embed([""]), /non-empty/); assert.equal(calls.length, 0);
  resetDb(":memory:");
  rag.indexProduct(saveProduct(null, { name: "无人机", unit: "架", summary: "道路事故巡检", capabilities: [], limits: [], xinchuang: "", metadata: {} }));
  await rag.probeEmbeddings();
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const size = body.parameters.text_type === "query" ? 2 : 3;
    return new Response(JSON.stringify({ output: { embeddings: body.input.texts.map((_, text_index) => ({ text_index, embedding: new Array(size).fill(1) })) } }), { status: 200 });
  };
  const [hits] = await rag.search(["道路事故巡检"], { topK: 2 });
  assert.equal(rag.retrievalMode().kind, "keyword"); assert.ok(hits.length);
  assert.match(rag.retrievalMode().reason, /dimensions/);
});
