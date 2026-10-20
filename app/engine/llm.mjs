import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chatCompletion } from "../lib/bai_client.mjs";

const cacheDir = new URL("../.cache/", import.meta.url);

export function appModel() {
  return process.env.APP_MODEL || "gpt-5.4-mini";
}

export function parseJson(text) {
  const stripped = String(text).replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(stripped.slice(start, end + 1));
}

/**
 * One client per job so usage numbers are not shared between concurrent jobs.
 * Cache is off by default: every action in the product is a real model call.
 * Set APP_LLM_CACHE=on to replay identical prompts (useful for rehearsed demos).
 */
export function createLlm({ model = appModel(), cache = process.env.APP_LLM_CACHE === "on", onCall = () => {} } = {}) {
  const usage = { calls: 0, cached: 0, promptTokens: 0, completionTokens: 0, steps: [] };

  async function json({ step, system, user, maxTokens = 8000 }) {
    const key = createHash("sha256").update(JSON.stringify({ model, system, user })).digest("hex").slice(0, 20);
    const file = new URL(`${step}-${key}.json`, cacheDir);
    if (cache && existsSync(file)) {
      usage.cached += 1;
      usage.steps.push({ step, cached: true, ms: 0 });
      onCall({ step, model, cached: true, ms: 0, promptTokens: 0, completionTokens: 0, ok: true });
      return JSON.parse(readFileSync(file, "utf8"));
    }

    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = Date.now();
      const result = await chatCompletion({ model, messages, maxTokens, temperature: 0.2 });
      const call = {
        step,
        model,
        cached: false,
        ms: Date.now() - started,
        promptTokens: result.usage.prompt_tokens ?? 0,
        completionTokens: result.usage.completion_tokens ?? 0,
      };
      usage.calls += 1;
      usage.promptTokens += call.promptTokens;
      usage.completionTokens += call.completionTokens;
      usage.steps.push({ step, cached: false, ms: call.ms, finish: result.finishReason });
      try {
        const data = parseJson(result.content);
        onCall({ ...call, ok: true });
        if (cache) {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
        }
        return data;
      } catch (error) {
        onCall({ ...call, ok: false });
        lastError = error;
        messages.push({ role: "assistant", content: result.content });
        messages.push({ role: "user", content: "上一次输出不是合法 JSON。请只输出一个完整的 JSON 对象，不要任何解释。" });
      }
    }
    throw new Error(`${step}: ${lastError.message}`);
  }

  return { model, usage, json };
}
