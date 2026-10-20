import assert from "node:assert/strict";
import { test } from "node:test";
import { resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { localAgentAdapter } from "../server/agent-adapter.mjs";
import { workspaceTarget, questionPending, questionUnlinked, questionsForRequirement, questionActions, questionLinkLabel, understandingAction, approvalSelectionIssue } from "../shared/understanding.js";
import { approvalPreview } from "../server/collaboration-approval.mjs";

test("materials accept an upload without a category and keep uploader context separate from evidence", async () => {
  resetDb();
  const id = repo.createProject({ name: "理解材料" }).id;
  const text = "会议纪要：客户希望夜间巡查，发现异常后通知值班人员，具体通知渠道尚未确定。";
  const mid = svc.addMaterial(id, { text, fileName: "客户会议.pdf", description: "这是最新讨论，重点关注通知渠道。" });
  const material = repo.getMaterial(id, mid);
  assert.equal(material.title, "客户会议");
  assert.equal(material.kind, "minutes");
  assert.equal(material.meta.kind_inferred, true);
  assert.equal(material.text, text);
  assert.ok(repo.listSegments(id).every((s) => !s.text.includes("这是最新讨论")));
  const state = (await localAgentAdapter(id).execute("project_state", {})).data;
  assert.equal(state.documents[0].description, material.meta.description);
});

test("legacy links enter the unified workspace and clarification stays independent of description approval", () => {
  assert.deepEqual(workspaceTarget("scenarios"), { tab: "understanding", pane: "scenarios" });
  assert.deepEqual(workspaceTarget("understanding", "questions"), { tab: "understanding", pane: "questions" });
  const requirement = { code: "R001", status: "已确认", scenario_ids: ["SC001"] };
  const questions = [
    { id: 1, status: "待答复", req_ids: ["R001"], scenario_ids: [] },
    { id: 2, status: "已应用", req_ids: ["R001"], scenario_ids: [] },
    { id: 3, status: "待处理", req_ids: [], scenario_ids: [] },
    { id: 4, status: "待处理", req_ids: [], scenario_ids: ["SC001"] },
    { id: 5, status: "待处理", req_ids: ["R002"], scenario_ids: ["SC001"] },
  ];
  assert.deepEqual(questionsForRequirement(requirement, questions).filter(questionPending).map((q) => q.id), [1, 4]);
  assert.deepEqual(questions.filter((q) => questionUnlinked(q) && questionPending(q)).map((q) => q.id), [3]);
});

test("understanding actions distinguish unread material from organizing saved requirements", () => {
  const view = { materials: [], requirements: [] };
  assert.equal(understandingAction(view), null);
  view.requirements = [{ status: "已确认" }];
  assert.equal(understandingAction(view).path, "scenarios/generate", "manual requirements do not require an uploaded material");
  view.materials = [{ extracted_at: null }];
  assert.equal(understandingAction(view).path, "analyze");
  view.materials[0].extracted_at = "processed";
  assert.equal(understandingAction(view).path, "scenarios/generate");
  view.requirements[0].status = "已删除";
  assert.deepEqual(understandingAction(view).body, { all: true });
  view.materials = [];
  assert.equal(understandingAction(view), null);
});

test("clarification actions and approval counts respect resolved and deferred answers", () => {
  resetDb();
  const id = repo.createProject({ name: "问题状态核对" }).id;
  const req = svc.addRequirement(id, { text: "支持异常通知" });
  const make = status => {
    repo.insertQuestion(id, { source: "人工", question: status, req_ids: [req], impact: "影响方案" });
    const q = repo.listQuestions(id).find(q => q.question === status);
    repo.updateQuestion(id, q.id, { status, answer: "通知值班人员", proposal: { summary: "保留原要求", changes: [], dropped: [] } });
    return q.id;
  };
  const pending = make("待处理"), answered = make("已答复"), done = make("已应用"), deferred = make("已忽略");
  assert.deepEqual(new Set(approvalPreview(id).questions.map(q => q.id)), new Set([pending, answered]));
  const doneQuestion = repo.getQuestion(id, done);
  assert.deepEqual(questionActions(doneQuestion), { answer: false, review: false, assign: false, defer: false, restore: false });
  assert.equal(questionLinkLabel(doneQuestion), "查看处理记录");
  assert.throws(() => svc.editQuestion(id, done, { status: "已忽略" }), /已处理/);
  assert.equal(questionActions(repo.getQuestion(id, deferred)).restore, true);
  svc.editQuestion(id, deferred, { status: "待处理" });
  assert.equal(repo.getQuestion(id, deferred).status, "已答复");
  assert.equal(questionActions(repo.getQuestion(id, deferred)).review, true);
  assert.equal(approvalPreview(id).questions.length, 3);
  assert.equal(repo.getRequirement(id, req).status, "已确认", "clarification remains independent from description review");
});

test("stale selections cannot revive deleted requirements and selected scenes require all linked requirements", () => {
  resetDb();
  const id = repo.createProject({ name: "确认范围状态核对" }).id;
  const live = svc.addRequirement(id, { text: "需求一" }), removed = svc.addRequirement(id, { text: "需求二" });
  repo.updateRequirement(id, live, { status: "待确认" });
  svc.editRequirement(id, removed, { status: "已删除", reason: "客户取消" });
  assert.throws(() => svc.confirmRequirements(id, [live, removed]), /已删除/);
  assert.equal(repo.getRequirement(id, live).status, "待确认", "batch failure must not partially approve");
  assert.equal(repo.getRequirement(id, removed).status, "已删除");
  const data = { requirements: [{ code: live }, { code: removed }], scenarios: [{ code: "SC001", links: [{ req_id: live }, { req_id: removed }] }] };
  assert.match(approvalSelectionIssue(data, [live], ["SC001"]), new RegExp(removed));
  assert.equal(approvalSelectionIssue(data, [live, removed], ["SC001"]), "");
  assert.ok(approvalSelectionIssue(data, [], []));
  data.requirements.pop();
  assert.match(approvalSelectionIssue(data, [live], ["SC001"]), /已删除/);
});
