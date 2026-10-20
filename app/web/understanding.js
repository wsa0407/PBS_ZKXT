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
