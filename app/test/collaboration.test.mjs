import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { resetDb, getDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as store from "../server/collaboration-store.mjs";
import { approvalPreview, approveUnderstanding, assertApproval } from "../server/collaboration-approval.mjs";
import { createCollaboration, receiveIntervention, runCollaboration } from "../server/collaboration.mjs";
import { collaborationAdapter } from "../server/collaboration-tools.mjs";
import { setAgentRuntimeFactory } from "../server/agent-runner.mjs";
import { createServer } from "../server/index.mjs";
import { inbox } from "../server/conversation-store.mjs";

let id;
beforeEach(() => {
  resetDb(); id = repo.createProject({ name: "协作核心验证" }).id;
  svc.addMaterial(id, { title: "巡查要求", text: "2.1.1 系统应支持夜间巡查，异常推送客户已有工单系统。\n2.1.2 平台支持不少于10路视频并发。" });
});
afterEach(() => setAgentRuntimeFactory(null));
const ok = async (execute, name, args = {}) => { const r = await execute(name, args); assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`); return r.data; };
function scripted(fn) {
  setAgentRuntimeFactory(async (o) => {
    o.onSession?.(`session-${o.role}`);
    await fn(o);
    return { sessionId: `session-${o.role}`, finalResponse: "已完成本次核对，详情见工作区。" };
  });
}
async function seedRequirement(execute) {
  const { documents } = await ok(execute, "project_state");
  const batch = await ok(execute, "read_document_batch", { document_id: documents[0].document_id });
  const s = batch.items.find((s) => s.text.includes("夜间巡查"));
  await ok(execute, "submit_requirements", { operation_id: "r1", document_id: s.document_id, document_version: s.document_version, requirements: [{ evidence_id: s.evidence_id, text: "夜间巡查并推送异常至已有工单系统", quote: "系统应支持夜间巡查，异常推送客户已有工单系统", category: "功能", priority: "必须" }] });
}

test("stage handoff requires a human-approved immutable scope before PBS, and rejects stale approval", async () => {
  const roles = [];
  scripted(async ({ role, execute }) => { roles.push(role); if (role === "materials") await seedRequirement(execute); });
  const t = createCollaboration(id, { role: "materials", goal: "理解材料" });
  await runCollaboration(t.id);
  assert.deepEqual(roles, ["materials"]);
  const understanding = createCollaboration(id, { role: "understanding", goal: "整理当前需求" });
  await runCollaboration(understanding.id);
  assert.deepEqual(roles, ["materials", "understanding"]);
  assert.equal(store.task(t.id).status, "awaiting_confirmation");
  const p = createCollaboration(id, { role: "pbs", goal: "编制" });
  await runCollaboration(p.id);
  assert.equal(roles.length, 2);
  const preview = approvalPreview(id);
  assert.throws(() => approveUnderstanding(id, { version: "stale", requirements: ["R001"] }), /变化/);
  const a = approveUnderstanding(id, { version: preview.version, requirements: ["R001"], scenarios: [] });
  assert.equal(a.snapshot.requirements[0].status, "已确认");
  const approved = { ...p, approval_id: a.id };
  assert.equal(assertApproval(approved).id, a.id);
  svc.editRequirement(id, "R001", { text: "已变更的需求" });
  assert.throws(() => assertApproval(approved), /变化/);
  scripted(async ({ tools }) => { assert.ok(!tools.some((t) => t.name === "submit_pbs")); });
  const discussion = createCollaboration(id, { role: "pbs", mode: "discussion", goal: "谁在？" });
  await runCollaboration(discussion.id);
  assert.equal(store.task(discussion.id).status, "done");
  assert.ok(!store.events(id).some((e) => e.task_id === discussion.id && e.kind === "approval_required"));
});

test("independent roles answer correlated multi-round consultations and preserve exact role sessions", async () => {
  const code = svc.addRequirement(id, { text: "夜间巡查" });
  const a = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [code] });
  let pbsCalls = 0;
  const seen = [];
  scripted(async ({ role, execute, sessionId }) => {
    seen.push({ role, sessionId });
    const state = await ok(execute, "collaboration_state");
    if (role === "pbs") {
      assert.deepEqual(state.capabilities.consultation_targets.map((r) => r.role), ["understanding", "materials"]);
      assert.ok(state.capabilities.business_tools.includes("submit_pbs"));
      assert.ok(!state.capabilities.business_tools.includes("submit_requirements"));
      pbsCalls++;
      if (pbsCalls === 1) {
        await ok(execute, "ask_expert", { operation_id: "same-id", target: "understanding", question: "是否需要新建工单闭环？" });
        await ok(execute, "ask_expert", { operation_id: "source", target: "materials", question: "原文如何要求对接？" });
      } else if (pbsCalls === 2) {
        const c = state.consultations.find((c) => c.target === "understanding");
        await ok(execute, "record_consultation_outcome", { operation_id: "use", consultation_id: c.id, outcome: "adopted", explanation: "按已有系统对接理解" });
        await ok(execute, "ask_expert", { operation_id: "follow", target: "materials", question: "是否明确接口数量？", followup_to: state.consultations.find((c) => c.target === "materials").id });
      }
    } else {
      assert.ok(!state.capabilities.business_tools.some((name) => name.startsWith("submit_")));
      if (role === "materials") assert.deepEqual(state.capabilities.consultation_targets, []);
      assert.equal((await execute("submit_requirements", {})).error.code, "ROLE_PERMISSION");
      const c = state.consultations.find((c) => c.id === state.consultation_id);
      await ok(execute, "submit_expert_answer", { operation_id: "same-id", consultation_id: c.id, answer: "当前只能确认异常推送，接口数量待明确。", nature: "analysis" });
    }
  });
  const t = createCollaboration(id, { role: "pbs", goal: "核对范围和依据", approvalId: a.id });
  await runCollaboration(t.id);
  assert.equal(store.consultations(t.id).length, 3);
  assert.ok(store.consultations(t.id).every((c) => c.state === "answered"));
  assert.equal(pbsCalls, 3);
  assert.equal(seen.filter((s) => s.role === "materials")[1].sessionId, "session-materials");
  const answers = store.events(id).filter((e) => e.kind === "answer");
  assert.equal(answers.length, 3);
  assert.ok(answers.some((e) => e.sender === "understanding"));
  assert.ok(answers.some((e) => e.sender === "materials"));
});

test("human input blocks stale writes, closes the runtime before resuming, and records a real delivery receipt", async () => {
  let entered, release, closed = false, turns = 0;
  const ready = new Promise((r) => { entered = r; });
  const done = new Promise((r) => { release = r; });
  setAgentRuntimeFactory(async (o) => {
    o.onSession?.(`session-${o.role}`);
    turns++;
    const state = await ok(o.execute, "collaboration_state");
    if (turns === 1) {
      entered();
      await new Promise((resolve) => o.signal.addEventListener("abort", resolve, { once: true }));
      const rejected = await o.execute("submit_questions", { operation_id: "stale", questions: [{ question: "旧范围疑点", reason: "旧依据", impact: "影响方案" }] });
      assert.equal(rejected.ok, false);
      await done; closed = true; throw new Error("closed");
    }
    assert.equal(closed, true);
    if (state.activation_mode === "consultation") {
      await ok(o.execute, "submit_expert_answer", { operation_id: "answer", consultation_id: state.consultation_id, nature: "analysis", answer: "已确认当前只有需求理解任务，尚未编制PBS。" });
    }
    if (state.activation_mode === "intervention") {
      const inputs = await ok(o.execute, "read_interventions");
      assert.equal(inputs.messages.length, 1);
      assert.equal(store.pendingInputs(state.task.id)[0].state, "delivered");
      if (!state.consultations.length) {
        await ok(o.execute, "ask_expert", { operation_id: "verify-progress", target: "materials", question: "请核对当前材料处理范围" });
        return { sessionId: `session-${o.role}`, finalResponse: "正在向材料专家核对" };
      }
      await ok(o.execute, "acknowledge_intervention", { operation_id: "ack", intervention_id: inputs.messages[0].id, outcome: "read_only", explanation: "目前还在核对需求，尚未生成PBS。" });
    }
    return { sessionId: `session-${o.role}`, finalResponse: "已核对" };
  });
  const t = createCollaboration(id, { goal: "理解材料" });
  const work = runCollaboration(t.id);
  await ready;
  receiveIntervention(t, { id: "human-1", text: "进展如何？" });
  assert.equal(store.pendingInputs(t.id).length, 1);
  assert.equal(turns, 1);
  release(); await work;
  assert.equal(store.interventions(t.id)[0].state, "handled");
  assert.equal(repo.listQuestions(id).length, 0);
});

test("durable messages, hidden conversation and restart recovery preserve evidence without duplicate operations", async () => {
  const t = createCollaboration(id, { goal: "理解材料" });
  receiveIntervention(t, { id: "unique", text: "客户已有工单系统" });
  receiveIntervention(t, { id: "unique", text: "客户已有工单系统" });
  assert.equal(store.interventions(t.id).length, 1);
  const a = store.nextActivation(t.id);
  getDb().prepare("UPDATE collaboration_activations SET state='running' WHERE id=?").run(a.id);
  store.saveSession(id, "understanding", "original-session");
  store.recoverCollaboration();
  assert.equal(store.task(t.id).status, "paused");
  assert.equal(store.nextActivation(t.id).id, a.id);
  assert.equal(store.sessionId(id, "understanding"), "original-session");
  repo.clearChat(id);
  assert.equal(repo.listChat(id).length, 0);
  assert.equal(store.events(id).length, 1);
  assert.equal(store.pendingInputs(t.id).length, 1);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/projects/${id}`;
  try {
    const input = { requestId: "api-message", text: "这个接口还需客户明确", target: "understanding" };
    const send = () => fetch(base + "/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then((r) => r.json());
    assert.deepEqual(await send(), await send());
    assert.equal(store.interventions(t.id).length, 1);
    assert.equal(inbox(t.id).length, 1);
    assert.deepEqual(inbox(t.id)[0].targets, ["understanding"]);
    const events = store.events(id);
    const stream = await fetch(base + `/collaboration/stream?after=${events.at(-2).seq}`, { signal: AbortSignal.timeout(2000) });
    const reader = stream.body.getReader();
    const packet = new TextDecoder().decode((await reader.read()).value);
    assert.ok(packet.includes(`id: ${events.at(-1).seq}`));
    await reader.cancel();
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("permissions, source evidence, approval scope and intervention outcome claims are enforced server-side", async () => {
  const t = createCollaboration(id, { goal: "理解" });
  const a = store.nextActivation(t.id), adapter = collaborationAdapter(t, a);
  assert.equal((await adapter.execute("submit_pbs", {})).error.code, "ROLE_PERMISSION");
  const c = await ok(adapter.execute, "ask_expert", { operation_id: "q", target: "materials", question: "请核对夜间巡查原文" });
  const ca = store.nextActivation(t.id), reader = collaborationAdapter(t, ca);
  assert.equal(ca.mode, "consultation");
  assert.equal((await reader.execute("submit_expert_answer", { operation_id: "bad", consultation_id: c.consultation_id, answer: "数量是3", nature: "source_fact" })).ok, false);
  const state = await ok(reader.execute, "project_state");
  const source = (await ok(reader.execute, "read_document_batch", { document_id: state.documents[0].document_id })).items.find((s) => s.text.includes("夜间巡查"));
  // Batch reading is also a real source read; do not force one tool call per citation.
  await ok(reader.execute, "submit_expert_answer", { operation_id: "good", consultation_id: c.consultation_id, answer: "原文要求夜间巡查并推送异常", nature: "source_fact", evidence: [{ evidence_id: source.evidence_id, document_version: source.document_version, quote: "系统应支持夜间巡查" }] });
  receiveIntervention(t, { id: "correct", text: "不新增工单系统" });
  const newer = store.task(t.id), i = { id: "input-role", role: "understanding", mode: "intervention", input: { intervention_ids: ["correct"] } };
  const corrector = collaborationAdapter(newer, i);
  await ok(corrector.execute, "read_interventions");
  assert.equal((await corrector.execute("acknowledge_intervention", { operation_id: "lie", intervention_id: "correct", outcome: "adjusted", explanation: "已修改" })).ok, false);
  assert.equal(store.pendingInputs(t.id).length, 1);
});

test("partial human approval cannot borrow sizing parameters from excluded requirements", async () => {
  const selected = svc.addRequirement(id, { text: "需要GPU推理服务器，规模待确认" });
  repo.insertRequirement(id, { text: "第二期配置10个机场", quote: "配置10个机场", quote_verified: true, category: "功能", priority: "重要", params: [{ name: "dock_count", value: 10, quote: "配置10个机场" }] });
  const approved = approveUnderstanding(id, { version: approvalPreview(id).version, requirements: [selected] });
  assert.equal(approved.snapshot.excluded.requirements.length, 1);
  const t = createCollaboration(id, { role: "pbs", goal: "只编制本期范围", approvalId: approved.id });
  const a = collaborationAdapter(t, store.nextActivation(t.id));
  const state = await ok(a.execute, "project_state");
  await ok(a.execute, "submit_pbs", { operation_id: "scoped-pbs", expected_version: state.pbs_version, items: [{ name: "GPU推理服务器", parent: "4", source: "外采", req_ids: [selected], sizing_rule: "R05", unit: "台" }] });
  assert.deepEqual(repo.listItems(id)[0].input_scope, [selected]);
  assert.equal(svc.computeState(id).view.items[0].qty, null);
});
