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
