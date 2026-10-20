import { hash } from "../engine/scenario.mjs";
import { getDb, parse } from "./db.mjs";
import * as repo from "./repo.mjs";
import * as scenes from "./scenarios.mjs";
import { HttpError } from "./errors.mjs";
import { latestTask } from "./collaboration-store.mjs";
import { questionPending } from "../shared/understanding.js";

export function understandingFacts(projectId) {
  return {
    requirements: repo.listRequirements(projectId, { includeDeleted: false }),
    scenarios: scenes.listScenarios(projectId).filter((s) => s.status !== "已归档"),
    dispositions: scenes.scenarioView(projectId).dispositions,
    sources: repo.listMaterials(projectId).map((m) => ({ id: m.id, title: m.title, version: hash(repo.getMaterial(projectId, m.id).text) })),
    answers: repo.listQuestions(projectId).filter((q) => q.answer).map((q) => ({ id: q.id, answer: q.answer, source: q.answer_source, status: q.status, applied: q.applied })),
    overrides: repo.listOverrides(projectId),
  };
}
export const understandingVersion = (projectId) => hash(understandingFacts(projectId));
export function approvalPreview(projectId) {
  const facts = understandingFacts(projectId);
  return { ...facts, version: hash(facts), questions: repo.listQuestions(projectId).filter(questionPending),
    defaults: { requirements: facts.requirements.filter((r) => r.status === "已确认").map((r) => r.code), scenarios: facts.scenarios.filter((s) => s.status === "已确认").map((s) => s.code) } };
}
export function approval(id, projectId) {
  const row = getDb().prepare("SELECT * FROM collaboration_approvals WHERE id=? AND project_id=?").get(id ?? "", projectId ?? "");
  return row ? { ...row, snapshot: parse(row.snapshot, {}) } : null;
}
export function pbsParticipation(t) {
  const confirmed = approval(t?.approval_id, t?.project_id);
  const canExecute = Boolean(confirmed && confirmed.input_version === understandingVersion(t.project_id));
  return { can_discuss: true, can_execute: canExecute,
    reason: canExecute ? null : "需求理解尚未经人工确认，或确认后的内容已变化。PBS 专家可交流和答疑，暂不认领或执行成果任务。" };
}
export function assertApproval(t) {
  const a = approval(t?.approval_id, t?.project_id);
  if (!a || a.input_version !== understandingVersion(t.project_id)) throw new HttpError(409, "本轮需求理解尚未确认或已变化，请先审阅并重新交接给PBS");
  return a;
}

/** Shared guard for automated PBS utilities outside a role activation. */
export function assertProjectApproval(projectId, item) {
  const approved = assertApproval(latestTask(projectId));
  const reqs = new Set(approved.snapshot.requirements.map(r => r.code));
  const scenes = new Set(approved.snapshot.scenarios.map(s => s.code));
  if (item && (item.req_ids.some(id => !reqs.has(id)) || item.scenario_ids.some(id => !scenes.has(id)))) throw new HttpError(409, "此 PBS 项超出本轮人工确认范围，请先审阅需求理解");
  return approved;
}
