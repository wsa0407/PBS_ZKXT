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

export class LlmOutputError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
  }
}

/**
 * One client per job so usage numbers are not shared between concurrent jobs.
 * Cache is off by default: every action in the product is a real model call.
 * Set APP_LLM_CACHE=on to replay identical prompts (useful for rehearsed demos).
 */
export function createLlm({ model = appModel(), cache = process.env.APP_LLM_CACHE === "on", onCall = () => {}, completion = chatCompletion } = {}) {
  const usage = { calls: 0, cached: 0, promptTokens: 0, completionTokens: 0, steps: [] };

  async function json({ step, system, user, maxTokens = 8000, validate = () => {} }) {
    const key = createHash("sha256").update(JSON.stringify({ version: 2, model, system, user, maxTokens })).digest("hex").slice(0, 20);
    const file = new URL(`${step}-${key}.json`, cacheDir);
    if (cache && existsSync(file)) {
      usage.cached += 1;
      usage.steps.push({ step, cached: true, ms: 0 });
      onCall({ step, model, cached: true, ms: 0, promptTokens: 0, completionTokens: 0, ok: true });
      const data = JSON.parse(readFileSync(file, "utf8"));
      validate(data);
      return data;
    }

    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = Date.now();
      const result = await completion({ model, messages, maxTokens, temperature: 0.2, jsonMode: true });
      const call = {
        step,
        model,
        cached: false,
        ms: Date.now() - started,
        promptTokens: result.usage.prompt_tokens ?? 0,
        completionTokens: result.usage.completion_tokens ?? 0,
        finishReason: result.finishReason,
        reasoningTokens: result.reasoningTokens ?? 0,
      };
      usage.calls += 1;
      usage.promptTokens += call.promptTokens;
      usage.completionTokens += call.completionTokens;
      usage.steps.push({ step, cached: false, ms: call.ms, finish: result.finishReason });
      if (result.finishReason === "length") {
        onCall({ ...call, ok: false });
        // The extractor will split this batch; repeating an identical request cannot fix truncation.
        throw new LlmOutputError(`${step}：模型输出达到 ${maxTokens} token 上限，结果不完整`, "LLM_OUTPUT_LIMIT");
      }
      if (result.finishReason === "content_filter" || result.finishReason === "refusal") {
        onCall({ ...call, ok: false });
        throw new LlmOutputError(`${step}：模型未能处理这段材料，未返回可用结果`, "LLM_REFUSAL");
      }
      try {
        const data = parseJson(result.content);
        validate(data);
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
        messages.push({ role: "user", content: "上一次输出不是合法 JSON 或不符合指定结构。请严格按要求只输出一个完整的 JSON 对象，不要任何解释。" });
      }
    }
    throw new LlmOutputError(`${step}：模型未返回符合要求的完整 JSON，已重试，请重新执行`, "LLM_INVALID_JSON", { cause: lastError });
  }

  return { model, usage, json };
}
