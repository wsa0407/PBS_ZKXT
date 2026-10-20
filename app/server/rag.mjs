import { createHash } from "node:crypto";
import { embed, embedModel, listEmbeddingModels } from "./embed.mjs";
import { normalize } from "../engine/text.mjs";
import { getDb, tx } from "./db.mjs";

/**
 * Retrieval over the product library, product manuals and past projects.
 * Hybrid = BM25 over Chinese bigrams + embedding cosine, fused with RRF.
 * Falls back to BM25 only when the embeddings endpoint is unavailable.
 */

const PRODUCT_KINDS = ["summary", "capability", "limit", "xinchuang", "manual"];
let mode = { kind: "keyword", model: null, reason: "尚未检测向量服务" };
let version = 0;
let index = null;

export { embedModel };
export const retrievalMode = () => mode;

export async function probeEmbeddings() {
  if (process.env.APP_EMBED === "off") {
    mode = { kind: "keyword", model: null, reason: "已通过 APP_EMBED=off 关闭向量检索" };
    return mode;
  }
  try {
    await embed(["连通性测试"]);
    mode = { kind: "hybrid", model: embedModel(), reason: "" };
  } catch (error) {
    const known = /model_not_found|Model not exist|404/i.test(String(error.message)) ? await listEmbeddingModels() : [];
    const hint = known.length ? `；该服务可用的向量模型：${known.join("、")}（请把 EMBED_MODEL 改成其中之一）` : "";
    mode = { kind: "keyword", model: null, reason: `向量服务不可用：${String(error.message).slice(0, 160)}${hint}` };
  }
  return mode;
}

export function setRetrievalMode(next) {
  mode = next;
}

// ---------- chunking & indexing ----------

const hashOf = (text) => createHash("sha1").update(text).digest("hex");

function insertChunk({ kind, productId = null, docId = null, historyId = null, text }) {
  getDb()
    .prepare("INSERT INTO chunks (kind, product_id, doc_id, history_id, text, hash) VALUES (?, ?, ?, ?, ?, ?)")
    .run(kind, productId, docId, historyId, text, hashOf(text));
}

// Retired chunks remain immutable evidence. Search only sees the current version.
function flagRetiredEvidence() {
  getDb().exec(`UPDATE pbs_items SET confirmed = 0, stale = '产品依据已变化或移除，请复核'
    WHERE id IN (SELECT i.id FROM pbs_items i, json_each(i.evidence_chunks) e
      JOIN chunks c ON c.id = CAST(e.value AS INTEGER) WHERE c.active = 0)`);
}

function syncChunks(where, args, chunks) {
  tx((db) => {
    const old = db.prepare(`SELECT * FROM chunks WHERE ${where}`).all(...args);
    db.prepare(`UPDATE chunks SET active = 0 WHERE ${where}`).run(...args);
    const used = new Set();
    for (const chunk of chunks) {
      const same = old.find((c) => !used.has(c.id) && c.kind === chunk.kind && c.text === chunk.text && c.product_id === (chunk.productId ?? null) && c.doc_id === (chunk.docId ?? null) && c.history_id === (chunk.historyId ?? null));
      if (same) {
        used.add(same.id);
        db.prepare('UPDATE chunks SET active = 1 WHERE id = ?').run(same.id);
      } else insertChunk(chunk);
    }
    flagRetiredEvidence();
  });
  version += 1;
}

export function indexProduct(product) {
  const chunks = [{ kind: 'summary', productId: product.id, text: `${product.name}：${product.summary || product.name}` }];
  for (const c of product.capabilities) chunks.push({ kind: 'capability', productId: product.id, text: `${product.name} 能力：${c}` });
  for (const l of product.limits) chunks.push({ kind: 'limit', productId: product.id, text: `${product.name} 限制：${l}` });
  if (product.xinchuang) chunks.push({ kind: 'xinchuang', productId: product.id, text: `${product.name} 信创适配：${product.xinchuang}` });
  syncChunks("product_id = ? AND kind != 'manual'", [product.id], chunks);
}

export function removeProductChunks(productId) {
  syncChunks('product_id = ?', [productId], []);
}

