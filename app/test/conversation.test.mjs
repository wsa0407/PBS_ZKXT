import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { resetDb, getDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as store from "../server/collaboration-store.mjs";
import * as conversation from "../server/conversation-store.mjs";
import { createCollaboration, receiveMessage, runCollaboration } from "../server/collaboration.mjs";
import { offerUnderstanding, review, latestReview, explicitReviewReply, validateReviewReply } from "../server/conversation-review.mjs";
import { assertApproval } from "../server/collaboration-approval.mjs";
import { collaborationAdapter } from "../server/collaboration-tools.mjs";
import { parseMentions, mentionQuery } from "../web/mentions.mjs";
import { setAgentRuntimeFactory } from "../server/agent-runner.mjs";
import { createServer } from "../server/index.mjs";
import { getJob } from "../server/jobs.mjs";
import { chatHistory } from "../server/chat.mjs";

let id;
beforeEach(() => { resetDb(); id = repo.createProject({ name: "对话认领核心验证" }).id; });
afterEach(() => setAgentRuntimeFactory(null));
const ok = async (execute, name, args = {}) => {
  const result = await execute(name, args); assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
};
function runtime(fn) {
  setAgentRuntimeFactory(async o => { const state = await ok(o.execute, "collaboration_state"); await fn(o, state); return { finalResponse: "本次已答复。" }; });
}
const claim = (o, s, values) => ok(o.execute, "respond_to_message", { operation_id: "claim", message_id: s.message.id, ...values });
async function answer(o) {
  const pending = await ok(o.execute, "read_interventions");
  for (const input of pending.messages) await ok(o.execute, "acknowledge_intervention", { operation_id: `ack-${input.id}`, intervention_id: input.id, outcome: "read_only", explanation: "已核对问题，答案与范围保持不变。" });
}

test("mentions support multiple recipients and completion without interpreting email addresses", () => {
  assert.deepEqual(parseMentions("@PBS专家 @材料拆解专家 请核对数量依据").targets, ["pbs", "materials"]);
  assert.deepEqual(parseMentions("请问 @需求理解专家，范围是什么").targets, ["understanding"]);
  assert.deepEqual(parseMentions("联系 someone@pbs.com；这是普通消息").targets, []);
  assert.deepEqual(parseMentions("@未定义专家 帮我看看").targets, []);
  assert.equal(mentionQuery("请 @需")?.options[0].id, "understanding");
  assert.equal(mentionQuery("@PBS专家 后续问题"), null);
  assert.equal(mentionQuery("@")?.options.length, 3);
});

test("broadcast reaches all three role sessions, only claimant answers, and discussion cannot write PBS", async () => {
  const seen = [];
  runtime(async (o, s) => {
    seen.push([o.role, s.activation_mode]);
    if (s.activation_mode === "claim") {
      assert.ok(!o.tools.some(t => t.name === "submit_pbs" || t.name === "propose_change" || t.name === "ask_expert"));
      assert.deepEqual(s.message.targets, ["materials", "understanding", "pbs"]);
      await claim(o, s, o.role === "pbs" ? { decision: "claim", scope: "解释产品数量依据", work_mode: "discussion" } : { decision: "pass" });
    } else {
      assert.equal(o.role, "pbs");
      assert.equal((await o.execute("submit_pbs", {})).error.code, "ROLE_PERMISSION");
      await answer(o);
    }
  });
  const t = createCollaboration(id, { goal: "解释", mode: "conversation" });
  receiveMessage(t, { id: "broadcast", content: "为什么要买这台服务器？" });
  await runCollaboration(t.id);
  assert.deepEqual(seen, [["materials", "claim"], ["understanding", "claim"], ["pbs", "claim"], ["pbs", "intervention"]]);
  assert.equal(conversation.claims("broadcast").length, 3);
  assert.equal(store.task(t.id).status, "done");
  assert.equal(store.events(id).filter(e => e.kind === "intervention_result").length, 1);
});

test("an addressed greeting overrides a stale recipient and shows the model reply without receipts or a confirmation prompt", async () => {
  svc.addRequirement(id, { text: "已有需求，尚待审阅" });
  const t = createCollaboration(id, { goal: "此前整理需求场景", mode: "conversation" });
  store.updateTask(t.id, { stage: "understanding", status: "awaiting_confirmation" });
  const roles = [];
  setAgentRuntimeFactory(async o => {
    const s = await ok(o.execute, "collaboration_state");
    roles.push(o.role); assert.equal(o.role, "materials");
    if (s.activation_mode === "claim") {
      assert.equal(s.message.content, "@材料拆解专家 嘛呢");
      assert.equal(s.message.data.addressed, true);
      await claim(o, s, { decision: "claim", scope: "回应给本人的招呼", work_mode: "discussion" });
    } else {
      assert.ok(!o.goal.includes("完整检查待处理材料，按顺序阅读"));
      const inputs = await ok(o.execute, "read_interventions");
      await ok(o.execute, "acknowledge_intervention", { operation_id: "ack", intervention_id: inputs.messages[0].id, outcome: "read_only", explanation: "内部记录：已经处理，不修改业务数据。" });
    }
    return { finalResponse: "我在。需要我帮你回查哪份材料？" };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "greeting-regression", text: "@材料拆解专家 嘛呢", target: "understanding" }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    for (let i = 0; i < 100 && getJob(result.jobId).status === "处理中"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(getJob(result.jobId).status, "已完成");
    assert.deepEqual(roles, ["materials", "materials"]);
    assert.deepEqual(chatHistory(id).map(m => m.content), ["@材料拆解专家 嘛呢", "我在。需要我帮你回查哪份材料？"]);
    assert.equal(chatHistory(id)[0].payload.recipient, "materials");
    assert.ok(store.events(id).some(e => e.kind === "intervention_result" && e.payload.visibility === "activity"));
    assert.ok(!store.events(id).some(e => e.kind === "approval_required"));
    // Old persisted activity bubbles are also hidden without altering their audit record.
    repo.addChat(id, "assistant", "正在同步你的补充。", { collaboration: true, kind: "activity", sender: "understanding" });
    repo.addChat(id, "assistant", "已读到你的补充。", { collaboration: true, kind: "delivery", sender: "understanding" });
    assert.equal(chatHistory(id).length, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("explicit mentions restrict delivery, multiple experts each execute their claimed part after recovery", async () => {
  const t = createCollaboration(id, { goal: "分头核对", mode: "conversation" });
  receiveMessage(t, { id: "directed", content: "@材料拆解专家 @PBS专家 核对原文和产品依据", targets: ["materials", "pbs"] });
  conversation.queueClaims(store.task(t.id));
  const first = store.nextActivation(t.id);
  getDb().prepare("UPDATE collaboration_activations SET state='running' WHERE id=?").run(first.id);
  await ok(collaborationAdapter(store.task(t.id), first).execute, "respond_to_message", { operation_id: "claim", message_id: "directed", decision: "claim", scope: "原文依据", work_mode: "discussion" });
  // Simulate a crash after the receipt commits but before the activity is marked done.
  store.recoverCollaboration();
  const seen = [];
  runtime(async (o, s) => {
    seen.push([o.role, s.activation_mode]);
    if (s.activation_mode === "claim") await claim(o, s, { decision: "claim", scope: "产品依据", work_mode: "discussion" });
    else await answer(o);
  });
  await runCollaboration(t.id);
  assert.deepEqual(seen, [["pbs", "claim"], ["materials", "intervention"], ["pbs", "intervention"]]);
  assert.equal(store.interventions(t.id).length, 2);
  assert.ok(store.interventions(t.id).every(i => i.state === "handled"));
  repo.deleteProject(id);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM conversation_claims").get().n, 0);
  assert.equal(conversation.inbox(t.id).length, 0);
});

test("natural confirmation is tied to the displayed immutable scope, opens PBS once, and decline stays declined", async () => {
  svc.addRequirement(id, { text: "夜间巡查" });
  const t = createCollaboration(id, { goal: "理解", mode: "conversation" });
  const offered = offerUnderstanding(t);
  let pbsTurns = 0;
  runtime(async (o, s) => {
    if (s.activation_mode === "claim") await claim(o, s, o.role === "understanding" ? { decision: "review", review_id: offered.id, review_decision: "approve", quote: "没问题，就按这个范围开始吧" } : { decision: "pass" });
    else { pbsTurns++; assert.equal(o.role, "pbs"); assert.ok(s.confirmation); }
  });
  receiveMessage(t, { id: "approve", content: "没问题，就按这个范围开始吧", data: { reviewId: offered.id } });
  await runCollaboration(t.id);
  assert.equal(pbsTurns, 1);
  assert.equal(review(offered.id).state, "accepted");
  assert.equal(assertApproval(store.task(t.id)).snapshot.requirements.length, 1);
  receiveMessage(t, { id: "approve", content: "没问题，就按这个范围开始吧", data: { reviewId: offered.id } });
  await runCollaboration(t.id);
  assert.equal(pbsTurns, 1);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM collaboration_approvals").get().n, 1);

  const next = createCollaboration(id, { goal: "复核", mode: "conversation" });
  const another = offerUnderstanding(next);
  runtime(async (o, s) => { await claim(o, s, { decision: "review", review_id: another.id, review_decision: "decline", quote: "先不确认" }); });
  receiveMessage(next, { id: "decline", content: "先不确认", targets: ["understanding"], data: { reviewId: another.id } });
  await runCollaboration(next.id);
  assert.equal(review(another.id).state, "declined");
  assert.equal(latestReview(id), undefined);
  assert.equal(store.task(next.id).status, "done");
});

test("questions, conditional assent, missing context and invented scope never authorize confirmation", () => {
  for (const text of ["继续", "先不要确认", "可以吗？", "如果修改好了就确认", "同意，但需要改成12台", "客户说同意", "确认是不是能改回来", "确认后会生成什么", "等客户同意后再确认", "我还没确认"]) {
    assert.equal(explicitReviewReply(text, "approve"), false, text);
  }
  const r1 = svc.addRequirement(id, { text: "第一期" }), r2 = svc.addRequirement(id, { text: "第二期" });
  const t = createCollaboration(id, { goal: "确认", mode: "conversation" }), offered = offerUnderstanding(t);
  receiveMessage(t, { id: "no-context", content: "同意" });
  assert.throws(() => validateReviewReply(conversation.message("no-context"), { review_id: offered.id, review_decision: "approve", quote: "同意" }), /关联/);
  receiveMessage(t, { id: "partial", content: `只确认 ${r1}`, data: { reviewId: offered.id } });
  const m = conversation.message("partial"), args = { review_id: offered.id, review_decision: "approve", quote: `只确认 ${r1}`, requirements: [r1], scenarios: [] };
  assert.equal(validateReviewReply(m, args).id, offered.id);
  assert.throws(() => validateReviewReply(m, { ...args, requirements: [r1, r2] }), /编号/);
  assert.throws(() => validateReviewReply(m, { ...args, requirements: ["R999"] }), /扩大/);
});

test("a stale confirmation is not applied and an updated request is shown for a fresh user reply", async () => {
  const code = svc.addRequirement(id, { text: "旧范围" });
  const t = createCollaboration(id, { goal: "确认", mode: "conversation" }), offered = offerUnderstanding(t);
  svc.editRequirement(id, code, { text: "新范围" });
  runtime(async (o, s) => { assert.equal(s.activation_mode, "claim"); await claim(o, s, { decision: "review", review_id: offered.id, review_decision: "approve", quote: "确认这个范围" }); });
  receiveMessage(t, { id: "stale", content: "确认这个范围", targets: ["pbs"], data: { reviewId: offered.id } });
  await runCollaboration(t.id);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM collaboration_approvals").get().n, 0);
  assert.equal(review(offered.id).state, "superseded");
  assert.notEqual(latestReview(id).id, offered.id);
  assert.equal(store.events(id).filter(e => e.kind === "approval_required").at(-1).sender, "understanding");
});

test("a proposed correction is accepted through chat even after the host marks existing PBS for review", async () => {
  const code = svc.addRequirement(id, { text: "夜间巡查" });
  svc.saveItem(id, null, { name: "巡查无人机", parent: "1", source: "外采", unit: "架", req_ids: [code], qty: 2 });
  const t = createCollaboration(id, { goal: "纠正", mode: "conversation" });
  runtime(async (o, s) => {
    if (s.activation_mode === "claim") return claim(o, s, { decision: "claim", scope: "提出日间巡查修订", work_mode: "main" });
    const input = (await ok(o.execute, "read_interventions")).messages[0];
    await ok(o.execute, "propose_change", { operation_id: "change", action: { type: "edit_requirement", code, text: "日间巡查" } });
    await ok(o.execute, "acknowledge_intervention", { operation_id: "ack", intervention_id: input.id, outcome: "requires_confirmation", operation_ids: ["change"], explanation: "建议改为日间巡查，请直接回复是否采纳。" });
  });
  receiveMessage(t, { id: "correction", content: "把夜间巡查改为日间巡查", targets: ["understanding"] });
  await runCollaboration(t.id);
  assert.equal(repo.listRequirements(id)[0].text, "夜间巡查");
  const request = latestReview(id); assert.equal(request.kind, "change");
  runtime(async (o, s) => claim(o, s, { decision: "review", review_id: request.id, review_decision: "approve", quote: "采纳" }));
  receiveMessage(t, { id: "accept-change", content: "采纳", targets: ["understanding"], data: { reviewId: request.id } });
  await runCollaboration(t.id);
  assert.equal(review(request.id).state, "accepted");
  assert.equal(repo.listRequirements(id)[0].text, "日间巡查");
});

test("new broadcast interrupts an active runtime and blocks its stale write before routing resumes", async () => {
  let entered, stopped = false;
  const ready = new Promise(r => { entered = r; });
  setAgentRuntimeFactory(async o => {
    const s = await ok(o.execute, "collaboration_state");
    if (s.activation_mode === "main" && !stopped) {
      entered(); await new Promise(r => o.signal.addEventListener("abort", r, { once: true }));
      assert.equal((await o.execute("submit_questions", { operation_id: "stale", questions: [{ question: "旧问题", reason: "旧", impact: "旧" }] })).ok, false);
      stopped = true; throw new Error("interrupted");
    }
    assert.equal(stopped, true);
    if (s.activation_mode === "claim") await claim(o, s, o.role === "understanding" ? { decision: "claim", scope: "回答最新范围问题", work_mode: "discussion" } : { decision: "pass" });
    if (s.activation_mode === "intervention") await answer(o);
    return { finalResponse: "已处理" };
  });
  const t = createCollaboration(id, { goal: "理解材料" });
  const work = runCollaboration(t.id); await ready;
  receiveMessage(t, { id: "during-run", content: "现在理解的范围是什么？" });
  await work;
  assert.equal(conversation.claims("during-run").length, 3);
  assert.equal(store.pendingInputs(t.id).length, 0);
  assert.equal(repo.listQuestions(id).length, 0);
});
