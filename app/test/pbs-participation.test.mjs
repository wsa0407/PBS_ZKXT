import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getDb, resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as store from "../server/collaboration-store.mjs";
import * as conversation from "../server/conversation-store.mjs";
import { approvalPreview, approveUnderstanding, pbsParticipation } from "../server/collaboration-approval.mjs";
import { collaborationAdapter } from "../server/collaboration-tools.mjs";
import { createCollaboration, receiveIntervention, receiveMessage, runCollaboration } from "../server/collaboration.mjs";
import { setAgentRuntimeFactory } from "../server/agent-runner.mjs";

let id, code;
beforeEach(() => {
  resetDb();
  id = repo.createProject({ name: "PBS 参与边界" }).id;
  code = svc.addRequirement(id, { text: "夜间巡查，异常推送现有系统" });
});
afterEach(() => setAgentRuntimeFactory(null));
const ok = async (execute, name, args = {}) => {
  const result = await execute(name, args);
  assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  return result.data;
};
const question = { question: "接口协议是否已确定？", reason: "尚未提供接口说明", impact: "影响方案" };
function runtime(fn) {
  setAgentRuntimeFactory(async o => {
    const state = await ok(o.execute, "collaboration_state");
    await fn(o, state);
    return { finalResponse: "已答复当前问题。" };
  });
}

test("confirmed requirement rows do not authorize PBS writes without human scope approval", async () => {
  svc.confirmRequirements(id, [code]);
  const t = createCollaboration(id, { role: "pbs", goal: "编制 PBS" });
  const adapter = collaborationAdapter(t, store.nextActivation(t.id));
  const state = await ok(adapter.execute, "collaboration_state");
  assert.equal(state.pbs_participation.can_discuss, true);
  assert.equal(state.pbs_participation.can_execute, false);
  assert.equal(state.confirmation, null);
  for (const name of ["submit_pbs", "submit_solutions", "submit_questions", "propose_change", "request_confirmation"]) {
    assert.ok(!adapter.tools.some(tool => tool.name === name), name);
    assert.equal((await adapter.execute(name, {})).error.code, "ROLE_PERMISSION");
  }
  await ok(adapter.execute, "project_state");
  assert.ok(adapter.tools.some(tool => tool.name === "ask_expert"));
  assert.equal(repo.listQuestions(id).length, 0);
});

test("unconfirmed PBS cannot claim broadcast execution while understanding work proceeds", async () => {
  const turns = [];
  runtime(async (o, s) => {
    turns.push([o.role, s.activation_mode]);
    if (s.activation_mode === "claim") {
      const args = { operation_id: "claim", message_id: s.message.id, decision: "claim", scope: "整理成果", work_mode: "main" };
      if (o.role === "pbs") {
        const rejected = await o.execute("respond_to_message", args);
        assert.equal(rejected.ok, false);
        assert.match(rejected.error.message, /人工确认/);
      }
      await ok(o.execute, "respond_to_message", o.role === "understanding" ? args : { operation_id: "pass", message_id: s.message.id, decision: "pass" });
    } else {
      assert.equal(o.role, "understanding");
      const input = (await ok(o.execute, "read_interventions")).messages[0];
      await ok(o.execute, "submit_questions", { operation_id: "question", questions: [question] });
      await ok(o.execute, "acknowledge_intervention", { operation_id: "ack", intervention_id: input.id, outcome: "read_only", explanation: "接口协议仍待明确。" });
    }
  });
  const t = createCollaboration(id, { goal: "整理需求并编制 PBS", mode: "conversation" });
  receiveMessage(t, { id: "broadcast", content: "整理需求并编制 PBS" });
  await runCollaboration(t.id);
  assert.deepEqual(turns, [["materials", "claim"], ["understanding", "claim"], ["pbs", "claim"], ["understanding", "intervention"]]);
  assert.equal(conversation.claims("broadcast").find(c => c.role === "pbs").decision, "pass");
  assert.equal(repo.listQuestions(id).length, 1);
  assert.equal(repo.listItems(id).length, 0);
});

