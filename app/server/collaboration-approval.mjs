import { hash } from "../engine/scenario.mjs";
import { getDb, json, now, parse, tx } from "./db.mjs";
import * as repo from "./repo.mjs";
import * as scenes from "./scenarios.mjs";
import * as svc from "./services.mjs";
import { HttpError } from "./errors.mjs";
import { uid } from "./collaboration-store.mjs";

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
  return { ...facts, version: hash(facts), questions: repo.listQuestions(projectId).filter((q) => !["已处理", "已忽略"].includes(q.status)),
    defaults: { requirements: facts.requirements.filter((r) => r.status === "已确认").map((r) => r.code), scenarios: facts.scenarios.filter((s) => s.status === "已确认").map((s) => s.code) } };
}
export function approveUnderstanding(projectId, body) {
  return tx((db) => {
    const facts = understandingFacts(projectId);
    if (body.version !== hash(facts)) throw new HttpError(409, "需求理解已变化，请重新打开并审阅本轮范围");
    const reqCodes = [...new Set(body.requirements ?? [])], sceneCodes = [...new Set(body.scenarios ?? [])];
    if (!reqCodes.length) throw new HttpError(400, "请明确选择本轮已审阅的需求范围");
    if (reqCodes.some((c) => !facts.requirements.some((r) => r.code === c)) || sceneCodes.some((c) => !facts.scenarios.some((s) => s.code === c))) throw new HttpError(400, "确认范围中存在无效编号");
    const selected = facts.scenarios.filter((s) => sceneCodes.includes(s.code));
    if (selected.some((s) => s.links.some((l) => !reqCodes.includes(l.req_id)))) throw new HttpError(400, "所选场景的关联需求也需纳入本轮确认范围");
    svc.confirmRequirements(projectId, reqCodes);
    const pending = selected.filter((s) => s.status !== "已确认");
    if (pending.length) scenes.confirmScenarios(projectId, { scenarios: pending.map(({ code, revision }) => ({ code, revision })) });
    const current = understandingFacts(projectId);
    const snapshot = { ...current, requirements: current.requirements.filter((r) => reqCodes.includes(r.code)), scenarios: current.scenarios.filter((s) => sceneCodes.includes(s.code)),
      excluded: { requirements: current.requirements.filter((r) => !reqCodes.includes(r.code)).map((r) => r.code), scenarios: current.scenarios.filter((s) => !sceneCodes.includes(s.code)).map((s) => s.code) },
      questions: repo.listQuestions(projectId), approved_by: "本地工作台用户", approved_at: now() };
    const id = uid(), version = hash(current);
    db.prepare("INSERT INTO collaboration_approvals(id,project_id,input_version,snapshot,created_at) VALUES (?,?,?,?,?)").run(id, projectId, version, json(snapshot), now());
    return { id, version, snapshot };
  });
}
export function approval(id, projectId) {
  const row = getDb().prepare("SELECT * FROM collaboration_approvals WHERE id=? AND project_id=?").get(id ?? "", projectId);
  return row ? { ...row, snapshot: parse(row.snapshot, {}) } : null;
}
export function assertApproval(t) {
  const a = approval(t.approval_id, t.project_id);
  if (!a || a.input_version !== understandingVersion(t.project_id)) throw new HttpError(409, "本轮需求理解尚未确认或已变化，请先审阅并重新交接给PBS");
  return a;
}