/** Split a manual into ~400-character chunks on paragraph boundaries; headings stay with their text. */
export function splitManual(text, size = 400) {
  const paragraphs = String(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n|\n(?=#)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length > size && !/^#/.test(current.split("\n").at(-1))) {
      chunks.push(current);
      current = "";
    }
    if (p.length > size * 1.5) {
      if (current) chunks.push(current);
      current = "";
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
      continue;
    }
    current = current ? `${current}\n${p}` : p;
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.replace(/^#+\s*/gm, "").trim()).filter((c) => c.length >= 10);
}

export function indexManual({ docId, productId, text }) {
  syncChunks('doc_id = ?', [docId], splitManual(text).map((text) => ({ kind: 'manual', productId, docId, text })));
}

export function removeManualChunks(docId) {
  syncChunks('doc_id = ?', [docId], []);
}

export function indexHistory(history) {
  const chunks = history.map((p) => {
    const lines = p.pbs.map((i) => `${i.name} ${i.qty}${i.unit}（${i.source}）`).join('；');
    return { kind: 'history', historyId: p.id, text: `${p.name}（${p.industry}，${p.year}）：${lines}。经验：${p.lessons}` };
  });
  syncChunks("kind = 'history'", [], chunks);
}

export function getChunks(ids) {
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(`SELECT c.*, d.name AS doc_name FROM chunks c LEFT JOIN product_docs d ON d.id = c.doc_id WHERE c.id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids);
  return rows;
}

// ---------- BM25 ----------

function tokens(text) {
  const clean = normalize(text).replace(/[,.;:()、。！？!?/|\-【】]/g, "");
  const out = [];
  for (let i = 0; i < clean.length - 1; i += 1) out.push(clean.slice(i, i + 2));
  for (const word of clean.match(/[a-z0-9]{2,}/g) ?? []) out.push(word);
  return out;
}

function buildIndex() {
  const chunks = getDb().prepare("SELECT c.*, d.name AS doc_name FROM chunks c LEFT JOIN product_docs d ON d.id = c.doc_id WHERE c.active = 1").all();
  const df = new Map();
  const docs = chunks.map((chunk) => {
    const tf = new Map();
    const list = tokens(chunk.text);
    for (const t of list) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { chunk, tf, len: list.length };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  return { version, docs, df, avg, n: docs.length };
}

function bm25(idx, query, allowed) {
  const k1 = 1.2;
  const b = 0.75;
  const q = [...new Set(tokens(query))];
  const scores = [];
  for (const d of idx.docs) {
    if (!allowed(d.chunk)) continue;
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (idx.n - idx.df.get(t) + 0.5) / (idx.df.get(t) + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / idx.avg));
    }
    if (s > 0) scores.push({ chunk: d.chunk, score: s });
  }
  return scores.sort((a, b2) => b2.score - a.score);
}

// ---------- vectors ----------

const toBlob = (vector) => new Uint8Array(Float32Array.from(vector).buffer);
const fromBlob = (blob) => new Float32Array(Uint8Array.from(blob).buffer);

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// text-embedding-v2 accepts at most 25 texts per request; stay under it.
const EMBED_BATCH = 20;

async function embedAll(texts, { query = false } = {}) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...(await embed(texts.slice(i, i + EMBED_BATCH), { query })));
  return out;
}

async function chunkVectors(chunks, model) {
  const db = getDb();
  const get = db.prepare("SELECT vector FROM embed_cache WHERE hash = ? AND model = ?");
  const vectors = new Map();
  const missing = [];
  for (const c of chunks) {
    const row = get.get(c.hash, model);
    if (row) vectors.set(c.id, fromBlob(row.vector));
    else missing.push(c);
  }
  if (missing.length) {
    const fresh = await embedAll(missing.map((c) => c.text));
    const put = db.prepare("INSERT OR REPLACE INTO embed_cache (hash, model, vector) VALUES (?, ?, ?)");
    missing.forEach((c, i) => {
      put.run(c.hash, model, toBlob(fresh[i]));
      vectors.set(c.id, Float32Array.from(fresh[i]));
    });
  }
  return vectors;
}

// ---------- search ----------

const RRF_K = 60;

/**
 * queries: string[]; returns one ranked hit list per query: [{ chunk, score, keyword, vector }].
 */
export async function search(queries, { kinds = PRODUCT_KINDS, topK = 8 } = {}) {
  if (!index || index.version !== version) index = buildIndex();
  const allowed = (chunk) => kinds.includes(chunk.kind);
  const keywordLists = queries.map((q) => bm25(index, q, allowed).slice(0, 30));

  let vectorLists = queries.map(() => []);
  if (mode.kind === "hybrid") {
    try {
      const pool = index.docs.map((d) => d.chunk).filter(allowed);
      const vectors = await chunkVectors(pool, mode.model);
      const qv = await embedAll(queries, { query: true });
      vectorLists = qv.map((v) =>
        pool
          .map((chunk) => ({ chunk, score: cosine(v, vectors.get(chunk.id)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 30),
      );
    } catch (error) {
      mode = { kind: "keyword", model: null, reason: `向量检索失败，已降级为关键词检索：${String(error.message).slice(0, 100)}` };
    }
  }

  return queries.map((_, qi) => {
    const fused = new Map();
    const addList = (list, key) =>
      list.forEach((hit, rank) => {
        const entry = fused.get(hit.chunk.id) ?? { chunk: hit.chunk, score: 0, keyword: null, vector: null };
        entry.score += 1 / (RRF_K + rank + 1);
        entry[key] = Math.round(hit.score * 1000) / 1000;
        fused.set(hit.chunk.id, entry);
      });
    addList(keywordLists[qi], "keyword");
    addList(vectorLists[qi], "vector");
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  });
}