test("addressed PBS discussion and upstream consultation remain available before confirmation", async () => {
  let pbsReplies = 0;
  runtime(async (o, s) => {
    assert.equal(s.pbs_participation.can_execute, false);
    if (s.activation_mode === "claim") {
      assert.equal(o.role, "pbs");
      await ok(o.execute, "respond_to_message", { operation_id: "claim", message_id: s.message.id, decision: "claim", scope: "解释已有接口要求", work_mode: "discussion" });
    } else if (o.role === "pbs") {
      pbsReplies++;
      assert.ok(!o.goal.includes("依据已确认需求理解包编制PBS"));
      const input = (await ok(o.execute, "read_interventions")).messages[0];
      if (!s.consultations.length) {
        await ok(o.execute, "ask_expert", { operation_id: "ask", target: "understanding", question: "当前客户指的是对接已有系统吗？", references: [code] });
      } else {
        await ok(o.execute, "record_consultation_outcome", { operation_id: "use", consultation_id: s.consultations[0].id, outcome: "adopted", explanation: "仅解释现有要求，未确定选型。" });
        const denied = await o.execute("acknowledge_intervention", { operation_id: "not-read-only", intervention_id: input.id, outcome: "needs_clarification", explanation: "记录疑点" });
        assert.equal(denied.ok, false);
        await ok(o.execute, "acknowledge_intervention", { operation_id: "ack", intervention_id: input.id, outcome: "read_only", explanation: "客户要求对接现有系统，具体协议尚未明确。" });
      }
    } else {
      assert.equal(o.role, "understanding");
      assert.equal(s.activation_mode, "consultation");
      await ok(o.execute, "submit_expert_answer", { operation_id: "answer", consultation_id: s.consultation_id, nature: "analysis", answer: "按当前需求理解是对接现有系统，协议尚未明确。" });
    }
  });
  const t = createCollaboration(id, { goal: "解释接口", mode: "conversation" });
  receiveMessage(t, { id: "direct", content: "@PBS专家 这里是指对接现有系统吗？", targets: ["pbs"] });
  await runCollaboration(t.id);
  assert.equal(pbsReplies, 2);
  assert.equal(store.consultations(t.id)[0].state, "answered");
  assert.equal(store.pendingInputs(t.id).length, 0);
  assert.equal(repo.listItems(id).length, 0);
  assert.equal(repo.listQuestions(id).length, 0);
  assert.ok(!store.events(id).some(e => e.kind === "approval_required"));
});

test("valid human scope enables PBS, and a scope edit revokes every write during execution", async () => {
  const approved = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [code] });
  const t = createCollaboration(id, { role: "pbs", goal: "编制本轮范围", approvalId: approved.id });
  let turns = 0;
  runtime(async (o, s) => {
    turns++;
    assert.equal(o.role, "pbs");
    assert.equal(s.pbs_participation.can_execute, true);
    await ok(o.execute, "submit_questions", { operation_id: "allowed", questions: [question] });
    const p = await ok(o.execute, "project_state");
    svc.editRequirement(id, code, { text: "改为日间巡查" });
    const writes = [
      ["submit_questions", { operation_id: "late-question", questions: [{ ...question, question: "数量是多少？" }] }],
      ["propose_change", { operation_id: "late-change", action: { type: "edit_requirement", code, text: "其他范围" } }],
      ["submit_pbs", { operation_id: "late-pbs", expected_version: p.pbs_version, items: [{ name: "巡查设备", parent: "1", source: "外采", req_ids: [code], unit: "套" }] }],
      ["submit_solutions", { operation_id: "late-solution", expected_version: p.pbs_version, solutions: [{ id: "patrol", name: "巡查方案", req_ids: [code], scenario_ids: [], item_ids: [] }] }],
      ["request_confirmation", { operation_id: "late-review" }],
    ];
    for (const [name, args] of writes) {
      const rejected = await o.execute(name, args);
      assert.equal(rejected.ok, false, name);
      assert.match(rejected.error.message, /确认|变化/, `${name}: ${rejected.error.message}`);
    }
    const current = await ok(o.execute, "collaboration_state");
    assert.equal(current.pbs_participation.can_execute, false);
    assert.equal(current.confirmation, null);
    assert.ok(!current.capabilities.business_tools.includes("submit_questions"));
  });
  await runCollaboration(t.id);
  assert.equal(turns, 1);
  assert.equal(repo.listQuestions(id).length, 1);
  assert.equal(repo.listItems(id).length, 0);
  assert.equal(store.task(t.id).status, "awaiting_confirmation");
  const renewed = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [code] });
  store.updateTask(t.id, { approval_id: renewed.id });
  assert.equal(pbsParticipation(store.task(t.id)).can_execute, true);
});

