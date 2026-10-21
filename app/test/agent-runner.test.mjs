import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { resetDb, getDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { setAgentRuntimeFactory, createHarnessLlm } from "../server/agent-runner.mjs";
import { createCollaboration, runCollaboration } from "../server/collaboration.mjs";
import { activeJob, cancelJob, getJob, startJob } from "../server/jobs.mjs";
import { budgetExceeded, runBudget } from "../server/agent-budget.mjs";
import * as store from "../server/collaboration-store.mjs";
import { approval, approvalPreview, approveUnderstanding } from "../server/collaboration-approval.mjs";
import { collaborationAdapter } from "../server/collaboration-tools.mjs";
import { editDisposition } from "../server/scenarios.mjs";

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

test("budgets distinguish cumulative usage, steps and elapsed time", () => {
  let time = 0;
  const options = { maxTokens: 100, maxSteps: 2, timeoutMs: 60000, clock: () => time };
  const budget = runBudget(options);
  assert.equal(budget.recordUsage({ promptTokens: 40, completionTokens: 5 }), null);
  const error = budget.recordUsage({ promptTokens: 50, completionTokens: 10 });
  assert.equal(error.code, "AGENT_TOKENS_LIMIT");
  assert.deepEqual(error.budget, { scope: "agent", resource: "tokens", used: 105, limit: 100 });
  const steps = runBudget(options);
  assert.equal(steps.startStep(), null); assert.equal(steps.startStep(), null);
  assert.equal(steps.startStep().code, "AGENT_STEPS_LIMIT");
  time = 60000;
  assert.equal(runBudget({ ...options, clock: () => 0 }).check(), null);
  assert.equal(budget.check().code, "AGENT_TIME_LIMIT");
});

test("token recovery starts fresh after cleanup, keeps idempotency, and permits only one automatic continuation", async () => {
  let turns = 0, closed = false;
  const t = createCollaboration(id, { role: "materials", goal: "理解材料" });
  setAgentRuntimeFactory(async o => {
    turns++;
    assert.equal(o.sessionId, undefined);
    if (turns > 1) { assert.ok(closed); assert.match(o.goal, /只处理剩余工作/); }
    o.onSession(`fresh-${turns}`);
    // Repeating an operation in the same activation must return the original result.
    const questions = n => ({ operation_id: `question-${n}`, questions: [{ question: `测试缺口${n}`, reason: "测试影响", impact: "影响方案" }] });
    assert.equal((await o.execute("submit_questions", questions(1))).ok, true);
    if (turns === 2) assert.equal((await o.execute("submit_questions", questions(2))).ok, true);
    o.onUsage({ model: "mock", promptTokens: 1000000, completionTokens: 10 });
    closed = true;
    throw budgetExceeded("agent", "tokens", 1000010, 1000000);
  });
  await assert.rejects(() => runCollaboration(t.id), e => e.code === "AGENT_TOKENS_LIMIT");
  assert.equal(turns, 2);
  assert.equal(repo.listQuestions(id).length, 2);
  const runs = getDb().prepare("SELECT stats,session_id FROM agent_runs WHERE project_id=? ORDER BY rowid").all(id);
  assert.deepEqual(runs.map(r => r.session_id), ["fresh-1", "fresh-2"]);
  assert.equal(new Set(runs.map(r => JSON.parse(r.stats).launchId)).size, 1);
  assert.equal(new Set(runs.map(r => JSON.parse(r.stats).activationId)).size, 1);
  assert.equal(store.nextActivation(t.id).input.recovery.fresh_session, true);
  const failure = repo.listChat(id).at(-1);
  assert.match(failure.content, /累计 token/);
  assert.equal(failure.payload.budget.used, 1000010);
});

test("shared budget stops continuation; explicit resume retains usage history and rechecks PBS approval", async () => {
  const savedLimit = process.env.APP_COLLABORATION_MAX_TOKENS;
  process.env.APP_COLLABORATION_MAX_TOKENS = "100";
  try {
    const req = svc.addRequirement(id, { text: "夜间巡查" });
    const approved = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [req] });
    const t = createCollaboration(id, { role: "pbs", goal: "编制PBS", approvalId: approved.id });
    let turns = 0;
    setAgentRuntimeFactory(async o => {
      turns++;
      o.onSession(`session-${turns}`);
      if (turns === 1) {
        o.onUsage({ model: "mock", promptTokens: 100, completionTokens: 1 });
        o.signal.throwIfAborted();
      }
      assert.equal(o.sessionId, undefined);
      assert.equal((await o.execute("collaboration_state", {})).data.confirmation.id, approved.id);
      o.onUsage({ model: "mock", promptTokens: 10, completionTokens: 1 });
      return { finalResponse: "已核对当前草稿。" };
    });
    await assert.rejects(() => runCollaboration(t.id), e => e.code === "COLLABORATION_TOKENS_LIMIT");
    assert.equal(turns, 1);
    await runCollaboration(t.id); // An explicit new launch, not an internal retry.
    assert.equal(turns, 2);
    const stats = getDb().prepare("SELECT stats FROM agent_runs WHERE project_id=?").all(id).map(r => JSON.parse(r.stats));
    assert.equal(new Set(stats.map(s => s.launchId)).size, 2);
    assert.equal(stats.reduce((sum, s) => sum + s.tokens, 0), 112);
    // A persisted recovery marker never grants permission to execute after human edits.
    store.enqueue(store.task(t.id), "pbs", "main", { recovery: { fresh_session: true } });
    svc.editRequirement(id, req, { text: "新的巡查范围" });
    await runCollaboration(t.id);
    assert.equal(turns, 2);
    assert.equal(store.task(t.id).status, "awaiting_confirmation");
  } finally {
    if (savedLimit === undefined) delete process.env.APP_COLLABORATION_MAX_TOKENS;
    else process.env.APP_COLLABORATION_MAX_TOKENS = savedLimit;
  }
});

test("model receives the complete approved scope index without mutating its evidence snapshot", async () => {
  const req = svc.addRequirement(id, { text: "夜间巡查", category: "功能" });
  editDisposition(id, req, { revision: 0, req_revision: repo.getRequirement(id, req).revision, kinds: ["跨场景约束"], scenario_ids: [], note: "适用于全部场景" });
  const approved = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [req] });
  const original = approval(approved.id, id);
  const t = createCollaboration(id, { role: "pbs", goal: "核对", approvalId: approved.id });
  const adapter = collaborationAdapter(t, store.nextActivation(t.id));
  const state = (await adapter.execute("collaboration_state", {})).data;
  const snapshot = state.confirmation.snapshot;
  assert.equal(snapshot.projection, "scope_index");
  assert.deepEqual(snapshot.requirements.map(r => r.code), [req]);
  assert.equal(snapshot.requirements[0].text, undefined);
  assert.deepEqual(snapshot.dispositions, [{ req_id: req, kinds: ["跨场景约束"], scenario_ids: [], note: "适用于全部场景" }]);
  assert.match(snapshot.read_details, /list_requirements/);
  assert.equal((await adapter.execute("list_requirements", {})).data.items[0].text, "夜间巡查");
  assert.deepEqual(approval(approved.id, id), original);
});
