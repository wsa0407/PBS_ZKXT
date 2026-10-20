import { hash } from "../engine/scenario.mjs";
import { json, now, tx } from "./db.mjs";
import * as repo from "./repo.mjs";
import * as scenes from "./scenarios.mjs";
import * as svc from "./services.mjs";
import { HttpError } from "./errors.mjs";
import { uid } from "./collaboration-store.mjs";
import { understandingFacts } from "./understanding-scope.mjs";

export { understandingFacts, understandingVersion, approvalPreview, approval, assertApproval, pbsParticipation } from "./understanding-scope.mjs";

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
