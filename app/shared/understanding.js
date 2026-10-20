// Shared navigation and association rules for the three views of understanding.
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
  if (view.requirements.some(r => r.status !== "已删除")) return { path: "scenarios/generate", body: {}, label: "整理需求与业务场景" };
  if (view.materials.length) return { path: "analyze", body: { all: true }, label: "重新检查材料" };
  return null;
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
