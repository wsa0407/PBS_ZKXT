import assert from "node:assert/strict";
import { after, test } from "node:test";
import { resetDb } from "../server/db.mjs";
import { embed, formatQuery } from "../server/embed.mjs";
import * as rag from "../server/rag.mjs";
import * as svc from "../server/services.mjs";

// A fake OpenAI-compatible embeddings endpoint. It answers in reverse order on purpose.
const calls = [];
const realFetch = globalThis.fetch;
const vec = (text) => {
  const v = new Array(32).fill(0);
  for (const ch of text) v[ch.codePointAt(0) % 32] += 1;
  return v;
};
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, auth: init.headers.Authorization, body });
  const data = body.input.map((t, index) => ({ index, embedding: vec(t) })).reverse();
  return new Response(JSON.stringify({ data }), { status: 200 });
};
after(() => (globalThis.fetch = realFetch));

process.env.EMBED_BASE_URL = "https://embed.example.com/v1/";
process.env.EMBED_API_KEY = "sk-test";
process.env.EMBED_MODEL = "Qwen/Qwen3-Embedding-8B";

test("Qwen3-Embedding queries carry the task instruction; other models do not", () => {
  assert.match(formatQuery("夜间巡逻", "Qwen/Qwen3-Embedding-8B"), /^Instruct: .*\nQuery: 夜间巡逻$/s);
  assert.equal(formatQuery("夜间巡逻", "text-embedding-3-small"), "夜间巡逻");
});

test("embed posts to EMBED_BASE_URL with the key and keeps input order", async () => {
  calls.length = 0;
  const out = await embed(["甲乙", "丙丁戊"]);
  assert.equal(calls[0].url, "https://embed.example.com/v1/embeddings");
  assert.equal(calls[0].auth, "Bearer sk-test");
  assert.equal(calls[0].body.model, "Qwen/Qwen3-Embedding-8B");
  assert.deepEqual(out[0], vec("甲乙"), "response was reversed by the server; order must be restored");
  assert.deepEqual(out[1], vec("丙丁戊"));

  calls.length = 0;
  await embed(["夜间巡逻"], { query: true });
  assert.match(calls[0].body.input[0], /^Instruct: /);
});

test("hybrid retrieval: probe succeeds, vectors are cached, only queries are re-embedded", async () => {
  resetDb(":memory:");
  svc.rebuildIndex();
  const mode = await rag.probeEmbeddings();
  assert.equal(mode.kind, "hybrid");
  assert.equal(mode.model, "Qwen/Qwen3-Embedding-8B");

  calls.length = 0;
  const [first] = await rag.search(["夜间能发现路面上的事故"], { topK: 5 });
  assert.ok(first.length);
  assert.ok(first.some((h) => h.vector !== null), "vector scores present");
  assert.ok(first.some((h) => h.keyword !== null || h.vector !== null));
  const docCalls = calls.filter((c) => !c.body.input[0].startsWith("Instruct:"));
  assert.ok(docCalls.length >= 1, "chunks were embedded once");

  calls.length = 0;
  await rag.search(["夜间能发现路面上的事故"], { topK: 5 });
  assert.equal(calls.length, 1, "second search embeds only the query");
  assert.match(calls[0].body.input[0], /^Instruct: /);
});

test("a failing embedding service degrades to keyword search instead of breaking", async () => {
  const ok = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
  try {
    const mode = await rag.probeEmbeddings();
    assert.equal(mode.kind, "keyword");
    assert.match(mode.reason, /403/);
    const [hits] = await rag.search(["无人机自动机场"], { topK: 3 });
    assert.ok(hits.length, "keyword retrieval still works");
  } finally {
    globalThis.fetch = ok;
  }
});
