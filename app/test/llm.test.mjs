import assert from "node:assert/strict";
import { test } from "node:test";
import { createLlm } from "../engine/llm.mjs";

const request = { step: "extract", system: "Return JSON", user: "A requirement", maxTokens: 6000 };
const result = (content, finishReason = "stop") => ({ content, finishReason, usage: { prompt_tokens: 10, completion_tokens: 20 } });

test("structured calls enable JSON mode and validate the returned shape before accepting it", async () => {
  const calls = [];
  const responses = [result('{}'), result('{"requirements":[]}')];
  const llm = createLlm({ cache: false, onCall: (call) => calls.push(call), completion: async (options) => {
    assert.equal(options.jsonMode, true);
    return responses.shift();
  } });
  const data = await llm.json({ ...request, validate: (data) => {
    if (!Array.isArray(data.requirements)) throw new Error("missing requirements");
  } });
  assert.deepEqual(data, { requirements: [] });
  assert.deepEqual(calls.map((call) => call.ok), [false, true]);
  assert.equal(llm.usage.calls, 2);
});

test("truncated JSON is rejected even when its visible prefix happens to parse", async () => {
  let count = 0;
  const calls = [];
  const llm = createLlm({ cache: false, onCall: (call) => calls.push(call), completion: async () => {
    count += 1;
    return result('{"requirements":[]}', "length");
  } });
  await assert.rejects(() => llm.json(request), (error) => error.code === "LLM_OUTPUT_LIMIT" && /6000/.test(error.message));
  assert.equal(count, 1, "the caller can split the input instead of repeating the same oversized request");
  assert.equal(calls[0].finishReason, "length");
  assert.equal(calls[0].ok, false);
});

test("empty final answers produce a clear bounded error and never use reasoning as business data", async () => {
  let count = 0;
  const llm = createLlm({ cache: false, completion: async () => {
    count += 1;
    return { ...result(""), reasoningTokens: 6000 };
  } });
  await assert.rejects(() => llm.json(request), (error) => error.code === "LLM_INVALID_JSON" && /完整 JSON/.test(error.message));
  assert.equal(count, 2);
});

test("refusals do not retry or get interpreted as extraction results", async () => {
  let count = 0;
  const llm = createLlm({ cache: false, completion: async () => { count += 1; return result("", "content_filter"); } });
  await assert.rejects(() => llm.json(request), (error) => error.code === "LLM_REFUSAL");
  assert.equal(count, 1);
});
