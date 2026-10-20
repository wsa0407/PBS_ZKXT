import { embeddings as gatewayEmbeddings } from "../lib/bai_client.mjs";

/**
 * Embedding client, kept separate from the chat client because the chat gateway may not expose
 * /embeddings. Configure with EMBED_BASE_URL (+ EMBED_API_KEY) for any OpenAI-compatible service
 * (SiliconFlow, vLLM, TEI, Ollama ...). Without EMBED_BASE_URL it falls back to the chat gateway.
 */

export const embedModel = () => process.env.EMBED_MODEL || "text-embedding-3-small";
const baseUrl = () => (process.env.EMBED_BASE_URL || "").trim().replace(/\/$/, "");

const QWEN_TASK = "Given a customer requirement for a solution, retrieve product capabilities, limitations and manual passages that satisfy or conflict with it";

/** Qwen3-Embedding is instruction-aware: queries carry a task prompt, documents do not. */
export function formatQuery(text, model = embedModel()) {
  return /qwen3-embedding/i.test(model) ? `Instruct: ${QWEN_TASK}\nQuery: ${text}` : text;
}

/** Best-effort: ask the service which models it offers, to make a wrong EMBED_MODEL easy to fix. */
export async function listEmbeddingModels() {
  const url = baseUrl();
  if (!url) return [];
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

export async function embed(texts, { query = false } = {}) {
  const model = embedModel();
  const input = query ? texts.map((t) => formatQuery(t, model)) : texts;
  const url = baseUrl();
  if (!url) return gatewayEmbeddings({ input, model });

  const res = await fetch(`${url}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.EMBED_API_KEY || ""}` },
    body: JSON.stringify({ model, input, encoding_format: "float" }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Embedding HTTP ${res.status}: ${body.slice(0, 200)}`);
  const rows = [...(JSON.parse(body).data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== input.length || !rows.every((r) => Array.isArray(r.embedding))) {
    throw new Error("Embedding response does not match the request");
  }
  return rows.map((r) => r.embedding);
}
