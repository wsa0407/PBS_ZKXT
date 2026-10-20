import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { resetDb, getDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { runAgent, setAgentRuntimeFactory } from "../server/agent-runner.mjs";
import { activeJob, cancelJob, getJob, startJob } from "../server/jobs.mjs";
import { agentChatTurn } from "../server/agent-chat.mjs";

let id;
beforeEach(() => {
  resetDb();
  id = repo.createProject({ name: "执行器测试" }).id;
  svc.addMaterial(id, { kind: "tender", title: "巡查", text: "2.1.1 系统应支持夜间巡逻，发现异常后通知值班人员。" });
});
afterEach(() => setAgentRuntimeFactory(null));

test("the primary Agent runner feeds real business validation failures back before saving corrected drafts", async () => {
  const calls = [];
  setAgentRuntimeFactory(async (options, run) => {
    options.onSession("test-session");
    const execute = async (name, args) => {
      const result = await options.execute(name, args);
      options.onTool?.({ name, ok: result.ok, result, ms: 1 }); calls.push(name); return result;
    };
    return run({ session: { async run() {
      const state = (await execute("project_state", {})).data;
      const doc = state.documents[0];
      const source = (await execute("read_document_batch", { document_id: doc.document_id })).data.items.find((s) => s.text.includes("支持夜间"));
      const args = { document_id: doc.document_id, document_version: doc.document_version, requirements: [{ evidence_id: source.evidence_id, text: "支持夜间巡逻", quote: "不存在的引用", category: "功能", priority: "重要" }] };
      const bad = await execute("submit_requirements", { ...args, operation_id: "bad" });
      assert.equal(bad.data.errors.length, 1);
      args.requirements[0].quote = "支持夜间巡逻";
      const good = await execute("submit_requirements", { ...args, operation_id: "fixed" });
      assert.equal(good.data.accepted.length, 1);
      await execute("finish_task", { summary: "已保存待审需求" });
      return { sessionId: "test-session", finalResponse: "已保存待审需求", events: [] };
    } } });
  });
  const result = await runAgent(id, "提取材料需求");
  assert.ok(calls.filter((n) => n === "submit_requirements").length === 2);
  assert.equal(result.sessionId, "test-session");
  assert.equal(repo.listRequirements(id).length, 1);
  const run = getDb().prepare("SELECT * FROM agent_runs WHERE id=?").get(result.runId);
  assert.equal(run.session_id, "test-session");
  assert.notEqual(run.status, "running");
});

test("job cancellation waits for runtime cleanup before releasing the project lock", async () => {
  let entered; const ready = new Promise((r) => { entered = r; });
  let cleaned = false;
  setAgentRuntimeFactory(async (options) => {
    entered();
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    await new Promise((r) => setTimeout(r, 10));
    cleaned = true; throw new Error("runtime closed");
  });
  const job = startJob({ projectId: id, kind: "agent", steps: ["执行"], run: (ctx) => runAgent(id, "分析材料", ctx) });
  await ready;
  cancelJob(job.id);
  assert.ok(activeJob(id));
  await job.promise;
  assert.equal(cleaned, true);
  assert.equal(activeJob(id), null);
  assert.equal(getJob(job.id).status, "已取消");
});

test("failed Agent chat work remains visible in persisted conversation history", async () => {
  setAgentRuntimeFactory(async () => { throw new Error("runtime unavailable"); });
  await assert.rejects(() => agentChatTurn(id, { text: "分析材料" }, {}), /runtime unavailable/);
  const last = repo.listChat(id).at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.payload.error, true);
  assert.ok(last.content.includes("未完成"));
});
