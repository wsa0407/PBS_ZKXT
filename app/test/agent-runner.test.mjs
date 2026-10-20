import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { resetDb, getDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { setAgentRuntimeFactory, createHarnessLlm } from "../server/agent-runner.mjs";
import { createCollaboration, runCollaboration } from "../server/collaboration.mjs";
import { activeJob, cancelJob, getJob, startJob } from "../server/jobs.mjs";

let id;
beforeEach(() => { resetDb(); id = repo.createProject({ name: "执行器测试" }).id; svc.addMaterial(id, { title: "巡查", text: "2.1.1 系统应支持夜间巡逻，发现异常后通知值班人员。" }); });
afterEach(() => setAgentRuntimeFactory(null));

test("role runtime receives validation errors and persists the corrected draft in its own session", async () => {
  setAgentRuntimeFactory(async o => {
    assert.equal(o.role, "materials"); o.onSession("test-session");
    const state = (await o.execute("project_state", {})).data;
    const source = (await o.execute("read_document_batch", { document_id: state.documents[0].document_id })).data.items[0];
    const args = { document_id: source.document_id, document_version: source.document_version, requirements: [{ evidence_id: source.evidence_id, text: "支持夜间巡逻", quote: "不存在的引用", category: "功能", priority: "重要" }] };
    assert.equal((await o.execute("submit_requirements", { ...args, operation_id: "bad" })).data.errors.length, 1);
    args.requirements[0].quote = "支持夜间巡逻";
    assert.equal((await o.execute("submit_requirements", { ...args, operation_id: "fixed" })).data.accepted.length, 1);
    return { finalResponse: "已保存待审需求。" };
  });
  const t = createCollaboration(id, { role: "materials", goal: "理解材料" });
  await runCollaboration(t.id);
  assert.equal(repo.listRequirements(id).length, 1);
  const run = getDb().prepare("SELECT * FROM agent_runs WHERE project_id=?").get(id);
  assert.equal(run.session_id, "test-session"); assert.notEqual(run.status, "running");
});

test("job cancellation waits for runtime cleanup before releasing the project lock", async () => {
  let entered; const ready = new Promise(r => { entered = r; }); let cleaned = false;
  setAgentRuntimeFactory(async o => {
    entered(); await new Promise(resolve => o.signal.addEventListener("abort", resolve, { once: true }));
    await new Promise(r => setTimeout(r, 10)); cleaned = true; throw new Error("runtime closed");
  });
  const t = createCollaboration(id, { role: "materials", goal: "分析材料" });
  const job = startJob({ projectId: id, kind: "collaboration", steps: ["执行"], run: ctx => runCollaboration(t.id, ctx) });
  await ready; cancelJob(job.id); assert.ok(activeJob(id)); await job.promise;
  assert.equal(cleaned, true); assert.equal(activeJob(id), null); assert.equal(getJob(job.id).status, "已取消");
});

test("runtime failures remain visible in the actual collaboration conversation", async () => {
  setAgentRuntimeFactory(async () => { throw new Error("runtime unavailable"); });
  const t = createCollaboration(id, { role: "materials", goal: "分析材料" });
  await assert.rejects(() => runCollaboration(t.id), /runtime unavailable/);
  const last = repo.listChat(id).at(-1);
  assert.equal(last.payload.error, true); assert.ok(last.content.includes("未完成"));
});

test("bounded analysis exposes only validated results and records runtime usage", async () => {
  const calls = [];
  setAgentRuntimeFactory(async o => {
    assert.deepEqual(o.tools.map(t => t.name), ["submit_result"]);
    assert.equal((await o.execute("submit_result", { result: {} })).ok, false);
    assert.equal((await o.execute("submit_result", { result: { summary: "明确的分析" } })).ok, true);
    o.onUsage({ model: "mock", promptTokens: 12, completionTokens: 5 }); return {};
  });
  const llm = createHarnessLlm({ model: "mock", onCall: c => calls.push(c) });
  const result = await llm.json({ step: "manual", system: "分析产品手册", user: "合成资料", validate: r => { if (!r.summary) throw new Error("缺少摘要"); } });
  assert.equal(result.summary, "明确的分析"); assert.equal(calls.length, 1); assert.equal(llm.usage.promptTokens, 12);
});
