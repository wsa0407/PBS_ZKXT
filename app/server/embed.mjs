import { createHash } from "node:crypto";
import { embeddings as gatewayEmbeddings } from "../lib/bai_client.mjs";

// Embedding credentials and protocol are independent of the chat gateway.
export const embedModel = () => process.env.EMBED_MODEL || "text-embedding-3-small";
const baseUrl = () => (process.env.EMBED_BASE_URL || "").trim().replace(/\/+$/, "");
const provider = () => {
  const value = (process.env.EMBED_PROVIDER || "openai").trim().toLowerCase();
  if (!["openai", "dashscope"].includes(value)) throw new Error("EMBED_PROVIDER must be openai or dashscope");
  return value;
};
const NATIVE_PATH = "/services/embeddings/text-embedding/text-embedding";
const QWEN_TASK = "Given a customer requirement for a solution, retrieve product capabilities, limitations and manual passages that satisfy or conflict with it";

/** OpenAI-compatible Qwen3 endpoints use the instruction prefix. Native DashScope uses parameters. */
export function formatQuery(text, model = embedModel()) {
  return /qwen3-embedding/i.test(model) ? `Instruct: ${QWEN_TASK}\nQuery: ${text}` : text;
}

function endpoint() {
  const base = baseUrl();
  if (provider() === "dashscope") {
    if (!base) throw new Error("DashScope requires EMBED_BASE_URL");
    return base.endsWith(NATIVE_PATH) ? base : base + NATIVE_PATH;
  }
  return `${base || (process.env.BAI_BASE_URL || "https://api.b.ai/v1").replace(/\/+$/, "")}/embeddings`;
}

// Changing service, model or document encoding must not reuse vectors from another space.
export function embeddingCacheKey() {
  const config = { provider: provider(), endpoint: endpoint(), model: embedModel(), document_encoding: provider() === "dashscope" ? "dense/document/v1" : "float/v1" };
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/** Native DashScope has no model-list API at this endpoint; never append /models to it. */
export async function listEmbeddingModels() {
  const url = baseUrl();
  if (!url || provider() === "dashscope") return [];
  try {
    const res = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${process.env.EMBED_API_KEY || ""}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const ids = ((await res.json()).data ?? []).map((m) => m.id).filter(Boolean);
    const embedding = ids.filter((id) => /embed/i.test(id));
    return embedding.length ? embedding : ids.slice(0, 20);
  } catch {
    return [];
  }
}

function orderedVectors(rows, count, indexField) {
  if (!Array.isArray(rows) || rows.length !== count) throw new Error("Embedding response does not match the request");
  const out = new Array(count);
  for (const row of rows) {
    const index = row?.[indexField];
    const v = row?.embedding;
    if (!Number.isInteger(index) || index < 0 || index >= count || out[index] || !Array.isArray(v) || !v.length || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Error("Embedding response contains invalid vectors or text indexes");
    }
    out[index] = v;
  }
  if (!out.every((v) => v.length === out[0].length)) throw new Error("Embedding response dimensions do not match");
  return out;
}

async function embedBatch(texts, query) {
  const model = embedModel();
  const native = provider() === "dashscope";
  const input = query && !native ? texts.map((t) => formatQuery(t, model)) : texts;
  if (!baseUrl() && !native) return gatewayEmbeddings({ input, model });
  const parameters = { text_type: query ? "query" : "document", output_type: "dense" };
  if (query && /^(qwen3\.7-text-embedding|text-embedding-v4)$/i.test(model)) parameters.instruct = QWEN_TASK;
  const body = native ? { model, input: { texts: input }, parameters } : { model, input, encoding_format: "float" };
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.EMBED_API_KEY || ""}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await res.json().catch(() => null);
  const code = typeof payload?.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(payload.code) ? payload.code : "";
  // Keep provider bodies out of errors: they may echo credentials or submitted documents.
  if (!res.ok || code) throw new Error(`Embedding HTTP ${res.status}${code ? ` (${code})` : ""}`);
  return orderedVectors(native ? payload?.output?.embeddings : payload?.data, texts.length, native ? "text_index" : "index");
}

export async function embed(texts, { query = false } = {}) {
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string" || !t.trim())) throw new Error("Embedding inputs must be non-empty text strings");
  if (!texts.length) return [];
  // qwen3.7 supports 20 texts; other native text-embedding models support 10.
  const batchSize = provider() === "dashscope" && !/^qwen3\.7-text-embedding$/i.test(embedModel()) ? 10 : 20;
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) out.push(...await embedBatch(texts.slice(i, i + batchSize), query));
  if (!out.every((v) => v.length === out[0].length)) throw new Error("Embedding batch dimensions do not match");
  return out;
}
