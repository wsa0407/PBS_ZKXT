// Small shared presentational helpers.

export const SOURCE_CLASS = { 自有产品: "own", 外采: "buy", 自研: "dev", 服务: "svc" };
export const SOURCES = ["自有产品", "外采", "自研", "服务"];
export const TIER_TYPE = { 必审: "danger", 抽检: "warning", 批量确认: "success" };
export const LEVEL_TYPE = { 阻断: "danger", 警告: "warning", 提示: "info" };
export const IMPACT_TYPE = { 影响废标风险: "danger", 影响报价: "warning", 影响方案: "primary" };
export const Q_STATUS_TYPE = { 待处理: "info", 待答复: "warning", 已答复: "primary", 已应用: "success", 已忽略: "info" };

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** HTML with the quote highlighted (only when found verbatim). */
export function highlight(text, quote) {
  const safe = esc(text);
  if (!quote) return safe;
  const q = esc(quote);
  return safe.includes(q) ? safe.replace(q, `<mark>${q}</mark>`) : safe;
}

export const SCENARIO_FIELD_LABELS = { name: "场景名称", goal: "业务目标", actors: "参与角色", context: "时间、地点与条件", trigger: "触发条件", activities: "业务活动", outcomes: "预期结果与验收条件", boundaries: "范围、约束与依赖", assumptions: "分析推断" };
export function scenarioFieldLabel(path) {
  const [field, index] = String(path).split(".");
  return (SCENARIO_FIELD_LABELS[field] ?? field) + (index === undefined ? "" : ` ${Number(index) + 1}`);
}
export function scenarioValue(value) {
  return Array.isArray(value) ? value.map((v) => typeof v === "string" ? v : `${v.text}${v.reason ? `（${v.reason}）` : ""}`).join("；") : value;
}
