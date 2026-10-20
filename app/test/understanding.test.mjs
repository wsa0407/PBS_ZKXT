import assert from "node:assert/strict";
import { test } from "node:test";
import { resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { localAgentAdapter } from "../server/agent-adapter.mjs";
import { workspaceTarget, questionPending, questionUnlinked, questionsForRequirement } from "../web/understanding.js";

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
