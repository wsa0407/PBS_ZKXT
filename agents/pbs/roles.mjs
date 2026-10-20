import { TOOLS } from "./contracts/tools.mjs";

export const ROLES = {
  materials: { label: "材料拆解专家", instructions: "roles/materials/AGENTS.md", writes: ["submit_requirements", "submit_questions", "propose_change"], consult: [] },
  understanding: { label: "需求理解专家", instructions: "roles/understanding/AGENTS.md", writes: ["submit_scenarios", "submit_questions", "propose_change"], consult: ["materials"] },
  pbs: { label: "PBS专家", instructions: "roles/pbs/AGENTS.md", writes: ["submit_pbs", "submit_solutions", "submit_questions", "propose_change"], consult: ["understanding", "materials"] },
};
export const roleTools = (role, mode) => TOOLS.filter((t) => (t.annotations.readOnlyHint && !(mode === "claim" && t.name === "finish_task")) || (!["consultation", "claim"].includes(mode) && (mode !== "discussion" || t.name === "propose_change") && ROLES[role]?.writes.includes(t.name)));
