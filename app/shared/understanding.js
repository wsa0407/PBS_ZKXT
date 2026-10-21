// Legacy deep links remain valid within the scene-first understanding page.
export const UNDERSTANDING_VIEWS = ["requirements", "scenarios", "questions"];
export function workspaceTarget(key, pane = "requirements") {
  if (key === "export") key = "finish";
  if (key === "capabilities") key = "scenarios";
  if (UNDERSTANDING_VIEWS.includes(key)) return { tab: "understanding", pane: key };
  if (key === "understanding") return { tab: key, pane: UNDERSTANDING_VIEWS.includes(pane) ? pane : "requirements" };
  return { tab: ["materials", "pbs", "finish"].includes(key) ? key : "materials", pane: "requirements" };
}
export const questionPending = (q) => ["待处理", "待答复", "已答复"].includes(q.status);
export const questionUnlinked = (q) => !q.req_ids?.length && !q.scenario_ids?.length;
export function questionsForRequirement(requirement, questions) {
  return questions.filter((q) => q.req_ids?.includes(requirement.code) || (!q.req_ids?.length && q.scenario_ids?.some((s) => requirement.scenario_ids?.includes(s))));
}

export function questionActions(q) {
  const pending = questionPending(q);
  return { answer: pending, review: q.status === "已答复" && Boolean(q.proposal), assign: pending, defer: pending, restore: q.status === "已忽略" };
}
export const questionLinkLabel = q => q.status === "已应用" ? "查看处理记录" : q.status === "已忽略" ? "查看暂存问题" : q.status === "已答复" ? "审阅答复建议" : "查看待确认问题";

export function understandingAction(view) {
  const pending = view.materials.filter(m => !m.extracted_at).length;
  if (pending) return { path: "analyze", body: {}, label: `理解待处理材料（${pending}）` };
  if (view.requirements.some(r => r.status !== "已删除")) return { path: "scenarios/generate", body: {}, label: view.scenarios?.some(s => s.status !== "已归档") ? "更新场景与需求关联" : "整理业务场景" };
  if (view.materials.length) return { path: "analyze", body: { all: true }, label: "重新检查材料" };
  return null;
}

/** Projection only: shared requirements keep one identity and current content. */
export function understandingBoard(view) {
  const requirements = (view.requirements ?? []).filter(r => r.status !== "已删除");
  const byCode = new Map(requirements.map(r => [r.code, r]));
  const dispositions = new Map((view.dispositions ?? []).map(d => [d.req_id, d]));
  const scenes = (view.scenarios ?? []).filter(s => s.status !== "已归档");
  const questions = (view.questions ?? []).filter(questionPending);
  const memberships = new Map(requirements.map(r => [r.code, scenes.filter(s => s.links.some(l => l.req_id === r.code)).map(s => ({ code: s.code, name: s.name }))]));
  const entry = (req, link) => ({ req, role: link?.role, shared: memberships.get(req.code) ?? [],
    changed: Boolean(link?.req_revision && link.req_revision !== req.revision),
    questions: questions.filter(q => q.req_ids?.includes(req.code)), disposition: dispositions.get(req.code) });
  const groups = scenes.map(scene => {
    const rows = scene.links.filter(l => byCode.has(l.req_id)).map(l => entry(byCode.get(l.req_id), l));
    const missing = scene.links.filter(l => !byCode.has(l.req_id)).map(l => l.req_id);
    const constraints = requirements.filter(r => {
      const d = dispositions.get(r.code);
      return d?.kinds.includes("跨场景约束") && (!d.scenario_ids?.length || d.scenario_ids.includes(scene.code)) && !scene.links.some(l => l.req_id === r.code);
    }).map(r => entry(r));
    const directQuestions = questions.filter(q => q.scenario_ids?.includes(scene.code) && !q.req_ids?.some(code => rows.some(e => e.req.code === code) || constraints.some(e => e.req.code === code)));
    return { scene, rows, constraints, missing, questions: directQuestions,
      needsUpdate: Boolean(missing.length || rows.some(e => e.changed) || scene.status === "待复核"),
      questionCount: new Set([...directQuestions, ...rows.flatMap(e => e.questions), ...constraints.flatMap(e => e.questions)].map(q => q.id)).size };
  });
  const buckets = [
    { key: "unassigned", title: "待安排的需求", hint: "这些要求尚未关联业务场景或明确处理去向。", rows: [] },
    { key: "constraints", title: "共性约束", hint: "适用于整个项目或指定场景，同一要求只保留一份。", rows: [] },
    { key: "delivery", title: "交付与商务要求", hint: "实施、培训、运维、商务与资质等要求。", rows: [] },
    { key: "context", title: "背景与范围外事项", hint: "保留理解依据与交付边界。", rows: [] },
  ];
  for (const req of requirements) {
    const kinds = dispositions.get(req.code)?.kinds ?? [];
    const key = kinds.includes("跨场景约束") ? "constraints" : kinds.some(k => ["交付与服务", "商务与资质"].includes(k)) ? "delivery" : kinds.some(k => ["背景", "范围外"].includes(k)) ? "context" : "unassigned";
    if (key === "unassigned" && memberships.get(req.code)?.length && !kinds.includes("待归类")) continue;
    buckets.find(b => b.key === key).rows.push(entry(req));
  }
  const visibleQuestions = new Set([...groups.flatMap(g => [...g.questions, ...g.rows.flatMap(e => e.questions), ...g.constraints.flatMap(e => e.questions)]), ...buckets.flatMap(b => b.rows.flatMap(e => e.questions))].map(q => q.id));
  return { groups, buckets: buckets.filter(b => b.rows.length), requirements, questions,
    unassigned: buckets[0].rows.length, needsUpdate: groups.filter(g => g.needsUpdate).length,
    otherQuestions: questions.filter(q => !visibleQuestions.has(q.id)),
    shared: [...memberships.values()].filter(s => s.length > 1).length };
}

export function approvalSelectionIssue(data, requirements, scenarios) {
  if (!data) return "尚未读取确认范围";
  if (!requirements.length) return "请先选择已审阅的需求";
  const available = new Set(data.requirements.map(r => r.code));
  if (requirements.some(code => !available.has(code)) || scenarios.some(code => !data.scenarios.some(s => s.code === code))) return "所选范围已变化，请重新读取后审阅";
  const linked = [...new Set(data.scenarios.filter(s => scenarios.includes(s.code)).flatMap(s => s.links.map(l => l.req_id)))];
  if (linked.some(code => !available.has(code))) return "所选场景关联了已删除的需求，请先调整场景关联";
  const missing = linked.filter(code => !requirements.includes(code));
  return missing.length ? `所选场景还需要纳入关联需求：${missing.join("、")}` : "";
}