test("stale queued PBS work is cancelled or made read-only without blocking upstream work", async () => {
  const approved = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [code] });
  const t = createCollaboration(id, { role: "pbs", goal: "尚未执行的 PBS 任务", approvalId: approved.id });
  const original = store.nextActivation(t.id);
  receiveIntervention(t, { id: "old-work", target: "pbs", text: "调整设备数量" });
  svc.editRequirement(id, code, { text: "新增日间巡查范围" });
  store.enqueue(store.task(t.id), "understanding", "main", { goal: "核对最新范围" });
  const turns = [];
  runtime(async (o, s) => {
    turns.push([o.role, s.activation_mode]);
    if (o.role === "pbs") {
      assert.equal(s.activation_mode, "intervention");
      assert.ok(!o.tools.some(tool => tool.name === "submit_pbs" || tool.name === "propose_change"));
      const input = (await ok(o.execute, "read_interventions")).messages[0];
      assert.equal(input.data.work_mode, "discussion");
      assert.equal(input.data.execution_deferred, true);
      await ok(o.execute, "acknowledge_intervention", { operation_id: "ack", intervention_id: input.id, outcome: "read_only", explanation: "最新范围需先确认，确认后才能调整数量。" });
    } else {
      await ok(o.execute, "submit_questions", { operation_id: "upstream", questions: [question] });
    }
  });
  await runCollaboration(t.id);
  assert.deepEqual(turns, [["pbs", "intervention"], ["understanding", "main"]]);
  assert.equal(getDb().prepare("SELECT state FROM collaboration_activations WHERE id=?").get(original.id).state, "cancelled");
  assert.equal(store.pendingInputs(t.id).length, 0);
  assert.equal(store.task(t.id).status, "awaiting_confirmation");
  assert.equal(repo.listItems(id).length, 0);
});

test("PBS can acknowledge its own saved adjustment without revoking an unchanged understanding scope", async () => {
  const approved = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [code] });
  const t = createCollaboration(id, { role: "pbs", mode: "conversation", goal: "编制 PBS", approvalId: approved.id });
  runtime(async (o, s) => {
    if (s.activation_mode === "claim") {
      await ok(o.execute, "respond_to_message", { operation_id: "claim", message_id: s.message.id, decision: "claim", work_mode: "main", scope: "保存巡查服务" });
      return;
    }
    const input = (await ok(o.execute, "read_interventions")).messages[0];
    const state = await ok(o.execute, "project_state");
    await ok(o.execute, "submit_pbs", { operation_id: "save", expected_version: state.pbs_version, items: [{ name: "巡查服务", parent: "5", source: "服务", req_ids: [code], unit: "项" }] });
    await ok(o.execute, "acknowledge_intervention", { operation_id: "ack", intervention_id: input.id, outcome: "adjusted", operation_ids: ["save"], explanation: "已保存巡查服务草稿。" });
  });
  receiveMessage(t, { id: "pbs-work", content: "@PBS专家 编制巡查服务项", targets: ["pbs"] });
  await runCollaboration(t.id);
  assert.equal(store.task(t.id).approval_id, approved.id);
  assert.equal(pbsParticipation(store.task(t.id)).can_execute, true);
  assert.equal(store.task(t.id).status, "awaiting_review");
});

test("rematch utilities cannot bypass missing, excluded or stale human scope", async () => {
  const item = svc.saveItem(id, null, { name: "巡查服务", parent: "5", source: "服务", req_ids: [code], unit: "项" });
  let calls = 0;
  const llm = { json: async () => { calls++; return { node: { name: "巡查服务建议", parent: "5", source: "服务", req_ids: ["R999"] } }; } };
  await assert.rejects(svc.rematchItem(id, item, { llm }), /确认/);
  assert.equal(calls, 0);
  const approved = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [code] });
  const t = createCollaboration(id, { role: "pbs", mode: "conversation", goal: "匹配", approvalId: approved.id });
  const result = await svc.rematchItem(id, item, { llm });
  assert.equal(calls, 1); assert.equal(result.suggestion.approval_id, approved.id);
  assert.deepEqual(result.suggestion.req_ids, [code]);
  svc.acceptRematch(id, item, result.suggestion);
  assert.equal(repo.getItem(id, item).name, "巡查服务建议");
  assert.deepEqual(repo.getItem(id, item).req_ids, [code]);
  svc.editRequirement(id, code, { text: "仅在日间开展巡查" });
  await assert.rejects(svc.rematchItem(id, item, { llm }), /变化|确认/);
  assert.throws(() => svc.acceptRematch(id, item, result.suggestion), /变化|确认/);
  assert.equal(calls, 1); assert.equal(repo.getItem(id, item).name, "巡查服务建议");
  const other = svc.addRequirement(id, { text: "其他一期需求" });
  const partial = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [other] });
  store.updateTask(t.id, { approval_id: partial.id });
  await assert.rejects(svc.rematchItem(id, item, { llm }), /超出/);
  assert.equal(calls, 1);
});
