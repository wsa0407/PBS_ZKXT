import { listModels } from "../lib/bai_client.mjs";
import { getDb } from "./db.mjs";
import { badRequest } from "./errors.mjs";

const appModel = () => process.env.APP_MODEL || "gpt-5.4-mini";

/**
 * Which chat model the app uses. The choice is stored in the database so it survives restarts and
 * applies to every job (chat, extraction, PBS, answers ...). The list comes from the B.AI gateway.
 */

const TTL = 5 * 60 * 1000;
const FAILURE_TTL = 30 * 1000;
let cache = { at: 0, ids: [], error: null };
let fetchModels = listModels;
let pending = null;

/** Tests inject a fake gateway listing (and clear the cache) so they never touch the network. */
export function setModelSource(fn) {
  fetchModels = fn ?? listModels;
  cache = { at: 0, ids: [], error: null };
  pending = null;
}

export function selectedModel() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'chat_model'").get();
  return row?.value || appModel();
}

// Non-chat models share the same listing; keep them reachable but out of the main group.
const NON_CHAT = /embed|whisper|tts|dall-e|image|moderation|rerank|stable-diffusion|sora|video|audio/i;

export function groupOf(id) {
  if (NON_CHAT.test(id)) return "其他（非对话模型）";
  if (/^(gpt|o\d|chatgpt)/i.test(id)) return "OpenAI";
  if (/claude/i.test(id)) return "Anthropic";
  if (/gemini|gemma/i.test(id)) return "Google";
  if (/deepseek/i.test(id)) return "DeepSeek";
  if (/qwen|qwq/i.test(id)) return "通义千问";
  if (/glm|zhipu/i.test(id)) return "智谱";
  if (/kimi|moonshot/i.test(id)) return "Moonshot";
  if (/llama|mistral|mixtral|grok|doubao|ernie|hunyuan|minimax/i.test(id)) return "其他对话模型";
  return "其他对话模型";
}

export async function availableModels({ refresh = false } = {}) {
  const fresh = cache.at && Date.now() - cache.at < (cache.error ? FAILURE_TTL : TTL);
  if (!refresh && fresh) return { ids: cache.ids, cached: true, error: cache.error };
  if (pending) return pending;
  pending = Promise.resolve().then(async () => {
    try {
      const ids = [...new Set(await fetchModels())].sort((a, b) => a.localeCompare(b));
      cache = { at: Date.now(), ids, error: null };
      return { ids, cached: false, error: null };
    } catch (error) {
      // Keep the last good list, and avoid retrying on every selection after an outage.
      cache = { ...cache, at: Date.now(), error: String(error.message).slice(0, 200) };
      return { ids: cache.ids, cached: true, error: cache.error };
    }
  }).finally(() => { pending = null; });
  return pending;
}

export async function modelCatalog(options) {
  const { ids, cached, error } = await availableModels(options);
  const current = selectedModel();
  const all = ids.includes(current) ? ids : [current, ...ids];
  const groups = new Map();
  for (const id of all) {
    const g = groupOf(id);
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const order = ["OpenAI", "Anthropic", "Google", "DeepSeek", "通义千问", "智谱", "Moonshot", "其他对话模型", "其他（非对话模型）"];
  return {
    current,
    default: appModel(),
    cached,
    error,
    unlisted: !ids.includes(current),
    groups: order.filter((g) => groups.has(g)).map((g) => ({ label: g, models: groups.get(g) })),
  };
}

export async function chooseModel(id) {
  const model = String(id ?? "").trim();
  if (!model) throw badRequest("请选择模型");
  const { ids, error } = await availableModels();
  // When the gateway list is unavailable we cannot verify; allow it and let the first call report problems.
  if (!error && ids.length && !ids.includes(model)) throw badRequest(`B.AI 的模型列表里没有「${model}」`);
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('chat_model', ?)").run(model);
  return { current: model, unverified: Boolean(error) };
}

export function resetModel() {
  getDb().prepare("DELETE FROM settings WHERE key = 'chat_model'").run();
  return { current: appModel() };
}
