import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRequirements } from "../engine/extract.mjs";
import { batchSegments } from "../engine/segment.mjs";

const segment = (i, text = `要求${i}支持数据对接。`) => ({ id: `S${i}`, chapter: "第五章 采购需求", text, star: false, triangle: false });
const sourceSegments = (user) => [...user.matchAll(/^\[([^\]]+)\] (.*)$/gm)].map((match) => ({ seg_id: match[1], text: match[2], quote: match[2], category: "集成", priority: "必须", params: [] }));
const run = (doc, llm, onBatch) => extractRequirements({ doc, params: {}, inputType: "tender", llm, onBatch });

test("a numbered tender is bounded by both segment count and text size without losing its source", () => {
  const segments = Array.from({ length: 100 }, (_, i) => segment(i, "需要集成业务数据。".repeat(15)));
  segments.push(segment(100, "要求支持平台对接。".repeat(500)));
  const batches = batchSegments({ numbered: true, segments }, 18, 1000);
  assert.ok(batches.length > 10);
  assert.ok(batches.every((batch) => batch.length <= 18 && batch.reduce((sum, s) => sum + s.text.length, 0) <= 1000));
  for (const original of segments) assert.equal(batches.flat().filter((s) => s.id === original.id).map((s) => s.text).join(""), original.text);
});

test("chapter boundaries survive batching for numbered tenders", () => {
  const first = segment(1); const second = { ...segment(2), chapter: "第六章 合同" };
  assert.deepEqual(batchSegments({ numbered: true, segments: [first, second] }).map((batch) => batch.map((s) => s.id)), [["S1"], ["S2"]]);
});

test("extraction limits in-flight requests and preserves source order despite completion order", async () => {
  let active = 0; let peak = 0;
  const llm = { async json({ user }) {
    active += 1; peak = Math.max(peak, active);
    const requirements = sourceSegments(user);
    await new Promise((resolve) => setTimeout(resolve, requirements[0].seg_id === "S0" ? 15 : 1));
    active -= 1;
    return { requirements };
  } };
  const segments = Array.from({ length: 80 }, (_, i) => segment(i));
  const progress = [];
  const out = await run({ numbered: true, segments }, llm, (done, total) => progress.push([done, total]));
  assert.equal(peak, 3); assert.equal(active, 0);
  assert.deepEqual(out.requirements.map((r) => r.seg_id), segments.map((s) => s.id));
  assert.ok(out.requirements.every((r) => r.quoteVerified));
  assert.deepEqual(progress.at(-1), [5, 5]);
});

test("a failed batch stops new work and drains in-flight requests before the job fails", async () => {
  let calls = 0; let active = 0;
  const llm = { async json() {
    const index = calls++; active += 1;
    try {
      if (index === 0) throw new Error("gateway down");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { requirements: [] };
    } finally { active -= 1; }
  } };
  await assert.rejects(() => run({ numbered: true, segments: Array.from({ length: 100 }, (_, i) => segment(i)) }, llm), /gateway down/);
  assert.equal(calls, 3); assert.equal(active, 0);
});

test("truncated batches split adaptively and keep every quote mapped to the original segment", async () => {
  let calls = 0;
  const llm = { async json({ user }) {
    calls += 1;
    const requirements = sourceSegments(user);
    if (requirements.length > 1) throw Object.assign(new Error("output limit"), { code: "LLM_OUTPUT_LIMIT" });
    return { requirements };
  } };
  const out = await run({ numbered: true, segments: [segment(1), segment(2), segment(3)] }, llm);
  assert.equal(out.requirements.length, 3);
  assert.ok(out.requirements.every((r) => r.quoteVerified));
  assert.equal(calls, 5);
});

test("an invalid extraction shape cannot be silently accepted as zero requirements", async () => {
  await assert.rejects(() => run({ numbered: true, segments: [segment(1)] }, { json: async () => ({}) }), /requirements 必须为数组/);
});

test("a single long clause can shrink after truncation while retaining its original source ID", async () => {
  const original = segment(1, "要求支持平台数据对接。".repeat(80));
  const llm = { async json({ user }) {
    const requirements = sourceSegments(user);
    if (requirements.some((r) => r.text.length > 300)) throw Object.assign(new Error("output limit"), { code: "LLM_OUTPUT_LIMIT" });
    return { requirements };
  } };
  const out = await run({ numbered: true, segments: [original] }, llm);
  assert.ok(out.requirements.length > 1);
  assert.ok(out.requirements.every((r) => r.seg_id === original.id && r.quoteVerified));
  assert.equal(out.requirements.map((r) => r.quote).join(""), original.text);
});
